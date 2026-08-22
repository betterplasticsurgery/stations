/* The legal pages, and a canary for them.
   -----------------------------------------------------------------
   A privacy policy is only worth anything if it matches the code. The
   interesting test here is not "does the page exist" — it is that every
   third party the app can actually reach at runtime is named on it. Add
   an analytics script, a font host, a new CDN, and this fails until the
   page says so. That is the failure mode worth catching: nobody sets out
   to write a false privacy policy, they just ship a feature. */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let pass = 0, fail = 0;
const ok = (n,c,x="") => c ? (pass++, console.log("  ok   "+n)) : (fail++, console.log("  FAIL "+n+(x?"  — "+x:"")));

const MIME = { ".html":"text/html", ".css":"text/css", ".js":"text/javascript",
               ".xml":"application/xml", ".png":"image/png", ".txt":"text/plain" };
const srv = http.createServer((q,r) => {
  let u = q.url.split("?")[0].split("#")[0];
  let f = path.join(ROOT, u === "/" ? "/index.html" : u);
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, {"Content-Type": MIME[path.extname(f)] || "text/plain"});
  r.end(fs.readFileSync(f));
});
await new Promise(r => srv.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + srv.address().port;

const read = p => fs.readFileSync(path.join(ROOT, p), "utf8");
const app  = read("index.html");
const priv = read("privacy/index.html");
const terms= read("terms/index.html");

/* ---- the pages exist and say the thing that matters ---- */
console.log("\nthe pages");
{
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args:["--no-sandbox"] });
  const p = await browser.newPage();
  for (const [u, want] of [["/terms/","Terms of use"], ["/privacy/","Privacy"]]){
    const res = await p.goto(BASE + u);
    ok(u + " is served", res.status() === 200, String(res.status()));
    ok(u + " has its heading", (await p.textContent("h1")).includes(want));
  }
  await p.goto(BASE + "/terms/");
  const warn = await p.textContent(".warn");
  ok("the health disclaimer is on the terms page",
     /not medical advice/i.test(warn) && /chest pain/i.test(warn));
  ok("and it is linkable, so the app can point at it",
     await p.$("#health") !== null);
  const sub = await p.textContent(".callout");
  ok("what a subscription is actually attached to is stated before anyone pays",
     /recovery code/i.test(sub) && /once/i.test(sub), sub.slice(0,90));
  ok("and the page is honest that a lost code cannot be looked up",
     /hash/i.test(await p.textContent("main")));
  await browser.close();
}

/* ---- every surface links to them ---- */
console.log("\nthe links");
{
  ok("the app links to both", app.includes('href="/terms/"') && app.includes('href="/privacy/"'));
  ok("and carries the disclaimer where someone will see it",
     /not medical advice/i.test(app));
  for (const p of ["interval-timer","hiit-timer","tabata-timer"]){
    const t = read(p + "/index.html");
    ok(p + " links to both", t.includes('href="/terms/"') && t.includes('href="/privacy/"'));
  }
  const sm = read("sitemap.xml");
  ok("both are in the sitemap", sm.includes("/terms/") && sm.includes("/privacy/"));
}

/* ---- ownership is stated, not implied ---- */
console.log("\nownership");
{
  ok("there is a LICENSE", fs.existsSync(path.join(ROOT, "LICENSE")));
  ok("and it reserves rights rather than granting them",
     /All rights reserved/i.test(read("LICENSE")) && /not open source/i.test(read("LICENSE")));
  ok("the app itself carries a copyright notice",
     /Copyright \(c\) 20\d\d Andre Rafizadeh/.test(app));
}

/* ---- THE CANARY ----
   Every host the shipped code can reach must be named on the privacy
   page. Hosts that are identifiers rather than requests are exempt and
   listed explicitly, so the exemption is a decision someone made rather
   than a regex accident. */
console.log("\nthird parties are disclosed");
{
  const NOT_A_REQUEST = [
    "schema.org", "www.w3.org",          // XML and JSON-LD namespaces
    "stations.fit",                       // ourselves
    "127.0.0.1", "localhost"
  ];
  /* host -> a phrase that must appear on the privacy page */
  const DISCLOSED = {
    "cdn.jsdelivr.net":        "jsdelivr",
    "storage.googleapis.com":  "Google",
    "w.soundcloud.com":        "SoundCloud",
    "soundcloud.com":          "SoundCloud",
    "api.mixcloud.com":        "Mixcloud",
    "widget.mixcloud.com":     "Mixcloud",
    "www.mixcloud.com":        "Mixcloud",
    "www.instagram.com":       null,       // an outbound link, sends nothing
    "stations-signal.andre-rafizadeh.workers.dev": "Cloudflare"
  };

  const sources = ["index.html", "assets/reps-run.js", "assets/repcount.js",
                   "assets/t.js", "assets/reps.js"]
        .filter(f => fs.existsSync(path.join(ROOT, f)))
        .map(read).join("\n");
  const hosts = [...new Set([...sources.matchAll(/https?:\/\/([a-zA-Z0-9._-]+)/g)]
        .map(m => m[1]))].filter(h => !NOT_A_REQUEST.includes(h));

  const unknown = hosts.filter(h => !(h in DISCLOSED));
  ok("no third party has appeared that the privacy page does not know about",
     unknown.length === 0,
     unknown.join(", ") + " — add it to DISCLOSED and say so on /privacy/");

  const silent = hosts.filter(h => DISCLOSED[h] && !priv.includes(DISCLOSED[h]));
  ok("and every one it reaches is actually named on the page",
     silent.length === 0, silent.join(", "));

  const TRACKERS = ["google-analytics", "googletagmanager", "gtag(", "connect.facebook.net",
                    "fbq(", "plausible.io", "posthog", "mixpanel", "segment.com",
                    "hotjar", "clarity.ms", "doubleclick"];
  const found = TRACKERS.filter(t => sources.includes(t));
  ok("and the claim of no analytics is still true", found.length === 0, found.join(", "));
}

/* ---- what the privacy page promises about the camera ---- */
console.log("\nthe camera promise");
{
  ok("the page promises video is never uploaded",
     /never recorded, never uploaded/i.test(priv));
  /* The promise is only true while the counter reads the stream and never
     sends it. If a frame ever gets posted anywhere, this is the line that
     should have stopped it. */
  const engine = fs.existsSync(path.join(ROOT,"assets/reps-run.js")) ? read("assets/reps-run.js") : "";
  const posts = /fetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|toBlob|toDataURL/.test(engine);
  ok("and the rep counter contains nothing that could send a frame", !posts,
     "reps-run.js gained a way to transmit — the privacy page now lies");
  ok("the terms repeat that the counter does not judge technique",
     /does not (assess|judge) technique/i.test(terms));
}

srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
