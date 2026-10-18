// probe: for the darkest pixels in the beach area, raycast into the world and report the
// block + face the camera is actually looking at.
(() => {
  const g = window.__MINEWEB__;
  const gl = g.renderer.gl;
  const R = g.renderer;
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  g.hud.hidePause();
  g.uiMode = 'playing';
  g.stepFrame(1 / 60);
  const cam = R.cam;

  // invert the live view-projection so a pixel can be turned back into a ray
  const invert = (m) => {
    const inv = new Array(16);
    inv[0] = m[5]*m[10]*m[15] - m[5]*m[11]*m[14] - m[9]*m[6]*m[15] + m[9]*m[7]*m[14] + m[13]*m[6]*m[11] - m[13]*m[7]*m[10];
    inv[4] = -m[4]*m[10]*m[15] + m[4]*m[11]*m[14] + m[8]*m[6]*m[15] - m[8]*m[7]*m[14] - m[12]*m[6]*m[11] + m[12]*m[7]*m[10];
    inv[8] = m[4]*m[9]*m[15] - m[4]*m[11]*m[13] - m[8]*m[5]*m[15] + m[8]*m[7]*m[13] + m[12]*m[5]*m[11] - m[12]*m[7]*m[9];
    inv[12] = -m[4]*m[9]*m[14] + m[4]*m[10]*m[13] + m[8]*m[5]*m[14] - m[8]*m[6]*m[13] - m[12]*m[5]*m[10] + m[12]*m[6]*m[9];
    inv[1] = -m[1]*m[10]*m[15] + m[1]*m[11]*m[14] + m[9]*m[2]*m[15] - m[9]*m[3]*m[14] - m[13]*m[2]*m[11] + m[13]*m[3]*m[10];
    inv[5] = m[0]*m[10]*m[15] - m[0]*m[11]*m[14] - m[8]*m[2]*m[15] + m[8]*m[3]*m[14] + m[12]*m[2]*m[11] - m[12]*m[3]*m[10];
    inv[9] = -m[0]*m[9]*m[15] + m[0]*m[11]*m[13] + m[8]*m[1]*m[15] - m[8]*m[3]*m[13] - m[12]*m[1]*m[11] + m[12]*m[3]*m[9];
    inv[13] = m[0]*m[9]*m[14] - m[0]*m[10]*m[13] - m[8]*m[1]*m[14] + m[8]*m[2]*m[13] + m[12]*m[1]*m[10] - m[12]*m[2]*m[9];
    inv[2] = m[1]*m[6]*m[15] - m[1]*m[7]*m[14] - m[5]*m[2]*m[15] + m[5]*m[3]*m[14] + m[13]*m[2]*m[7] - m[13]*m[3]*m[6];
    inv[6] = -m[0]*m[6]*m[15] + m[0]*m[7]*m[14] + m[4]*m[2]*m[15] - m[4]*m[3]*m[14] - m[12]*m[2]*m[7] + m[12]*m[3]*m[6];
    inv[10] = m[0]*m[5]*m[15] - m[0]*m[7]*m[13] - m[4]*m[1]*m[15] + m[4]*m[3]*m[13] + m[12]*m[1]*m[7] - m[12]*m[3]*m[5];
    inv[14] = -m[0]*m[5]*m[14] + m[0]*m[6]*m[13] + m[4]*m[1]*m[14] - m[4]*m[2]*m[13] - m[12]*m[1]*m[6] + m[12]*m[2]*m[5];
    inv[3] = -m[1]*m[6]*m[11] + m[1]*m[7]*m[10] + m[5]*m[2]*m[11] - m[5]*m[3]*m[10] - m[9]*m[2]*m[7] + m[9]*m[3]*m[6];
    inv[7] = m[0]*m[6]*m[11] - m[0]*m[7]*m[10] - m[4]*m[2]*m[11] + m[4]*m[3]*m[10] + m[8]*m[2]*m[7] - m[8]*m[3]*m[6];
    inv[11] = -m[0]*m[5]*m[11] + m[0]*m[7]*m[9] + m[4]*m[1]*m[11] - m[4]*m[3]*m[9] - m[8]*m[1]*m[7] + m[8]*m[3]*m[5];
    inv[15] = m[0]*m[5]*m[10] - m[0]*m[6]*m[9] - m[4]*m[1]*m[10] + m[4]*m[2]*m[9] + m[8]*m[1]*m[6] - m[8]*m[2]*m[5];
    let det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
    if (!det) return null;
    det = 1 / det;
    return inv.map((v) => v * det);
  };
  const inv = invert(Array.from(R.vp));
  const rayFromPixel = (px, py) => {
    const nx = (px / W) * 2 - 1, ny = (py / H) * 2 - 1;
    const mul = (v) => [
      inv[0]*v[0] + inv[4]*v[1] + inv[8]*v[2] + inv[12]*v[3],
      inv[1]*v[0] + inv[5]*v[1] + inv[9]*v[2] + inv[13]*v[3],
      inv[2]*v[0] + inv[6]*v[1] + inv[10]*v[2] + inv[14]*v[3],
      inv[3]*v[0] + inv[7]*v[1] + inv[11]*v[2] + inv[15]*v[3],
    ];
    const a = mul([nx, ny, -1, 1]), b = mul([nx, ny, 1, 1]);
    for (let i = 0; i < 4; i++) { a[i] /= a[3]; b[i] /= b[3]; }
    const d = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    return { o: [a[0], a[1], a[2]], d: [d[0]/len, d[1]/len, d[2]/len] };
  };

  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);

  // hunt for dark pixels on the right half (the beach) and trace them
  const found = [];
  for (let y = 40; y < H * 0.6 && found.length < 10; y += 3) {
    for (let x = Math.floor(W * 0.55); x < W && found.length < 10; x += 3) {
      const i = (y * W + x) * 4;
      const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
      if (l < 25) {
        const r = rayFromPixel(x, y);
        const hit = g.world.raycast(r.o[0], r.o[1], r.o[2], r.d[0], r.d[1], r.d[2], 200, true);
        found.push({
          screen: [x, y], rgb: [px[i], px[i + 1], px[i + 2]],
          hit: hit ? { x: hit.x, y: hit.y, z: hit.z, id: hit.id, normal: [hit.nx, hit.ny, hit.nz], dist: Number(hit.dist.toFixed(2)) } : null,
        });
      }
    }
  }
  return { cam: { x: Number(cam.x.toFixed(2)), y: Number(cam.y.toFixed(2)), z: Number(cam.z.toFixed(2)), pitch: Number(cam.pitch.toFixed(3)) }, found };
})()
