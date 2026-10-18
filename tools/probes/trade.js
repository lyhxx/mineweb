// probe: place a villager in front of the player and open the trade window.
(() => {
  const g = window.__MINEWEB__;
  const p = g.player;
  const w = g.world;
  const inv = g.player.inventory;

  // flatten a spot and put the player looking at it
  const tx = Math.floor(p.x), tz = Math.floor(p.z) - 3;
  const ty = w.findSurfaceY(tx, tz);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -4; dz <= 2; dz++) {
      for (let dy = 0; dy <= 5; dy++) w.setBlockAt(tx + dx, ty + dy, tz + dz, 0);
      w.setBlockAt(tx + dx, ty - 1, tz + dz, 2);
    }
  }
  // a villager (with a fixed seed, so the same trades every run)
  const villager = g.spawnMobForTests('villager', tx + 0.5, ty, tz + 0.5);
  villager.seed = 4242;
  g.mobs.push(villager);

  // give the player plenty of the currency so the offers light up
  inv.slots.fill(null);
  inv.add(g.idsForProbe ? g.idsForProbe().emerald : -12, 24);
  inv.add(g.idsForProbe ? g.idsForProbe().iron_ingot : -4, 16);
  inv.add(g.idsForProbe ? g.idsForProbe().wheat : -12, 32);
  p.level = 12;

  p.x = tx + 0.5; p.z = tz + 3.5; p.y = ty + 0.2;
  p.yaw = 0; p.pitch = -0.12;
  w.update(p.x, p.z, 600);
  for (let i = 0; i < 20; i++) g.stepFrame(1 / 60);
  g.openTrade(villager);

  return {
    profession: villager.profession ? villager.profession.cn : null,
    offers: (villager.offers || []).map((o) => `${o.give.key}x${o.give.count} -> ${o.get.key}x${o.get.count} (${o.uses}/${o.max})`),
  };
})()
