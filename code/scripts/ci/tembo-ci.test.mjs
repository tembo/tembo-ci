import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRuns, environment, gate, jobEnvironment, JOBS, logTail, repoFromRemote, reusable, runPool, testCommit, truncate, workingTree } from './tembo-ci.mjs';

test('runPool never runs more than N at once', async () => {
  let running = 0, peak = 0;
  await runPool([1, 2, 3, 4, 5], 2, async () => { running++; peak = Math.max(peak, running); await new Promise(r => setTimeout(r, 10)); running--; });
  assert.equal(peak, 2);
});

test('strips GitHub tokens from job environments', () => {
  const env = jobEnvironment({ GITHUB_TOKEN: 'x', GH_TOKEN: 'y', PATH: '/bin' });
  assert.equal(env.GITHUB_TOKEN, undefined); assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.CI, 'true'); assert.equal(env.PATH, '/bin');
});

test('reuses only passed results for the same tree, toolchain and merge base', () => {
  const saved = { format: 1, tree: 't', environment: 'e', base: 'b', jobs: { a: { conclusion: 'success' }, b: { conclusion: 'failure' } } };
  assert.deepEqual([...reusable(saved, { tree: 't', env: 'e', base: 'b' }).keys()], ['a']);
  assert.equal(reusable(saved, { tree: 't2', env: 'e', base: 'b' }).size, 0);
  assert.equal(reusable(saved, { tree: 't', env: 'e2', base: 'b' }).size, 0);
  assert.equal(reusable(saved, { tree: 't', env: 'e', base: 'b2' }).size, 0);
  assert.equal(reusable(saved, { tree: 't', env: 'e', base: 'b', noCache: true }).size, 0);
});

test('environment key changes with Node or pnpm version', () => {
  assert.notEqual(environment({ node: 'v22', pnpm: '9' }), environment({ node: 'v20', pnpm: '9' }));
  assert.notEqual(environment({ node: 'v22', pnpm: '9' }), environment({ node: 'v22', pnpm: '10' }));
});

test('gate passes only when every job succeeded', () => {
  const ok = Object.fromEntries(JOBS.map(job => [job.id, { conclusion: 'success' }]));
  assert.equal(gate(ok).passed, true);
  assert.equal(gate({ ...ok, [JOBS[0].id]: { conclusion: 'failure' } }).passed, false);
});

test('reads owner/repo from common remote URLs', () => {
  for (const url of ['https://github.com/acme/widget.git', 'git@github.com:acme/widget.git', 'ssh://git@github.com/acme/widget', 'https://x-access-token@github.com/acme/widget.git'])
    assert.equal(repoFromRemote(url), 'acme/widget');
});

test('truncates output and strips ANSI from log tails', () => {
  assert.ok(truncate('a'.repeat(100), 50).length <= 50);
  assert.equal(logTail('\u001b[31mred\u001b[0m\nok'), 'red\nok');
});

test('without a client, check runs only print', async () => {
  const checks = checkRuns(null, 'abc');
  await checks.start('lint'); await checks.complete('lint', 'success', 'ok', 'ok');
  assert.equal(checks.open.size, 0);
});

test('working tree and test commit are deterministic and leave the index alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'tci-'));
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  git('init', '-q'); writeFileSync(join(root, 'a'), '1'); git('add', 'a'); git('commit', '-qm', 'init', '--no-gpg-sign');
  const clean = workingTree(root, mkdtempSync(join(tmpdir(), 'tci-s-')));
  assert.equal(testCommit(root, clean), git('rev-parse', 'HEAD'));
  writeFileSync(join(root, 'b'), '2');
  const tree = workingTree(root, mkdtempSync(join(tmpdir(), 'tci-s-')));
  assert.notEqual(tree, clean);
  assert.equal(testCommit(root, tree), testCommit(root, tree));
  assert.equal(git('status', '--porcelain'), '?? b');
});
