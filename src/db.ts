import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type NewJob = {
  id: string;
  destinationUrl: string;
  eventId: string;
  payload: Record<string, unknown>;
  now: number;
};

export function openDb(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      destination_url TEXT NOT NULL,
      event_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,            -- queued | delivering | succeeded | failed
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS delivery_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,            -- success | retrying | failed
      status_code INTEGER,
      error TEXT,
      duration_ms INTEGER,
      created_at INTEGER NOT NULL
    );
  `);

  // If the server died mid-delivery, those jobs are put back in the queue.
  db.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'delivering'").run();

  const insert = db.prepare(`INSERT INTO jobs
    (id, destination_url, event_id, payload, status, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`);
  const getJob = db.prepare('SELECT * FROM jobs WHERE id = ?');
  const getAttempts = db.prepare(`SELECT attempt, status, status_code, error, duration_ms, created_at
    FROM delivery_attempts WHERE job_id = ? ORDER BY id`);
  const logAttempt = db.prepare(`INSERT INTO delivery_attempts
    (job_id, attempt, status, status_code, error, duration_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

  return {
    getJob: (id: string) => getJob.get(id) as Record<string, unknown> | undefined,
    getAttempts: (id: string) => getAttempts.all(id) as Record<string, unknown>[],
    logAttempt: (a: { jobId: string; attempt: number; status: string; statusCode: number | null; error: string | null; durationMs: number; now: number }) =>
      logAttempt.run(a.jobId, a.attempt, a.status, a.statusCode, a.error, a.durationMs, a.now),

    // Synchronous: returns only after SQLite has the row. That is what makes our 202 honest.
    insertJob(job: NewJob) {
      insert.run(job.id, job.destinationUrl, job.eventId, JSON.stringify(job.payload), job.now, job.now, job.now);
    },
  };
}
