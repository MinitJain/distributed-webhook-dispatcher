# Distributed Webhook Dispatcher

Accepts events over HTTP, saves them, and delivers them to client URLs in the background, with retries and per-client rate limits.

**Live:** https://distributed-webhook-dispatcher-yozq.onrender.com

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Check the server is alive |
| POST | `/api/webhooks/dispatch` | Submit an event. Replies `202` right away |
| GET | `/api/webhooks/jobs/:id` | Job status and every delivery attempt |
| GET/POST | `/api/mock/:code?delayMs=N` | Fake client: replies with `:code` after an optional delay (max 15s) |

## Try it (live)

```bash
URL=https://distributed-webhook-dispatcher-yozq.onrender.com

# 1. Is it alive?
curl $URL/health

# 2. Send an event (returns 202 right away)
curl -X POST $URL/api/webhooks/dispatch \
  -H 'content-type: application/json' \
  -d '{"destinationUrl":"'$URL'/api/mock/200","eventId":"evt_demo_1","payload":{"event":"user.signup","userId":"usr_999"}}'

# 3. Check delivery, using the jobId from step 2
curl $URL/api/webhooks/jobs/PASTE_JOB_ID_HERE
```

**To see retries:** change `mock/200` to `mock/503` in step 2. Wait about 15 seconds, then run step 3. You'll see 4 attempts, with waits of about 2s, 4s and 8s between them, ending in `failed`.

**Bad input** returns `400` with a message:

```bash
curl -X POST $URL/api/webhooks/dispatch -H 'content-type: application/json' \
  -d '{"destinationUrl":"http://169.254.169.254/","eventId":"x","payload":{}}'
# {"error":"destinationUrl points to a private address"}
```

The free host sleeps when idle, so the first request can take 30–60 seconds.

## Run locally

```bash
npm install
npm run build && npm start      # serves on PORT (default 3000)
npm test                        # 16 tests
```

Environment variables:

| Name | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `DB_PATH` | `./data/dispatcher.db` | SQLite file |
| `ALLOW_PRIVATE_DESTINATIONS` | off | Set to `1` only for local testing with `localhost` mocks. Never on the live site |

## How it works

- **Fast intake:** the POST validates the request, saves a row in SQLite, and replies `202`. It never waits for the client's server. A `202` is only sent after the row is saved, so a crash can't lose an accepted event.
- **Background worker:** every 200 ms it picks up due jobs, marks them `delivering` so no other loop takes them, and sends each one with a 10-second timeout. Jobs are sent in parallel.
- **Retries:** network errors, timeouts, `408`, `429` and `5xx` are retried after 2s, 4s and 8s. That's 4 attempts in total. Other `4xx` responses fail right away, because resending the same bad request won't help.
- **Rate limiting:** a token bucket per destination host. Each host gets a burst of 5 sends, then 5 per second. Jobs over the limit wait in the queue. One slow or busy client doesn't hold up the others.
- **Restart safety:** jobs left in `delivering` after a crash go back to `queued` on startup. Every try is written to a `delivery_attempts` table.
- **SSRF guard:** URLs pointing at localhost or private IP ranges are rejected at intake and checked again before each delivery.

## Known limits

These are choices made for this assignment. Each one has a known fix.

- **One instance by design.** Running several copies would need shared rate-limit state (for example Redis) and a safe way for only one worker to claim each job.
- **At-least-once delivery.** A receiver can get the same event twice, for example after a timeout where the client actually got it. Receivers should ignore repeats using the `x-webhook-event-id` header.
- **SSRF check is by address only.** A public hostname that resolves to a private IP gets through. The fix is to resolve DNS and check the IP before connecting.
- **Redirects are followed.** A public URL could redirect to a private address. Fix: don't follow redirects, or check each hop.
- **Retry window is about 14 seconds.** A client that's down for longer won't get the event. Fixes: longer capped backoff, jitter, a dead-letter state, and a replay endpoint.
- **Rate-limit counts reset on restart.**
- **Free hosting:** the service sleeps when idle, and the disk is wiped on every redeploy, so job history is lost then.
- **No HTTP-level automated tests yet.** The routes were checked by hand with curl. The 16 tests cover the validation, retry and rate-limit logic.
