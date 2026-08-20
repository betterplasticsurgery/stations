# Tests

```sh
cd tests
npm install          # playwright + ws, local only, never a dependency of the app
node run.mjs
```

Everything third-party is stubbed or local. The music widgets are never
loaded, and the signalling relay under test is `relay.mjs` running
in-process on a random port — the sandbox cannot reach the real ones and
the tests must stay deterministic regardless.

What it asserts, and why each one is here:

| Check | Why it exists |
|---|---|
| Zero external requests on a cold load | The offline promise. The music scripts are injected lazily and duo touches the network only when someone taps it — this is the test that keeps it true. |
| Every preset totals exactly | 45:00 and 30:00 to the second, as promised on the setup screen. |
| Every exercise has a TAG entry and an animation | A missing TAG silently becomes bodyweight-and-injury-free and is never filtered out. A missing animation is a blank frame. |
| Train together with no relay deployed | It must say so. This caught the message being written into a panel that was still hidden — a button that did nothing at all. |
| Two peers connect and share one clock | Two real `RTCPeerConnection`s in one browser, host and guest, through the local relay. |
| The guest gets the host's exact stations | The session rides in the invite; both sides must build the same timeline. |
| Both are within a second | The host's clock is authoritative and the guest corrects to it. |
| The figure is drawn on both screens | Reads pixels off the canvas, so an animation that silently fails to paint fails the test. |
| The guest's pause is refused, with a reason | One clock, one owner. |
| The mic is muted through work, open outside it | The echo rule. If this regresses, both people hear a second copy of their own mix. |

For the figure engine itself, none of this replaces rendering a contact
sheet and looking at it. Every pose bug so far was found by eye.
