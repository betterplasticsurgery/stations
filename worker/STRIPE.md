# Turning billing on

Nothing here charges anyone until three secrets exist. Until then the
wall collects an email exactly as it does now, and the Subscribe button
does not appear at all. A half-finished setup cannot take money.

## 1. Make the price in Stripe

Stripe dashboard → **Product catalogue** → add a product.

- Name it something a customer will recognise on a bank statement —
  "STATIONS — Train together" rather than "subscription".
- Add a **recurring** price. Monthly, in your currency.
- Copy the **price ID** — it starts `price_`.

**The number lives in Stripe, not in the code.** The app asks the relay
what a subscription costs and the relay asks Stripe. Change the price in
the dashboard and the wall follows. There is no price hardcoded
anywhere to go stale, and `DUO_PRICE` in `index.html` stays empty.

## 2. Add the secrets

Workers & Pages → **stations-signal** → Settings → Variables and
secrets. Type **Secret** for all three.

| Name | Where it comes from |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys → **secret** key (`sk_live_…`) |
| `STRIPE_PRICE_ID` | the price you just made (`price_…`) |
| `STRIPE_WEBHOOK_SECRET` | step 3 gives you this (`whsec_…`) |

The secret key is the one that can move money. It only ever exists in
Stripe and in that box — never in the repo, never in a chat.

## 3. Add the webhook

Stripe → Developers → **Webhooks** → add endpoint.

- URL: `https://stations-signal.andre-rafizadeh.workers.dev/stripe/webhook`
- Events: `customer.subscription.deleted`, `customer.subscription.updated`,
  `customer.subscription.paused`
- Copy the **signing secret** into `STRIPE_WEBHOOK_SECRET`.

This is what ends a subscription when someone cancels or their card
fails. Without it people who stop paying keep their access.

**The signature check is not optional.** Without a verified signature
this URL is one anyone can POST to in order to hand themselves a
subscription. It is checked with HMAC-SHA256 and a five-minute window
so a captured request cannot be replayed, and it is tested in
`tests/billing.test.mjs` against real HMACs.

## 4. Test with test keys first

Use `sk_test_…`, a test price and a test webhook. Stripe's test card is
`4242 4242 4242 4242`, any future expiry, any CVC. Run one purchase end
to end, confirm the wall unlocks, then cancel it in the dashboard and
confirm access goes away. Only then swap in the live keys.

## What entitlement is tied to — read this before selling a year

A subscription binds to the **device id in localStorage**, not to an
account, because there are no accounts yet. So:

- Clearing site data loses access. Stripe still has the customer and
  their email, so it can be restored by hand, but only by hand.
- A second phone does not inherit it.

That is survivable for early monthly subscribers and **not** something
to sell an annual plan on. The magic-link account is what fixes it, and
it should land before anyone pays for twelve months up front.

## What happens if Stripe is unreachable

`/price` failing hides the Subscribe button and the wall reverts to
collecting an email. `/activate` failing tells the customer plainly that
they may have been charged and where to write. Nothing about a payment
outage can block a workout — the trial check already fails open.
