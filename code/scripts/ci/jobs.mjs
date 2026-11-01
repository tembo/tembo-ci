// The single definition of CI's jobs. GitHub Actions (.github/workflows/ci.yml) and Tembo sessions
// (tembo-ci.mjs) both run each job as `node scripts/ci/job.mjs <id>` and report it under `name`.
// ci.yml cannot import this file, so ci-workflow.test.mjs fails if the workflow drifts from it.
// To add or change a job, edit this file and the matching ci.yml job together.
//
//   id:      the Actions job key in ci.yml
//   name:    the Actions job `name:`, which is also the check-run name
//   run:     shell command the job runs from the repository root
//   install: 'always' (run the install command first) or 'never'
//   env:     extra environment for the command, on top of the runner's
//
// REPLACE the example JOBS below with your repository's own jobs (see templates/jobs.example.mjs).

export const INSTALL = 'pnpm install --frozen-lockfile --prefer-offline';
// The gate job: Actions runs it over `needs`; tembo-ci.mjs computes it from its own results.
export const GATE = { id: 'checks', name: 'checks' };

export const JOBS = [
  { id: 'lint', name: 'lint', run: 'pnpm lint', install: 'always' },
  { id: 'typecheck', name: 'typecheck', run: 'pnpm typecheck', install: 'always' },
  { id: 'test', name: 'test', run: 'pnpm test', install: 'always', env: { NODE_OPTIONS: '--max-old-space-size=4096' } },
];

export function job(id) {
  const found = JOBS.find(entry => entry.id === id);
  if (!found) throw new Error(`Unknown CI job ${JSON.stringify(id)}; expected one of ${JOBS.map(entry => entry.id).join(', ')}`);
  return found;
}

// The shell command and environment for a job; `extra` arguments are appended.
export function invocation(id, { extra = [] } = {}) {
  const { run, env = {} } = job(id);
  return { command: [run, ...extra].join(' '), env };
}
