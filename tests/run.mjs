/* STATIONS regression run. No third party is ever contacted: the music
   players are stubbed and the signalling relay is the one in relay.mjs.
   Nothing here may become a dependency of index.html. */
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { startRelay, FREE_CALLS } from "./relay.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let pass = 0, fail = 0;
const ok  = (n, c, extra="") => { c ? (pass++, console.log("  ok   " + n)) : (fail++, console.log("  FAIL " + n + (extra?"  — "+extra:""))); };

const MIME = { ".html":"text/html", ".css":"text/css", ".js":"text/javascript",
               ".xml":"application/xml", ".png":"image/png", ".txt":"text/plain" };
function serve(){
  const s = http.createServer((req,res) => {
    let p0 = req.url.split("?")[0].split("#")[0];
    let f = path.join(ROOT, p0 === "/" ? "/index.html" : p0);
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
    if (!f.startsWith(ROOT) || !fs.existsSync(f)){ res.writeHead(404); res.end(); return; }
    res.writeHead(200, {"Content-Type": MIME[path.extname(f)] || "text/plain"});
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

/* ---- the coach ---- */
console.log("\nthe coach");
{
  const ctx = await browser.newContext();
  const p = await newPage(ctx);
  await p.goto(BASE);
  /* coachSpeak is the seam pre-rendered audio will use; standing in for it
     here means the tests never depend on a headless browser having voices. */
  await p.evaluate(() => {
    window.__said = [];
    window.coachSpeak = (text, id) => window.__said.push({ text, id });
    generateWorkout();
  });

  const names = await p.evaluate(() => Object.keys(COACHES).map(k => COACHES[k].name));
  ok("the full intensity ladder ships",
     ["The Quiet One","The Coach","Sarge","Feral"].every(n => names.includes(n)), names.join(", "));
  const sizes = await p.evaluate(() => {
    const out = {};
    for (const k of Object.keys(COACHES))
      out[k] = Object.values(COACHES[k].lines).reduce((a,v) => a + (Array.isArray(v)?v.length:1), 0);
    return out;
  });
  ok("every persona has enough lines to not repeat itself early",
     Object.values(sizes).every(n => n >= 30), JSON.stringify(sizes));

  /* it names the exercise when a station starts */
  const said = await p.evaluate(() => {
    window.__said = [];
    S.segs = buildTimeline(); S.idx = 0; S.running = true;
    const wi = S.segs.findIndex(x => x.type === "work");
    S.idx = wi; S.remain = S.segs[wi].dur * 1000;
    coachSegment(S.segs[wi], false);
    return { line: (window.__said[0]||{}).text || "", ex: S.segs[wi].label };
  });
  ok("names the exercise at a station", said.line.includes(said.ex), `${said.line} / ${said.ex}`);

  /* the beeps own the last few seconds */
  const tail = await p.evaluate(() => {
    window.__said = []; CO.last = -1e9; S.running = true;
    S.remain = 2000;                       // inside the countdown
    const spokeLate = coachSay("mid", {});
    CO.last = -1e9; S.remain = 20000;      // plenty of room
    const spokeEarly = coachSay("mid", {});
    return { spokeLate, spokeEarly };
  });
  ok("silent inside the final seconds", tail.spokeLate === false);
  ok("but speaks when there is room", tail.spokeEarly === true);

  /* no line twice until the pool is spent */
  const rep = await p.evaluate(() => {
    coachReset(); window.__said = [];
    const pool = COACHES[CO.id].lines.mid.length;
    for (let i=0;i<pool;i++){ CO.last = -1e9; S.remain = 20000; coachSay("mid", {}); }
    const ids = window.__said.map(x => x.id);
    return { pool, spoken: ids.length, unique: new Set(ids).size };
  });
  ok("no line repeats until the pool is spent", rep.unique === rep.spoken && rep.spoken === rep.pool,
     JSON.stringify(rep));

  /* two lines cannot land on top of each other */
  const gap = await p.evaluate(() => {
    coachReset(); window.__said = []; S.remain = 20000; S.running = true;
    const a = coachSay("mid", {});
    const b = coachSay("mid", {});          // immediately after
    return { a, b };
  });
  ok("will not speak twice in a row", gap.a === true && gap.b === false);

  /* personas are actually different */
  const diff = await p.evaluate(() => {
    const out = {};
    for (const id of Object.keys(COACHES)){
      CO.id = id; coachReset(); window.__said = [];
      CO.last = -1e9; S.remain = 20000;
      coachSay("work", { ex:"Kettlebell Swing" }, { force:true });
      out[id] = { line:(window.__said[0]||{}).text||"", rate:COACHES[id].rate };
    }
    CO.id = "coach";
    return out;
  });
  const lines = Object.values(diff).map(d => d.line);
  ok("each persona has its own words", new Set(lines).size === lines.length, JSON.stringify(lines));
  ok("and its own delivery", new Set(Object.values(diff).map(d => d.rate)).size >= 3);

  /* silence means silence */
  const off = await p.evaluate(() => {
    coachReset(); window.__said = []; CO.on = false; S.remain = 20000;
    const spoke = coachSay("mid", {}, { force:true });
    CO.on = true;
    return spoke;
  });
  ok("Silence turns it off completely", off === false);

  const muted = await p.evaluate(() => {
    coachReset(); window.__said = []; S.voice = false; CO.last = -1e9; S.remain = 20000;
    const spoke = coachSay("mid", {}, { force:true });
    S.voice = true;
    return spoke;
  });
  ok("the voice toggle still mutes it", muted === false);

  /* the picker is wired to the setup screen */
  const chips = await p.evaluate(() => {
    show("setup");
    return [...document.querySelectorAll("#coaches .coachchip")].map(b => b.querySelector("b").textContent);
  });
  ok("the setup screen offers every persona", ["The Coach","Sarge","The Quiet One"].every(n => chips.includes(n)),
     chips.join(" / "));
  ok("plus Silence and the fresh-script switch",
     chips.includes("Silence") && chips.some(c => c.startsWith("Fresh script")), chips.join(" / "));
  await ctx.close();
}

/* ---- the generated script ---- */
console.log("\na script written per session");
{
  const ctx = await browser.newContext();

  /* off by default: a normal workout must not touch the network */
  {
    const p = await newPage(ctx, { relay:true });
    await p.goto(BASE);
    await fetch(`${RELAY}/__coachmode`);
    await p.evaluate(() => {
      window.__said = []; window.coachSpeak = (text,id) => window.__said.push({ text, id });
      generateWorkout(); startWorkout();
    });
    await p.waitForTimeout(700);
    const calls = (await (await fetch(`${RELAY}/__coach`)).json()).calls;
    ok("stays off unless asked for", calls.length === 0, JSON.stringify(calls));
    ok("and the coach still spoke from the written pool",
       await p.evaluate(() => window.__said.length > 0));
    await p.close();
  }

  /* on: one call for the whole session, and its lines get used */
  {
    const p = await newPage(ctx, { relay:true });
    await p.goto(BASE);
    await fetch(`${RELAY}/__coachmode`);
    await p.evaluate(async () => {
      window.__said = []; window.coachSpeak = (text,id) => window.__said.push({ text, id });
      CO.live = true; generateWorkout();
      startWorkout();                        // fires the request under the warm-up
      await CO.pending;                      // wait on that one, do not make a second
    });
    const body = (await (await fetch(`${RELAY}/__coach`)).json()).calls;
    ok("exactly one call for the whole workout", body.length === 1, body.length + " calls");
    ok("it sends the real station list",
       Array.isArray(body[0].stations) && body[0].stations.length > 4,
       JSON.stringify((body[0]||{}).stations||[]).slice(0,80));
    ok("and the chosen persona", !!body[0].persona);

    const used = await p.evaluate(() => {
      window.__said = []; CO.last = -1e9; S.running = true; S.remain = 20000;
      coachSay("mid", {});
      const first = (window.__said[0]||{}).text || "";
      /* the station line should be the generated one for that station */
      S.segs = buildTimeline();
      const wi = S.segs.findIndex(x => x.type === "work");
      window.__said = []; CO.last = -1e9; S.idx = wi; S.remain = S.segs[wi].dur*1000;
      coachSegment(S.segs[wi], false);
      return { mid:first, work:(window.__said[0]||{}).text || "",
               ex:S.segs[wi].label, idx: coachStationIndex(S.segs[wi]) };
    });
    ok("generated lines replace the written ones", /^GEN mid/.test(used.mid), used.mid);
    ok("each station gets its own generated line",
       used.work.startsWith("GEN " + used.idx + ":") && used.work.includes(used.ex),
       `${used.work} (station ${used.idx}, ${used.ex})`);
    ok("generated lines carry no clip id",
       await p.evaluate(() => coachPick("mid").id === null));
    await p.close();
  }

  /* the model failing must be invisible */
  {
    const p = await newPage(ctx, { relay:true });
    await p.goto(BASE);
    await fetch(`${RELAY}/__coachmode?fail=1`);
    await p.evaluate(async () => {
      window.__said = []; window.coachSpeak = (text,id) => window.__said.push({ text, id });
      CO.live = true; generateWorkout(); startWorkout();
      await CO.pending;
    });
    const fellBack = await p.evaluate(() => {
      window.__said = []; CO.last = -1e9; S.running = true; S.remain = 20000;
      coachSay("mid", {});
      return { text:(window.__said[0]||{}).text || "", gen: CO.gen };
    });
    ok("a failed model leaves the written pool in charge",
       fellBack.text.length > 0 && !/^GEN/.test(fellBack.text), fellBack.text);
    ok("and nothing broken is cached", fellBack.gen === null);
    ok("the session is still running", await p.evaluate(() => !!S.timer));
    await p.close();
  }
  await fetch(`${RELAY}/__coachmode`);
  await ctx.close();
}

/* ---- the landing pages ---- */
console.log("\nlanding pages");
{
  const ctx = await browser.newContext();
  for (const slug of ["interval-timer","hiit-timer","tabata-timer"]){
    const p = await ctx.newPage();
    const errs = [];
    p.on("pageerror", e => errs.push(e.message));
    await p.goto(`http://127.0.0.1:${site.port}/${slug}/`, { waitUntil:"networkidle" });

    const meta = await p.evaluate(() => ({
      h1: (document.querySelector("h1") || {}).textContent || "",
      desc: (document.querySelector('meta[name="description"]') || {}).content || "",
      canon: (document.querySelector('link[rel="canonical"]') || {}).href || "",
      words: document.body.innerText.trim().split(/\s+/).length,
      faqs: document.querySelectorAll("details").length,
      ld: (() => { try { return JSON.parse(
            document.querySelector('script[type="application/ld+json"]').textContent
          ); } catch(e){ return null; } })()
    }));
    ok(`${slug}: no page errors`, errs.length === 0, errs.join(" | "));
    ok(`${slug}: has an h1`, meta.h1.length > 4, meta.h1);
    ok(`${slug}: has a description`, meta.desc.length > 60);
    ok(`${slug}: canonical points at stations.fit`, /^https:\/\/stations\.fit\//.test(meta.canon), meta.canon);
    ok(`${slug}: enough real copy to rank`, meta.words > 350, meta.words + " words");
    ok(`${slug}: FAQ schema matches the visible FAQ`,
       meta.ld && meta.ld["@type"] === "FAQPage" && meta.ld.mainEntity.length === meta.faqs,
       `${meta.ld && meta.ld.mainEntity.length} in schema vs ${meta.faqs} on page`);

    /* the point of these pages is that they are a working tool, not an article */
    const before = await p.textContent("#t .t-clock");
    await p.click(".t-go");
    await p.waitForTimeout(2200);
    const after = await p.textContent("#t .t-clock");
    ok(`${slug}: the timer actually counts down`, before !== after, `${before} -> ${after}`);
    await p.click(".t-reset");
    ok(`${slug}: reset returns it to the start`, (await p.textContent("#t .t-clock")) === before);
    await p.close();
  }
  await ctx.close();
}

/* the sitemap must list every page that exists, and nothing that does not */
{
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`http://127.0.0.1:${site.port}/sitemap.xml`);
  const xml = await p.content();
  for (const u of ["https://stations.fit/", "https://stations.fit/interval-timer/",
                   "https://stations.fit/hiit-timer/", "https://stations.fit/tabata-timer/"])
    ok(`sitemap lists ${u}`, xml.includes(u));
  await ctx.close();
}

/* ---- 4c. the free-session wall ---- */
console.log("\nthe wall");
{
  const ctx = await browser.newContext({ permissions:["camera","microphone"] });
  const p = await newPage(ctx, { relay:true });
  await p.goto(BASE);
  const did = await p.evaluate(() => duoDid());
  ok("a device id is minted and kept", /^[0-9a-f]{32}$/.test(did), did);

  await fetch(`${RELAY}/__spend?did=${did}&n=${FREE_CALLS}`);   // burn the trial

  const camAsked = [];
  p.on("console", m => camAsked.push(m.text()));
  await p.evaluate(() => { generateWorkout(); show("preview"); });
  await p.click("#duostart");
  await p.waitForSelector("#duowall:not(.hide)", { timeout:10000 });
  ok("the wall appears instead of a call", true);
  ok("no camera was requested first", await p.evaluate(() => !DUO.local));
  ok("it says how many were free", /all 3 free sessions/i.test(await p.textContent("#duowalltag")));
  ok("it promises solo stays free", /solo workouts stay free/i.test(await p.textContent("#duowallbody")));

  /* a bad address is refused, and says so */
  await p.fill("#duoemail", "not-an-email");
  await p.click("#duowantin");
  await p.waitForSelector("#duomsg:not(.hide)", { timeout:8000 });
  ok("a malformed email is rejected with a reason", /does not look like an email/i.test(await p.textContent("#duomsg")));
  ok("and the button comes back", await p.evaluate(() => !document.querySelector("#duowantin").disabled));

  /* the consent box must not exist until there is a number to consent about */
  ok("no consent checkbox before a phone number is typed",
     await p.evaluate(() => document.querySelector("#duosmsrow").classList.contains("hide")));
  await p.fill("#duophone", "555 0100 22");
  ok("it appears once a number is entered",
     await p.evaluate(() => !document.querySelector("#duosmsrow").classList.contains("hide")));
  ok("and it starts unticked", await p.evaluate(() => !document.querySelector("#duosms").checked));
  const consentText = await p.textContent("#duosmsrow");
  for (const phrase of ["not a condition of purchase", "Message and data rates", "STOP"])
    ok(`the disclosure says "${phrase}"`, consentText.includes(phrase));
  await p.fill("#duophone", "");
  ok("clearing the number hides it again and unticks",
     await p.evaluate(() => document.querySelector("#duosmsrow").classList.contains("hide")
                         && !document.querySelector("#duosms").checked));

  await p.fill("#duoname", "Andre");
  await p.fill("#duophone", "555 0100 22");
  await p.check("#duosms");
  await p.fill("#duoemail", "andre+test@example.com");
  await p.click("#duowantin");
  await p.waitForFunction(() => /on the list/i.test(document.querySelector("#duowall").textContent),
                          null, { timeout:8000 });
  ok("a good email is accepted and confirmed", true);
  const stored = await (await fetch(`${RELAY}/__interest`)).json();
  const rec = (stored.find(([e]) => e === "andre+test@example.com") || [])[1] || {};
  ok("and it actually reached the relay", !!rec, JSON.stringify(stored));
  ok("with the name attached", rec.name === "Andre", JSON.stringify(rec));
  ok("with the number as typed, not reformatted", rec.phone === "555 0100 22", JSON.stringify(rec));
  ok("and consent recorded", rec.sms === 1, JSON.stringify(rec));
  await ctx.close();
}

/* ---- billing ---- */
console.log("\nthe wall when billing is off");
{
  const ctx = await browser.newContext({ permissions:["camera","microphone"] });
  const p = await newPage(ctx, { relay:true });
  await p.goto(BASE);
  await fetch(`${RELAY}/__billing?on=0`);
  const did = await p.evaluate(() => duoDid());
  await fetch(`${RELAY}/__spend?did=${did}&n=${FREE_CALLS}`);
  await p.evaluate(() => { generateWorkout(); show("preview"); });
  await p.click("#duostart");
  await p.waitForSelector("#duowall:not(.hide)", { timeout:10000 });
  ok("no Subscribe button when Stripe is not set up",
     await p.evaluate(() => document.querySelector("#duobuy").classList.contains("hide")));
  ok("and it still asks for an email", /leave your email|tell us|we'll tell you/i.test(
     await p.textContent("#duowallbody")));
  await ctx.close();
}

console.log("\nthe wall when billing is on");
{
  const ctx = await browser.newContext({ permissions:["camera","microphone"] });
  const p = await newPage(ctx, { relay:true });
  await p.goto(BASE);
  await fetch(`${RELAY}/__billing?on=1`);
  const did = await p.evaluate(() => duoDid());
  await fetch(`${RELAY}/__spend?did=${did}&n=${FREE_CALLS}`);
  await p.evaluate(() => { generateWorkout(); show("preview"); });
  await p.click("#duostart");
  await p.waitForSelector("#duobuy:not(.hide)", { timeout:10000 });
  const label = await p.textContent("#duobuy");
  ok("the Subscribe button carries the real price from Stripe", /\$7\.99\/month/.test(label), label);
  ok("the price is never hardcoded in the page",
     await p.evaluate(() => DUO_PRICE === ""), "DUO_PRICE should stay empty");
  const bodyText = await p.textContent("#duowallbody");
  ok("and the copy says only the host pays", /only the person who starts the call pays/i.test(bodyText));
  ok("email capture is still offered as the softer option",
     /just email me/i.test(await p.textContent("#duowantin")));

  /* it should hand Stripe the device, so the payment can be tied back.
     Calling the endpoint directly rather than clicking, because clicking
     navigates away to Stripe. */
  const sent = await p.evaluate(async () => {
    const r = await fetch(DUO_RELAY + "/subscribe", {
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ did: duoDid(), returnTo: location.origin + location.pathname })
    });
    return r.json();
  });
  ok("checkout starts and returns somewhere to send them", sent.ok && !!sent.url, JSON.stringify(sent));
  const calls = await (await fetch(`${RELAY}/__billingcalls`)).json();
  ok("and the device id travels with it", calls.length && calls[0].did === did, JSON.stringify(calls));
  await ctx.close();
}

console.log("\ncoming back from Stripe");
{
  const ctx = await browser.newContext({ permissions:["camera","microphone"] });
  await fetch(`${RELAY}/__billing?on=1`);
  const p = await newPage(ctx, { relay:true });
  await p.goto(BASE);
  const did = await p.evaluate(() => duoDid());
  const started = await (await fetch(`${RELAY}/subscribe`, { method:"POST",
    headers:{"Content-Type":"application/json"}, body: JSON.stringify({ did }) })).json();
  const sid = new URL(started.url, RELAY).searchParams.get("s");

  /* a session id someone else's device started must not unlock this one */
  const stolen = await p.evaluate(async ([relay, sid]) => {
    const r = await fetch(relay + "/activate", { method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ session_id: sid, did: "someone-elses-device" }) });
    return r.json();
  }, [RELAY, sid]);
  ok("a checkout cannot be claimed by another device", stolen.ok === false, JSON.stringify(stolen));

  const forged = await p.evaluate(async ([relay, did]) => {
    const r = await fetch(relay + "/activate", { method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ session_id: "cs_test_madeup", did }) });
    return r.json();
  }, [RELAY, did]);
  ok("and an invented session id unlocks nothing", forged.ok === false, JSON.stringify(forged));

  /* A fresh page in the same context: same localStorage, so the same
     device id, but boot actually runs. Navigating the existing page to
     the same URL with only a hash added does not reload it. */
  const back = await newPage(ctx, { relay:true });
  await back.goto(BASE + "#paid=" + sid);
  await back.waitForFunction(() => /you're in|could not/i.test(
    (document.querySelector("#duomsg")||{}).textContent || ""), null, { timeout:15000 });
  const msg = await back.textContent("#duomsg");
  ok("a real return from Stripe unlocks it", /you're in/i.test(msg), msg);
  ok("the session id is scrubbed from the address bar",
     await back.evaluate(() => location.hash.indexOf("paid=") < 0));

  const st = await back.evaluate(async () => { await duoTrial(); return { sub: DUO.subscribed, left: DUO.left }; });
  ok("and the trial no longer applies", st.sub === true, JSON.stringify(st));
  await ctx.close();
  await fetch(`${RELAY}/__billing?on=0`);
}

/* ---- 4d. the gate is the server's, not the page's ---- */
console.log("\nthe gate cannot be edited around");
{
  const ctx = await browser.newContext({ permissions:["camera","microphone"] });
  const p = await newPage(ctx, { relay:true });
  await p.goto(BASE);
  const did = await p.evaluate(() => duoDid());
  await fetch(`${RELAY}/__spend?did=${did}&n=${FREE_CALLS}`);
  /* Pretend the client lies: skip the check entirely and open a room
     the way a tampered page would. The relay must still refuse. */
  const verdict = await p.evaluate(relay => new Promise(res => {
    const ws = new WebSocket(relay.replace(/^http/, "ws") + "/room/tampered1?did=" + duoDid());
    ws.onmessage = e => res(JSON.parse(e.data));
    ws.onerror = () => res({ t:"error" });
    setTimeout(() => res({ t:"timeout" }), 8000);
  }), RELAY);
  ok("the relay blocks a tampered client", verdict.t === "blocked", JSON.stringify(verdict));
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

  /* Nothing on the connected-but-not-started screen may be covered by the
     video. This is the bug two real phones found and the container did not:
     the tests used to call startWorkout() directly, so nobody ever tried to
     TAP the button, and #preview is a plain .wrap with no stacking context
     underneath a position:fixed video. */
  const reachable = async (pg, sel) => pg.evaluate(s => {
    const el = document.querySelector(s);
    if (!el) return { ok:false, why:"missing" };
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return { ok:false, why:"zero size" };
    const hit = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
    return { ok: !!hit && (hit === el || el.contains(hit) || hit.contains(el)),
             why: hit ? (hit.id || hit.tagName.toLowerCase()) : "nothing" };
  }, sel);

  for (const [who, pg] of [["host", host], ["guest", guest]]){
    const st = await reachable(pg, "#start");
    ok(who + " can actually tap Start workout once connected", st.ok, "covered by " + st.why);
  }
  const bleed = await host.evaluate(() => {
    const v = document.querySelector("#duofar");
    const r = v.getBoundingClientRect();
    return { full: r.width >= innerWidth * 0.95 && r.height >= innerHeight * 0.95,
             shown: getComputedStyle(v).display !== "none" };
  });
  ok("partner video is visible before the workout", bleed.shown);
  ok("but not covering the whole screen yet", !bleed.full, "full-bleed while still on preview");


  /* compress the session so the run is quick, then start it */
  await host.evaluate(() => { S.workout.halves.forEach(h => { h.work = 3; h.rest = 2; h.rounds = 1; h.stations = Math.min(2, h.stations); h.list = h.list.slice(0,2); }); S.workout.warmup = 2; S.workout.halftime = 2; S.workout.cooldown = 2; });
  await guest.evaluate(() => { S.workout.halves.forEach(h => { h.work = 3; h.rest = 2; h.rounds = 1; h.stations = Math.min(2, h.stations); h.list = h.list.slice(0,2); }); S.workout.warmup = 2; S.workout.halftime = 2; S.workout.cooldown = 2; });
  /* Click it, do not call it. Calling startWorkout() directly is what hid
     the covered-button bug from every previous run. */
  await host.click("#start");
  await host.waitForFunction(() => !!S.timer, null, { timeout:10000 });
  await guest.waitForFunction(() => !!S.timer, null, { timeout:10000 });
  ok("the guest's session started from the host's go", true);

  const bleedNow = await host.evaluate(() => {
    const r = document.querySelector("#duofar").getBoundingClientRect();
    return r.width >= innerWidth * 0.95 && r.height >= innerHeight * 0.95;
  });
  ok("and now the partner does fill the screen", bleedNow);

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
