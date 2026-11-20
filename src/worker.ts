import type { JobRow, openDb } from './db.js';
import { isPrivateHost } from './validate.js';

type Db = ReturnType<typeof openDb>;

type WorkerOptions = {
  tickMs?: number;
  timeoutMs?: number;
  allowPrivate?: boolean;
  baseBackoffMs?: number;
  ratePerSec?: number;
};

const MAX_ATTEMPTS = 4; // 1 try + 3 retries

// Token bucket per destination host. Starts full (burst = ratePerSec), refills ratePerSec tokens per second.
// Each send takes one token. No token = the job waits in the queue and is checked again next tick.
export function makeTokenBuckets(ratePerSec: number) {
  const buckets = new Map<string, { tokens: number; last: number }>();
  return (host: string, now = Date.now()): boolean => {
    const b = buckets.get(host) ?? { tokens: ratePerSec, last: now };
    b.tokens = Math.min(ratePerSec, b.tokens + ((now - b.last) / 1000) * ratePerSec);
    b.last = now;
    buckets.set(host, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

// Pure decision: what to do after one try. Easy to test on its own.
export function decide(code: number | null, permanent: boolean, attempt: number, baseMs: number, now: number) {
  if (code !== null && code >= 200 && code < 300)
    return { attemptStatus: 'success', jobStatus: 'succeeded', nextAt: now } as const;

  // code === null means a network error or timeout. Those are worth retrying.
  const retryable = !permanent && (code === null || code === 429 || code >= 500);
  if (retryable && attempt < MAX_ATTEMPTS)
    return { attemptStatus: 'retrying', jobStatus: 'queued', nextAt: now + baseMs * 2 ** (attempt - 1) } as const; // 2s, 4s, 8s

  return { attemptStatus: 'failed', jobStatus: 'failed', nextAt: now } as const;
}

// Every tick: find due jobs, mark them "delivering" (so no second loop grabs them), then send.
export function startWorker(db: Db, opts: WorkerOptions = {}) {
  const tickMs = opts.tickMs ?? 200;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const allowPrivate = opts.allowPrivate ?? false;
  const baseBackoffMs = opts.baseBackoffMs ?? 2_000;
  const takeToken = makeTokenBuckets(opts.ratePerSec ?? 5);

  const timer = setInterval(() => {
    const now = Date.now();
    for (const job of db.dueJobs(now)) {
      // shortcut: one busy host can push other jobs past the LIMIT 50 window, use per-host queues to fix
      if (!takeToken(new URL(job.destination_url).host, now)) continue; // over the limit: wait for next tick
      db.markDelivering(job.id, now);
      // Not awaited: one slow client must not hold up the other jobs.
      deliver(db, job, { timeoutMs, allowPrivate, baseBackoffMs }).catch((err) => console.error('delivery crashed', job.id, err));
    }
  }, tickMs);

  return { stop: () => clearInterval(timer) };
}

async function deliver(
  db: Db,
  job: JobRow,
  opts: { timeoutMs: number; allowPrivate: boolean; baseBackoffMs: number },
) {
  const attempt = job.attempts + 1;
  const started = Date.now();
  let code: number | null = null;
  let error: string | null = null;
  let permanent = false; // true = never retry (our own block, not the client's fault)

  try {
    // Check again before sending. The stored URL was checked at intake, but we re-check in case.
    if (!opts.allowPrivate && isPrivateHost(new URL(job.destination_url).hostname)) {
      permanent = true;
      throw new Error('destination is a private address');
    }

    const res = await fetch(job.destination_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-event-id': job.event_id,
        'x-webhook-job-id': job.id,
      },
      body: job.payload,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    code = res.status;
    await res.body?.cancel().catch(() => {}); // we don't need the response body
  } catch (err) {
    error = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : String(err);
  }

  const now = Date.now();
  const next = decide(code, permanent, attempt, opts.baseBackoffMs, now);
  db.logAttempt({
    jobId: job.id,
    attempt,
    status: next.attemptStatus,
    statusCode: code,
    error,
    durationMs: now - started,
    now,
  });
  db.finishJob({ id: job.id, status: next.jobStatus, attempts: attempt, nextAt: next.nextAt, now });
}
