---
name: tembo-session-ci
description: Use when adding Tembo session-run CI to a GitHub repository, so PRs Tembo opens (branches starting with `tembo/`) get their CI check runs posted from the Tembo session itself, while human, other-bot and fork PRs keep running GitHub Actions. Covers installing the scripts, writing jobs.mjs from the existing workflow, patching ci.yml with the skip and `checks` gate, the AGENTS.md block, verification and rollback.
---

# Tembo session CI

## What it does

- `scripts/ci/jobs.mjs` is the one list of CI jobs (id, check name, shell command, install, env). Every Actions step and the session runner call `node scripts/ci/job.mjs <id>`.
- `scripts/ci/tembo-ci.mjs` runs those jobs in a Tembo session **before the push**, each in its own detached git worktree, N at a time (`--jobs`, default 2), with a 45-minute per-job timeout (`--timeout-minutes`). It tests the tree a commit of the working tree would record (via a throwaway index and an unreferenced, deterministic commit; your index is untouched).
- Results are saved in `.tembo-ci/results/<tree>.json`, keyed by git tree + a hash of the Node and pnpm versions + the merge base with `--base` (default `origin/main`). Only passed jobs are reused; `--no-cache` ignores the cache.
- `--pr <n>` reads the PR head SHA, reuses the saved results for that tree (rerunning anything not covered) and posts one GitHub **check run** per job, named exactly like the Actions job, plus the `checks` gate. Open runs are completed (cancelled/failure) on interrupt or crash.
- In `ci.yml`, every PR job and the `checks` gate are skipped for same-repo PRs whose branch starts with `tembo/`. There is no repo variable: the branch prefix is the switch. Forks and other branches always run Actions.
- `scripts/ci/ci-workflow.test.mjs` (the drift test) fails if `ci.yml`'s jobs, names, `job.mjs` steps, skip conditions or gate `needs` stop matching `jobs.mjs`.

## Prerequisites

- Node 18+ (global `fetch`, `node:test`) and git in the session. pnpm by default (see Adaptations).
- GitHub Actions with an existing CI workflow (usually `.github/workflows/ci.yml`).
- Tembo connected to the repo (Tembo GitHub App installed on it) and Tembo opening PRs from `tembo/...` branches.
- Auth to post check runs: the Checks API only accepts **GitHub App** tokens with `checks: write` (a personal access token or `gh auth` user token gets 403 on `POST /repos/{owner}/{repo}/check-runs`). `tembo-ci.mjs` looks for a token in this order:
  1. `GITHUB_TOKEN` or `GH_TOKEN` in the environment;
  2. otherwise `git credential fill` for `https://github.com/<owner>/<repo>`. In a Tembo session this returns the Tembo GitHub App installation token that git already uses to push.
  So a new repo needs: the Tembo GitHub App installed on it with **Checks: Read and write** permission (and Pull requests: read, to look up the PR head). Nothing is stored in the repo. Tokens are stripped from job environments (`GITHUB_TOKEN`, `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`); add any other secret names to `STRIP` in `tembo-ci.mjs`.
- Owner/repo come from `--repo`, else `GITHUB_REPOSITORY`, else `git remote get-url origin`.
- If branch protection requires a status, require **`checks`** (the gate); it is produced by Actions on normal PRs and by the session on Tembo PRs.

## Install (one Tembo session, one PR)

1. **Copy the scripts.** Copy `code/scripts/ci/*` from this bundle into the repo's `scripts/ci/` unchanged (`job.mjs`, `jobs.mjs`, `tembo-ci.mjs`, `*.test.mjs`). If `scripts/ci/` already exists, keep its other files. Add to `.gitignore`:
   ```
   .tembo-ci/
   test-results/
   ```
   (Required: otherwise the saved results make the working tree differ from run to run and nothing is reused.)
2. **Write `jobs.mjs`.** Read the existing workflow. For each job that runs on `pull_request`, add `{ id: <job key>, name: <job name: or key>, run: '<its commands joined with &&>', install: 'always' | 'never', env: {...} }`. Set `INSTALL` to the repo's install command. Keep the `checks` gate id unless the repo already uses another required-check name; then set `GATE.name` (and the job key) to match. Template: `templates/jobs.example.mjs`. Jobs that need services (databases, etc.) must either work in the session sandbox or stay Actions-only (see Adaptations).
3. **Patch the workflow** (compare `templates/ci.yml.example`):
   - Add to every job in `jobs.mjs`:
     `if: github.event_name != 'pull_request' || !(github.event.pull_request.head.repo.full_name == github.repository && startsWith(github.head_ref, 'tembo/'))`
     (if the job already has an `if:`, AND it with this in parentheses; the drift test only checks that this text is present).
   - Replace each job's command steps with `- run: node scripts/ci/job.mjs <id>` (keep checkout, setup-node, install, caches).
   - Add the `checks` gate job: `if: always() && (<same condition as above>)`, `needs: [<every job id>]`, failing if any `needs.*.result != 'success'`.
   - Make sure `pull_request` triggers include `opened, reopened, synchronize, ready_for_review`.
4. **AGENTS.md.** Append `templates/AGENTS-snippet.md` (adjust the install and base-branch lines if they differ).
5. **Test locally.**
   - `node --check scripts/ci/*.mjs`
   - `node --test scripts/ci/*.test.mjs` (includes the drift test against `.github/workflows/ci.yml`)
   - `node scripts/ci/tembo-ci.mjs` (all jobs should pass), then run it again and confirm every job says `reused`.
6. **Open the PR** from the session as usual. Because the branch is `tembo/...`, Actions will skip; after pushing, run `node scripts/ci/tembo-ci.mjs --pr <number>` so the PR gets its checks.

## Verify

- Tembo PR: the Actions run shows every job skipped; the PR's checks list shows `lint`, …, `checks` posted with the Tembo session as details URL. A failing job shows the log tail in the check run.
- Non-Tembo PR (a human branch) and a fork PR: Actions runs every job and `checks` normally.
- `push` to main / `workflow_dispatch` always run on Actions.

## Turn it off

Remove the `!(...)` skip from each `if:` in `ci.yml` (or revert that commit). Tembo PRs then run Actions again; the scripts are harmless and `job.mjs` keeps working. Remove the AGENTS.md block so sessions stop posting.

## Adaptations

- **npm / yarn:** set `INSTALL` to `npm ci` or `yarn install --frozen-lockfile` (Berry: `yarn install --immutable`), and change `environment()` in `tembo-ci.mjs` to hash `npm --version` / `yarn --version` instead of pnpm so the cache key tracks the right tool.
- **No Node in the project:** the scripts still need Node in the session and on the runner (`actions/setup-node`), but `run` can be any shell command (`go test ./...`, `cargo test`, `pytest`). Use `install: 'never'` or put the install into `run`; set `INSTALL` to `true` if unused, and add the relevant toolchain version to `environment()`.
- **Matrix jobs:** flatten them into one jobs.mjs entry per leg with the leg's check name, and make the workflow job use `matrix.id` with `node scripts/ci/job.mjs ${{ matrix.id }}`; extend the drift test accordingly.
- **Service-dependent jobs (databases etc.):** either provide the service in the sandbox and pass its URL through `env`, or keep the job Actions-only by leaving it out of `jobs.mjs` and without the skip `if:` (then don't put it in the gate's `needs`; the drift test ignores jobs only if you extend it to allow-list them).
- **Different branch prefix or base branch:** change `tembo/` in `ci.yml` and `SKIP` in the drift test; pass `--base origin/<branch>`.
