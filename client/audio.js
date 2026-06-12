'use strict';

// Procedural audio: every sound is synthesized with WebAudio, so the game
// ships no audio files. Master/effects/ambience volumes persist in
// localStorage. The context starts on the first user gesture (browser rule).

const Sound = (() => {
  let ctx = null;
  let master, sfxBus, ambBus;
  let started = false;

  const vols = {
    master: +(localStorage.getItem('shardlands:vol') ?? 0.7),
    sfx: +(localStorage.getItem('shardlands:vol.sfx') ?? 0.8),
    amb: +(localStorage.getItem('shardlands:vol.amb') ?? 0.5),
  };

  function ensure() {
    if (ctx) return true;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return false;
    }
    master = ctx.createGain();
    master.gain.value = vols.master;
    master.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = vols.sfx;
    sfxBus.connect(master);
    ambBus = ctx.createGain();
    ambBus.gain.value = vols.amb;
    ambBus.connect(master);
    startAmbience();
    return true;
  }

  function setVol(which, v) {
    vols[which] = v;
    localStorage.setItem('shardlands:vol' + (which === 'master' ? '' : '.' + which), String(v));
    if (!ctx) return;
    ({ master, sfx: sfxBus, amb: ambBus })[which].gain.value = v;
  }

  // ---- tiny synth helpers -----------------------------------------------------

  function blip(freq, dur, type = 'square', gain = 0.12, slide = 0) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(sfxBus);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function noise(dur, gain = 0.15, freq = 1200, q = 1) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(sfxBus);
    src.start(t);
  }

  // ---- the effect palette --------------------------------------------------------

  const FX = {
    click: () => blip(660, 0.05, 'square', 0.05),
    swing: () => noise(0.12, 0.1, 700, 0.8),
    hit: () => { noise(0.1, 0.18, 350, 1); blip(140, 0.08, 'square', 0.08, -60); },
    miss: () => noise(0.08, 0.05, 1500, 1),
    heal: () => { blip(520, 0.12, 'sine', 0.08, 200); blip(780, 0.18, 'sine', 0.06, 240); },
    drink: () => { blip(300, 0.08, 'sine', 0.08, 120); blip(420, 0.1, 'sine', 0.06, 160); },
    pickup: () => { blip(880, 0.06, 'triangle', 0.08); blip(1320, 0.08, 'triangle', 0.06); },
    gold: () => { blip(1180, 0.05, 'triangle', 0.07); blip(1560, 0.09, 'triangle', 0.06); },
    chop: () => noise(0.1, 0.16, 250, 2),
    die: () => blip(180, 0.4, 'sawtooth', 0.07, -120),
    break_: () => { noise(0.2, 0.2, 500, 0.6); blip(220, 0.18, 'square', 0.07, -160); },
    portal: () => { blip(330, 0.5, 'sine', 0.07, 660); blip(495, 0.5, 'sine', 0.05, 990); },
    gain: () => { blip(523, 0.1, 'triangle', 0.07); setTimeout(() => blip(659, 0.12, 'triangle', 0.07), 90); },
    spell: () => blip(900, 0.18, 'sawtooth', 0.05, -500),
    bell: () => { blip(660, 0.7, 'sine', 0.09, -8); blip(1320, 0.5, 'sine', 0.03); },
  };

  function play(name) {
    if (!started || !ctx) return;
    const fn = FX[name === 'break' ? 'break_' : name];
    if (fn) fn();
  }

  // ---- ambience: wind, birdsong by day, and a slow wandering harp ----------------

  function startAmbience() {
    // wind: looped filtered noise
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 380;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    src.connect(f).connect(g).connect(ambBus);
    src.start();
    // gentle LFO on the wind
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.025;
    lfo.connect(lfoG).connect(g.gain);
    lfo.start();

    // birds by day, harp notes always (the realm has a resident minstrel)
    const PENTA = [262, 294, 330, 392, 440, 523, 587, 659];
    setInterval(() => {
      if (!started) return;
      const night = typeof dayDarkness === 'function' ? dayDarkness() > 0.3 : false;
      if (!night && Math.random() < 0.4) {
        const f0 = 2200 + Math.random() * 1400;
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        const gg = ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(f0, t);
        o.frequency.exponentialRampToValueAtTime(f0 * (0.8 + Math.random() * 0.5), t + 0.18);
        gg.gain.setValueAtTime(0.02, t);
        gg.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
        o.connect(gg).connect(ambBus);
        o.start(t);
        o.stop(t + 0.25);
      }
      if (Math.random() < 0.3) {
        const n = PENTA[Math.floor(Math.random() * PENTA.length)] / 2;
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        const gg = ctx.createGain();
        o.type = 'triangle';
        o.frequency.value = n;
        gg.gain.setValueAtTime(0.03, t);
        gg.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
        o.connect(gg).connect(ambBus);
        o.start(t);
        o.stop(t + 1.7);
      }
    }, 1800);
  }

  function start() {
    if (started) return;
    if (ensure()) {
      started = true;
      if (ctx.state === 'suspended') ctx.resume();
    }
  }

  document.addEventListener('pointerdown', start, { once: true });
  document.addEventListener('keydown', start, { once: true });

  return { play, setVol, vols };
})();
