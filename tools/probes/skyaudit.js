// probe: how much of the chunk's air has full skylight? A correct fill should give 15 to
// (almost) every air cell above the terrain surface.
(() => {
  const g = window.__MINEWEB__;
  const w = g.world;
  const c = w.getChunkRaw(Math.floor(g.player.x) >> 4, Math.floor(g.player.z) >> 4);
  let air = 0, airSky15 = 0, airSky0 = 0, airAboveSurface = 0, aboveSky15 = 0;
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      const surf = c.heightMap[z * 16 + x];
      for (let y = 0; y < 128; y++) {
        const b = c.blocks[(y * 16 + z) * 16 + x];
        const sky = c.skyLight[(y * 16 + z) * 16 + x];
        if (b === 0) {
          air++;
          if (sky === 15) airSky15++;
          if (sky === 0) airSky0++;
          if (y >= surf) {
            airAboveSurface++;
            if (sky === 15) aboveSky15++;
          }
        }
      }
    }
  }
  // sample a few specific columns
  const samples = [];
  for (const [x, z] of [[0, 0], [8, 8], [15, 15], [4, 12]]) {
    const surf = c.heightMap[z * 16 + x];
    const col = [];
    for (let y = Math.max(0, surf - 1); y <= Math.min(127, surf + 3); y++) {
      col.push({ y, b: c.blocks[(y * 16 + z) * 16 + x], sky: c.skyLight[(y * 16 + z) * 16 + x] });
    }
    samples.push({ x, z, surf, col });
  }
  return {
    air, airSky15, airSky0,
    airAboveSurface, aboveSky15,
    aboveRatio: Number((aboveSky15 / Math.max(1, airAboveSurface)).toFixed(3)),
    samples,
    chunkLit: c.lit,
  };
})()
