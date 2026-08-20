/* A stand-in for worker/signal.js, in-process, so the duo tests never
   touch the network. Same contract: hold the offer, relay everything
   else to the other socket in the room. */
import { WebSocketServer } from "ws";
import http from "node:http";

export function startRelay(){
  const rooms = new Map();
  const server = http.createServer((req, res) => {
    if (req.url === "/ice"){
      res.writeHead(200, {"Content-Type":"application/json","Access-Control-Allow-Origin":"*"});
      res.end(JSON.stringify({ iceServers: [] }));   // host candidates only; both peers are local
      return;
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    const code = (req.url || "").replace("/room/", "");
    const room = rooms.get(code) || { peers: new Set(), offer: null };
    rooms.set(code, room);
    const first = room.peers.size === 0;
    room.peers.add(ws);
    if (!first && room.offer) ws.send(room.offer);
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
    res({ port: server.address().port, close: () => new Promise(r => { wss.close(); server.close(r); }) });
  }));
}
