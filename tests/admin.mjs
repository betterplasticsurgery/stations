/* The dashboard: does the key actually gate it, and does it show what
   arrived. The real page is rendered by the Worker; this checks the
   contract the app and the browser depend on. */
import { chromium } from "playwright";
import { startRelay } from "./relay.mjs";
const relay = await startRelay();
const R = `http://127.0.0.1:${relay.port}`;
let pass=0, fail=0;
const ok=(n,c,x="")=>c?(pass++,console.log("  ok   "+n)):(fail++,console.log("  FAIL "+n+(x?"  — "+x:"")));

console.log("\nthe waiting-list dashboard");
{
  const wrong = await fetch(`${R}/admin?key=nope`);
  ok("a wrong key gets a 404, not a hint", wrong.status === 404, String(wrong.status));
  const none = await fetch(`${R}/admin`);
  ok("and no key at all is the same", none.status === 404, String(none.status));
}
{
  const r = await fetch(`${R}/admin?key=test-admin-key`);
  ok("the right key opens it", r.status === 200);
  const html = await r.text();
  ok("an empty list says so plainly", /nobody yet/i.test(html), html.slice(0,120));
  ok("it is noindex", /robots.*noindex/i.test(html));
}
{
  await fetch(`${R}/interest`, { method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({ email:"someone@example.com", did:"abc" }) });
  const html = await (await fetch(`${R}/admin?key=test-admin-key`)).text();
  ok("a signup shows up on the page", html.includes("someone@example.com"));
  ok("and the count moves", /<div class="n">1<\/div>/.test(html), html.match(/class="n">\d+/)?.[0]);
}
{
  /* the browser has to be able to actually read it */
  const b = await chromium.launch({ executablePath:process.env.CHROME_PATH, args:["--no-sandbox"] });
  const p = await (await b.newContext()).newPage();
  const errs=[]; p.on("pageerror",e=>errs.push(e.message));
  await p.goto(`${R}/admin?key=test-admin-key`);
  ok("it renders in a browser without errors", errs.length===0, errs.join(" | "));
  ok("and offers the CSV", await p.evaluate(()=>!!document.querySelector('a[href*="export"]')));
  await b.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
await relay.close();
process.exit(fail?1:0);
