// probe: dump the first few raw quads from the mesher so the vertex layout can be seen.
(async () => {
  const g = window.__MINEWEB__;
  const w = g.world;
  const p = g.player;
  const mesherMod = await import('/js/world/mesher.js');
  const cx = Math.floor(p.x) >> 4, cz = Math.floor(p.z) >> 4;
  const chunk = w.getChunkRaw(cx, cz);
  const mesh = w.mesher.mesh(chunk);
  const VF = mesherMod.VERT_FLOATS;
  const d = mesh.opaque.data;
  const quadsDump = [];
  for (let q = 0; q < 3; q++) {
    const verts = [];
    for (let i = 0; i < 6; i++) {
      const o = q * 6 * VF + i * VF;
      verts.push([+d[o].toFixed(3), +d[o + 1].toFixed(3), +d[o + 2].toFixed(3),
        +d[o + 3].toFixed(3), +d[o + 4].toFixed(3),
        +d[o + 5].toFixed(3), +d[o + 6].toFixed(3), +d[o + 7].toFixed(3), d[o + 8]]);
    }
    quadsDump.push(verts);
  }
  return { VF, totalVerts: mesh.opaque.verts, quads: quadsDump };
})()
