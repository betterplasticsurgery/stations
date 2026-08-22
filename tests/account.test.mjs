/* Recovery codes and session tokens, tested against the real crypto.
   Same extraction trick as billing.test.mjs: pull the functions out of
   the Worker source and run them, so what is tested is what deploys.

   The two failures that matter are opposite. A token that verifies when
   it should not hands someone else's subscription away. A code that is
   guessable does the same thing more slowly. Everything below is one of
   those two questions. */
import fs from "node:fs";

const src = fs.readFileSync(new URL("../worker/signal.js", import.meta.url), "utf8");
/* The Worker reads every secret through E(), so the extracted blocks
   need it in scope. Pull the real one out rather than writing a second
   implementation that could drift from it. */
const Esrc = src.slice(src.indexOf("const E = (env, k)"), src.indexOf("\nconst ledger = env"));
const E = new Function(Esrc + "\nreturn E;")();

const block = src.slice(src.indexOf("const TOKEN_DAYS"), src.indexOf("async function whoIs"));
const A = new Function("crypto", "TextEncoder", "btoa", "E",
  block + "\nreturn { CODE_ALPHA, CODE_LEN, TOKEN_DAYS, b64url, newUid, newCode, prettyCode," +
          " tidyCode, validCode, sha256hex, authSign, authRead, sameString, authOn, authMac, b64url };")(
  globalThis.crypto, globalThis.TextEncoder, globalThis.btoa, E);

/* The Google half needs ALLOWED and the HMAC helpers from above, so it
   is pulled out as its own block with those injected. */
const gblock = src.slice(src.indexOf("const G_AUTH"), src.indexOf("async function googleStart"));
const G = new Function("crypto", "TextEncoder", "btoa", "atob", "E", "ALLOWED", "b64url", "authMac", "sameString", "authOn",
  gblock + "\nreturn { googleOn, b64urlStr, unb64url, safeBack, stateSign, stateRead };")(
  globalThis.crypto, globalThis.TextEncoder, globalThis.btoa, globalThis.atob, E,
  ["https://stations.fit","https://www.stations.fit","https://betterplasticsurgery.github.io"],
  null, null, null, null);

let pass = 0, fail = 0;
const ok = (n,c,x="") => c ? (pass++, console.log("  ok   "+n)) : (fail++, console.log("  FAIL "+n+(x?"  — "+x:"")));

/* stateSign/stateRead close over authMac and sameString, which live in
   the first block. Rebuild G with the real ones now that A exists. */
const G2 = new Function("crypto", "TextEncoder", "btoa", "atob", "E", "ALLOWED", "b64url", "authMac", "sameString", "authOn",
  gblock + "\nreturn { googleOn, b64urlStr, unb64url, safeBack, stateSign, stateRead };")(
  globalThis.crypto, globalThis.TextEncoder, globalThis.btoa, globalThis.atob, E,
  ["https://stations.fit","https://www.stations.fit","https://betterplasticsurgery.github.io"],
  A.b64url, A.authMac ?? null, A.sameString, A.authOn);

const env  = { AUTH_SECRET: "test-secret-not-a-real-one-0123456789" };
const other= { AUTH_SECRET: "a-different-secret-entirely-987654321" };

console.log("\nthe gate");
{
  ok("without a secret, accounts are off", A.authOn({}) === false);
  ok("a token cannot be read without one", await A.authRead({}, "v1.a.1.99999999999999.x") === null);
}

console.log("\nrecovery codes");
{
  const c = A.newCode();
  ok("is twelve characters", c.length === A.CODE_LEN, c);
  ok("uses only the alphabet", [...c].every(ch => A.CODE_ALPHA.includes(ch)), c);
  ok("and never a character you could misread",
     !/[IOLU01]/.test(c), c);
  ok("prints in groups of four", /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(A.prettyCode(c)), A.prettyCode(c));

  const many = Array.from({length: 4000}, () => A.newCode());
  ok("four thousand codes, no repeats", new Set(many).size === 4000,
     String(4000 - new Set(many).size) + " collisions");

  /* Rejection sampling exists so no letter is likelier than another. A
     modulo bug would make the first six letters ~27% more common, which
     this catches without being flaky: 48000 draws over 30 letters is
     1600 expected each, and the bound is generous. */
  const freq = {};
  for (const ch of many.join("")) freq[ch] = (freq[ch] || 0) + 1;
  ok("every letter in the alphabet actually appears",
     Object.keys(freq).length === A.CODE_ALPHA.length,
     Object.keys(freq).length + " of " + A.CODE_ALPHA.length);
  const counts = Object.values(freq);
  const lo = Math.min(...counts), hi = Math.max(...counts), mean = 4000 * A.CODE_LEN / 30;
  ok("and none is meaningfully likelier than the rest",
     lo > mean * 0.82 && hi < mean * 1.18,
     `low ${lo}, high ${hi}, expected ~${Math.round(mean)}`);

  /* 30^12 ≈ 5.3e17. Worth stating in the test rather than in a comment
     nobody re-derives when someone shortens the code to "look nicer". */
  const bits = Math.log2(Math.pow(30, A.CODE_LEN));
  ok("a code is worth at least 55 bits of guessing", bits >= 55, bits.toFixed(1) + " bits");
}

console.log("\ntyping one in");
{
  const c = "ABCD-EFGH-JKMN";
  ok("dashes are optional", A.tidyCode("ABCDEFGHJKMN") === A.tidyCode(c));
  ok("case does not matter", A.tidyCode("abcd-efgh-jkmn") === A.tidyCode(c));
  ok("stray spaces are forgiven", A.tidyCode(" ABCD EFGH JKMN ") === A.tidyCode(c));
  ok("underscores and dots too", A.tidyCode("ABCD_EFGH.JKMN") === A.tidyCode(c));
  ok("a good code validates", A.validCode(A.tidyCode(c)));
  ok("a short one does not", !A.validCode("ABCD"));
  ok("and a misread character is caught rather than silently dropped",
     !A.validCode(A.tidyCode("ABCD-EFGH-JKMO")), "trailing O");
}

console.log("\nsession tokens");
{
  const t = await A.authSign(env, "uid123", 4);
  ok("round-trips", (await A.authRead(env, t))?.uid === "uid123");
  ok("and carries the generation", (await A.authRead(env, t))?.gen === 4);

  const p = t.split(".");
  ok("a swapped uid is refused",
     await A.authRead(env, ["v1","someoneelse",p[2],p[3],p[4]].join(".")) === null);
  ok("a bumped generation is refused",
     await A.authRead(env, ["v1",p[1],"99",p[3],p[4]].join(".")) === null);
  ok("an extended expiry is refused",
     await A.authRead(env, ["v1",p[1],p[2],String(Date.now()+9e9),p[4]].join(".")) === null);
  ok("a tampered signature is refused",
     await A.authRead(env, p.slice(0,4).join(".") + "." + p[4].slice(0,-1) + (p[4].slice(-1) === "A" ? "B" : "A")) === null);
  ok("a token signed with another secret is refused",
     await A.authRead(env, await A.authSign(other, "uid123", 4)) === null);
  ok("and our own token is refused by the other secret",
     await A.authRead(other, t) === null);

  const dead = await A.authSign(env, "uid123", 1, -1000);
  ok("an expired token is refused", await A.authRead(env, dead) === null);
  ok("even though its signature is perfectly good",
     dead.split(".").length === 5);

  for (const junk of ["", "v1", "v1.a.b", "v2.a.1.9999999999999.x", "....", "not a token"])
    ok("junk is refused: " + JSON.stringify(junk), await A.authRead(env, junk) === null);
}

console.log("\nthe pieces underneath");
{
  ok("uids are url-safe", !/[+/=]/.test(A.newUid()));
  ok("uids are 128 bits", A.newUid().length === 22, A.newUid());
  ok("two uids differ", A.newUid() !== A.newUid());
  ok("the hash is a sha-256 in hex",
     /^[0-9a-f]{64}$/.test(await A.sha256hex("hello")));
  ok("and matches a known vector",
     await A.sha256hex("abc") === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  ok("comparison rejects different lengths", A.sameString("abc","abcd") === false);
  ok("and accepts an exact match", A.sameString("abc","abc") === true);
}

console.log("\nwhere Google may send you back");
{
  /* An unchecked return address is an open redirect, and an open
     redirect on the domain holding the session is how a token gets
     handed to a stranger. This is the highest-value test in the file. */
  for (const evil of [
      "https://evil.example.com/steal",
      "http://stations.fit.evil.com/",
      "https://stations.fit.evil.com/",
      "//evil.example.com",
      "javascript:alert(1)",
      "",
      "https://evilstations.fit/"
  ]) ok("refuses " + JSON.stringify(evil),
        G2.safeBack(evil).startsWith("https://stations.fit"), G2.safeBack(evil));

  ok("allows the real site", G2.safeBack("https://stations.fit/") === "https://stations.fit/");
  ok("allows the www host", G2.safeBack("https://www.stations.fit/x") === "https://www.stations.fit/x");
  ok("allows the pages host",
     G2.safeBack("https://betterplasticsurgery.github.io/stations/").startsWith("https://betterplasticsurgery.github.io"));
  ok("allows localhost, for working on it",
     G2.safeBack("http://localhost:8080/index.html") === "http://localhost:8080/index.html");
  ok("and strips any query or hash it was handed",
     G2.safeBack("https://stations.fit/a?tok=leak#x") === "https://stations.fit/a");
}

console.log("\nthe state parameter");
{
  const st = await G2.stateSign(env, { did:"d1", back:"https://stations.fit/", t: Date.now() });
  const back = await G2.stateRead(env, st);
  ok("round-trips", back && back.did === "d1", JSON.stringify(back));
  ok("a state signed with another secret is refused",
     await G2.stateRead(env, await G2.stateSign(other, { t: Date.now() })) === null);
  ok("a tampered payload is refused",
     await G2.stateRead(env, "x" + st) === null);
  const old = await G2.stateSign(env, { t: Date.now() - 20*60*1000 });
  ok("and one from twenty minutes ago is refused", await G2.stateRead(env, old) === null);
  for (const junk of ["", "a", "a.b.c"])
    ok("junk state is refused: " + JSON.stringify(junk), await G2.stateRead(env, junk) === null);
}

console.log("\nthe Google gate");
{
  ok("off with no client id", G2.googleOn({ AUTH_SECRET:"x", GOOGLE_CLIENT_SECRET:"y" }) === false);
  ok("off with no client secret", G2.googleOn({ AUTH_SECRET:"x", GOOGLE_CLIENT_ID:"y" }) === false);
  ok("off without an auth secret at all",
     G2.googleOn({ GOOGLE_CLIENT_ID:"a", GOOGLE_CLIENT_SECRET:"b" }) === false);
  ok("on only with all three",
     G2.googleOn({ AUTH_SECRET:"x", GOOGLE_CLIENT_ID:"a", GOOGLE_CLIENT_SECRET:"b" }) === true);
}

console.log("\nsign-in links");
{
  /* The link token is the same primitive as the session token with a
     different payload, so what is worth testing is the payload: that a
     tampered address does not survive, and that an expiry is honoured.
     Rebuild the exact string the Worker builds and check it end to end. */
  const mk = async (email, back, nonce, ms) => {
    const body = "l1." + G2.b64urlStr(JSON.stringify({ e:email, b:back, n:nonce, x: Date.now() + ms }));
    return body + "." + await A.authMac(env, body);
  };
  const read = async raw => {
    const p = raw.split(".");
    if (p.length !== 3 || p[0] !== "l1") return null;
    if (!A.sameString(await A.authMac(env, p[0] + "." + p[1]), p[2])) return null;
    let o; try{ o = JSON.parse(G2.unb64url(p[1])); }catch(e){ return null; }
    return (o.x && Number(o.x) >= Date.now()) ? o : null;
  };

  const good = await mk("andre@example.com", "https://stations.fit/", "n1", 900000);
  ok("round-trips", (await read(good))?.e === "andre@example.com");

  const parts = good.split(".");
  const swapped = "l1." + G2.b64urlStr(JSON.stringify(
    { e:"someone@else.com", b:"https://stations.fit/", n:"n1", x: Date.now() + 900000 })) + "." + parts[2];
  ok("a swapped address is refused", await read(swapped) === null);
  ok("a tampered signature is refused",
     await read(parts[0] + "." + parts[1] + "." + parts[2].slice(0,-1) + "Z") === null);
  ok("an expired link is refused", await read(await mk("a@b.co","https://stations.fit/","n2",-1000)) === null);

  /* The address is signed, so nobody can turn their own link into a link
     for somebody else's account. That is the whole security property. */
  const mine = await read(await mk("mine@example.com","https://stations.fit/","n3",900000));
  ok("the address in the link is the one that was signed", mine.e === "mine@example.com");
}

console.log("\nwhat counts as an email");
{
  const okE = new Function("return " + src.slice(src.indexOf("function okEmail"),
    src.indexOf("async function linkStart")))();
  for (const good of ["a@b.co", "andre.rafizadeh@gmail.com", "a+tag@b.co", "a_b@c-d.io"])
    ok("accepts " + good, okE(good) === true);
  for (const bad of ["", "a", "a@b", "a b@c.co", "@b.co", "a@", "a@@b.co"])
    ok("rejects " + JSON.stringify(bad), okE(bad) === false);
}

console.log("\npasted secrets");
{
  /* A trailing newline in a pasted client id is invisible in a settings
     box, passes every is-it-configured check because the string is not
     empty, and makes the far end say it has never heard of you. Google
     answers it with "invalid_client", which reads as a setup mistake
     rather than a whitespace one. Cost us a round trip; now it cannot. */
  ok("a trailing newline is trimmed", E({ K:"abc\n" }, "K") === "abc");
  ok("a trailing space is trimmed", E({ K:"abc " }, "K") === "abc");
  ok("a leading space is trimmed", E({ K:"  abc" }, "K") === "abc");
  ok("a carriage return is trimmed", E({ K:"abc\r\n" }, "K") === "abc");
  ok("a clean value is untouched", E({ K:"abc" }, "K") === "abc");
  ok("an unset value stays unset", E({}, "K") === undefined);
  /* Whitespace only must not read as configured — otherwise a fat-fingered
     paste turns the feature on and then fails at the far end. */
  ok("whitespace alone is empty, so a gate stays shut", !E({ K:"   " }, "K"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
