// game/audio.js — every sound is synthesised with the WebAudio API; no asset files.
export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.volume = 0.55;
    this.stepFlip = 0;
  }

  init() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { this.enabled = false; return; }
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    // a little convolver-free "air": a gentle lowpass on the bus
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 12000;
    this.filter.connect(this.master);
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  _env(node, start, attack, decay, peak = 1) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + attack + decay);
    node.connect(g);
    g.connect(this.filter || this.master);
    return g;
  }

  noiseBuffer(duration) {
    const len = Math.max(1, Math.floor(this.ctx.sampleRate * duration));
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Material-flavoured footstep / dig noise. */
  _thud(freq, q, dur, peak, type = 'lowpass') {
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(dur + 0.05);
    const bp = this.ctx.createBiquadFilter();
    bp.type = type;
    bp.frequency.value = freq;
    bp.Q.value = q;
    src.connect(bp);
    this._env(bp, t, 0.004, dur, peak);
    src.start(t);
    src.stop(t + dur + 0.08);
  }

  _tone(freq, dur, peak, type = 'sine', slideTo = null) {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    this._env(osc, t, 0.008, dur, peak);
    osc.start(t);
    osc.stop(t + dur + 0.06);
  }

  step(blockKey) {
    if (!this.enabled || !this.ctx) return;
    this.stepFlip ^= 1;
    const f = 320 + this.stepFlip * 60;
    switch (blockKey) {
      case 'grass': case 'leaves': this._thud(1800, 0.7, 0.09, 0.16, 'highpass'); break;
      case 'sand': this._thud(2600, 0.6, 0.11, 0.13, 'highpass'); break;
      case 'snow': this._thud(1400, 0.5, 0.08, 0.10, 'highpass'); break;
      case 'water': this._thud(700, 0.8, 0.16, 0.16); break;
      case 'log': case 'planks': this._thud(600, 1.2, 0.08, 0.18); break;
      case 'stone': case 'cobblestone': case 'brick': this._thud(420, 1.0, 0.06, 0.16); break;
      case 'gravel': this._thud(900, 0.9, 0.09, 0.16, 'highpass'); break;
      default: this._thud(f, 0.8, 0.08, 0.14);
    }
  }

  dig(blockKey, progress = 0) {
    if (!this.enabled || !this.ctx) return;
    const p = 0.06 + progress * 0.06;
    this._thud(blockKey === 'stone' ? 700 : 1100, 1.1, p, 0.10);
  }

  breakBlock(blockKey) {
    if (!this.enabled || !this.ctx) return;
    this._thud(blockKey === 'stone' || blockKey === 'cobblestone' ? 900 : 1500, 0.9, 0.16, 0.24);
    this._tone(blockKey === 'stone' ? 180 : 260, 0.12, 0.08, 'triangle', 120);
  }

  placeBlock(blockKey) {
    if (!this.enabled || !this.ctx) return;
    this._thud(blockKey === 'stone' ? 500 : 850, 1.0, 0.1, 0.22);
  }

  hurt() {
    if (!this.enabled || !this.ctx) return;
    this._tone(240, 0.22, 0.22, 'square', 120);
  }

  eat() {
    if (!this.enabled || !this.ctx) return;
    this._thud(500, 1.4, 0.12, 0.16);
  }

  splash() {
    if (!this.enabled || !this.ctx) return;
    this._thud(900, 0.7, 0.3, 0.2, 'highpass');
  }

  explode() {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer(0.9);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1600, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 0.8);
    src.connect(lp);
    this._env(lp, t, 0.005, 0.85, 0.5);
    src.start(t); src.stop(t + 0.95);
  }

  levelUp() {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    [523, 659, 784].forEach((f, i) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.08);
      g.gain.exponentialRampToValueAtTime(0.18, t + i * 0.08 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.08 + 0.22);
      osc.connect(g); g.connect(this.master);
      osc.start(t + i * 0.08); osc.stop(t + i * 0.08 + 0.3);
    });
  }

  mob(kind) {
    if (!this.enabled || !this.ctx) return;
    const base = kind === 'zombie' ? 130 : kind === 'pig' ? 320 : kind === 'cow' ? 200 : 420;
    this._tone(base, 0.35, 0.10, kind === 'zombie' ? 'sawtooth' : 'triangle', base * 0.72);
  }
}
