import assert from 'node:assert/strict';
import test from 'node:test';
import { toolNeedsPrompt, batchStepNeedsPrompt, fileActionNeedsExtraPrompt, fileActionKinds } from '../dist/packages/dsh-adapter/src/approval-policy.js';

const modes = ['per-action', 'per-lease', 'trusted', 'personal'];

test('invariant: an upload or file-chooser action is prompted in every approval mode (download is not)', () => {
  assert.deepEqual([...fileActionKinds].sort(), ['choose', 'upload']);
  for (const mode of modes) {
    // Either the enclosing act call is prompted up front, or the adapter prompts for the file action itself.
    assert.equal(toolNeedsPrompt(mode, 'act') || fileActionNeedsExtraPrompt(mode), true, mode);
  }
});

test('invariant: batch never carries file actions past a missing prompt', () => {
  // Batches reject file actions at validation; per-action additionally prompts every step.
  assert.equal(batchStepNeedsPrompt('per-action'), true);
  for (const mode of ['per-lease', 'trusted', 'personal']) assert.equal(batchStepNeedsPrompt(mode), false, mode);
});

test('prompt matrix stays as documented', () => {
  assert.deepEqual(['claim', 'open', 'close', 'act', 'screenshot', 'task'].filter(t => toolNeedsPrompt('per-action', t)).length, 6);
  assert.deepEqual(['claim', 'open', 'act', 'observe'].filter(t => toolNeedsPrompt('per-lease', t)), ['claim', 'open']);
  for (const mode of ['trusted', 'personal']) assert.equal(['claim', 'open', 'act', 'screenshot'].some(t => toolNeedsPrompt(mode, t)), false, mode);
});
