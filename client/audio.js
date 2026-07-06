'use strict';

// Procedural audio: every sound is synthesized with WebAudio, so the game
// ships no audio files. Master/effects/ambience volumes persist in
// localStorage. The context starts on the first user gesture (browser rule).

const Sound = (() => {
  let ctx = null;
  let master, sfxBus, ambBus, musicBus;
  let started = false;

  const vols = {
    master: +(localStorage.getItem('shardlands:vol') ?? 0.7),
    sfx: +(localStorage.getItem('shardlands:vol.sfx') ?? 0.8),
    amb: +(localStorage.getItem('shardlands:vol.amb') ?? 0.4),
    music: +(localStorage.getItem('shardlands:vol.music') ?? 0.5),
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
    musicBus = ctx.createGain();
    musicBus.gain.value = vols.music;
    musicBus.connect(master);
    startAmbience();
    startMusic();
    return true;
  }

  function setVol(which, v) {
    vols[which] = v;
    localStorage.setItem('shardlands:vol' + (which === 'master' ? '' : '.' + which), String(v));
    if (!ctx) return;
    ({ master, sfx: sfxBus, amb: ambBus, music: musicBus })[which].gain.value = v;
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
    // melee: air, then steel — a whoosh that ends in a ring
    swing: () => noise(0.12, 0.1, 700, 0.8),
    hit: () => {
      noise(0.07, 0.16, 350, 1);              // the thud of impact
      blip(2400, 0.09, 'square', 0.025, -900); // steel ringing off
      blip(140, 0.08, 'square', 0.08, -60);
    },
    miss: () => noise(0.08, 0.05, 1500, 1),
    // the bow: string pluck, then the arrow's hiss
    bow: () => {
      blip(220, 0.06, 'triangle', 0.12, 160);  // string snap
      setTimeout(() => noise(0.16, 0.05, 2400, 0.7), 40); // fletching hiss
    },
    // spells sound like what they do
    marrow: () => { blip(880, 0.14, 'sine', 0.06, 500); noise(0.1, 0.03, 3200, 1); },
    fireball: () => {
      noise(0.3, 0.1, 300, 0.5);               // the roar
      blip(160, 0.28, 'sawtooth', 0.07, -90);  // low rolling boom
    },
    zap: () => { blip(1400, 0.12, 'sawtooth', 0.06, -1100); noise(0.08, 0.06, 4000, 2); },
    spell: () => blip(900, 0.18, 'sawtooth', 0.05, -500),
    heal: () => { blip(520, 0.12, 'sine', 0.08, 200); blip(780, 0.18, 'sine', 0.06, 240); },
    // bodily noises
    drink: () => { // three swallows, each lower than the last
      blip(340, 0.07, 'sine', 0.09, -80);
      setTimeout(() => blip(300, 0.07, 'sine', 0.08, -70), 110);
      setTimeout(() => blip(260, 0.09, 'sine', 0.07, -60), 230);
    },
    eat: () => { noise(0.06, 0.1, 900, 0.6); setTimeout(() => noise(0.06, 0.09, 700, 0.6), 140); },
    bandage: () => noise(0.28, 0.06, 1100, 0.4), // cloth pulled tight
    // working the land, each material with its own voice
    chop: () => { noise(0.05, 0.2, 180, 1.5); blip(95, 0.1, 'triangle', 0.1, -25); }, // axe into wood
    mine: () => { noise(0.04, 0.14, 2600, 3); blip(1900, 0.12, 'triangle', 0.05, -300); }, // pick on stone
    splash: () => { noise(0.2, 0.1, 600, 0.5); blip(280, 0.16, 'sine', 0.06, -140); },
    forge: () => { blip(1300, 0.14, 'square', 0.06, -200); noise(0.1, 0.1, 2000, 2); }, // hammer on anvil
    pickup: () => { blip(880, 0.06, 'triangle', 0.08); blip(1320, 0.08, 'triangle', 0.06); },
    gold: () => { // a fistful of coins, not two
      blip(1180, 0.05, 'triangle', 0.07);
      blip(1560, 0.09, 'triangle', 0.06);
      setTimeout(() => blip(1320, 0.06, 'triangle', 0.05), 70);
      setTimeout(() => blip(1760, 0.08, 'triangle', 0.04), 130);
    },
    die: () => blip(180, 0.4, 'sawtooth', 0.07, -120),
    break_: () => { noise(0.2, 0.2, 500, 0.6); blip(220, 0.18, 'square', 0.07, -160); },
    portal: () => { blip(330, 0.5, 'sine', 0.07, 660); blip(495, 0.5, 'sine', 0.05, 990); },
    gain: () => { blip(523, 0.1, 'triangle', 0.07); setTimeout(() => blip(659, 0.12, 'triangle', 0.07), 90); },
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

    // birdsong by day
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
    }, 1800);
  }

  // ---- the OST: old-school chiptunes, sequenced live -----------------------------
  // Three channels in the NES spirit: pulse lead, triangle bass, noise drums.
  // Notes are [midi, beats]; 0 = rest. Each track loops seamlessly.

  const N = null; // readability for rests
  const TRACKS = {
    overworld: {
      bpm: 112,
      lead: [ // A minor, a road-song
        [69, 1], [72, 1], [76, 1], [81, 1], [79, 1], [76, 1], [72, 1], [76, 0.5], [74, 0.5],
        [74, 1], [77, 1], [81, 0.5], [77, 0.5], [76, 1], [72, 1], [69, 2], [0, 1],
        [69, 1], [72, 1], [76, 1], [81, 1], [83, 1], [81, 1], [79, 1], [76, 0.5], [79, 0.5],
        [81, 1], [79, 1], [76, 1], [74, 1], [72, 2], [69, 1], [0, 1],
      ],
      harmony: [
        [60, 2], [64, 2], [57, 2], [59, 2],
        [62, 2], [65, 2], [64, 2], [57, 2],
        [60, 2], [64, 2], [67, 2], [64, 2],
        [65, 2], [64, 2], [60, 2], [57, 2],
      ],
      bass: [
        [45, 1], [45, 1], [52, 1], [45, 1], [41, 1], [41, 1], [48, 1], [41, 1],
        [43, 1], [43, 1], [50, 1], [43, 1], [45, 1], [52, 1], [45, 1], [45, 1],
        [45, 1], [45, 1], [52, 1], [45, 1], [43, 1], [43, 1], [50, 1], [43, 1],
        [41, 1], [41, 1], [48, 1], [41, 1], [45, 1], [40, 1], [45, 1], [45, 1],
      ],
      drums: [ // 1 = kick-ish thump, 2 = hat tick
        [1, 1], [2, 1], [2, 1], [2, 1], [1, 1], [2, 1], [1, 0.5], [2, 0.5], [2, 1],
      ],
    },
    town: {
      bpm: 100,
      lead: [ // C major, market-day jig
        [72, 1], [76, 0.5], [74, 0.5], [72, 1], [79, 1], [77, 1], [76, 1], [74, 2],
        [71, 1], [74, 0.5], [72, 0.5], [71, 1], [67, 1], [69, 1], [71, 1], [72, 2],
        [72, 1], [76, 0.5], [74, 0.5], [72, 1], [79, 1], [81, 1], [79, 1], [77, 2],
        [76, 1], [74, 1], [72, 1], [71, 1], [72, 3], [0, 1],
      ],
      harmony: [
        [64, 2], [67, 2], [65, 2], [62, 2],
        [62, 2], [64, 2], [62, 2], [64, 2],
        [64, 2], [67, 2], [69, 2], [65, 2],
        [67, 2], [65, 2], [64, 2], [60, 2],
      ],
      bass: [
        [48, 1], [55, 1], [52, 1], [55, 1], [53, 1], [55, 1], [43, 1], [47, 1],
        [43, 1], [50, 1], [48, 1], [52, 1], [41, 1], [43, 1], [48, 1], [48, 1],
        [48, 1], [55, 1], [52, 1], [55, 1], [53, 1], [57, 1], [53, 1], [50, 1],
        [55, 1], [50, 1], [48, 1], [43, 1], [48, 2], [48, 2],
      ],
      drums: [[2, 1], [2, 1], [1, 1], [2, 1]],
    },
    deeps: {
      bpm: 84,
      lead: [ // E phrygian, low and close — torchlight music
        [52, 2], [53, 1], [52, 1], [48, 4], [52, 2], [55, 2], [53, 2], [52, 2],
        [57, 2], [55, 1], [53, 1], [52, 4], [53, 2], [52, 2], [47, 2], [0, 2],
        [52, 2], [53, 1], [52, 1], [59, 4], [57, 2], [55, 2], [53, 2], [52, 2],
        [48, 2], [47, 2], [45, 2], [47, 2], [52, 4], [0, 4],
      ],
      harmony: [
        [52, 4], [53, 4], [52, 4], [47, 4],
        [52, 4], [55, 4], [53, 4], [52, 4],
      ],
      bass: [ // a heartbeat under the stone
        [40, 2], [40, 2], [41, 2], [41, 2],
        [40, 2], [40, 2], [35, 2], [35, 2],
      ],
      drums: [[1, 1], [1, 1], [0, 2], [2, 1], [0, 3]],
    },
    frost: {
      bpm: 74,
      lead: [ // E minor, high and glassy — snowlight over the drifts
        [76, 2], [79, 2], [83, 3], [81, 1], [79, 2], [76, 4], [0, 2],
        [74, 2], [76, 2], [79, 3], [83, 1], [81, 2], [79, 4], [0, 2],
        [76, 2], [79, 2], [88, 3], [86, 1], [83, 2], [79, 2], [76, 4], [0, 2],
        [74, 2], [71, 2], [74, 3], [76, 1], [71, 2], [64, 4], [0, 2],
      ],
      harmony: [
        [64, 4], [67, 4], [59, 4], [60, 4],
        [64, 4], [62, 4], [59, 4], [64, 4],
      ],
      bass: [
        [40, 4], [43, 4], [35, 4], [36, 4],
        [40, 4], [38, 4], [35, 4], [40, 4],
      ],
      drums: [[0, 3], [2, 1]], // a lone tick, like settling ice
    },
    mire: {
      bpm: 80,
      lead: [ // B locrian murk — something is breathing under the water
        [59, 2], [58, 1], [59, 1], [62, 3], [61, 1], [59, 2], [55, 4], [0, 2],
        [57, 2], [58, 2], [59, 3], [58, 1], [57, 2], [53, 4], [0, 2],
        [59, 2], [62, 2], [65, 3], [64, 1], [62, 2], [58, 2], [59, 4], [0, 2],
      ],
      harmony: [
        [47, 4], [46, 4], [50, 4], [47, 4],
        [45, 4], [46, 4], [47, 4], [46, 4],
      ],
      bass: [
        [35, 2], [35, 2], [34, 2], [34, 2], [38, 2], [38, 2], [35, 2], [35, 2],
        [33, 2], [33, 2], [34, 2], [34, 2], [35, 2], [34, 2], [35, 2], [35, 2],
      ],
      drums: [[1, 2], [0, 1], [2, 1]], // slow squelching pulse
    },
    dunes: {
      bpm: 92,
      lead: [ // A phrygian dominant — heat shimmer on the southeastern sands
        [69, 1], [70, 1], [73, 1], [74, 1], [76, 2], [77, 1], [76, 1],
        [74, 1], [73, 1], [70, 1], [69, 3], [0, 1],
        [76, 1], [77, 1], [79, 1], [77, 1], [76, 2], [74, 1], [73, 1],
        [74, 1], [70, 1], [69, 2], [68, 1], [69, 3], [0, 1],
      ],
      harmony: [
        [57, 2], [58, 2], [61, 2], [57, 2],
        [62, 2], [61, 2], [58, 2], [57, 2],
      ],
      bass: [
        [45, 1], [45, 1], [52, 1], [45, 1], [46, 1], [46, 1], [45, 1], [45, 1],
        [50, 1], [50, 1], [49, 1], [49, 1], [45, 1], [45, 1], [45, 2],
      ],
      drums: [[1, 0.5], [2, 0.5], [2, 1], [1, 1], [2, 0.5], [2, 0.5]],
    },
    night: {
      bpm: 72,
      lead: [ // D dorian, sparse and watchful
        [62, 2], [65, 2], [69, 3], [67, 1], [65, 2], [62, 4], [0, 2],
        [60, 2], [62, 2], [65, 3], [69, 1], [67, 2], [65, 4], [0, 2],
        [62, 2], [65, 2], [72, 3], [70, 1], [69, 2], [65, 2], [62, 4], [0, 2],
      ],
      harmony: [
        [53, 4], [57, 4], [50, 4], [48, 4],
        [53, 4], [55, 4], [57, 4], [50, 4],
      ],
      bass: [
        [38, 4], [41, 4], [36, 4], [38, 4],
        [41, 4], [43, 4], [38, 4], [38, 4],
      ],
      drums: [[0, 4]],
    },
    coast: {
      bpm: 96,
      lead: [ // C mixolydian — gull-light air for the shorelines
        [72, 1], [76, 1], [79, 1], [77, 1], [76, 1], [74, 1], [72, 1], [70, 1],
        [69, 1], [72, 1], [74, 2], [72, 1], [70, 1], [67, 2],
        [72, 1], [76, 1], [79, 1], [81, 1], [79, 1], [77, 1], [76, 1], [74, 1],
        [76, 1], [74, 1], [72, 1], [70, 1], [72, 3], [0, 1],
      ],
      harmony: [
        [64, 2], [65, 2], [67, 2], [65, 2], [64, 2], [62, 2], [60, 2], [64, 2],
        [64, 2], [67, 2], [69, 2], [67, 2], [65, 2], [64, 2], [60, 2], [64, 2],
      ],
      bass: [
        [48, 1], [55, 1], [52, 1], [55, 1], [46, 1], [53, 1], [50, 1], [53, 1],
        [45, 1], [52, 1], [48, 1], [52, 1], [43, 1], [50, 1], [47, 1], [50, 1],
        [48, 1], [55, 1], [52, 1], [55, 1], [46, 1], [53, 1], [50, 1], [53, 1],
        [41, 1], [48, 1], [45, 1], [48, 1], [48, 1], [55, 1], [48, 2],
      ],
      drums: [[2, 1], [2, 0.5], [2, 0.5], [1, 1], [2, 1]], // surf-brush
    },
    tavern: {
      bpm: 132,
      lead: [ // G major jig — the OTHER market day, two ales in
        [67, 0.5], [71, 0.5], [74, 0.5], [79, 1.5], [76, 0.5], [78, 0.5], [79, 1], [74, 1], [71, 0.5], [72, 0.5], [74, 1],
        [76, 0.5], [74, 0.5], [72, 0.5], [71, 1.5], [69, 0.5], [67, 0.5], [69, 1], [71, 1], [74, 2],
        [79, 0.5], [78, 0.5], [76, 0.5], [78, 1.5], [74, 0.5], [76, 0.5], [78, 1], [79, 1], [81, 0.5], [79, 0.5], [78, 1],
        [76, 0.5], [74, 0.5], [72, 0.5], [74, 1.5], [71, 0.5], [72, 0.5], [71, 1], [69, 1], [67, 2],
      ],
      harmony: [
        [59, 2], [62, 2], [60, 2], [62, 2], [64, 2], [62, 2], [60, 2], [59, 2],
        [62, 2], [64, 2], [66, 2], [62, 2], [60, 2], [62, 2], [59, 2], [55, 2],
      ],
      bass: [
        [43, 1], [50, 1], [47, 1], [50, 1], [48, 1], [55, 1], [52, 1], [55, 1],
        [40, 1], [47, 1], [43, 1], [47, 1], [50, 1], [45, 1], [50, 1], [43, 1],
        [43, 1], [50, 1], [47, 1], [50, 1], [48, 1], [55, 1], [52, 1], [55, 1],
        [40, 1], [47, 1], [43, 1], [47, 1], [50, 1], [43, 1], [38, 1], [43, 1],
      ],
      drums: [[1, 0.5], [2, 0.5], [2, 0.5], [1, 0.5], [2, 0.5], [2, 0.5]], // jig lilt
    },
    wanderer: {
      bpm: 104,
      lead: [ // D major, wistful — the road-song's second verse, miles later
        [74, 1], [78, 1], [81, 1], [79, 1], [78, 1], [76, 1], [74, 1], [71, 1],
        [69, 1], [71, 1], [74, 2], [73, 1], [71, 1], [69, 2],
        [74, 1], [78, 1], [81, 1], [83, 1], [81, 1], [79, 1], [78, 1], [76, 1],
        [78, 1], [76, 1], [74, 1], [73, 1], [74, 3], [0, 1],
      ],
      harmony: [
        [66, 2], [67, 2], [69, 2], [67, 2], [66, 2], [64, 2], [62, 2], [66, 2],
        [66, 2], [69, 2], [71, 2], [69, 2], [67, 2], [66, 2], [64, 2], [66, 2],
      ],
      bass: [
        [38, 1], [45, 1], [42, 1], [45, 1], [43, 1], [50, 1], [47, 1], [50, 1],
        [35, 1], [42, 1], [38, 1], [42, 1], [45, 1], [52, 1], [45, 1], [45, 1],
        [38, 1], [45, 1], [42, 1], [45, 1], [43, 1], [50, 1], [47, 1], [50, 1],
        [40, 1], [47, 1], [43, 1], [47, 1], [38, 1], [45, 1], [38, 2],
      ],
      drums: [[1, 1], [2, 1], [2, 1], [2, 1], [1, 1], [2, 0.5], [2, 0.5], [2, 2]],
    },
  };

  const CHANNEL_VOICE = {
    lead: { type: 'square', gain: 0.045, decay: 0.9 },
    harmony: { type: 'square', gain: 0.022, decay: 0.95, detune: -1200 },
    bass: { type: 'triangle', gain: 0.07, decay: 0.95 },
  };

  let currentTrack = 'overworld';
  let pendingTrack = null;

  function midiHz(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  }

  function startMusic() {
    const pos = {}; // channel -> { i, t }
    let trackStart = ctx.currentTime + 0.2;
    const resetPos = () => {
      for (const ch of ['lead', 'harmony', 'bass', 'drums']) pos[ch] = { i: 0, t: trackStart };
    };
    resetPos();
    setInterval(() => {
      if (!started) return;
      const track = TRACKS[currentTrack];
      const spb = 60 / track.bpm;
      const horizon = ctx.currentTime + 0.4;
      // switch tracks at a loop boundary-ish (when the lead wraps)
      for (const ch of ['lead', 'harmony', 'bass', 'drums']) {
        const seq = track[ch];
        if (!seq || !seq.length) continue;
        const P = pos[ch];
        while (P.t < horizon) {
          const [note, beats] = seq[P.i % seq.length];
          const dur = beats * spb;
          if (ch === 'drums') {
            if (note === 1) scheduleThump(P.t);
            else if (note === 2) scheduleTick(P.t);
          } else if (note) {
            scheduleNote(ch, note, P.t, dur);
          }
          P.t += dur;
          P.i++;
          if (ch === 'lead' && P.i % seq.length === 0 && pendingTrack) {
            currentTrack = pendingTrack;
            pendingTrack = null;
            trackStart = P.t;
            resetPos();
            break;
          }
        }
      }
    }, 150);
  }

  function scheduleNote(ch, midi, at, dur) {
    const v = CHANNEL_VOICE[ch];
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = v.type;
    o.frequency.value = midiHz(midi);
    if (v.detune) o.detune.value = v.detune;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(v.gain, at + 0.02);
    g.gain.setValueAtTime(v.gain, at + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur * v.decay);
    o.connect(g).connect(musicBus);
    o.start(at);
    o.stop(at + dur);
  }

  function scheduleThump(at) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(110, at);
    o.frequency.exponentialRampToValueAtTime(45, at + 0.12);
    g.gain.setValueAtTime(0.09, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
    o.connect(g).connect(musicBus);
    o.start(at);
    o.stop(at + 0.15);
  }

  function scheduleTick(at) {
    const len = Math.ceil(ctx.sampleRate * 0.03);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 6000;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    src.connect(f).connect(g).connect(musicBus);
    src.start(at);
  }

  function setTrack(name) {
    if (TRACKS[name] && name !== currentTrack) pendingTrack = name;
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

  return { play, setVol, vols, setTrack };
})();
