// probe: build a small wheat farm + bed + tilled soil in front of the camera and render it.
(() => {
  const g = window.__MINEWEB__;
  const p = g.player;
  const w = g.world;
  const dirtId = 3, farmlandId = 55, wheatId = 56, bedId = 57, waterId = 9;
  // find a flat spot
  let best = null;
  for (let attempt = 0; attempt < 80 && !best; attempt++) {
    const tx = Math.floor(p.x) + ((attempt * 5) % 40) - 20;
    const tz = Math.floor(p.z) + ((attempt * 7) % 40) - 20;
    const h0 = w.findSurfaceY(tx, tz);
    let flat = true;
    for (let dx = 0; dx <= 9 && flat; dx++) {
      for (let dz = 0; dz <= 7 && flat; dz++) {
        const h = w.findSurfaceY(tx + dx, tz + dz);
        if (Math.abs(h - h0) > 0 || w.getBlockRaw(tx + dx, h, tz + dz) !== 2) flat = false;
        for (let ay = h + 1; ay <= h + 8; ay++) if (w.getBlockRaw(tx + dx, ay, tz + dz) !== 0) flat = false;
      }
    }
    if (flat) best = { x: tx, z: tz, y: h0 };
  }
  if (!best) best = { x: Math.floor(p.x), z: Math.floor(p.z), y: w.findSurfaceY(Math.floor(p.x), Math.floor(p.z)) };

  // 8x6 wheat field: two rows of water-flanked farmland, crops at mixed stages
  for (let dx = 0; dx < 9; dx++) {
    for (let dz = 0; dz < 7; dz++) {
      const x = best.x + dx, z = best.z + dz;
      w.setBlockAt(x, best.y, z, farmlandId);
      w.setBlockAt(x, best.y + 1, z, 0);
      w.setFacing(x, best.y, z, 0);
    }
  }
  // a water channel down the middle
  for (let dx = 0; dx < 9; dx++) w.setBlockAt(best.x + dx, best.y, best.z + 3, waterId);
  // crops at every stage
  let stage = 0;
  for (let dx = 0; dx < 9; dx++) {
    for (let dz = 0; dz < 7; dz++) {
      if (dz === 3) continue;
      const x = best.x + dx, z = best.z + dz;
      w.setBlockAt(x, best.y + 1, z, wheatId);
      w.setFacing(x, best.y + 1, z, (dx + dz) % 4);
    }
  }
  // a bed and a chest beside the field
  w.setBlockAt(best.x - 2, best.y + 1, best.z + 2, bedId);
  w.setFacing(best.x - 2, best.y + 1, best.z + 2, 0);
  w.setBlockAt(best.x - 2, best.y + 1, best.z + 4, 29);

  // look at it
  p.x = best.x + 4.5; p.z = best.z - 7.5; p.y = best.y + 3.2;
  p.yaw = 0; p.pitch = -0.30;
  g.hud.hidePause();
  g.uiMode = 'playing';
  w.update(p.x, p.z, 600);
  for (let i = 0; i < 24; i++) g.stepFrame(1 / 60);

  const gl = g.renderer.gl;
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const src = (H - 1 - y) * W * 4;
    img.data.set(px.subarray(src, src + W * 4), y * W * 4);
  }
  ctx.putImageData(img, 0, 0);

  // verify the crop stages actually landed
  const stageHist = {};
  for (let dx = 0; dx < 9; dx++) {
    for (let dz = 0; dz < 7; dz++) {
      if (dz === 3) continue;
      const s = w.getFacing(best.x + dx, best.y + 1, best.z + dz);
      stageHist[s] = (stageHist[s] || 0) + 1;
    }
  }
  return { url: cv.toDataURL('image/png'), stageHist, field: [best.x, best.y, best.z] };
})()
