<div align="center">
  <h1>Tembo CI</h1>
<a href="https://tembo.io"><img alt="Made by Tembo" src="https://img.shields.io/badge/MADE%20BY%20TEMBO-0f172a.svg?style=for-the-badge&labelColor=000&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB2aWV3Qm94PSIwIDAgMzIgMzIiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgZmlsbD0ibm9uZSI%2BPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoNiA2KSBzY2FsZSgwLjE5OTMpIHRyYW5zbGF0ZSgwIC0yLjUwODYxKSIgZmlsbD0iI2ZmZmZmZiI%2BPHBhdGggZD0iTTMzLjQ1MDMgNjkuNDA5NkgwVjEwMi44NkgzMy40NTAzVjY5LjQwOTZaIi8%2BPHBhdGggZD0iTTEwMC4zNDggNjkuNDA5Nkg2Ni44OTc0VjEwMi44NkgxMDAuMzQ4VjY5LjQwOTZaIi8%2BPHBhdGggZD0iTTEwMC4zNTEgMzUuOTU4OVYyLjUwODYxSDBWMzUuOTU4OUgzMy40NTAzTDMzLjQ1MDMgNjkuNDA5Nkw2Ni45MDA2IDY5LjQwOTJWMzUuOTU4OUgxMDAuMzUxWiIvPjwvZz48L3N2Zz4%3D"></a>
  <p>Run CI in your Tembo session. Push with results ready.</p>
  <p><a href="#quickstart">Quickstart</a> · <a href="#manual-setup">Manual setup</a> · <a href="#faq">FAQ</a></p>
</div>

> Run your tests before pushing, then publish the results as GitHub checks on your PR.

Your Tembo session already has your code and dependencies. Tembo CI uses that environment to run your CI suite, saves the results, and posts them to GitHub after the push. When the tested code is unchanged, there is no second test run to wait for.

## At a Glance

| Area | What Tembo CI provides |
| --- | --- |
| Tembo PRs | CI runs in the session before pushing |
| GitHub checks | Results appear on the PR under your existing check names |
| Other PRs | People, other agents, and forks keep using GitHub Actions |
| Shared commands | Actions and Tembo use the same job definitions |
| Result reuse | Passing results are reused for the same code, base, and toolchain |
| Setup | One setup PR with scripts, workflow changes, and agent instructions |

## Quickstart

**Ask a Tembo session to set it up.** Open a session in the repository you want to enable and paste:

```text
Set up Tembo CI in this repository using https://github.com/tembo/tembo-ci.
Read its SKILL.md for the installation steps and use the supplied scripts and templates.
Adapt the example jobs to our existing CI commands and check names.
Keep GitHub Actions running for non-Tembo PRs, forks, and pushes to main.
Verify the setup and open a PR with the changes.
```

The session copies the runner, connects your existing CI commands, updates the workflow, and adds the instructions future sessions need. The bundled jobs are examples; setup adapts them to your repository.

**Before you merge:** your Tembo environment needs Node 18+, git, your package manager (pnpm by default), dependencies, and any test services. The Tembo GitHub App needs **Checks: write** and **Pull requests: read**. A repository admin should confirm required checks accept results from Tembo as well as GitHub Actions. See [Turning it on](#turning-it-on) for the checklist.

### After setup

Future sessions follow this flow:

```bash
# 1. Run CI on the finished changes. Fix any failures before pushing.
node scripts/ci/tembo-ci.mjs

# 2. Commit and push as usual, then publish results to your PR.
node scripts/ci/tembo-ci.mjs --pr 123
```

Replace `123` with your PR number. Run the second command after every push. If the code, base, or toolchain changed, the runner reruns the jobs it cannot reuse.

## Core Concepts

- **Jobs** are your lint, test, build, and other CI commands, defined in `scripts/ci/jobs.mjs`.
- **Saved results** record what passed for a specific code tree, merge base, and toolchain. Failed jobs always rerun.
- **Checks** are the results reviewers see on GitHub. The `checks` gate summarizes whether the suite passed.
- **Workflow routing** sends same-repository `tembo/` PRs to session CI. Other PRs and pushes to `main` continue on Actions.

## How it works

```mermaid
flowchart TD
  A[Session finishes change] --> B[tembo-ci: run suite on working tree]
  B -->|red| A
  B -->|green| C[Save results keyed by tree + merge base + toolchain]
  C --> D[git push / tembo commit]
  D --> E[tembo-ci --pr N]
  E -->|key matches| F[Post saved results as check runs]
  E -->|key changed or job failed| G[Rerun affected jobs, then post]
  F --> H[Required checks pass]
  G --> H
```

1. **Before pushing**, the session runs `node scripts/ci/tembo-ci.mjs`. The script works out the git tree of the working directory as it would be committed, runs every CI job against that tree, and saves the results to `.tembo-ci/results/<tree>.json`. That directory is gitignored.
2. **The cache key** is the git tree SHA, the merge base with `main` (your plan or diff base), and the toolchain versions (for example Node and pnpm). The lockfile and CI scripts are inside the tree, so a change to either one means a new key.
3. **After pushing**, the session runs `node scripts/ci/tembo-ci.mjs --pr <n>`. The script reads the PR head, finds the saved results for that tree, and posts one check run per job through the GitHub Checks API. Each check run has the same name as the matching Actions job.
4. **Nothing runs a second time** unless the tree, merge base or toolchain changed, a job failed or timed out, or you pass `--no-cache`. Reused check runs start with `Reused result from <time>, tree <sha>` and keep the start and end times from the original run.
5. **Actions skips only Tembo PRs.** `ci.yml` skips its PR jobs for PRs whose branch starts with `tembo/` and comes from the same repository. Forks can't skip CI by naming a branch that way. Every other PR (Codex, human, forks) runs normal Actions CI. Pushes to `main`, nightly runs, releases and manual runs keep running on Actions.
6. **One set of CI jobs.** Jobs are defined once, in `scripts/ci/jobs.mjs`. Actions and Tembo both run them through `scripts/ci/job.mjs`, and a test fails if the workflow and `jobs.mjs` drift apart. To add a job, update `jobs.mjs` and the matching workflow job; the drift test checks that they agree.

The check runs are posted with the Tembo GitHub App's installation token, which the session already has through its git credential helper. The app can create check runs and commit statuses, so you don't need to add a token.

## Manual Setup

### 1. Gate the PR jobs in your workflow

Put this condition on the root jobs of `ci.yml`. Jobs that `need` a gated job are skipped along with it. The condition skips PR jobs only for same-repo branches starting with `tembo/`.

```yaml
name: CI   # keep the name if other workflows (alerts, etc.) refer to it

on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: '23 6 * * *'
  workflow_dispatch:

jobs:
  plan:
    if: >-
      github.event_name != 'pull_request' || !startsWith(github.head_ref, 'tembo/') || github.event.pull_request.head.repo.full_name != github.repository
    runs-on: ubuntu-latest
    steps: [...]

  lint:
    needs: plan            # skipped when plan is skipped
    steps:
      - run: node scripts/ci/job.mjs lint   # same job definition Tembo runs

  test:
    needs: plan
    steps: [...]

  build:
    needs: plan
    steps: [...]

  checks:                  # the single required gate
    needs: [plan, lint, test, build]
    if: always() && (github.event_name != 'pull_request' || !startsWith(github.head_ref, 'tembo/') || github.event.pull_request.head.repo.full_name != github.repository)
    steps: [...]
```

There is no variable or switch to set: once this change is merged, same-repo `tembo/` PRs skip Actions and every other PR runs in full. To switch back to Actions for everything, revert this `if:` condition in a PR.

### 2. Add the runner script

Copy the supplied [runner](./code/scripts/ci/tembo-ci.mjs), [job launcher](./code/scripts/ci/job.mjs), [job definitions](./code/scripts/ci/jobs.mjs), and tests into your repository's `scripts/ci/` directory. Use the working implementation rather than writing a runner from scratch.

Replace the example jobs in `jobs.mjs` with your CI commands and preserve the check names your repository already requires. Set `INSTALL` to your install command. See the [jobs template](./templates/jobs.example.mjs) for the format.

Add both generated-output directories to `.gitignore` so results do not change the tree being tested:

```gitignore
.tembo-ci/
test-results/
```

### 3. Post check runs

Send each request to `POST /repos/{owner}/{repo}/check-runs` (and `PATCH /repos/{owner}/{repo}/check-runs/{id}` to finish one) with the installation token. In a session, the token comes from `GITHUB_TOKEN` or `GH_TOKEN` if one is set, and otherwise from `git credential fill` for `github.com`. Never print it.

Fields every payload has:

```json
{ "name": "test", "head_sha": "<PR head sha>", "external_id": "tembo-ci:test",
  "details_url": "<link to the Tembo session>" }
```

**A job running now:**

```json
{ "status": "in_progress", "started_at": "2026-10-31T19:40:00Z",
  "output": { "title": "Running", "summary": "Running in a Tembo session." } }
```

Finish it with a PATCH:

```json
{ "status": "completed", "conclusion": "success", "completed_at": "2026-10-31T19:46:10Z",
  "output": { "title": "Passed in 6m10s", "summary": "commands, exit codes, test counts",
              "text": "on failure: the last lines of the log" } }
```

**A reused result,** created already completed, with the times from the original run:

```json
{ "status": "completed", "conclusion": "success",
  "started_at": "<original start>", "completed_at": "<original end>",
  "output": { "title": "Reused: Passed in 6m10s",
              "summary": "Reused result from 2026-10-31 19:40 UTC, tree 3f2a9c1. Ran on commit abc1234.\n\n..." } }
```

**A job your plan leaves out:**

```json
{ "status": "completed", "conclusion": "skipped", "completed_at": "...",
  "output": { "title": "Skipped", "summary": "Prose-only change; no build needed." } }
```

Post the gate check (`checks` in the examples) last. It passes only if every planned job passed. Keep `summary` and `text` under the API's 65,535-character limit.

### 4. Write agent instructions

Add this to `AGENTS.md`, or whichever instructions file your agents read:

```markdown
## CI in Tembo sessions

PRs from same-repo `tembo/` branches get CI from your session, not GitHub Actions. CI jobs are defined in `scripts/ci/jobs.mjs`; to add a job, edit that file.

1. Finish your change and stage everything (`git add -A`). The pushed tree must be the tested tree.
2. Run `node scripts/ci/tembo-ci.mjs`. If any job fails, fix it and run the script again. **Do not push while it is red.**
3. Push (or `tembo commit`).
4. Run `node scripts/ci/tembo-ci.mjs --pr <number>`. This posts the saved results as check runs.
   Run it again after every push, because check runs belong to a commit.
5. Saved results are reused only for the exact same tree, toolchain and merge base. Any file change reruns everything, and failures always rerun. Use `--no-cache` to force a full rerun.
```

`tembo commit` commits and pushes in one step, so run the script on the finished changes just before it.

### 5. Add it to your Tembo session brief

Add a line like this to the repo's Tembo instructions or task template so every session follows the same steps:

```text
Before pushing, run `node scripts/ci/tembo-ci.mjs` and fix every failure; do not push while it is red.
After the PR exists, run `node scripts/ci/tembo-ci.mjs --pr <PR number>` and confirm all checks are green on the PR.
If the sandbox needs services (e.g. Postgres), start them first.
```

### 6. Size the VM

In our repo, the session runs two jobs at a time on an 8 vCPU VM, and a full run takes about 7 minutes, most of it the database tests. Running more jobs at once on a small VM usually makes the total time longer because the jobs compete for CPU. Use `--jobs <n>` to adjust concurrency and `--timeout-minutes <n>` to set the per-job timeout (default: 45 minutes) so a job that hangs ends as `timed_out` and doesn't stall the session.

## Turning it on

There is no variable or switch: turning it on is just merging the workflow change. Before you merge it:

1. Have `jobs.mjs`, `job.mjs`, the script, `.gitignore` and the `AGENTS.md` change in place (in the same PR or merged first).
2. **Check required checks before you merge the workflow gate.** A branch rule that requires `checks` should accept it from either the Tembo app (Tembo PRs) or GitHub Actions (every other PR). Be aware that GitHub can count a skipped Actions `checks` job as passing. Since Actions skips only same-repo `tembo/` branches, those are the PRs to watch: make sure their sessions always post results.
3. Look for existing rulesets that pin required checks to the **GitHub Actions** app only. Tembo's check runs won't satisfy those, so Tembo PRs stay blocked.
4. Merge the workflow change. From then on, same-repo `tembo/` PRs skip Actions.

To switch back to Actions for everything, revert the `if:` condition in a PR. Actions takes over CI for Tembo PRs on their next push after that merges.

## Verifying

- After the workflow change is merged, open a small PR from a Tembo session (`tembo/` branch). In the Actions tab, the PR run should show its jobs as skipped.
- Open a PR from another branch or a fork, including a fork branch named `tembo/...`. Actions should run in full.
- On the PR's **Checks** tab, every job name should appear once, posted by the Tembo app, with the gate last.
- Run `tembo-ci.mjs --pr <n>` a second time without changing anything. Each check should say `Reused result from <time>, tree <sha>`, and the run should finish in seconds.
- Break a test on purpose. The script before the push should fail, and the session should not push.
- Confirm that a merge to `main` still runs the full Actions workflow.

## Fallbacks and caveats

- **Only `tembo/` branches skip Actions.** PRs from people, other agents (such as Codex) and forks run normal Actions CI. A fork can't skip CI by naming its branch `tembo/...`.
- **What gets tested is different from Actions.** Actions tests GitHub's merge commit. This setup tests the pushed tree, diffed against the merge base with the fetched `main`. Pushes to `main` still run in full on Actions, which catches anything that breaks after merging.
- **Check runs belong to a commit.** Post again after every push, including rebases.
- **Remove secrets from the job environment.** Strip the GitHub token, production database URLs and other credentials before running jobs. Tests should use only disposable local services.
- **Clean up on failure.** If the script crashes, complete every open check run as `failure`, and complete them as `cancelled` on an interrupt. A check left `in_progress` blocks the PR.
- **Draft PRs.** The session runs CI on drafts even if your Actions workflow skips them.

## FAQ

**What happens with PRs not created by a Tembo session?**
They run normal GitHub Actions CI. Actions skips its PR jobs only for same-repo PRs whose branch starts with `tembo/`. PRs from people, other agents such as Codex, and forks (even with a `tembo/` branch name) are tested on Actions as usual, using the same job definitions from `scripts/ci/jobs.mjs`.

**How do I turn it off?**
There is no variable to flip. Revert the `if:` condition in `ci.yml` in a PR, and Actions runs for every PR again.

**Does this need a new GitHub token or secret?**
No. Inside a session, the script uses the Tembo GitHub App installation token from the git credential helper. The app needs `checks: write`.

**Why use the same check names as the Actions jobs?**
Branch protection and rulesets match required checks by name. With the same names, your rules apply as they do today. The one setting that changes is the source app.

**Can't a session just post a green check without running anything?**
The script posts only results it recorded for that exact tree. Reused results show the tree and the time they ran, and each check links to the session. The full suite still runs on Actions for every merge to `main`, so a bad result is caught there. If you need stronger guarantees, keep a small set of Actions jobs required on PRs.

**What makes the script run jobs again?**
A different git tree (any file change, including the lockfile and CI scripts, reruns everything), a different merge base with `main`, a different Node or pnpm version, a job that failed or timed out, or `--no-cache`. Reuse avoids testing the same code twice; it never skips testing new code.

**Do caches carry over between jobs?**
Dependencies come from the snapshot and the local package store (`pnpm install --frozen-lockfile --prefer-offline`). The outline doesn't restore compiler or lint caches, and test results are reused only through the tree-keyed results file.

**Where are the logs?**
Each job's log and test output are copied to a local folder (for example `test-results/tembo-ci/`). When a job fails, the end of its log goes into the check run's `text`, so reviewers can see it on the PR.

## Performance Example

The following figures describe the original example repository, not a guarantee for every project. They include an assumed 10-minute coding session; test durations and costs depend on your suite and environment.

### CI after the push

Baseline: laptop plus unsharded Actions.

| Scenario | CI time | Time vs. baseline | CI cost per push | Cost vs. baseline |
|---|---|---|---|---|
| Local + Actions, unsharded | 11 min | 100% | ~$0.11 (~14 runner-min) | 100% |
| Local + Actions, sharded | 6 min | ~55% | $0.18 (23 runner-min) | ~164% |
| Tembo, jobs one at a time | 3 s | <1% | ~$0 (posting only) | ~0% |
| Tembo, 2 jobs at once (default) | 3 s | <1% | ~$0 (posting only) | ~0% |

In the Tembo rows, the test run before the push counts as part of the coding session (see the next table).

### Full timeline per change, including the coding session

Coding is assumed to take 10 minutes.

| Scenario | 1. Coding | 2. Lint/tests before push | 3. CI after push | Wait for green after coding done | Total time | Time vs. baseline | Cost per change | Cost vs. baseline |
|---|---|---|---|---|---|---|---|---|
| Local + Actions, unsharded | 10 min | 14 min | 11 min | 25 min | 35 min | 100% | ~$0.11 (Actions only) | 100% |
| Local + Actions, sharded | 10 min | 14 min | 6 min | 20 min | 30 min | 86% | $0.18 (Actions only) | ~164% |
| Tembo, jobs one at a time | 10 min | 14 min | 3 s | 14 min | 24 min | 69% | ~$0.21 (24 VM-min) | ~190% |
| Tembo, 2 jobs at once (default) | 10 min | 7 min | 3 s | 7 min | 17 min | 49% | ~$0.15 (17 VM-min) | ~134% |

### Method notes

- Actions is priced at GitHub's $0.008 per runner-minute Linux rate, with each job rounded up to a whole minute. Costs are total billed runner-minutes across all jobs and shards, not wall time.
- Sharded: 6 test shards plus plan, docs and checks jobs. Median of 16 real runs: 6.2 min wall, 23 billed runner-minutes.
- Unsharded is an estimate: the sum of the shard test times plus one job's setup.
- Tembo VM: 8 vCPU / 16 GiB at $0.5304/hour ([tembo.io/pricing](https://tembo.io/pricing)), billed per second.
- Laptop compute and model/token costs are not counted. Coding time is an assumed 10 minutes. Local test time is assumed equal to Tembo running jobs one at a time.
- Tembo posting latency after the push: median about 3-4 s, worst 19 s.

## Repository Layout

```text
tembo-ci/
|-- SKILL.md                   Agent installation instructions
|-- code/scripts/ci/            Runner, job definitions, and self-tests
|-- templates/                 Workflow, jobs, and agent instruction examples
`-- tembo-session-ci-guide.md   Original standalone guide
```

## Local Development

Run the bundled self-tests from the repository root:

```bash
cd code/scripts/ci
CI_WORKFLOW=../../../templates/ci.yml.example node --test *.test.mjs
```

For installation details and adaptations (npm, yarn, other languages, matrices, and service-dependent jobs), see [SKILL.md](./SKILL.md).
