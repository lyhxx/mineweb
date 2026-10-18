// probe: call decorateChunk directly on a stuck chunk and report any exception.
(() => {
  const g = window.__MINEWEB__;
  const w = g.world;
  const chunks = [...w.chunks.values()];
  const target = chunks.find((c) => !c.decorated && w.getChunkRaw(c.cx - 1, c.cz - 1) && w.getChunkRaw(c.cx + 1, c.cz + 1));
  if (!target) return { error: 'no decoratable chunk found', total: chunks.length };
  const before = { decorated: chunks.filter((c) => c.decorated).length };
  let thrown = null;
  let result = null;
  try {
    result = w.gen.decorateChunk(target, w);
  } catch (e) {
    thrown = (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
  }
  return {
    chunk: [target.cx, target.cz],
    neighboursPresent: [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]].every(([dx,dz]) => !!w.getChunkRaw(target.cx+dx, target.cz+dz)),
    returned: result,
    thrown,
    decoratedBefore: before.decorated,
    decoratedAfter: chunks.filter((c) => c.decorated).length,
    lootDrops: w.gen.lootDrops ? w.gen.lootDrops.length : 'none',
    structureChests: w.structureChests ? w.structureChests.size : -1,
  };
})()
