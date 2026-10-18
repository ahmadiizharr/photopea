// Synthesised blips so the booth needs no audio files.
let ac = null;

export function unlock() {
  if (!ac) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    ac = new Ctx();
  }
  if (ac.state === 'suspended') ac.resume();
}

function tone(freq, start, dur, type = 'sine', gain = 0.18) {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(gain, start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(ac.destination);
  o.start(start);
  o.stop(start + dur + 0.02);
}

export function beep(freq = 880) {
  if (!ac) return;
  tone(freq, ac.currentTime, 0.09, 'square', 0.06);
}

export function shutter() {
  if (!ac) return;
  const t = ac.currentTime;
  const len = Math.floor(ac.sampleRate * 0.09);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const src = ac.createBufferSource();
  const hp = ac.createBiquadFilter();
  const g = ac.createGain();
  hp.type = 'highpass';
  hp.frequency.value = 1800;
  g.gain.value = 0.5;
  src.buffer = buf;
  src.connect(hp).connect(g).connect(ac.destination);
  src.start(t);
  tone(2400, t, 0.03, 'square', 0.05);
}

export function chime() {
  if (!ac) return;
  const t = ac.currentTime;
  [784, 988, 1319].forEach((f, i) => tone(f, t + i * 0.09, 0.25, 'triangle', 0.12));
}
