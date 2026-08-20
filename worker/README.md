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

## Deploy

```sh
cd worker
npx wrangler deploy
```

Wrangler will ask you to log in the first time. When it finishes it prints
the URL — something like `https://stations-signal.<you>.workers.dev`.

Then turn TURN on (optional, recommended):

1. Cloudflare dashboard → **Realtime** → **TURN Keys** → create one.
2. Note the key ID and the API token.
3. ```sh
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_KEY_API_TOKEN
   ```

Without those two secrets `/ice` quietly returns public STUN instead. That
is a deliberate fallback, not a failure — check it by opening
`https://<your-worker>/ice` and looking for `turn:` URLs in the response.

## Point the app at it

One line, in section 16 of `index.html`:

```js
const DUO_RELAY = (typeof window !== "undefined" && window.STATIONS_RELAY) || "";
```

Put your Worker URL in as the fallback:

```js
const DUO_RELAY = (typeof window !== "undefined" && window.STATIONS_RELAY) || "https://stations-signal.<you>.workers.dev";
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
