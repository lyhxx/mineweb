// probe: does mouse-look actually rotate the camera? Force pointer-lock on, inject mouse
// movement, and confirm both the yaw/pitch values AND the rendered image change.
(() => {
  const g = window.__MINEWEB__;
  const p = g.player;
  const input = g.input;
  const out = {};

  // stand somewhere open with a clear view
  const w = g.world;
  const px = Math.floor(p.x), pz = Math.floor(p.z);
  const py = w.findSurfaceY(px, pz);
  p.x = px + 0.5; p.z = pz + 0.5; p.y = py + 0.2;
  p.yaw = 0; p.pitch = 0;
  g.uiMode = 'playing';
  g.hud.hidePause();
  w.update(p.x, p.z, 900);

  // simulate pointer lock so the mousemove handler accumulates deltas
  input.locked = true;

  const grabFrame = () => {
    for (let i = 0; i < 3; i++) g.stepFrame(1 / 60);
    const gl = g.renderer.gl;
    const W = 64, H = 64;
    const buf = new Uint8Array(W * H * 4);
    // sample the centre of the framebuffer
    const cw = gl.drawingBufferWidth, ch = gl.drawingBufferHeight;
    gl.readPixels((cw - W) >> 1, (ch - H) >> 1, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0, hash = 0;
    for (let i = 0; i < buf.length; i += 4) {
      sum += buf[i] + buf[i + 1] + buf[i + 2];
      hash = (hash * 31 + buf[i] + buf[i + 1] * 7 + buf[i + 2] * 13) | 0;
    }
    return { sum, hash, W, H };
  };

  const before = { yaw: p.yaw, pitch: p.pitch };
  const frameA = grabFrame();

  // inject a horizontal mouse move (movementX = 400)
  const canvas = g.canvas;
  const ev = new MouseEvent('mousemove', { bubbles: true });
  Object.defineProperty(ev, 'movementX', { value: 400 });
  Object.defineProperty(ev, 'movementY', { value: 0 });
  window.dispatchEvent(ev);

  out.accumulated = { dx: input.mouseDX, dy: input.mouseDY };
  // run one tick so the game consumes the delta
  g.stepFrame(1 / 60);
  const afterYaw = { yaw: p.yaw, pitch: p.pitch };
  const frameB = grabFrame();

  // now inject a vertical move
  const ev2 = new MouseEvent('mousemove', { bubbles: true });
  Object.defineProperty(ev2, 'movementX', { value: 0 });
  Object.defineProperty(ev2, 'movementY', { value: 400 });
  window.dispatchEvent(ev2);
  const acc2 = { dx: input.mouseDX, dy: input.mouseDY };
  g.stepFrame(1 / 60);
  const afterPitch = { yaw: p.yaw, pitch: p.pitch };
  const frameC = grabFrame();

  // how far can pitch go?
  p.pitch = 0;
  const ev3 = new MouseEvent('mousemove', { bubbles: true });
  Object.defineProperty(ev3, 'movementX', { value: 0 });
  Object.defineProperty(ev3, 'movementY', { value: -100000 });
  window.dispatchEvent(ev3);
  g.stepFrame(1 / 60);
  const pitchMax = p.pitch;
  const ev4 = new MouseEvent('mousemove', { bubbles: true });
  Object.defineProperty(ev4, 'movementX', { value: 0 });
  Object.defineProperty(ev4, 'movementY', { value: 200000 });
  window.dispatchEvent(ev4);
  g.stepFrame(1 / 60);
  const pitchMin = p.pitch;

  out.before = before;
  out.afterYaw = afterYaw;
  out.afterPitch = afterPitch;
  out.yawChanged = Math.abs(afterYaw.yaw - before.yaw) > 0.01;
  out.pitchChanged = Math.abs(afterPitch.pitch - afterYaw.pitch) > 0.01;
  out.frameA = frameA;
  out.frameB = frameB;
  out.frameC = frameC;
  out.viewChangedH = frameA.hash !== frameB.hash;
  out.viewChangedV = frameB.hash !== frameC.hash;
  out.pitchMax = pitchMax;
  out.pitchMin = pitchMin;
  out.lookDirLevel = p.lookDir();
  p.yaw = 0; p.pitch = 0;
  out.lookDirForward = p.lookDir();
  p.yaw = Math.PI / 2;
  out.lookDirRight = p.lookDir();
  p.yaw = 0; p.pitch = 0;
  input.locked = false;
  return out;
})()
