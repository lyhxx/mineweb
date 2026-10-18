// game/input.js — keyboard, mouse and pointer-lock handling.
/** Guard rails so a bad setting or a glitched event can never spin the view. */
const MIN_SENSITIVITY = 0.0004;
const MAX_SENSITIVITY = 0.02;
const MAX_EVENT_DELTA = 250;   // px; larger jumps come from lock acquisition, not aiming

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.locked = false;
    this.buttons = [false, false, false];
    this.wheelDelta = 0;
    this.textBuffer = '';
    this.onKey = null;
    this.onMouseDown = null;
    this.onMouseUp = null;
    this.onWheel = null;
    this.onLockChange = null;
    this.sensitivity = 0.0022;
    this.invertY = false;
    this._bind();
  }

  _bind() {
    const canvas = this.canvas;
    window.addEventListener('keydown', (e) => {
      // browser shortcuts we never want to fight with
      if (e.code === 'F5' || e.code === 'F12' || (e.ctrlKey && e.code === 'KeyR')) return;
      this.keys.add(e.code);
      if (this.locked || e.code === 'Escape' || e.code === 'Tab') e.preventDefault();
      if (this.onKey) this.onKey(e.code, e, true);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (this.onKey) this.onKey(e.code, e, false);
    });
    window.addEventListener('blur', () => { this.keys.clear(); this.buttons = [false, false, false]; });

    canvas.addEventListener('mousedown', (e) => {
      this.buttons[e.button] = true;
      if (this.locked) e.preventDefault();
      if (this.onMouseDown) this.onMouseDown(e.button, e);
    });
    window.addEventListener('mouseup', (e) => {
      this.buttons[e.button] = false;
      if (this.onMouseUp) this.onMouseUp(e.button, e);
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Clamp single-event deltas: some browsers emit a huge jump right after the
      // pointer is locked, and raw-input devices can report very large deltas. A clamped
      // event can still aim, it just cannot whip the camera around in one frame.
      const mx = Math.max(-MAX_EVENT_DELTA, Math.min(MAX_EVENT_DELTA, e.movementX || 0));
      const my = Math.max(-MAX_EVENT_DELTA, Math.min(MAX_EVENT_DELTA, e.movementY || 0));
      this.mouseDX += mx;
      this.mouseDY += my;
    });
    window.addEventListener('wheel', (e) => {
      if (this.locked) e.preventDefault();
      this.wheelDelta += Math.sign(e.deltaY);
      if (this.onWheel) this.onWheel(Math.sign(e.deltaY));
    }, { passive: false });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  requestLock() {
    if (this.locked) return;
    // Plain pointer lock: `unadjustedMovement` hands back raw device deltas, which vary
    // wildly between mice and made the view uncontrollable. The adjusted (default) path
    // is what desktop games expect.
    try {
      const p = this.canvas.requestPointerLock();
      if (p && p.catch) p.catch(() => { /* headless / unsupported: play without lock */ });
    } catch (e) { /* ignore */ }
  }

  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  down(code) { return this.keys.has(code); }

  /** Consume accumulated mouse delta (radians already scaled). */
  takeMouse() {
    const sens = Math.max(MIN_SENSITIVITY, Math.min(MAX_SENSITIVITY, this.sensitivity || 0.0022));
    const dx = this.mouseDX * sens;
    const dy = this.mouseDY * sens * (this.invertY ? -1 : 1);
    this.mouseDX = 0; this.mouseDY = 0;
    return [dx, dy];
  }

  takeWheel() { const w = this.wheelDelta; this.wheelDelta = 0; return w; }

  /** Convenience snapshot used by the player physics. */
  movement() {
    return {
      forward: this.down('KeyW') || this.down('ArrowUp'),
      back: this.down('KeyS') || this.down('ArrowDown'),
      left: this.down('KeyA') || this.down('ArrowLeft'),
      right: this.down('KeyD') || this.down('ArrowRight'),
      jump: this.down('Space'),
      sneak: this.down('ShiftLeft') || this.down('ShiftRight'),
      sprint: this.down('ControlLeft') || this.down('ControlRight'),
    };
  }
}
