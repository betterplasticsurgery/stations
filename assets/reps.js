/* =========================================================
   Rep counting — the spike
   =========================================================
   The question this exists to answer: does counting reps from the
   phone camera work in a real room, on a real phone, at real speed?
   Not "can pose estimation run in a browser" — it can — but whether
   the number on screen matches the number you did.

   The bet: rep counting does NOT need good pose estimation. It needs
   ONE periodic signal. Depth can be noisy, a forearm can flip, the
   3D can be nonsense — none of that touches the height of your hips
   over time. Every documented weakness of browser pose estimation is
   a weakness of FORM analysis, which is why that is months away and
   this is days.

   So: pick one scalar per exercise, smooth it, and count the swings.

   THE SIGNAL IS DRAWN ON SCREEN ON PURPOSE. When the count is wrong
   the trace shows why — too small a movement, a lost limb, a jitter
   that split one rep into two. A spike you cannot debug tells you
   nothing except that it did not work.
   ========================================================= */



import { RECIPES, Counter, L } from "/assets/repcount.js";

/* ---- wiring ---- */
const $ = s => document.querySelector(s);
const video = $("#cam"), cv = $("#ov"), ctx = cv.getContext("2d");
const traceCv = $("#trace"), tctx = traceCv.getContext("2d");

let pose = null, counter = new Counter(RECIPES.squat), running = false, lastVideoTime = -1;
let recipe = RECIPES.squat, seen = 0, missing = 0;

function say(n){
  try{
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(n));
    u.rate = 1.15; speechSynthesis.speak(u);
  }catch(e){}
}

function setStatus(t, bad){
  const el = $("#status");
  el.textContent = t;
  el.classList.toggle("bad", !!bad);
}

function drawSkeleton(pts){
  ctx.clearRect(0,0,cv.width,cv.height);
  const bones = [[11,12],[11,23],[12,24],[23,24],[11,13],[13,15],[12,14],[14,16],
                 [23,25],[25,27],[24,26],[26,28]];
  ctx.strokeStyle = "#ffffffcc"; ctx.lineWidth = 3;
  for (const [a,b] of bones){
    if (!pts[a] || !pts[b]) continue;
    ctx.beginPath();
    ctx.moveTo(pts[a].x*cv.width, pts[a].y*cv.height);
    ctx.lineTo(pts[b].x*cv.width, pts[b].y*cv.height);
    ctx.stroke();
  }
  ctx.fillStyle = "#fff";
  for (const i of Object.values(L)){
    if (!pts[i]) continue;
    ctx.beginPath(); ctx.arc(pts[i].x*cv.width, pts[i].y*cv.height, 4, 0, 7); ctx.fill();
  }
}

/* The trace is the point of the spike. If the count is wrong, this
   says whether the signal was flat, noisy, or clipped. */
function drawTrace(){
  const w = traceCv.width, h = traceCv.height, t = counter.trace;
  tctx.clearRect(0,0,w,h);
  if (t.length < 2) return;
  const lo = Math.min(...t), hi = Math.max(...t), r = (hi - lo) || 1;
  const range = counter.hi - counter.lo;
  if (counter.ready){
    const y = v => h - ((v - lo)/r) * h;
    tctx.strokeStyle = "#33333a"; tctx.lineWidth = 1;
    for (const lvl of [counter.lo + range*0.68, counter.lo + range*0.32]){
      tctx.beginPath(); tctx.moveTo(0, y(lvl)); tctx.lineTo(w, y(lvl)); tctx.stroke();
    }
  }
  tctx.strokeStyle = "#fff"; tctx.lineWidth = 2; tctx.beginPath();
  t.forEach((v,i) => {
    const x = (i/(t.length-1))*w, y = h - ((v - lo)/r) * h;
    i ? tctx.lineTo(x,y) : tctx.moveTo(x,y);
  });
  tctx.stroke();
}

function loop(){
  if (!running) return;
  requestAnimationFrame(loop);
  if (!pose || video.readyState < 2) return;
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const now = performance.now();
  let res;
  try{ res = pose.detectForVideo(video, now); }catch(e){ return; }
  const pts = res && res.landmarks && res.landmarks[0];

  if (!pts){
    missing++; seen = 0;
    if (missing > 30) setStatus("Cannot see you — step back so your whole body is in frame", true);
    ctx.clearRect(0,0,cv.width,cv.height);
    return;
  }
  missing = 0; seen++;
  drawSkeleton(pts);

  let v;
  try{ v = recipe.signal(pts); }catch(e){ return; }
  if (!isFinite(v)) return;

  if (counter.push(v, now)){
    $("#count").textContent = counter.n;
    say(counter.n);
  }
  setStatus(counter.ready ? "Counting" : "Move through a full rep so I can see your range");
  drawTrace();
  $("#fps").textContent = Math.round(1000/Math.max(1, now - (loop._t||now)));
  loop._t = now;
}

async function start(){
  setStatus("Loading the model…");
  try{
    /* Loaded on demand, not at the top of the file. A static import that
       fails takes the whole module with it, so a flaky connection would
       leave a dead page with no buttons and no explanation — which is
       exactly the failure that wastes an afternoon. */
    const { FilesetResolver, PoseLandmarker } =
      await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14");
    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
    pose = await PoseLandmarker.createFromOptions(vision, {
      baseOptions:{
        modelAssetPath:"https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
        delegate:"GPU" },
      runningMode:"VIDEO", numPoses:1
    });
  }catch(e){
    setStatus("Could not load the pose model — check your connection and try again. (" +
              (e && e.message ? e.message : e) + ")", true);
    return;
  }

  setStatus("Turning the camera on…");
  let stream;
  try{
    stream = await navigator.mediaDevices.getUserMedia({
      video:{ facingMode:"user", width:{ideal:640}, height:{ideal:480} }, audio:false });
  }catch(e){ setStatus("Camera blocked: " + e.message, true); return; }

  video.srcObject = stream;
  await video.play();
  cv.width = video.videoWidth || 640; cv.height = video.videoHeight || 480;
  running = true;
  $("#go").textContent = "Stop";
  setStatus("Move through a full rep so I can see your range");
  loop();
}

function stop(){
  running = false;
  $("#go").textContent = "Start";
  const s = video.srcObject;
  if (s) s.getTracks().forEach(t => t.stop());
  video.srcObject = null;
  setStatus("Stopped");
}

$("#go").onclick = () => running ? stop() : start();
$("#reset").onclick = () => { counter.reset(); $("#count").textContent = "0"; };

document.querySelectorAll("[data-ex]").forEach(b => {
  b.onclick = () => {
    document.querySelectorAll("[data-ex]").forEach(x => x.classList.remove("on"));
    b.classList.add("on");
    recipe = RECIPES[b.dataset.ex];
    counter = new Counter(recipe);
    $("#count").textContent = "0";
    $("#hint").textContent = recipe.hint;
  };
});
$("#hint").textContent = RECIPES.squat.hint;
