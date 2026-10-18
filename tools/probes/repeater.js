// probe: isolate a single repeater circuit and watch every transition.
(() => {
  const g = window.__MINEWEB__;
  const w = g.world;
  const p = g.player;
  const rx = Math.floor(p.x) + 30, rz = Math.floor(p.z) + 30;
  const ry = w.findSurfaceY(rx, rz);
  for (let dx = -1; dx <= 6; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = 0; dy <= 3; dy++) w.setBlockAt(rx + dx, ry + dy, rz + dz, 0);
      w.setBlockAt(rx + dx, ry - 1, rz + dz, 2);
      w.setPower(rx + dx, ry, rz + dz, 0);
    }
  }
  const lever = 69, wire = 67, rep = 79, lamp = 72, lampLit = 73;
  w.setBlockAt(rx, ry, rz, lever);
  w.setBlockAt(rx + 1, ry, rz, wire);
  w.setBlockAt(rx + 2, ry, rz, rep);
  w.setFacing(rx + 2, ry, rz, 0);
  w.setBlockAt(rx + 3, ry, rz, wire);
  w.setBlockAt(rx + 4, ry, rz, lamp);

  const snap = (tag) => ({
    tag,
    ids: [0, 1, 2, 3, 4].map((i) => w.getBlockRaw(rx + i, ry, rz)),
    powers: [0, 1, 2, 3, 4].map((i) => w.getPower(rx + i, ry, rz)),
    lever: { ...w.redstoneState(rx, ry, rz) },
    rep: { ...w.redstoneState(rx + 2, ry, rz) },
  });
  const log = [snap('initial')];
  w.toggleLever(rx, ry, rz);
  log.push(snap('lever-on'));
  for (let i = 0; i < 10; i++) w.tickRepeaters(0.02);
  log.push(snap('after-10-ticks'));
  w.toggleLever(rx, ry, rz);
  log.push(snap('lever-off'));
  for (let i = 0; i < 10; i++) w.tickRepeaters(0.02);
  log.push(snap('after-off-10-ticks'));
  return { log, ids: { lever, wire, rep, lamp, lampLit } };
})()
