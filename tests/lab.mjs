import { chromium } from "playwright";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MIME={".html":"text/html",".css":"text/css",".js":"text/javascript",".mjs":"text/javascript"};
const s=http.createServer((q,r)=>{let p0=q.url.split("?")[0];let f=path.join(ROOT,p0==="/"?"/index.html":p0);
 if(fs.existsSync(f)&&fs.statSync(f).isDirectory())f=path.join(f,"index.html");
 if(!fs.existsSync(f)){r.writeHead(404);return r.end();}
 r.writeHead(200,{"Content-Type":MIME[path.extname(f)]||"text/plain"});r.end(fs.readFileSync(f));});
await new Promise(r=>s.listen(0,"127.0.0.1",r));
const b=await chromium.launch({executablePath:process.env.CHROME_PATH,
  args:["--no-sandbox","--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"]});
const ctx=await b.newContext({permissions:["camera"]}); const p=await ctx.newPage();
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
await p.goto(`http://127.0.0.1:${s.address().port}/lab/reps/`,{waitUntil:"networkidle"});
let pass=0,fail=0; const ok=(n,c,x="")=>c?(pass++,console.log("  ok   "+n)):(fail++,console.log("  FAIL "+n+(x?"  — "+x:"")));
console.log("\nthe lab page");
ok("loads with no page errors", errs.length===0, errs.join(" | "));
ok("the exercise picker is wired",
   await p.evaluate(()=>document.querySelectorAll("[data-ex]").length===4));
const hint0 = await p.textContent("#hint");
await p.click('[data-ex="jack"]');
const hint1 = await p.textContent("#hint");
ok("switching exercise changes the guidance", hint0!==hint1 && hint1.length>10, hint1);
ok("and marks the new one active",
   await p.evaluate(()=>document.querySelector('[data-ex="jack"]').classList.contains("on")));
/* the CDN is unreachable from this sandbox — a good stand-in for a bad connection */
await p.click("#go");
await p.waitForFunction(()=>/could not load|camera/i.test(document.querySelector("#status").textContent),
                        null,{timeout:20000}).catch(()=>{});
const st = await p.textContent("#status");
ok("a model that will not load says so instead of dying silently",
   /could not load/i.test(st), st.slice(0,90));
ok("the page is still interactive afterwards",
   await p.evaluate(()=>{document.querySelector('[data-ex="squat"]').click();
     return document.querySelector('[data-ex="squat"]').classList.contains("on");}));
ok("it is marked noindex — an experiment should not rank",
   await p.evaluate(()=>!!document.querySelector('meta[name="robots"][content*="noindex"]')));
console.log(`\n${pass} passed, ${fail} failed`);
await b.close(); s.close(); process.exit(fail?1:0);
