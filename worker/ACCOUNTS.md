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

## Sign in with Google

The fastest real account, and the only one that needs no mail provider.
Two secrets and one redirect URI.

### 1. Make the OAuth client

[console.cloud.google.com](https://console.cloud.google.com) → create a
project (call it STATIONS) → **APIs & Services → OAuth consent screen**.

- User type: **External**, then **Publish app**. Left in Testing it only
  works for accounts you list by hand, and it shows an unverified-app
  warning.
- App name: STATIONS. Support email: yours.
- **Homepage** `https://stations.fit`, **Privacy policy**
  `https://stations.fit/privacy/`, **Terms of service**
  `https://stations.fit/terms/`. Google requires these and now you have
  them.
- Scopes: `openid`, `email`, `profile`. **Add nothing else.** These are
  non-sensitive, which is what keeps you out of the verification review
  and away from the hundred-user cap. The moment you add a scope that
  touches someone's Gmail or Calendar, that changes.

Then **Credentials → Create credentials → OAuth client ID → Web
application**:

| Field | Value |
|---|---|
| Authorised JavaScript origins | `https://stations.fit` |
| Authorised redirect URIs | `https://stations-signal.andre-rafizadeh.workers.dev/account/google/callback` |

The redirect URI must match **exactly** — scheme, host, path, no
trailing slash. A mismatch is the single commonest failure and Google
says so plainly in the error.

### 2. The two secrets

Same Cloudflare page as `AUTH_SECRET`, both type **Secret**:

| Name | Where it comes from |
|---|---|
| `GOOGLE_CLIENT_ID` | the client id, ends `.apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | the client secret next to it |

Without both, `/account/google/start` redirects straight back saying
Google sign-in is not set up, and the button does not appear at all.

### What signing in actually does

1. The button sends them to Google with a signed `state` carrying their
   device id and where to return. The return address is checked against
   the allow-list — an open redirect here would hand a session token to
   whoever asked for it.
2. Google sends them back with a code. The relay swaps it for an ID
   token over TLS using the client secret.
3. The claims that matter are checked: `aud` is this client, `iss` is
   Google, `exp` is in the future, the email is verified.
4. The account is found by Google's `sub` — never by email, because an
   address can change hands and a `sub` never does.
5. They come back to the site with a session token in the hash, which
   the app stores and scrubs out of the address bar.

### Which account they land on

In this order, and the order is the policy:

1. **That Google identity already has an account** → sign in to it.
2. **They are already signed in with a recovery code** → Google gets
   attached to that account, so the two paths converge rather than
   leaving somebody with two accounts and one subscription.
3. **Neither** → a new account, and this device's history comes with it.

## What is not here yet

Magic-link email sign-in. It is the same account, reached a second way,
and it needs a mail provider (Resend) with the domain verified before it
can exist. When that lands, `email` on the accounts table is already
waiting for it, and a code and a link will both get you into the same
account.

Until then: **the code is the only way back in.** That is stated on
/terms/, and it should stay stated there.
