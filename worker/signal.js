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
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

const PUBLIC_STUN = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }
];

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
      const r = await ledger(env).fetch(new Request("https://l/state?did=" + encodeURIComponent(did)));
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
      if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY)
        return new Response("nope", { status:404, headers:cors });
      const r = await ledger(env).fetch(new Request("https://l/dump"));
      return new Response(adminPage(await r.json(), url.searchParams.get("key")), {
        headers: { ...cors, "Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store" }});
    }

    /* Deliberately not clever: one shared secret, and without it set the
       list simply is not reachable from the internet. */
    if (url.pathname === "/interest/export"){
      if (!env.ADMIN_KEY || url.searchParams.get("key") !== env.ADMIN_KEY)
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
      const out = await stripeActivate(env, b || {});
      return new Response(JSON.stringify(out), { status: out.ok ? 200 : 400,
        headers: { ...cors, "Content-Type":"application/json" }});
    }
    if (url.pathname === "/stripe/webhook" && req.method === "POST"){
      return stripeWebhook(env, req);
    }

    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_-]{4,40})$/);
    if (m){
      if (req.headers.get("Upgrade") !== "websocket")
        return new Response("expected a websocket", { status:426, headers:cors });
      const id = env.ROOM.idFromName(m[1]);
      return env.ROOM.get(id).fetch(req);
    }

    return new Response("stations signalling relay", { status:404, headers:cors });
  }
};

/* Credentials are short-lived by design, so they cannot be pasted into
   index.html — minting them is the one thing that genuinely needs a
   server side. Without the secrets set this degrades to public STUN,
   which connects most calls but not the ones behind symmetric NAT. */
async function iceServers(env){
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return { iceServers: PUBLIC_STUN };
  try{
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      { method:"POST",
        headers:{ "Authorization":`Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type":"application/json" },
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

    const did = (new URL(req.url).searchParams.get("did") || "").slice(0, 64);
    const first = live.length === 0;

    /* The host is the one who needs standing. Whoever they invite gets in
       free — a subscription nobody can share is a subscription nobody can
       recommend, and the invited friend is exactly who you want to reach. */
    if (first){
      const v = await this.env.LEDGER.get(this.env.LEDGER.idFromName("v1"))
        .fetch(new Request("https://l/check?did=" + encodeURIComponent(did)));
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
      if (host) this.env.LEDGER.get(this.env.LEDGER.idFromName("v1"))
        .fetch(new Request("https://l/spend?did=" + encodeURIComponent(host)))
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
    /* This table is already live with the original four columns, and SQLite
       has no ADD COLUMN IF NOT EXISTS. Adding each one and ignoring the
       failure is the ordinary way to migrate a table you cannot drop. */
    for (const col of ["name TEXT", "phone TEXT", "sms INTEGER", "ip TEXT"]){
      try{ this.sql.exec(`ALTER TABLE interest ADD COLUMN ${col}`); }catch(e){}
    }
  }

  subbed(did){
    if (!did) return false;
    const r = [...this.sql.exec("SELECT status FROM subs WHERE did = ?", did)];
    return !!r.length && r[0].status === "active";
  }

  row(did){
    const r = [...this.sql.exec("SELECT used FROM trials WHERE did = ?", did)];
    return r.length ? r[0].used : 0;
  }

  async fetch(req){
    const url = new URL(req.url);
    const did = (url.searchParams.get("did") || "").slice(0, 64);
    const now = Date.now();
    const json = (o, status) => new Response(JSON.stringify(o),
      { status: status || 200, headers:{ "Content-Type":"application/json" }});

    switch (url.pathname){

      /* Read-only. Used to show "2 of 3 left" before anyone commits. */
      case "/state": {
        const used = did ? this.row(did) : 0;
        const sub = this.subbed(did);
        return json({ used, limit:FREE_CALLS,
                      remaining: sub ? 9999 : Math.max(0, FREE_CALLS - used),
                      subscribed: sub });
      }

      /* Asked before a room opens. A missing did is treated as spent —
         a client that will not identify itself does not get free calls. */
      case "/check": {
        if (!did) return json({ allowed:false, used:FREE_CALLS, limit:FREE_CALLS });
        if (this.subbed(did)) return json({ allowed:true, subscribed:true, used:0, limit:FREE_CALLS });
        const used = this.row(did);
        return json({ allowed: used < FREE_CALLS, used, limit:FREE_CALLS });
      }

      /* Fire-and-forget from the Room when a second person turns up. */
      case "/spend": {
        if (!did) return json({ ok:false });
        this.sql.exec(
          `INSERT INTO trials(did, used, first_seen, last_seen) VALUES(?, 1, ?, ?)
           ON CONFLICT(did) DO UPDATE SET used = used + 1, last_seen = excluded.last_seen`,
          did, now, now);
        return json({ ok:true, used: this.row(did) });
      }

      case "/sub": {
        let b = {}; try{ b = await req.json(); }catch(e){}
        if (!b.did) return json({ ok:false });
        this.sql.exec(
          `INSERT INTO subs(did, email, customer, sub, status, at) VALUES(?, ?, ?, ?, ?, ?)
           ON CONFLICT(did) DO UPDATE SET email=excluded.email, customer=excluded.customer,
             sub=excluded.sub, status=excluded.status, at=excluded.at`,
          String(b.did).slice(0,64), String(b.email||"").slice(0,254),
          String(b.customer||"").slice(0,64), String(b.sub||"").slice(0,64),
          String(b.status||"active").slice(0,24), now);
        return json({ ok:true });
      }

      /* Cancellations arrive keyed by Stripe's ids, not by device. */
      case "/unsub": {
        let b = {}; try{ b = await req.json(); }catch(e){}
        if (b.sub)      this.sql.exec("UPDATE subs SET status='ended', at=? WHERE sub = ?", now, String(b.sub));
        if (b.customer) this.sql.exec("UPDATE subs SET status='ended', at=? WHERE customer = ?", now, String(b.customer));
        return json({ ok:true });
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
        return json({ interest, devices: t.n || 0, sessions: t.s || 0, spent: spent.n || 0,
                      subscribers: subs.n || 0 });
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
async function notify(env, body){
  if (!env.RESEND_API_KEY || !env.ADMIN_EMAIL) return;
  const who = String((body && body.email) || "").slice(0, 254);
  if (!who) return;
  await fetch("https://api.resend.com/emails", {
    method:"POST",
    headers:{ "Authorization":"Bearer " + env.RESEND_API_KEY, "Content-Type":"application/json" },
    body: JSON.stringify({
      from: env.NOTIFY_FROM || "STATIONS <onboarding@resend.dev>",
      to: [env.ADMIN_EMAIL],
      subject: "Someone hit the wall: " + who,
      text: who + " used up their three free sessions and asked to be told when "
          + "Train together opens.\n\nThe whole list: "
          + "https://stations-signal.andre-rafizadeh.workers.dev/admin?key=YOUR_ADMIN_KEY\n"
    })
  });
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

function stripeOn(env){ return !!(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID); }

async function stripeCall(env, path, form, method){
  const r = await fetch(STRIPE + path, {
    method: method || (form ? "POST" : "GET"),
    headers: {
      "Authorization": "Bearer " + env.STRIPE_SECRET_KEY,
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
    const p = await stripeCall(env, "prices/" + encodeURIComponent(env.STRIPE_PRICE_ID));
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
      "line_items[0][price]": env.STRIPE_PRICE_ID,
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
async function stripeActivate(env, b){
  if (!stripeOn(env)) return { ok:false, error:"billing is not set up yet" };
  const id  = String(b.session_id || "").slice(0, 200);
  const did = String(b.did || "").slice(0, 64);
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
      did, email: (s.customer_details && s.customer_details.email) || s.customer_email || "",
      customer: s.customer || "", sub: s.subscription || "", status: "active"
    })}));
    return { ok:true };
  }catch(e){ return { ok:false, error: e.message || "could not confirm that payment" }; }
}

/* Stripe signs every webhook. An unverified endpoint is an open door
   that anyone can use to grant themselves a subscription. */
async function stripeVerify(env, raw, header){
  if (!env.STRIPE_WEBHOOK_SECRET || !header) return false;
  const parts = Object.fromEntries(String(header).split(",").map(p => p.split("=", 2)));
  const t = parts.t, sig = parts.v1;
  if (!t || !sig) return false;
  /* Five minutes, so a captured request cannot be replayed later. */
  if (Math.abs(Date.now()/1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
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
