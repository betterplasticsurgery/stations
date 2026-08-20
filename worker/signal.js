/* =========================================================
   STATIONS — signalling relay
   =========================================================
   The only server this project has, and it is deliberately the
   smallest one that can exist: two people need to swap a WebRTC
   offer and an answer, and a link cannot carry the answer back.
   Nothing about a workout passes through here, nothing is logged,
   and a room's contents are dropped the moment both sides leave
   or ROOM_TTL_MS elapses — whichever comes first.

   Routes
     GET /ice            → ICE servers. Cloudflare TURN when the
                           secrets are set, public STUN otherwise.
     GET /room/<code>    → WebSocket. Everything sent is relayed
                           verbatim to the other side of the room.

   Deploy: see worker/README.md
   ========================================================= */

import { DurableObject } from "cloudflare:workers";

const ROOM_TTL_MS = 30 * 60 * 1000;   // a room is for joining, not for living in
const MAX_PEERS   = 2;                 // duo means two
const MAX_MSG     = 96 * 1024;         // an SDP offer is ~2.5 KB; this is generous

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
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

const PUBLIC_STUN = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }
];

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

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    /* Hibernation, not ws.accept(): the room spends almost all of its
       life waiting for the second person to open the link, and a
       hibernated socket is not billed for that wait. */
    this.ctx.acceptWebSocket(server);

    const first = live.length === 0;
    server.serializeAttachment({ host: first });

    /* The host arrives, posts an offer, and closes their laptop. Whoever
       opens the link minutes later still needs that offer, so it is held
       here rather than requiring both people to be present at once. */
    if (!first){
      const kept = await this.ctx.storage.get("offer");
      if (kept) try{ server.send(kept); }catch(e){}
    } else {
      await this.ctx.storage.deleteAll();
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
