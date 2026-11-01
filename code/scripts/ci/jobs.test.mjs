import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GATE, invocation, job, JOBS } from './jobs.mjs';

test('defines each job once, with unique names', () => {
  assert.equal(new Set(JOBS.map(entry => entry.id)).size, JOBS.length);
  assert.equal(new Set([...JOBS.map(entry => entry.name), GATE.name]).size, JOBS.length + 1);
  assert.ok(!JOBS.some(entry => entry.id === GATE.id));
  for (const entry of JOBS) assert.ok(typeof entry.run === 'string' && entry.run, `${entry.id}: run`);
  assert.throws(() => job('nope'), /Unknown CI job "nope"/);
});

test('builds the command each runner executes', () => {
  const first = JOBS[0];
  assert.deepEqual(invocation(first.id, { extra: ['--x'] }), { command: `${first.run} --x`, env: first.env ?? {} });
});
