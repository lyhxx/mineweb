// probe: is the distant "black checkerboard" real geometry (cave openings) or a
// rendering artifact? Capture the frame with the real shader and examine the dark pixels.
(() => {
  const g = window.__MINEWEB__;
  const gl = g.renderer.gl;
  const R = g.renderer;
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  g.hud.hidePause();
  g.uiMode = 'playing';
  g.stepFrame(1 / 60);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // sample a horizontal strip across the desert area and report luminance runs
  const y = Math.floor(H * 0.36);
  const runs = [];
  let cur = null;
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const lum = (px[i] + px[i + 1] + px[i + 2]) / 3;
    const kind = lum < 25 ? 'D' : lum > 170 ? 'L' : 'M';
    if (!cur || cur.kind !== kind) { cur = { kind, len: 1 }; runs.push(cur); }
    else cur.len++;
  }
  // distinguish "bright sky blue" from "lit terrain"
  const classify = (i) => {
    const r = px[i], gg = px[i + 1], b = px[i + 2];
    if (b > r + 25) return 'sky';
    const lum = (r + gg + b) / 3;
    if (lum < 25) return 'black';
    if (r > 150 && gg > 130 && b < 150) return 'sand';
    if (gg > r && gg > b) return 'grass';
    return 'other';
  };
  const hist = {};
  for (let x = 0; x < W; x++) {
    const c = classify((y * W + x) * 4);
    hist[c] = (hist[c] || 0) + 1;
  }
  // where are the black pixels? print their average B channel (sky fog would be blue-ish)
  let blackCount = 0, blackBlue = 0;
  for (let i = 0; i < W * H; i += 3) {
    const r = px[i * 4], gg = px[i * 4 + 1], b = px[i * 4 + 2];
    if ((r + gg + b) / 3 < 25) { blackCount++; if (b > r + 20) blackBlue++; }
  }
  // camera info
  return {
    stripY: y,
    runs: runs.slice(0, 24),
    hist,
    blackCount, blackBlue,
    blackBlueRatio: Number((blackBlue / Math.max(1, blackCount)).toFixed(3)),
    camY: Number(g.player.eyeY.toFixed(2)),
    viewDistance: g.world.viewDistance,
    draws: R.stats.draws, quads: R.stats.quads,
    glError: gl.getError(),
  };
})()
