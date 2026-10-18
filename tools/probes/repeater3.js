// probe: minimal lever -> wire -> repeater -> wire -> lamp, with a recompute trace at each
// lever transition.
(async () => {
  const g = window.__MINEWEB__;
  const w = g.world;
  const p = g.player;
  const rs = await import('/js/world/redstone.js');
  const rx = Math.floor(p.x) + 42, rz = Math.floor(p.z) + 42;
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
  const probeValue = () => ({
    pow1: w.getPower(rx + 1, ry, rz),
    pow3: w.getPower(rx + 3, ry, rz),
    lev: w.redstoneState(rx, ry, rz).leverOn,
    repOut: w.redstoneState(rx + 2, ry, rz).repOut,
    traceNodes: rs.lastRecomputeTrace().nodes,
    traceFinal: rs.lastRecomputeTrace().final,
  });
  const out = {};
  // turn ON, then force a recompute directly on the input wire and record the trace
  w.toggleLever(rx, ry, rz);
  w.recomputeRedstone(rx + 1, ry, rz);
  out.onTrace = probeValue();
  // let the repeater fire
  for (let i = 0; i < 10; i++) w.tickRepeaters(0.02);
  out.afterFire = probeValue();
  // turn OFF and record
  w.toggleLever(rx, ry, rz);
  out.offTrace = probeValue();
  w.recomputeRedstone(rx + 1, ry, rz);
  out.offForced = probeValue();
  return out;
})()
