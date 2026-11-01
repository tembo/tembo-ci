## Tembo CI

On `tembo/` branches, GitHub Actions skips its PR jobs; you run CI in the session and post the results as the PR's checks.

1. Before every push, on the finished working tree, run `node scripts/ci/tembo-ci.mjs`. It runs every job in `scripts/ci/jobs.mjs` (2 at a time; `--jobs <n>` to change) on the tree a commit of your changes would record, and posts nothing. Do not push if it fails. In a Tembo session `tembo commit` also pushes, so run it just before `tembo commit`.
2. After pushing to a branch with an open PR, run `node scripts/ci/tembo-ci.mjs --pr <number>`. It posts check runs named like the Actions jobs (and the `checks` gate) on the PR head, reusing the saved results from step 1. It reruns only what the tree, merge base or Node/pnpm versions changed, or everything with `--no-cache`.
3. To change what CI runs, edit `scripts/ci/jobs.mjs` and `.github/workflows/ci.yml` together; `node --test scripts/ci/*.test.mjs` fails if they drift.

Logs are in `test-results/tembo-ci/`.
