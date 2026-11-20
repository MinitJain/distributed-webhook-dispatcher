import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type JobRow = {
  id: string;
  destination_url: string;
  event_id: string;
  payload: string; // JSON text
  status: string;
  attempts: number;
  next_attempt_at: number;
};

export type AttemptRow = {
  attempt: number;
  status: string;
  status_code: number | null;
  error: string | null;
  duration_ms: number;
  created_at: number;
};

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

  const due = db.prepare(`SELECT * FROM jobs WHERE status = 'queued' AND next_attempt_at <= ?
    ORDER BY next_attempt_at LIMIT 50`);
  const markDelivering = db.prepare("UPDATE jobs SET status = 'delivering', updated_at = ? WHERE id = ?");
  const finish = db.prepare('UPDATE jobs SET status = ?, attempts = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?');

  return {
    dueJobs: (now: number) => due.all(now) as JobRow[],
    markDelivering: (id: string, now: number) => markDelivering.run(now, id),
    finishJob: (j: { id: string; status: string; attempts: number; nextAt: number; now: number }) =>
      finish.run(j.status, j.attempts, j.nextAt, j.now, j.id),
    getJob: (id: string) => getJob.get(id) as JobRow | undefined,
    getAttempts: (id: string) => getAttempts.all(id) as AttemptRow[],
    logAttempt: (a: { jobId: string; attempt: number; status: string; statusCode: number | null; error: string | null; durationMs: number; now: number }) =>
      logAttempt.run(a.jobId, a.attempt, a.status, a.statusCode, a.error, a.durationMs, a.now),

    // Synchronous: returns only after SQLite has the row. That is what makes our 202 honest.
    insertJob(job: NewJob) {
      insert.run(job.id, job.destinationUrl, job.eventId, JSON.stringify(job.payload), job.now, job.now, job.now);
    },
  };
}
