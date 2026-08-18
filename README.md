# STATIONS — hosted build

The public version. **Nobody signs into anything** — not you, not your users.
No API keys, no OAuth, no developer accounts, no approval process.

## Deploying

1. Create a public GitHub repo (`stations`).
2. Upload `index.html` to the root. Don't rename it.
3. **Settings → Pages → Deploy from a branch →** `main` / `(root)`. Save.
4. A minute later it's live at `https://YOUR-USERNAME.github.io/stations/`.

That's the whole setup. To put it on your own domain, add a `CNAME` file
containing `stations.fit` (or `app.stations.fit`) and point the DNS at GitHub.

## How the music works

Paste a **SoundCloud** or **Mixcloud** link. The app figures out which it is and
behaves differently, because the two platforms are good at different things.

**SoundCloud playlist → a new track at every station.** The widget API exposes
`getSounds`, `skip` and `seekTo`, so the app jumps to a different track for each
station and drops in partway through — 35% by default, which lands you past the
intro. Shuffle is on by default. This is the punchy, one-song-per-station format.

**Mixcloud mix → one continuous DJ set.** A mix is a single audio file, so there
are no tracks to skip between; it just plays underneath the whole session, which
is what a gym actually does. If the uploader added a tracklist, the app reads it
and shows the real artist and title as each track comes around, and can start
each half on a track change rather than mid-phrase.

Either way the music pauses when you pause the timer and resumes with it, and the
🎵 button in the top bar mutes it without stopping the workout.

## Why not Spotify

Spotify closed public API access to new developers on 15 May 2025. Extended quota
mode — the thing you need for arbitrary users to connect their accounts — now
requires a registered business entity, a launched service, and **250,000 monthly
active users**. Individuals can't apply at all. You'd need 250k users to get the
access that would let you have more than five.

Development mode still works for the owner plus a handful of allowlisted accounts,
but it cannot become a product. SoundCloud and Mixcloud need none of that.

## Known limits

- **The player has to stay visible.** Both SoundCloud and Mixcloud require a
  visible widget for their JS API to work, so there's a slim player bar pinned to
  the bottom of the screen. It is not decorative and it can't be hidden.
- **Free accounts may hear ads** on either platform. Nothing can be done about
  this — suppressing them would breach both platforms' terms.
- **Mixcloud tracklists are uploader-supplied.** Plenty of mixes don't have one.
  The app degrades to showing the mix title.
- **Links rot.** Uploads get deleted and embedding gets disabled. The app reports
  the failure and the workout carries on regardless — music never blocks the timer.
- **The phone has to stay awake** with the app in front. The app holds a screen
  wake lock, but backgrounding the browser will stop playback.
