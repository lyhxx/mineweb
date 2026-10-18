// probe: numerically validate the mesher output — looking for garbage vertices,
// out-of-range atlas layers, bad UVs, or malformed quads.
(async () => {
  const g = window.__MINEWEB__;
  const w = g.world;
  const p = g.player;
  const atlas = await import('/js/core/atlas.js');
  const blocks = await import('/js/core/blocks.js');
  const mesherMod = await import('/js/world/mesher.js');

  const cx = Math.floor(p.x) >> 4, cz = Math.floor(p.z) >> 4;
  const chunk = w.getChunkRaw(cx, cz);
  const mesh = w.mesher.mesh(chunk);
  if (!mesh || !mesh.opaque) return { error: 'no mesh' };

  const VF = mesherMod.VERT_FLOATS;
  const data = mesh.opaque.data;
  const verts = mesh.opaque.verts;
  const tileCount = 768;

  const stats = {
    verts,
    floats: data.length,
    expectedFloats: verts * VF,
    nanCount: 0, infCount: 0,
    badLayer: 0,
    badUv: 0,
    outOfBounds: 0,
    minY: Infinity, maxY: -Infinity,
    layerMin: Infinity, layerMax: -Infinity,
    uvMin: Infinity, uvMax: -Infinity,
    lightMin: Infinity, lightMax: -Infinity,
    shadeMin: Infinity, shadeMax: -Infinity,
    sampleBadLayer: [],
  };

  for (let v = 0; v < verts; v++) {
    const o = v * VF;
    for (let k = 0; k < 3; k++) {
      const c = data[o + k];
      if (Number.isNaN(c)) stats.nanCount++;
      else if (!Number.isFinite(c)) stats.infCount++;
    }
    const x = data[o], y = data[o + 1], z = data[o + 2];
    const u = data[o + 3], vv = data[o + 4];
    const light = data[o + 5], ao = data[o + 6], shade = data[o + 7];
    const layer = data[o + 8];
    if (y < stats.minY) stats.minY = y;
    if (y > stats.maxY) stats.maxY = y;
    if (layer < stats.layerMin) stats.layerMin = layer;
    if (layer > stats.layerMax) stats.layerMax = layer;
    if (u < stats.uvMin) stats.uvMin = u;
    if (u > stats.uvMax) stats.uvMax = u;
    if (vv < stats.uvMin) stats.uvMin = vv;
    if (vv > stats.uvMax) stats.uvMax = vv;
    if (light < stats.lightMin) stats.lightMin = light;
    if (light > stats.lightMax) stats.lightMax = light;
    if (shade < stats.shadeMin) stats.shadeMin = shade;
    if (shade > stats.shadeMax) stats.shadeMax = shade;
    if (x < -1 || x > 17 || z < -1 || z > 17 || y < -1 || y > 129) stats.outOfBounds++;
    if (!Number.isInteger(layer) || layer < 0 || layer >= tileCount) {
      stats.badLayer++;
      if (stats.sampleBadLayer.length < 6) stats.sampleBadLayer.push([v, layer]);
    }
    if (u < -0.01 || u > 1.01 || vv < -0.01 || vv > 1.01) stats.badUv++;
    void ao;
  }

  // per-quad structure check: triangles must share the 0-2 diagonal
  let quads = verts / 6;
  let badQuads = 0;
  for (let q = 0; q < Math.min(quads, 4000); q++) {
    const b = q * 6 * VF;
    const P = (i) => [data[b + i * VF], data[b + i * VF + 1], data[b + i * VF + 2]];
    const a0 = P(0), a1 = P(1), a2 = P(2);
    const b0 = P(3), b1 = P(4), b2 = P(5);
    const eq = (p1, p2) => Math.abs(p1[0] - p2[0]) < 1e-4 && Math.abs(p1[1] - p2[1]) < 1e-4 && Math.abs(p1[2] - p2[2]) < 1e-4;
    const ok = eq(a0, b0) && eq(a2, b2);
    if (!ok) badQuads++;
  }
  stats.quads = quads;
  stats.badQuads = badQuads;

  // how many blocks in this chunk are of each id (to correlate corruption with a block)
  const hist = {};
  for (let i = 0; i < chunk.blocks.length; i++) {
    const id = chunk.blocks[i];
    if (!id) continue;
    hist[id] = (hist[id] || 0) + 1;
  }
  stats.blockHistogram = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 10);
  stats.tileCount = blocks.BLOCKS.length;
  stats.maxTile = blocks.MAX_TILE_INDEX;
  void atlas;
  return stats;
})()
