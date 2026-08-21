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
    /* Per-rep depth and timing. This is the ONLY thing the coach is ever
       given, and it is deliberately a comparison of you against you in one
       set from one camera position — never an absolute claim about your
       body. A lite pose model at an unknown angle cannot tell you your
       knees are caving; it can tell you this rep covered two thirds of the
       range your first three did, and that is true regardless of how good
       the 3D is. */
    this.reps = [];  // {t, depth} in torso lengths
    this.enterLow = 0; this.swingPeak = 0;
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

    /* Nothing counts until the movement is big enough to be a rep.

       This gate is also what happens when someone fatigues badly: once
       the movement drops under half the recipe's amplitude the count
       STALLS rather than climbing through half reps. That is deliberate.
       A number that keeps rising while the reps stop being reps is worse
       than a number that stops, because the number is the only thing
       anyone will remember. Tested in tests/reps.test.mjs. */
    this.ready = range >= this.r.amp * 0.5;
    if (!this.ready) return false;

    const down = this.lo + range * 0.68;   // deep enough to be the bottom
    const up   = this.lo + range * 0.32;   // back up enough to be the top
    let counted = false;

    if (this.state === "high" && e > down){
      this.state = "low"; this.enterLow = e; this.swingPeak = e;
    } else if (this.state === "low"){
      if (e > this.swingPeak) this.swingPeak = e;
      if (e < up){
        this.state = "high";
        if (t - this.lastRep > this.r.refractory){
          this.n++; this.lastRep = t; counted = true;
          this.reps.push({ t, depth: this.swingPeak - this.enterLow });
        }
      }
    }
    return counted;
  }

  /* What a set looked like, in the two terms that survive a bad camera:
     how long a rep took, and how much of your own opening range each one
     covered. Returns nulls rather than guesses when there is not enough
     to say — a coach that comments on four reps is a coach you stop
     believing. */
  stats(){
    const n = this.n, r = this.reps;
    const out = { n, gap:null, drift:null, faded:false };
    if (r.length >= 3){
      const gaps = [];
      for (let i=1;i<r.length;i++) gaps.push(r[i].t - r[i-1].t);
      out.gap = median(gaps);
    }
    /* Six reps is the floor: three to set the standard and three to
       compare against it. Below that a single sloppy rep is the whole
       sample. */
    if (r.length >= 6){
      const first = median(r.slice(0,3).map(x => x.depth));
      const last  = median(r.slice(-3).map(x => x.depth));
      if (first > 0.05){
        out.drift = last / first;
        /* A fifth of your range is a real loss and not camera noise. */
        out.faded = out.drift < 0.78;
      }
    }
    return out;
  }
}

function median(a){
  if (!a.length) return null;
  const b = [...a].sort((x,y) => x-y), m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m-1] + b[m]) / 2;
}

/* ---- which exercises this can actually count ----
   Thirty of ninety-six. That is the honest number, and it is the reason
   the camera is armed per station rather than left running: on most
   stations there is nothing here to do, and a phone that spends
   forty-five minutes doing pose estimation for five of them is a phone
   that gets hot for no reason.

   Everything here moves one body part through a large, repeatable arc
   that a camera on the floor can see. Deliberately absent: holds (a wall
   sit has no reps), carries, machines, anything where the signal is a
   wrist travelling in a small circle, and anything that leaves frame. */
const REPS_FOR = {
  /* hip height rises and falls */
  "Air Squat":"squat", "Jump Squat":"squat", "Goblet Squat":"squat",
  "DB Front Squat":"squat", "Split Squat":"squat", "Reverse Lunge":"squat",
  "DB Reverse Lunge":"squat", "Lateral Lunge":"squat", "Cossack Squat":"squat",
  "Goblet Cossack Squat":"squat", "Step-Up":"squat", "DB Step-Up":"squat",
  "DB Walking Lunge":"squat", "DB Thruster":"squat", "DB Sumo Deadlift":"squat",
  /* shoulder height rises and falls */
  "Push-Up":"pushup", "Incline Push-Up":"pushup", "Decline Push-Up":"pushup",
  "Diamond Push-Up":"pushup", "Plyo Push-Up":"pushup", "Pike Push-Up":"pushup",
  "Bench Dip":"pushup",
  /* hands come together and apart */
  "Jumping Jack":"jack", "Star Jump":"jack",
  /* the whole body goes to the floor and back */
  "Burpee":"burpee", "Squat Thrust":"burpee", "Sprawl":"burpee",
  "Devil Press":"burpee", "Man Maker":"burpee", "DB Burpee Deadlift":"burpee"
};

/* The recipe for an exercise, or null when there is nothing to count. */
function recipeFor(name){
  const id = REPS_FOR[name];
  return id ? RECIPES[id] : null;
}


export { L, RECIPES, REPS_FOR, Counter, recipeFor, median, mid, dist, torso };
