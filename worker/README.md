# The signalling relay

STATIONS has no backend and does not want one. This is the exception, and
it exists for a single reason: **a link can carry a WebRTC offer out, but
nothing carries the answer back.** Two phones cannot introduce themselves
to each other without something in the middle holding the door.

So this is the smallest thing that can do that job. It relays two strings
between two people and then gets out of the way — the moment the call
connects, the page closes the socket and every byte after that is peer to
peer. No workout data passes through it. Nothing is logged. A room's
contents are dropped when both sides leave, or after 30 minutes,
whichever comes first.

## What it costs

Nothing, at any plausible size for this app. On the Workers free plan you
get 100,000 requests a day, and SQLite-backed Durable Objects with the
WebSocket Hibernation API — which is the whole trick: a room spends
almost all of its life asleep waiting for the second person to open the
link, and a hibernated socket is not billed for that wait.

TURN is the other half. Plain STUN connects most calls, but not the ones
where either person is behind symmetric NAT — office wifi, hotel wifi,
most universities. Cloudflare's TURN gives 1,000 GB a month free, which
is far more relayed video than this app will ever produce. Without it the
app still works; it just fails to connect for a real minority of people,
and says so.

## Already deployed

**Live at `https://stations-signal.andre-rafizadeh.workers.dev`**, deployed
2026-08-20 through the Cloudflare dashboard rather than from a laptop.

It is wired to this repository: Cloudflare watches `betterplasticsurgery/stations`,
builds from the `/worker` root directory, and runs `npx wrangler deploy` on every
push to `main`. **So changing `signal.js` and pushing is the whole redeploy
process** — there is nothing to run by hand.

Build history: Workers & Pages → stations-signal → Deployments.
A note on reading it: the live build log streams unreliably and can sit on
"Initializing build environment…" for minutes after the build has actually
finished. Check the build *history* list for the green tick rather than
believing the log.

## Deploying it somewhere else

```sh
cd worker
npx wrangler deploy
```

Wrangler will ask you to log in the first time. When it finishes it prints
the URL — something like `https://stations-signal.<you>.workers.dev`.

## Turn TURN on — the one thing still outstanding

Right now `/ice` returns public STUN only. Confirm it yourself:
`https://stations-signal.andre-rafizadeh.workers.dev/ice` — if the response
has no `turn:` URLs in it, TURN is off, and calls where either person is on
office, hotel or university wifi will fail to connect.

1. Cloudflare dashboard → **Realtime** → **TURN Server** → create a key.
2. Note the key ID and the API token.
3. Add them as secrets. Either from a terminal:
   ```sh
   cd worker
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_KEY_API_TOKEN
   ```
   or in the dashboard: Workers & Pages → stations-signal → Settings →
   **Variables and Secrets** → add each as type **Secret**.

Secrets are not in this repo and must never be. `signal.js` reads them from
`env` and falls back to public STUN when they are absent, so a missing secret
costs you some calls rather than all of them.

Without those two secrets `/ice` quietly returns public STUN instead. That
is a deliberate fallback, not a failure — check it by opening
`https://<your-worker>/ice` and looking for `turn:` URLs in the response.

## How the app finds it

One line, in section 16 of `index.html`, already filled in:

```js
const DUO_RELAY = (typeof window !== "undefined" && window.STATIONS_RELAY) ||
      "https://stations-signal.andre-rafizadeh.workers.dev";
```

Left empty, **Train together** tells the user it isn't set up rather than
failing somewhere deep inside a WebSocket handler. Everything else in the
app works exactly as before — this is the only feature that touches it.

`window.STATIONS_RELAY` is the override the tests use to point at a local
relay, and it lets a working copy aim at a dev Worker without editing the
file.

## Origins

`ALLOWED` in `signal.js` lists who gets the CORS header on `/ice`:
`stations.fit`, the Pages domain, and localhost. Add to it if the app ever
gets served from somewhere else. The room WebSocket is deliberately not
origin-locked — there is nothing in a room worth stealing, and a strict
check there mostly breaks people rather than protecting them.
