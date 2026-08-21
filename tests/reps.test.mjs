/* The counting maths, fed synthetic signals. This cannot tell you
   whether pose estimation works in your living room — only whether the
   counter counts correctly once it has an honest signal. Those are two
   different failures and they need two different tests. */
import { Counter, RECIPES, REPS_FOR, recipeFor, median } from "../assets/repcount.js";
import fs from "node:fs";

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


/* ---- which exercises it claims it can count ----
   The map is the thing that decides whether the camera turns on at all,
   so a name that drifts out of the library silently turns a feature off
   for that station and nobody finds out. */
console.log("\nthe exercise map");
{
  const LIB_NAMES = JSON.parse(fs.readFileSync(new URL("./lib-names.json", import.meta.url), "utf8"));
  const strays = Object.keys(REPS_FOR).filter(n => !LIB_NAMES.includes(n));
  ok("every mapped exercise still exists in the library", strays.length === 0, strays.join(", "));
  const badRecipe = Object.entries(REPS_FOR).filter(([,id]) => !RECIPES[id]);
  ok("and every one points at a real recipe", badRecipe.length === 0, JSON.stringify(badRecipe));
  ok("holds are not countable", !recipeFor("Wall Sit") && !recipeFor("Forearm Plank") && !recipeFor("Hollow Hold"));
  ok("carries are not countable", !recipeFor("Farmer Carry") && !recipeFor("Suitcase Carry"));
  ok("machines are not countable", !recipeFor("Row — Sprint") && !recipeFor("Ski Erg") && !recipeFor("Bike — Tempo"));
  ok("an unknown name is not countable", !recipeFor("Interpretive Dance") && !recipeFor(""));
  const n = Object.keys(REPS_FOR).length;
  ok(`it claims ${n} of ${LIB_NAMES.length} — a minority, and honestly so`, n > 20 && n < LIB_NAMES.length/2, String(n));
}

/* ---- what the coach is allowed to know ----
   Two numbers, and only ever this person against themselves in one set.
   The test that matters is the one that stops it talking: a set that
   held its range must never be reported as fading. */
console.log("\ndepth and tempo");
{
  const c = run(RECIPES.squat, 12, { hz:0.5 });
  const st = c.stats();
  ok("a steady set reports a tempo", st.gap > 1500 && st.gap < 2500, String(Math.round(st.gap)));
  ok("and is not accused of fading", st.faded === false, JSON.stringify(st));
  ok("drift on a steady set sits near one", st.drift > 0.85 && st.drift < 1.15, String(st.drift));
}
/* A set that fades: honest reps, then reps a third shorter. This is what
   real fatigue looks like — not a collapse, a shortening. */
function fading(r, factor, reps = 14, hz = 0.5, fps = 30){
  const c = new Counter(r), n = Math.round((reps/hz)*fps), half = Math.round((reps/2/hz)*fps);
  for (let i = 0; i < n; i++){
    const t = i/fps;
    const amp = i < half ? r.amp : r.amp * factor;
    c.push(2.0 + (amp/2)*(Math.sin(2*Math.PI*hz*t - Math.PI/2)+1), t*1000);
  }
  return c;
}
{
  const st = fading(RECIPES.squat, 0.65).stats();
  ok("a set that shortens is caught", st.faded === true, JSON.stringify(st));
  ok("and the drift says by how much", st.drift < 0.85, String(st.drift));
}
{
  /* Below the amplitude gate the counter stops counting rather than
     counting rubbish, and that is the behaviour we want: half-depth
     squats are not squats, and a number that keeps climbing through
     them would be a lie. The visible symptom is a count that stalls. */
  const c = fading(RECIPES.squat, 0.35);
  ok("movement below the gate stops counting rather than miscounting",
     c.n <= 8, "counted " + c.n + " of 14");
  ok("and it never reports a fade it did not measure",
     c.stats().drift === null || c.stats().drift > 0.5, JSON.stringify(c.stats()));
}
{
  const st = run(RECIPES.squat, 4).stats();
  ok("four reps is too few to judge", st.drift === null && st.faded === false, JSON.stringify(st));
}
{
  const st = new Counter(RECIPES.squat).stats();
  ok("and an empty set says nothing at all", st.n === 0 && st.gap === null && st.drift === null);
}
{
  ok("median of an even list averages the middle", median([1,2,3,4]) === 2.5);
  ok("median of an odd list is the middle", median([5,1,3]) === 3);
  ok("median of nothing is null", median([]) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
