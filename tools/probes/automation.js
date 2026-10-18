// probe: build a hopper chain (chest -> hopper -> chest) plus a repeater delay line, then
// render it so the shot shows the automation setup.
(() => {
  const g = window.__MINEWEB__;
  const p = g.player;
  const w = g.world;
  const inv = g.player.inventory;

  const rx = Math.floor(p.x);
  const rz = Math.floor(p.z) - 9;
  const ry = w.findSurfaceY(rx, rz);
  for (let dx = -7; dx <= 8; dx++) {
    for (let dz = -3; dz <= 7; dz++) {
      for (let dy = 0; dy <= 6; dy++) w.setBlockAt(rx + dx, ry + dy, rz + dz, 0);
      w.setBlockAt(rx + dx, ry - 1, rz + dz, 2);
    }
  }
  const chest = 29, hopper = 77, wire = 67, lever = 69, lamp = 72, rep = 79, piston = 74;
  // chest -> hopper -> chest chain
  w.setBlockAt(rx - 5, ry + 2, rz, chest);
  w.setBlockAt(rx - 5, ry + 1, rz, hopper);
  w.setFacing(rx - 5, ry + 1, rz, 5);        // faces down
  w.setBlockAt(rx - 5, ry, rz, chest);
  // put items in the top chest so the hopper visibly has work to do
  const src = w.containerAt('chest', rx - 5, ry + 2, rz, true);
  const dust = g.resolveKeyForTests('redstone_dust');
  src[0] = { id: dust, count: 24, durability: null, ench: null };
  // a repeater delay line: lever -> wire -> repeater -> wire -> lamp
  w.setBlockAt(rx + 1, ry, rz + 4, lever);
  w.setBlockAt(rx + 2, ry, rz + 4, wire);
  w.setBlockAt(rx + 3, ry, rz + 4, rep); w.setFacing(rx + 3, ry, rz + 4, 0);
  w.setBlockAt(rx + 4, ry, rz + 4, wire);
  w.setBlockAt(rx + 5, ry, rz + 4, lamp);
  w.toggleLever(rx + 1, ry, rz + 4);
  for (let i = 0; i < 12; i++) w.tickRepeaters(0.02);

  inv.slots.fill(null);
  [['redstone_dust', 32], ['hopper_item', 2], ['repeater_item', 2], ['redstone_lamp', 4],
    ['piston_item', 2], ['lever', 4], ['chest', 2]].forEach(([k, n], i) => {
    const id = g.resolveKeyForTests(k);
    if (id) inv.slots[i] = { id, count: n, durability: null, ench: null };
  });

  p.x = rx; p.z = rz + 9; p.y = ry + 3.4;
  p.yaw = Math.PI; p.pitch = -0.40;
  w.viewDistance = 12;
  w.update(p.x, p.z, 900);
  for (let i = 0; i < 24; i++) g.stepFrame(1 / 60);

  return {
    hopperRegistered: w.hopperPositions.size,
    lampLit: w.getBlockRaw(rx + 5, ry, rz + 4) === 73,
    repOut: w.redstoneState(rx + 3, ry, rz + 4).repOut,
    outWirePower: w.getPower(rx + 4, ry, rz + 4),
    hopperItemCount: (w.containerAt('hopper', rx - 5, ry + 1, rz, false) || []).filter(Boolean).reduce((n, s) => n + s.count, 0),
  };
})()
