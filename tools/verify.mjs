// tools/verify.mjs — end-to-end behaviour check of the live game in real Chrome.
// Exercises block breaking/placing, inventory, crafting, mobs, combat, save/load and
// world streaming, then prints a pass/fail report.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ARG = process.argv[2] || 'http://127.0.0.1:8137/';
const PORT = 9600 + Math.floor(Math.random() * 200);
const PROFILE = path.join(os.tmpdir(), 'mineweb-func-' + process.pid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = [
  process.env.CHROME_PATH,
  path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((c) => c && fs.existsSync(c));
if (!chrome) throw new Error('chrome not found');

const child = spawn(chrome, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
  '--window-size=1280,720', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' });

let ws;
const report = { checks: [] };
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, detail });
  console.error(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  [' + String(detail).slice(0, 130) + ']' : ''}`);
};

try {
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch (e) { /* retry */ }
    if (!target) await sleep(250);
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.onmessage = (message) => {
    const m = JSON.parse(message.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push(m.params.entry.text);
    else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push((d?.exception?.description || d?.text || 'exception').split('\n').slice(0, 2).join(' | '));
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = async (expr) => {
    const t0 = Date.now();
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    const dt = Date.now() - t0;
    if (dt > 2500) console.error(`  [slow ${dt}ms] ${expr.slice(0, 60).replace(/\s+/g, ' ')}`);
    if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description || 'eval error' };
    return r.result?.result?.value;
  };
  const step = (name) => console.error('[verify] ' + name);

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  step('navigate');
  await send('Page.navigate', { url: URL_ARG });
  await sleep(2000);

  const t0 = Date.now();
  step('start world');
  await ev('window.__MINEWEB__.startNewGame("verify")');
  let ready = false;
  for (let i = 0; i < 600; i++) {
    if (await ev('!!(window.__MINEWEB__.running && window.__MINEWEB__.player)')) { ready = true; break; }
    await sleep(250);
  }
  report.loadMs = Date.now() - t0;
  step(`world ready (${report.loadMs}ms)`);
  check('world starts', ready, `${report.loadMs}ms`);
  if (!ready) throw new Error('world never started');
  await ev('(() => { const g = window.__MINEWEB__; g.settings.vsync = false; g.dpr = 1; g.resize(); return true; })()');
  await sleep(1200);

  step('world basics');
  report.world = await ev(`(() => { const g = window.__MINEWEB__; const w = g.world; const p = g.player;
    return { seed: w.seed, chunks: w.chunks.size, viewDistance: w.viewDistance, biome: w.biomeNameAt(Math.floor(p.x), Math.floor(p.z)),
      surfaceY: w.findSurfaceY(Math.floor(p.x), Math.floor(p.z)), playerY: Number(p.y.toFixed(2)),
      glRenderer: (() => { const gl = g.renderer.gl; const d = gl.getExtension('WEBGL_debug_renderer_info');
        return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })() }; })()`);
  check('terrain generated', report.world.chunks > 40, `${report.world.chunks} chunks (pre-generated + streamed)`);
  check('player on surface', Math.abs(report.world.playerY - report.world.surfaceY) < 3,
    `y=${report.world.playerY} surface=${report.world.surfaceY}`);

  step('break block');
  const breakRes = await ev(`(() => { const g = window.__MINEWEB__; const w = g.world; const p = g.player;
    p.mode = 'creative'; g.uiMode = 'playing';
    const bx = Math.floor(p.x), bz = Math.floor(p.z);
    const by = w.findSurfaceY(bx, bz);
    w.setBlockAt(bx + 1, by, bz, 5);
    g.__testTarget = { x: bx + 1, y: by, z: bz };
    const before = w.getBlockRaw(bx + 1, by, bz);
    g.breakBlock({ x: bx + 1, y: by, z: bz, id: 5, nx: 0, ny: 1, nz: 0 });
    const after = w.getBlockRaw(bx + 1, by, bz);
    return { before, after }; })()`);
  check('block breaking', breakRes.before === 5 && breakRes.after === 0, JSON.stringify(breakRes));

  step('place block');
  const placeRes = await ev(`(() => { const g = window.__MINEWEB__; const w = g.world; const p = g.player;
    const t = g.__testTarget;
    const inv = p.inventory;
    let slot = -1;
    for (let i = 0; i < 9; i++) if (inv.slots[i] && inv.slots[i].id === 5) { slot = i; break; }
    if (slot < 0) { inv.slots[0] = { id: 5, count: 64 }; slot = 0; }
    inv.selected = slot;
    inv.creative = true;
    const before = w.getBlockRaw(t.x, t.y, t.z);
    const savedRay = g.raycastHit;
    g.raycastHit = () => ({ x: t.x, y: t.y - 1, z: t.z, id: 1, nx: 0, ny: 1, nz: 0 });
    g.placeBlock();
    g.raycastHit = savedRay;
    const after = w.getBlockRaw(t.x, t.y, t.z);
    return { before, after }; })()`);
  check('block placing', placeRes.after === 5, JSON.stringify(placeRes));

  step('inventory and crafting');
  const invRes = await ev(`(() => { const g = window.__MINEWEB__; const inv = g.player.inventory;
    inv.slots.fill(null);
    inv.craftGrid.fill(null);
    inv.craftSize = 2;
    const logId = 6;
    inv.add(logId, 3);
    const logCount = inv.count(logId);
    // take a real log out of the pack so consumption is observable
    const taken = inv.slots[0];
    inv.craftGrid[0] = { id: logId, count: 1, durability: null };
    taken.count--;
    if (taken.count <= 0) inv.slots[0] = null;
    inv.updateCraftResult();
    const recipe = inv.recipe ? inv.recipe.id : null;
    const out = inv.craftOut ? { id: inv.craftOut.id, count: inv.craftOut.count } : null;
    const ok = inv.craftToInventory();
    const afterLogs = inv.count(logId);
    const planks = inv.count(5);
    return { logCount, recipe, out, ok, afterLogs, planks };
    })()`);
  check('inventory stacking', invRes.logCount === 3, JSON.stringify(invRes));
  check('crafting match (2x2)', invRes.recipe === 'planks' && invRes.out && invRes.out.id === 5 && invRes.out.count === 4, JSON.stringify(invRes));
  check('crafting consumes input', invRes.ok === true && invRes.afterLogs === 2 && invRes.planks === 4, JSON.stringify(invRes));

  step('items, tools and furnace');
  const craft = await ev('window.__MINEWEB__.auditCrafting()');
  report.crafting = craft;
  check('item registry', craft.itemCount >= 30 && craft.toolCount >= 20, `${craft.itemCount} items / ${craft.toolCount} tools`);
  check('tool recipe consumes the 3x3 grid', craft.grid3 && craft.grid3.ok, JSON.stringify(craft.grid3));
  check('2x2 grid rejects 3x3 recipes', craft.grid3NeedsTable === true);
  check('furnace smelts ore to ingot', craft.furnace && craft.furnace.ok,
    `${craft.furnace ? craft.furnace.seconds : '?'}s -> ${JSON.stringify(craft.furnace && craft.furnace.output)}`);
  check('ore blocks drop materials', craft.oreDrop === craft.furnace.expectIngot, `${craft.oreDrop}`);
  check('tool matches block and wears out', craft.tool && craft.tool.effective
    && craft.tool.durabilityAfter === craft.tool.durabilityBefore - 1, JSON.stringify(craft.tool));
  check('eating restores hunger', craft.eating && craft.eating.ate && craft.eating.hunger > 10, JSON.stringify(craft.eating));
  check('every item icon renders', craft.iconFails && craft.iconFails.length === 0, `${craft.iconCount} icons`);
  check('armour absorbs damage and wears', craft.armor && craft.armor.reduced
    && craft.armor.durabilityAfter === craft.armor.maxDurability - 1, JSON.stringify(craft.armor));
  check('armour slots are type-filtered', craft.armorSlotFilter === true);
  check('bow consumes arrows and scales with draw', craft.bow && craft.bow.arrowsAfter === craft.bow.arrowsBefore - 1
    && craft.bow.arrowsInFlight === 1 && craft.bow.arrowDamage > 0 && craft.bow.firedWithoutArrows === 0,
    JSON.stringify(craft.bow));
  check('chest storage round-trips', craft.chest && craft.chest.ok && craft.chest.slots === 27
    && craft.chest.takenBack && craft.chest.takenBack[1] === 30, JSON.stringify(craft.chest));
  check('structures generate chests', craft.structures && craft.structures.chestCount > 0
    && Object.keys(craft.structures.themes).length >= 2, JSON.stringify(craft.structures.themes));
  check('structure chests hold themed loot', craft.structures && craft.structures.sample
    && craft.structures.sample.filledSlots > 0, craft.structures && JSON.stringify(craft.structures.sample));
  check('structure blocks exist in the world', craft.structures && craft.structures.nearby
    && (craft.structures.nearby.cobble > 0 || craft.structures.nearby.planks > 0),
    craft.structures && JSON.stringify(craft.structures.nearby));
  check('hoe tills dirt into farmland', craft.farming && craft.farming.tilled
    && craft.farming.afterTill === craft.farming.expectFarmland, JSON.stringify(craft.farming));
  check('seeds plant and wheat grows to ripe', craft.farming && craft.farming.planted
    && craft.farming.afterPlant === craft.farming.expectWheat
    && craft.farming.stageAfterTicks === 3, JSON.stringify(craft.farming));
  check('harvest yields wheat and bakes bread', craft.farming
    && craft.farming.harvested === craft.farming.expectWheatItem
    && craft.farming.breadOk === true, JSON.stringify(craft.farming));
  check('bed refuses daytime sleep', craft.sleeping && craft.sleeping.refusedByDay === true);
  check('bed skips night and sets spawn', craft.sleeping && craft.sleeping.startedSleep
    && craft.sleeping.isMorning && craft.sleeping.spawnMoved, JSON.stringify(craft.sleeping));
  check('spider has its own multi-part model', craft.mobs && craft.mobs.spiderKind === 'spider'
    && craft.mobs.spiderParts >= 12 && craft.mobs.spiderHasLegs === true, JSON.stringify(craft.mobs));
  check('skeleton arrow spawns and damages the player', craft.mobs
    && craft.mobs.arrowSpawned && craft.mobs.hostileArrow && craft.mobs.playerDamaged
    && craft.mobs.damageTaken > 0, JSON.stringify(craft.mobs));
  check('flint and steel lights a portal', craft.dimensions
    && craft.dimensions.litOk === true && craft.dimensions.litCount === 6,
    JSON.stringify({ lit: craft.dimensions && craft.dimensions.litOk, blocks: craft.dimensions && craft.dimensions.litCount }));
  check('nether portal changes dimension', craft.dimensions
    && craft.dimensions.inNether === true && craft.dimensions.toDimension === 'nether'
    && craft.dimensions.aboveRoof === false, JSON.stringify(craft.dimensions && craft.dimensions.arrival));
  check('nether generates its own blocks', craft.dimensions
    && craft.dimensions.hasNetherrack && craft.dimensions.hasLava
    && craft.dimensions.hasGlowstone && craft.dimensions.hasBedrock,
    JSON.stringify(craft.dimensions && craft.dimensions.census));
  check('arrival builds a return portal', craft.dimensions
    && craft.dimensions.returnPortalBlocks >= 6, `${craft.dimensions && craft.dimensions.returnPortalBlocks} portal blocks`);
  check('portal round trip returns to the overworld', craft.dimensions
    && craft.dimensions.backToOverworld === true, JSON.stringify(craft.dimensions && craft.dimensions.backPos));
  check('melee swing damages a mob', craft.melee && craft.melee.hitSomething
    && craft.melee.swordDamage > 0 && craft.melee.knockback === true, JSON.stringify(craft.melee));
  check('swords hit harder than fists', craft.melee
    && craft.melee.swordBeatsFist === true && craft.melee.fistDamage >= 1, JSON.stringify(craft.melee));
  check('enchanting table offers enchantments', craft.enchant && craft.enchant.hasTableRecipe
    && craft.enchant.offerCount > 0, JSON.stringify(craft.enchant && craft.enchant.offerKeys));
  check('applying an enchantment costs levels', craft.enchant && craft.enchant.applied === true
    && craft.enchant.levelSpent > 0 && craft.enchant.enchantedKeys.length > 0,
    JSON.stringify({ spent: craft.enchant && craft.enchant.levelSpent, keys: craft.enchant && craft.enchant.enchantedKeys }));
  check('enchantments are stored on the stack', craft.enchant
    && craft.enchant.plainEff === 0 && craft.enchant.enchEff === 3,
    `plain=${craft.enchant && craft.enchant.plainEff} enchanted=${craft.enchant && craft.enchant.enchEff}`);
  check('villagers roll deterministic offers', craft.trading
    && craft.trading.opened === true && craft.trading.offerCount > 0
    && craft.trading.deterministicVillager === true && craft.trading.professionsSeen === 4,
    JSON.stringify({ prof: craft.trading && craft.trading.profession, offers: craft.trading && craft.trading.offerCount }));
  check('a completed trade moves items both ways', craft.trading && craft.trading.tradeResult
    && craft.trading.tradeResult.ok === true
    && craft.trading.tradeResult.paid === craft.trading.tradeResult.expectedPay
    && craft.trading.tradeResult.received === craft.trading.tradeResult.expectedGet,
    JSON.stringify(craft.trading && craft.trading.tradeResult));
  check('unaffordable trades are refused', craft.trading && craft.trading.refused === true);
  check('villagers do not despawn', craft.trading && craft.trading.villagerKeepsExisting === true);
  check('the End generates an island', craft.theEnd
    && craft.theEnd.dimension === 'end' && craft.theEnd.hasEndStone === true,
    JSON.stringify(craft.theEnd && craft.theEnd.census));
  check('the End has pillars, crystals and an exit portal', craft.theEnd
    && craft.theEnd.pillarBlocks >= 10 && craft.theEnd.crystalCount === 10
    && craft.theEnd.exitPortalBlocks >= 9,
    `pillars=${craft.theEnd && craft.theEnd.pillarBlocks} crystals=${craft.theEnd && craft.theEnd.crystalCount} exit=${craft.theEnd && craft.theEnd.exitPortalBlocks}`);
  check('the Ender Dragon spawns as a boss', craft.theEnd
    && craft.theEnd.dragonSpawned === true && craft.theEnd.dragonHp === 200
    && craft.theEnd.dragonParts >= 10,
    `hp=${craft.theEnd && craft.theEnd.dragonHp} parts=${craft.theEnd && craft.theEnd.dragonParts}`);
  check('crystals heal the dragon until destroyed', craft.theEnd
    && craft.theEnd.healedWithCrystals === true && craft.theEnd.stoppedHealing === true);
  check('felling the dragon shows the victory screen', craft.theEnd
    && craft.theEnd.victory === true && craft.theEnd.victoryShown === true);
  check('the End portal returns to the overworld', craft.theEnd
    && craft.theEnd.backHome === true);
  check('brewing turns water into potions', craft.brewing
    && craft.brewing.awkwardOk === true && craft.brewing.swiftOk === true,
    JSON.stringify({ wart: craft.brewing && craft.brewing.afterWart, sugar: craft.brewing && craft.brewing.afterSugar }));
  check('drinking a potion applies its effect', craft.brewing
    && craft.brewing.drank === true && craft.brewing.speedOk === true,
    `speed x${craft.brewing && craft.brewing.speedMul}`);
  check('instant potions heal at once', craft.brewing
    && craft.brewing.healedOk === true, `health=${craft.brewing && craft.brewing.healedTo}`);
  check('poison damages but never kills', craft.brewing
    && craft.brewing.poisonNeverKills === true, `health=${craft.brewing && craft.brewing.poisonHealth}`);
  check('fire resistance cancels burning', craft.brewing
    && craft.brewing.fireCancelled === true);
  check('potion registry is complete', craft.brewing && craft.brewing.potionItems >= 14,
    `${craft.brewing && craft.brewing.potionItems} potions`);
  check('lever powers wire and the lamp lights', craft.redstone
    && craft.redstone.leverOn === true && craft.redstone.lampOffBefore === true
    && craft.redstone.lampOn === true && craft.redstone.lampOffAgain === true,
    JSON.stringify({ near: craft.redstone && craft.redstone.wireNear, lampOn: craft.redstone && craft.redstone.lampOn }));
  check('signal decays one per block', craft.redstone && craft.redstone.decayOk === true,
    `near=${craft.redstone && craft.redstone.wireNear} far=${craft.redstone && craft.redstone.wireFar} atLamp=${craft.redstone && craft.redstone.wireAtLamp}`);
  check('piston extends, pushes a block and retracts', craft.redstone
    && craft.redstone.pistonExtended === true && craft.redstone.headPlaced === true
    && craft.redstone.pushedBlock === true && craft.redstone.pistonBack === true,
    JSON.stringify({ ext: craft.redstone && craft.redstone.pistonExtended, pushed: craft.redstone && craft.redstone.pushedBlock }));
  check('button is momentary and plate reacts', craft.redstone
    && craft.redstone.buttonOn === 15 && craft.redstone.buttonOff === 0
    && craft.redstone.plateOn === 15 && craft.redstone.plateOff === 0,
    JSON.stringify({ bOn: craft.redstone && craft.redstone.buttonOn, bOff: craft.redstone && craft.redstone.buttonOff, pOn: craft.redstone && craft.redstone.plateOn }));
  check('redstone component registry', craft.redstone && craft.redstone.componentCount === 12,
    `${craft.redstone && craft.redstone.componentCount} blocks`);
  check('hopper moves items between containers', craft.hoppers
    && craft.hoppers.movedThrough === true && craft.hoppers.registered === true,
    JSON.stringify(craft.hoppers && { src: craft.hoppers.srcLeft, dst: craft.hoppers.dstCount }));
  check('powered hopper freezes, unpowered resumes', craft.hoppers
    && craft.hoppers.poweredNow === true && craft.hoppers.frozeWhilePowered === true
    && craft.hoppers.resumedWhenUnpowered === true,
    JSON.stringify(craft.hoppers && { powered: craft.hoppers.poweredNow, froze: craft.hoppers.frozeWhilePowered }));
  check('repeater delays the signal', craft.repeaters && craft.repeaters.delayed === true,
    JSON.stringify(craft.repeaters && { off: craft.repeaters.lampOffRightAfter, on: craft.repeaters.lampAfterDelay }));
  check('repeater passes the signal back off', craft.repeaters
    && craft.repeaters.lampOffAgain === true && craft.repeaters.repRegistered === true);

  step('entities');
  const mobRes = await ev(`(() => { const g = window.__MINEWEB__; const p = g.player;
    const before = g.mobs.length;
    const kinds = ['pig', 'cow', 'sheep', 'chicken', 'zombie', 'creeper', 'skeleton'];
    const spawned = [];
    // the audit empties the mob list, so fall back to the game's own factory
    const MobCtor = (g.mobs.length ? g.mobs[0].constructor : null) || g.mobClassForTests();
    if (!MobCtor) return { error: 'no mob class available' };
    for (const k of kinds) {
      const mob = new MobCtor(k, p.x + 2, p.y, p.z + 2);
      g.mobs.push(mob); spawned.push(k);
    }
    return { before, after: g.mobs.length, spawned };
    })()`);
  check('mob spawning', mobRes.after > mobRes.before, JSON.stringify(mobRes).slice(0, 160));

  step('combat');
  const combat = await ev(`(() => { const g = window.__MINEWEB__; const p = g.player;
    const mob = g.mobs.find((m) => !m.def.hostile);
    if (!mob) return { error: 'no passive mob' };
    const hp = mob.hp;
    mob.damage(4, g.mobApi());
    const after = mob.hp;
    for (let i = 0; i < 8; i++) mob.damage(4, g.mobApi());
    return { hp, after, dead: mob.dead, xp: p.xp };
    })()`);
  check('mob damage and death', combat.after === combat.hp - 4 && combat.dead === true, JSON.stringify(combat));

  step('player damage and respawn');
  const dmg = await ev(`(() => { const g = window.__MINEWEB__; const p = g.player;
    p.mode = 'survival'; p.health = 20;
    p.damage(7, 'test');
    const h1 = p.health;
    p.damage(100, 'test');
    const dead = p.dead;
    g.respawnPlayer();
    return { h1, dead, afterRespawn: p.health, stillDead: p.dead };
    })()`);
  check('player damage', dmg.h1 === 13, JSON.stringify(dmg));
  check('death and respawn', dmg.dead && dmg.afterRespawn === 20 && !dmg.stillDead, JSON.stringify(dmg));

  step('day/night');
  const cycle = await ev(`(() => { const g = window.__MINEWEB__;
    g.dayTime = 0.25; const noon = g.dayLightLevel();
    g.dayTime = 0.75; const midnight = g.dayLightLevel();
    const night = g.isNight();
    g.dayTime = 0.28;
    return { noon: Number(noon.toFixed(3)), midnight: Number(midnight.toFixed(3)), nightAtMidnight: night }; })()`);
  check('day/night cycle', cycle.noon > 0.9 && cycle.midnight < 0.4 && cycle.nightAtMidnight, JSON.stringify(cycle));

  step('save');
  const persist = await ev(`(() => { const g = window.__MINEWEB__; const p = g.player; const w = g.world;
    const bx = Math.floor(p.x) + 4, bz = Math.floor(p.z);
    const by = w.findSurfaceY(bx, bz) + 1;
    w.setBlockAt(bx, by, bz, 28);
    g.recordEdit(bx, by, bz, 28);
    g.saveWorld();
    const raw = localStorage.getItem('mineweb.save.v1');
    const parsed = JSON.parse(raw);
    const key = bx + ',' + by + ',' + bz;
    return { saved: !!raw, records: Object.keys(parsed.edits).length, hasEdit: parsed.edits[key] === 28,
      playerX: parsed.player.x, invSlots: parsed.inventory.slots.length };
    })()`);
  check('save file written', persist.saved && persist.hasEdit && persist.invSlots === 37, JSON.stringify(persist));

  step('torch light');
  const torch = await ev(`(() => { const g = window.__MINEWEB__; const w = g.world; const p = g.player;
    const bx = Math.floor(p.x), bz = Math.floor(p.z);
    const by = w.findSurfaceY(bx, bz);
    for (let d = 1; d <= 5; d++) { w.setBlockAt(bx + d, by, bz, 0); w.setBlockAt(bx + d, by + 1, bz, 0); }
    const placed = w.setBlockAt(bx + 3, by, bz, 30);
    const queued = w.lightQueue.length;
    // let the world's own scheduler finish relighting (a real update call)
    w.update(p.x, p.z, 400);
    const cxT = (bx + 3) >> 4, czT = bz >> 4;
    const c = w.getChunkRaw(cxT, czT);
    const lx = (bx + 3) - (cxT * 16);
    const lzLocal = bz - (czT * 16);
    return {
      placed, queued, lit: c.lit,
      atTorch: c.light[(by * 16 + lzLocal) * 16 + lx],
      twoAway: c.light[(by * 16 + lzLocal) * 16 + Math.max(0, lx - 2)],
      torchBlock: w.getBlockRaw(bx + 3, by, bz),
    };
    })()`);
  check('torch emits light', torch.atTorch >= 13 && torch.twoAway > 0, JSON.stringify(torch));

  step('streaming while walking');
  // Driven synchronously through game.simulate() so the check does not depend on the
  // browser actually scheduling animation frames. The player is lifted well clear of
  // the ground first so the measurement tests locomotion, not collision response.
  const walk = await ev(`(() => { const g = window.__MINEWEB__; const w = g.world; const p = g.player;
    g.hud.hidePause(); g.uiMode = 'playing';
    p.mode = 'creative'; p.flying = true; p.pitch = 0;
    p.y = w.findSurfaceY(Math.floor(p.x), Math.floor(p.z)) + 12;
    p.vy = 0;
    const start = [p.x, p.y, p.z];
    g.input.keys.add('KeyW');
    const sim = g.simulate(480, 1 / 60);          // eight seconds of gameplay
    g.input.keys.delete('KeyW');
    w.update(p.x, p.z, 400);
    return {
      moved: Number(Math.hypot(p.x - start[0], p.z - start[2]).toFixed(2)),
      startY: Number(start[1].toFixed(1)), endY: Number(p.y.toFixed(1)),
      speed: Number(Math.hypot(p.vx, p.vz).toFixed(2)),
      chunks: w.chunks.size, meshQueue: w.stats.meshQueue, mode: g.uiMode,
      simMsPerFrame: Number(sim.simMsPerFrame.toFixed(3)),
    }; })()`);
  check('walking and chunk streaming', walk.moved > 25 && walk.chunks > 60, JSON.stringify(walk));

  step('chat commands');
  const cmd = await ev(`(() => { const g = window.__MINEWEB__;
    g.player.inventory.slots.fill(null);
    g.runCommand('give', ['diamond_ore', '5']);
    const got = g.player.inventory.count(17);
    g.runCommand('time', ['set', 'night']);
    const t = g.dayTime;
    g.runCommand('time', ['set', 'day']);
    return { got, nightTime: t }; })()`);
  check('chat commands', cmd.got === 5 && Math.abs(cmd.nightTime - 0.75) < 0.01, JSON.stringify(cmd));

  step('UI surfaces');
  report.ui = await ev(`(() => { const g = window.__MINEWEB__;
    g.openInventory();
    const invOpen = !document.getElementById('inventory').classList.contains('hidden');
    const slots = document.querySelectorAll('#inventory .slot').length;
    const hotbar = document.querySelectorAll('#hotbar .slot').length;
    const recipes = document.querySelectorAll('#recipe-book .recipe-chip').length;
    g.closeInventory();
    const invClosed = document.getElementById('inventory').classList.contains('hidden');
    g.pause(); const paused = !document.getElementById('pause').classList.contains('hidden');
    g.resume();
    g.hud.toggleDebug();
    return { invOpen, slots, hotbar, recipes, invClosed, paused, debug: g.hud.debugVisible }; })()`);
  check('inventory UI', report.ui.invOpen && report.ui.slots >= 45, JSON.stringify(report.ui));
  check('hotbar has 9 slots', report.ui.hotbar === 9, JSON.stringify(report.ui));
  check('recipe book', report.ui.recipes >= 10, `${report.ui.recipes} recipes`);
  check('pause menu', report.ui.paused);
  check('debug overlay', report.ui.debug);

  step('performance');
  // Simulation cost is measured synchronously (always available); the rendered frame
  // rate is sampled from the real animation loop when the browser is actually
  // scheduling frames (window visible + foreground).
  const simPerf = await ev(`(() => { const g = window.__MINEWEB__;
    g.hud.hidePause(); g.uiMode = 'playing'; g.player.mode = 'survival'; g.player.flying = false;
    g.simulate(30, 1 / 60);                       // warm up
    const a = g.simulate(300, 1 / 60);
    return { simMsPerFrame: Number(a.simMsPerFrame.toFixed(3)), frames: a.frames,
      maxSimFps: Number((1000 / a.simMsPerFrame).toFixed(0)) }; })()`);
  report.simPerformance = simPerf;
  check('simulation step is cheap (<4ms)', simPerf.simMsPerFrame < 4,
    `${simPerf.simMsPerFrame}ms/frame (ceiling ${simPerf.maxSimFps} fps)`);

  const perf = await ev(`new Promise((resolve) => {
    const g = window.__MINEWEB__;
    const times = []; let last = performance.now(); const start = last;
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      const s = times.slice(1).sort((a, b) => a - b);
      if (!s.length) { resolve({ error: 'no frames sampled', rafBlocked: true }); return; }
      const mean = s.reduce((a, b) => a + b, 0) / s.length;
      resolve({ frames: s.length, avgFps: 1000 / mean,
        p99FrameMs: s[Math.floor(s.length * 0.99)], fps1pctLow: 1000 / s[Math.floor(s.length * 0.99)],
        medianFps: 1000 / s[Math.floor(s.length / 2)],
        draws: g.renderer.stats.draws, quads: g.renderer.stats.quads,
        viewDistance: g.world.viewDistance });
    };
    function tick(now) {
      times.push(now - last); last = now;
      if (now - start < 5000) requestAnimationFrame(tick);
      else done();
    }
    requestAnimationFrame(tick);
    // hard fallback so the harness can never hang if rAF is throttled
    setTimeout(done, 9000);
  })`);
  report.performance = perf;
  if (perf && perf.avgFps) {
    check('average fps >= 60', perf.avgFps >= 60, `${perf.avgFps.toFixed(1)} fps`);
    check('1% low fps >= 60', perf.fps1pctLow >= 60, `${perf.fps1pctLow.toFixed(1)} fps`);  } else {
    // the browser did not schedule frames (occluded/background window); the
    // simulation-side ceiling above is the meaningful measurement in that case
    report.performanceNote = 'animation frames were throttled by the browser; see simPerformance';
    console.error('  SKIP  rendered fps sample (rAF throttled)');
  }

  // ---- visual regression: a broken chunk mesh shows up as large black wedges, so render
  // a normal first-person view and make sure the frame is actually filled with colour.
  step('rendered frame sanity');  const visual = await ev(`(() => {
    const g = window.__MINEWEB__;
    const p = g.player;
    const w = g.world;
    // stand on the surface looking at the horizon
    const px = Math.floor(p.x), pz = Math.floor(p.z);
    const py = w.findSurfaceY(px, pz);
    p.x = px + 0.5; p.z = pz + 0.5; p.y = py + 0.2;
    p.yaw = 0; p.pitch = 0;
    g.uiMode = 'playing';
    w.update(p.x, p.z, 900);
    for (let i = 0; i < 6; i++) g.stepFrame(1 / 60);
    const gl = g.renderer.gl;
    const cw = gl.drawingBufferWidth, ch = gl.drawingBufferHeight;
    const W = 160, H = 90;
    const buf = new Uint8Array(W * H * 4);
    // sample the lower centre: that is ground, never sky
    gl.readPixels((cw - W) >> 1, Math.floor(ch * 0.05), W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let near = 0, total = W * H, sum = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const r = buf[i], gg = buf[i + 1], b = buf[i + 2];
      sum += r + gg + b;
      if (r < 12 && gg < 12 && b < 12) near++;
    }
    // also validate the GL-side invariant that broke: verts must be 6 per quad
    let badSlots = 0, slots = 0;
    for (const c of w.chunks.values()) {
      const s = c._opaque;
      if (!s || !s.verts) continue;
      slots++;
      if (s.verts % 6 !== 0 || s.quads !== Math.floor(s.verts / 6)) badSlots++;
    }
    return { blackRatio: near / total, avgBrightness: sum / (total * 3), slots, badSlots, draws: g.renderer.stats.draws };
  })()`);
  report.visual = visual;
  check('lower screen renders solid terrain', visual && visual.blackRatio < 0.35,
    `${(visual && (visual.blackRatio * 100).toFixed(1))}% near-black pixels`);
  check('mesh vertex count matches 6 per quad', visual && visual.badSlots === 0,
    `${visual && visual.badSlots} bad of ${visual && visual.slots} chunks`);
  check('frame is bright enough to be a lit scene', visual && visual.avgBrightness > 25,
    `brightness ${visual && visual.avgBrightness.toFixed(1)}`);

  // ---- mouse look must be a scaled delta, not a runaway spin
  step('mouse look');
  const look = await ev(`(() => {
    const g = window.__MINEWEB__;
    const p = g.player;
    const input = g.input;
    g.uiMode = 'playing';
    p.yaw = 0; p.pitch = 0;
    input.mouseDX = 0; input.mouseDY = 0;
    input.locked = true;
    const send = (mx, my) => {
      const ev = new MouseEvent('mousemove', { bubbles: true });
      Object.defineProperty(ev, 'movementX', { value: mx });
      Object.defineProperty(ev, 'movementY', { value: my });
      window.dispatchEvent(ev);
    };
    const sens = input.sensitivity;
    // one 100px move should turn the view by a sensible amount, not a whole turn
    send(100, 0);
    g.stepFrame(1 / 60);
    const yawAfter100 = p.yaw;
    // and it must stop when the mouse stops
    for (let i = 0; i < 90; i++) g.stepFrame(1 / 60);
    const yawSettled = p.yaw;
    // a glitched giant event must not flip the camera
    p.pitch = 0;
    send(0, 100000);
    g.stepFrame(1 / 60);
    const pitchAfterGiant = p.pitch;
    // pitch stays inside the legal range
    for (let i = 0; i < 200; i++) { send(0, -400); g.stepFrame(1 / 60); }
    const pitchLimit = p.pitch;
    input.locked = false;
    p.yaw = 0; p.pitch = 0;
    return { sens, yawAfter100, yawSettled, pitchAfterGiant, pitchLimit };
  })()`);
  report.mouseLook = look;
  check('sensitivity is in a sane range', look
    && look.sens >= 0.0004 && look.sens <= 0.02, `${look && look.sens} rad/px`);
  check('100px turns a sensible angle', look
    && Math.abs(look.yawAfter100) > 0.02 && Math.abs(look.yawAfter100) < 0.6,
    `${((look && look.yawAfter100) * 180 / Math.PI).toFixed(1)}°`);
  check('look stops when the mouse stops', look
    && Math.abs(look.yawSettled - look.yawAfter100) < 0.001);
  check('a giant event cannot flip the camera', look
    && Math.abs(look.pitchAfterGiant) < 1.0, `${look && look.pitchAfterGiant.toFixed(2)} rad`);
  check('pitch stays clamped', look
    && Math.abs(look.pitchLimit) <= Math.PI / 2 + 0.01);

  // ---- M1: creative mode, pickups, mob heading, fishing, shield
  step('sandbox fixes');
  const fixes = await ev(`(() => {
    const g = window.__MINEWEB__;
    const p = g.player;
    const inv = p.inventory;
    const out = {};
    const wasCreative = inv.creative;
    const savedSlots = inv.slots.map((s) => s);
    const savedSel = inv.selected;
    const savedHealth = p.health;
    const savedDead = p.dead;
    // build real ItemStacks; plain objects lack enchLevel() and friends
    const hold = (id, count, dur) => {
      inv.slots.fill(null); inv.selected = 0; inv.add(id, count);
      const s = inv.slots[0];
      if (s && dur != null) s.durability = dur;
      return s;
    };

    // ---- creative palette + no consumption
    inv.creative = true;
    inv.slots.fill(null);
    inv.giveCreativePalette();
    out.paletteFilled = inv.slots.filter(Boolean).length;
    out.paletteBlocks = new Set(inv.slots.filter(Boolean).map((s) => s.id)).size;
    // the four armour slots must stay empty
    out.armourSlotsUsed = inv.slots.slice(33).filter(Boolean).length;
    hold(1, 64);
    inv.consumeHeld(); inv.consumeHeld(); inv.consumeHeld();
    out.creativeCountAfter = inv.slots[0].count;
    // creative pick block hands over a full stack
    const realRay = g.raycastHit;
    g.raycastHit = () => ({ id: 3, x: 0, y: 0, z: 0 });
    inv.slots[0] = null; inv.selected = 0;
    g.pickBlock();
    out.pickCount = inv.slots[0] ? inv.slots[0].count : 0;
    g.raycastHit = realRay;
    // survival does consume
    inv.creative = false;
    hold(1, 5);
    inv.consumeHeld();
    out.survivalCountAfter = inv.slots[0] ? inv.slots[0].count : -1;

    // ---- dropped items are picked up (the magnet brings them in from ~3 blocks)
    inv.slots.fill(null);
    p.dead = false;
    p.health = 20;
    const drop = g.itemEntityForTests(1, 4, p.x + 2.4, p.y + 0.5, p.z);
    drop.pickupDelay = 0;
    g.items.push(drop);
    const before = inv.count(1);
    for (let i = 0; i < 90; i++) g.stepFrame(1 / 60);
    out.pickupGained = inv.count(1) - before;
    g.items.length = 0;

    // ---- mobs face the way they walk (model front is local -Z)
    const Mob = g.mobClassForTests();
    const sheep = new Mob('sheep', p.x + 6, p.y, p.z);
    g.mobs.push(sheep);
    // re-inject velocity every frame: the wandering AI would otherwise decelerate to a
    // standstill and the check would trivially pass through the idle branch
    for (let i = 0; i < 20; i++) { sheep.vx = 2; sheep.vz = 0; sheep.update(1 / 60, g.world, p, g.mobApi()); }
    out.mobSpeed = Math.hypot(sheep.vx, sheep.vz);
    out.mobYaw = sheep.yaw;
    const expectYaw = Math.atan2(-sheep.vx, -sheep.vz);
    // the facing must be the direction of travel, and must actually be moving
    out.mobHeadingOk = out.mobSpeed > 0.35 && Math.abs(((sheep.yaw - expectYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < 0.05;
    g.mobs = g.mobs.filter((m) => m !== sheep);

    // ---- fishing: cast, force a bite, reel in a catch
    const rodId = g.resolveKeyForTests('fishing_rod');
    hold(rodId, 1, 64);
    g.bobber = null;
    g.useFishingRod();
    out.bobberCast = !!g.bobber;
    if (g.bobber) g.bobber.state = 'biting';
    const invBefore = inv.slots.filter(Boolean).reduce((n, s) => n + s.count, 0);
    g.reelFishing();
    out.bobberAfterReel = !!g.bobber;
    out.fishingGained = inv.slots.filter(Boolean).reduce((n, s) => n + s.count, 0) - invBefore;

    // ---- shield absorbs most of a physical hit and wears out
    const shieldId = g.resolveKeyForTests('shield_item');
    hold(shieldId, 1, 336);
    p.health = 20; p.blocking = true;
    p.damage(10, 'mob');
    out.shieldedHealth = p.health;
    out.shieldDurability = inv.slots[0] ? inv.slots[0].durability : 'broken';
    p.health = 20; p.blocking = false;
    p.damage(10, 'mob');
    out.unshieldedHealth = p.health;
    // fall damage is environmental and must not be blockable
    p.health = 20; p.blocking = true;
    p.damage(10, 'fall');
    out.fallWhileBlocking = p.health;

    // restore
    inv.creative = wasCreative;
    inv.slots = savedSlots;
    inv.selected = savedSel;
    p.health = savedHealth;
    p.dead = savedDead;
    p.blocking = false;
    return out;
  })()`);
  report.fixes = fixes;
  check('creative palette fills the inventory', fixes
    && fixes.paletteFilled >= 25 && fixes.paletteBlocks >= 25,
    `${fixes && fixes.paletteFilled} slots / ${fixes && fixes.paletteBlocks} blocks`);
  check('creative palette leaves armour slots empty', fixes && fixes.armourSlotsUsed === 0,
    `${fixes && fixes.armourSlotsUsed}`);
  check('creative never consumes items', fixes && fixes.creativeCountAfter === 64,
    `${fixes && fixes.creativeCountAfter}`);
  check('survival still consumes items', fixes && fixes.survivalCountAfter === 4);
  check('creative pick block gives a full stack', fixes && fixes.pickCount === 64);
  check('dropped items are picked up', fixes && fixes.pickupGained === 4,
    `gained ${fixes && fixes.pickupGained}`);
  check('mobs face their direction of travel', fixes && fixes.mobHeadingOk === true,
    `yaw ${fixes && fixes.mobYaw && fixes.mobYaw.toFixed(2)} @ ${fixes && fixes.mobSpeed && fixes.mobSpeed.toFixed(2)}`);
  check('fishing casts and reels in a catch', fixes
    && fixes.bobberCast === true && fixes.bobberAfterReel === false && fixes.fishingGained > 0,
    JSON.stringify({ cast: fixes && fixes.bobberCast, gained: fixes && fixes.fishingGained }));
  check('shield reduces damage and wears', fixes
    && fixes.shieldedHealth > fixes.unshieldedHealth && fixes.shieldDurability < 336,
    `shielded ${fixes && fixes.shieldedHealth} vs ${fixes && fixes.unshieldedHealth}`);
  check('shield cannot block fall damage', fixes && fixes.fallWhileBlocking === 10,
    `${fixes && fixes.fallWhileBlocking}`);

  report.logs = logs.slice(0, 10);
  report.summary = {
    passed: report.checks.filter((c) => c.ok).length,
    failed: report.checks.filter((c) => !c.ok).length,
    total: report.checks.length,
  };
  step(`done: ${report.summary.passed}/${report.summary.total} passed`);
  fs.writeFileSync('reports/verify-report.json', JSON.stringify(report, null, 2));
  // the full report goes to stdout so the console shows the failing details too
  console.log(JSON.stringify(report, null, 2));
  await send('Browser.close');
} catch (err) {
  report.fatal = err.message;
  console.error('FATAL: ' + err.message);
  fs.writeFileSync('reports/verify-report.json', JSON.stringify(report, null, 2));
} finally {
  try { ws?.close(); } catch (e) { /* ignore */ }
  try { child.kill(); } catch (e) { /* ignore */ }
  await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
