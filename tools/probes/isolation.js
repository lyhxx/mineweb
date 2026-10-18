// probe: find what is actually powering the input wire — dump every neighbouring block.
(() => {
  const g = window.__MINEWEB__;
  const w = g.world;
  const p = g.player;
  const rx = Math.floor(p.x) + 50, rz = Math.floor(p.z) + 50;
  const ry = w.findSurfaceY(rx, rz);
  // a generous clean area so nothing from another probe can interfere
  for (let dx = -6; dx <= 10; dx++) {
    for (let dz = -6; dz <= 6; dz++) {
      for (let dy = -1; dy <= 8; dy++) w.setBlockAt(rx + dx, ry + dy, rz + dz, 0);
      w.setBlockAt(rx + dx, ry - 1, rz + dz, 2);
      for (let dy = 0; dy <= 8; dy++) w.setPower(rx + dx, ry + dy, rz + dz, 0);
    }
  }
  w.setBlockAt(rx, ry, rz, 69);      // lever
  w.setBlockAt(rx + 1, ry, rz, 67);  // wire
  // enumerate every non-air block within 3 of the wire, by id
  const around = {};
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      for (let dz = -3; dz <= 3; dz++) {
        const id = w.getBlockRaw(rx + 1 + dx, ry + dy, rz + dz);
        if (id) around[id] = (around[id] || 0) + 1;
      }
    }
  }
  return { around, wirePower: w.getPower(rx + 1, ry, rz), leverOn: w.redstoneState(rx, ry, rz).leverOn };
})()
