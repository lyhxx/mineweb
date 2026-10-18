// probe: wait for a fully loaded world, then run the lever->wire->repeater->wire->lamp
// circuit with a full trace at each stage.
(async () => {
  const g = window.__MINEWEB__;
  const w = g.world;
  const p = g.player;
  const rs = await import('/js/world/redstone.js');
  const rx = Math.floor(p.x) + 60, rz = Math.floor(p.z) + 60;
  const ry = w.findSurfaceY(rx, rz);
  // clean generously and wait for the chunks to exist
  for (let dx = -6; dx <= 12; dx++) {
    for (let dz = -6; dz <= 6; dz++) {
      for (let dy = -1; dy <= 8; dy++) { w.setBlockAt(rx + dx, ry + dy, rz + dz, 0); w.setPower(rx + dx, ry + dy, rz + dz, 0); }
      w.setBlockAt(rx + dx, ry - 1, rz + dz, 2);
    }
  }
  w.update(rx, rz, 800);
  const lever = 69, wire = 67, rep = 79, lamp = 72;
  w.setBlockAt(rx, ry, rz, lever);
  w.setBlockAt(rx + 1, ry, rz, wire);
  w.setBlockAt(rx + 2, ry, rz, rep);
  w.setFacing(rx + 2, ry, rz, 0);
  w.setBlockAt(rx + 3, ry, rz, wire);
  w.setBlockAt(rx + 4, ry, rz, lamp);
  const dump = () => ({
    ids: [0, 1, 2, 3, 4].map((i) => w.getBlockRaw(rx + i, ry, rz)),
    pow: [0, 1, 2, 3, 4].map((i) => w.getPower(rx + i, ry, rz)),
    lev: w.redstoneState(rx, ry, rz).leverOn,
    repOut: w.redstoneState(rx + 2, ry, rz).repOut,
    powerAtWire: rs.powerAt(w, rx + 1, ry, rz),
  });
  const out = { start: dump() };
  w.toggleLever(rx, ry, rz);
  out.on = dump();
  for (let i = 0; i < 12; i++) w.tickRepeaters(0.02);
  out.fired = dump();
  w.toggleLever(rx, ry, rz);
  out.off = dump();
  out.powerAtWireAfterOff = rs.powerAt(w, rx + 1, ry, rz);
  out.leverCellState = { ...w.redstoneState(rx, ry, rz) };
  out.leverBlockId = w.getBlockRaw(rx, ry, rz);
  // is anything on the input side of the wire?
  out.neighbours = [];
  for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0],[0,-1,0]]) {
    const id = w.getBlockRaw(rx + 1 + dx, ry + dy, rz + dz);
    out.neighbours.push([dx, dy, dz, id, id ? (id === wire ? 'wire' : id === rep ? 'repeater' : id === lever ? 'lever' : 'other') : 'air']);
  }
  return out;
})()
