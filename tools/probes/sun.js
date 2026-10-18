// probe: point the camera straight at the sun and confirm a bright disc appears there.
(() => {
  const g = window.__MINEWEB__;
  const p = g.player;
  const w = g.world;

  // late morning: sun high in the sky
  g.dayTime = 0.36;
  const s = g.sunDirection();
  const len = Math.hypot(s[0], s[1], s[2]);
  const sx = s[0] / len, sy = s[1] / len, sz = s[2] / len;
  p.pitch = Math.asin(sy);
  p.yaw = Math.atan2(sx, -sz);

  const px = Math.floor(p.x), pz = Math.floor(p.z);
  p.y = Math.max(w.findSurfaceY(px, pz) + 0.2, 96);
  g.uiMode = 'playing';
  w.update(p.x, p.z, 900);
  for (let i = 0; i < 6; i++) g.stepFrame(1 / 60);

  const gl = g.renderer.gl;
  const cw = gl.drawingBufferWidth, ch = gl.drawingBufferHeight;
  const W = 64, H = 64;
  const buf = new Uint8Array(W * H * 4);
  gl.readPixels((cw - W) >> 1, (ch - H) >> 1, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let maxLum = 0, brightPixels = 0, sum = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const lum = buf[i] + buf[i + 1] + buf[i + 2];
    sum += lum;
    if (lum > maxLum) maxLum = lum;
    if (lum > 660) brightPixels++;   // near-white
  }
  // export the exact frame we measured so the numbers and the image cannot disagree
  const full = new Uint8Array(cw * ch * 4);
  gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, full);
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    const src = (ch - 1 - y) * cw * 4;
    img.data.set(full.subarray(src, src + cw * 4), y * cw * 4);
  }
  ctx.putImageData(img, 0, 0);
  return {
    url: cv.toDataURL('image/png'),
    dayTime: g.dayTime,
    sunDir: [+sx.toFixed(3), +sy.toFixed(3), +sz.toFixed(3)],
    elevationDeg: +(Math.asin(sy) * 180 / Math.PI).toFixed(1),
    yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3),
    maxLum, avgLum: +(sum / (W * H)).toFixed(1),
    brightPixels,
    sunVisible: maxLum > 690 && brightPixels >= 2,
  };
})()
