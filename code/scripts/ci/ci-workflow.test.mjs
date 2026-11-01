// Drift test: .github/workflows/ci.yml must run exactly the jobs jobs.mjs defines, under the same
// names, each step calling `node scripts/ci/job.mjs <id>`, with the Tembo skip on every job and a
// `checks` gate that needs them all. Run: node --test scripts/ci/
// Set CI_WORKFLOW to test another file (the bundle's self-test points it at templates/ci.yml.example).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GATE, JOBS } from './jobs.mjs';

const path = process.env.CI_WORKFLOW ?? fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url));
export const SKIP = "!(github.event.pull_request.head.repo.full_name == github.repository && startsWith(github.head_ref, 'tembo/'))";

// Top-level jobs as { id: text } blocks; enough YAML for a drift check without a dependency.
export function workflowJobs(yaml) {
  const body = yaml.split(/^jobs:\s*$/m)[1] ?? '';
  const jobs = {};
  let current;
  for (const line of body.split('\n')) {
    const key = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (key) { current = key[1]; jobs[current] = ''; continue; }
    if (/^\S/.test(line)) break;
    if (current) jobs[current] += line + '\n';
  }
  return jobs;
}
const field = (text, name) => text.match(new RegExp(`^ {4}${name}:\\s*(.+)$`, 'm'))?.[1].trim();

test('ci.yml runs the jobs jobs.mjs defines', () => {
  const jobs = workflowJobs(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(jobs).sort(), [...JOBS.map(job => job.id), GATE.id].sort());
  for (const job of JOBS) {
    const text = jobs[job.id];
    assert.equal(field(text, 'name'), job.name, `${job.id}: name`);
    assert.ok(text.includes(`node scripts/ci/job.mjs ${job.id}`), `${job.id}: step must run node scripts/ci/job.mjs ${job.id}`);
    assert.ok(field(text, 'if')?.includes(SKIP), `${job.id}: needs the Tembo skip condition`);
  }
  const gate = jobs[GATE.id];
  assert.equal(field(gate, 'name'), GATE.name);
  assert.ok(field(gate, 'if')?.startsWith('always()') && field(gate, 'if').includes(SKIP), 'checks: if: always() && Tembo skip');
  const needs = field(gate, 'needs')?.replace(/[[\]\s]/g, '').split(',').sort();
  assert.deepEqual(needs, JOBS.map(job => job.id).sort(), 'checks must need every job');
});
