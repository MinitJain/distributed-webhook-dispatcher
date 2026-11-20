import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { startWorker, decide, makeTokenBuckets } from '../src/worker.js';

// ---------- pure rules ----------

test('decide: 2xx succeeds', () => {
  assert.equal(decide(200, false, 1, 2000, 0).jobStatus, 'succeeded');
});

test('decide: 5xx, 429 and network errors retry with 2s, 4s, 8s waits', () => {
  for (const code of [500, 503, 408, 429, null]) {
    assert.equal(decide(code, false, 1, 2000, 0).nextAt, 2000);
    assert.equal(decide(code, false, 2, 2000, 0).nextAt, 4000);
    assert.equal(decide(code, false, 3, 2000, 0).nextAt, 8000);
    assert.equal(decide(code, false, 3, 2000, 0).jobStatus, 'queued');
  }
});

test('decide: gives up after 4 attempts', () => {
  assert.equal(decide(500, false, 4, 2000, 0).jobStatus, 'failed');
});

test('decide: other 4xx and permanent blocks never retry', () => {
  assert.equal(decide(400, false, 1, 2000, 0).jobStatus, 'failed');
  assert.equal(decide(null, true, 1, 2000, 0).jobStatus, 'failed');
});

test('token bucket: burst of 2, then refills over time, per host', () => {
  const take = makeTokenBuckets(2);
  assert.equal(take('a', 0), true);
  assert.equal(take('a', 0), true);
  assert.equal(take('a', 0), false); // burst used up
  assert.equal(take('a', 500), true); // 500 ms = 1 token back at 2/sec
  assert.equal(take('b', 0), true); // other host has its own bucket
});

// ---------- full flow against a local receiver ----------

// Receiver replies with the next code from `plan`, or 200 when the plan is empty.
async function receiver(plan: number[]) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(plan.shift() ?? 200).end());
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { server, url: `http://localhost:${(server.address() as { port: number }).port}/hook` };
}

async function waitForFinal(db: ReturnType<typeof openDb>, id: string) {
  for (let i = 0; i < 300; i++) {
    const job = db.getJob(id);
    if (job && (job.status === 'succeeded' || job.status === 'failed')) return job;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`job ${id} never finished`);
}

async function runOne(plan: number[], opts: { allowPrivate?: boolean; url?: string } = {}) {
  const r = await receiver(plan);
  const db = openDb(':memory:');
  const worker = startWorker(db, { tickMs: 5, allowPrivate: true, baseBackoffMs: 10, ...opts });
  try {
    db.insertJob({ id: 'j', destinationUrl: opts.url ?? r.url, eventId: 'e', payload: { a: 1 }, now: Date.now() });
    const job = await waitForFinal(db, 'j');
    return { job, attempts: db.getAttempts('j') };
  } finally {
    worker.stop();
    r.server.close();
  }
}

test('flow: 503, 503, then 200 succeeds on attempt 3', async () => {
  const { job, attempts } = await runOne([503, 503, 200]);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.attempts, 3);
  assert.deepEqual(attempts.map((a) => a.status), ['retrying', 'retrying', 'success']);
});

test('flow: always 500 gives up after exactly 4 attempts', async () => {
  const { job, attempts } = await runOne([500, 500, 500, 500]);
  assert.equal(job.status, 'failed');
  assert.equal(attempts.length, 4);
});

test('flow: 400 is not retried', async () => {
  const { job } = await runOne([400]);
  assert.equal(job.status, 'failed');
  assert.equal(job.attempts, 1);
});

test('flow: private destination is blocked at delivery and not retried', async () => {
  const { job, attempts } = await runOne([], { allowPrivate: false, url: 'http://127.0.0.1:1/x' });
  assert.equal(job.status, 'failed');
  assert.equal(attempts.length, 1);
  assert.match(attempts[0].error ?? '', /private address/);
});
