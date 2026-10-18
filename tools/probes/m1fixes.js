// probe: M1 sandbox fixes — creative palette, pickup, mob heading, fishing, shield.
(() => {
  const g = window.__MINEWEB__;
  const p = g.player;
  const inv = p.inventory;
  const out = {};
  const wasCreative = inv.creative;
  const savedSlots = inv.slots.map((s) => s);
  const savedSel = inv.selected;
  const savedHealth = p.health;

  inv.creative = true;
  inv.slots.fill(null);
  inv.giveCreativePalette();
  out.paletteFilled = inv.slots.filter(Boolean).length;
  out.paletteBlocks = new Set(inv.slots.filter(Boolean).map((s) => s.id)).size;

  // build real ItemStacks (plain objects lack enchLevel etc.)
  inv.slots.fill(null); inv.selected = 0; inv.add(1, 64);
  inv.consumeHeld(); inv.consumeHeld(); inv.consumeHeld();
  out.creativeCountAfter = inv.slots[0].count;

  const realRay = g.raycastHit;
  g.raycastHit = () => ({ id: 3, x: 0, y: 0, z: 0 });
  inv.slots[0] = null; inv.selected = 0;
  g.pickBlock();
  out.pickCount = inv.slots[0] ? inv.slots[0].count : 0;
  g.raycastHit = realRay;

  inv.creative = false;
  inv.slots.fill(null); inv.selected = 0; inv.add(1, 5);
  inv.consumeHeld();
  out.survivalCountAfter = inv.slots[0] ? inv.slots[0].count : -1;

  inv.slots.fill(null);
  p.dead = false;
  p.health = 20;
  const drop = g.itemEntityForTests(1, 4, p.x + 2.4, p.y + 0.5, p.z);
  drop.pickupDelay = 0;
  g.items.push(drop);
  const before = inv.count(1);
  for (let i = 0; i < 90; i++) g.stepFrame(1 / 60);
  out.pickupGained = inv.count(1) - before;
  out.dropDiag = {
    running: g.running, uiMode: g.uiMode, dead: p.dead,
    start: [p.x + 2.4, p.y + 0.5, p.z],
    end: [drop.x, drop.y, drop.z], alive: !drop.dead, delay: drop.pickupDelay,
    player: [p.x, p.y, p.z],
    dist: Math.hypot(drop.x - p.x, (p.y + 0.9) - drop.y, drop.z - p.z),
  };
  g.items.length = 0;

  const Mob = g.mobClassForTests();
  const sheep = new Mob('sheep', p.x + 6, p.y, p.z);
  g.mobs.push(sheep);
  sheep.vx = 2; sheep.vz = 0;
  for (let i = 0; i < 20; i++) sheep.update(1 / 60, g.world, p, g.mobApi());
  out.mobYawMovingX = sheep.yaw;
  out.mobHeadingOk = Math.abs(sheep.yaw - Math.atan2(-1, 0)) < 0.6;
  g.mobs = g.mobs.filter((m) => m !== sheep);

  inv.slots.fill(null); inv.selected = 0;
  const rodId = g.resolveKeyForTests('fishing_rod');
  out.rodId = rodId;
  inv.add(rodId, 1);
  g.bobber = null;
  g.useFishingRod();
  out.bobberCast = !!g.bobber;
  if (g.bobber) g.bobber.state = 'biting';
  const invBefore = inv.slots.filter(Boolean).reduce((n, s) => n + s.count, 0);
  g.reelFishing();
  out.bobberAfterReel = !!g.bobber;
  out.fishingGained = inv.slots.filter(Boolean).reduce((n, s) => n + s.count, 0) - invBefore;

  inv.slots.fill(null); inv.selected = 0;
  const shieldId = g.resolveKeyForTests('shield_item');
  out.shieldId = shieldId;
  inv.add(shieldId, 1);
  p.health = 20; p.blocking = true;
  p.damage(10, 'mob');
  out.shieldedHealth = p.health;
  out.shieldDurability = inv.slots[0] ? inv.slots[0].durability : 'broken';
  p.health = 20; p.blocking = false;
  p.damage(10, 'mob');
  out.unshieldedHealth = p.health;
  p.health = 20; p.blocking = true;
  p.damage(10, 'fall');
  out.fallWhileBlocking = p.health;

  inv.creative = wasCreative;
  inv.slots = savedSlots;
  inv.selected = savedSel;
  p.health = savedHealth;
  p.blocking = false;
  return out;
})()
