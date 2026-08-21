/* =========================================================
   Rep counting — the maths, with nothing attached
   =========================================================
   Deliberately separate from the camera. When a count comes out
   wrong you need to know whether the algorithm miscounted a clean
   signal or the camera handed it a bad one, and you cannot answer
   that if the two are welded together. This half is tested against
   synthetic signals in tests/; the other half needs a room, a phone
   and a person.
   ========================================================= */

/* BlazePose's 33 landmarks, the handful worth naming */
const L = { shoulderL:11, shoulderR:12, wristL:15, wristR:16,
            hipL:23, hipR:24, kneeL:25, kneeR:26, ankleL:27, ankleR:28 };

const mid = (p, a, b) => ({ x:(p[a].x + p[b].x)/2, y:(p[a].y + p[b].y)/2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* Scale everything by torso length so the count does not change when
   you stand closer to the phone. */
function torso(p){
  return Math.max(0.05, dist(mid(p, L.shoulderL, L.shoulderR), mid(p, L.hipL, L.hipR)));
}

/* ---- the recipes ----
   This is the whole extensibility argument. A new exercise is a signal
   and three numbers, not a new model. `amp` is how much of a torso
   length the movement must cover before it counts as real, which is
   what stops fidgeting registering as reps. */
const RECIPES = {
  squat: {
    name:"Squat", amp:0.55, refractory:420,
    hint:"Face the phone or stand side-on. Whole body in frame.",
    signal: p => mid(p, L.hipL, L.hipR).y / torso(p)      // hips drop = value rises
  },
  pushup: {
    name:"Push-up", amp:0.40, refractory:420,
    hint:"Phone on the floor, side-on to you, a couple of metres back.",
    signal: p => mid(p, L.shoulderL, L.shoulderR).y / torso(p)
  },
  jack: {
    name:"Jumping jack", amp:0.90, refractory:300,
    hint:"Face the phone, far enough back that your hands stay in frame.",
    signal: p => -dist(p[L.wristL], p[L.wristR]) / torso(p)   // hands apart = value falls
  },
  burpee: {
    name:"Burpee", amp:1.30, refractory:700,
    hint:"Side-on, phone low, whole body in frame at the bottom.",
    signal: p => mid(p, L.hipL, L.hipR).y / torso(p)
  }
};

/* ---- the counter ----
   A two-state machine with hysteresis. The thresholds float with the
   range actually observed, so it adapts to how deep this person
   happens to squat rather than to a number I guessed. */
class Counter {
  constructor(recipe){
    this.r = recipe; this.reset();
  }
  reset(){
    this.n = 0; this.ema = null; this.lo = Infinity; this.hi = -Infinity;
    this.state = "high"; this.lastRep = 0; this.trace = []; this.ready = false;
  }
  push(v, t){
    this.ema = this.ema == null ? v : this.ema * 0.65 + v * 0.35;
    const e = this.ema;

    /* Decay the observed range so a single wild frame does not set the
       scale for the rest of the set. */
    this.lo = Math.min(e, this.lo + 0.0006);
    this.hi = Math.max(e, this.hi - 0.0006);
    const range = this.hi - this.lo;

    this.trace.push(e);
    if (this.trace.length > 240) this.trace.shift();

    /* Nothing counts until the movement is big enough to be a rep. */
    this.ready = range >= this.r.amp * 0.5;
    if (!this.ready) return false;

    const down = this.lo + range * 0.68;   // deep enough to be the bottom
    const up   = this.lo + range * 0.32;   // back up enough to be the top
    let counted = false;

    if (this.state === "high" && e > down){
      this.state = "low";
    } else if (this.state === "low" && e < up){
      this.state = "high";
      if (t - this.lastRep > this.r.refractory){
        this.n++; this.lastRep = t; counted = true;
      }
    }
    return counted;
  }
}


export { L, RECIPES, Counter, mid, dist, torso };
