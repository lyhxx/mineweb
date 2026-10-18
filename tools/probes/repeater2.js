// probe: full repeater circuit, instrumented at every step, to find where stale power lives.
(async () => {
  const g = window.__MINEWEB__;
  const rs = await import('/js/world/redstone.js');
  const w = g.world;
  const p = g.player;
  const rx = Math.floor(p.x) + 38, rz = Math.floor(p.z) + 38;
  const ry = w.findSurfaceY(rx, rz);
  for (let dx = -1; dx <= 6; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = 0; dy <= 3; dy++) w.setBlockAt(rx + dx, ry + dy, rz + dz, 0);
      w.setBlockAt(rx + dx, ry - 1, rz + dz, 2);
      w.setPower(rx + dx, ry, rz + dz, 0);
    }
  }
  w.setBlockAt(rx, ry, rz, 69);
  w.setBlockAt(rx + 1, ry, rz, 67);
  w.setBlockAt(rx + 2, ry, rz, 79);
  w.setFacing(rx + 2, ry, rz, 0);
  w.setBlockAt(rx + 3, ry, rz, 67);
  w.setBlockAt(rx + 4, ry, rz, 72);
  const out = [];
  const shot = (tag) => out.push({
    tag,
    ids: [0, 1, 2, 3, 4].map((i) => w.getBlockRaw(rx + i, ry, rz)),
    pow: [0, 1, 2, 3, 4].map((i) => w.getPower(rx + i, ry, rz)),
    levOn: w.redstoneState(rx, ry, rz).leverOn,
    repOut: w.redstoneState(rx + 2, ry, rz).repOut,
  });
  shot('start');
  w.toggleLever(rx, ry, rz);
  shot('on');
  for (let i = 0; i < 10; i++) w.tickRepeaters(0.02);
  shot('fired');
  w.toggleLever(rx, ry, rz);
  shot('off');
  // force a fresh recompute anchored on the input wire and see if it clears
  w.recomputeRedstone(rx + 1, ry, rz);
  shot('after-forced-recompute');
  const trace = rs.lastRecomputeTrace();
  for (let i = 0; i < 10; i++) w.tickRepeaters(0.02);
  shot('off-fired');
  return { out, trace };
})()
