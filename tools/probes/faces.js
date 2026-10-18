// probe: how many faces exist in the world vs how many the mesher emits?
(() => {
  const g = window.__MINEWEB__;
  const w = g.world;
  // Count the faces a single chunk's mesh actually contains vs its block content.
  const c = w.getChunkRaw(Math.floor(g.player.x) >> 4, Math.floor(g.player.z) >> 4);
  let solid = 0, exposed = 0, air = 0;
  const opaque = (x, y, z) => {
    const v = w.getBlockRaw(x, y, z);
    return v !== 0 && (v & 31) !== 9 && (v & 31) !== 10 && (v & 31) !== 7 && (v & 31) !== 18 && (v & 31) !== 30 && (v & 31) !== 31;
  };
  const ox = c.cx * 16, oz = c.cz * 16;
  for (let y = 0; y < 128; y++) {
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        const v = c.blocks[(y * 16 + lz) * 16 + lx];
        if (v === 0) { air++; continue; }
        solid++;
        const x = ox + lx, z = oz + lz;
        for (const [dx, dy, dz] of [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, -1, 0]]) {
          if (!opaque(x + dx, y + dy, z + dz)) exposed++;
        }
      }
    }
  }
  const slot = c._opaque;
  return {
    chunk: [c.cx, c.cz],
    solidBlocks: solid,
    airBlocks: air,
    exposedFaces: exposed,
    meshQuads: slot ? slot.quads : -1,
    ratio: slot && exposed ? Number((slot.quads / exposed).toFixed(3)) : -1,
    surfaceY: w.findSurfaceY(Math.floor(g.player.x), Math.floor(g.player.z)),
    playerY: g.player.y,
    column: (() => { const out = []; const px = Math.floor(g.player.x), pz = Math.floor(g.player.z);
      for (let y = 60; y <= 70; y++) out.push(w.getBlockRaw(px, y, pz)); return out; })(),
  };
})()
