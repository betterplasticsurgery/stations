/* STATIONS regression run. No third party is ever contacted: the music
   players are stubbed and the signalling relay is the one in relay.mjs.
   Nothing here may become a dependency of index.html. */
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { startRelay } from "./relay.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let pass = 0, fail = 0;
const ok  = (n, c, extra="") => { c ? (pass++, console.log("  ok   " + n)) : (fail++, console.log("  FAIL " + n + (extra?"  — "+extra:""))); };

function serve(){
  const s = http.createServer((req,res) => {
    const f = path.join(ROOT, (req.url.split("?")[0] === "/" ? "/index.html" : req.url.split("?")[0]).split("#")[0]);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)){ res.writeHead(404); res.end(); return; }
    res.writeHead(200, {"Content-Type": f.endsWith(".html") ? "text/html" : "text/plain"});
    res.end(fs.readFileSync(f));
  });
  return new Promise(r => s.listen(0,"127.0.0.1",()=>r({ port:s.address().port, close:()=>new Promise(q=>s.close(q)) })));
}

/* The fake device flags are what let two RTCPeerConnections in one
   browser see a camera without a camera, and without a prompt. */
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
  args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--no-sandbox"]
});
const site = await serve();
const relay = await startRelay();
const BASE = `http://127.0.0.1:${site.port}/index.html`;
const RELAY = `http://127.0.0.1:${relay.port}`;

async function newPage(ctx, opts={}){
  const p = await ctx.newPage();
  p.on("pageerror", e => { fail++; console.log("  FAIL page error — " + e.message); });
  if (opts.relay) await p.addInitScript(r => { window.STATIONS_RELAY = r; }, RELAY);
  return p;
}

/* ---- 1. cold load asks nobody for anything ---- */
console.log("\ncold load");
{
  const ctx = await browser.newContext();
  const external = [];
  ctx.on("request", r => { if (!r.url().startsWith("http://127.0.0.1:")) external.push(r.url()); });
  const p = await newPage(ctx);
  await p.goto(BASE, { waitUntil:"networkidle" });
  ok("zero external requests with music off", external.length === 0, external.join(", "));
  ok("home screen is up", await p.isVisible("#home"));
  await ctx.close();
}

/* ---- 2. presets still land on the second ---- */
console.log("\npresets");
{
  const ctx = await browser.newContext();
  const p = await newPage(ctx);
  await p.goto(BASE);
  const WANT = { hybrid:45*60, engine:45*60, power:45*60, express:30*60 };
  const bad = await p.evaluate(w => PRESETS
    .map(x => ({ id:x.id, want:w[x.id], got: totalSeconds(cfgFromPreset(x)) }))
    .filter(r => r.want !== r.got), WANT);
  ok("every preset totals exactly", bad.length === 0, JSON.stringify(bad));
  await ctx.close();
}

/* ---- 3. every exercise has a tag and an animation ---- */
console.log("\nlibrary");
{
  const ctx = await browser.newContext();
  const p = await newPage(ctx);
  await p.goto(BASE);
  const r = await p.evaluate(() => ({
    untagged: LIB.filter(x => !TAG[x.n]).map(x => x.n),
    unanimated: LIB.filter(x => !animFor(x.n)).map(x => x.n)
  }));
  ok("every exercise has a TAG entry", r.untagged.length === 0, r.untagged.join(", "));
  ok("every exercise has an animation", r.unanimated.length === 0, r.unanimated.join(", "));
  await ctx.close();
}

/* ---- 4. the relay being unreachable is explained, not swallowed ----
   DUO_RELAY now points at the deployed Worker, so "nothing configured"
   is no longer reachable from a browser. What IS reachable is the relay
   being down or blocked, and that has to say so rather than hanging. */
console.log("\nduo when the relay cannot be reached");
{
  const ctx = await browser.newContext({ permissions:["camera","microphone"] });
  const p = await ctx.newPage();
  p.on("pageerror", e => { fail++; console.log("  FAIL page error — " + e.message); });
  await p.addInitScript(() => { window.STATIONS_RELAY = "http://127.0.0.1:9"; });  // discard port
  await p.goto(BASE);
  await p.evaluate(() => { generateWorkout(); show("preview"); });
  await p.click("#duostart");
  await p.waitForFunction(() => {
    const el = document.querySelector("#duomsg");
    return el && !el.classList.contains("hide") && /could not|did not answer|Could not start/i.test(el.textContent);
  }, null, { timeout: 20000 });
  const t = await p.textContent("#duomsg");
  ok("says the relay could not be reached", /relay/i.test(t), t);
  ok("the message is actually visible", await p.isVisible("#duomsg"));
  ok("no half-open call left behind", await p.evaluate(() => !DUO.connected && !DUO.ws));
  await ctx.close();
}

/* ---- 4b. the deployed relay URL is the one baked into the app ---- */
console.log("\ndeployed relay");
{
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(BASE);
  const url = await p.evaluate(() => DUO_RELAY);
  ok("DUO_RELAY is filled in", /^https:\/\/.+/.test(url), url);
  ok("and is not a placeholder", !/<|your-worker|example/.test(url), url);
  await ctx.close();
}

/* ---- 5. two peers actually connect, and share one clock ---- */
console.log("\nduo end to end");
{
  const ctx = await browser.newContext({ permissions:["camera","microphone"] });
  const host = await newPage(ctx, { relay:true });
  await host.goto(BASE);
  await host.evaluate(() => { PROF.name = "Andre"; generateWorkout(); show("preview"); });
  await host.click("#duostart");
  await host.waitForFunction(() => !!DUO.link, null, { timeout:15000 });
  const link = await host.evaluate(() => DUO.link);
  ok("invite link carries a room code", /#duo=[a-z2-9]{8}$/.test(link), link);
  await host.waitForSelector("#duoqr:not(.hide)", { timeout:10000 });
  const qr = await host.evaluate(() => {
    const c = document.getElementById("duoqr");
    const g = c.getContext("2d").getImageData(0,0,c.width,c.height).data;
    let dark = 0;
    for (let i=0;i<g.length;i+=4) if (g[i] < 128) dark++;
    return { w:c.width, dark };
  });
  ok("the QR rendered actual modules", qr.w > 0 && qr.dark > 500, JSON.stringify(qr));

  const guest = await newPage(ctx, { relay:true });
  await guest.goto(BASE.replace(/index\.html.*/, "index.html") + link.slice(link.indexOf("#")));
  await guest.waitForSelector("#duoinvite:not(.hide)", { timeout:15000 });

  const same = await guest.evaluate(() => S.workout.halves.map(h => h.list.map(e => e.n)));
  const hostHas = await host.evaluate(() => S.workout.halves.map(h => h.list.map(e => e.n)));
  ok("guest received the host's exact stations", JSON.stringify(same) === JSON.stringify(hostHas));

  await guest.click("#duojoin");
  await host.waitForFunction(() => DUO.connected, null, { timeout:20000 });
  await guest.waitForFunction(() => DUO.connected, null, { timeout:20000 });
  ok("both sides report connected", true);

  await host.waitForFunction(() => DUO.rtt < 1e9, null, { timeout:10000 });
  ok("clock offset was measured", await host.evaluate(() => DUO.rtt < 5000));

  /* compress the session so the run is quick, then start it */
  await host.evaluate(() => { S.workout.halves.forEach(h => { h.work = 3; h.rest = 2; h.rounds = 1; h.stations = Math.min(2, h.stations); h.list = h.list.slice(0,2); }); S.workout.warmup = 2; S.workout.halftime = 2; S.workout.cooldown = 2; });
  await guest.evaluate(() => { S.workout.halves.forEach(h => { h.work = 3; h.rest = 2; h.rounds = 1; h.stations = Math.min(2, h.stations); h.list = h.list.slice(0,2); }); S.workout.warmup = 2; S.workout.halftime = 2; S.workout.cooldown = 2; });
  await host.evaluate(() => startWorkout());
  await guest.waitForFunction(() => !!S.timer, null, { timeout:10000 });
  ok("the guest's session started from the host's go", true);

  await host.waitForFunction(() => S.idx >= 2, null, { timeout:20000 });
  await guest.waitForFunction(() => S.idx >= 1, null, { timeout:20000 });
  const [hi, gi] = [await host.evaluate(()=>S.idx), await guest.evaluate(()=>S.idx)];
  ok("both are on the same segment", Math.abs(hi - gi) <= 1, `host ${hi} guest ${gi}`);

  const elapsed = pg => pg.evaluate(() => {
    const s = S.segs[S.idx]; return s ? s.start + (s.dur - S.remain/1000) : -1;
  });
  const [he, ge] = await Promise.all([elapsed(host), elapsed(guest)]);
  ok("guest is within a second of the host", Math.abs(he - ge) < 1.2, `host ${he.toFixed(2)}s guest ${ge.toFixed(2)}s`);

  /* the exercise figure is drawn on both screens, over the video */
  const fig = async pg => pg.evaluate(async () => {
    /* wait for a work segment, then look at what is actually painted */
    for (let i=0;i<80;i++){
      const s = S.segs[S.idx];
      if (s && s.type === "work"){
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const c = document.getElementById("fig");
        const g = c.getContext("2d").getImageData(0,0,c.width,c.height).data;
        let ink = 0;
        for (let j=3;j<g.length;j+=4) if (g[j] > 24) ink++;
        return { hidden: document.getElementById("figwrap").classList.contains("hide"),
                 name: document.getElementById("exname").textContent, ink };
      }
      await new Promise(r => setTimeout(r, 120));
    }
    return { hidden:true, name:"", ink:0 };
  });
  const [hf, gf] = [await fig(host), await fig(guest)];
  ok("host draws the exercise figure", !hf.hidden && hf.ink > 300, JSON.stringify(hf));
  ok("guest draws the same exercise figure", !gf.hidden && gf.ink > 300, JSON.stringify(gf));
  ok("and it is the same exercise on both", hf.name === gf.name, `${hf.name} / ${gf.name}`);

  /* the guest cannot drive the clock */
  await guest.click("#toggle");
  await guest.waitForTimeout(300);
  ok("guest's pause is refused", await guest.evaluate(() => S.running === true));
  const gm = await guest.textContent("#duomsg");
  ok("and it says why", /running the clock/.test(gm || ""), gm);

  /* mic follows the work/rest boundary */
  const micStates = await guest.evaluate(async () => {
    const seen = [];
    for (let i=0;i<26;i++){
      const s = S.segs[S.idx];
      const tr = DUO.local.getAudioTracks()[0];
      if (s) seen.push(s.type + ":" + (tr.enabled ? "on" : "off"));
      await new Promise(r => setTimeout(r, 400));
    }
    return [...new Set(seen)];
  });
  ok("mic is muted through work", !micStates.some(s => s.startsWith("work:on")), micStates.join(" "));
  ok("mic is open outside work", micStates.some(s => /^(rest|warmup|halftime|cooldown):on/.test(s)), micStates.join(" "));

  await host.evaluate(() => duoHangUp());
  await ctx.close();
}

await relay.close(); await site.close(); await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
