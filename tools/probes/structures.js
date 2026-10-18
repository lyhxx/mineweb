// probe: verify structures exist in the loaded world, open a structure chest to check the
// loot roll, and render a view of the nearest one.
(() => {
  const g = window.__MINEWEB__;
  const w = g.world;
  const out = {
    structureChests: w.structureChests ? w.structureChests.size : -1,
    chests: [],
    findChest: null,
  };
  if (w.structureChests) {
    let n = 0;
    for (const [key, theme] of w.structureChests) {
      out.chests.push({ key, theme });
      if (++n >= 6) break;
    }
  }
  // count structure blocks near the player: cobble/planks/torch/glass away from trees
  const p = g.player;
  let chestsNearby = 0, torchesNearby = 0, planksNearby = 0, glassNearby = 0;
  const px = Math.floor(p.x), pz = Math.floor(p.z);
  for (let dx = -64; dx <= 64; dx += 2) {
    for (let dz = -64; dz <= 64; dz += 2) {
      for (let y = 55; y < 100; y += 1) {
        const id = w.getBlockRaw(px + dx, y, pz + dz);
        if (id === 29) chestsNearby++;
        else if (id === 30) torchesNearby++;
        else if (id === 5) planksNearby++;
        else if (id === 18) glassNearby++;
      }
    }
  }
  out.nearby = { chestsNearby, torchesNearby, planksNearby, glassNearby };

  // open one structure chest and read the loot
  if (out.chests.length) {
    const [x, y, z] = out.chests[0].key.split(',').map(Number);
    const chest = w.chestAt(x, y, z, true);
    const filled = chest.map((s, i) => (s ? [i, s.id, s.count] : null)).filter(Boolean);
    out.findChest = { pos: [x, y, z], theme: out.chests[0].theme, filled };
    // move the camera to look at it
    p.x = x + 10; p.y = y + 8; p.z = z + 10;
    p.yaw = Math.atan2(x - p.x, -(z - p.z));
    p.pitch = -0.45;
    g.hud.hidePause();
    g.uiMode = 'playing';
    w.update(p.x, p.z, 600);
    for (let i = 0; i < 20; i++) g.stepFrame(1 / 60);
    // capture the frame
    const gl = g.renderer.gl;
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const px2 = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px2);
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(W, H);
    for (let yy = 0; yy < H; yy++) {
      const src = (H - 1 - yy) * W * 4;
      img.data.set(px2.subarray(src, src + W * 4), yy * W * 4);
    }
    ctx.putImageData(img, 0, 0);
    out.url = cv.toDataURL('image/png');
  }
  return out;
})()
