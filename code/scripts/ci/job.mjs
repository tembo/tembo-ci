import { spawnSync } from 'node:child_process';
import { invocation } from './jobs.mjs';

// Runs one CI job as jobs.mjs defines it. Every ci.yml job step and tembo-ci.mjs call this.
//   node scripts/ci/job.mjs <id> [extra args for the job's command]
const [id, ...extra] = process.argv.slice(2);
const { command, env } = invocation(id, { extra });
console.log(`> ${command}`);
const result = spawnSync(command, { shell: true, stdio: 'inherit', env: { ...process.env, ...env } });
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
