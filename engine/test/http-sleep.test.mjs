import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { sleep } from '../lib/http.js';

test('completed provider polling waits do not retain abort listeners', async () => {
  const controller = new AbortController();
  for (let i = 0; i < 50; i++) await sleep(0, controller.signal);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation rejects a pending wait and removes its listener', async () => {
  const controller = new AbortController();
  const pending = sleep(60_000, controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(sleep(0, controller.signal), /cancelled/);
});
