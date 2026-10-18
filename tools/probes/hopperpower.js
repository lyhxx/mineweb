// probe: check what power a hopper sees beside a redstone block, and whether it freezes.
(async () => {
  const g = window.__MINEWEB__;
  const w = g.world;
  const p = g.player;
  const blocks = await import('/js/core/blocks.js');
  const rs = await import('/js/world/redstone.js');

  const hx = Math.floor(p.x) + 20, hz = Math.floor(p.z) + 20;
  const hy = w.findSurfaceY(hx, hz);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = 0; dy <= 3; dy++) w.setBlockAt(hx + dx, hy + dy, hz + dz, 0);
      w.setBlockAt(hx + dx, hy - 1, hz + dz, blocks.idOf('stone'));
    }
  }
  const hopper = blocks.idOf('hopper');
  const rb = blocks.idOf('redstone_block');
  w.setBlockAt(hx, hy + 1, hz, hopper);
  const beforePower = w.getPower(hx, hy + 1, hz);
  w.setBlockAt(hx - 1, hy + 1, hz, rb);
  const idBeside = blocks.baseId(w.getBlockRaw(hx - 1, hy + 1, hz));
  const powerAtDirect = rs.powerAt(w, hx, hy + 1, hz);
  const afterPower = w.getPower(hx, hy + 1, hz);
  const isComp = rs.isRedstoneComponent(idBeside);
  return {
    hopperId: hopper, redstoneBlockId: rb, idBeside,
    beforePower, afterPower, powerAtDirect, isComp,
    // force a recompute anchored on the hopper itself
    afterRecompute: (() => { w.recomputeRedstone(hx, hy + 1, hz); return w.getPower(hx, hy + 1, hz); })(),
  };
})()
