// probe: minimal torch-light trace — no manual queue draining.
(() => {
  const g = window.__MINEWEB__;
  const w = g.world;
  const p = g.player;
  const out = {};
  const bx = Math.floor(p.x), bz = Math.floor(p.z);
  const by = w.findSurfaceY(bx, bz);
  // carve room
  for (let dx = -1; dx <= 6; dx++) {
    for (let dy = 0; dy <= 2; dy++) {
      for (let dz = -1; dz <= 1; dz++) w.setBlockAt(bx + dx, by + dy, bz + dz, 0);
    }
  }
  out.torchPlaced = w.setBlockAt(bx + 3, by, bz, 30);
  out.queueAfterPlace = w.lightQueue.length;
  const targetChunk = w.getChunkRaw((bx + 3) >> 4, bz >> 4);
  out.sameRef = w.lightQueue.includes(targetChunk);
  out.litBefore = targetChunk.lit;
  const t0 = performance.now();
  w.update(p.x, p.z, 300);
  out.updateMs = Number((performance.now() - t0).toFixed(1));
  out.queueAfterUpdate = w.lightQueue.length;
  out.litAfter = targetChunk.lit;
  const cxT = (bx + 3) >> 4, czT = bz >> 4;
  const lx = (bx + 3) - cxT * 16, lz = bz - czT * 16;
  out.torchLocal = [lx, by, lz];
  out.lightAt = targetChunk.light[(by * 16 + lz) * 16 + lx];
  let maxL = 0;
  for (let y = 0; y < 128; y++) {
    for (let z2 = 0; z2 < 16; z2++) for (let x2 = 0; x2 < 16; x2++) {
      const v = targetChunk.light[(y * 16 + z2) * 16 + x2];
      if (v > maxL) maxL = v;
    }
  }
  out.chunkMaxLight = maxL;
  out.lightQueueLen = w.lightQueue.length;
  // what does lighting think the emissive source is?
  out.torchLightValue = 14;
  out.blockIdAtTorch = w.getBlockRaw(bx + 3, by, bz);
  return out;
})()
