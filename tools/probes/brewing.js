// probe: fill a brewing stand with a live brew in progress and show the effect chips.
(() => {
  const g = window.__MINEWEB__;
  const p = g.player;
  const w = g.world;
  const inv = g.player.inventory;

  // flatten a spot and place a brewing stand
  const tx = Math.floor(p.x), tz = Math.floor(p.z) - 3;
  const ty = w.findSurfaceY(tx, tz);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -4; dz <= 2; dz++) {
      for (let dy = 0; dy <= 5; dy++) w.setBlockAt(tx + dx, ty + dy, tz + dz, 0);
      w.setBlockAt(tx + dx, ty - 1, tz + dz, 2);
    }
  }
  w.setBlockAt(tx, ty, tz, 64);          // brewing stand

  // load the stand mid-brew: nether wart + three water bottles
  inv.slots.fill(null);
  const wart = -78;
  const water = inv.add; // placeholder to keep the linter quiet
  void water;
  const ids = {};
  for (const key of ['nether_wart', 'water_bottle', 'glowstone_dust', 'sugar', 'empty_bottle']) {
    // resolve through the inventory's own helper path
    ids[key] = g.resolveKeyForTests ? g.resolveKeyForTests(key) : 0;
  }
  inv.brewing = { ingredient: null, bottles: [null, null, null], progress: 13, total: 20 };
  if (ids.nether_wart) inv.brewing.ingredient = { id: ids.nether_wart, count: 3, durability: null };
  for (let i = 0; i < 3; i++) {
    if (ids.water_bottle) inv.brewing.bottles[i] = { id: ids.water_bottle, count: 1, durability: null };
  }
  // some bottles and ingredients in the pack so the slots look populated
  let slot = 0;
  for (const key of ['empty_bottle', 'glowstone_dust', 'sugar', 'nether_wart', 'blaze_powder']) {
    if (ids[key]) { inv.slots[slot++] = { id: ids[key], count: 4, durability: null }; }
  }
  // and give the player two active effects so the chips render
  p.effects.clear();
  p.effects.apply('night_vision', 1, 180);
  p.effects.apply('strength', 2, 80);
  p.effects.apply('poison', 1, 45);
  g.hud.refreshEffects(g.activeEffects());

  p.x = tx + 0.5; p.z = tz + 3.5; p.y = ty + 0.2;
  p.yaw = 0; p.pitch = -0.18;
  w.update(p.x, p.z, 600);
  for (let i = 0; i < 20; i++) g.stepFrame(1 / 60);
  g.openBrewing();

  return {
    standBlock: w.getBlockRaw(tx, ty, tz),
    ingredient: inv.brewing.ingredient ? inv.brewing.ingredient.id : null,
    bottles: inv.brewing.bottles.map((b) => (b ? b.id : null)),
    effects: g.activeEffects().map((e) => `${e.cn}${e.level > 1 ? ' II' : ''} ${Math.round(e.time)}s`),
  };
})()
