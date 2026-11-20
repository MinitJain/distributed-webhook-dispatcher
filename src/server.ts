import express from 'express';
import { randomUUID } from 'node:crypto';
import { openDb } from './db.js';
import { validateDispatch } from './validate.js';
import { startWorker } from './worker.js';

const app = express();
app.use(express.json({ limit: '100kb' }));

const db = openDb(process.env.DB_PATH || './data/dispatcher.db');
const allowPrivate = process.env.ALLOW_PRIVATE_DESTINATIONS === '1'; // local testing only
startWorker(db, { allowPrivate });

// Root: lists the endpoints so the live site isn't a bare "Cannot GET /".
app.get('/', (_req, res) => {
  res.json({
    service: 'distributed-webhook-dispatcher',
    endpoints: [
      'GET /health',
      'POST /api/webhooks/dispatch',
      'GET /api/webhooks/jobs/:id',
      'GET|POST /api/mock/:code?delayMs=N',
    ],
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post('/api/webhooks/dispatch', (req, res) => {
  const result = validateDispatch(req.body, { allowPrivate });
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }

  const jobId = randomUUID();
  db.insertJob({ id: jobId, ...result.value, now: Date.now() });
  res.status(202).json({ status: 'queued', jobId }); // stored, not delivered yet
});

// Status of one job, with every delivery try.
app.get('/api/webhooks/jobs/:id', (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  res.json({
    jobId: job.id,
    eventId: job.event_id,
    destinationUrl: job.destination_url,
    status: job.status,
    attempts: job.attempts,
    deliveryAttempts: db.getAttempts(job.id).map((a) => ({
      attempt: a.attempt,
      status: a.status,
      statusCode: a.status_code,
      error: a.error,
      durationMs: a.duration_ms,
      at: new Date(a.created_at).toISOString(),
    })),
  });
});

// Fake client for testing: replies with the status code in the URL, after an optional delay.
app.all('/api/mock/:code', async (req, res) => {
  const code = Number(req.params.code);
  if (!Number.isInteger(code) || code < 200 || code > 599) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const delay = Math.min(Number(req.query.delayMs) || 0, 15_000);
  await new Promise((r) => setTimeout(r, delay));
  res.status(code).json({ received: true, status: code });
});

// Last middleware: body-parser errors (bad JSON, 413) and anything else. Never send stack traces out.
app.use((err: { status?: number; message?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'internal error' : (err.message ?? 'bad request') });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(JSON.stringify({ msg: 'listening', port }));
});
