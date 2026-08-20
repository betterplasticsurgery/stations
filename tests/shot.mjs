import { chromium } from "playwright";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MIME={".html":"text/html",".css":"text/css",".js":"text/javascript",".png":"image/png",".xml":"application/xml"};
const s = http.createServer((q,r)=>{
  let p0=q.url.split("?")[0]; let f=path.join(ROOT,p0==="/"?"/index.html":p0);
  if (fs.existsSync(f)&&fs.statSync(f).isDirectory()) f=path.join(f,"index.html");
  if(!fs.existsSync(f)){r.writeHead(404);return r.end();}
  r.writeHead(200,{"Content-Type":MIME[path.extname(f)]||"text/plain"}); r.end(fs.readFileSync(f));
});
await new Promise(r=>s.listen(8123,"127.0.0.1",r));
const b = await chromium.launch({ executablePath:process.env.CHROME_PATH, args:["--no-sandbox"] });
const ctx = await b.newContext({ viewport:{width:414,height:896}, deviceScaleFactor:2 });
const p = await ctx.newPage();
await p.goto("http://127.0.0.1:8123/"); await p.waitForTimeout(4000);
await p.screenshot({ path:"/tmp/shot-home.png" });
await p.goto("http://127.0.0.1:8123/tabata-timer/"); await p.waitForTimeout(600);
await p.screenshot({ path:"/tmp/shot-tabata.png" });
await b.close(); s.close();
console.log("shots done");
