// probe: read skyLight/blockLight along a known surface column and at the neighbouring
// block faces the mesher samples.
(() => {
  const g = window.__MINEWEB__;
  const w = g.world;
  const p = g.player;
  const x = Math.floor(p.x), z = Math.floor(p.z);
  const cx = x >> 4, cz = z >> 4;
  const c = w.getChunkRaw(cx, cz);
  const lx = x - cx * 16, lz = z - cz * 16;
  const idx = (yy, zz, xx) => (yy * 16 + zz) * 16 + xx;
  const column = [];
  const sy = w.findSurfaceY(x, z);
  for (let y = Math.max(0, sy - 4); y <= Math.min(127, sy + 4); y++) {
    column.push({
      y,
      block: w.getBlockRaw(x, y, z),
      sky: c.skyLight[idx(y, lz, lx)],
      blk: c.light[idx(y, lz, lx)],
    });
  }
  // neighbour columns too, to see how skylight varies across the surface
  const neighbours = [];
  for (const [dx, dz] of [[1, 0], [0, 1], [1, 1], [-1, 0]]) {
    const nx = x + dx, nz = z + dz;
    const nc = w.getChunkRaw(nx >> 4, nz >> 4);
    const nlx = nx - ((nx >> 4) * 16), nlz = nz - ((nz >> 4) * 16);
    const nsy = w.findSurfaceY(nx, nz);
    neighbours.push({
      dx, dz, surfaceY: nsy,
      skyAbove: nc ? nc.skyLight[idx(Math.min(127, nsy), nlz, nlx)] : -1,
      skyAtFace: nc ? nc.skyLight[idx(Math.min(127, nsy + 1), nlz, nlx)] : -1,
    });
  }
  return { columnAt: [x, z], surfaceY: sy, column, neighbours, chunkLit: c.lit };
})()
