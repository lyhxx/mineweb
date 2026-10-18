// probe: does turning a lever OFF clear the wire it powers? Minimal two-cell circuit.
(async () => {
  const g = window.__MINEWEB__;
  const R = await import('/js/world/redstone.js');
  const w = g.world;
  const p = g.player;
  const rx = Math.floor(p.x) + 34, rz = Math.floor(p.z) + 34;
  const ry = w.findSurfaceY(rx, rz);
  for (let dx = -1; dx <= 4; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = 0; dy <= 3; dy++) w.setBlockAt(rx + dx, ry + dy, rz + dz, 0);
      w.setBlockAt(rx + dx, ry - 1, rz + dz, 2);
      w.setPower(rx + dx, ry, rz + dz, 0);
    }
  }
  w.setBlockAt(rx, ry, rz, 69);            // lever
  w.setBlockAt(rx + 1, ry, rz, 67);        // wire
  const rs = null;
  const out = [];
  const shot = (tag) => out.push({ tag, wire: w.getPower(rx + 1, ry, rz), lever: { ...w.redstoneState(rx, ry, rz) } });
  shot('start');
  w.toggleLever(rx, ry, rz);
  shot('on');
  w.toggleLever(rx, ry, rz);
  shot('off');
  w.toggleLever(rx, ry, rz);
  shot('on2');
  w.toggleLever(rx, ry, rz);
  shot('off2');
  return { out, nearIds: [1, 2, 3].map((d) => g.world.getBlockRaw(rx + d, ry, rz)), leverId: 69, wireId: 67, srcAtWireWhenOff: 'n/a' };
})()
