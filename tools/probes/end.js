// probe: go to the End, stand near the dragon, and open the boss bar so the shot shows
// the dimension, the pillars and the boss HUD.
(() => {
  const g = window.__MINEWEB__;
  const w0 = g.world;

  // travel to the End (builds the island, pillars, crystals and the dragon)
  g.travelTo('end', 0, 0);
  const w = g.world;
  w.update(0, 0, 800);

  // put the dragon in view, in front of the player
  const p = g.player;
  if (g.boss) {
    g.boss.x = 0; g.boss.y = 70; g.boss.z = -30;
    g.boss.hp = 140;
    g.boss.vx = g.boss.vy = g.boss.vz = 0;
  }
  p.x = 0.5; p.y = 64; p.z = 4.5;
  p.yaw = 0; p.pitch = -0.08;
  g.uiMode = 'playing';
  g.hud.hidePause();
  w.update(p.x, p.z, 900);
  for (let i = 0; i < 30; i++) {
    if (g.boss) { g.boss.x = 0; g.boss.y = 70; g.boss.z = -30; g.boss.vx = g.boss.vy = g.boss.vz = 0; }
    g.stepFrame(1 / 60);
  }
  // step the camera one more frame with everything settled
  g.stepFrame(1 / 60);

  const blocks = {};
  for (let dx = -20; dx <= 20; dx += 2) {
    for (let dz = -40; dz <= 20; dz += 2) {
      for (let y = 55; y < 110; y += 2) {
        const id = w.getBlockRaw(dx, y, dz);
        if (id) blocks[id] = (blocks[id] || 0) + 1;
      }
    }
  }
  void w0;
  return {
    dimension: w.dimension,
    dragonHp: g.boss ? g.boss.hp : null,
    crystals: (g.dragonCrystals || []).length,
    bossBarVisible: !document.getElementById('boss-bar').classList.contains('hidden'),
    blocks,
  };
})()
