# Turning accounts on

One secret. Until it exists every `/account/*` route answers "accounts are
not set up yet", the app's Your access section says so plainly, and
everything else works exactly as it does now — access just stays on the
browser it was bought in, as it does today.

## The secret

Generate it yourself. It must never appear in the repo, in a chat, or in
anything I can see:

    openssl rand -hex 32

Workers & Pages → **stations-signal** → Settings → Variables and secrets →
type **Secret**:

| Name | Value |
|---|---|
| `AUTH_SECRET` | the 64 hex characters from that command |

**Changing it later signs everybody out.** Every session token is an HMAC
over this secret, so rotating it invalidates all of them at once. Their
recovery codes still work, because those are hashed separately — so the
blast radius of a rotation is "everyone types their code again", not
"everyone loses their subscription". Do it if you ever think the secret
leaked, and not otherwise.

## What an account is

A uid, a generation number, and one recovery code. No password and no
email, because neither buys anything yet: a password is a thing to store,
leak and reset, and email needs a mail provider that does not exist.

- The **recovery code** is twelve characters from a thirty-letter
  alphabet with no I, O, L, U, 0 or 1 — about sixty bits, and nothing in
  it can be misread off a phone screen. It is shown **once**. The server
  keeps only a SHA-256 of it, so nobody, you included, can look one up.
- The **token** is `v1.<uid>.<gen>.<expiry>.<signature>`, signed with
  `AUTH_SECRET` and good for 180 days. Checking one is arithmetic, not a
  database read.
- The **generation** is the escape hatch. Asking for a new recovery code
  bumps it, which stops every token ever minted for that account from
  verifying. That is what "I lost my phone" has to mean.

## What happens to the people who already paid

Nothing, until they choose. `trials` and `subs` gained a nullable `uid`
column rather than being rebuilt, so every existing row keeps working
exactly as it did. The first time a device makes an account or redeems a
code, its rows are claimed by that account.

Free sessions count per account, using the **highest** count across its
devices — so signing in on a second phone neither hands out three more
free calls nor retroactively spends any.

## Where the code is handed over

Automatically, the moment a subscription is confirmed, on the same screen
as the confirmation. That is the only moment worth interrupting for: they
have just paid, and until they save a code their purchase is attached to a
string in one browser's local storage. Free users are never asked — nobody
writes down a code to protect nothing.

## Test it before you rely on it

With `AUTH_SECRET` set, in your own browser:

1. Subscribe with a Stripe test card. Confirm a code appears with the
   confirmation, and copy it.
2. Open a private window. Confirm it has no subscription.
3. Settings → Your access → paste the code. Confirm it says the
   subscription came with it, and that Train together is unlocked.
4. Back in the first window, ask for a new recovery code. Confirm the
   private window loses access on its next check — that is the generation
   bump working.

## What is not here yet

Magic-link email sign-in. It is the same account, reached a second way,
and it needs a mail provider (Resend) with the domain verified before it
can exist. When that lands, `email` on the accounts table is already
waiting for it, and a code and a link will both get you into the same
account.

Until then: **the code is the only way back in.** That is stated on
/terms/, and it should stay stated there.
