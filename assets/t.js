/* The timer that runs on the landing pages.
   Deliberately separate from index.html: the app stays one self-contained
   file that works offline, and these marketing pages share one copy of a
   much simpler timer rather than carrying three that drift apart.

   Config comes off the container's data- attributes, so each page is a
   different preset of the same code. */
(function(){
  "use strict";
  const el = document.getElementById("t");
  if (!el) return;

  const CFG = {
    work:  +el.dataset.work  || 40,
    rest:  +el.dataset.rest  || 20,
    rounds:+el.dataset.rounds|| 8,
    prep:  +el.dataset.prep  || 10
  };

  const $ = s => el.querySelector(s);
  const mmss = s => { s = Math.max(0, Math.ceil(s));
    return Math.floor(s/60) + ":" + String(s%60).padStart(2,"0"); };

  let segs = [], idx = 0, remain = 0, endAt = 0, running = false, tick = null,
      wake = null, ac = null, lastBeep = -1;

  function build(){
    const out = [];
    if (CFG.prep > 0) out.push({ type:"prep", label:"Get ready", dur:CFG.prep });
    for (let r = 0; r < CFG.rounds; r++){
      out.push({ type:"work", label:"Work", dur:CFG.work, round:r+1 });
      if (CFG.rest > 0 && r < CFG.rounds - 1)
        out.push({ type:"rest", label:"Rest", dur:CFG.rest, round:r+1 });
    }
    let t = 0;
    out.forEach(s => { s.start = t; t += s.dur; });
    out.total = t;
    return out;
  }

  /* A short sine blip. No audio files to load, and nothing to fetch. */
  function beep(freq, len, vol){
    try{
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = freq; o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(vol || .3, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(.0001, ac.currentTime + (len || .12));
      o.start(); o.stop(ac.currentTime + (len || .12));
    }catch(e){}
  }

  async function keepAwake(on){
    try{
      if (on && !wake && navigator.wakeLock) wake = await navigator.wakeLock.request("screen");
      if (!on && wake){ await wake.release(); wake = null; }
    }catch(e){}
  }

  function paint(){
    const s = segs[idx]; if (!s) return;
    const secs = Math.max(0, remain / 1000);
    $(".t-clock").textContent = mmss(secs);
    $(".t-phase").textContent = s.type === "work"
      ? "Work — round " + s.round + " of " + CFG.rounds
      : s.type === "rest" ? "Rest" : s.label;
    el.className = "t " + s.type + (running ? "" : " paused");
    const done = s.start + (s.dur - secs);
    $(".t-bar i").style.width = (100 * done / segs.total).toFixed(2) + "%";
    $(".t-left").textContent = mmss(segs.total - done) + " left";
    $(".t-go").textContent = running ? "Pause"
      : (idx === 0 && remain === segs[0].dur * 1000 ? "Start" : "Resume");
  }

  function enter(i, announce){
    idx = i;
    remain = segs[idx].dur * 1000;
    endAt = performance.now() + remain;
    lastBeep = -1;
    if (announce) beep(segs[idx].type === "work" ? 1200 : 760, .16, .3);
    paint();
  }

  function frame(){
    if (!running) return;
    remain = endAt - performance.now();
    const secs = Math.ceil(remain / 1000);
    if (secs <= 3 && secs >= 1 && secs !== lastBeep){ lastBeep = secs; beep(700, .08, .22); }
    if (remain <= 0){
      if (idx >= segs.length - 1){ finish(); return; }
      enter(idx + 1, true);
    }
    paint();
  }

  function setRunning(on){
    running = on;
    if (on){
      endAt = performance.now() + remain;
      if (!tick) tick = setInterval(frame, 100);
      beep(880, .1);
    } else if (tick){ clearInterval(tick); tick = null; }
    keepAwake(on);
    paint();
  }

  function finish(){
    running = false;
    if (tick){ clearInterval(tick); tick = null; }
    keepAwake(false);
    remain = 0;
    beep(660,.16); setTimeout(()=>beep(880,.16),170); setTimeout(()=>beep(1320,.3),340);
    el.className = "t done";
    $(".t-clock").textContent = "0:00";
    $(".t-phase").textContent = "Done — nice work";
    $(".t-go").textContent = "Again";
  }

  function reset(){
    running = false;
    if (tick){ clearInterval(tick); tick = null; }
    keepAwake(false);
    segs = build();
    enter(0, false);
  }

  function num(sel, key, min, max){
    const input = $(sel);
    input.value = CFG[key];
    input.addEventListener("change", () => {
      const v = Math.round(Number(input.value));
      CFG[key] = Math.max(min, Math.min(max, isFinite(v) ? v : CFG[key]));
      input.value = CFG[key];
      reset();
    });
  }

  num(".t-work", "work", 5, 600);
  num(".t-rest", "rest", 0, 600);
  num(".t-rounds", "rounds", 1, 99);

  $(".t-go").addEventListener("click", () => {
    if (el.classList.contains("done")){ reset(); setRunning(true); return; }
    setRunning(!running);
  });
  $(".t-reset").addEventListener("click", reset);

  document.addEventListener("keydown", e => {
    if (e.target.tagName === "INPUT") return;
    if (e.code === "Space"){ e.preventDefault(); $(".t-go").click(); }
  });

  reset();
})();
