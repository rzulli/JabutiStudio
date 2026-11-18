import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOptionArgs, agentCapabilities, BUILTIN_AGENTS } from '../src/services/agentRegistry.js';

test('codex lists the models its CLI offers, and passes the chosen one with -m', () => {
  const { models } = agentCapabilities('codex');
  assert.ok(models.some(m => m.id === 'gpt-6-sol'));
  assert.ok(!models.some(m => m.id === 'gpt-reserve' || m.id === 'codex-auto-review'));
  assert.match(runOptionArgs('codex', { model: 'gpt-6-sol' }), /-m 'gpt-6-sol'/);
});

test('codex starts with automatic approval, not a prompt per command', () => {
  const codex = BUILTIN_AGENTS.find(a => a.id === 'codex');
  assert.ok(codex);
  assert.match(codex.args, /--approve-for-me/);
});

test('claude takes model and effort flags', () => {
  const args = runOptionArgs('claude', { model: 'opus', effort: 'high' });
  assert.match(args, /--model .*opus/);
  assert.match(args, /--effort high/);
});

test('codex maps effort to its reasoning config', () => {
  assert.match(runOptionArgs('codex', { effort: 'medium' }), /model_reasoning_effort=medium/);
});

test('codex offers the effort levels its catalog lists', () => {
  assert.deepEqual(agentCapabilities('codex').efforts, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  assert.match(runOptionArgs('codex', { effort: 'ultra' }), /model_reasoning_effort=ultra/);
});

test('a harness without an effort flag ignores effort but keeps the model', () => {
  const args = runOptionArgs('gemini', { model: 'gemini-2.5-pro', effort: 'high' });
  assert.match(args, /-m .*gemini-2\.5-pro/);
  assert.doesNotMatch(args, /effort/);
});

test('unknown effort levels and shell-unsafe model ids are dropped', () => {
  assert.equal(runOptionArgs('claude', { effort: 'ultra' }), '');
  assert.equal(runOptionArgs('claude', { model: 'opus; rm -rf /' }), '');
  assert.equal(runOptionArgs('claude', { model: '$(whoami)' }), '');
});

test('custom agents get no flags and no capabilities', () => {
  assert.equal(runOptionArgs('my-cli', { model: 'x', effort: 'high' }), '');
  assert.deepEqual(agentCapabilities('my-cli'), { models: [], efforts: [] });
});
