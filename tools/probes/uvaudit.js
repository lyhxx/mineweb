// probe: validate that every emitted vertex's UV lies inside the tile of the block it
// belongs to. Any (0,0)-ish UV means the attribute stream is out of alignment.
(() => {
  const g = window.__MINEWEB__;
  const w = g.world;
  const c = w.getChunkRaw(Math.floor(g.player.x) >> 4, Math.floor(g.player.z) >> 4);
  const d = c.mesh.opaque.data;
  const out = { verts: d.length / 8, bad: [], uvRange: [1, 0, 1, 0], zeros: 0, sampleCounts: {} };
  let checked = 0;
  for (let i = 0; i < d.length; i += 8 * 4) {   // first vertex of each quad
    const u = d[i + 3], v = d[i + 4];
    checked++;
    if (u < out.uvRange[0]) out.uvRange[0] = u;
    if (u > out.uvRange[1]) out.uvRange[1] = u;
    if (v < out.uvRange[2]) out.uvRange[2] = v;
    if (v > out.uvRange[3]) out.uvRange[3] = v;
    if (u === 0 && v === 0) out.zeros++;
    // the local block position
    const lx = d[i], ly = d[i + 1], lz = d[i + 2];
    // expected tile for each of the 6 faces of any block: any multiple of 1/32 offset by inset
    const tu = u * 32, tv = v * 32;
    const key = `${lx},${ly},${lz}`;
    out.sampleCounts[key] = (out.sampleCounts[key] || 0) + 1;
    if (out.bad.length < 8 && (u === 0 || v === 0 || u < 0.0006 || v < 0.0006)) {
      out.bad.push({ i, local: [lx, ly, lz], uv: [Number(u.toFixed(4)), Number(v.toFixed(4))], light: d[i + 5], ao: d[i + 6], shade: d[i + 7] });
    }
  }
  out.checked = checked;
  out.uniquePositions = Object.keys(out.sampleCounts).length;
  // verify the vertex stride by looking for the pattern of a known full cube: 6 quads,
  // 36 vertices whose light/ao/shade fields are all within [0,2]
  let outOfRange = 0;
  for (let i = 0; i < d.length; i += 8) {
    if (d[i + 5] < 0 || d[i + 5] > 2.2) outOfRange++;
    if (d[i + 6] < 0 || d[i + 6] > 1.2) outOfRange++;
    if (d[i + 7] < 0 || d[i + 7] > 1.2) outOfRange++;
  }
  out.outOfRangeFields = outOfRange;
  return out;
})()
