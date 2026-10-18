// probe: build a redstone demo in front of the camera — lever, wire run, lamp, and a
// piston pushing a block — then light it and render.
(() => {
  const g = window.__MINEWEB__;
  const p = g.player;
  const w = g.world;
  const inv = g.player.inventory;

  const rx = Math.floor(p.x);
  const rz = Math.floor(p.z) - 10;
  const ry = w.findSurfaceY(rx, rz);
  // clean platform
  for (let dx = -6; dx <= 8; dx++) {
    for (let dz = -4; dz <= 6; dz++) {
      for (let dy = 0; dy <= 5; dy++) w.setBlockAt(rx + dx, ry + dy, rz + dz, 0);
      w.setBlockAt(rx + dx, ry - 1, rz + dz, 2);
    }
  }
  const wire = 67, lever = 69, lamp = 72, piston = 74, cobble = 3;
  // main run: lever -> 8 wire -> lamp
  w.setBlockAt(rx - 4, ry, rz, lever);
  for (let i = -3; i <= 4; i++) { w.setBlockAt(rx + i, ry, rz, wire); w.setFacing(rx + i, ry, rz, 0); }
  w.setBlockAt(rx + 5, ry, rz, lamp);
  // branch: wire across to a piston that pushes cobblestone
  w.setBlockAt(rx - 4, ry, rz + 2, wire); w.setFacing(rx - 4, ry, rz + 2, 0);
  w.setBlockAt(rx - 3, ry, rz + 2, wire); w.setFacing(rx - 3, ry, rz + 2, 0);
  w.setBlockAt(rx - 3, ry, rz + 1, wire); w.setFacing(rx - 3, ry, rz + 1, 0);
  w.setBlockAt(rx - 2, ry, rz + 1, piston); w.setFacing(rx - 2, ry, rz + 1, 0);
  w.setBlockAt(rx - 1, ry, rz + 1, cobble);
  // a second lamp fed by a redstone torch
  w.setBlockAt(rx + 2, ry, rz + 3, 68);
  w.setBlockAt(rx + 3, ry, rz + 3, wire); w.setFacing(rx + 3, ry, rz + 3, 0);
  w.setBlockAt(rx + 4, ry, rz + 3, lamp);

  // throw the lever so everything is live
  w.toggleLever(rx - 4, ry, rz);

  inv.slots.fill(null);
  [['redstone_dust', 32], ['lever', 4], ['stone_button', 4], ['pressure_plate', 4],
    ['redstone_lamp', 4], ['piston_item', 2], ['redstone_torch', 4]].forEach(([k, n], i) => {
    const id = g.resolveKeyForTests(k);
    if (id) inv.slots[i] = { id, count: n, durability: null, ench: null };
  });

  p.x = rx + 1; p.z = rz + 7; p.y = ry + 3.2;
  p.yaw = Math.PI; p.pitch = -0.42;
  w.viewDistance = 12;
  w.update(p.x, p.z, 1200);
  for (let i = 0; i < 24; i++) g.stepFrame(1 / 60);

  const powerRun = [];
  for (let i = -3; i <= 5; i++) powerRun.push(w.getPower(rx + i, ry, rz));
  return {
    powerRun,
    lampLit: w.getBlockRaw(rx + 5, ry, rz) === 73,
    torchLampLit: w.getBlockRaw(rx + 4, ry, rz + 3) === 73,
    pistonExtended: w.getBlockRaw(rx - 2, ry, rz + 1) === 75,
    pushed: w.getBlockRaw(rx - 1, ry, rz + 1) === 3,
  };
})()
