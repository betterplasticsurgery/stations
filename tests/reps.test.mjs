/* The counting maths, fed synthetic signals. This cannot tell you
   whether pose estimation works in your living room — only whether the
   counter counts correctly once it has an honest signal. Those are two
   different failures and they need two different tests. */
import { Counter, RECIPES } from "../assets/repcount.js";

let pass = 0, fail = 0;
const ok = (n,c,x="") => c ? (pass++, console.log("  ok   "+n)) : (fail++, console.log("  FAIL "+n+(x?"  — "+x:"")));

/* one rep = one full down-and-up of `amp` torso-lengths, at `hz` reps/sec */
function run(recipe, reps, { amp = recipe.amp, hz = 0.5, noise = 0, fps = 30, drift = 0 } = {}){
  const c = new Counter(recipe);
  const frames = Math.round((reps / hz) * fps);
  for (let i = 0; i < frames; i++){
    const t = i / fps;
    const phase = Math.sin(2*Math.PI*hz*t - Math.PI/2);      // starts at the top
    let v = 2.0 + (amp/2) * (phase + 1) + drift * t;
    if (noise) v += (Math.sin(i*12.9898)*43758.5453 % 1) * noise;
    c.push(v, t*1000);
  }
  return c;
}

console.log("\ncounting a clean signal");
for (const [key, r] of Object.entries(RECIPES)){
  const c = run(r, 12);
  /* the first rep is spent learning the range, so one short is correct */
  ok(`${r.name}: counts 12 reps (got ${c.n})`, Math.abs(c.n - 12) <= 1, `${c.n}`);
}

console.log("\nthings that should not count");
{
  const c = run(RECIPES.squat, 12, { amp: RECIPES.squat.amp * 0.15 });
  ok("small fidgeting does not register as reps", c.n === 0, `${c.n} counted`);
}
{
  const c = new Counter(RECIPES.squat);
  for (let i = 0; i < 300; i++) c.push(2.0, i*33);           // dead still
  ok("standing still counts nothing", c.n === 0, `${c.n} counted`);
  ok("and it says it has not found a range yet", c.ready === false);
}
{
  /* two reps crammed inside the refractory window must not double-count */
  const c = run(RECIPES.burpee, 10, { hz: 4 });
  ok("impossibly fast movement is rate-limited", c.n < 10, `${c.n} from a 4Hz signal`);
}

console.log("\nrobustness");
{
  const c = run(RECIPES.squat, 12, { noise: 0.05 });
  ok("survives a noisy signal", Math.abs(c.n - 12) <= 2, `${c.n}`);
}
{
  /* someone drifting closer to the camera as they go */
  const c = run(RECIPES.squat, 12, { drift: 0.02 });
  ok("survives the baseline drifting", Math.abs(c.n - 12) <= 2, `${c.n}`);
}
{
  const shallow = run(RECIPES.squat, 12, { amp: RECIPES.squat.amp * 0.7 });
  ok("counts a shallower-than-average rep too", Math.abs(shallow.n - 12) <= 2, `${shallow.n}`);
}
{
  const c = run(RECIPES.squat, 12);
  c.reset();
  ok("reset clears the count", c.n === 0 && c.trace.length === 0);
}

console.log("\nthe recipes are what makes this extensible");
{
  const keys = Object.keys(RECIPES);
  ok("four movements ship", keys.length === 4, keys.join(", "));
  ok("each is only a signal and three numbers",
     keys.every(k => typeof RECIPES[k].signal === "function"
                  && typeof RECIPES[k].amp === "number"
                  && typeof RECIPES[k].refractory === "number"
                  && typeof RECIPES[k].hint === "string"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
