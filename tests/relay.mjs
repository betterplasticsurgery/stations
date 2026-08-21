/* A stand-in for worker/signal.js, in-process, so the duo tests never
   touch the network. Same contract: hold the offer, relay everything
   else, and refuse to open a room for a host whose free sessions are
   spent. Kept deliberately small — it mirrors the Worker's behaviour,
   not its implementation. */
import { WebSocketServer } from "ws";
import http from "node:http";

export const FREE_CALLS = 3;

export function startRelay(){
  const rooms = new Map();
  const used = new Map();          // did -> sessions spent
  const interest = new Map();      // email -> did
  const coachCalls = [];
  const coachMode = { fail:false, slow:false };
  const json = (res, o, status=200) => {
    res.writeHead(status, {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"});
    res.end(JSON.stringify(o));
  };

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    /* The real Worker answers preflight; so must this, or every POST from
       the page fails before it is sent and the app only sees a network error. */
    if (req.method === "OPTIONS"){
      res.writeHead(204, {
        "Access-Control-Allow-Origin":"*",
        "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
        "Access-Control-Allow-Headers":"Content-Type" });
      return res.end();
    }
    if (u.pathname === "/ice") return json(res, { iceServers: [] });

    if (u.pathname === "/trial"){
      const did = u.searchParams.get("did") || "";
      const spent = used.get(did) || 0;
      return json(res, { used: spent, limit: FREE_CALLS,
                         remaining: Math.max(0, FREE_CALLS - spent), subscribed: false });
    }
    if (u.pathname === "/interest" && req.method === "POST"){
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        let b = {}; try{ b = JSON.parse(body); }catch(e){}
        const email = String(b.email || "").trim();
        if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email))
          return json(res, { ok:false, error:"that does not look like an email" }, 400);
        interest.set(email, b.did || "");
        json(res, { ok:true });
      });
      return;
    }
    if (u.pathname === "/coach" && req.method === "POST"){
      let body = "";
      req.on("data", c => body += c);
      req.on("end", () => {
        let b = {}; try{ b = JSON.parse(body); }catch(e){}
        coachCalls.push(b);
        if (coachMode.fail) return json(res, { ok:false, error:"model unavailable" }, 502);
        if (coachMode.slow) return;                      // never answers: tests the timeout
        const stations = b.stations || [];
        json(res, { ok:true, persona:b.persona, lines:{
          start:"GEN start line",
          work: stations.map((n,i) => `GEN ${i}: ${n}, go`),
          mid:  ["GEN mid A","GEN mid B","GEN mid C"],
          rest: ["GEN rest A","GEN rest B"],
          half: "GEN half", end: "GEN end"
        }});
      });
      return;
    }
    if (u.pathname === "/__coach") return json(res, { calls: coachCalls, mode: coachMode });
    if (u.pathname === "/__coachmode"){
      coachMode.fail = u.searchParams.get("fail") === "1";
      coachMode.slow = u.searchParams.get("slow") === "1";
      coachCalls.length = 0;
      return json(res, { ok:true, mode: coachMode });
    }
    if (u.pathname === "/__interest") return json(res, [...interest.entries()]);
    if (u.pathname === "/__spend"){   // test hook: burn someone's free sessions
      const did = u.searchParams.get("did") || "";
      used.set(did, Number(u.searchParams.get("n") || FREE_CALLS));
      return json(res, { ok:true, used: used.get(did) });
    }
    res.writeHead(404); res.end();
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    const u = new URL(req.url, "http://x");
    const code = u.pathname.replace("/room/", "");
    const did = u.searchParams.get("did") || "";
    const room = rooms.get(code) || { peers: new Set(), offer: null, host: null };
    rooms.set(code, room);
    const first = room.peers.size === 0;

    if (first && (used.get(did) || 0) >= FREE_CALLS){
      ws.send(JSON.stringify({ t:"blocked", used: used.get(did), limit: FREE_CALLS }));
      ws.close(1008, "trial spent");
      return;
    }
    if (first) room.host = did;

    room.peers.add(ws);
    if (!first){
      if (room.offer) ws.send(room.offer);
      if (room.host) used.set(room.host, (used.get(room.host) || 0) + 1);   // a real session
    }
    ws.send(JSON.stringify({ t:"joined", host:first }));
    if (!first) for (const p of room.peers) if (p !== ws) p.send(JSON.stringify({ t:"peer" }));

    ws.on("message", raw => {
      const msg = String(raw);
      try{ if (JSON.parse(msg).t === "offer") room.offer = msg; }catch(e){}
      for (const p of room.peers) if (p !== ws && p.readyState === 1) p.send(msg);
    });
    ws.on("close", () => { room.peers.delete(ws); if (!room.peers.size) rooms.delete(code); });
  });

  return new Promise(res => server.listen(0, "127.0.0.1", () => {
    res({ port: server.address().port, used, interest,
          close: () => new Promise(r => { wss.close(); server.close(r); }) });
  }));
}
