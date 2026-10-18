// probe: histogram of baked vertex light/AO/shade, correlated with block parity.
// If every other block is darker, the light sampling is position-dependent.
(() => {
  const g = window.__MINEWEB__;
  const w = g.world;
  const c = w.getChunkRaw(Math.floor(g.player.x) >> 4, Math.floor(g.player.z) >> 4);
  const d = c.mesh.opaque.data;
  const lightHist = {};
  const byParity = { even: { sum: 0, n: 0, min: 9, max: 0 }, odd: { sum: 0, n: 0, min: 9, max: 0 } };
  let zero = 0, total = 0;
  for (let i = 0; i < d.length; i += 8 * 4) {          // first vertex of each quad
    const lx = d[i], wy = d[i + 1], lz = d[i + 2];
    const light = d[i + 5], ao = d[i + 6], shade = d[i + 7];
    const key = light.toFixed(3) + '/' + ao.toFixed(2) + '/' + shade.toFixed(2);
    lightHist[key] = (lightHist[key] || 0) + 1;
    const bucket = ((Math.round(lx) + Math.round(lz)) % 2 === 0) ? byParity.even : byParity.odd;
    bucket.sum += light; bucket.n++;
    if (light < bucket.min) bucket.min = light;
    if (light > bucket.max) bucket.max = light;
    if (light <= 0.0501) zero++;
    total++;
  }
  return {
    quads: total,
    minLightQuads: zero,
    parity: {
      even: { avg: Number((byParity.even.sum / Math.max(1, byParity.even.n)).toFixed(3)), min: Number(byParity.even.min.toFixed(3)), max: Number(byParity.even.max.toFixed(3)), n: byParity.even.n },
      odd: { avg: Number((byParity.odd.sum / Math.max(1, byParity.odd.n)).toFixed(3)), min: Number(byParity.odd.min.toFixed(3)), max: Number(byParity.odd.max.toFixed(3)), n: byParity.odd.n },
    },
    topLightCombos: Object.entries(lightHist).sort((a, b) => b[1] - a[1]).slice(0, 8),
    chunkLit: c.lit,
    skySampleAtSurface: (() => {
      const p = g.player;
      const x = Math.floor(p.x), z = Math.floor(p.z);
      const y = w.findSurfaceY(x, z);
      const i = (y * 16 + (z - ((z >> 4) << 4))) * 16 + (x - ((x >> 4) << 4));
      const cc = w.getChunkRaw(x >> 4, z >> 4);
      return { sky: cc.skyLight[i], blk: cc.light[i] };
    })(),
  };
})()
