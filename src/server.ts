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
