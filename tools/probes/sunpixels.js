// probe: sample individual pixels around the sun to see whether the blowout is local
// (sun too bright) or global (shader producing NaNs / white everywhere).
(() => {
  const g = window.__MINEWEB__;
  const p = g.player;
  const w = g.world;
  g.dayTime = 0.36;
  const s = g.sunDirection();
  const len = Math.hypot(s[0], s[1], s[2]);
  const sx = s[0] / len, sy = s[1] / len, sz = s[2] / len;
  p.pitch = Math.asin(sy);
  p.yaw = Math.atan2(sx, -sz);
  const px = Math.floor(p.x), pz = Math.floor(p.z);
  // lift the camera clear of the tree canopy so nothing occludes the sky
  p.y = Math.max(w.findSurfaceY(px, pz) + 0.2, 96);
  g.uiMode = 'playing';
  w.update(p.x, p.z, 600);
  for (let i = 0; i < 6; i++) g.stepFrame(1 / 60);

  const gl = g.renderer.gl;
  const cw = gl.drawingBufferWidth, ch = gl.drawingBufferHeight;
  const one = new Uint8Array(4);
  const at = (nx, ny) => {
    const x = Math.round((nx * 0.5 + 0.5) * (cw - 1));
    const y = Math.round((ny * 0.5 + 0.5) * (ch - 1));
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
    return [one[0], one[1], one[2]];
  };
  // ray angle from the sun for a given ndc offset is roughly proportional, so these are
  // "at the sun", "near it", "far corner"
  return {
    centre: at(0, 0),
    up: at(0, 0.5),
    down: at(0, -0.5),
    left: at(-0.6, 0),
    right: at(0.6, 0),
    cornerTL: at(-0.95, 0.95),
    cornerBR: at(0.95, -0.95),
    sunGlow: g.renderer.progSky ? 'ok' : 'none',
    tanHalfFov: +g.renderer.tanHalfFov.toFixed(3),
    aspect: +g.renderer.aspect.toFixed(3),
  };
})()
