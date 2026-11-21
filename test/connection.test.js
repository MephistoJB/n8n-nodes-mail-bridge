'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { connectWithRetry } = require('../lib/connection');

test('transient connect failures are retried using new clients and exponential backoff', async () => {
  let attempts = 0; const waits = []; let closed = 0;
  const result = await connectWithRetry(() => ({
    attempt: ++attempts, authenticated: false, close() { closed++; },
    async connect() { if (this.attempt < 3) throw Object.assign(new Error('DNS temporarily unavailable'), { code: 'EAI_AGAIN' }); },
  }), 4, async ms => waits.push(ms));
  assert.equal(result.attempt, 3); assert.deepEqual(waits, [1000,2000]); assert.equal(closed, 2);
});

test('authentication failures are not retried', async () => {
  let attempts = 0;
  await assert.rejects(connectWithRetry(() => ({ async connect() { attempts++; throw Error('Authentication failed'); } }), 4, async () => {}), /Authentication failed/);
  assert.equal(attempts, 1);
});
