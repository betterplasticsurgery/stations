/* =========================================================
   Rep counting, inside a real session
   =========================================================
   The lab page answered "can this count?". This answers the harder
   question: what does it cost to leave it on for forty-five minutes,
   and the answer is that you must not.

   So the camera is armed per station. It opens a few seconds before a
   station this can actually count, runs for that work interval, and
   shuts off again — sensor and inference both. On a nine-station half
   with two countable stations that is a duty cycle near fifteen per
   cent instead of a hundred, which is the difference between a warm
   phone and a phone that throttles halfway through.

   Nothing in here is allowed to throw into the run loop. A rep counter
   that stops a workout is worse than no rep counter.
   ========================================================= */

import { RECIPES, Counter, recipeFor } from "./repcount.js";

const CDN   = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
const MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/" +
              "pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

/* 22Hz. A rep takes the better part of a second, so this is fifteen-odd
   samples through the shortest movement here, and it halves the work
   against a 45fps camera for nothing lost. */
const STEP_MS = 45;

let pose = null, video = null, stream = null, owned = false;
let counter = null, recipe = null, running = false;
let hooks = { count:()=>{}, state:()=>{} }, getStream = null;
let lastVideoTime = -1, lastRun = 0, missing = 0, raf = 0;

function state(k, extra){ try{ hooks.state(k, extra); }catch(e){} }

/* ---- one-time setup ---- */

export function init(opts){
  video    = opts.video;
  hooks    = { count: opts.onCount || (()=>{}), state: opts.onState || (()=>{}) };
  getStream = opts.getStream || null;
}

/* Can this exercise be counted at all? Pure, and safe to call every
   segment — this is what decides whether the camera turns on. */
export function countable(name){ return !!recipeFor(name); }

/* The model is fetched on demand and never at boot: the app's promise is
   that the timer works with the wifi off, and a static import would make
   a pose model a dependency of the clock. */
export async function load(){
  if (pose) return true;
  try{
    state("loading");
    const { FilesetResolver, PoseLandmarker } = await import(CDN);
    const vision = await FilesetResolver.forVisionTasks(CDN + "/wasm");
    pose = await PoseLandmarker.createFromOptions({
      baseOptions:{ modelAssetPath:MODEL, delegate:"GPU" },
      runningMode:"VIDEO", numPoses:1
    }, vision).catch(async () =>
      /* Older builds take (vision, options). Try both rather than fail. */
      PoseLandmarker.createFromOptions(vision, {
        baseOptions:{ modelAssetPath:MODEL, delegate:"GPU" },
        runningMode:"VIDEO", numPoses:1 }));
    return true;
  }catch(e){
    pose = null;
    state("nomodel", e && e.message);
    return false;
  }
}

/* ---- the camera ----
   In a duo call the stream already exists and belongs to the call. Taking
   a second one would double the battery cost and, on some phones, simply
   fail. Borrow it, and never stop a track we did not open. */
async function openCam(){
  if (stream) return true;
  try{
    const borrowed = getStream && getStream();
    if (borrowed && borrowed.getVideoTracks().length){
      stream = borrowed; owned = false;
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        video:{ facingMode:"user", width:{ideal:640}, height:{ideal:480} }, audio:false });
      owned = true;
    }
    video.srcObject = stream;
    await video.play().catch(()=>{});
    return true;
  }catch(e){
    stream = null;
    state("nocam", e && e.message);
    return false;
  }
}

function closeCam(){
  if (stream && owned) { try{ stream.getTracks().forEach(t => t.stop()); }catch(e){} }
  stream = null; owned = false;
  try{ video.srcObject = null; }catch(e){}
}

/* Called during the rest before a countable station, so the sensor is
   warm and the first rep is not the one that gets missed. */
export async function warm(){
  if (!pose && !(await load())) return false;
  return openCam();
}

/* ---- arming ---- */

export async function arm(name){
  const r = recipeFor(name);
  if (!r) return false;
  if (!(await warm())) return false;
  recipe = r; counter = new Counter(r);
  lastVideoTime = -1; missing = 0; running = true;
  state("armed", r.hint);
  cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
  return true;
}

/* Returns what the set looked like, and shuts everything down. The caller
   decides whether any of it is worth saying out loud. */
export function disarm(keepCam){
  running = false;
  cancelAnimationFrame(raf); raf = 0;
  const out = counter ? { ...counter.stats(), hint:recipe && recipe.hint } : null;
  if (!keepCam) closeCam();
  state("idle");
  return out;
}

export function stop(){ running = false; cancelAnimationFrame(raf); raf = 0; closeCam(); state("off"); }
export function armed(){ return running; }
export function count(){ return counter ? counter.n : 0; }

/* ---- the loop ---- */

function loop(){
  if (!running) return;
  raf = requestAnimationFrame(loop);
  if (!pose || !video || video.readyState < 2) return;

  const now = performance.now();
  if (now - lastRun < STEP_MS) return;
  if (video.currentTime === lastVideoTime) return;
  lastRun = now; lastVideoTime = video.currentTime;

  let res;
  try{ res = pose.detectForVideo(video, now); }catch(e){ return; }
  const pts = res && res.landmarks && res.landmarks[0];

  if (!pts){
    /* Roughly a second and a half of nobody there. Said once, not every
       frame — the whole point of the camera is that it does not nag. */
    if (++missing === 34) state("lost", recipe && recipe.hint);
    return;
  }
  if (missing >= 34) state("armed", recipe && recipe.hint);
  missing = 0;

  let v;
  try{ v = recipe.signal(pts); }catch(e){ return; }
  if (!isFinite(v)) return;

  if (counter.push(v, now)){
    try{ hooks.count(counter.n); }catch(e){}
  } else if (!counter.ready && counter.n === 0){
    state("range");
  }
}

export { RECIPES };
