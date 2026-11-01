import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { GATE, INSTALL, JOBS } from './jobs.mjs';

// Runs the CI workflow's jobs in a Tembo session and reports each one to the PR as a GitHub check
// run with the same name as its Actions job. Results are saved by git tree (plus toolchain and
// merge base), so jobs that already passed on the same tree are posted, not rerun.
//   node scripts/ci/tembo-ci.mjs [--base origin/main] [--jobs <n>] [--timeout-minutes <n>] [--no-cache] [--keep] [--repo owner/name]
//   node scripts/ci/tembo-ci.mjs --pr <number> [same options]
// Before the push, without --pr, it tests the working tree (the tree a commit of every change
// records) and posts nothing. After the push, --pr posts that run's saved results to the PR head
// and runs only what they do not cover. Posting reads GITHUB_TOKEN or GH_TOKEN, else the git
// credential helper's token for the repo (in Tembo sessions: the Tembo GitHub App installation token).

export { JOBS };
export const DEFAULT_SLOTS = 2;
const RESULTS = '.tembo-ci/results';
const FORMAT = 1;
const MAX_OUTPUT = 60_000;

export async function runPool(jobs, slots, start) {
  const pending = [...jobs], running = new Set();
  while (pending.length || running.size) {
    while (pending.length && running.size < slots) {
      const job = pending.shift();
      const promise = Promise.resolve().then(() => start(job)).finally(() => running.delete(promise));
      running.add(promise);
    }
    await Promise.race(running);
  }
}

// What the Actions job sees: CI set. job.mjs adds each job's own environment. GitHub tokens never
// reach repository code. Add any other secret variable names your sandbox exposes to STRIP.
const STRIP = /^(GITHUB_TOKEN|GH_TOKEN|GH_ENTERPRISE_TOKEN)$/;
export function jobEnvironment(source = process.env) {
  const env = { ...source, CI: 'true', TEMBO_BYPASS_GIT_RESTRICTIONS: '1' };
  for (const key of Object.keys(env)) if (STRIP.test(key)) delete env[key];
  return env;
}

export function truncate(text, limit = MAX_OUTPUT) {
  return text.length <= limit ? text : `${text.slice(0, limit - 40)}\n…truncated (${text.length - limit + 40} chars)`;
}

export function logTail(text, lines = 120) {
  const plain = text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n');
  return truncate(plain.trimEnd().split('\n').slice(-lines).join('\n'), MAX_OUTPUT - 20);
}

const duration = ms => { const seconds = Math.round(ms / 1000); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; };
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } };
const utc = iso => iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

const git = (args, cwd, options = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options }).trim();

// The tree a commit of the whole working tree records: HEAD plus every tracked change and
// untracked, non-ignored file. A copy of the index keeps the real one untouched; it keeps the
// index's mtime, which git compares with entry mtimes to recheck racily clean files.
export function workingTree(root, scratch) {
  const index = join(scratch, 'index');
  const real = git(['rev-parse', '--path-format=absolute', '--git-path', 'index'], root);
  if (existsSync(real)) cpSync(real, index, { preserveTimestamps: true });
  const env = { ...process.env, GIT_INDEX_FILE: index };
  git(['add', '-A'], root, { env });
  return git(['write-tree'], root, { env });
}

// Check runs and saved results name a commit. Uncommitted changes (a Tembo session's
// `tembo commit` also pushes) get an unreferenced commit on HEAD with fixed metadata, so the
// same tree and parent give the same SHA. It is never pushed or referenced by a branch.
export function testCommit(root, tree) {
  const head = git(['rev-parse', 'HEAD'], root);
  if (git(['rev-parse', 'HEAD^{tree}'], root) === tree) return head;
  const fixed = { GIT_AUTHOR_NAME: 'tembo-ci', GIT_AUTHOR_EMAIL: 'tembo-ci@localhost', GIT_AUTHOR_DATE: '@0 +0000',
    GIT_COMMITTER_NAME: 'tembo-ci', GIT_COMMITTER_EMAIL: 'tembo-ci@localhost', GIT_COMMITTER_DATE: '@0 +0000' };
  return git(['commit-tree', '--no-gpg-sign', tree, '-p', head, '-m', `tembo-ci test commit for tree ${tree}`], root, { env: { ...process.env, ...fixed } });
}

// Results also depend on the toolchain outside the tree (the lockfile and CI scripts are in it).
export function environment({ node = process.version, pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).stdout?.trim() } = {}) {
  return createHash('sha256').update(`tembo-ci ${FORMAT}\0node ${node}\0pnpm ${pnpm}`).digest('hex').slice(0, 16);
}

export const resultsPath = (root, tree) => join(root, RESULTS, `${tree}.json`);

const sameRun = (saved, { tree, env, base, noCache }) => !noCache && saved?.format === FORMAT && saved.tree === tree && saved.environment === env && saved.base === base;

// A saved job result is reused only if it passed on this exact tree, merge base and toolchain.
// Failures and anything else rerun.
export function reusable(saved, { tree, env, base, noCache = false }) {
  if (!sameRun(saved, { tree, env, base, noCache })) return new Map();
  return new Map(Object.entries(saved.jobs ?? {}).filter(([, job]) => job.conclusion === 'success'));
}

// The gate: every job must have succeeded (same rule as the Actions `checks` job).
export function gate(records) {
  const errors = JOBS.filter(job => records[job.id]?.conclusion !== 'success').map(job => `${job.name}: ${records[job.id]?.conclusion ?? 'not run'}`);
  return { passed: !errors.length, errors };
}

// Check runs: created in_progress when a job starts and completed when it ends. A reused result
// is created completed, with the times it actually ran. Without a client, results are only printed.
export function checkRuns(github, sha, detailsUrl) {
  const open = new Map();
  const output = (title, summary, text) => ({ title, summary: truncate(summary), ...(text ? { text: truncate(text) } : {}) });
  const base = name => ({ name, head_sha: sha, external_id: `tembo-ci:${name}`, ...(detailsUrl ? { details_url: detailsUrl } : {}) });
  return {
    open,
    async start(name) {
      console.log(`[tembo-ci] ${name}: started`);
      if (!github) return open.set(name, null);
      const run = await github('POST', 'check-runs', { ...base(name), status: 'in_progress', started_at: new Date().toISOString(),
        output: output('Running', `Running in a Tembo session${detailsUrl ? `: ${detailsUrl}` : ''}.`) });
      open.set(name, run.id);
    },
    async complete(name, conclusion, title, summary, text) {
      console.log(`[tembo-ci] ${name}: ${conclusion} (${title})`);
      const id = open.get(name);
      open.delete(name);
      if (github && id) await github('PATCH', `check-runs/${id}`, { status: 'completed', conclusion, completed_at: new Date().toISOString(), output: output(title, summary, text) });
    },
    async reused(name, record, summary) {
      console.log(`[tembo-ci] ${name}: ${record.conclusion} (reused result from ${utc(record.ranAt)})`);
      if (github) await github('POST', 'check-runs', { ...base(name), status: 'completed', conclusion: record.conclusion,
        started_at: record.startedAt, completed_at: record.completedAt, output: output(`Reused: ${record.title}`, summary, record.text) });
    },
    async skip(name, why) {
      console.log(`[tembo-ci] ${name}: skipped (${why})`);
      if (github) await github('POST', 'check-runs', { ...base(name), status: 'completed', conclusion: 'skipped', completed_at: new Date().toISOString(), output: output('Skipped', why) });
    },
    // Never leave a run in progress: an aborted run completes every open check.
    async closeAll(conclusion, reason) {
      for (const name of [...open.keys()]) {
        try { await this.complete(name, conclusion, reason.split('\n')[0].slice(0, 120), `Tembo CI stopped before this job finished.\n\n\`\`\`\n${truncate(reason, 4000)}\n\`\`\``); } catch (error) {
          console.error(`[tembo-ci] could not complete ${name}: ${error.message}`);
        }
      }
    },
  };
}

// The first line of a reused check run says where its result came from.
export function reusedSummary(record, tree, sha) {
  return [`Reused result from ${utc(record.ranAt)}, tree \`${tree}\``, '',
    `This job passed on commit \`${record.commit.slice(0, 12)}\`, which has the same tree as \`${sha.slice(0, 12)}\`, so it was not rerun.`,
    '', record.summary].join('\n');
}

function githubClient(repo, token) {
  return async (method, path, body) => {
    const url = path.startsWith('/') ? `https://api.github.com${path}` : `https://api.github.com/repos/${repo}/${path}`;
    for (let attempt = 1; ; attempt++) {
      const response = await fetch(url, { method, body: body && JSON.stringify(body), headers: {
        authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'tembo-session-ci',
      } });
      if (response.ok) return response.status === 204 ? null : response.json();
      const text = (await response.text()).slice(0, 500);
      if (attempt < 4 && (response.status >= 500 || response.status === 429)) { await new Promise(done => setTimeout(done, attempt * 2000)); continue; }
      throw new Error(`GitHub ${method} ${path}: HTTP ${response.status} ${text}`);
    }
  };
}

function githubToken(repo) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) return token;
  // Tembo sessions expose the app installation token through git's credential helper.
  const result = spawnSync('git', ['credential', 'fill'], { input: `protocol=https\nhost=github.com\npath=${repo}\n\n`, encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  const password = result.status === 0 ? result.stdout.match(/^password=(.+)$/m)?.[1] : undefined;
  if (!password) throw new Error('Set GITHUB_TOKEN (a GitHub App token with checks:write) to post check runs');
  return password;
}

const children = new Set();

// Runs a command in its own process group so a timeout or interrupt stops all of its descendants.
function exec(command, args, { cwd, env, log, deadline }) {
  return new Promise(done => {
    log.write(`\n> ${command} ${args.join(' ')}\n`);
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop(child); }, Math.max(0, deadline - Date.now()));
    child.on('error', error => log.write(`${error.stack}\n`));
    child.on('close', code => {
      clearTimeout(timer);
      children.delete(child);
      log.write(`Exit ${code ?? 'signal'}${timedOut ? ' (timed out)' : ''}\n`);
      done({ status: code ?? 1, timedOut });
    });
  });
}

function stop(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }, 10_000).unref();
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

export function repoFromRemote(url) {
  return url.trim().replace(/^(https:\/\/([^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/, '').replace(/\.git$/, '');
}

async function main(args) {
  const root = git(['rev-parse', '--show-toplevel']);
  const base = option(args, '--base', 'origin/main');
  const timeoutMs = Number(option(args, '--timeout-minutes', '45')) * 60_000;
  const slots = Number(option(args, '--jobs', DEFAULT_SLOTS)) || DEFAULT_SLOTS;
  const pr = option(args, '--pr');
  const repo = option(args, '--repo', process.env.GITHUB_REPOSITORY) ?? repoFromRemote(git(['remote', 'get-url', 'origin'], root));
  const github = pr ? githubClient(repo, githubToken(repo)) : null;
  const runDir = mkdtempSync(join(process.env.TEMBO_SESSION_CI_WORKDIR ?? tmpdir(), 'tembo-ci-'));
  let sha, tree;
  if (pr) {
    sha = (await github('GET', `pulls/${pr}`)).head.sha;
    if (spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: root }).status !== 0) git(['fetch', '--quiet', 'origin', sha], root);
    tree = git(['rev-parse', `${sha}^{tree}`], root);
  } else {
    tree = workingTree(root, runDir);
    sha = testCommit(root, tree);
  }
  const env = environment();
  const noCache = args.includes('--no-cache');
  const saved = readJson(resultsPath(root, tree));
  const baseBranch = base.match(/^origin\/([^~^:@]+)/)?.[1];
  if (baseBranch) spawnSync('git', ['fetch', '--quiet', 'origin', baseBranch], { cwd: root, stdio: 'inherit' });
  const mergeBase = spawnSync('git', ['merge-base', base, sha], { cwd: root, encoding: 'utf8' }).stdout?.trim();
  console.log(`[tembo-ci] ${pr ? `PR #${pr} head` : 'working tree as'} ${sha.slice(0, 12)} (tree ${tree.slice(0, 12)}); ${slots} job(s) at a time`);

  const results = join(root, 'test-results', 'tembo-ci');
  rmSync(results, { recursive: true, force: true });
  mkdirSync(results, { recursive: true });
  const sessionUrl = process.env.TEMBO_SESSION_URL || (process.env.TEMBO_SESSION_ID ? `https://app.tembo.io/sessions/${process.env.TEMBO_SESSION_ID}` : undefined);
  const checks = checkRuns(github, sha, sessionUrl);
  const footer = `Commit \`${sha.slice(0, 12)}\`, tree \`${tree.slice(0, 12)}\`${sessionUrl ? ` · [Tembo session](${sessionUrl}) · logs: \`test-results/tembo-ci/\` in the session checkout` : ''}`;
  const worktree = id => {
    const dir = join(runDir, id);
    git(['worktree', 'add', '--detach', '--quiet', dir, sha], root);
    return dir;
  };
  const cleanup = () => {
    for (const child of children) stop(child);
    if (args.includes('--keep')) return console.log(`[tembo-ci] kept worktrees in ${runDir}`);
    rmSync(runDir, { recursive: true, force: true });
    spawnSync('git', ['worktree', 'prune'], { cwd: root });
  };
  const interrupt = async signal => {
    console.error(`[tembo-ci] ${signal}: stopping`);
    for (const child of children) stop(child);
    await checks.closeAll('cancelled', `Interrupted by ${signal}`);
    cleanup();
    process.exit(130);
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const now = () => new Date().toISOString();
  let gatePosted = false;

  try {
    const reuse = reusable(saved, { tree, env, base: mergeBase, noCache });
    const records = {};
    const runJob = async job => {
      if (reuse.has(job.id)) {
        const record = reuse.get(job.id);
        await checks.reused(job.name, record, `${reusedSummary(record, tree, sha)}\n\n${footer}`);
        return record;
      }
      await checks.start(job.name);
      const startedAt = now();
      const started = performance.now();
      const deadline = Date.now() + timeoutMs;
      const log = createWriteStream(join(results, `${job.id}.log`));
      let status = { status: 1, timedOut: false };
      let dir;
      try {
        dir = worktree(job.id);
        const jobEnv = jobEnvironment(process.env);
        status = job.install === 'always' ? await exec('sh', ['-c', INSTALL], { cwd: dir, env: jobEnv, log, deadline }) : { status: 0 };
        if (!status.status) status = await exec(process.execPath, ['scripts/ci/job.mjs', job.id], { cwd: dir, env: jobEnv, log, deadline });
      } catch (error) {
        log.write(`\n${error.stack ?? error}\n`);
      }
      await new Promise(done => log.end(done));
      if (dir && existsSync(join(dir, 'test-results'))) cpSync(join(dir, 'test-results'), join(results, job.id), { recursive: true });
      const conclusion = status.timedOut ? 'timed_out' : status.status === 0 ? 'success' : 'failure';
      const elapsed = duration(performance.now() - started);
      const verdict = conclusion === 'success' ? 'Passed' : conclusion === 'timed_out' ? 'Timed out' : 'Failed';
      const record = { conclusion, commit: sha, startedAt, completedAt: now(), ranAt: startedAt, title: `${verdict} in ${elapsed}`,
        summary: `**${verdict}** in ${elapsed}.`,
        ...(conclusion === 'success' ? {} : { text: `Last lines of the log:\n\n\`\`\`text\n${logTail(readFileSync(join(results, `${job.id}.log`), 'utf8'))}\n\`\`\`` }) };
      await checks.complete(job.name, conclusion, record.title, `${record.summary}\n\n${footer}`, record.text);
      return record;
    };
    await runPool(JOBS, slots, async job => { records[job.id] = await runJob(job); });

    await checks.start(GATE.name);
    const { passed, errors } = gate(records);
    const table = ['| Job | Result |', '| --- | --- |',
      ...JOBS.map(job => `| ${job.name} | ${records[job.id]?.conclusion ?? 'not run'}${reuse.has(job.id) ? ` (reused from ${utc(records[job.id].ranAt)})` : ''} |`)];
    const summary = [`**${passed ? 'All jobs passed.' : 'Required checks failed.'}**`, '', ...table, '', ...errors.map(error => `- ❌ ${error}`), '', footer].join('\n');
    gatePosted = true;
    await checks.complete(GATE.name, passed ? 'success' : 'failure', passed ? 'All jobs passed' : `${errors.length} problem(s)`, summary);

    mkdirSync(join(root, RESULTS), { recursive: true });
    writeFileSync(resultsPath(root, tree), JSON.stringify({ format: FORMAT, tree, commit: sha, base: mergeBase, environment: env, createdAt: now(), jobs: records }, null, 2) + '\n');
    return passed;
  } catch (error) {
    await checks.closeAll('failure', error.stack ?? String(error));
    if (!gatePosted) {
      try {
        await checks.start(GATE.name);
        await checks.complete(GATE.name, 'failure', 'Tembo CI aborted', `Tembo CI stopped with an error, so the jobs were not verified.\n\n\`\`\`\n${truncate(String(error.message), 4000)}\n\`\`\`\n\n${footer}`);
      } catch (reportError) { console.error(`[tembo-ci] could not post checks: ${reportError.message}`); }
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    cleanup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(passed => {
    console.log(`[tembo-ci] ${passed ? 'all jobs passed' : 'checks failed'}; logs in test-results/tembo-ci/`);
    process.exitCode = passed ? 0 : 1;
  }, error => {
    console.error(`[tembo-ci] ${error.stack ?? error}`);
    process.exitCode = 1;
  });
}
