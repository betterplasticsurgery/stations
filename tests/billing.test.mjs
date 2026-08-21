/* The webhook signature check, tested against real HMACs.
   This is the highest-value test in the file: an endpoint that does not
   verify Stripe's signature is a URL anyone can POST to in order to
   grant themselves a subscription. */
import crypto from "node:crypto";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../worker/signal.js", import.meta.url), "utf8");
const fn = src.slice(src.indexOf("async function stripeVerify"));
const stripeVerify = new Function("crypto", "TextEncoder",
  "return " + fn.slice(0, fn.indexOf("\nasync function stripeWebhook")))(
  globalThis.crypto, globalThis.TextEncoder);

let pass = 0, fail = 0;
const ok = (n,c,x="") => c ? (pass++, console.log("  ok   "+n)) : (fail++, console.log("  FAIL "+n+(x?"  — "+x:"")));

const SECRET = "whsec_test_only_not_a_real_secret";
const env = { STRIPE_WEBHOOK_SECRET: SECRET };
const sign = (payload, t, secret = SECRET) =>
  crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");

const body = JSON.stringify({ type:"customer.subscription.deleted", data:{ object:{ id:"sub_1" } } });
const now = Math.floor(Date.now()/1000);

console.log("\nwebhook signatures");
ok("a correctly signed request is accepted",
   await stripeVerify(env, body, `t=${now},v1=${sign(body, now)}`));
ok("a wrong signature is refused",
   !await stripeVerify(env, body, `t=${now},v1=${"0".repeat(64)}`));
ok("a signature from a different secret is refused",
   !await stripeVerify(env, body, `t=${now},v1=${sign(body, now, "whsec_someone_else")}`));
ok("a tampered body is refused",
   !await stripeVerify(env, body.replace("sub_1","sub_2"), `t=${now},v1=${sign(body, now)}`));
{
  /* replay protection: a valid signature from an hour ago is still a
     valid signature, which is exactly why the timestamp is checked */
  const old = now - 3600;
  ok("a replayed request from an hour ago is refused",
     !await stripeVerify(env, body, `t=${old},v1=${sign(body, old)}`));
  const fresh = now - 120;
  ok("but two minutes of clock drift is tolerated",
     await stripeVerify(env, body, `t=${fresh},v1=${sign(body, fresh)}`));
}
ok("a missing header is refused", !await stripeVerify(env, body, null));
ok("a malformed header is refused", !await stripeVerify(env, body, "garbage"));
ok("no configured secret means nothing is accepted",
   !await stripeVerify({}, body, `t=${now},v1=${sign(body, now)}`));

console.log("\nconfiguration gates");
{
  const gate = new Function("return " + src.slice(src.indexOf("function stripeOn"),
                                                  src.indexOf("async function stripeCall")))();
  ok("billing is off with no keys", !gate({}));
  ok("off with only a secret key", !gate({ STRIPE_SECRET_KEY:"sk_test" }));
  ok("off with only a price", !gate({ STRIPE_PRICE_ID:"price_1" }));
  ok("on only with both", !!gate({ STRIPE_SECRET_KEY:"sk_test", STRIPE_PRICE_ID:"price_1" }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
