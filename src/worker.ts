import type { JobRow, openDb } from './db.js';
import { isPrivateHost } from './validate.js';

type Db = ReturnType<typeof openDb>;

type WorkerOptions = {
  tickMs?: number;
  timeoutMs?: number;
  allowPrivate?: boolean;
};

// Every tick: find due jobs, mark them "delivering" (so no second loop grabs them), then send.
export function startWorker(db: Db, opts: WorkerOptions = {}) {
  const tickMs = opts.tickMs ?? 200;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const allowPrivate = opts.allowPrivate ?? false;

  const timer = setInterval(() => {
    const now = Date.now();
    for (const job of db.dueJobs(now)) {
      db.markDelivering(job.id, now);
      // Not awaited: one slow client must not hold up the other jobs.
      deliver(db, job, { timeoutMs, allowPrivate }).catch((err) => console.error('delivery crashed', job.id, err));
    }
  }, tickMs);

  return { stop: () => clearInterval(timer) };
}

async function deliver(db: Db, job: JobRow, opts: { timeoutMs: number; allowPrivate: boolean }) {
  const attempt = job.attempts + 1;
  const started = Date.now();
  let code: number | null = null;
  let error: string | null = null;
  let ok = false;

  try {
    // Check again before sending. The stored URL was checked at intake, but we re-check in case.
    if (!opts.allowPrivate && isPrivateHost(new URL(job.destination_url).hostname))
      throw new Error('destination is a private address');

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
    ok = res.ok;
    await res.body?.cancel().catch(() => {}); // we don't need the response body
  } catch (err) {
    error = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : String(err);
  }

  const now = Date.now();
  db.logAttempt({
    jobId: job.id,
    attempt,
    status: ok ? 'success' : 'failed',
    statusCode: code,
    error,
    durationMs: now - started,
    now,
  });
  db.finishJob({ id: job.id, status: ok ? 'succeeded' : 'failed', attempts: attempt, nextAt: now, now });
}
