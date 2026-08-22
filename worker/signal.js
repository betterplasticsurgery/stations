/* =========================================================
   STATIONS — signalling relay
   =========================================================
   The only server this project has, and it is deliberately the
   smallest one that can exist: two people need to swap a WebRTC
   offer and an answer, and a link cannot carry the answer back.
   Nothing about a workout passes through here, nothing is logged,
   and a room's contents are dropped the moment both sides leave
   or ROOM_TTL_MS elapses — whichever comes first.

   It is also the only place a paywall can honestly live. A price
   gate written into index.html is worth nothing — the source is
   public and devtools is one tap away. But a duo call physically
   cannot happen without this relay, so refusing to open a room is
   a gate that cannot be edited around.

   Routes
     GET  /ice            → ICE servers. Cloudflare TURN when the
                            secrets are set, public STUN otherwise.
     GET  /room/<code>    → WebSocket. Everything sent is relayed
                            verbatim to the other side of the room.
     POST /coach          → a whole session's coaching script,
                            written fresh. One call per workout,
                            never one per interval.
     GET  /trial?did=     → how many free sessions are left.
     POST /interest       → an email from someone who hit the wall.
     GET  /interest/export?key= → that list as CSV. Needs ADMIN_KEY.
     GET  /admin?key=     → the same thing as a page you can read
                            on a phone. Needs ADMIN_KEY.
     GET  /price          → what a subscription costs, read from
                            Stripe so the app never hardcodes it.
     POST /subscribe      → a Stripe Checkout session to send them to.
     POST /activate       → binds a completed checkout to a device.
     POST /stripe/webhook → cancellations and failed payments.
     POST /account/new    → an account for this device, and the one
                            recovery code that can move it elsewhere.
     POST /account/redeem → hand that code to a second device.
     GET  /account/me     → who the bearer token says you are.
     POST /account/rotate → a fresh code, killing the old one.
     GET  /account/google/start    → off to Google.
     GET  /account/google/callback → back from Google, with a session.
     POST /account/link/start      → email somebody a sign-in link.
     GET  /account/link/finish     → that link, clicked.

   Deploy: see worker/README.md
   ========================================================= */

import { DurableObject } from "cloudflare:workers";

const ROOM_TTL_MS = 30 * 60 * 1000;   // a room is for joining, not for living in
const MAX_PEERS   = 2;                 // duo means two
const MAX_MSG     = 96 * 1024;         // an SDP offer is ~2.5 KB; this is generous
const FREE_CALLS  = 3;                 // "your first workout on us", three times over

/* The page is served from GitHub Pages and from the custom domain, and
   from localhost while someone is working on it. Anything else is not
   turned away — a signalling relay has nothing worth stealing — but only
   these get the CORS header they need for /ice. */
const ALLOWED = [
  "https://stations.fit",
  "https://www.stations.fit",
  "https://betterplasticsurgery.github.io"
];

function corsFor(req){
  const o = req.headers.get("Origin") || "";
  const ok = ALLOWED.includes(o) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return {
    "Access-Control-Allow-Origin": ok ? o : ALLOWED[0],
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
}

const PUBLIC_STUN = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }
];

/* Every secret is read through here, and the only thing it does is
   trim. Copying a client id out of a console and pasting it into a
   settings box brings a trailing newline more often than not, and the
   failure it causes is invisible: the value looks right in the box, the
   configured-or-not check passes because the string is non-empty, and
   the far end simply says it has never heard of you. Google answers a
   client id with a newline on the end with "invalid_client", which
   reads as "you set this up wrong" rather than "there is whitespace in
   your paste". One .trim() in one place, forever. */
const E = (env, k) => (env && typeof env[k] === "string") ? env[k].trim() : env[k];

/* And for the ones that are identifiers rather than prose, every space
   goes — not just the ends. A client id arrived once as

     951154917637- Oiu6sc77ni9ba06u8bv3lu6p359rre37.ap ps.googleusercontent.com

   with spaces INSIDE it, because a copy off a wrapped line brings the
   wrap with it. trim() cannot help with that, and the value still looks
   right in a settings box, and Google answers "the OAuth client was not
   found" — which sends you off to re-check the part that was correct.

   None of these can legitimately contain whitespace: a key, a token, an
   id, a hex secret. NOTIFY_FROM and ADMIN_EMAIL are not on this list,
   because "STATIONS <hello@stations.fit>" has a space in it on purpose. */
const ID = (env, k) => {
  const v = E(env, k);
  return typeof v === "string" ? v.replace(/\s+/g, "") : v;
};

const ledger = env => env.LEDGER.get(env.LEDGER.idFromName("v1"));

export default {
  async fetch(req, env, ctx){
    const url = new URL(req.url);
    const cors = corsFor(req);

    if (req.method === "OPTIONS") return new Response(null, { status:204, headers:cors });

    if (url.pathname === "/ice"){
      return new Response(JSON.stringify(await iceServers(env)), {
        headers: { ...cors, "Content-Type":"application/json",
                   "Cache-Control":"no-store" }
      });
    }

    if (url.pathname === "/trial"){
      const did = (url.searchParams.get("did") || "").slice(0, 64);
      const who = await whoIs(env, req, did);
      const r = await ledger(env).fetch(new Request("https://l/state?did=" +
        encodeURIComponent(who.did) + "&uid=" + encodeURIComponent(who.uid)));
      return new Response(await r.text(), {
        headers: { ...cors, "Content-Type":"application/json", "Cache-Control":"no-store" }});
    }

    if (url.pathname === "/interest" && req.method === "POST"){
      let body = {};
      try{ body = await req.json(); }catch(e){}
      /* Consent has to be provable, and the proof cannot come from the
         page — a client can claim any IP it likes. Cloudflare puts the
         real one on the request. */
      body = Object.assign({}, body, { ip: req.headers.get("CF-Connecting-IP") || "" });
      const r = await ledger(env).fetch(new Request("https://l/interest", {
        method:"POST", body: JSON.stringify(body) }));
      const text = await r.text();
      /* Tell Andre, but never make the person on the wall wait for it —
         and never fail their signup because a mail provider was down. */
      if (r.ok) ctx.waitUntil(notify(env, body).catch(() => {}));
      return new Response(text, { status:r.status,
        headers: { ...cors, "Content-Type":"application/json" }});
    }

    /* The list, as something readable on a phone. Same key as the CSV. */
    if (url.pathname === "/admin"){
      if (!ID(env,"ADMIN_KEY") || url.searchParams.get("key") !== ID(env,"ADMIN_KEY"))
        return new Response("nope", { status:404, headers:cors });
      const r = await ledger(env).fetch(new Request("https://l/dump"));
      return new Response(adminPage(await r.json(), url.searchParams.get("key")), {
        headers: { ...cors, "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store" }});
    }

    /* Deliberately not clever: one shared secret, and without it set the
       list simply is not reachable from the internet. */
    if (url.pathname === "/interest/export"){
      if (!ID(env,"ADMIN_KEY") || url.searchParams.get("key") !== ID(env,"ADMIN_KEY"))
        return new Response("nope", { status:404, headers:cors });
      const r = await ledger(env).fetch(new Request("https://l/export"));
      return new Response(await r.text(), {
        headers: { ...cors, "Content-Type":"text/csv", "Cache-Control":"no-store" }});
    }

    if (url.pathname === "/coach" && req.method === "POST"){
      let body = {};
      try{ body = await req.json(); }catch(e){}
      const out = await coachScript(env, body || {});
      return new Response(JSON.stringify(out), {
        status: out.ok ? 200 : 502,
        headers: { ...cors, "Content-Type":"application/json", "Cache-Control":"no-store" }});
    }

    /* ---- billing ----
       Every one of these is dead until the Stripe secrets are set, and
       the wall behaves exactly as it does today in the meantime. */
    if (url.pathname === "/price"){
      return new Response(JSON.stringify(await stripePrice(env)), {
        headers: { ...cors, "Content-Type":"application/json", "Cache-Control":"public, max-age=300" }});
    }
    if (url.pathname === "/subscribe" && req.method === "POST"){
      let b = {}; try{ b = await req.json(); }catch(e){}
      const out = await stripeCheckout(env, b || {}, url.origin);
      return new Response(JSON.stringify(out), { status: out.ok ? 200 : 400,
        headers: { ...cors, "Content-Type":"application/json" }});
    }
    if (url.pathname === "/activate" && req.method === "POST"){
      let b = {}; try{ b = await req.json(); }catch(e){}
      const out = await stripeActivate(env, b || {}, req);
      return new Response(JSON.stringify(out), { status: out.ok ? 200 : 400,
        headers: { ...cors, "Content-Type":"application/json" }});
    }
    if (url.pathname === "/stripe/webhook" && req.method === "POST"){
      return stripeWebhook(env, req);
    }

    /* ---- accounts ----
       Dead until AUTH_SECRET is set, and the app behaves exactly as it
       does today in the meantime. */
    if (url.pathname.startsWith("/account/")){
      const j = (o, st) => new Response(JSON.stringify(o), { status: st || (o.ok ? 200 : 400),
        headers: { ...cors, "Content-Type":"application/json", "Cache-Control":"no-store" }});
      let b = {}; if (req.method === "POST") { try{ b = await req.json(); }catch(e){} }

      /* Redirects, not JSON — these two are navigated to, not fetched. */
      if (url.pathname === "/account/link/finish")     return linkFinish(env, url);
      if (url.pathname === "/account/link/start" && req.method === "POST")
        return j(await linkStart(env, req, b || {}));
      if (url.pathname === "/account/google/start")    return googleStart(env, req, url);
      if (url.pathname === "/account/google/callback") return googleCallback(env, url);
      if (url.pathname === "/account/me")
        return j(await acctMe(env, req, (url.searchParams.get("did") || "").slice(0,64)), 200);
      if (url.pathname === "/account/new" && req.method === "POST")
        return j(await acctNew(env, b || {}));
      if (url.pathname === "/account/redeem" && req.method === "POST")
        return j(await acctRedeem(env, b || {}));
      if (url.pathname === "/account/rotate" && req.method === "POST")
        return j(await acctRotate(env, req, b || {}));
      return new Response("nope", { status:404, headers:cors });
    }

    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{4,40})$/);
    if (m){
      if (req.headers.get("Upgrade") !== "websocket")
        return new Response("expected a websocket", { status:426, headers:cors });
      /* A WebSocket handshake cannot carry an Authorization header, so the
         token rides in the query string. It is verified HERE and the URL is
         rewritten before the room ever sees it: the room is only reachable
         through this worker, so a uid it receives is one we vouched for. A
         uid the client simply asserted is dropped on the floor. */
      const tok = url.searchParams.get("tok") || "";
      const t = await authRead(env, tok);
      let uid = "";
      if (t){
        const g = await (await ledger(env).fetch(
          new Request("https://l/acct/gen?uid=" + encodeURIComponent(t.uid)))).json();
        if (g.ok && g.gen === t.gen) uid = t.uid;
      }
      url.searchParams.delete("tok");
      url.searchParams.set("uid", uid);
      const fwd = new Request(url.toString(), req);
      const id = env.ROOM.idFromName(m[1]);
      return env.ROOM.get(id).fetch(fwd);
    }

    return new Response("stations signalling relay", { status:404, headers:cors });
  }
};

/* Credentials are short-lived by design, so they cannot be pasted into
   index.html — minting them is the one thing that genuinely needs a
   server side. Without the secrets set this degrades to public STUN,
   which connects most calls but not the ones behind symmetric NAT. */
async function iceServers(env){
  if (!ID(env,"TURN_KEY_ID") || !ID(env,"TURN_KEY_API_TOKEN")) return { iceServers: PUBLIC_STUN };
  try{
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${ID(env,"TURN_KEY_ID")}/credentials/generate-ice-servers`,
      { method:"POST",
        headers:{ "Authorization":`Bearer ${ID(env,"TURN_KEY_API_TOKEN")}`, "Content-Type":"application/json" },
        body: JSON.stringify({ ttl: 7200 }) }        // two hours covers any session
    );
    if (!r.ok) return { iceServers: PUBLIC_STUN };
    const j = await r.json();
    return Array.isArray(j.iceServers) && j.iceServers.length
      ? { iceServers: j.iceServers }
      : { iceServers: PUBLIC_STUN };
  }catch(e){
    return { iceServers: PUBLIC_STUN };
  }
}

/* =========================================================
   One Durable Object per room code.
   ========================================================= */
export class Room extends DurableObject {

  async fetch(req){
    const live = this.ctx.getWebSockets();
    if (live.length >= MAX_PEERS)
      return new Response("room is full", { status:409 });

    const q   = new URL(req.url).searchParams;
    const did = (q.get("did") || "").slice(0, 64);
    /* Set by the worker from a verified token, or empty. Never trusted
       from the client — see the /room route. */
    const uid = (q.get("uid") || "").slice(0, 64);
    const whoQ = "did=" + encodeURIComponent(did) + "&uid=" + encodeURIComponent(uid);
    const first = live.length === 0;

    /* The host is the one who needs standing. Whoever they invite gets in
       free — a subscription nobody can share is a subscription nobody can
       recommend, and the invited friend is exactly who you want to reach. */
    if (first){
      const v = await this.env.LEDGER.get(this.env.LEDGER.idFromName("v1"))
        .fetch(new Request("https://l/check?" + whoQ));
      const j = await v.json();
      if (!j.allowed){
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();
        server.send(JSON.stringify({ t:"blocked", used:j.used, limit:j.limit }));
        server.close(1008, "trial spent");
        return new Response(null, { status:101, webSocket: client });
      }
      await this.ctx.storage.deleteAll();     // a fresh room, whatever was here before
      await this.ctx.storage.put("host", did);
      await this.ctx.storage.put("hostUid", uid);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    /* Hibernation, not ws.accept(): the room spends almost all of its
       life waiting for the second person to open the link, and a
       hibernated socket is not billed for that wait. */
    this.ctx.acceptWebSocket(server);

    server.serializeAttachment({ host: first });

    /* A session is spent when someone actually turns up, not when an
       invite is made. Otherwise a link nobody opens costs a workout. */
    if (!first){
      const host = await this.ctx.storage.get("host");
      const hostUid = (await this.ctx.storage.get("hostUid")) || "";
      /* Spent against the host's account when they have one, so a free
         session cannot be had twice by signing in on a second phone. */
      if (host) this.env.LEDGER.get(this.env.LEDGER.idFromName("v1"))
        .fetch(new Request("https://l/spend?did=" + encodeURIComponent(host) +
                           "&uid=" + encodeURIComponent(hostUid)))
        .catch(() => {});
    }

    /* The host arrives, posts an offer, and closes their laptop. Whoever
       opens the link minutes later still needs that offer, so it is held
       here rather than requiring both people to be present at once. */
    if (!first){
      const kept = await this.ctx.storage.get("offer");
      if (kept) try{ server.send(kept); }catch(e){}
    } else {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    }

    try{ server.send(JSON.stringify({ t:"joined", host:first, peers: live.length + 1 })); }catch(e){}
    if (!first) for (const p of live) try{ p.send(JSON.stringify({ t:"peer" })); }catch(e){}

    return new Response(null, { status:101, webSocket: client });
  }

  async webSocketMessage(ws, msg){
    if (typeof msg !== "string" || msg.length > MAX_MSG) return;

    /* Only the offer is ever held; answers and ICE candidates are
       worthless a second later and are relayed, never stored. */
    let t = "";
    try{ t = (JSON.parse(msg) || {}).t || ""; }catch(e){ return; }
    if (t === "offer") await this.ctx.storage.put("offer", msg);
    if (t === "bye")   await this.ctx.storage.deleteAll();

    for (const p of this.ctx.getWebSockets())
      if (p !== ws) try{ p.send(msg); }catch(e){}
  }

  async webSocketClose(ws, code, reason){
    for (const p of this.ctx.getWebSockets())
      if (p !== ws) try{ p.send(JSON.stringify({ t:"gone" })); }catch(e){}
    try{ ws.close(code === 1006 ? 1000 : code, reason); }catch(e){}
  }

  async webSocketError(ws){
    try{ ws.close(1011, "error"); }catch(e){}
  }

  /* Nobody ever joined, or nobody cleaned up. Either way the offer in
     here is long stale. */
  async alarm(){
    await this.ctx.storage.deleteAll();
    for (const p of this.ctx.getWebSockets()) try{ p.close(1000, "expired"); }catch(e){}
  }
}


/* =========================================================
   The ledger — free sessions, and the people who asked for more.
   =========================================================
   One instance, keyed "v1". At this scale a single Durable Object is
   the whole database, and using one means there is no dashboard
   resource to create by hand: the class ships in wrangler.toml and
   appears on the next push.

   `did` is a random id the browser keeps in localStorage. It is a weak
   identity and known to be one — clearing site data buys another three
   sessions. That is a deliberate phase-one trade: the point right now
   is to find out whether anyone reaches the wall at all, and a login
   asked for before that question is answered is a login asked too
   early. The magic-link account replaces it before money changes hands.
   ========================================================= */
export class Ledger extends DurableObject {

  constructor(state, env){
    super(state, env);
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS trials(
      did TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS subs(
      did TEXT PRIMARY KEY, email TEXT, customer TEXT, sub TEXT,
      status TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS interest(
      email TEXT PRIMARY KEY, did TEXT, at INTEGER NOT NULL, used INTEGER)`);
    /* An account is a uid, a generation, and a code hash. email is null
       until a magic link is used — the column exists now so that landing
       does not need a migration on a live table. */
    this.sql.exec(`CREATE TABLE IF NOT EXISTS accts(
      uid TEXT PRIMARY KEY, code TEXT, email TEXT, gsub TEXT,
      gen INTEGER NOT NULL DEFAULT 1,
      created INTEGER NOT NULL, seen INTEGER NOT NULL)`);
    try{ this.sql.exec(`ALTER TABLE accts ADD COLUMN gsub TEXT`); }catch(e){}
    this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS accts_code ON accts(code)`);
    /* Google's sub, not the email address: Google is explicit that sub is
       unique and never reused, and that an address can change hands. */
    this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS accts_gsub ON accts(gsub)`);
    /* One address, one account — so signing in by link reaches the same
       account Google made, rather than a second one beside it. SQLite
       lets a unique index hold many NULLs, which is what accounts with
       no address yet have. */
    this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS accts_email ON accts(email)`);
    /* Sign-in links, burned on use. Rows are swept when they expire. */
    this.sql.exec(`CREATE TABLE IF NOT EXISTS once(n TEXT PRIMARY KEY, until INTEGER NOT NULL)`);
    /* Rate limiting, one row per attempt, counted over the last hour. */
    this.sql.exec(`CREATE TABLE IF NOT EXISTS hits(k TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS hits_k ON hits(k, at)`);
    /* trials and subs were keyed by device before accounts existed. The
       column is added rather than the tables rebuilt, and every existing
       row keeps working with a null uid until a device claims it. */
    for (const t of ["trials", "subs"]){
      try{ this.sql.exec(`ALTER TABLE ${t} ADD COLUMN uid TEXT`); }catch(e){}
      try{ this.sql.exec(`CREATE INDEX IF NOT EXISTS ${t}_uid ON ${t}(uid)`); }catch(e){}
    }
    /* This table is already live with the original four columns, and SQLite
       has no ADD COLUMN IF NOT EXISTS. Adding each one and ignoring the
       failure is the ordinary way to migrate a table you cannot drop. */
    for (const col of ["name TEXT", "phone TEXT", "sms INTEGER", "ip TEXT"]){
      try{ this.sql.exec(`ALTER TABLE interest ADD COLUMN ${col}`); }catch(e){}
    }
  }

  /* An account first, the bare device second. Both, because a device
     that has not been claimed yet still has to work. */
  subbed(uid, did){
    if (uid){
      const r = [...this.sql.exec(
        "SELECT 1 AS x FROM subs WHERE uid = ? AND status = 'active' LIMIT 1", uid)];
      if (r.length) return true;
    }
    if (!did) return false;
    const r = [...this.sql.exec("SELECT status FROM subs WHERE did = ?", did)];
    return !!r.length && r[0].status === "active";
  }

  /* The highest count across the account's devices, not the sum and not
     this device's. Signing in on a new phone must not hand out three more
     free calls, and it must not retroactively spend calls either. */
  row(uid, did){
    if (uid){
      const r = [...this.sql.exec(
        "SELECT COALESCE(MAX(used), 0) AS u FROM trials WHERE uid = ?", uid)];
      const byAcct = r.length ? r[0].u : 0;
      const mine = did ? this.rowDid(did) : 0;
      return Math.max(byAcct, mine);
    }
    return did ? this.rowDid(did) : 0;
  }
  rowDid(did){
    const r = [...this.sql.exec("SELECT used FROM trials WHERE did = ?", did)];
    return r.length ? r[0].used : 0;
  }

  /* Everything this device has done becomes the account's. Called once,
     when an account is made or a code is redeemed on a new device. */
  claim(uid, did){
    if (!uid || !did) return;
    this.sql.exec("UPDATE trials SET uid = ? WHERE did = ?", uid, did);
    this.sql.exec("UPDATE subs   SET uid = ? WHERE did = ?", uid, did);
  }

  async fetch(req){
    const url = new URL(req.url);
    const did = (url.searchParams.get("did") || "").slice(0, 64);
    const uid = (url.searchParams.get("uid") || "").slice(0, 64);
    const now = Date.now();
    const json = (o, status) => new Response(JSON.stringify(o),
      { status: status || 200, headers:{ "Content-Type":"application/json" }});

    switch (url.pathname){

      /* Read-only. Used to show "2 of 3 left" before anyone commits. */
      case "/state": {
        const used = this.row(uid, did);
        const sub = this.subbed(uid, did);
        let email = "";
        if (uid){
          const r = [...this.sql.exec("SELECT email FROM accts WHERE uid = ?", uid)];
          if (r.length) email = r[0].email || "";
        }
        return json({ used, limit:FREE_CALLS, email,
                      remaining: sub ? 9999 : Math.max(0, FREE_CALLS - used),
                      subscribed: sub });
      }

      /* Asked before a room opens. A missing did is treated as spent —
         a client that will not identify itself does not get free calls. */
      case "/check": {
        if (!did && !uid) return json({ allowed:false, used:FREE_CALLS, limit:FREE_CALLS });
        if (this.subbed(uid, did)) return json({ allowed:true, subscribed:true, used:0, limit:FREE_CALLS });
        const used = this.row(uid, did);
        return json({ allowed: used < FREE_CALLS, used, limit:FREE_CALLS });
      }

      /* Fire-and-forget from the Room when a second person turns up. */
      case "/spend": {
        if (!did) return json({ ok:false });
        this.sql.exec(
          `INSERT INTO trials(did, used, first_seen, last_seen, uid) VALUES(?, 1, ?, ?, ?)
           ON CONFLICT(did) DO UPDATE SET used = used + 1, last_seen = excluded.last_seen,
             uid = COALESCE(excluded.uid, trials.uid)`,
          did, now, now, uid || null);
        return json({ ok:true, used: this.row(uid, did) });
      }

      case "/sub": {
        let b = {}; try{ b = await req.json(); }catch(e){}
        if (!b.did) return json({ ok:false });
        this.sql.exec(
          `INSERT INTO subs(did, email, customer, sub, status, at, uid) VALUES(?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(did) DO UPDATE SET email=excluded.email, customer=excluded.customer,
             sub=excluded.sub, status=excluded.status, at=excluded.at,
             uid = COALESCE(excluded.uid, subs.uid)`,
          String(b.did).slice(0,64), String(b.email||"").slice(0,254),
          String(b.customer||"").slice(0,64), String(b.sub||"").slice(0,64),
          String(b.status||"active").slice(0,24), now, String(b.uid||"").slice(0,64) || null);
        return json({ ok:true });
      }

      /* Cancellations arrive keyed by Stripe's ids, not by device. */
      case "/unsub": {
        let b = {}; try{ b = await req.json(); }catch(e){}
        if (b.sub)      this.sql.exec("UPDATE subs SET status='ended', at=? WHERE sub = ?", now, String(b.sub));
        if (b.customer) this.sql.exec("UPDATE subs SET status='ended', at=? WHERE customer = ?", now, String(b.customer));
        return json({ ok:true });
      }

      /* ---- accounts ---- */

      case "/acct/gen": {
        if (!uid) return json({ ok:false });
        const r = [...this.sql.exec("SELECT gen FROM accts WHERE uid = ?", uid)];
        if (!r.length) return json({ ok:false });
        this.sql.exec("UPDATE accts SET seen = ? WHERE uid = ?", now, uid);
        return json({ ok:true, gen: r[0].gen });
      }

      case "/acct/new": {
        let b = {}; try{ b = await req.json(); }catch(e){}
        if (!b.uid || !b.hash) return json({ ok:false });
        try{
          this.sql.exec(
            `INSERT INTO accts(uid, code, gen, created, seen) VALUES(?, ?, 1, ?, ?)`,
            String(b.uid), String(b.hash), now, now);
        }catch(e){
          /* The unique index on the hash is the guard. Two codes colliding
             is a sixty-bit coincidence; a caller retrying is not. */
          return json({ ok:false, error:"could not create that account" });
        }
        this.claim(String(b.uid), String(b.did || ""));
        return json({ ok:true });
      }

      case "/acct/redeem": {
        let b = {}; try{ b = await req.json(); }catch(e){}
        const r = [...this.sql.exec("SELECT uid, gen FROM accts WHERE code = ?", String(b.hash || ""))];
        if (!r.length) return json({ ok:false });
        const who = r[0].uid;
        /* The new device joins the account. It does not bring its own
           trial history with it — see claim(). */
        this.claim(who, String(b.did || ""));
        this.sql.exec("UPDATE accts SET seen = ? WHERE uid = ?", now, who);
        return json({ ok:true, uid: who, gen: r[0].gen,
                      subscribed: this.subbed(who, String(b.did || "")) });
      }

      /* Find, attach, or create — in that order, and the order is the
         whole of the policy:

           1. This Google identity already has an account → sign in to it.
              Their Google account is the more durable thing; a recovery
              code they made earlier does not outrank it.
           2. They are signed in already → attach Google to that account,
              so the code path and the Google path converge instead of
              leaving somebody with two accounts and one subscription.
           3. Neither → a new account, with the device's history claimed. */
      case "/acct/google": {
        let b = {}; try{ b = await req.json(); }catch(e){}
        const gsub = String(b.gsub || ""), email = String(b.email || "");
        const dev  = String(b.did || "");
        if (!gsub) return json({ ok:false });

        const found = [...this.sql.exec("SELECT uid, gen FROM accts WHERE gsub = ?", gsub)];
        if (found.length){
          const who = found[0].uid;
          if (email) this.sql.exec("UPDATE accts SET email = ? WHERE uid = ?", email, who);
          this.sql.exec("UPDATE accts SET seen = ? WHERE uid = ?", now, who);
          this.claim(who, dev);
          return json({ ok:true, uid: who, gen: found[0].gen });
        }

        const mine = String(b.uid || "");
        if (mine){
          const has = [...this.sql.exec("SELECT gen FROM accts WHERE uid = ?", mine)];
          if (has.length){
            try{
              this.sql.exec("UPDATE accts SET gsub = ?, email = COALESCE(NULLIF(?, ''), email), seen = ? WHERE uid = ?",
                gsub, email, now, mine);
            }catch(e){ return json({ ok:false }); }
            this.claim(mine, dev);
            return json({ ok:true, uid: mine, gen: has[0].gen });
          }
        }

        const uid = "g" + gsub.slice(-18);
        try{
          this.sql.exec(
            `INSERT INTO accts(uid, gsub, email, gen, created, seen) VALUES(?, ?, ?, 1, ?, ?)`,
            uid, gsub, email || null, now, now);
        }catch(e){ return json({ ok:false }); }
        this.claim(uid, dev);
        return json({ ok:true, uid, gen: 1 });
      }

      /* A nonce may be claimed exactly once. The insert is the claim —
         the primary key does the work, so there is no read-then-write
         for two simultaneous clicks to race through. */
      case "/acct/once": {
        let b = {}; try{ b = await req.json(); }catch(e){}
        const n = String(b.n || "");
        if (!n) return json({ ok:false });
        this.sql.exec("DELETE FROM once WHERE until < ?", now);
        try{
          this.sql.exec("INSERT INTO once(n, until) VALUES(?, ?)",
            n, now + Number(b.ttl || 900000));
        }catch(e){ return json({ ok:false }); }
        return json({ ok:true });
      }

      /* Requests in the last hour, for every key at once. Any key over
         the limit refuses the lot — an address and an IP are two ways of
         being the same person trying too often. */
      case "/rate": {
        let b = {}; try{ b = await req.json(); }catch(e){}
        const keys = (b.keys || []).filter(Boolean).map(String);
        const max = Number(b.max || 5), since = now - 3600000;
        this.sql.exec("DELETE FROM hits WHERE at < ?", since);
        for (const k of keys){
          const r = [...this.sql.exec("SELECT COUNT(*) AS n FROM hits WHERE k = ? AND at >= ?", k, since)];
          if (r.length && r[0].n >= max) return json({ ok:false });
        }
        for (const k of keys) this.sql.exec("INSERT INTO hits(k, at) VALUES(?, ?)", k, now);
        return json({ ok:true });
      }

      /* Find by address, or make one. This is where a link and a Google
         sign-in for the same address converge on one account. */
      case "/acct/byemail": {
        let b = {}; try{ b = await req.json(); }catch(e){}
        const email = String(b.email || "").trim().toLowerCase();
        const dev = String(b.did || "");
        if (!email) return json({ ok:false });
        const r = [...this.sql.exec("SELECT uid, gen FROM accts WHERE email = ?", email)];
        if (r.length){
          this.sql.exec("UPDATE accts SET seen = ? WHERE uid = ?", now, r[0].uid);
          this.claim(r[0].uid, dev);
          return json({ ok:true, uid: r[0].uid, gen: r[0].gen });
        }
        const uid = "m" + [...crypto.getRandomValues(new Uint8Array(12))]
          .map(x => x.toString(16).padStart(2,"0")).join("");
        try{
          this.sql.exec(
            `INSERT INTO accts(uid, email, gen, created, seen) VALUES(?, ?, 1, ?, ?)`,
            uid, email, now, now);
        }catch(e){ return json({ ok:false }); }
        this.claim(uid, dev);
        return json({ ok:true, uid, gen: 1 });
      }

      case "/acct/rotate": {
        let b = {}; try{ b = await req.json(); }catch(e){}
        if (!b.uid || !b.hash) return json({ ok:false });
        const r = [...this.sql.exec("SELECT gen FROM accts WHERE uid = ?", String(b.uid))];
        if (!r.length) return json({ ok:false });
        const gen = r[0].gen + 1;
        try{
          this.sql.exec("UPDATE accts SET code = ?, gen = ?, seen = ? WHERE uid = ?",
            String(b.hash), gen, now, String(b.uid));
        }catch(e){ return json({ ok:false }); }
        return json({ ok:true, gen });
      }

      case "/interest": {
        let b = {};
        try{ b = await req.json(); }catch(e){}
        const email = String(b.email || "").trim().slice(0, 254);
        /* Deliberately loose. Bouncing a real address because it has a
           plus in it is worse than storing one typo. */
        if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email))
          return json({ ok:false, error:"that does not look like an email" }, 400);
        const who   = String(b.did || "").slice(0, 64);
        const name  = String(b.name || "").trim().slice(0, 80);
        /* Kept as typed. Reformatting someone's number is how you turn a
           reachable contact into an unreachable one. */
        const phone = String(b.phone || "").trim().slice(0, 32);
        /* Consent is only true if they actually ticked it AND gave a number.
           A tick with no number is not consent to anything. */
        const sms   = (b.sms === true && phone) ? 1 : 0;
        const ip    = String(b.ip || "").slice(0, 64);
        this.sql.exec(
          `INSERT INTO interest(email, did, at, used, name, phone, sms, ip)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET at = excluded.at, did = excluded.did,
             name = COALESCE(NULLIF(excluded.name,''), interest.name),
             phone = COALESCE(NULLIF(excluded.phone,''), interest.phone),
             sms = MAX(excluded.sms, COALESCE(interest.sms,0)),
             ip = excluded.ip`,
          email, who, now, who ? this.row(who) : 0, name, phone, sms, ip);
        return json({ ok:true });
      }

      /* Everything the dashboard shows, in one read. */
      case "/dump": {
        const interest = [...this.sql.exec(
          "SELECT email, name, phone, sms, at, used FROM interest ORDER BY at DESC")];
        const t = [...this.sql.exec("SELECT COUNT(*) AS n, COALESCE(SUM(used),0) AS s FROM trials")][0] || {};
        const spent = [...this.sql.exec("SELECT COUNT(*) AS n FROM trials WHERE used >= ?", FREE_CALLS)][0] || {};
        const subs = [...this.sql.exec("SELECT COUNT(*) AS n FROM subs WHERE status='active'")][0] || {};
        const accts = [...this.sql.exec("SELECT COUNT(*) AS n FROM accts")][0] || {};
        return json({ interest, devices: t.n || 0, sessions: t.s || 0, spent: spent.n || 0,
                      subscribers: subs.n || 0, accounts: accts.n || 0 });
      }

      case "/export": {
        const rows = [...this.sql.exec(
          "SELECT email, name, phone, sms, ip, at, used FROM interest ORDER BY at DESC")];
        /* Column names chosen to drop straight into a CRM import. */
        const q = v => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
        const csv = ["email,first_name,phone,sms_consent,consent_at_utc,consent_ip,signed_up_utc,sessions_used"]
          .concat(rows.map(r => [r.email, r.name, r.phone, r.sms ? "yes" : "no",
                                 r.sms ? new Date(r.at).toISOString() : "",
                                 r.sms ? (r.ip || "") : "",
                                 new Date(r.at).toISOString(), r.used].map(q).join(",")))
          .join("\n");
        return new Response(csv + "\n", { headers:{ "Content-Type":"text/csv" }});
      }
    }
    return new Response("no", { status:404 });
  }
}


/* =========================================================
   The coach's script, written fresh for one session
   =========================================================
   The whole workout is known before it starts — every exercise, in
   order, with its duration. So this is ONE call that writes the
   entire script, not one call per interval. The client fires it as
   the warm-up begins and has minutes to work with, which is why
   nobody ever waits on a model mid-burpee.

   Runs on Workers AI, so there is no third-party key anywhere and no
   account beyond the one already hosting this.

   Every failure path returns ok:false and the app falls back to its
   written-in pool. A coach that goes silent because a model was busy
   would be worse than one that repeats itself.
   ========================================================= */

const MODEL = "@cf/meta/llama-3.2-3b-instruct";

/* Things a coach must never say, whatever the model decides. Pain is
   information, and an app that tells someone to ignore it is an app
   that hurts someone. A backstop, not the only guard — the prompt
   says it too. */
const FORBIDDEN = [
  /push through the pain/i, /ignore the pain/i, /pain is weakness/i,
  /no pain,? no gain/i, /work through the injury/i,
  /you can'?t stop now/i, /skip (the )?(warm|cool)/i
];

const VOICES = {
  coach: "A plain-spoken strength coach. Direct, technical, unsentimental. Cues body position and breathing. Never gushes.",
  sarge: "A drill instructor. Clipped, loud, unsympathetic, faintly funny in its severity. Short sentences. Never comforting.",
  quiet: "A calm, low-voiced coach who never raises their voice. Breath-led, unhurried, kind without being soft.",
  feral: "An unhinged, very funny coach. Absurd, hyperbolic, relentless, deadpan. Mocks the person's excuses, their negotiating with themselves, and the situation — NEVER their body, weight or appearance. No profanity."
};

function clean(line){
  let t = String(line || "").replace(/\s+/g, " ").trim();
  t = t.replace(/^["\u2018\u2019'\-\u2013\u2014\s]+|["\u2018\u2019'\s]+$/g, "");
  if (t.length > 90 || t.length < 4) return null;
  if (FORBIDDEN.some(re => re.test(t))) return null;
  return t;
}

async function coachScript(env, body){
  const persona = VOICES[body.persona] ? body.persona : "coach";
  const stations = Array.isArray(body.stations) ? body.stations.slice(0, 24).map(String) : [];
  if (!stations.length) return { ok:false, error:"no stations" };

  const facts = [];
  if (body.sessions > 0) facts.push("they have logged " + body.sessions + " sessions");
  if (body.streak   > 1) facts.push("they are on a " + body.streak + " day streak");
  if (body.thisWeek > 1) facts.push("this is session " + body.thisWeek + " this week");
  if (body.lastRpe === 0) facts.push("they said the last session was too easy");
  if (body.lastRpe === 2) facts.push("they said the last session was too much");
  if (body.minutes)      facts.push("the session is " + body.minutes + " minutes long");

  const prompt = [
    "You are writing the spoken lines for a workout app's coach. Return JSON only.",
    "",
    "VOICE: " + VOICES[persona],
    "",
    "THE SESSION: " + stations.length + " stations, in this order: " + stations.join(", ") + ".",
    facts.length ? "ABOUT THIS PERSON: " + facts.join("; ") + "." : "",
    "",
    'Write JSON with exactly these keys:',
    '{"start":"...","work":["one line per station, same order, each naming that exercise"],' +
    '"mid":["6 short mid-effort lines"],"rest":["4 lines for the rest period"],"half":"...","end":"..."}',
    "",
    "RULES",
    "- Every line is spoken aloud mid-workout. Under 90 characters. No emoji, no markdown, no stage directions.",
    "- The work array must have exactly " + stations.length + " entries and each must name its exercise.",
    "- Cue position, breathing, tempo or effort. Be specific to the movement where you can.",
    "- Never tell anyone to push through pain, ignore pain, or skip a warm-up or cool-down.",
    "- No medical claims. No calorie or fat-loss claims. No hype about transformation.",
    "- Do not repeat the same sentence twice.",
    "- JSON only. No prose before or after."
  ].join("\n");

  let raw;
  try{
    const r = await env.AI.run(MODEL, {
      messages: [{ role:"user", content: prompt }],
      max_tokens: 1400, temperature: 0.9
    });
    raw = (r && (r.response || r.result)) || "";
  }catch(e){ return { ok:false, error:"model unavailable" }; }

  /* Models put JSON inside prose more often than anyone admits. */
  let parsed = null;
  const m2 = String(raw).match(/\{[\s\S]*\}/);
  if (m2) { try{ parsed = JSON.parse(m2[0]); }catch(e){} }
  if (!parsed) return { ok:false, error:"unparseable" };

  const arr = (v, n) => {
    const out = (Array.isArray(v) ? v : []).map(clean).filter(Boolean);
    return (n && out.length !== n) ? null : (out.length ? out : null);
  };
  const one = v => clean(Array.isArray(v) ? v[0] : v);

  const lines = {
    start: one(parsed.start), work: arr(parsed.work, stations.length),
    mid: arr(parsed.mid), rest: arr(parsed.rest),
    half: one(parsed.half), end: one(parsed.end)
  };

  /* Partial is fine — whatever survives is used and the rest falls back
     to the written pool. Half a fresh script still beats none. */
  const kept = Object.keys(lines).filter(k => lines[k]);
  if (!kept.length) return { ok:false, error:"nothing usable" };
  return { ok:true, persona, lines, kept };
}


/* =========================================================
   Telling Andre somebody signed up
   =========================================================
   Cloudflare's own email sending needs the paid Workers plan, so this
   uses Resend, which has a free tier. Both secrets are optional: with
   them set you get an email per signup, without them nothing happens
   and the signup still works. Same rule as everywhere else here —
   a missing key costs a nicety, never the feature.

   Set RESEND_API_KEY and ADMIN_EMAIL to turn it on.
   ========================================================= */
/* One place that talks to the mail provider, so swapping it later is one
   function and not a search. */
async function sendMail(env, to, subject, text){
  if (!ID(env,"RESEND_API_KEY")) return false;
  try{
    const r = await fetch("https://api.resend.com/emails", {
      method:"POST",
      headers:{ "Authorization":"Bearer " + ID(env,"RESEND_API_KEY"), "Content-Type":"application/json" },
      body: JSON.stringify({
        from: E(env,"NOTIFY_FROM") || "STATIONS <onboarding@resend.dev>",
        to: [to], subject, text })
    });
    return r.ok;
  }catch(e){ return false; }
}

async function notify(env, body){
  if (!ID(env,"RESEND_API_KEY") || !E(env,"ADMIN_EMAIL")) return;
  const who = String((body && body.email) || "").slice(0, 254);
  if (!who) return;
  await sendMail(env, E(env,"ADMIN_EMAIL"), "Someone hit the wall: " + who,
    who + " used up their three free sessions and asked to be told when "
        + "Train together opens.\n\nThe whole list: "
        + "https://stations-signal.andre-rafizadeh.workers.dev/admin?key=YOUR_ADMIN_KEY\n");
}

/* A page rather than a CSV, because the question this answers — has
   anyone signed up — gets asked from a phone, in a queue, one-handed. */
function adminPage(d, key){
  const esc = t => String(t).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
  const rows = (d.interest || []).map(r =>
    `<tr><td>${esc(r.email)}${r.name ? `<i>${esc(r.name)}</i>` : ""}</td>` +
    `<td>${r.phone ? esc(r.phone) + (r.sms ? ` <b title="consented to texts">SMS</b>` : ` <s title="no consent to text">no texts</s>`) : "—"}</td>` +
    `<td>${new Date(r.at).toISOString().slice(0,16).replace("T"," ")}</td></tr>`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>STATIONS — the list</title>
<style>
:root{--bg:#000;--line:#26262b;--txt:#fff;--dim:#9b9ba4;--dim2:#66666e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);
 font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;padding:24px 18px 60px}
.w{max-width:640px;margin:0 auto}
h1{font-size:12px;letter-spacing:3px;text-transform:uppercase;color:var(--dim2);font-weight:800;margin:0 0 18px}
.n{font-family:ui-monospace,Menlo,monospace;font-size:clamp(56px,16vw,88px);font-weight:800;
 letter-spacing:-3px;line-height:1;font-variant-numeric:tabular-nums}
.sub{color:var(--dim);margin:6px 0 26px}
.stats{display:flex;gap:26px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:16px 0;margin-bottom:22px}
.stat .k{font-size:10.5px;letter-spacing:1.8px;text-transform:uppercase;color:var(--dim2);font-weight:800}
.stat .v{font-family:ui-monospace,Menlo,monospace;font-size:22px;font-weight:800}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:10.5px;letter-spacing:1.6px;text-transform:uppercase;color:var(--dim2);
 padding:0 0 8px;font-weight:800}
td{padding:11px 0;border-top:1px solid var(--line);color:var(--dim);vertical-align:top}
td:first-child{color:var(--txt);word-break:break-all}
td:last-child,th:last-child{text-align:right}
td i{display:block;font-style:normal;color:var(--dim2);font-size:12.5px}
td b{font-size:9.5px;letter-spacing:1px;background:#fff;color:#000;padding:1px 5px;border-radius:3px;vertical-align:middle}
td s{font-size:11px;color:var(--dim2);text-decoration:none}
a{color:var(--dim2)}
.empty{border:1px dashed var(--line);border-radius:14px;padding:26px;text-align:center;color:var(--dim2)}
</style></head><body><div class="w">
<h1>Train together — the waiting list</h1>
<div class="n">${(d.interest || []).length}</div>
<p class="sub">${(d.interest||[]).length === 1 ? "person has" : "people have"} asked to be told when it opens.</p>
<div class="stats">
  <div class="stat"><div class="k">Devices seen</div><div class="v">${d.devices || 0}</div></div>
  <div class="stat"><div class="k">Sessions used</div><div class="v">${d.sessions || 0}</div></div>
  <div class="stat"><div class="k">Hit the wall</div><div class="v">${d.spent || 0}</div></div>
  <div class="stat"><div class="k">Subscribers</div><div class="v">${d.subscribers || 0}</div></div>
  <div class="stat"><div class="k">Accounts</div><div class="v">${d.accounts || 0}</div></div>
</div>
${rows ? `<table><tr><th>Who</th><th>Phone</th><th>When (UTC)</th></tr>${rows}</table>`
       : `<div class="empty">Nobody yet. That is information too — it means either
          nobody is reaching the wall, or the wall is not persuading them.</div>`}
<p style="margin-top:30px"><a href="/interest/export?key=${encodeURIComponent(key)}">Download as CSV</a></p>
</div></body></html>`;
}


/* =========================================================
   Billing
   =========================================================
   Stripe holds the price, the customer and the subscription. This
   holds one fact: is this device entitled. Everything here is inert
   until STRIPE_SECRET_KEY and STRIPE_PRICE_ID are set, and the wall
   falls back to collecting an email exactly as it does now — so a
   half-finished setup can never take money or block a workout.

   The device id is what entitlement binds to, and it is weak: clearing
   site data loses the subscription. Stripe still has the customer and
   their email, so it is recoverable by hand, and the magic-link
   account replaces this properly. Nobody should be sold a year on this
   binding without that landing first.
   ========================================================= */

const STRIPE = "https://api.stripe.com/v1/";

/* =========================================================
   ACCOUNTS
   =========================================================
   Until now a subscription belonged to a string in localStorage. That
   is fine right up until someone clears their site data or buys a new
   phone, at which point they have paid for something they cannot reach
   and the only fix is an email to a human.

   An account is a uid, a generation number, and — for now — one
   recovery code. There is no password, because a password is a thing
   to store, to leak, and to reset, and none of that buys anything here.

   The code is the whole of it: sixty bits, shown once, kept only as a
   hash. Someone who steals the database gets hashes, and someone who
   steals a code gets a fitness app. That is the right amount of
   security for what is being protected.

   Sessions are a signed string rather than a table, so checking one is
   arithmetic and not a read. The generation number is the escape hatch:
   bump it and every token ever minted for that account stops verifying,
   which is what "I lost my phone" has to mean.

   Everything here is dead until AUTH_SECRET is set, exactly like the
   billing routes. An account layer with no secret would sign tokens
   anyone could forge, so it refuses to sign at all.
   ========================================================= */

const TOKEN_DAYS = 180;
/* No I/O/0/1/L/U. People read these off a screen and type them into a
   phone, and every confusable pair is a support email. */
const CODE_ALPHA = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LEN   = 12;

function authOn(env){ return !!ID(env,"AUTH_SECRET"); }

function b64url(bytes){
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function randomBytes(n){ return crypto.getRandomValues(new Uint8Array(n)); }

/* 128 bits. Not sequential, because a sequential id tells anyone who
   holds one roughly how many customers there are. */
function newUid(){ return b64url(randomBytes(16)); }

/* Rejection sampling, not modulo. A 30-letter alphabet does not divide
   256, so modulo would quietly make the first six letters likelier than
   the rest and cost real entropy for nothing. */
function newCode(){
  let out = "";
  while (out.length < CODE_LEN){
    for (const b of randomBytes(CODE_LEN * 2)){
      if (b >= 240) continue;                       // 240 = 30 * 8
      out += CODE_ALPHA[b % CODE_ALPHA.length];
      if (out.length === CODE_LEN) break;
    }
  }
  return out;
}

/* Grouped for reading and typing. The canonical form is the bare twelve
   characters — that is what gets hashed, so a code works whether it is
   typed with the dashes, without them, or pasted with a stray space. */
function prettyCode(c){ return c.match(/.{1,4}/g).join("-"); }
function tidyCode(raw){ return String(raw || "").toUpperCase().replace(/[\s\-._]+/g, ""); }
function validCode(c){
  return c.length === CODE_LEN && [...c].every(ch => CODE_ALPHA.includes(ch));
}

async function sha256hex(text){
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2,"0")).join("");
}

async function authMac(env, msg){
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(ID(env,"AUTH_SECRET")),
    { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg))));
}

function sameString(a, b){
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* v1.<uid>.<gen>.<expiry>.<signature> — flat, so parsing it cannot be
   the interesting part of an attack. */
async function authSign(env, uid, gen, ms){
  const exp = Date.now() + (ms || TOKEN_DAYS * 86400000);
  const body = "v1." + uid + "." + gen + "." + exp;
  return body + "." + await authMac(env, body);
}

/* Signature and expiry only. Whether that generation is still current is
   a question for the ledger, and the caller asks it when it matters. */
async function authRead(env, tok){
  if (!authOn(env) || !tok) return null;
  const p = String(tok).split(".");
  if (p.length !== 5 || p[0] !== "v1") return null;
  const body = p.slice(0, 4).join(".");
  if (!sameString(await authMac(env, body), p[4])) return null;
  const exp = Number(p[3]);
  if (!isFinite(exp) || exp < Date.now()) return null;
  return { uid: p[1], gen: Number(p[2]) };
}

/* The identity behind a request: the token when there is a good one,
   the device id otherwise. Every route that used to take a bare did
   goes through here, so an account and a lone browser are the same
   shape to everything downstream. */
async function whoIs(env, req, did){
  const h = req.headers.get("Authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  const t = await authRead(env, tok);
  if (!t) return { uid:"", did };
  const r = await ledger(env).fetch(new Request("https://l/acct/gen?uid=" + encodeURIComponent(t.uid)));
  const g = await r.json();
  /* A token from before a rotation is a token from a phone that was
     lost. It verifies, and it is still refused. */
  if (!g.ok || g.gen !== t.gen) return { uid:"", did };
  return { uid: t.uid, did };
}

async function acctNew(env, b){
  if (!authOn(env)) return { ok:false, error:"accounts are not set up yet" };
  const did  = String(b.did || "").slice(0, 64);
  if (!did) return { ok:false, error:"no device" };
  const uid  = newUid();
  const code = newCode();
  const r = await ledger(env).fetch(new Request("https://l/acct/new", { method:"POST",
    body: JSON.stringify({ uid, did, hash: await sha256hex(code) }) }));
  const out = await r.json();
  if (!out.ok) return out;
  /* Shown here and never again — the hash is all that is kept. */
  return { ok:true, uid, code: prettyCode(code), token: await authSign(env, uid, 1) };
}

async function acctRedeem(env, b){
  if (!authOn(env)) return { ok:false, error:"accounts are not set up yet" };
  const code = tidyCode(b.code);
  const did  = String(b.did || "").slice(0, 64);
  /* I, O, L, U, 0 and 1 are not in the alphabet, so a code containing
     one was misread rather than mistyped. Say so, because "that code did
     not work" sends someone hunting for the wrong problem. */
  if (!validCode(code))
    return { ok:false, error: code.length === CODE_LEN
      ? "check that code — it has a character these codes never use"
      : "a code is twelve characters, like ABCD-EFGH-JKMN" };
  const r = await ledger(env).fetch(new Request("https://l/acct/redeem", { method:"POST",
    body: JSON.stringify({ hash: await sha256hex(code), did }) }));
  const out = await r.json();
  /* Deliberately the same sentence for a wrong code and a code that
     never existed. */
  if (!out.ok) return { ok:false, error:"that code did not work" };
  return { ok:true, uid: out.uid, subscribed: !!out.subscribed,
           token: await authSign(env, out.uid, out.gen) };
}

async function acctRotate(env, req, b){
  const who = await whoIs(env, req, String(b.did || "").slice(0, 64));
  if (!who.uid) return { ok:false, error:"sign in first" };
  const code = newCode();
  const r = await ledger(env).fetch(new Request("https://l/acct/rotate", { method:"POST",
    body: JSON.stringify({ uid: who.uid, hash: await sha256hex(code) }) }));
  const out = await r.json();
  if (!out.ok) return out;
  /* The generation moved, so this request's own token is now stale too. */
  return { ok:true, code: prettyCode(code), token: await authSign(env, who.uid, out.gen) };
}

/* Two separate questions, and conflating them is a bug I shipped for
   ten minutes: whether accounts EXIST on this deployment, and whether
   THIS browser is signed in. A visitor who has never made one is not
   evidence that the feature is off. */
async function acctMe(env, req, did){
  const who = await whoIs(env, req, did);
  if (!who.uid) return { ok:true, available: authOn(env), google: googleOn(env),
                         mail: mailOn(env), signedIn:false };
  const r = await ledger(env).fetch(new Request("https://l/state?uid=" + encodeURIComponent(who.uid)));
  const st = await r.json();
  return { ok:true, available:true, google: googleOn(env), mail: mailOn(env),
           signedIn:true, uid: who.uid,
           email: st.email || "", subscribed: !!st.subscribed, remaining: st.remaining };
}

/* =========================================================
   SIGN IN WITH GOOGLE
   =========================================================
   A real account with no mail provider behind it. Google hands over a
   verified email address and a permanent user id, which is the whole of
   what an account needs, and it does it in one tap rather than in a
   message that has to survive a spam filter — which matters more than
   it sounds when you remember where someone is standing when they sign
   in to a workout app.

   The identity key is Google's `sub`, never the email address. Google
   is explicit that sub is unique and never reused, and that an email
   can change hands. Keying on email would mean an address changing
   owner changes who owns the subscription.

   The signature on the ID token is not checked here, and that is
   deliberate rather than lazy: the token is fetched over TLS straight
   from Google's token endpoint using the client secret, which is the
   one case Google documents as not needing it. The claims that carry
   the meaning — issuer, audience, expiry — are checked, because those
   are what a stolen-but-valid token from someone else's project would
   fail.
   ========================================================= */

const G_AUTH  = "https://accounts.google.com/o/oauth2/v2/auth";
const G_TOKEN = "https://oauth2.googleapis.com/token";

function googleOn(env){ return !!(ID(env,"GOOGLE_CLIENT_ID") && ID(env,"GOOGLE_CLIENT_SECRET") && authOn(env)); }

function b64urlStr(str){ return b64url(new TextEncoder().encode(str)); }
function unb64url(s){
  const pad = s.replace(/-/g,"+").replace(/_/g,"/");
  return atob(pad + "=".repeat((4 - pad.length % 4) % 4));
}

/* Where we are allowed to send someone afterwards. An unchecked return
   address is an open redirect, and an open redirect on the domain that
   also holds the session is how a token gets handed to a stranger. */
function safeBack(raw){
  try{
    const u = new URL(raw);
    const ok = ALLOWED.includes(u.origin) ||
               /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(u.origin);
    return ok ? u.origin + u.pathname : ALLOWED[0] + "/";
  }catch(e){ return ALLOWED[0] + "/"; }
}

async function stateSign(env, o){
  const body = b64urlStr(JSON.stringify(o));
  return body + "." + await authMac(env, body);
}
async function stateRead(env, raw){
  const p = String(raw || "").split(".");
  if (p.length !== 2) return null;
  if (!sameString(await authMac(env, p[0]), p[1])) return null;
  let o; try{ o = JSON.parse(unb64url(p[0])); }catch(e){ return null; }
  /* Ten minutes is longer than any real sign-in and short enough that a
     state parameter found in a log is useless. */
  if (!o || Math.abs(Date.now() - Number(o.t || 0)) > 600000) return null;
  return o;
}

async function googleStart(env, req, url){
  const back = safeBack(url.searchParams.get("back") || "");
  if (!googleOn(env)) return Response.redirect(back + "#in_err=" +
    encodeURIComponent("Google sign-in is not set up yet"), 302);
  const h = req.headers.get("Authorization") || "";
  const state = await stateSign(env, {
    did: (url.searchParams.get("did") || "").slice(0, 64),
    back, t: Date.now(),
    /* If they are already on an account, Google gets attached to it
       rather than starting a second one. */
    tok: h.startsWith("Bearer ") ? h.slice(7) : (url.searchParams.get("tok") || "")
  });
  const q = new URLSearchParams({
    client_id: ID(env,"GOOGLE_CLIENT_ID"),
    redirect_uri: url.origin + "/account/google/callback",
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account"
  });
  return Response.redirect(G_AUTH + "?" + q.toString(), 302);
}

async function googleCallback(env, url){
  const st = await stateRead(env, url.searchParams.get("state"));
  const back = st ? st.back : (ALLOWED[0] + "/");
  const bad = m => Response.redirect(back + "#in_err=" + encodeURIComponent(m), 302);
  if (!st) return bad("that sign-in link expired — try again");
  if (url.searchParams.get("error")) return bad("sign-in was cancelled");
  const code = url.searchParams.get("code");
  if (!code) return bad("Google did not send a code back");

  try{
    const r = await fetch(G_TOKEN, {
      method:"POST", headers:{ "Content-Type":"application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: ID(env,"GOOGLE_CLIENT_ID"), client_secret: ID(env,"GOOGLE_CLIENT_SECRET"),
        redirect_uri: url.origin + "/account/google/callback",
        grant_type: "authorization_code"
      })
    });
    const tk = await r.json();
    if (!tk.id_token) return bad("Google would not complete the sign-in");

    const claims = JSON.parse(unb64url(tk.id_token.split(".")[1] || ""));
    /* The three that matter. aud is the one that stops a valid token
       minted for somebody else's project being replayed at ours. */
    if (claims.aud !== ID(env,"GOOGLE_CLIENT_ID")) return bad("that sign-in was not for this app");
    if (!["https://accounts.google.com","accounts.google.com"].includes(claims.iss))
      return bad("that sign-in did not come from Google");
    if (!claims.exp || Number(claims.exp) * 1000 < Date.now()) return bad("that sign-in expired");
    if (!claims.sub) return bad("Google did not say who you are");
    /* An unverified address is not proof of anything, and it is the
       route by which someone claims an address that is not theirs. */
    if (claims.email && claims.email_verified === false)
      return bad("that Google account's email is not verified");

    /* Attach to the account they are already on, if any. */
    let uid = "";
    if (st.tok){
      const t = await authRead(env, st.tok);
      if (t){
        const g = await (await ledger(env).fetch(
          new Request("https://l/acct/gen?uid=" + encodeURIComponent(t.uid)))).json();
        if (g.ok && g.gen === t.gen) uid = t.uid;
      }
    }

    const out = await (await ledger(env).fetch(new Request("https://l/acct/google", {
      method:"POST", body: JSON.stringify({
        gsub: String(claims.sub), email: String(claims.email || "").slice(0,254),
        did: st.did || "", uid
      })}))).json();
    if (!out.ok) return bad("could not finish signing you in");
    return Response.redirect(back + "#in=" +
      encodeURIComponent(await authSign(env, out.uid, out.gen)), 302);
  }catch(e){ return bad("something went wrong signing you in"); }
}

/* =========================================================
   MAGIC LINK
   =========================================================
   The third door, and the only one that needs nothing from Google. You
   type an address, you get a link, you tap it, you are in.

   Two things it has to survive, and both are about the inbox rather
   than the cryptography:

   A link is single use. A signed token that keeps working for fifteen
   minutes is fifteen minutes in which anyone holding a forwarded email
   is you. The nonce is burned on first use.

   And corporate mail scanners click links before the human does —
   Outlook's Safe Links is the famous one. That burns a single-use token
   and the person is told their brand new link has already been used,
   which is maddening and looks like a bug. So a used nonce says exactly
   that, and offers another, instead of failing generically.

   NOTIFY_FROM must be an address on a domain verified with the mail
   provider. Sending from resend.dev works for the admin notification,
   because that only ever goes to one inbox that expects it. A sign-in
   link from a shared testing domain goes to spam, and a sign-in link in
   spam is a broken product.
   ========================================================= */

const LINK_MIN  = 15;        // a link is good for a quarter of an hour
const LINK_MAX  = 5;         // per address per hour, and per IP per hour

function mailOn(env){ return !!(ID(env,"RESEND_API_KEY") && E(env,"NOTIFY_FROM") && authOn(env)); }

/* Deliberately loose. Bouncing a real address because it has a plus in
   it is worse than accepting one typo. */
function okEmail(e){ return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e); }

async function linkStart(env, req, b){
  if (!mailOn(env)) return { ok:false, error:"email sign-in is not set up yet" };
  const email = String(b.email || "").trim().toLowerCase().slice(0, 254);
  if (!okEmail(email)) return { ok:false, error:"that does not look like an email" };
  const back = safeBack(b.back || "");
  const ip = req.headers.get("CF-Connecting-IP") || "";

  const gate = await (await ledger(env).fetch(new Request("https://l/rate", {
    method:"POST", body: JSON.stringify({ keys:["m:"+email, "i:"+ip], max: LINK_MAX })
  }))).json();
  if (!gate.ok) return { ok:false, error:"too many links requested — try again in an hour" };

  const nonce = b64url(randomBytes(16));
  const body  = "l1." + b64urlStr(JSON.stringify({
    e: email, b: back, n: nonce, x: Date.now() + LINK_MIN * 60000 }));
  const token = body + "." + await authMac(env, body);
  const url   = new URL(req.url).origin + "/account/link/finish?t=" + encodeURIComponent(token);

  const sent = await sendMail(env, email, "Your STATIONS sign-in link",
    "Tap this to sign in:\n\n" + url +
    "\n\nIt works once and expires in " + LINK_MIN + " minutes.\n\n" +
    "If you did not ask for this, nothing has happened and you can ignore it.\n");
  /* The same answer either way. Whether an address is deliverable is not
     something a stranger should be able to probe for. */
  if (!sent) return { ok:false, error:"could not send that just now — try again shortly" };
  return { ok:true };
}

async function linkFinish(env, url){
  const raw = url.searchParams.get("t") || "";
  const p = raw.split(".");
  const fail = (back, m) => Response.redirect(back + "#in_err=" + encodeURIComponent(m), 302);
  if (p.length !== 3 || p[0] !== "l1") return fail(ALLOWED[0] + "/", "that link is not valid");
  if (!sameString(await authMac(env, p[0] + "." + p[1]), p[2]))
    return fail(ALLOWED[0] + "/", "that link is not valid");

  let o; try{ o = JSON.parse(unb64url(p[1])); }catch(e){ return fail(ALLOWED[0] + "/", "that link is not valid"); }
  const back = safeBack(o.b || "");
  if (!o.x || Number(o.x) < Date.now())
    return fail(back, "that link expired — ask for another");

  /* Burned here, not at the end: if anything after this fails they must
     ask for a new link rather than get a token that still works. */
  const once = await (await ledger(env).fetch(new Request("https://l/acct/once", {
    method:"POST", body: JSON.stringify({ n: o.n, ttl: LINK_MIN * 60000 }) }))).json();
  if (!once.ok)
    return fail(back, "that link was already used — ask for another and it will work");

  const out = await (await ledger(env).fetch(new Request("https://l/acct/byemail", {
    method:"POST", body: JSON.stringify({ email: o.e, did: "" }) }))).json();
  if (!out.ok) return fail(back, "could not finish signing you in");
  return Response.redirect(back + "#in=" +
    encodeURIComponent(await authSign(env, out.uid, out.gen)), 302);
}

function stripeOn(env){ return !!(ID(env,"STRIPE_SECRET_KEY") && ID(env,"STRIPE_PRICE_ID")); }

async function stripeCall(env, path, form, method){
  const r = await fetch(STRIPE + path, {
    method: method || (form ? "POST" : "GET"),
    headers: {
      "Authorization": "Bearer " + ID(env,"STRIPE_SECRET_KEY"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: form ? new URLSearchParams(form).toString() : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || ("stripe " + r.status));
  return j;
}

/* The number on the wall comes from Stripe, so there is exactly one
   place a price lives and the app can never quote a stale one. */
async function stripePrice(env){
  if (!stripeOn(env)) return { ok:false, configured:false };
  try{
    const p = await stripeCall(env, "prices/" + encodeURIComponent(ID(env,"STRIPE_PRICE_ID")));
    const rec = p.recurring || {};
    const amount = (p.unit_amount == null) ? null : p.unit_amount / 100;
    return { ok:true, configured:true, amount, currency:(p.currency || "usd").toUpperCase(),
             interval: rec.interval || "month", intervalCount: rec.interval_count || 1,
             display: amount == null ? "" :
               formatMoney(amount, p.currency) + "/" + (rec.interval || "month") };
  }catch(e){ return { ok:false, configured:true, error:"price unavailable" }; }
}

function formatMoney(amount, currency){
  const sym = { usd:"$", gbp:"\u00a3", eur:"\u20ac", cad:"CA$", aud:"A$" }[String(currency||"usd").toLowerCase()];
  const n = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return sym ? sym + n : n + " " + String(currency).toUpperCase();
}

async function stripeCheckout(env, b, origin){
  if (!stripeOn(env)) return { ok:false, error:"billing is not set up yet" };
  const did = String(b.did || "").slice(0, 64);
  if (!did) return { ok:false, error:"no device" };
  const back = String(b.returnTo || "").slice(0, 200) || "https://stations.fit/";
  try{
    const form = {
      mode: "subscription",
      "line_items[0][price]": ID(env,"STRIPE_PRICE_ID"),
      "line_items[0][quantity]": "1",
      /* client_reference_id is what ties the payment back to the device
         without asking anyone to make an account first. */
      client_reference_id: did,
      success_url: back + "#paid={CHECKOUT_SESSION_ID}",
      cancel_url: back + "#paidcancel",
      allow_promotion_codes: "true"
    };
    if (b.email && /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(String(b.email))) form.customer_email = String(b.email);
    const s = await stripeCall(env, "checkout/sessions", form);
    return { ok:true, url: s.url };
  }catch(e){ return { ok:false, error: e.message || "could not start checkout" }; }
}

/* Called when they come back from Stripe. The session id in the URL is
   not proof of anything on its own — it is checked against Stripe
   before a single free session is granted. */
async function stripeActivate(env, b, req){
  if (!stripeOn(env)) return { ok:false, error:"billing is not set up yet" };
  const id  = String(b.session_id || "").slice(0, 200);
  const did = String(b.did || "").slice(0, 64);
  /* If they are already signed in, the subscription is the account's from
     the first second rather than the device's until they think to save it. */
  const who = req ? await whoIs(env, req, did) : { uid:"" };
  if (!id || !did) return { ok:false, error:"missing session" };
  try{
    const s = await stripeCall(env, "checkout/sessions/" + encodeURIComponent(id));
    const paid = s.payment_status === "paid" || s.status === "complete";
    if (!paid) return { ok:false, error:"that checkout is not complete" };
    /* The session says which device started it. Trusting the id alone
       would let anyone paste someone else's and inherit their sub. */
    if (s.client_reference_id && s.client_reference_id !== did)
      return { ok:false, error:"that checkout belongs to another device" };
    await ledger(env).fetch(new Request("https://l/sub", { method:"POST", body: JSON.stringify({
      did, uid: who.uid || "",
      email: (s.customer_details && s.customer_details.email) || s.customer_email || "",
      customer: s.customer || "", sub: s.subscription || "", status: "active"
    })}));
    return { ok:true };
  }catch(e){ return { ok:false, error: e.message || "could not confirm that payment" }; }
}

/* Stripe signs every webhook. An unverified endpoint is an open door
   that anyone can use to grant themselves a subscription. */
async function stripeVerify(env, raw, header){
  if (!ID(env,"STRIPE_WEBHOOK_SECRET") || !header) return false;
  const parts = Object.fromEntries(String(header).split(",").map(p => p.split("=", 2)));
  const t = parts.t, sig = parts.v1;
  if (!t || !sig) return false;
  /* Five minutes, so a captured request cannot be replayed later. */
  if (Math.abs(Date.now()/1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(ID(env,"STRIPE_WEBHOOK_SECRET")),
    { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(t + "." + raw));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2,"0")).join("");
  if (hex.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

async function stripeWebhook(env, req){
  const raw = await req.text();
  if (!await stripeVerify(env, raw, req.headers.get("Stripe-Signature")))
    return new Response("bad signature", { status:400 });
  let ev = {};
  try{ ev = JSON.parse(raw); }catch(e){ return new Response("bad json", { status:400 }); }
  const o = (ev.data && ev.data.object) || {};
  const ended = ["customer.subscription.deleted", "customer.subscription.paused"];
  const changed = ["customer.subscription.updated"];
  try{
    if (ended.includes(ev.type) || (changed.includes(ev.type) && ["canceled","unpaid","incomplete_expired"].includes(o.status))){
      await ledger(env).fetch(new Request("https://l/unsub", { method:"POST",
        body: JSON.stringify({ customer: o.customer || "", sub: o.id || "" }) }));
    }
  }catch(e){}
  /* Always 200 once the signature is good — a retry storm helps nobody,
     and the subscription state is Stripe's to replay. */
  return new Response("ok", { status:200 });
}
