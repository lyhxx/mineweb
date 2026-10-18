// game/game.js — the game shell: world lifecycle, input routing, mining, survival,
// day/night cycle, mob spawning, adaptive performance and the main frame loop.
import { Renderer } from '../render/gl.js';
import { World } from '../world/world.js';
import { SEA_LEVEL, CX, CZ, WORLD_H, BIOME_NAMES } from '../world/chunk.js';
import { Player, GAMEMODE, EYE_HEIGHT, GRAVITY } from './player.js';
import { Inventory, registerBlockKeys, resolveAny, foodValue, toolInfo, RECIPES, isBow, bowPower, armorPoints, armorInfo, maxDurability, ARMOR_START, INVENTORY_SIZE, enchantMitigation } from './inventory.js';
import { SMELT_RECIPES, ITEMS, ITEM_BY_KEY, itemById, stackName } from '../core/items.js';
import { stackIcon } from '../render/icons.js';
import { NetherGen, NETHER_ROOF, LAVA_LEVEL } from '../world/nether.js';
import { EndGen, END_GROUND_Y } from '../world/end.js';
import { rollOffers, enchantLabel, enchantFamilies, eligibleEnchants, protectionPoints } from '../core/enchant.js';
import { rollVillager, resolveOffer, bindTradeResolver } from '../core/trades.js';
import { makeRng } from '../core/math.js';
import { EFFECTS, DURATION, EffectTracker, parsePotionKey, brewResult } from '../core/potions.js';
import { Bobber, rollCatch } from '../core/fishing.js';
import { captureRegion, pasteBlueprint, BUILTIN_BLUEPRINTS } from '../world/blueprint.js';
import { NetClient } from '../net/client.js';
import { maxPowerAt, lastRecomputeSources, powerAt } from '../world/redstone.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { Particles } from './particles.js';
import { Hud } from './hud.js';
import { Mob, ItemEntity, spawnInitialMobs, MOB_DEFS, mobParts } from './entities.js';
import { BLOCKS, baseId, SOLID, LIQUID, OPAQUE, RENDER, R, blockByKey, idOf, TILE, CREATIVE_ORDER, ATLAS_SLOTS, MAX_TILE_INDEX, MAX_BLOCKS, BLOCK_DROPS, ItemStack } from '../core/blocks.js';
import { clamp, m4identity, m4rotY, m4rotX, m4scale, m4translate, m4multiply, m4aim, rayBox } from '../core/math.js';
import { buildBlockMesh } from '../render/itemmesh.js';
import { VERT_BYTES } from '../world/mesher.js';
import { skyLevel, blockLevel, lightCurve, lightChunk } from '../world/lighting.js';

const SETTINGS_KEY = 'mineweb.settings.v1';

/** Usable mouse-look sensitivity range, in radians per pixel of movement. */
const MIN_SENSITIVITY = 0.0004;
const MAX_SENSITIVITY = 0.02;
const SAVE_KEY = 'mineweb.save.v1';

const DEFAULT_SETTINGS = {
  renderDistance: 8,
  fov: 76,
  // radians of rotation per pixel of mouse movement. Anything near 1.0 makes the view
  // spin a full turn from a one-pixel flick, which is what an earlier 1000x-too-large
  // default felt like.
  sensitivity: 0.0022,
  volume: 0.55,
  gamma: 1.0,
  maxFps: 240,
  fog: 1.0,
  bob: 1.0,
  vsync: true,
  smoothLighting: true,
  invertY: false,
  adaptive: true,
};

export class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.settings = { ...DEFAULT_SETTINGS, ...this.loadSettings() };
    // Heal saved settings from older builds: a regression shipped a sensitivity of 2.2
    // (radians per pixel, ~1000x too large), and that value is still sitting in
    // localStorage for anyone who played before. Clamp it back to a usable range.
    if (!(this.settings.sensitivity > 0) || this.settings.sensitivity > MAX_SENSITIVITY) {
      this.settings.sensitivity = DEFAULT_SETTINGS.sensitivity;
    }
    this.settings.sensitivity = clamp(this.settings.sensitivity, MIN_SENSITIVITY, MAX_SENSITIVITY);
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.renderer = new Renderer(canvas);
    this.input = new Input(canvas);
    this.audio = new Audio();
    this.audio.setVolume(this.settings.volume);
    this.input.sensitivity = this.settings.sensitivity;
    this.input.invertY = this.settings.invertY;

    this.uiMode = 'title';           // title | loading | playing | inventory | paused | settings | dead | chat
    this.running = false;
    this.lastFrame = 0;
    this.accumulator = 0;
    this.fps = 0;
    this.frameTimes = new Float32Array(180);
    this.frameIndex = 0;
    this.frameCount = 0;
    this.fpsTimer = 0;
    this.playTime = 0;
    this.dayTime = 0.28;             // 0..1, 0.25 = noon-ish
    this.dayLength = 20 * 60;        // 20 real minutes per full day, like Minecraft
    this.mobs = [];
    this.items = [];
    this.arrows = [];
    this.bowCharging = false;
    this.bowCharge = 0;
    this.chestPos = null;
    this.bobber = null;
    this.net = null;          // NetClient while connected to a co-op server
    this.mining = null;
    this.miningProgress = 0;
    this.miningSoundTimer = 0;
    this.breakParticlesTimer = 0;
    this.placeCooldown = 0;
    this.breakCooldown = 0;
    this.lastSpaceTap = 0;
    this.lastWTap = 0;
    this.sprintToggle = false;
    this.debugTimer = 0;
    this.paused = false;
    this.autoSaveTimer = 0;
    this.changedBlocks = new Map();
    this.itemMeshCache = new Map();
    this.taps = 0;
    this.usingSavedWorld = false;

    this.hud = new Hud(this);
    this.bindInput();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    this.perf = { autoReduced: false, minFps: Infinity, samples: [] };
    // exposed for automated verification (tools/bench.mjs)
    window.__MINEWEB__ = this;
  }

  /**
   * Registry audit used by tools/verify.mjs and the diagnostic probes. Returns a plain
   * serialisable snapshot — no module handles leak into the harness.
   */
  auditBlocks() {
    const defined = [];
    for (let id = 0; id < MAX_BLOCKS; id++) if (BLOCKS[id]) defined.push(id);
    const badTiles = [];
    const tileUse = new Map();
    for (const id of defined) {
      for (let f = 0; f < ATLAS_SLOTS; f++) {
        const t = TILE[id * ATLAS_SLOTS + f];
        if (!(t >= 0 && t <= MAX_TILE_INDEX)) badTiles.push([id, f, t]);
        tileUse.set(t, (tileUse.get(t) || 0) + 1);
      }
    }
    const solidMismatch = [];
    const renderMismatch = [];
    for (const id of defined) {
      const b = BLOCKS[id];
      if (SOLID[id] !== (b.solid ? 1 : 0)) solidMismatch.push(id);
      if (RENDER[id] !== b.render) renderMismatch.push(id);
    }
    return {
      definedCount: defined.length,
      maxId: defined[defined.length - 1],
      badTiles: badTiles.slice(0, 8),
      sharedTiles: [...tileUse.values()].filter((n) => n > 1).length,
      solidMismatch, renderMismatch,
      creativeCount: CREATIVE_ORDER.length,
      creativeMissing: CREATIVE_ORDER.filter((id) => !BLOCKS[id]),
      directional: defined.filter((id) => BLOCKS[id].directional).map((id) => BLOCKS[id].key),
      maxTileIndex: MAX_TILE_INDEX,
      maxBlocks: MAX_BLOCKS,
      atlasSlots: ATLAS_SLOTS,
      tileCount: TILE.length,
    };
  }

  // ------------------------------------------------------------------ settings + saves
  loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch (e) { return {}; }
  }

  saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) { /* ignore */ }
  }

  hasSavedWorld() {
    try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; }
  }

  applyVsync() {
    // WebGL has no vsync switch; emulate by capping the frame rate to 60 when enabled.
    if (this.settings.vsync) this.settings.maxFps = 60;
    else if (this.settings.maxFps === 60) this.settings.maxFps = 240;
    this.hud.refreshSettingValues();
  }

  // ------------------------------------------------------------------ bootstrap
  /** Shortcut used all over the HUD: the active inventory (player-held). */
  get inventory() { return this.player ? this.player.inventory : null; }

  async startNewGame(seedText) {
    const raw = seedText !== undefined ? seedText : (this.hud.refs.seedInput.value || '');
    let seed;
    if (raw) {
      seed = hashSeed(raw);
    } else {
      seed = (Math.random() * 0x7fffffff) | 0;
    }
    this.hud.hideTitle();
    this.uiMode = 'loading';
    this.hud.showLoading('初始化世界…');
    this.hud.setLoading(0.02, `种子 ${seed}`);
    await frameGap();

    // World creation is split across frames so the progress bar stays alive.
    this.seed = seed;
    this.world = new World(seed, { viewDistance: this.settings.renderDistance });
    this.world.readOnly = false;
    // structure chests, dimension travel and portal lighting all rely on the item registry
    this.world.lootResolver = (roll) => (roll.id ? roll.id : resolveAny(roll.itemKey));
    // register the starting world as the overworld up front, so travelling back works
    this.dimensions = { overworld: this.world };
    // trade offers are stored as item keys; resolve them through the registry
    bindTradeResolver((key) => resolveAny(key));
    const spawn = this.world.gen.findSpawn(this.world);
    this.spawn = spawn;
    this.player = new Player(this.world, spawn);
    this.player.inventory = new Inventory();
    this.player.effects = new EffectTracker();
    registerBlockKeys(BLOCKS);
    this.player.inventory.giveStarterKit();
    this.player.onFootstep = () => {
      const under = baseId(this.world.getBlockRaw(Math.floor(this.player.x), Math.floor(this.player.y - 0.2), Math.floor(this.player.z)));
      const water = this.world.isLiquidAt(Math.floor(this.player.x), Math.floor(this.player.y + 0.1), Math.floor(this.player.z));
      this.audio.step(water ? 'water' : (BLOCKS[under]?.key || 'stone'));
      this.emitFootstepParticles();
    };
    this.particles = new Particles(this.world);
    this.changedBlocks.clear();
    this.mobs = [];
    this.items = [];
    this.arrows = [];
    this.bowCharging = false;
    this.bowCharge = 0;
    this.chestPos = null;
    this.bobber = null;

    // Only the immediate neighbourhood is built behind the loading screen; the rest of
    // the ring streams in during play via world.update().
    const radius = Math.min(this.settings.renderDistance, 4);
    await this.pregenerate(radius);
    this.hud.setLoading(1, '完成');
    await frameGap();

    // settle the player on the surface
    const surfaceY = this.world.findSurfaceY(Math.floor(spawn.x), Math.floor(spawn.z));
    this.player.y = surfaceY + 0.2;
    this.player.spawnPoint = { x: this.player.x, y: this.player.y, z: this.player.z };
    this.dayTime = 0.30;
    this.mobs = spawnInitialMobs(this.world, Math.floor(spawn.x), Math.floor(spawn.z), seed ^ 0x5f3759df);
    // a couple of villagers near spawn, so trading is discoverable without a long walk
    this.spawnVillagersNearSpawn(Math.floor(spawn.x), Math.floor(spawn.z));

    this.hud.hideLoading();
    this.hud.showHud();
    this.running = true;
    this.uiMode = 'playing';
    this.usingSavedWorld = false;
    this.hud.setCredits(`世界种子：${seed}`);
    this.hud.refs.seedValue.textContent = String(seed);
    this.hud.refreshHotbar();
    this.hud.refreshStatus();
    this.hud.chatLine(`欢迎来到 MineWeb！种子 ${seed}，按 E 打开背包，F3 查看调试信息。`, '#aaffaa');
    this.input.requestLock();
    this.audio.init();
    this.audio.resume();
  }

  async pregenerate(radius) {
    const world = this.world;
    const pcx = Math.floor(this.spawn.x) >> 4, pcz = Math.floor(this.spawn.z) >> 4;
    const coords = [];
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) coords.push([pcx + dx, pcz + dz]);
    }
    coords.sort((a, b) => (Math.hypot(a[0] - pcx, a[1] - pcz) - Math.hypot(b[0] - pcx, b[1] - pcz)));
    let i = 0;
    const total = coords.length;
    for (const [cx, cz] of coords) {
      world.ensureChunk(cx, cz);
      i++;
      // yield rarely: requestAnimationFrame is throttled, so a per-chunk yield would
      // dominate the loading time
      if (i % 48 === 0) {
        this.hud.setLoading(0.05 + 0.45 * (i / total), `生成地形 ${i}/${total}`);
        await frameGap();
      }
    }
    this.hud.setLoading(0.55, '装饰地形…');
    await frameGap();
    for (const c of world.chunks.values()) world.gen.decorateChunk(c, world);
    for (const c of world.chunks.values()) world.gen.decorateChunk(c, world);
    this.hud.setLoading(0.70, '计算光照…');
    await frameGap();
    let lit = 0;
    const litTotal = world.chunks.size;
    for (const c of world.chunks.values()) {
      if (!c.lit) lightChunk(c, world);
      if (++lit % 64 === 0) await frameGap();
    }
    this.hud.setLoading(0.85, '构建网格…');
    await frameGap();
    let n = 0;
    for (const c of world.chunks.values()) {
      if (!c.lit) lightChunk(c, world);
      world.remeshNow(c);
      this.renderer.uploadChunk(c);
      c._uploadedVersion = c.meshVersion;
      n++;
      if (n % 32 === 0) {
        this.hud.setLoading(0.85 + 0.13 * (n / litTotal), `构建网格 ${n}/${litTotal}`);
        await frameGap();
      }
    }
    this.world.pendingDecorate.clear();
  }

  async continueSaved() {
    let data;
    try { data = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { data = null; }
    if (!data) return this.startNewGame();
    this.settings.renderDistance = data.settings?.renderDistance ?? this.settings.renderDistance;
    await this.startNewGame(String(data.seed));
    this.world.loadEdits(data.edits || {});
    this.world.loadContainers(data.containers || {});
    this.player.x = data.player.x; this.player.y = data.player.y; this.player.z = data.player.z;
    this.player.yaw = data.player.yaw; this.player.pitch = data.player.pitch;
    this.player.mode = data.player.mode || GAMEMODE.SURVIVAL;
    this.player.health = data.player.health ?? 20;
    this.player.hunger = data.player.hunger ?? 20;
    this.player.spawnPoint = data.player.spawnPoint || this.player.spawnPoint;
    this.player.inventory.deserialize(data.inventory);
    this.player.inventory.creative = this.player.mode === GAMEMODE.CREATIVE;
    this.dayTime = data.dayTime ?? this.dayTime;
    this.changedBlocks = this.world.editLog || new Map();
    this.usingSavedWorld = true;
    this.hud.refreshHotbar();
    this.hud.refreshStatus();
    this.hud.chatLine('已载入存档。', '#aaffaa');
  }

  async newWorld(seedText) {
    this.running = false;
    this.input.exitLock();
    this.hud.hideInventory();
    this.hud.hidePause();
    this.hud.hideDeath();
    this.hud.hideHud();
    this.uiMode = 'title';
    this.hud.showTitle();
    if (seedText !== undefined) this.hud.refs.seedInput.value = seedText;
    await this.startNewGame(seedText);
  }

  saveWorld() {
    if (!this.world || !this.player) return;
    const edits = {};
    for (const [key, value] of this.world.editLog || []) edits[key] = value;
    const data = {
      version: 2,
      seed: this.world.seed,
      dayTime: this.dayTime,
      settings: { renderDistance: this.settings.renderDistance },
      edits,
      containers: this.world.serializeContainers(),
      player: {
        x: this.player.x, y: this.player.y, z: this.player.z,
        yaw: this.player.yaw, pitch: this.player.pitch,
        mode: this.player.mode, health: this.player.health, hunger: this.player.hunger,
        spawnPoint: this.player.spawnPoint,
      },
      inventory: this.player.inventory.serialize(),
      savedAt: Date.now(),
    };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (e) { /* quota */ }
    this.hud.refs.continueBtn.classList.remove('hidden');
  }

  // ------------------------------------------------------------------ input wiring
  bindInput() {
    const input = this.input;
    input.onKey = (code, e, down) => this.onKey(code, e, down);
    input.onMouseDown = (button) => this.onMouseDown(button);
  input.onMouseUp = () => {
    // releasing the right button fires a drawn bow
    if (this.bowCharging) this.releaseBow();
    // and lowers a raised shield
    if (this.player) this.player.blocking = false;
    this.mining = null; this.miningProgress = 0;
  };
    input.onWheel = (dir) => {
      if (this.uiMode !== 'playing') return;
      const inv = this.player.inventory;
      inv.selected = (inv.selected + (dir > 0 ? 1 : -1) + 9) % 9;
      this.hud.refreshHotbar();
    };
    input.onLockChange = (locked) => {
      // Only auto-pause when the player actually HAD the pointer lock and lost it.
      // Environments without pointer lock support (headless, some embeds) must not
      // bounce straight back into the pause menu.
      if (locked) this.hadLock = true;
      else if (this.hadLock && this.uiMode === 'playing') this.pause();
    };
    this.canvas.addEventListener('mousedown', () => {
      this.audio.init();
      this.audio.resume();
      if (this.uiMode === 'playing' && !this.input.locked) this.input.requestLock();
    });
  }

  onKey(code, e, down) {
    if (!down) return;
    const inv = this.player?.inventory;
    switch (code) {
      case 'Escape':
        if (this.uiMode === 'victory') this.resume();
        else if (this.uiMode === 'inventory') this.closeInventory();
        else if (this.uiMode === 'furnace') this.closeFurnace();
        else if (this.uiMode === 'chest') this.closeChest();
        else if (this.uiMode === 'enchanting') this.closeEnchanting();
        else if (this.uiMode === 'brewing') this.closeBrewing();
        else if (this.uiMode === 'trading') this.closeTrade();
        else if (this.uiMode === 'settings') { this.hud.hideSettings(); this.showPause(); }
        else if (this.uiMode === 'paused') this.resume();
        else if (this.uiMode === 'playing') this.pause();
        break;
      case 'KeyE':
        if (this.uiMode === 'playing') this.openInventory();
        else if (this.uiMode === 'inventory') this.closeInventory();
        else if (this.uiMode === 'furnace') this.closeFurnace();
        else if (this.uiMode === 'chest') this.closeChest();
        else if (this.uiMode === 'enchanting') this.closeEnchanting();
        else if (this.uiMode === 'brewing') this.closeBrewing();
        else if (this.uiMode === 'trading') this.closeTrade();
        break;
      case 'KeyR':
        // eat whatever food is held (R for "restore")
        if (this.uiMode === 'playing') this.tryEat();
        break;
      case 'F3': this.hud.toggleDebug(); break;
      case 'F1': this.hud.refs.hud.classList.toggle('hidden'); break;
      case 'KeyT':
        if (this.uiMode === 'playing') this.openChat();
        break;
      case 'KeyF':
        if (this.uiMode === 'playing' && this.player.mode === GAMEMODE.CREATIVE) {
          this.player.flying = !this.player.flying;
          this.hud.toast(this.player.flying ? '飞行：开' : '飞行：关');
        }
        break;
      case 'KeyG':
        if (this.uiMode === 'playing') { this.toggleGamemode(); }
        break;
      case 'Space':
        if (this.uiMode === 'playing') {
          const now = performance.now();
          if (now - this.lastSpaceTap < 320 && this.player.mode === GAMEMODE.CREATIVE) {
            this.player.flying = !this.player.flying;
            this.hud.toast(this.player.flying ? '飞行：开' : '飞行：关');
          }
          this.lastSpaceTap = now;
        }
        break;
      case 'KeyW':
        if (this.uiMode === 'playing') {
          const now = performance.now();
          if (now - this.lastWTap < 300) this.sprintToggle = true;
          this.lastWTap = now;
        }
        break;
      case 'KeyQ':
        if (this.uiMode === 'playing') this.dropHeld();
        break;
      case 'F5':
        break;
      default: break;
    }
    // number keys select hotbar slots
    if (code.startsWith('Digit') && this.uiMode === 'playing') {
      const n = Number(code.slice(5));
      if (n >= 1 && n <= 9) { inv.selected = n - 1; this.hud.refreshHotbar(); }
    }
  }

  onMouseDown(button) {
    if (this.uiMode !== 'playing' || !this.input.locked) return;
    if (button === 0) { this.breaking = true; this.placeCooldown = 0; }
    if (button === 2) {
      // shield: hold the right button to raise it; damage is mitigated in Player.damage
      if (itemById(this.player.inventory.heldId)?.shield) {
        this.player.blocking = true;
        return;
      }
      // fishing rod: right-click casts, right-click again reels in
      if (itemById(this.player.inventory.heldId)?.key === 'fishing_rod') {
        this.useFishingRod();
        this.breaking = false;
        return;
      }
      const hit = this.raycastHit();
      const blockKey = hit && BLOCKS[hit.id] ? BLOCKS[hit.id].key : null;
      if (blockKey === 'crafting_table') { this.openCraftingTable(); this.breaking = false; return; }
      if (blockKey === 'furnace' || blockKey === 'furnace_lit') { this.openFurnace(); this.breaking = false; return; }
      if (blockKey === 'chest' && !this.input.down('ShiftLeft')) {
        this.openChest(hit.x, hit.y, hit.z); this.breaking = false; return;
      }
      if ((blockKey === 'hopper' || blockKey === 'dispenser') && !this.input.down('ShiftLeft')) {
        this.openSmallContainer(blockKey, hit.x, hit.y, hit.z); this.breaking = false; return;
      }
      // a repeater cycles its delay on right-click, like Minecraft's four settings
      if (blockKey === 'repeater') {
        const d = (this.world.getFacing(hit.x, hit.y, hit.z) + 1) & 3;
        this.world.setFacing(hit.x, hit.y, hit.z, d);
        this.world.markDirty(hit.x >> 4, hit.z >> 4);
        this.hud.toast(`中继器延时：${(d + 1) * 2} 刻`);
        this.breaking = false;
        return;
      }
      if (blockKey === 'bed') { this.trySleep(hit); this.breaking = false; return; }
      if (blockKey === 'enchanting_table') { this.openEnchanting(); this.breaking = false; return; }
      if (blockKey === 'brewing_stand') { this.openBrewing(); this.breaking = false; return; }
      // redstone: levers toggle, buttons press, everything else recomputes
      if (blockKey === 'lever') {
        const on = this.world.toggleLever(hit.x, hit.y, hit.z);
        this.hud.toast(on ? '拉杆：开' : '拉杆：关');
        this.breaking = false;
        return;
      }
      if (blockKey === 'stone_button') {
        this.world.pressButton(hit.x, hit.y, hit.z, 1.2);
        this.breaking = false;
        return;
      }
      if (blockKey === 'piston' || blockKey === 'piston_extended') {
        // wrench-free manual toggle: right-click a piston to test the mechanism
        this.world.recomputeRedstone(hit.x, hit.y, hit.z);
        this.hud.toast('活塞已重算');
        this.breaking = false;
        return;
      }
      // empty hand on a villager opens trading
      if (this.tryInteractMob()) { this.breaking = false; return; }
      // flint & steel lights a portal frame
      if (resolveAny('flint_and_steel') === this.player.inventory.heldId) {
        if (this.tryLightPortal(hit)) { this.breaking = false; return; }
      }
      // hoe: turn dirt/grass into farmland
      if (this.tryTill(hit)) { this.breaking = false; return; }
      // seeds: plant on farmland
      if (this.tryPlantSeeds(hit)) { this.breaking = false; return; }
      // holding a bow: start drawing it instead of placing
      if (isBow(this.player.inventory.heldId)) {
        this.bowCharge = 0;
        this.bowCharging = true;
        this.breaking = false;
        return;
      }
      // holding a potion: drink it
      if (this.tryDrinkPotion()) { this.breaking = false; return; }
      // holding food: eat rather than place
      if (this.tryEat()) { this.breaking = false; return; }
      // right-clicking a facing block rotates it instead of placing
      if (hit && BLOCKS[hit.id] && BLOCKS[hit.id].directional) this.rotateBlock(hit);
      else this.placeBlock();
      this.placeCooldown = 0.22;
      this.breaking = false;
    }
    if (button === 1) this.pickBlock();
  }

  /**
   * Crafting / item / furnace audit used by tools/verify.mjs and the probes.
   * Exercises the real Inventory code paths and reports plain data.
   */
  auditCrafting() {
    const inv = this.player.inventory;
    const savedSlots = inv.slots.map((s) => s);
    const savedSelected = inv.selected;
    const savedCreative = inv.creative;
    const savedFurnace = { ...inv.furnace };
    // the audit must behave the same whatever mode the session is in
    inv.creative = false;
    const result = {};

    // registry
    result.itemCount = ITEMS.filter(Boolean).length;
    result.toolCount = ITEMS.filter((it) => it && it.tool).length;
    result.recipeCount = RECIPES.length;
    result.smeltCount = SMELT_RECIPES.size;

    // 2x2: log -> planks (needs the block key table to be registered)
    inv.slots.fill(null);
    inv.craftGrid.fill(null);
    inv.craftSize = 2;
    const logId = idOf('log');
    const planksId = idOf('planks');
    inv.add(logId, 4);
    inv.craftGrid[0] = new ItemStack(logId, 1);
    inv.updateCraftResult();
    result.grid2 = {
      recipe: inv.recipe ? inv.recipe.id : null,
      out: inv.craftOut ? [inv.craftOut.id, inv.craftOut.count] : null,
      expectPlanks: planksId,
      ok: inv.recipe && inv.recipe.id === 'planks' && inv.craftOut && inv.craftOut.id === planksId,
    };
    const crafted = inv.takeCraftResult();
    result.grid2.took = crafted ? [crafted.id, crafted.count] : null;

    // 3x3: wooden pickaxe needs three planks and two sticks
    inv.slots.fill(null);
    inv.craftGrid.fill(null);
    inv.craftSize = 3;
    const stickId = resolveAny('stick');
    inv.add(planksId, 3);
    inv.add(stickId, 2);
    inv.craftGrid[0] = new ItemStack(planksId, 1);
    inv.craftGrid[1] = new ItemStack(planksId, 1);
    inv.craftGrid[2] = new ItemStack(planksId, 1);
    inv.craftGrid[4] = new ItemStack(stickId, 1);
    inv.craftGrid[7] = new ItemStack(stickId, 1);
    inv.updateCraftResult();
    const pickId = resolveAny('wood_pickaxe');
    result.grid3 = {
      recipe: inv.recipe ? inv.recipe.id : null,
      out: inv.craftOut ? [inv.craftOut.id, inv.craftOut.count] : null,
      expectPickaxe: pickId,
      ok: inv.recipe && inv.recipe.id === 'wood_pickaxe' && inv.craftOut && inv.craftOut.id === pickId,
    };

    // a 3x3-only recipe must NOT match in the 2x2 grid
    inv.craftSize = 2;
    inv.updateCraftResult();
    result.grid3NeedsTable = inv.recipe === null;

    // furnace: iron ore + coal -> iron ingot
    inv.slots.fill(null);
    inv.craftGrid.fill(null);
    inv.craftSize = 2;
    const f = inv.furnace;
    f.input = new ItemStack(idOf('iron_ore'), 2);
    f.fuel = new ItemStack(resolveAny('coal'), 1);
    f.output = null; f.burn = 0; f.burnTotal = 0; f.cook = 0;
    const before = { burn: f.burn, cook: f.cook };
    let steps = 0;
    while (steps < 400 && !(f.output && f.output.count >= 1)) {
      inv.tickFurnace(0.1, SMELT_RECIPES);
      steps++;
    }
    result.furnace = {
      steps, seconds: Number((steps * 0.1).toFixed(1)),
      output: f.output ? [f.output.id, f.output.count] : null,
      inputLeft: f.input ? f.input.count : 0,
      fuelLeft: f.fuel ? f.fuel.count : 0,
      burn: Number(f.burn.toFixed(1)),
      expectIngot: resolveAny('iron_ingot'),
      ok: !!f.output && f.output.id === resolveAny('iron_ingot') && f.input && f.input.count === 1,
    };
    // the ore block must also yield the ingot when mined
    result.oreDrop = this.dropForBlock(idOf('iron_ore'));

    // tools: mining speed multiplier
    inv.slots.fill(null);
    inv.selected = 0;
    inv.slots[0] = new ItemStack(pickId, 1, 60);
    const def = BLOCKS[idOf('stone')];
    const info = toolInfo(inv.heldId);
    result.tool = {
      held: inv.heldId, expect: pickId, isItem: inv.heldId < 0,
      toolClass: info ? info.tool : null,
      blockTool: def ? def.tool : null,
      speed: info ? info.speed : 1,
      effective: !!(info && def && info.tool === def.tool),
    };
    // using it must consume durability
    const durBefore = inv.slots[0].durability;
    inv.damageHeld(1);
    result.tool.durabilityBefore = durBefore;
    result.tool.durabilityAfter = inv.slots[0] ? inv.slots[0].durability : 'broken';

    // eating
    inv.slots.fill(null);
    inv.selected = 0;
    inv.slots[0] = new ItemStack(resolveAny('bread'), 2);
    this.player.hunger = 10;
    const ate = this.tryEat();
    result.eating = { ate, hunger: this.player.hunger, left: inv.slots[0] ? inv.slots[0].count : 0 };

    // armour: points and damage absorption
    inv.slots.fill(null);
    const helmId = resolveAny('iron_helmet');
    const chestId = resolveAny('iron_chestplate');
    inv.slots[ARMOR_START] = new ItemStack(helmId, 1, maxDurability(helmId));
    inv.slots[ARMOR_START + 1] = new ItemStack(chestId, 1, maxDurability(chestId));
    const points = armorPoints(inv);
    const mitigated = 10 * (1 - Math.min(0.8, points * 0.04));
    const brokeBefore = inv.damageArmor(1);
    result.armor = {
      helmetId: helmId, chestId,
      points: Number(points.toFixed(2)),
      rawDamage: 10, mitigatedDamage: Number(mitigated.toFixed(2)),
      reduced: mitigated < 10,
      durabilityAfter: inv.slots[ARMOR_START] ? inv.slots[ARMOR_START].durability : 'broken',
      maxDurability: maxDurability(helmId),
      brokePieces: brokeBefore,
    };
    // armour must only accept its own slot
    inv.slots[ARMOR_START + 2] = new ItemStack(helmId, 1, 100);
    result.armorSlotFilter = armorInfo(helmId).slot === 'helmet' && armorInfo(resolveAny('iron_boots')).slot === 'boots';

    // bow: needs arrows, and the arrow damage scales with draw time
    inv.slots.fill(null);
    inv.selected = 0;
    const bowId = resolveAny('wood_bow');
    inv.slots[0] = new ItemStack(bowId, 1, maxDurability(bowId));
    this.arrows = [];
    this.bowCharging = false;
    this.bowCharge = 0;
    this.releaseBow();                               // no arrows yet -> nothing happens
    const firedWithoutArrows = this.arrows.length;
    inv.add(resolveAny('arrow'), 8);
    const arrowsBefore = inv.count(resolveAny('arrow'));
    this.bowCharging = true;
    this.bowCharge = 1;
    this.releaseBow();
    result.bow = {
      isBow: isBow(bowId), power: bowPower(bowId),
      firedWithoutArrows,
      arrowsBefore,
      arrowsAfter: inv.count(resolveAny('arrow')),
      arrowsInFlight: this.arrows.length,
      arrowDamage: this.arrows[0] && this.arrows[0].arrow ? Number(this.arrows[0].arrow.damage.toFixed(2)) : 0,
      arrowSpeed: this.arrows[0] ? Number(Math.hypot(this.arrows[0].vx, this.arrows[0].vy, this.arrows[0].vz).toFixed(1)) : 0,
      durability: inv.slots[0] ? inv.slots[0].durability : 'broken',
    };
    this.arrows = [];

    // chest: storage round-trips through the save format
    const cx = Math.floor(this.player.x) + 6, cz = Math.floor(this.player.z) + 6;
    const cy = this.world.findSurfaceY(cx, cz) + 1;
    this.world.setBlockAt(cx, cy, cz, idOf('chest'));
    const chest = this.world.chestAt(cx, cy, cz, true);
    inv.slots.fill(null);
    inv.add(planksId, 30);
    chest[4] = new ItemStack(planksId, 30);
    // take it back out through the real click path
    inv.cursor = null;
    inv.clickChestSlot(chest, 4, false, false);
    const takenBack = inv.cursor ? [inv.cursor.id, inv.cursor.count] : null;
    inv.cursor = null;
    chest[0] = new ItemStack(planksId, 7);
    const packed = this.world.serializeContainers();
    this.world.loadContainers(packed);
    const reloaded = this.world.chestAt(cx, cy, cz, false);
    result.chest = {
      slots: chest.length,
      takenBack,
      slotCleared: chest[4] === null,
      savedKeys: Object.keys(packed).length,
      reloadedCount: reloaded && reloaded[0] ? reloaded[0].count : -1,
      reloadedId: reloaded && reloaded[0] ? reloaded[0].id : 0,
      ok: reloaded && reloaded[0] && reloaded[0].id === planksId && reloaded[0].count === 7,
    };

    // icons for every stack id must render
    const iconFails = [];
    for (const it of ITEMS) {
      if (!it) continue;
      if (!stackIcon(it.id, 32)) iconFails.push(it.key);
    }
    result.iconFails = iconFails.slice(0, 8);
    result.iconCount = ITEMS.filter(Boolean).length;

    // structures: chests were recorded during world generation, loot is deterministic
    const themes = {};
    let chestCount = 0;
    if (this.world.structureChests) {
      for (const theme of this.world.structureChests.values()) {
        themes[theme] = (themes[theme] || 0) + 1;
        chestCount++;
      }
    }
    result.structures = { chestCount, themes };
    if (chestCount > 0) {
      const firstKey = [...this.world.structureChests.keys()][0];
      const [sx, sy, sz] = firstKey.split(',').map(Number);
      const chest = this.world.chestAt(sx, sy, sz, true);
      const items = chest.filter(Boolean).length;
      // re-rolling the same chest must produce the same loot
      const again = this.world.gen.lootFor(sx, sy, sz,
        this.world.gen.lootRng(sx, sy, sz, this.world.structureChests.get(firstKey)),
        this.world.structureChests.get(firstKey));
      result.structures.sample = {
        pos: [sx, sy, sz],
        theme: this.world.structureChests.get(firstKey),
        filledSlots: items,
        totalStacks: chest.filter(Boolean).reduce((n, s) => n + s.count, 0),
        deterministic: again.length > 0,
      };
    }
    // structure blocks must actually be present in the world
    const p2 = this.player;
    let cobble = 0, planks = 0, torchBlocks = 0;
    for (let dx = -48; dx <= 48; dx += 3) {
      for (let dz = -48; dz <= 48; dz += 3) {
        for (let y = 50; y < 100; y++) {
          const id = this.world.getBlockRaw(Math.floor(p2.x) + dx, y, Math.floor(p2.z) + dz);
          if (id === idOf('cobblestone')) cobble++;
          else if (id === idOf('planks')) planks++;
          else if (id === idOf('torch')) torchBlocks++;
        }
      }
    }
    result.structures.nearby = { cobble, planks, torchBlocks };

    // farming: hoe tills dirt, seeds plant, random ticks grow the crop, harvest yields wheat
    const fx = Math.floor(this.player.x) + 3, fz = Math.floor(this.player.z) + 3;
    const fy = this.world.findSurfaceY(fx, fz) - 1;
    this.world.setBlockAt(fx, fy, fz, idOf('dirt'));
    this.world.setBlockAt(fx, fy + 1, fz, 0);
    const dirtHit = { x: fx, y: fy, z: fz, id: idOf('dirt'), nx: 0, ny: 1, nz: 0 };
    const hoeId = resolveAny('iron_hoe');
    inv.slots.fill(null);
    inv.selected = 0;
    inv.slots[0] = new ItemStack(hoeId, 1, maxDurability(hoeId));
    const tilled = this.tryTill(dirtHit);
    const afterTill = this.world.getBlockRaw(fx, fy, fz);
    inv.slots[0] = new ItemStack(resolveAny('seeds'), 4);
    const planted = this.tryPlantSeeds({ x: fx, y: fy, z: fz, id: afterTill, nx: 0, ny: 1, nz: 0 });
    const wheatId = idOf('wheat');
    const afterPlant = this.world.getBlockRaw(fx, fy + 1, fz);
    // drive growth through the real random-tick handler
    for (let i = 0; i < 400 && this.world.getFacing(fx, fy + 1, fz) < 3; i++) this.onBlockTick(fx, fy + 1, fz, wheatId);
    const stage = this.world.getFacing(fx, fy + 1, fz);
    const harvested = this.dropForBlock(wheatId);
    inv.slots.fill(null);
    inv.add(resolveAny('wheat'), 3);
    inv.craftSize = 3;
    inv.craftGrid.fill(null);
    inv.craftGrid[0] = new ItemStack(resolveAny('wheat'), 1);
    inv.craftGrid[1] = new ItemStack(resolveAny('wheat'), 1);
    inv.craftGrid[2] = new ItemStack(resolveAny('wheat'), 1);
    inv.updateCraftResult();
    const breadOk = !!(inv.craftOut && inv.craftOut.id === resolveAny('bread'));
    result.farming = {
      hoeId, tilled, afterTill, expectFarmland: idOf('farmland'),
      planted, afterPlant, expectWheat: wheatId,
      stageAfterTicks: stage,
      harvested,
      expectWheatItem: resolveAny('wheat'),
      breadOk,
    };

    // sleeping: refused by day, allowed at night, advances to morning and sets spawn
    const oldSpawn = { x: this.player.spawnPoint.x, z: this.player.spawnPoint.z };
    const bedX = Math.floor(this.player.x) + 4, bedZ = Math.floor(this.player.z) + 4;
    const bedY = this.world.findSurfaceY(bedX, bedZ);
    this.world.setBlockAt(bedX, bedY, bedZ, idOf('bed'));
    const bedHit = { x: bedX, y: bedY, z: bedZ, id: idOf('bed'), nx: 0, ny: 1, nz: 0 };
    this.sleeping = 0;
    this.dayTime = 0.25;
    this.player.onGround = true;
    this.trySleep(bedHit);
    const refusedByDay = this.sleeping === 0;
    this.dayTime = 0.75;
    this.player.onGround = true;
    this.trySleep(bedHit);
    const startedSleep = this.sleeping > 0;
    for (let i = 0; i < 40; i++) this.updateSleeping(0.1);
    result.sleeping = {
      refusedByDay,
      startedSleep,
      dayTimeAfter: Number(this.dayTime.toFixed(3)),
      spawnMoved: this.player.spawnPoint.x !== oldSpawn.x || this.player.spawnPoint.z !== oldSpawn.z,
      isMorning: this.dayTime < 0.1,
    };

    // mobs: the spider has its own model and the skeleton shoots real arrows
    const mobX = Math.floor(this.player.x) + 2.5, mobZ = Math.floor(this.player.z) + 2.5;
    const mobY = this.world.findSurfaceY(Math.floor(this.player.x) + 2, Math.floor(this.player.z) + 2);
    const spider = new Mob('spider', mobX, mobY, mobZ);
    const spiderParts = mobParts(spider);
    const savedMobs = this.mobs;
    this.mobs = [spider];
    const beforeX = spider.x;
    for (let i = 0; i < 30; i++) spider.update(1 / 60, this.world, this.player, this.mobApi());
    const skeleton = new Mob('skeleton', mobX, mobY, mobZ);
    this.arrows = [];
    this.player.health = 20;
    this.player.mode = GAMEMODE.SURVIVAL;
    const arrowsBefore2 = this.arrows.length;
    this.mobShoot(skeleton, this.player);
    const arrowsAfter2 = this.arrows.length;
    const hostileArrow = this.arrows[0] && this.arrows[0].arrow && this.arrows[0].arrow.hostile === true;
    // step the arrow into the player so the hit path runs
    const hpBefore = this.player.health;
    if (this.arrows[0]) {
      const a = this.arrows[0];
      a.x = this.player.x; a.y = this.player.y + 0.9; a.z = this.player.z;
      a.vx = 0; a.vy = 0; a.vz = 0;
      for (let i = 0; i < 3; i++) this.updateArrows(1 / 60);
    }
    result.mobs = {
      spiderParts: spiderParts.length,
      spiderKind: spider.kind,
      spiderHasLegs: spiderParts.filter((p) => p.rotZ !== undefined).length >= 8,
      spiderAlive: !spider.dead,
      arrowSpawned: arrowsAfter2 === arrowsBefore2 + 1,
      hostileArrow,
      playerDamaged: this.player.health < hpBefore,
      damageTaken: Number((hpBefore - this.player.health).toFixed(2)),
    };
    this.mobs = savedMobs;
    this.arrows = [];

    // dimensions: build a portal in the overworld, light it, walk through, come back
    const obsId = idOf('obsidian');
    const portalId = idOf('nether_portal');
    const slotId = resolveAny('flint_and_steel');
    inv.slots.fill(null);
    inv.selected = 0;
    inv.slots[0] = new ItemStack(slotId, 1, maxDurability(slotId));
    const px0 = Math.floor(this.player.x) + 6, pz0 = Math.floor(this.player.z);
    const py0 = this.world.findSurfaceY(px0, pz0);
    for (let d = -1; d <= 2; d++) {
      for (const cy of [-1, 3]) {
        this.world.setBlockAt(px0, py0 + cy, pz0 + d, obsId);
        this.world.setBlockAt(px0 + 1, py0 + cy, pz0 + d, obsId);
      }
    }
    for (const d of [-1, 2]) {
      for (let cy = 0; cy <= 2; cy++) {
        this.world.setBlockAt(px0, py0 + cy, pz0 + d, obsId);
        this.world.setBlockAt(px0 + 1, py0 + cy, pz0 + d, obsId);
      }
    }
    for (let cy = -1; cy <= 3; cy++) {
      for (let d = -1; d <= 2; d++) {
        if (d === -1 || d === 2 || cy === -1 || cy === 3) continue;
        this.world.setBlockAt(px0, py0 + cy, pz0 + d, 0);
        this.world.setBlockAt(px0 + 1, py0 + cy, pz0 + d, 0);
      }
    }
    const litOk = this.tryLightPortal({ x: px0, y: py0, z: pz0 + 1 });
    const litCount = (() => {
      let n = 0;
      for (let cy = 0; cy <= 2; cy++) for (let d = 0; d <= 1; d++) if (this.world.getBlockRaw(px0, py0 + cy, pz0 + d) === portalId) n++;
      return n;
    })();
    // step into the portal
    const overworldDim = this.world.dimension;
    this.player.x = px0 + 0.5;
    this.player.y = py0;
    this.player.z = pz0 + 0.5;
    this.portalCooldown = 0;
    this.updatePortals(1 / 60);
    const inNether = this.world.dimension === 'nether';
    const arrival = [Math.floor(this.player.x), Math.floor(this.player.y), Math.floor(this.player.z)];
    // census a slab of the nether around the arrival point
    const census = {};
    for (let dx = -16; dx <= 16; dx += 2) {
      for (let dz = -16; dz <= 16; dz += 2) {
        for (let y = 1; y < 128; y++) {
          const id = this.world.getBlockRaw(arrival[0] + dx, y, arrival[2] + dz);
          if (id) census[id] = (census[id] || 0) + 1;
        }
      }
    }
    let returnPortal = 0;
    for (let dx = -8; dx <= 8; dx++) {
      for (let dz = -8; dz <= 8; dz++) {
        for (let y = 1; y < 128; y++) if (this.world.getBlockRaw(arrival[0] + dx, y, arrival[2] + dz) === portalId) returnPortal++;
      }
    }
    result.dimensions = {
      obsId, portalId, slotId,
      litOk, litCount,
      fromDimension: overworldDim,
      toDimension: this.world.dimension,
      inNether,
      arrival,
      aboveRoof: arrival[1] > NETHER_ROOF,
      returnPortalBlocks: returnPortal,
      census,
      hasNetherrack: !!census[idOf('netherrack')],
      hasLava: !!census[10],
      hasGlowstone: !!census[28],
      hasBedrock: !!census[11],
    };
    // come back: walk into the return portal that the arrival built
    const exit = this.portalExit || { x: arrival[0] + 6, y: arrival[1], z: arrival[2] };
    this.player.x = exit.x + 0.5;
    this.player.y = exit.y;
    this.player.z = exit.z + 0.5;
    this.portalCooldown = 0;
    this.updatePortals(1 / 60);
    result.dimensions.backToOverworld = this.world.dimension === 'overworld';
    result.dimensions.backPos = [Math.floor(this.player.x), Math.floor(this.player.y), Math.floor(this.player.z)];

    // melee: a swung sword must actually hurt a mob in front of the player
    inv.slots.fill(null);
    inv.selected = 0;
    const swordId = resolveAny('iron_sword');
    inv.slots[0] = new ItemStack(swordId, 1, maxDurability(swordId));
    const meleeTarget = new Mob('pig', this.player.x, this.player.y, this.player.z - 2.5);
    this.mobs = [meleeTarget];
    this.player.yaw = 0;                       // look towards -Z
    // aim down at the mob's body: a level ray from eye height passes over its head
    const aimDy = (meleeTarget.y + meleeTarget.height * 0.5) - this.player.eyeY;
    this.player.pitch = Math.atan2(aimDy, 2.5);
    this.attackCooldown = 0;
    const hpBefore3 = meleeTarget.hp;
    const hitSomething = this.tryMeleeAttack();
    const swordDamage = hpBefore3 - meleeTarget.hp;
    // bare hands do less
    inv.slots[0] = null;
    this.attackCooldown = 0;
    const pig2 = new Mob('pig', this.player.x, this.player.y, this.player.z - 2.5);
    this.mobs = [pig2];
    this.player.pitch = Math.atan2((pig2.y + pig2.height * 0.5) - this.player.eyeY, 2.5);
    const hpBefore4 = pig2.hp;
    this.tryMeleeAttack();
    const fistDamage = hpBefore4 - pig2.hp;
    result.melee = {
      swordId, hitSomething, swordDamage, fistDamage,
      swordBeatsFist: swordDamage > fistDamage,
      knockback: Math.abs(meleeTarget.vz) > 0.5 || Math.abs(meleeTarget.vx) > 0.5,
    };

    // enchanting: roll offers, apply one, and check it costs levels and sticks
    const tableId = idOf('enchanting_table');
    const tableRecipe = RECIPES.find((r) => r.id === 'enchanting_table');
    inv.slots.fill(null);
    inv.craftSize = 3;
    inv.craftGrid.fill(null);
    inv.enchantItem = new ItemStack(swordId, 1, maxDurability(swordId));
    this.player.level = 30;
    const enchOffers = rollOffers(inv.enchantItem, this.player.level, 1).filter(Boolean);
    const levelBefore = this.player.level;
    const firstOffer = enchOffers[0] || null;
    const applied = firstOffer ? this.applyEnchantment(firstOffer) : false;
    const pickForEnch = resolveAny('iron_pickaxe');
    const plainPick = new ItemStack(pickForEnch, 1, maxDurability(pickForEnch));
    const enchPick = new ItemStack(pickForEnch, 1, maxDurability(pickForEnch));
    enchPick.addEnchant('efficiency', 3);
    result.enchant = {
      tableId, hasTableRecipe: !!tableRecipe,
      offerCount: enchOffers.length,
      offerKeys: enchOffers.map((o) => `${o.key}:${o.level}`),
      applied,
      levelBefore, levelAfter: this.player.level,
      levelSpent: levelBefore - this.player.level,
      enchantedKeys: inv.enchantItem && inv.enchantItem.ench ? Object.keys(inv.enchantItem.ench) : [],
      effectLabel: firstOffer ? enchantLabel(firstOffer.key, firstOffer.level) : null,
      plainEff: plainPick.enchLevel('efficiency'),
      enchEff: enchPick.enchLevel('efficiency'),
    };
    inv.enchantItem = null;
    inv.enchantOffers = null;
    this.mobs = savedMobs;

    // trading: villagers roll deterministic offers and a completed trade moves items
    const vProfessions = {};
    for (let i = 0; i < 40; i++) {
      const rolled = rollVillager(i * 7919);
      vProfessions[rolled.profession.key] = (vProfessions[rolled.profession.key] || 0) + 1;
    }
    const a1 = rollVillager(4242);
    const a2 = rollVillager(4242);
    const deterministicVillager = a1.profession.key === a2.profession.key
      && JSON.stringify(a1.offers) === JSON.stringify(a2.offers);
    const villager = new Mob('villager', this.player.x, this.player.y, this.player.z - 2.5);
    villager.seed = 4242;
    this.mobs = [villager];
    inv.slots.fill(null);
    this.player.level = 5;
    const opened = this.openTrade(villager);
    const offers = (villager.offers || []).map((o) => ({
      give: `${o.give.key}x${o.give.count}`, get: `${o.get.key}x${o.get.count}`,
      giveId: o.giveId, getId: o.getId, max: o.max,
    }));
    const first = (villager.offers || [])[0];
    let tradeResult = null;
    if (first) {
      inv.add(first.giveId, first.give.count);
      const haveBefore = inv.count(first.giveId);
      const getBefore = inv.count(first.getId);
      const ok = this.doTrade(villager, first);
      tradeResult = {
        ok,
        paid: haveBefore - inv.count(first.giveId),
        received: inv.count(first.getId) - getBefore,
        uses: first.uses,
        expectedPay: first.give.count,
        expectedGet: first.get.count,
      };
    }
    let refused = null;
    if (villager.offers && villager.offers[1]) {
      inv.slots.fill(null);
      refused = this.doTrade(villager, villager.offers[1]) === false;
    }
    result.trading = {
      professionsSeen: Object.keys(vProfessions).length,
      deterministicVillager,
      opened,
      profession: villager.profession ? villager.profession.key : null,
      offerCount: offers.length,
      offers,
      tradeResult,
      refused,
      villagerKeepsExisting: villager.def.noDespawn === true,
    };
    this.closeTrade();
    this.mobs = savedMobs;

    // the End: island, pillars with crystals, exit portal, and the dragon fight
    const overWorld = this.world;
    const travelOk = this.travelTo('end', 0, 0);
    const endWorld = this.world;
    let endCensus = {};
    let crystalCount = (this.dragonCrystals || []).length;
    let pillarBlocks = 0;
    let exitPortalBlocks = 0;
    if (endWorld.dimension === 'end') {
      for (let dx = -48; dx <= 48; dx += 4) {
        for (let dz = -48; dz <= 48; dz += 4) {
          for (let y = 1; y < 128; y += 2) {
            const id = endWorld.getBlockRaw(dx, y, dz);
            if (id) endCensus[id] = (endCensus[id] || 0) + 1;
          }
        }
      }
      for (let dx = -62; dx <= 62; dx++) {
        for (let dz = -62; dz <= 62; dz++) {
          for (let y = 60; y < 110; y++) {
            const id = endWorld.getBlockRaw(dx, y, dz);
            if (id === idOf('purpur')) pillarBlocks++;
            if (id === idOf('end_portal')) exitPortalBlocks++;
          }
        }
      }
    }
    const dragon = this.boss;
    // crystals keep the dragon alive: drain it, then tick with crystals up and down
    let healedWithCrystals = false;
    let stoppedHealing = false;
    if (dragon) {
      dragon.hp = 100;
      dragon.bossTick(1, crystalCount);
      healedWithCrystals = dragon.hp > 100;
      dragon.hp = 100;
      for (const c of this.dragonCrystals || []) c.alive = false;
      dragon.bossTick(1, 0);
      stoppedHealing = dragon.hp === 100;
    }
    // felling the dragon triggers the victory
    let victory = false;
    let victoryDebug = null;
    if (dragon) {
      dragon.hp = 1;
      const hpBeforeKill = dragon.hp;
      dragon.damage(5, this.mobApi());
      victory = this.bossDefeated === true;
      victoryDebug = {
        hpBeforeKill, hpAfter: dragon.hp, dead: dragon.dead,
        bossRef: !!this.boss, bossDefeated: this.bossDefeated,
        victoryShown: !!this.victoryShown, uiMode: this.uiMode,
      };
    }
    result.theEnd = {
      travelOk,
      dimension: endWorld.dimension,
      dragonSpawned: !!dragon,
      dragonHp: dragon ? dragon.maxHp : 0,
      dragonParts: dragon ? mobParts(dragon).length : 0,
      crystalCount,
      healedWithCrystals,
      stoppedHealing,
      victory,
      victoryDebug,
      victoryShown: !!this.victoryShown,
      // the exit portal is rebuilt when the dragon dies
      exitPortalBlocks,
      pillarBlocks,
      census: endCensus,
      hasEndStone: !!endCensus[idOf('end_stone')],
      hasObsidian: !!endCensus[idOf('obsidian')],
      arrivalY: Number(this.player.y.toFixed(1)),
    };
    // go home
    this.travelTo('overworld', Math.floor(this.player.x), Math.floor(this.player.z));
    result.theEnd.backHome = this.world.dimension === 'overworld';
    this.victoryShown = false;
    if (this.hud.hideVictory) this.hud.hideVictory();
    this.bossDefeated = false;
    void overWorld;

    // brewing: water + nether wart -> awkward, then awkward + sugar -> swiftness
    const inv2 = this.player.inventory;
    inv2.slots.fill(null);
    inv2.brewing = { ingredient: null, bottles: [null, null, null], progress: 0, total: 0 };
    const wartId = resolveAny('nether_wart');
    const waterId = resolveAny('water_bottle');
    const awkwardId = resolveAny('awkward_potion');
    const sugarId = resolveAny('sugar');
    const swiftId = resolveAny('potion_swiftness');
    inv2.brewing.ingredient = new ItemStack(wartId, 2);
    inv2.brewing.bottles[0] = new ItemStack(waterId, 1);
    inv2.brewing.bottles[1] = new ItemStack(waterId, 1);
    let brewSteps = 0;
    while (brewSteps < 400 && (inv2.brewing.ingredient || !inv2.brewing.bottles[0])) {
      inv2.tickBrewing(0.5, brewResult); brewSteps++;
    }
    const afterWart = inv2.brewing.bottles.map((b) => (b ? (itemById(b.id) || {}).key : null));
    inv2.brewing.ingredient = new ItemStack(sugarId, 2);
    brewSteps = 0;
    while (brewSteps < 400 && inv2.brewing.ingredient) { inv2.tickBrewing(0.5, brewResult); brewSteps++; }
    const afterSugar = inv2.brewing.bottles.map((b) => (b ? (itemById(b.id) || {}).key : null));
    // drinking applies the effect
    inv2.slots.fill(null);
    inv2.selected = 0;
    inv2.slots[0] = new ItemStack(swiftId, 1);
    this.player.effects.clear();
    const drank = this.tryDrinkPotion();
    const speedMul = this.player.effects.speedMultiplier();
    // an instant potion heals immediately
    this.player.health = 10;
    this.applyPotion('healing', 2);
    const healedTo = this.player.health;
    // a bad potion damages over time but can never kill
    this.player.health = 3;
    this.player.effects.apply('poison', 1, 5);
    this.player.regenAccum = 0;
    for (let i = 0; i < 40; i++) this.updateEffects(0.1);
    const poisonHealth = this.player.health;
    // fire resistance cancels burning
    this.player.burning = true;
    this.player.effects.apply('fire_resistance', 1, 60);
    this.updateEffects(0.05);
    const fireBefore = this.player.burning;
    const fireAfter = this.player.burning;
    const effectsCleared = (() => { this.player.effects.clear(); return this.player.effects.active.size; })();
    result.brewing = {
      afterWart, afterSugar,
      awkwardOk: afterWart.filter(Boolean).length === 2 && afterWart.filter(Boolean).every((k) => k === 'awkward_potion'),
      swiftOk: afterSugar.filter(Boolean).length === 2 && afterSugar.filter(Boolean).every((k) => k === 'potion_swiftness'),
      drank, speedMul: Number(speedMul.toFixed(2)), speedOk: speedMul > 1,
      healedTo, healedOk: healedTo > 10,
      poisonHealth, poisonNeverKills: poisonHealth >= 1,
      fireBefore, fireAfter, fireCancelled: this.player.effects.level('fire_resistance') > 0 ? !fireAfter : true,
      effectsCleared,
      potionItems: ITEMS.filter((it) => it && it.potion).length,
    };
    inv2.brewing = { ingredient: null, bottles: [null, null, null], progress: 0, total: 0 };
    inv2.slots.fill(null);
    this.player.health = this.player.maxHealth;

    // redstone: lever -> wire run -> lamp, with strength decaying along the way
    const rx = Math.floor(this.player.x) + 8;
    const rz = Math.floor(this.player.z);
    const ry = this.world.findSurfaceY(rx, rz);
    // build a clean platform for the circuit
    for (let dx = -1; dx <= 12; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = 0; dy <= 3; dy++) this.world.setBlockAt(rx + dx, ry + dy, rz + dz, 0);
        this.world.setBlockAt(rx + dx, ry - 1, rz + dz, idOf('stone'));
      }
    }
    const wireId = idOf('redstone_wire');
    const leverId = idOf('lever');
    const lampId = idOf('redstone_lamp');
    const lampLitId = idOf('redstone_lamp_lit');
    const pistonId = idOf('piston');
    // measure what the propagation actually computed, for the audit
    const rsMaxInComponent = maxPowerAt(this.world, rx + 1, ry, rz);
    const rsLastSources = lastRecomputeSources();
    // lever at the start, then 6 wire, then a lamp
    this.world.setBlockAt(rx, ry, rz, leverId);
    for (let i = 1; i <= 6; i++) {
      this.world.setBlockAt(rx + i, ry, rz, wireId);
      this.world.setFacing(rx + i, ry, rz, 0);
    }
    this.world.setBlockAt(rx + 13, ry, rz, lampId);
    for (let i = 7; i <= 12; i++) {
      this.world.setBlockAt(rx + i, ry, rz, wireId);
      this.world.setFacing(rx + i, ry, rz, 0);
    }
    // a second branch with a piston at the end, pushing a block
    this.world.setBlockAt(rx, ry, rz + 2, wireId);
    this.world.setFacing(rx, ry, rz + 2, 0);
    this.world.setBlockAt(rx + 1, ry, rz + 1, wireId);
    this.world.setFacing(rx + 1, ry, rz + 1, 0);
    this.world.setBlockAt(rx + 1, ry, rz + 2, wireId);
    this.world.setFacing(rx + 1, ry, rz + 2, 0);
    this.world.setBlockAt(rx + 2, ry, rz + 2, pistonId);
    this.world.setFacing(rx + 2, ry, rz + 2, 0);         // facing +X
    this.world.setBlockAt(rx + 3, ry, rz + 2, idOf('cobblestone'));

    // before the lever is thrown everything is unpowered
    const lampOffBefore = baseId(this.world.getBlockRaw(rx + 13, ry, rz)) === lampId;
    const wireOff = this.world.getPower(rx + 3, ry, rz);
    const pistonRetracted = baseId(this.world.getBlockRaw(rx + 2, ry, rz + 2)) === pistonId;
    // throw the lever
    const leverOn = this.world.toggleLever(rx, ry, rz);
    const leverState = this.world.redstoneState(rx, ry, rz);
    const wireNear = this.world.getPower(rx + 1, ry, rz);      // 15 next to the lever
    const wireFar = this.world.getPower(rx + 5, ry, rz);       // 11 five blocks away
    const rsDebug = {
      leverOn, leverStateOn: leverState.leverOn,
      cellIds: [0, 1, 2, 3, 6, 8].map((i) => baseId(this.world.getBlockRaw(rx + i, ry, rz))),
      cellPower: [0, 1, 2, 3, 5, 6, 8].map((i) => this.world.getPower(rx + i, ry, rz)),
      leverBlockId: baseId(this.world.getBlockRaw(rx, ry, rz)),
      expectedLeverId: leverId,
      maxPowerAtWire: rsMaxInComponent,
      sources: rsLastSources,
    };
    const wireAtLamp = this.world.getPower(rx + 12, ry, rz);   // 3, still enough to light
    const lampOn = baseId(this.world.getBlockRaw(rx + 13, ry, rz)) === lampLitId;
    // the piston branch should have extended and pushed the cobblestone along
    const pistonExtended = baseId(this.world.getBlockRaw(rx + 2, ry, rz + 2)) === idOf('piston_extended');
    const headPlaced = baseId(this.world.getBlockRaw(rx + 3, ry, rz + 2)) === idOf('piston_head');
    const pushedBlock = baseId(this.world.getBlockRaw(rx + 4, ry, rz + 2)) === idOf('cobblestone');
    // throw it back
    this.world.toggleLever(rx, ry, rz);
    const lampOffAgain = baseId(this.world.getBlockRaw(rx + 13, ry, rz)) === lampId;
    const pistonBack = baseId(this.world.getBlockRaw(rx + 2, ry, rz + 2)) === pistonId;
    // a redstone block powers a neighbouring wire at full strength
    this.world.setBlockAt(rx + 1, ry + 2, rz, idOf('redstone_block'));
    this.world.setBlockAt(rx + 2, ry + 2, rz, wireId);
    this.world.setFacing(rx + 2, ry + 2, rz, 0);
    this.world.recomputeRedstone(rx + 2, ry + 2, rz);
    const blockPoweredWire = this.world.getPower(rx + 2, ry + 2, rz);
    // a button is momentary
    this.world.setBlockAt(rx + 1, ry, rz + 4, idOf('stone_button'));
    this.world.setBlockAt(rx + 2, ry, rz + 4, wireId);
    this.world.setFacing(rx + 2, ry, rz + 4, 0);
    this.world.pressButton(rx + 1, ry, rz + 4, 1.0);
    const buttonOn = this.world.getPower(rx + 2, ry, rz + 4);
    for (let i = 0; i < 30; i++) this.world.tickRedstone(0.1, []);
    const buttonOff = this.world.getPower(rx + 2, ry, rz + 4);
    // a pressure plate reacts to a player standing on it
    this.world.setBlockAt(rx + 1, ry, rz - 2, idOf('pressure_plate'));
    this.world.setBlockAt(rx + 2, ry, rz - 2, wireId);
    this.world.setFacing(rx + 2, ry, rz - 2, 0);
    const savedP = { x: this.player.x, y: this.player.y, z: this.player.z };
    this.player.x = rx + 1.5; this.player.y = ry + 1; this.player.z = rz - 1.5;
    this.world.tickRedstone(0.2, [this.player]);
    const plateBlockId = baseId(this.world.getBlockRaw(rx + 1, ry, rz - 2));
    const plateOn = this.world.getPower(rx + 2, ry, rz - 2);
    this.player.x = rx + 6.5; this.player.z = rz + 4.5;
    for (let i = 0; i < 10; i++) this.world.tickRedstone(0.2, [this.player]);
    const plateOff = this.world.getPower(rx + 2, ry, rz - 2);
    this.player.x = savedP.x; this.player.y = savedP.y; this.player.z = savedP.z;

    result.redstone = {
      lampOffBefore, wireOff, pistonRetracted,
      leverOn, wireNear, wireFar, lampOn,
      pistonExtended, headPlaced, pushedBlock,
      lampOffAgain, pistonBack,
      blockPoweredWire, buttonOn, buttonOff, plateOn, plateOff, plateBlockId, expectPlateId: idOf('pressure_plate'),
      wireAtLamp, decayOk: (wireNear === 15 && wireFar === 11 && wireAtLamp === 4),
      debug: rsDebug,
      componentCount: ['redstone_block', 'redstone_ore', 'redstone_wire', 'redstone_torch',
        'lever', 'stone_button', 'pressure_plate', 'redstone_lamp', 'redstone_lamp_lit',
        'piston', 'piston_extended', 'piston_head']
        .filter((k) => idOf(k) > 0).length,
    };

    // hoppers: a chest above feeds a hopper, which feeds a chest below
    const hx = Math.floor(this.player.x) + 16;
    const hz = Math.floor(this.player.z);
    const hy = this.world.findSurfaceY(hx, hz);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = 0; dy <= 4; dy++) this.world.setBlockAt(hx + dx, hy + dy, hz + dz, 0);
        this.world.setBlockAt(hx + dx, hy - 1, hz + dz, idOf('stone'));
      }
    }
    const hopperId = idOf('hopper');
    const chestBlockId = idOf('chest');
    // chest (source) -> hopper -> chest (destination)
    this.world.setBlockAt(hx, hy + 2, hz, chestBlockId);
    this.world.setBlockAt(hx, hy + 1, hz, hopperId);
    this.world.setFacing(hx, hy + 1, hz, 5);              // faces -Y (down)
    this.world.setBlockAt(hx, hy, hz, chestBlockId);
    const srcChest = this.world.containerAt('chest', hx, hy + 2, hz, true);
    const hopperInv = this.world.containerAt('hopper', hx, hy + 1, hz, true);
    const dstChest = this.world.containerAt('chest', hx, hy, hz, true);
    const testItem = resolveAny('redstone_dust');
    srcChest[0] = new ItemStack(testItem, 5);
    const registered = this.world.hopperPositions.has(hx + ',' + (hy + 1) + ',' + hz);
    // let the hopper run for a while
    let ticks = 0;
    for (let i = 0; i < 200 && (dstChest[0] ? dstChest[0].count : 0) < 3; i++) {
      this.world.tickHoppers(0.5, this.world.chunks);
      ticks++;
    }
    const srcLeft = srcChest[0] ? srcChest[0].count : 0;
    const dstCount = dstChest[0] ? dstChest[0].count : 0;
    const hopperLeft = hopperInv.filter(Boolean).reduce((n, s) => n + s.count, 0);
    // a powered hopper must stop moving items
    const src2 = this.world.containerAt('chest', hx, hy + 2, hz, true);
    const dst2 = this.world.containerAt('chest', hx, hy, hz, true);
    src2[1] = new ItemStack(testItem, 8);
    this.world.setBlockAt(hx - 1, hy + 1, hz, idOf('redstone_block'));
    this.world.recomputeRedstone(hx, hy + 1, hz);
    const poweredNow = powerAt(this.world, hx, hy + 1, hz) > 0;
    const dstBefore = dst2[0] ? dst2[0].count : 0;
    for (let i = 0; i < 40; i++) this.world.tickHoppers(0.5, this.world.chunks);
    const dstAfterPower = dst2[0] ? dst2[0].count : 0;
    // remove the block and confirm it resumes
    this.world.setBlockAt(hx - 1, hy + 1, hz, 0);
    this.world.recomputeRedstone(hx, hy + 1, hz);
    for (let i = 0; i < 60; i++) this.world.tickHoppers(0.5, this.world.chunks);
    const dstResumed = dst2[0] ? dst2[0].count : 0;
    result.hoppers = {
      registered, ticks,
      srcLeft, dstCount, hopperLeft,
      // the hopper pulled 3 out of the source chest and delivered 3 to the destination
      movedThrough: dstCount >= 3 && srcLeft === 2,
      poweredNow,
      frozeWhilePowered: dstAfterPower === dstBefore,
      resumedWhenUnpowered: dstResumed > dstAfterPower,
      containerSlots: hopperInv.length,
      chestSlots: srcChest.length,
    };

    // repeater: a signal fed into it comes out the far side after a delay.
    // Use a fresh area well clear of the hopper circuit, and wipe both the blocks and the
    // power map first so nothing from the earlier circuits can leak in.
    const px2 = hx + 6;
    const pz2 = hz + 8;
    for (let dx = -3; dx <= 8; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        for (let dy = -1; dy <= 6; dy++) {
          this.world.setBlockAt(px2 + dx, hy + dy, pz2 + dz, 0);
          this.world.setPower(px2 + dx, hy + dy, pz2 + dz, 0);
        }
        this.world.setBlockAt(px2 + dx, hy - 1, pz2 + dz, idOf('stone'));
      }
    }
    const repId = idOf('repeater');
    // lever -> wire -> repeater -> wire -> lamp.
    for (let dx = -1; dx <= 6; dx++) this.world.setPower(px2 + dx, hy, pz2, 0);
    this.world.setBlockAt(px2, hy, pz2, idOf('lever'));
    this.world.setBlockAt(px2 + 1, hy, pz2, idOf('redstone_wire'));
    this.world.setBlockAt(px2 + 2, hy, pz2, repId);
    this.world.setFacing(px2 + 2, hy, pz2, 0);
    this.world.setBlockAt(px2 + 3, hy, pz2, idOf('redstone_wire'));
    this.world.setBlockAt(px2 + 4, hy, pz2, idOf('redstone_lamp'));
    const repRegistered = this.world.repeaters.has((px2 + 2) + ',' + hy + ',' + pz2);
    const lampBefore = baseId(this.world.getBlockRaw(px2 + 4, hy, pz2)) === idOf('redstone_lamp');
    const lampIdBeforeLever = baseId(this.world.getBlockRaw(px2 + 4, hy, pz2));
    this.world.toggleLever(px2, hy, pz2);
    const lampIdAfterLever = baseId(this.world.getBlockRaw(px2 + 4, hy, pz2));
    const powersAfterLever = [0, 1, 2, 3, 4].map((i) => this.world.getPower(px2 + i, hy, pz2));
    const inputOn = this.world.getPower(px2 + 1, hy, pz2) > 0;
    // what the repeater itself can see on its input side (x-1, behind it)
    const repSeesInput = powerAt(this.world, px2 + 1, hy, pz2) > 0;
    const repFacing = this.world.getFacing(px2 + 2, hy, pz2);
    // immediately after the lever the repeater has not fired yet
    this.world.tickRepeaters(0.02);
    const repStateAfterOneTick = { ...this.world.redstoneState(px2 + 2, hy, pz2) };
    const lampIdAfterOneTick = baseId(this.world.getBlockRaw(px2 + 4, hy, pz2));
    const lampOffRightAfter = baseId(this.world.getBlockRaw(px2 + 4, hy, pz2)) === idOf('redstone_lamp');
    for (let i = 0; i < 20; i++) this.world.tickRepeaters(0.02);
    const lampAfterDelay = baseId(this.world.getBlockRaw(px2 + 4, hy, pz2)) === idOf('redstone_lamp_lit');
    const repStateAfterLoop = { ...this.world.redstoneState(px2 + 2, hy, pz2) };
    const outWirePower = this.world.getPower(px2 + 3, hy, pz2);
    const lampIdAfterLoop = baseId(this.world.getBlockRaw(px2 + 4, hy, pz2));
    const wirePowerBeforeOff = this.world.getPower(px2 + 1, hy, pz2);
    const leverReturn = this.world.toggleLever(px2, hy, pz2);
    const inputPowerAfterOff = this.world.getPower(px2 + 1, hy, pz2);
    const powerAtInputAfterOff = powerAt(this.world, px2 + 1, hy, pz2);
    const leverStateRightAfter = { ...this.world.redstoneState(px2, hy, pz2) };
    const leverStateAfterOff = { ...this.world.redstoneState(px2, hy, pz2) };
    for (let i = 0; i < 20; i++) this.world.tickRepeaters(0.02);
    const lampOffAgain2 = baseId(this.world.getBlockRaw(px2 + 4, hy, pz2)) === idOf('redstone_lamp');
    const repStateAfterOff = { ...this.world.redstoneState(px2 + 2, hy, pz2) };
    result.repeaters = {
      repRegistered, hasRepeater: repId > 0,
      lampBefore, inputOn,
      delayed: lampOffRightAfter === true && lampAfterDelay === true,
      lampAfterDelay, lampOffAgain: lampOffAgain2,
      repState: { ...this.world.redstoneState(px2 + 2, hy, pz2) },
      outPower: this.world.getPower(px2 + 3, hy, pz2),
      repSeesInput, repFacing, repStateAfterOneTick,
      repSetSize: this.world.repeaters.size,
      repIds: [0, 1, 2, 3, 4].map((i) => baseId(this.world.getBlockRaw(px2 + i, hy, pz2))),
      repPowers: [0, 1, 2, 3, 4].map((i) => this.world.getPower(px2 + i, hy, pz2)),
      lampPower: powerAt(this.world, px2 + 4, hy, pz2),
      lampIdBeforeLever, lampIdAfterLever, powersAfterLever, lampIdAfterOneTick,
      repStateAfterLoop,
      lampOffRightAfter, lampAfterDelay, outWirePower, lampIdAfterLoop, inputPowerAfterOff, repStateAfterOff, leverStateAfterOff, wirePowerBeforeOff, leverReturn, powerAtInputAfterOff, leverStateRightAfter,
    };

    // restore
    inv.slots = savedSlots;
    inv.selected = savedSelected;
    inv.creative = savedCreative;
    Object.assign(inv.furnace, savedFurnace);
    inv.craftGrid.fill(null);
    inv.craftSize = 2;
    return result;
  }

  // ------------------------------------------------------------------ co-op
  /**
   * Join a co-op server (tools/server.mjs). The server owns the edit log, so joining
   * replays every change made so far instead of starting from a diverged world.
   */
  connectToServer(url, name) {
    if (this.net) { this.net.close(); this.net = null; }
    if (!url) { this.hud.toast('用法：/connect ws://主机:端口/'); return null; }
    const target = String(url).replace(/^http/, 'ws');
    this.net = new NetClient(target, name || 'player', {
      onStatus: (text) => this.hud.toast(text),
      onWelcome: (msg) => {
        let applied = 0;
        for (const [x, y, z, block] of msg.edits || []) {
          this.world.setBlockAt(x, y, z, block);
          applied++;
        }
        this.hud.chatLine(`已加入服务器：${(msg.players || []).length} 人在线，回放 ${applied} 处改动`, '#88ff88');
        if (msg.seed && this.seed && String(msg.seed) !== String(this.seed)) {
          this.hud.chatLine(`注意：服务器种子是 ${msg.seed}，和本世界不同，地形可能对不上`, '#ffcc66');
        }
      },
      onJoin: (msg) => this.hud.chatLine(`${msg.name} 加入了游戏`, '#88ddff'),
      onLeave: (msg) => this.hud.chatLine('有玩家离开了游戏', '#88ddff'),
      onEdit: (msg) => this.world.setBlockAt(msg.x, msg.y, msg.z, msg.block),
      onChat: (msg) => this.hud.chatLine(`<${msg.name}> ${msg.msg}`, '#dddddd'),
    });
    this.net.connect();
    this.hud.toast('正在连接 ' + target);
    return this.net;
  }

  disconnectFromServer() {
    if (!this.net) { this.hud.toast('还没连接服务器'); return; }
    this.net.close();
    this.net = null;
    this.hud.chatLine('已断开联机', '#88ddff');
  }

  // ------------------------------------------------------------------ blueprints
  loadBlueprints() {
    try { return JSON.parse(localStorage.getItem('mineweb.blueprints.v1') || '{}'); } catch (e) { return {}; }
  }

  saveBlueprints(map) {
    try { localStorage.setItem('mineweb.blueprints.v1', JSON.stringify(map)); } catch (e) { /* full or blocked */ }
  }

  /** Capture a 15x15x15 box around the player so it can be pasted elsewhere. */
  saveBlueprint(name) {
    const p = this.player;
    const r = 7;
    const ox = Math.floor(p.x) - r;
    const oy = Math.max(0, Math.floor(p.y) - 1);
    const oz = Math.floor(p.z) - r;
    const bp = captureRegion(this.world, ox, oy, oz, r * 2 + 1, 15, r * 2 + 1, name);
    const all = this.loadBlueprints();
    all[name] = bp;
    this.saveBlueprints(all);
    this.hud.toast('已保存蓝图 ' + name + '（' + bp.size.join('x') + '）');
    return bp;
  }

  /** Paste a built-in, saved or remote blueprint at the player's feet. */
  async pasteBlueprintNamed(name) {
    if (!name) { this.hud.toast('用法：/paste <名字|地址>'); return 0; }
    let bp = BUILTIN_BLUEPRINTS[name] || this.loadBlueprints()[name] || null;
    // a name that looks like a path or URL is fetched instead of looked up locally
    const looksLikeUrl = /^(https?:|data:|\.{0,2}\/)/.test(name) || /\.json$/i.test(name);
    try {
      if (!bp && looksLikeUrl) {
        const url = new URL(name, location.href).href;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        bp = await res.json();
      }
    } catch (e) { bp = null; }
    if (!bp) { this.hud.toast('找不到蓝图：' + name); return 0; }
    const p = this.player;
    const ox = Math.floor(p.x) - ((bp.size[0] / 2) | 0);
    const oy = Math.floor(p.y);
    const oz = Math.floor(p.z) - ((bp.size[2] / 2) | 0);
    const n = pasteBlueprint(this.world, bp, ox, oy, oz);
    this.hud.toast('已粘贴 ' + (bp.name || name) + '（' + n + ' 块）');
    return n;
  }
  // ------------------------------------------------------------------ texture packs
  /**
   * Load a texture pack manifest from a URL, or restore the built-in art.
   *
   * The manifest only names the tiles it replaces:
   *   { "name": "Redstone", "tiles": { "stone": "tiles/stone.png",
   *                                    "grass/top": "tiles/grass_top.png" } }
   * Relative URLs resolve against the manifest, so a pack can be a folder of PNGs.
   */
  async loadTexturePack(url) {
    if (!url || url === 'off' || url === 'default') {
      this.renderer.resetTexturePack();
      this.hud.toast('已恢复默认材质');
      return true;
    }
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const manifest = await res.json();
      // resolve tile paths relative to the manifest so packs can use relative names
      const base = new URL(url, location.href);
      const tiles = manifest.tiles || {};
      for (const [key, src] of Object.entries(tiles)) {
        if (typeof src === 'string' && !/^(https?:|data:|blob:|\/)/.test(src)) {
          tiles[key] = new URL(src, base).href;
        }
      }
      const n = await this.renderer.applyTexturePack({ ...manifest, tiles });
      this.hud.toast('材质包已加载：' + (manifest.name || url) + '（' + n + ' 张）');
      return true;
    } catch (e) {
      this.hud.toast('材质包加载失败：' + e.message);
      return false;
    }
  }
  /** The Mob class, for tooling that needs to spawn a test mob with an empty world. */
  mobClassForTests() { return Mob; }

  /** Build a dropped-item entity for tooling (pickup / magnet tests). */
  itemEntityForTests(id, count, x, y, z) { return new ItemEntity(id, count, x, y, z); }

  /** Resolve an item/block key to a stack id, for probes. */
  resolveKeyForTests(key) { return resolveAny(key); }

  /** Best-effort spawn of a mob, used by the entity tests. */
  spawnMobForTests(kind, x, y, z) { return new Mob(kind, x, y, z); }

  /** The smelting recipe for a stack, if any (used by the furnace UI). */
  smeltRecipeFor(stack) {
    if (!stack) return null;
    return SMELT_RECIPES.get(stack.id) || null;
  }

  /**
   * Swap the placed furnace blocks between the cold and lit variants to match the
   * furnace's burn state. Only touches blocks this player placed, and only when the
   * state actually changes, so it costs nothing per frame.
   */
  updateFurnaceVisual() {
    const f = this.player.inventory.furnace;
    const lit = f.burn > 0;
    if (this._furnaceLit === lit) return;
    this._furnaceLit = lit;
    const target = lit ? 'furnace_lit' : 'furnace';
    const targetId = idOf(target);
    if (!targetId) return;
    const fromIds = [idOf('furnace'), idOf('furnace_lit')];
    for (const [key, value] of this.world.editLog) {
      if (!fromIds.includes(value)) continue;
      const [x, y, z] = key.split(',').map(Number);
      if (this.world.getBlockRaw(x, y, z) !== value) continue;
      const dir = this.world.getFacing(x, y, z);
      this.world.setBlockAt(x, y, z, targetId);
      this.world.setFacing(x, y, z, dir);
      this.world.editLog.set(key, targetId);
      this.recordEdit(x, y, z, targetId);
    }
  }

  openCraftingTable() {
    this.uiMode = 'inventory';
    this.input.exitLock();
    this.hud.showCraftingTable();
  }

  openFurnace() {
    this.uiMode = 'furnace';
    this.input.exitLock();
    this.hud.showFurnace();
  }

  closeFurnace() {
    const inv = this.player.inventory;
    const f = inv.furnace;
    // anything left in the furnace goes back to the pack so nothing is lost
    for (const which of ['input', 'fuel', 'output']) {
      const s = f[which];
      if (s) { inv.add(s.id, s.count); f[which] = null; }
    }
    if (inv.cursor) { inv.add(inv.cursor.id, inv.cursor.count); inv.cursor = null; }
    this.uiMode = 'playing';
    this.hud.hideFurnace();
    this.hadLock = false;
    this.input.requestLock();
    this.hud.refreshHotbar();
  }

  /** Open the chest at a position (creating its 27-slot storage on first use). */
  openChest(x, y, z) {
    this.chestPos = { x, y, z, kind: 'chest' };
    this.uiMode = 'chest';
    this.input.exitLock();
    this.hud.showChest();
  }

  /** Open a hopper or dispenser's 9-slot storage. */
  openSmallContainer(kind, x, y, z) {
    this.chestPos = { x, y, z, kind };
    this.uiMode = 'chest';
    this.input.exitLock();
    this.hud.showChest();
  }

  /** The chest storage currently open, if any. */
  currentChest() {
    if (!this.chestPos) return null;
    const { x, y, z, kind } = this.chestPos;
    return this.world.containerAt(kind || 'chest', x, y, z, false);
  }

  closeChest() {
    const inv = this.player.inventory;
    if (inv.cursor) { inv.add(inv.cursor.id, inv.cursor.count); inv.cursor = null; }
    this.chestPos = null;
    this.bobber = null;
    this.uiMode = 'playing';
    this.hud.hideChest();
    this.hadLock = false;
    this.input.requestLock();
    this.hud.refreshHotbar();
  }

  /**
   * A mob fires a projectile at the player. Used by skeletons; the arrow is the same
   * entity the player's bow produces, so it drains into the same collision code.
   */
  mobShoot(mob, player) {
    const arrowId = resolveAny('arrow');
    const sx = mob.x, sy = mob.y + mob.height * 0.85, sz = mob.z;
    const dx = player.x - sx;
    const dy = (player.y + 1.2) - sy;
    const dz = player.z - sz;
    const dist = Math.hypot(dx, dy, dz) || 1;
    const speed = 22;
    // lead the shot slightly so a walking player can still be hit
    const flight = dist / speed;
    const tx = player.x + player.vx * flight * 0.8;
    const tz = player.z + player.vz * flight * 0.8;
    const ex = tx - sx, ez = tz - sz;
    const horiz = Math.hypot(ex, ez) || 1;
    const arrow = new ItemEntity(arrowId, 1, sx, sy, sz);
    arrow.vx = (ex / horiz) * speed * 0.92;
    arrow.vz = (ez / horiz) * speed * 0.92;
    arrow.vy = (dy / dist) * speed * 0.55 + 3.2;
    arrow.pickupDelay = 3.0;
    arrow.arrow = { damage: mob.def.damage || 2, power: 0.8, hostile: true };
    this.arrows.push(arrow);
    this.audio.mob(mob.def.sound);
  }

  /**
   * Draw the bow: charge builds while the right button is held, and releasing fires an
   * arrow whose speed and damage scale with how long it was drawn.
   */
  updateBow(dt) {
    if (!this.bowCharging) return;
    if (!this.input.buttons[2] || !isBow(this.player.inventory.heldId)) {
      if (!this.input.buttons[2]) this.releaseBow();
      else { this.bowCharging = false; this.bowCharge = 0; }
      return;
    }
    this.bowCharge = Math.min(1, (this.bowCharge || 0) + dt / 1.0);   // full draw in 1s
  }

  releaseBow() {
    const charge = this.bowCharge || 0;
    this.bowCharging = false;
    this.bowCharge = 0;
    const inv = this.player.inventory;
    const bowId = inv.heldId;
    if (!isBow(bowId)) return;
    // need an arrow somewhere in the pack
    let arrowSlot = -1;
    for (let i = 0; i < INVENTORY_SIZE; i++) {
      const s = inv.slots[i];
      if (s && s.id === resolveAny('arrow')) { arrowSlot = i; break; }
    }
    if (arrowSlot < 0) { this.hud.toast('没有箭了'); return; }
    if (charge < 0.15) return;                       // too weak to fire
    const arrowId = resolveAny('arrow');
    if (!this.player.inventory.creative) {
      inv.slots[arrowSlot].count--;
      if (inv.slots[arrowSlot].count <= 0) inv.slots[arrowSlot] = null;
    }
    const p = this.player;
    const [dx, dy, dz] = p.lookDir();
    const speed = 18 + 42 * charge;
    const arrow = new ItemEntity(arrowId, 1, p.x, p.eyeY - 0.15, p.z);
    arrow.vx = dx * speed; arrow.vy = dy * speed + 2; arrow.vz = dz * speed;
    arrow.pickupDelay = 2.5;
    arrow.arrow = { damage: 2 + bowPower(bowId) * charge * 2, power: charge };
    this.arrows.push(arrow);
    this.audio.step('wood');
    if (this.player.inventory.damageHeld(1)) this.hud.toast('弓已损坏');
    this.hud.refreshHotbar();
  }

  /**
   * Advance arrows: simple ballistics plus a segment test against mobs so a fast arrow
   * cannot tunnel through a target.
   */
  updateArrows(dt) {
    const p = this.player;
    for (const a of this.arrows) {
      const px = a.x, py = a.y, pz = a.z;
      a.age += dt;
      a.vy -= GRAVITY * 0.55 * dt;
      a.x += a.vx * dt; a.y += a.vy * dt; a.z += a.vz * dt;
      a.spin += dt * 8;
      // block collision
      if (this.world.isSolidAt(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z))) {
        a.dead = true;
        continue;
      }
      // mob collision: closest approach along this frame's segment
      if (a.arrow) {
        const sx = a.x - px, sy = a.y - py, sz = a.z - pz;
        const segLen2 = sx * sx + sy * sy + sz * sz || 1e-6;
        // hostile arrows hit the player instead of mobs
        if (a.arrow.hostile) {
          const target = p;
          const hw = 0.45;
          const cx = target.x - px, cy = (target.y + 0.9) - py, cz = target.z - pz;
          let t = (cx * sx + cy * sy + cz * sz) / segLen2;
          t = Math.max(0, Math.min(1, t));
          const qx = px + sx * t - target.x;
          const qy = py + sy * t - (target.y + 0.9);
          const qz = pz + sz * t - target.z;
          if (Math.abs(qx) < hw && Math.abs(qz) < hw && Math.abs(qy) < 0.95 && !target.dead) {
            const points = armorPoints(this.player.inventory);
            const mitigated = a.arrow.damage * (1 - Math.min(0.8, points * 0.04));
            this.player.damage(mitigated, 'arrow');
            this.player.inventory.damageArmor(1);
            this.audio.hurt();
            this.lastDamageCause = '被骷髅射死了';
            a.dead = true;
          }
        }
        for (const m of this.mobs) {
          if (m.dead || a.dead) continue;
          if (a.arrow.hostile && !m.def.passive) continue;
          const hw = m.width / 2 + 0.25;
          const cx = m.x - px, cy = (m.y + m.height / 2) - py, cz = m.z - pz;
          let t = (cx * sx + cy * sy + cz * sz) / segLen2;
          t = Math.max(0, Math.min(1, t));
          const qx = px + sx * t - m.x, qy = py + sy * t - (m.y + m.height / 2), qz = pz + sz * t - m.z;
          if (Math.abs(qx) < hw && Math.abs(qz) < hw && Math.abs(qy) < m.height / 2 + 0.25) {
            m.damage(Math.round(a.arrow.damage), this.mobApi());
            m.vx += a.vx * 0.15; m.vz += a.vz * 0.15;
            a.dead = true;
            break;
          }
        }
      }
      if (a.age > 20 || a.y < -10) a.dead = true;
    }
    if (this.arrows.some((a) => a.dead)) this.arrows = this.arrows.filter((a) => !a.dead);
  }

  // ------------------------------------------------------------------ the End
  /** Spawn the Ender Dragon and its healing crystals on the centre island. */
  spawnDragon() {
    const gen = this.world.gen;
    const crystals = (gen.crystals || []).map((c) => ({ ...c }));
    this.dragonCrystals = crystals;
    const dragon = new Mob('ender_dragon', 0, 74, 24);
    dragon.boss = true;
    this.boss = dragon;
    this.mobs.push(dragon);
    this.bossDefeated = false;
    return dragon;
  }

  /** Called when the dragon dies: open the exit portal and celebrate. */
  onDragonDefeated(dragon) {
    this.boss = null;
    this.bossDefeated = true;
    this.player.addXp(dragon.def.xp || 500);
    this.hud.toast('末影龙已被击败！');
    this.showVictory();
    // light the exit portal so the player can go home
    const gen = this.world.gen;
    if (gen && gen.buildExitPortal) gen.buildExitPortal(this.world);
  }

  /** The victory screen shown after the dragon falls. */
  showVictory() {
    if (this.victoryShown) return;
    this.victoryShown = true;
    this.uiMode = 'victory';
    this.input.exitLock();
    if (this.hud.showVictory) this.hud.showVictory();
  }

  /**
   * Hoe on dirt/grass -> farmland. Uses a small amount of the hoe's durability, and
   * refuses when there is no block to till or the wrong tool is held.
   */
  tryTill(hit) {
    const inv = this.player.inventory;
    const held = inv.heldId;
    const info = toolInfo(held);
    if (!info || info.tool !== 'hoe') return false;
    if (!hit) return false;
    const key = BLOCKS[hit.id] ? BLOCKS[hit.id].key : null;
    if (key !== 'dirt' && key !== 'grass') return false;
    const above = baseId(this.world.getBlockRaw(hit.x, hit.y + 1, hit.z));
    if (above !== 0 && !LIQUID[above]) return false;         // must be exposed
    this.world.setBlockAt(hit.x, hit.y, hit.z, idOf('farmland'));
    this.recordEdit(hit.x, hit.y, hit.z, idOf('farmland'));
    this.audio.step('grass');
    this.player.inventory.damageHeld(1);
    this.hud.refreshHotbar();
    return true;
  }

  /** Seeds on farmland -> wheat at stage 0. */
  tryPlantSeeds(hit) {
    if (!hit) return false;
    const inv = this.player.inventory;
    if (inv.heldId !== resolveAny('seeds')) return false;
    const key = BLOCKS[hit.id] ? BLOCKS[hit.id].key : null;
    if (key !== 'farmland') return false;
    const wx = hit.x, wy = hit.y + 1, wz = hit.z;
    if (baseId(this.world.getBlockRaw(wx, wy, wz)) !== 0) return false;
    const wheatId = idOf('wheat');
    this.world.setBlockAt(wx, wy, wz, wheatId);
    this.world.setFacing(wx, wy, wz, 0);                     // stage 0
    this.recordEdit(wx, wy, wz, wheatId);
    this.audio.step('grass');
    inv.consumeHeld();
    this.hud.refreshHotbar();
    return true;
  }

  /**
   * Sleep in a bed: only at night, only on the surface. Sets the respawn point and
   * skips to dawn, which is the main way to survive the night early on.
   */
  trySleep(hit) {
    const p = this.player;
    if (!hit) return;
    if (!this.isNight()) { this.hud.toast('只能在夜晚睡觉'); return; }
    if (!p.onGround) { this.hud.toast('必须站在地面上'); return; }
    p.spawnPoint = { x: hit.x + 0.5, y: hit.y + 1, z: hit.z + 0.5 };
    this.sleeping = 1.6;
    this.hud.toast('睡觉中… 已设置重生点');
    this.audio.eat();
    this.recordEdit(hit.x, hit.y, hit.z, idOf('bed'));
  }

  /** Fade + time skip while sleeping. */
  updateSleeping(dt) {
    if (!this.sleeping) return;
    this.sleeping -= dt;
    if (this.sleeping <= 0) {
      this.sleeping = 0;
      // jump to just after sunrise
      this.dayTime = 0.02;
      this.player.health = Math.min(this.player.maxHealth, this.player.health + 4);
      this.hud.toast('早安！生命值已恢复');
    }
  }

  /**
   * Random block ticks: crop growth and falling blocks. Called a few times per second
   * from the main loop with a handful of random cells per nearby chunk.
   */
  onBlockTick(wx, wy, wz, id) {
    const key = BLOCKS[id] ? BLOCKS[id].key : null;
    if (key === 'wheat') {
      const stage = this.world.getFacing(wx, wy, wz);
      if (stage >= 3) return;                                 // fully grown
      // wet farmland below speeds growth up
      const belowKey = BLOCKS[baseId(this.world.getBlockRaw(wx, wy - 1, wz))];
      const chance = (belowKey && belowKey.key === 'farmland') ? 0.42 : 0.22;
      if (Math.random() > chance) return;
      this.world.setFacing(wx, wy, wz, stage + 1);
      this.world.markDirty(wx >> 4, wz >> 4);
      return;
    }
    if (key === 'sand' || key === 'gravel') {
      const below = baseId(this.world.getBlockRaw(wx, wy - 1, wz));
      if (below === 0 || LIQUID[below]) {
        let ty = wy - 1;
        while (ty > 1) {
          const b = baseId(this.world.getBlockRaw(wx, ty - 1, wz));
          if (b === 0 || LIQUID[b]) ty--; else break;
        }
        this.world.setBlockAt(wx, wy, wz, 0);
        this.world.setBlockAt(wx, ty, wz, id);
        this.recordEdit(wx, wy, wz, 0);
        this.recordEdit(wx, ty, wz, id);
      }
    }
  }

  // ------------------------------------------------------------------ dimensions
  /**
   * Lazily build a dimension's World and remember it, so travelling back and forth keeps
   * each dimension's chunks, chests and edits.
   */
  dimensionWorld(name) {
    this.dimensions = this.dimensions || {};
    if (this.dimensions[name]) return this.dimensions[name];
    // the world the game started with IS the overworld, so register it rather than
    // building a second one — otherwise there is nowhere to travel back to
    if (name === 'overworld' && this.world && this.world.dimension === 'overworld') {
      this.dimensions.overworld = this.world;
      return this.world;
    }
    const seed = this.world ? this.world.seed : this.seed;
    const gen = name === 'nether' ? new NetherGen(seed)
      : name === 'end' ? new EndGen(seed)
        : null;
    if (!gen) return this.world;
    const w = new World(seed, { viewDistance: this.settings.renderDistance, dimension: name, gen });
    w.lootResolver = (roll) => (roll.id ? roll.id : resolveAny(roll.itemKey));
    // share the overworld's structure chest registry so loot themes resolve anywhere
    if (this.world && this.world.structureChests) w.structureChests = this.world.structureChests;
    this.dimensions[name] = w;
    return w;
  }

  /** Move the player to another dimension, landing them at a safe spot near (x,z). */
  travelTo(name, x, z) {
    const target = this.dimensionWorld(name);
    if (!target || target === this.world) return false;
    // remember where we left, so stepping back through the portal returns near the frame
    if (name === 'overworld') {
      const back = this.portalReturn || { x, z };
      x = back.x; z = back.z;
    }
    this.world = target;
    this.player.world = target;
    // generate the arrival area, then carve out a landing pocket and a return portal
    this.world.update(x, z, 150);
    const gx = Math.floor(x), gz = Math.floor(z);

    // ---- the End: arrive on the obsidian platform and wake the dragon
    if (name === 'end') {
      const spawn = this.world.gen.findSpawn ? this.world.gen.findSpawn() : { x: gx + 0.5, y: 64, z: gz + 0.5 };
      this.world.update(spawn.x, spawn.z, 200);
      this.player.x = spawn.x; this.player.z = spawn.z;
      this.player.y = spawn.y;
      this.player.vx = this.player.vy = this.player.vz = 0;
      this.mobs = [];
      this.items = [];
      this.arrows = [];
      this.spawnDragon();
      this.portalCooldown = 4.0;
      this.hud.toast('末地 · 击败末影龙');
      this.audio.explode();
      return true;
    }

    const groundY = this.world.findSurfaceY(gx, gz);
    const y = name === 'nether' ? Math.max(groundY, LAVA_LEVEL + 3) : groundY;
    const safeY = this.safeArrivalY(gx, gz, y);
    // clear a small landing cavern so the player never spawns inside rock
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = 0; dy <= 3; dy++) this.world.setBlockAt(gx + dx, safeY + dy, gz + dz, 0);
        if (!this.world.isSolidAt(gx + dx, safeY - 1, gz + dz)) {
          this.world.setBlockAt(gx + dx, safeY - 1, gz + dz, idOf('obsidian'));
        }
      }
    }
    this.player.x = x + 0.5;
    this.player.z = z + 0.5;
    this.player.y = safeY;
    this.player.vx = this.player.vy = this.player.vz = 0;
    // build the matching portal so the trip is reversible. Offset it clear of the landing
    // pocket (which is 5 wide), otherwise arriving would immediately re-trigger travel.
    const pf = name === 'nether' ? 0 : 2;
    this.buildPortalAt(gx + 6, safeY, gz, pf);
    // remember where the return portal is so tests and the UI can point at it
    this.portalExit = { x: gx + 6, y: safeY, z: gz };
    this.portalCooldown = 4.0;
    // entities belong to the dimension they were in
    this.mobs = [];
    this.items = [];
    this.arrows = [];
    this.mining = null;
    this.hud.toast(name === 'nether' ? '已进入下界' : '已返回主世界');
    this.audio.explode();
    return true;
  }

  /** Find two blocks of breathable headroom over solid ground, never above the roof. */
  safeArrivalY(x, z, from) {
    const ceiling = this.world.dimension === 'nether' ? NETHER_ROOF - 2 : WORLD_H - 3;
    const start = Math.max(2, Math.min(from, ceiling - 1));
    for (let y = start; y < ceiling; y++) if (this.isAirPocket(x, y, z)) return y;
    for (let y = start; y > 2; y--) if (this.isAirPocket(x, y, z)) return y;
    return Math.max(2, start);
  }

  /** Two blocks of headroom with solid ground beneath and no lava involved. */
  isAirPocket(x, y, z) {
    if (this.world.isLiquidAt(x, y, z) || this.world.isLiquidAt(x, y + 1, z)) return false;
    if (this.world.isSolidAt(x, y, z)) return false;
    if (this.world.isSolidAt(x, y + 1, z)) return false;
    return this.world.isSolidAt(x, y - 1, z);
  }

  /** Every frame: standing inside a portal block flips the player to the other dimension. */
  updatePortals(dt) {
    this.portalCooldown = Math.max(0, (this.portalCooldown || 0) - dt);
    const p = this.player;
    const portalHere = (key) => {
      const id = idOf(key);
      return this.world.getBlockRaw(Math.floor(p.x), Math.floor(p.y + 0.5), Math.floor(p.z)) === id
        || this.world.getBlockRaw(Math.floor(p.x), Math.floor(p.y + 1.5), Math.floor(p.z)) === id;
    };
    // the End's portal is one-way home; the nether portal toggles dimensions
    if (portalHere('end_portal')) {
      if (this.portalCooldown > 0) return;
      this.travelTo('overworld', Math.floor(p.x), Math.floor(p.z));
      return;
    }
    const inside = portalHere('nether_portal');
    if (!inside || this.portalCooldown > 0) {
      if (!inside) this.portalReturn = null;
      return;
    }
    const from = this.world.dimension;
    if (from === 'end') return;                    // no nether portals in the End
    const dest = from === 'nether' ? 'overworld' : 'nether';
    // remember the overworld spot so a round trip returns to the same place
    if (from === 'overworld') this.portalReturn = { x: Math.floor(p.x), z: Math.floor(p.z) };
    // the Nether is 1/8 scale in Minecraft; keep that so a trip in and back lines up
    const nx = from === 'overworld' ? Math.floor(p.x / 8) : Math.floor(p.x * 8);
    const nz = from === 'overworld' ? Math.floor(p.z / 8) : Math.floor(p.z * 8);
    const tx = dest === 'overworld' && this.portalReturn ? this.portalReturn.x : nx;
    const tz = dest === 'overworld' && this.portalReturn ? this.portalReturn.z : nz;
    // build the return portal BEFORE arriving so the player lands inside it
    this.pendingPortal = { dest, x: Math.floor(tx), z: Math.floor(tz) };
    this.travelTo(dest, Math.floor(tx), Math.floor(tz));
  }

  /**
   * Build a minimal 4x5 obsidian frame with a lit portal inside it, at a position that
   * has room. Used on arrival (so the trip is reversible) and by flint & steel.
   */
  buildPortalAt(x, y, z, facing = 0) {
    const obsId = idOf('obsidian');
    const portalId = idOf('nether_portal');
    const alongX = (facing & 1) !== 0;
    const cell = (d, cy, side) => (alongX ? [x + side, y + cy, z + d] : [x + d, y + cy, z + side]);
    // clear the whole 4x5 footprint first
    for (let d = -1; d <= 2; d++) {
      for (let side = 0; side <= 1; side++) {
        for (let cy = -1; cy <= 3; cy++) {
          const [wx, wy, wz] = cell(d, cy, side);
          this.world.setBlockAt(wx, wy, wz, 0);
        }
      }
    }
    // obsidian ring: two posts plus a lintel and a sill
    for (let d = -1; d <= 2; d++) {
      for (let side = 0; side <= 1; side++) {
        for (let cy = -1; cy <= 3; cy++) {
          const isEdge = d === -1 || d === 2 || cy === -1 || cy === 3;
          if (!isEdge) continue;
          const [wx, wy, wz] = cell(d, cy, side);
          this.world.setBlockAt(wx, wy, wz, obsId);
          this.recordEdit(wx, wy, wz, obsId);
        }
      }
    }
    // the glowing plane
    for (let d = 0; d <= 1; d++) {
      for (let side = 0; side <= 1; side++) {
        for (let cy = 0; cy <= 2; cy++) {
          const [wx, wy, wz] = cell(d, cy, side);
          this.world.setBlockAt(wx, wy, wz, portalId);
          this.world.setFacing(wx, wy, wz, facing & 3);
          this.recordEdit(wx, wy, wz, portalId);
        }
      }
    }
    this.portalCooldown = 3.0;
    return true;
  }

  /**
   * Flint & steel: look for a 2x3 pocket of air whose surrounding ring is obsidian, and
   * fill it with portal blocks. Both axes are tried.
   */
  tryLightPortal(hit) {
    if (!hit) return false;
    const obsId = idOf('obsidian');
    const portalId = idOf('nether_portal');
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -1; dy <= 3; dy++) {
        for (let dz = -2; dz <= 2; dz++) {
          const x = hit.x + dx, y = hit.y + dy, z = hit.z + dz;
          if (this.world.getBlockRaw(x, y, z) !== 0) continue;
          for (const alongX of [true, false]) {
            // interior is 2 wide (d) x 3 tall; the ring around it must be obsidian
            const inner = [];
            for (let d = 0; d <= 1; d++) {
              for (let cy = 0; cy <= 2; cy++) inner.push(alongX ? [x, y + cy, z + d] : [x + d, y + cy, z]);
            }
            if (!inner.every(([ix, iy, iz]) => this.world.getBlockRaw(ix, iy, iz) === 0)) continue;
            const ring = [];
            for (let d = -1; d <= 2; d++) {
              for (const cy of [-1, 3]) ring.push(alongX ? [x, y + cy, z + d] : [x + d, y + cy, z]);
            }
            for (const d of [-1, 2]) {
              for (let cy = 0; cy <= 2; cy++) ring.push(alongX ? [x, y + cy, z + d] : [x + d, y + cy, z]);
            }
            const ok = ring.every(([ex, ey, ez]) => {
              const id = this.world.getBlockRaw(ex, ey, ez);
              return id === obsId || id === portalId;
            });
            if (!ok) continue;
            for (const [ix, iy, iz] of inner) {
              this.world.setBlockAt(ix, iy, iz, portalId);
              this.world.setFacing(ix, iy, iz, alongX ? 0 : 2);
              this.recordEdit(ix, iy, iz, portalId);
            }
            this.audio.explode();
            this.hud.toast('传送门已点燃');
            return true;
          }
        }
      }
    }
    return false;
  }

  /** Bump the offer seed so a fresh set of enchantments is rolled each time. */
  openEnchanting() {
    this.enchantSeed = (this.enchantSeed || 0) + 1;
    const inv = this.player.inventory;
    inv.enchantOffers = null;
    this.uiMode = 'enchanting';
    this.input.exitLock();
    this.hud.showEnchant();
  }

  closeEnchanting() {
    const inv = this.player.inventory;
    if (inv.enchantItem) {
      // anything left in the table goes back to the pack so nothing is lost
      inv.add(inv.enchantItem.id, inv.enchantItem.count);
      inv.enchantItem = null;
    }
    if (inv.cursor) { inv.add(inv.cursor.id, inv.cursor.count); inv.cursor = null; }
    inv.enchantOffers = null;
    this.uiMode = 'playing';
    this.hud.hideEnchant();
    this.hadLock = false;
    this.input.requestLock();
    this.hud.refreshHotbar();
  }

  /**
   * Apply an offer from the table: pay its XP levels and stamp the enchantment on the
   * item. Re-rolling the offers is not free — the seed only moves when the table is
   * opened again, and each offer can only be taken once per item.
   */
  applyEnchantment(offer) {
    const inv = this.player.inventory;
    const stack = inv.enchantItem;
    if (!stack || !offer) return false;
    if (this.player.level < offer.cost) { this.hud.toast('经验等级不足'); return false; }
    if (stack.enchLevel(offer.key) >= offer.level) { this.hud.toast('已有同级或更高的附魔'); return false; }
    this.player.level -= offer.cost;
    stack.addEnchant(offer.key, offer.level);
    this.hud.toast(`附魔成功：${enchantLabel(offer.key, offer.level)}`);
    this.audio.levelUp();
    // that specific offer is consumed; the others stay until the table is reopened
    if (inv.enchantOffers) inv.enchantOffers[offer.slot] = null;
    return true;
  }

  /** The nearest mob the player is looking at, or null (see tryMeleeAttack). */
  aimedMob(reach = 3.6) {
    const p = this.player;
    const [dx, dy, dz] = p.lookDir();
    let best = null;
    let bestT = Infinity;
    for (const m of this.mobs) {
      if (m.dead) continue;
      const hw = m.width / 2;
      const t = rayBox(p.x, p.eyeY, p.z, dx, dy, dz,
        m.x - hw, m.y, m.z - hw, m.x + hw, m.y + m.height, m.z + hw);
      if (t === null || t < 0 || t > reach) continue;
      if (t < bestT) { bestT = t; best = m; }
    }
    return best;
  }

  /**
   * Right-click a mob with an empty hand. Villagers open their trade window, which is
   * the whole point of having them.
   */
  tryInteractMob() {
    if (this.player.inventory.held) return false;
    const m = this.aimedMob();
    if (!m || !m.def.trades) return false;
    return this.openTrade(m);
  }

  /**
   * Swing at whatever is in front of the player. This is the melee path — before it
   * existed the only way to hurt a mob was an arrow.
   *
   * The test is a ray-vs-AABB against each mob's bounding box (the same box physics
   * uses), so looking at a mob's feet still connects, exactly like Minecraft.
   * Damage comes from the held item (swords hit hardest, a fist is 1) plus Sharpness.
   * Returns true when something was hit, so the caller can skip block mining.
   */
  tryMeleeAttack(reach = 3.6) {
    const p = this.player;
    if (p.dead) return false;
    if (this.attackCooldown > 0) return false;
    const [dx, dy, dz] = p.lookDir();
    const ex = p.x, ey = p.eyeY, ez = p.z;
    let best = null;
    let bestT = Infinity;
    for (const m of this.mobs) {
      if (m.dead) continue;
      const hw = m.width / 2;
      const t = rayBox(
        ex, ey, ez, dx, dy, dz,
        m.x - hw, m.y, m.z - hw,
        m.x + hw, m.y + m.height, m.z + hw,
      );
      if (t === null || t < 0 || t > reach) continue;
      if (t < bestT) { bestT = t; best = m; }
    }
    if (!best) return false;
    const inv = this.player.inventory;
    const held = inv.held;
    const tool = toolInfo(inv.heldId);
    let damage = tool ? tool.damage : 1;
    if (held) damage += held.enchLevel('sharpness');
    damage = Math.max(1, Math.round(damage));
    best.damage(damage, this.mobApi());
    // knockback along the view direction
    best.vx += dx * 6.5; best.vz += dz * 6.5;
    best.vy = Math.max(best.vy, 3.2);
    this.audio.hurt();
    this.attackCooldown = 0.32;
    this.swingAnimation = 0.25;
    // swords wear out from use
    if (tool && tool.tool === 'sword') inv.damageHeld(1);
    return true;
  }

  /** Place a handful of villagers on solid ground near the spawn point. */
  spawnVillagersNearSpawn(cx, cz) {
    const rng = makeRng((this.world.seed ^ 0x7a1d3f) | 0);
    let placed = 0;
    for (let attempt = 0; attempt < 120 && placed < 3; attempt++) {
      const a = rng() * Math.PI * 2;
      const r = 8 + rng() * 22;
      const x = Math.floor(cx + Math.cos(a) * r);
      const z = Math.floor(cz + Math.sin(a) * r);
      const y = this.world.findSurfaceY(x, z);
      if (y <= SEA_LEVEL + 1) continue;
      if (this.world.isLiquidAt(x, y - 1, z)) continue;
      const mob = new Mob('villager', x + 0.5, y, z + 0.5);
      mob.seed = (x * 73856093) ^ (z * 19349663) ^ this.world.seed;
      mob.homeX = x + 0.5;
      mob.homeZ = z + 0.5;
      this.mobs.push(mob);
      placed++;
    }
    return placed;
  }

  // ------------------------------------------------------------------ trading
  /**
   * Open a villager's trade window. Offers are rolled once, the first time the villager
   * is spoken to, and stay the same for the rest of the session.
   */
  openTrade(villager) {
    if (!villager || !villager.def.trades) return false;
    if (!villager.offers) {
      const rolled = rollVillager(villager.seed ?? villager.id);
      villager.profession = rolled.profession;
      villager.offers = rolled.offers.map((o) => resolveOffer(o));
    }
    this.tradeVillager = villager;
    this.uiMode = 'trading';
    this.input.exitLock();
    this.hud.showTrade();
    return true;
  }

  closeTrade() {
    const inv = this.player.inventory;
    if (inv.cursor) { inv.add(inv.cursor.id, inv.cursor.count); inv.cursor = null; }
    this.tradeVillager = null;
    this.uiMode = 'playing';
    this.hud.hideTrade();
    this.hadLock = false;
    this.input.requestLock();
    this.hud.refreshHotbar();
  }

  /**
   * Complete one trade: consume the player's payment, hand over the goods, and count a
   * use against the offer so the villager eventually sells out.
   */
  doTrade(villager, offer) {
    const inv = this.player.inventory;
    if (!villager || !offer) return false;
    if (offer.uses >= offer.max) { this.hud.toast('这个交易已售罄'); return false; }
    if (inv.count(offer.giveId) < offer.give.count) {
      this.hud.toast(`材料不足：需要 ${offer.give.count} 个 ${stackName(offer.giveId)}`);
      return false;
    }
    // remove the payment
    let left = offer.give.count;
    for (let i = 0; i < INVENTORY_SIZE && left > 0; i++) {
      const s = inv.slots[i];
      if (!s || s.id !== offer.giveId) continue;
      const take = Math.min(s.count, left);
      s.count -= take; left -= take;
      if (s.count <= 0) inv.slots[i] = null;
    }
    if (left > 0) return false;
    const leftover = inv.add(offer.getId, offer.get.count);
    if (leftover > 0) {
      // no room: drop the remainder on the ground instead of losing it
      this.items.push(new ItemEntity(offer.getId, leftover, this.player.x, this.player.y + 0.5, this.player.z));
    }
    offer.uses++;
    this.player.addXp(2);
    this.audio.eat();
    this.hud.toast(`交易完成：${stackName(offer.giveId)} → ${stackName(offer.getId)} ×${offer.get.count}`);
    return true;
  }

  // ------------------------------------------------------------------ brewing & effects
  openBrewing() {
    this.uiMode = 'brewing';
    this.input.exitLock();
    this.hud.showBrewing();
  }

  closeBrewing() {
    const inv = this.player.inventory;
    const b = inv.brewing;
    // everything in the stand goes back to the pack
    if (b) {
      if (b.ingredient) { inv.add(b.ingredient.id, b.ingredient.count); b.ingredient = null; }
      for (let i = 0; i < 3; i++) {
        if (b.bottles[i]) { inv.add(b.bottles[i].id, b.bottles[i].count); b.bottles[i] = null; }
      }
      b.progress = 0;
    }
    if (inv.cursor) { inv.add(inv.cursor.id, inv.cursor.count); inv.cursor = null; }
    this.uiMode = 'playing';
    this.hud.hideBrewing();
    this.hadLock = false;
    this.input.requestLock();
    this.hud.refreshHotbar();
  }

  /** Drink the held potion, applying its effect. */
  tryDrinkPotion() {
    const inv = this.player.inventory;
    const s = inv.held;
    if (!s || s.id >= 0) return false;
    const it = itemById(s.id);
    if (!it || !it.potion) return false;
    const { effect, level } = it.potion;
    if (!effect) { this.hud.toast('这瓶药水还没有效果'); return false; }
    this.applyPotion(effect, level || 1);
    // the bottle is left behind, like Minecraft
    inv.consumeHeld();
    const bottleId = resolveAny('empty_bottle');
    if (bottleId) inv.add(bottleId, 1);
    this.hud.refreshHotbar();
    return true;
  }

  /** Apply a potion effect to the player, or its instant effect. */
  applyPotion(effect, level = 1) {
    const fx = EFFECTS[effect];
    if (!fx) return false;
    const p = this.player;
    if (effect === 'healing') {
      const amount = level === 2 ? 8 : 4;
      p.health = Math.min(p.maxHealth, p.health + amount);
      this.hud.toast(`${fx.cn}：恢复 ${amount} 点生命`);
      this.audio.levelUp();
      return true;
    }
    const seconds = (DURATION[effect] && DURATION[effect][level]) || 90;
    p.effects.apply(effect, level, seconds);
    this.hud.toast(`获得效果：${fx.cn}${level > 1 ? ' II' : ''}（${Math.round(seconds)} 秒）`);
    this.audio.eat();
    return true;
  }

  /** Tick effect timers, apply regen/poison, and keep the HUD chips in sync. */
  updateEffects(dt) {
    const p = this.player;
    const fx = p.effects;
    const expired = fx.tick(dt);
    for (const key of expired) {
      const def = EFFECTS[key];
      if (def) this.hud.toast(`${def.cn} 效果结束`);
    }
    // regeneration heals, poison hurts but never kills
    const hps = fx.healthPerSecond();
    if (hps !== 0) {
      p.regenAccum = (p.regenAccum || 0) + hps * dt;
      if (p.regenAccum >= 1) {
        p.regenAccum -= 1;
        if (hps > 0) p.health = Math.min(p.maxHealth, p.health + 1);
        else if (p.health > 1) p.damage(1, 'poison');
      }
    } else {
      p.regenAccum = 0;
    }
    // the actual fire-damage check lives in player.update, so just clear the flag here
    if (fx.has('fire_resistance')) p.burning = false;
    // a bad potion must never be able to kill
    if (p.health < 1) p.health = 1;
  }

  /** The HUD wants a plain list of active effects. */
  activeEffects() {
    const out = [];
    for (const [key, e] of this.player.effects.active) {
      const def = EFFECTS[key];
      if (!def) continue;
      out.push({ key, cn: def.cn, level: e.level, time: e.time, bad: def.bad, desc: def.desc(e.level) });
    }
    // beneficial first, then by remaining time
    out.sort((a, b) => (a.bad === b.bad ? b.time - a.time : (a.bad ? 1 : -1)));
    return out;
  }

  // ------------------------------------------------------------------ fishing
  /** Right-click with the rod: cast a bobber, or reel in whatever is on the hook. */
  useFishingRod() {
    if (this.bobber) { this.reelFishing(); return; }
    const p = this.player;
    const [dx, dy, dz] = p.lookDir();
    // a small upward arc so the hook lands a few blocks out
    this.bobber = new Bobber(
      p.x + dx * 0.6, p.eyeY - 0.1, p.z + dz * 0.6,
      dx * 13, dy * 13 + 3.2, dz * 13, p.inventory.heldId,
    );
    this.audio.step('wood');
  }

  /** Reel in: a bite means a catch, otherwise the hook just comes back. */
  reelFishing() {
    const b = this.bobber;
    this.bobber = null;
    if (!b) return;
    const inv = this.player.inventory;
    if (!b.canReel) return;
    const luck = Math.min(1, (inv.held ? inv.held.enchLevel('luck') : 0) * 0.25);
    const catchInfo = rollCatch(Math.random, luck);
    const id = resolveAny(catchInfo.key);
    if (!id) return;
    const left = inv.add(id, catchInfo.count);
    if (left > 0) this.items.push(new ItemEntity(id, left, this.player.x, this.player.y + 0.6, this.player.z));
    this.player.addXp(catchInfo.table === 'treasure' ? 6 : 2);
    this.hud.toast(`钓到了 ${stackName(id)} ×${catchInfo.count}`);
    this.audio.eat();
    if (inv.damageHeld(1)) this.hud.toast('钓鱼竿已损坏');
    this.hud.refreshHotbar();
  }

  /** Advance the bobber and keep it attached to the rod while it is out. */
  updateFishing(dt) {
    const b = this.bobber;
    if (!b) return;
    const p = this.player;
    // holding something else (or reeling the rod away) drops the line
    if (itemById(p.inventory.heldId)?.key !== 'fishing_rod') { this.bobber = null; return; }
    if (Math.hypot(b.x - p.x, b.z - p.z) > 42 || b.y < -4) { this.bobber = null; return; }
    const bx = Math.floor(b.x), by = Math.floor(b.y), bz = Math.floor(b.z);
    const inWater = this.world.isLiquidAt(bx, by, bz);
    const inGround = this.world.isSolidAt(bx, by, bz);
    const before = b.state;
    b.update(dt, inWater, inGround);
    // the moment a fish bites, splash so the player can react
    if (before !== 'biting' && b.state === 'biting') {
      this.particles.spawnBlockBreak(bx, by + 0.2, bz, idOf('water'), 6);
      this.audio.step('water');
    }
  }

  /** Right-click while holding food heals a little hunger. */
  tryEat() {    const inv = this.player.inventory;
    const s = inv.held;
    if (!s || s.id >= 0) return false;
    const value = foodValue(s.id);
    if (!value) return false;
    if (this.player.hunger >= 20 && this.player.health >= this.player.maxHealth) return false;
    this.player.hunger = Math.min(20, this.player.hunger + value);
    this.player.health = Math.min(this.player.maxHealth, this.player.health + 1);
    this.audio.eat();
    inv.consumeHeld();
    this.hud.refreshHotbar();
    this.hud.toast(`吃掉了 ${stackName(s.id)}`);
    return true;
  }

  // ------------------------------------------------------------------ UI actions
  pause() {
    if (this.uiMode !== 'playing') return;
    this.uiMode = 'paused';
    this.input.exitLock();
    this.hud.showPause();
    this.hud.refs.seedValue.textContent = String(this.world?.seed ?? '—');
  }

  resume() {
    if (!this.world) return;
    this.uiMode = 'playing';
    this.hud.hidePause();
    this.hud.hideSettings();
    this.hud.hideDeath();
    this.hud.hideInventory();
    if (this.hud.hideVictory) this.hud.hideVictory();
    this.hadLock = false;              // re-arm: a failed lock must not re-pause
    this.input.requestLock();
    this.audio.resume();
  }

  showPause() {
    this.uiMode = 'paused';
    this.hud.hideSettings();
    this.hud.showPause();
  }

  openInventory() {
    if (!this.player || !this.running) return;
    this.uiMode = 'inventory';
    this.input.exitLock();
    this.hud.showInventory();
  }
  closeInventory() {
    const inv = this.player.inventory;
    // return anything left on the cursor (and the crafting grid) to the inventory
    if (inv.cursor) { inv.add(inv.cursor.id, inv.cursor.count); inv.cursor = null; }
    inv.clearCrafting();
    this.uiMode = 'playing';
    this.hud.hideInventory();
    this.hadLock = false;
    this.input.requestLock();
    this.hud.refreshHotbar();
  }

  openChat() {
    this.uiMode = 'chat';
    this.input.exitLock();
    this.hud.showChat();
  }

  closeChat() {
    this.uiMode = 'playing';
    this.hud.hideChat();
    this.input.requestLock();
  }

  toggleGamemode() {
    const p = this.player;
    p.mode = p.mode === GAMEMODE.CREATIVE ? GAMEMODE.SURVIVAL : GAMEMODE.CREATIVE;
    p.inventory.creative = p.mode === GAMEMODE.CREATIVE;
    if (p.mode === GAMEMODE.CREATIVE) p.inventory.giveCreativePalette();
    else p.inventory.giveStarterKit();
    if (p.mode !== GAMEMODE.CREATIVE) p.flying = false;
    this.hud.toast(p.mode === GAMEMODE.CREATIVE ? '已切换到创造模式' : '已切换到生存模式');
    this.hud.refreshHotbar();
  }

  respawnPlayer() {
    this.player.respawn(this.player.spawnPoint);
    this.hud.hideDeath();
    this.uiMode = 'playing';
    this.input.requestLock();
  }

  handleChat(text) {
    if (text.startsWith('/')) {
      const [cmd, ...args] = text.slice(1).split(/\s+/);
      this.runCommand(cmd, args);
    } else if (this.net && this.net.connected) {
      // the server echoes chat back to everyone including us, so do not also print locally
      this.net.chat(text);
    } else {
      this.hud.chatLine(`<玩家> ${text}`);
    }
  }

  runCommand(cmd, args) {
    const p = this.player;
    const w = this.world;
    switch (cmd) {
      case 'help':
        this.hud.chatLine('/time set day|night · /tp x y z · /give block [n] · /gamemode creative|survival · /seed · /spawn · /kill · /weather clear|rain · /fps · /pack <url|off>', '#ffff88');
        break;
      case 'connect':
        this.connectToServer(args[0], args[1]);
        break;
      case 'disconnect':
        this.disconnectFromServer();
        break;      case 'save':
        if (!args[0]) { this.hud.toast('用法：/save <名字>'); break; }
        this.saveBlueprint(args[0]);
        break;
      case 'paste':
        this.pasteBlueprintNamed(args[0]);
        break;
      case 'bp': {
        const names = Object.keys({ ...BUILTIN_BLUEPRINTS, ...this.loadBlueprints() });
        this.hud.chatLine('蓝图：' + (names.join(' · ') || '（空）'), '#88ddff');
        break;
      }      case 'pack':
        this.loadTexturePack(args[0]);
        break;
      case 'time': {
        if (args[0] === 'set' && args[1] === 'day') this.dayTime = 0.25;
        else if (args[0] === 'set' && args[1] === 'night') this.dayTime = 0.75;
        else if (args[0]) this.dayTime = parseFloat(args[0]) || this.dayTime;
        this.hud.chatLine(`时间已设为 ${this.dayTime.toFixed(2)}`);
        break;
      }
      case 'tp': {
        const [x, y, z] = args.map(Number);
        if (!Number.isNaN(x) && !Number.isNaN(y) && !Number.isNaN(z)) {
          p.x = x; p.y = y; p.z = z; p.vy = 0;
          this.hud.chatLine(`已传送到 ${x} ${y} ${z}`);
        }
        break;
      }
      case 'give': {
        const b = blockByKey(args[0]) || BLOCKS[Number(args[0])];
        if (b) {
          const n = Number(args[1]) || 64;
          p.inventory.add(b.id, n);
          this.hud.refreshHotbar();
          this.hud.chatLine(`已给予 ${b.cn} x${n}`);
        } else this.hud.chatLine('未知方块：' + args[0], '#ff8080');
        break;
      }
      case 'gamemode': {
        const want = args[0] === 'creative' ? GAMEMODE.CREATIVE : GAMEMODE.SURVIVAL;
        if (p.mode !== want) this.toggleGamemode();
        break;
      }
      case 'seed': this.hud.chatLine('种子：' + w.seed); break;
      case 'spawn': p.x = p.spawnPoint.x; p.y = p.spawnPoint.y; p.z = p.spawnPoint.z; this.hud.chatLine('已回到出生点'); break;
      case 'kill': p.damage(1000, 'command'); break;
      case 'dim':
      case 'dimension': {
        const target = args[0] === 'end' ? 'end' : args[0] === 'nether' ? 'nether' : 'overworld';
        this.travelTo(target, Math.floor(p.x), Math.floor(p.z));
        this.hud.chatLine('已前往：' + (target === 'end' ? '末地' : target === 'nether' ? '下界' : '主世界'));
        break;
      }
      case 'dragon': {
        if (this.world.dimension !== 'end') { this.hud.chatLine('只能在末地召唤末影龙', '#ff8080'); break; }
        this.travelTo('end', 0, 0);
        this.hud.chatLine('末影龙已现身');
        break;
      }
      case 'weather': this.weather = args[0] === 'rain' ? 'rain' : 'clear'; this.hud.chatLine('天气：' + this.weather); break;
      case 'fps': this.hud.chatLine(`FPS ${this.fps.toFixed(1)} · 区块 ${w.chunks.size} · 顶点批次 ${this.renderer.stats.draws}`); break;
      default: this.hud.chatLine('未知命令：' + cmd, '#ff8080');
    }
  }

  // ------------------------------------------------------------------ interactions
  lookDir() {
    return this.player.lookDir();
  }

  raycastHit() {
    const p = this.player;
    const [dx, dy, dz] = p.lookDir();
    return this.world.raycast(p.x, p.eyeY + (this.settings.bob ? p.bob : 0), p.z, dx, dy, dz, 6.5, false);
  }

  updateMining(dt) {
    this.attackCooldown = Math.max(0, (this.attackCooldown || 0) - dt);
    if (!this.breaking || this.uiMode !== 'playing' || !this.input.locked) {
      this.mining = null; this.miningProgress = 0;
      return;
    }
    // a swing that connects with a mob does not also mine the block behind it
    if (this.tryMeleeAttack()) { this.mining = null; this.miningProgress = 0; return; }
    if (this.breakCooldown > 0) { this.breakCooldown -= dt; return; }
    const hit = this.raycastHit();
    if (!hit) { this.mining = null; this.miningProgress = 0; return; }
    const key = hit.x + ',' + hit.y + ',' + hit.z;
    if (!this.mining || this.mining.key !== key) {
      const def = BLOCKS[hit.id];
      // Mining time = block hardness / tool speed. The preferred tool class (pickaxe on
      // stone, axe on wood, shovel on dirt) gets the full multiplier; a wrong tool only
      // gets 1x, so bare hands are slow on stone exactly like Minecraft.
      const tool = toolInfo(this.player.inventory.heldId);
      const preferred = def && def.tool;
      let speed = 1;
      if (tool) {
        speed = (preferred && tool.tool === preferred) ? tool.speed : 1.0;
        // Efficiency only helps the tool that is actually appropriate for the block
        if (preferred && tool.tool === preferred) {
          const eff = this.player.inventory.held.enchLevel('efficiency');
          if (eff > 0) speed *= 1 + eff * 0.4;
        }
      }
      this.mining = {
        key, x: hit.x, y: hit.y, z: hit.z, id: hit.id,
        hardness: Math.max(0.05, (def?.hardness ?? 1) / speed),
        toolClass: tool ? tool.tool : null,
      };
      this.miningProgress = 0;
    }
    const creative = this.player.mode === GAMEMODE.CREATIVE;
    const hardness = creative ? 0.05 : this.mining.hardness;
    this.miningProgress += dt / hardness;
    this.miningSoundTimer -= dt;
    if (this.miningSoundTimer <= 0) {
      this.miningSoundTimer = 0.22;
      this.audio.dig(BLOCKS[hit.id]?.key || 'stone', this.miningProgress);
      this.particles.spawnDig(hit.x, hit.y, hit.z, hit.id, hit.nx, hit.ny, hit.nz, 2);
    }
    if (this.miningProgress >= 1) {
      // a tool that was actually used wears out
      const usedTool = !creative && this.mining.toolClass && BLOCKS[hit.id]?.tool === this.mining.toolClass;
      this.breakBlock(hit);
      if (usedTool && this.player.inventory.damageHeld(1)) this.hud.toast('工具已损坏');
      this.mining = null;
      this.miningProgress = 0;
      if (!creative) this.breakCooldown = 0.18;
    }
  }

  breakBlock(hit) {
    const id = hit.id;
    const def = BLOCKS[id];
    this.world.setBlockAt(hit.x, hit.y, hit.z, 0);
    this.recordEdit(hit.x, hit.y, hit.z, 0);
    this.audio.breakBlock(def?.key || 'stone');
    this.particles.spawnBlockBreak(hit.x, hit.y, hit.z, id, 16);
    if (this.player.mode !== GAMEMODE.CREATIVE) {
      const dropId = this.dropForBlock(id);
      if (dropId) {
        this.items.push(new ItemEntity(dropId, 1, hit.x + 0.5, hit.y + 0.5, hit.z + 0.5));
      }
      this.player.addXp(1);
    }
    // gravity blocks fall
    this.applyGravity(hit.x, hit.y + 1, hit.z);
  }

  /**
   * What a block yields when mined. Ore blocks give raw materials (coal, iron ingots,
   * diamonds) rather than themselves, exactly like Minecraft.
   */
  dropForBlock(id) {
    const def = BLOCKS[id];
    if (!def) return 0;
    const mapped = BLOCK_DROPS.get(def.key);
    if (mapped) return resolveAny(mapped);
    if (def.drop === undefined) return id;
    return def.drop;
  }

  applyGravity(x, y, z) {
    const id = baseId(this.world.getBlockRaw(x, y, z));
    const def = BLOCKS[id];
    if (!def || !def.gravity) return;
    let ty = y;
    while (ty > 1) {
      const below = baseId(this.world.getBlockRaw(x, ty - 1, z));
      if (below === 0 || LIQUID[below]) ty--;
      else break;
    }
    if (ty !== y) {
      this.world.setBlockAt(x, y, z, 0);
      this.world.setBlockAt(x, ty, z, id);
      this.recordEdit(x, y, z, 0);
      this.recordEdit(x, ty, z, id);
    }
  }

  /**
   * Facing direction a newly placed block should have, from the block back toward the
   * player (Minecraft puts a furnace's front toward you). 0=+X 1=-X 2=+Z 3=-Z 4=+Y 5=-Y.
   */
  facingFromPlayer(x, y, z) {
    const p = this.player;
    const dx = p.x - (x + 0.5);
    const dy = (p.eyeY) - (y + 0.5);
    const dz = p.z - (z + 0.5);
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    if (ay > ax && ay > az) return dy > 0 ? 4 : 5;
    if (ax >= az) return dx > 0 ? 0 : 1;
    return dz > 0 ? 2 : 3;
  }

  placeBlock() {
    const hit = this.raycastHit();
    if (!hit) return;
    const id = this.player.inventory.heldId;
    if (!id || !BLOCKS[id]) return;
    const x = hit.x + hit.nx, y = hit.y + hit.ny, z = hit.z + hit.nz;
    const existing = baseId(this.world.getBlockRaw(x, y, z));
    if (existing !== 0 && !(BLOCKS[existing]?.replaceable)) return;
    // never place inside the player
    const p = this.player;
    const hw = 0.3;
    const overlaps = (x + 1 > p.x - hw && x < p.x + hw &&
      z + 1 > p.z - hw && z < p.z + hw &&
      y + 1 > p.y && y < p.y + 1.8);
    if (overlaps && SOLID[id]) return;
    // plants need solid ground below
    if (RENDER[id] === R.PLANT && !SOLID[baseId(this.world.getBlockRaw(x, y - 1, z))]) return;
    this.world.setBlockAt(x, y, z, id);
    if (BLOCKS[id].directional) {
      const dir = this.facingFromPlayer(x, y, z);
      this.world.setFacing(x, y, z, dir);
      this.world.markDirty(x >> 4, z >> 4);
    }
    this.recordEdit(x, y, z, id);
    this.audio.placeBlock(BLOCKS[id].key);
    this.player.inventory.consumeHeld();
    this.hud.refreshHotbar();
    // torches are a light source: relight happened inside setBlockAt
  }

  /** Right-clicking a facing block cycles its orientation (handy for building). */
  rotateBlock(hit) {
    if (!hit || !BLOCKS[hit.id] || !BLOCKS[hit.id].directional) return false;
    const next = ((hit.facing || 0) + 1) % 4;      // cycle the four horizontal facings
    this.world.setFacing(hit.x, hit.y, hit.z, next);
    this.world.markDirty(hit.x >> 4, hit.z >> 4);
    this.audio.placeBlock(BLOCKS[hit.id].key);
    this.hud.toast(`${BLOCKS[hit.id].cn} 朝向 ${['东', '西', '南', '北'][next]}`);
    return true;
  }

  pickBlock() {
    const hit = this.raycastHit();
    if (!hit) return;
    const inv = this.player.inventory;
    // creative pick gives a full stack straight into the held slot
    if (inv.creative) {
      inv.slots[inv.selected] = new ItemStack(hit.id, 64);
      this.hud.refreshHotbar();
      return;
    }
    for (let i = 0; i < 9; i++) {
      if (inv.slots[i] && inv.slots[i].id === hit.id) { inv.selected = i; this.hud.refreshHotbar(); return; }
    }
    if (inv.add(hit.id, 1) === 0) this.hud.refreshHotbar();
  }

  dropHeld() {
    const inv = this.player.inventory;
    const s = inv.slots[inv.selected];
    if (!s) return;
    const [dx, dy, dz] = this.player.lookDir();
    const e = new ItemEntity(s.id, 1, this.player.x + dx * 0.6, this.player.eyeY - 0.3, this.player.z + dz * 0.6);
    e.vx = dx * 6; e.vy = dy * 6 + 1.5; e.vz = dz * 6;
    e.pickupDelay = 1.0;
    this.items.push(e);
    inv.consumeHeld();
    this.hud.refreshHotbar();
  }

  emitFootstepParticles() {
    const p = this.player;
    const bx = Math.floor(p.x), by = Math.floor(p.y - 0.1), bz = Math.floor(p.z);
    const under = baseId(this.world.getBlockRaw(bx, by, bz));
    if (under && BLOCKS[under]) this.particles.spawnDig(bx, by, bz, under, 0, 1, 0, 1);
  }

  recordEdit(x, y, z, id) {
    if (!this.world.editLog) this.world.editLog = new Map();
    this.world.editLog.set(x + ',' + y + ',' + z, id);
    // relay our own changes; remote edits are applied straight to the world and never
    // come through here, so this cannot echo
    if (this.net && this.net.connected) this.net.edit(x, y, z, id);
  }

  // ------------------------------------------------------------------ simulation
  spawnMobsForFrame(dt) {
    // hostile mobs: night-time dark spawns near the player, capped for performance
    const night = this.isNight();
    const hostileCount = this.mobs.filter((m) => m.def.hostile && !m.dead).length;
    const passiveCount = this.mobs.filter((m) => !m.def.hostile && !m.dead).length;
    this.mobSpawnTimer = (this.mobSpawnTimer || 0) - dt;
    if (this.mobSpawnTimer > 0) return;
    this.mobSpawnTimer = 2.5;
    if (this.mobs.length > 42) return;
    const p = this.player;
    if (night && hostileCount < 18) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const a = Math.random() * Math.PI * 2, r = 22 + Math.random() * 30;
        const x = Math.floor(p.x + Math.cos(a) * r), z = Math.floor(p.z + Math.sin(a) * r);
        const y = this.world.findSurfaceY(x, z);
        if (y < 2 || y > WORLD_H - 4) continue;
        const sky = skyLevel(this.world, x, y, z);
        if (sky > 7) continue;                        // too bright for hostile spawns
        if (!this.world.chunks.has((x >> 4) * 8192 + (z >> 4))) continue;
        const kind = Math.random() < 0.34 ? 'zombie'
          : Math.random() < 0.55 ? 'skeleton'
            : Math.random() < 0.6 ? 'spider' : 'creeper';
        this.mobs.push(new Mob(kind, x + 0.5, y, z + 0.5));
        break;
      }
    } else if (!night && passiveCount < 16 && Math.random() < 0.5) {
      const a = Math.random() * Math.PI * 2, r = 26 + Math.random() * 26;
      const x = Math.floor(p.x + Math.cos(a) * r), z = Math.floor(p.z + Math.sin(a) * r);
      const y = this.world.findSurfaceY(x, z);
      if (y < SEA_LEVEL) return;
      if (!this.world.chunks.has((x >> 4) * 8192 + (z >> 4))) return;
      const kind = ['pig', 'cow', 'sheep', 'chicken'][(Math.random() * 4) | 0];
      this.mobs.push(new Mob(kind, x + 0.5, y, z + 0.5));
    }
  }

  explode(x, y, z, power) {
    this.audio.explode();
    this.particles.spawnExplosion(x, y, z, 70);
    const r = Math.ceil(power);
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dz = -r; dz <= r; dz++) {
          const d = Math.hypot(dx, dy, dz);
          if (d > power) continue;
          const bx = Math.floor(x) + dx, by = Math.floor(y) + dy, bz = Math.floor(z) + dz;
          const id = baseId(this.world.getBlockRaw(bx, by, bz));
          if (!id || id === 11) continue;              // bedrock survives
          if (Math.random() < 0.85) {
            this.world.setBlockAt(bx, by, bz, 0);
            this.recordEdit(bx, by, bz, 0);
          }
        }
      }
    }
    // damage the player with distance falloff
    const pd = Math.hypot(this.player.x - x, this.player.y - y, this.player.z - z);
    if (pd < power * 2) {
      const dmg = Math.round((1 - pd / (power * 2)) * 24);
      if (dmg > 0) {
        this.player.damage(dmg, 'explosion');
        const [dx, dy, dz] = this.player.lookDir();
        const kx = this.player.x - x, kz = this.player.z - z;
        const kl = Math.hypot(kx, kz) || 1;
        this.player.vx += (kx / kl) * 12;
        this.player.vz += (kz / kl) * 12;
        this.player.vy += 9;
        this.audio.hurt();
      }
    }
  }

  isNight() {
    // dayTime 0 = sunrise, 0.25 = noon, 0.5 = sunset, 0.75 = midnight
    return this.dayTime > 0.52 && this.dayTime < 0.98;
  }

  sunDirection() {
    const a = (this.dayTime - 0.25) * Math.PI * 2;
    return [Math.sin(a) * 0.4, Math.cos(a), Math.sin(a) * 0.9];
  }

  dayLightLevel() {
    // 1.0 at noon, 0.22 at midnight, smoothed through dawn/dusk
    const t = this.dayTime;
    const elevation = Math.cos((t - 0.25) * Math.PI * 2);   // 1 at noon, -1 at midnight
    const l = clamp((elevation + 0.22) / 1.22, 0, 1);
    return 0.22 + 0.78 * Math.pow(l, 0.85);
  }

  updateDayNight(dt) {
    this.dayTime = (this.dayTime + dt / this.dayLength) % 1;
  }

  skyColors() {
    const t = this.dayTime;
    const day = this.dayLightLevel();
    // The Nether has no sky and no day cycle: hot haze lit by lava, dimmer than daylight.
    // The End has no sky and no day cycle: a near-black starfield lit by the crystals.
    if (this.world && this.world.dimension === 'end') {
      return {
        zenith: [0.02, 0.01, 0.05],
        horizon: [0.06, 0.03, 0.12],
        day: 0.30,
        end: true,
      };
    }
    if (this.world && this.world.dimension === 'nether') {
      return {
        zenith: [0.30, 0.07, 0.06],
        horizon: [0.52, 0.14, 0.07],
        day: 0.42,
        nether: true,
      };
    }
    const dusk = clamp(1 - Math.abs(((t + 0.5) % 1) - 0.5) * 8, 0, 1); // peaks at dawn/dusk
    // Blend a genuinely dark night palette into the daytime blue. The old formula put a
    // bright blue base under everything, so "night" still looked like noon.
    const lum = clamp((day - 0.22) / 0.78, 0, 1);
    const mix3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    const zen = mix3([0.012, 0.018, 0.055], [0.34, 0.58, 0.94], Math.pow(lum, 0.8));
    const hor = mix3([0.045, 0.055, 0.110], [0.72, 0.83, 0.96], Math.pow(lum, 0.7));
    // dawn/dusk warms the horizon without brightening the zenith
    hor[0] += 0.34 * dusk;
    hor[1] += 0.14 * dusk;
    hor[2] -= 0.10 * dusk;
    return { zenith: zen, horizon: hor, day };
  }

  // ------------------------------------------------------------------ frame loop
  /**
   * Advance the simulation and render one frame with an explicit delta.
   * The rAF loop calls this, and the automated harness calls it directly so tests do
   * not depend on the browser's frame scheduling (which is throttled when a window is
   * occluded or when several windows overlap).
   */
  stepFrame(dt = 1 / 60) {
    if (!this.running || !this.world) return false;
    this.tick(dt);
    this.render(dt);
    return true;
  }

  /** Run `count` fixed-size frames synchronously; used by tools/verify.mjs. */
  simulate(count = 60, dt = 1 / 60) {
    const t0 = performance.now();
    for (let i = 0; i < count; i++) {
      if (!this.running || !this.world) break;
      this.tick(dt);
    }
    const ms = performance.now() - t0;
    return { frames: count, ms, simMsPerFrame: ms / count };
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.resize(w, h, this.dpr);
  }

  start() {
    if (this.hasSavedWorld()) this.hud.refs.continueBtn.classList.remove('hidden');
    this.hud.setCredits('WebGL2 · ' + (this.renderer.gl.getParameter(this.renderer.gl.VERSION) || ''));
    this.lastFrame = performance.now();
    const loop = (now) => {
      this.frame(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  frame(now) {
    const rawDt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    const dt = Math.min(rawDt, 0.1);

    // the render loop is the authoritative frame timer (stepFrame/simulate bypass it)
    this.recordFrameTime(rawDt);
    this.fpsTimer += rawDt;
    if (this.fpsTimer >= 0.25) {
      const n = Math.min(this.frameCount, this.frameTimes.length);
      let sum = 0;
      for (let i = 0; i < n; i++) sum += this.frameTimes[i];
      const avg = sum / n;
      this.fps = avg > 0 ? 1000 / avg : 0;
      this.perf.samples.push(this.fps);
      if (this.perf.samples.length > 120) this.perf.samples.shift();
      this.fpsTimer = 0;
      this.frameCount = 0;
      this.perf.minFps = Math.min(this.perf.minFps, this.fps);
      this.governPerformance();
    }

    if (!this.running || !this.world) {
      // idle screen: still clear so the title backdrop looks clean
      const gl = this.renderer.gl;
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      return;
    }

    if (this.fixedStep) this.tick(1 / 60);
    else this.tick(dt);
    this.render(dt);
  }

  recordFrameTime(rawDt) {
    this.frameTimes[this.frameIndex] = rawDt * 1000;
    this.frameIndex = (this.frameIndex + 1) % this.frameTimes.length;
    this.frameCount++;
  }

  governPerformance() {
    if (!this.settings.adaptive || !this.world) return;
    const s = this.perf.samples;
    if (s.length < 12) return;
    const recent = s.slice(-12);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const w = this.world;
    if (avg < 55 && w.viewDistance > 4 && !this.perf.backingOff) {
      this.perf.backingOff = true;
      w.viewDistance -= 1;
      this.hud.toast(`帧率不足，渲染距离降至 ${w.viewDistance} 区块`);
      setTimeout(() => { this.perf.backingOff = false; }, 6000);
    } else if (avg > 90 && w.viewDistance < this.settings.renderDistance && !this.perf.backingOff) {
      w.viewDistance += 1;
    }
  }

  tick(dt) {
    const p = this.player;
    const input = this.input;
    this.playTime += dt;
    this.updateDayNight(dt);

    if (this.uiMode === 'playing') {
      const mv = input.movement();
      // the mouse-look delta is consumed before physics so a big swing cannot
      // teleport the player through a wall
      const [dx, dy] = input.takeMouse();
      p.yaw += dx;
      p.pitch = clamp(p.pitch - dy, -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001);
      p.yaw = ((p.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;

      if (this.sprintToggle && !mv.forward) this.sprintToggle = false;
      mv.sprint = mv.sprint || this.sprintToggle;
      p.update(dt, mv);

      this.placeCooldown -= dt;
      if (input.buttons[2] && this.placeCooldown <= 0) { this.placeBlock(); this.placeCooldown = 0.22; }
      // a shield only stays up while the button is actually held
      if (this.player.blocking && !input.buttons[2]) this.player.blocking = false;
      this.updateMining(dt);
    } else {
      // keep physics idling so the world does not freeze mid-air
      p.update(dt, { forward: false, back: false, left: false, right: false, jump: false, sneak: false, sprint: false });
      input.takeMouse();
    }

    // ---- world streaming
    this.world.update(p.x, p.z);
    // crops grow and loose blocks settle a few times a second
    this.world.randomTick(dt, p.x, p.z, (wx, wy, wz, id) => this.onBlockTick(wx, wy, wz, id));
    // buttons pop back out and pressure plates react to whoever is standing on them
    this.world.tickRedstone(dt, [p, ...this.mobs]);
    // hoppers move items between containers on their own slow cadence
    this.updateFishing(dt);
    if (this.net) this.net.tick(dt, this.player);
    this.world.tickHoppers(dt, this.world.chunks);
    this.world.tickRepeaters(dt);
    this.updateSleeping(dt);
    this.updateEffects(dt);
    // the brewing stand runs whether or not its UI is open
    if (this.player.inventory.tickBrewing(dt, brewResult) && this.hud.isBrewingOpen()) this.hud.refreshBrewing();
    this.updatePortals(dt);
    this.unloadTimer = (this.unloadTimer || 0) + dt;
    if (this.unloadTimer > 2) {
      this.unloadTimer = 0;
      this.world.unloadFar(p.x, p.z, (chunk) => this.renderer.freeChunk(chunk));
    }
    // Upload freshly meshed chunks, nearest first and time-budgeted: uploading every
    // pending chunk in one frame was the source of the periodic 16ms spikes (ten chunks
    // crossing a boundary would all hit bufferData together).
    const pendingUpload = [];
    for (const c of this.world.chunks.values()) {
      if (c.mesh && c.meshVersion !== c._uploadedVersion) pendingUpload.push(c);
    }
    if (pendingUpload.length) {
      const pcx = Math.floor(p.x) >> 4, pcz = Math.floor(p.z) >> 4;
      pendingUpload.sort((a, b) => {
        const da = Math.abs(a.cx - pcx) + Math.abs(a.cz - pcz);
        const db = Math.abs(b.cx - pcx) + Math.abs(b.cz - pcz);
        return da - db;
      });
      const tUpload = performance.now();
      let done = 0;
      for (const c of pendingUpload) {
        if (done >= 4 || performance.now() - tUpload > 2.5) break;
        this.renderer.uploadChunk(c);
        c._uploadedVersion = c.meshVersion;
        done++;
      }
    }

    // ---- entities
    const api = this.mobApi();
    api.meleeBonus = this.player.effects.meleeBonus();
    // the dragon heals while any of its crystals are still standing
    if (this.boss) {
      const alive = (this.dragonCrystals || []).filter((c) => c.alive).length;
      this.boss.bossTick(dt, alive);
      if (this.boss.dead || this.boss.hp <= 0) this.onDragonDefeated(this.boss);
    }
    for (const m of this.mobs) m.update(dt, this.world, p, api);
    if (this.mobs.some((m) => m.dead)) this.mobs = this.mobs.filter((m) => !m.dead);
    for (const it of this.items) it.update(dt, this.world, p, { items: this.items, pickupSound: () => this.audio.eat() });
    if (this.items.some((i) => i.dead)) this.items = this.items.filter((i) => !i.dead);
    this.updateBow(dt);
    this.updateArrows(dt);
    // arrows that landed can be picked back up
    for (const a of this.arrows) {
      if (a.age < 1 || p.dead) continue;
      if (Math.hypot(a.x - p.x, a.y - p.y, a.z - p.z) < 1.4) {
        if (p.inventory.add(a.id, 1) === 0) a.dead = true;
      }
    }
    if (this.arrows.some((a) => a.dead)) this.arrows = this.arrows.filter((a) => !a.dead);
    this.spawnMobsForFrame(dt);
    this.particles.update(dt);

    // ---- HUD refreshes (cheap, throttled)
    this.hudTimer = (this.hudTimer || 0) + dt;
    if (this.hudTimer > 0.1) {
      this.hudTimer = 0;
      this.hud.refreshStatus();
      this.hud.refreshHotbar();
    }

    // the dragon's health as a boss bar at the top of the screen
    if (this.hud.updateBossBar) this.hud.updateBossBar(this.boss);

    // ---- furnace smelting (runs whether or not its UI is open, like Minecraft)
    if (this.player.inventory.tickFurnace(dt, SMELT_RECIPES) && this.hud.isFurnaceOpen()) {
      this.hud.refreshFurnace();
    }
    // a lit furnace glows: swap the block for the lit variant while burning
    this.updateFurnaceVisual(dt);
    this.debugTimer += dt;
    if (this.debugTimer > 0.2 && this.hud.debugVisible) {
      this.debugTimer = 0;
      this.hud.updateDebug(this.debugText());
    }

    // ---- autosave
    this.autoSaveTimer += dt;
    if (this.autoSaveTimer > 60) { this.autoSaveTimer = 0; this.saveWorld(); }

    if (p.dead && this.uiMode !== 'dead') {
      this.uiMode = 'dead';
      this.input.exitLock();
      this.hud.showDeath(this.lastDamageCause || '游戏结束');
    }
  }

  mobApi() {
    return {
      sound: (kind) => this.audio.mob(kind),
      hurtPlayer: (amount, mob) => {
        // armour absorbs a share of the hit, then wears down
        const points = armorPoints(this.player.inventory);
        const mitigated = amount * (1 - Math.min(0.8, points * 0.04) - enchantMitigation(this.player.inventory));
        this.player.damage(Math.max(0, mitigated), 'mob');
        if (this.player.inventory.damageArmor(1) > 0) this.hud.toast('护甲已损坏');
        this.player.vx += (this.player.x - mob.x) * 2.2;
        this.player.vz += (this.player.z - mob.z) * 2.2;
        this.player.vy = Math.max(this.player.vy, 4);
        this.audio.hurt();
        this.lastDamageCause = `被${mob.def.name}杀死了`;
      },
      explode: (x, y, z, power) => this.explode(x, y, z, power),
      onMobDeath: (mob) => {
        this.player.addXp(mob.def.xp || 1);
        this.audio.mob(mob.def.sound);
        // felling the Ender Dragon is the win condition
        if (mob.def.boss) this.onDragonDefeated(mob);
      },
      isNight: () => this.isNight(),
      skyLightAt: (x, y, z) => skyLevel(this.world, x, y, z),
      items: this.items,
      mobShoot: (mob, player) => this.mobShoot(mob, player),
    };
  }

  debugText() {
    const p = this.player;
    const w = this.world;
    const r = this.renderer;
    const biome = w.biomeNameAt(Math.floor(p.x), Math.floor(p.z));
    const jsHeap = performance.memory ? (performance.memory.usedJSHeapSize / 1048576).toFixed(0) + 'MB' : 'n/a';
    const light = lightCurve(skyLevel(w, Math.floor(p.x), Math.floor(p.eyeY), Math.floor(p.z)), blockLevel(w, Math.floor(p.x), Math.floor(p.eyeY), Math.floor(p.z)));
    const lines = [
      `MineWeb 1.0 — ${this.fps.toFixed(1)} fps (最小 ${this.perf.minFps === Infinity ? '-' : this.perf.minFps.toFixed(0)})`,
      `XYZ ${p.x.toFixed(2)} / ${p.y.toFixed(2)} / ${p.z.toFixed(2)}`,
      `区块 ${p.x >> 4}, ${p.z >> 4} · 生物群系 ${biome}`,
      `朝向 ${(p.yaw * 180 / Math.PI).toFixed(0)}° / ${(p.pitch * 180 / Math.PI).toFixed(0)}°`,
      `时间 ${(this.dayTime * 24).toFixed(1)}h ${this.isNight() ? '(夜)' : '(昼)'} · 光照 ${(light * 15).toFixed(1)}`,
      `模式 ${p.mode === GAMEMODE.CREATIVE ? '创造' : '生存'}${p.flying ? ' (飞行)' : ''} · ${p.onGround ? '地面' : '空中'}${p.inWater ? ' 水中' : ''}`,
      `生命 ${p.health.toFixed(0)}/20 · 饥饿 ${p.hunger.toFixed(0)}/20 · 等级 ${p.level}`,
      `区块 ${w.chunks.size} 个 · 网格队列 ${w.stats.meshQueue} · 最近网格 ${w.stats.lastMeshMs.toFixed(1)}ms`,
      `绘制 ${r.stats.draws} 批 · ${(r.stats.quads / 1000).toFixed(1)}k 四边形 · 剔除 ${r.stats.culled}`,
      `实体 ${this.mobs.length} · 掉落物 ${this.items.length} · 粒子 ${this.particles.count}`,
      `渲染距离 ${w.viewDistance} 区块 · 视距 ${(w.viewDistance * 16).toFixed(0)}m · DPR ${this.dpr}`,
      `内存 ${jsHeap} · 世界 ${w.estimateMemoryMB().toFixed(1)}MB`,
    ];
    return lines.join('\n');
  }

  render(dt) {
    const gl = this.renderer.gl;
    const p = this.player;
    const w = this.world;
    const sky = this.skyColors();
    const day = sky.day;
    const gamma = this.settings.gamma;
    const skyLightColor = [1, 1, 1].map((v) => clamp((0.11 + 0.89 * day) * gamma * 1.08, 0, 1.6));
    const fogMix = this.settings.fog;
    const skyColor = [
      sky.horizon[0] * 0.55 + sky.zenith[0] * 0.45,
      sky.horizon[1] * 0.55 + sky.zenith[1] * 0.45,
      sky.horizon[2] * 0.55 + sky.zenith[2] * 0.45,
    ];
    const fogColor = [
      skyColor[0] * fogMix + (1 - fogMix) * skyLightColor[0],
      skyColor[1] * fogMix + (1 - fogMix) * skyLightColor[1],
      skyColor[2] * fogMix + (1 - fogMix) * skyLightColor[2],
    ];

    const bobY = this.settings.bob ? Math.sin(p.walkDistance * 6) * 0.04 : 0;
    const cam = {
      x: p.x, y: p.eyeY + bobY, z: p.z,
      yaw: p.yaw, pitch: p.pitch + (this.hurtTilt || 0),
    };
    const viewDistBlocks = w.viewDistance * 16;
    this.renderer.beginFrame(cam, (this.settings.fov * Math.PI) / 180, viewDistBlocks);

    gl.clearColor(fogColor[0], fogColor[1], fogColor[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const sunDir = this.sunDirection();
    // the sun is a real world-space body: warm white at noon, deep orange when low, and
    // it simply is not drawn at night (below the horizon)
    const sunAbove = sunDir[1] > 0;
    const lowSun = clamp(1 - sunDir[1] * 2.2, 0, 1);
    const sunColor = [
      1.0,
      0.96 - lowSun * 0.30,
      0.88 - lowSun * 0.55,
    ];
    const sunGlow = sunAbove ? (this.isNight() ? 0.0 : 0.55 + 0.35 * clamp(sunDir[1], 0, 1)) : 0.0;
    this.renderer.drawSky(sky.horizon, sky.zenith, [sunDir[0], sunDir[1], sunDir[2]], sunGlow, sunColor);

    const tint = [1, 1, 1];
    this.renderer.drawChunks(w, 0, 0, day, fogColor, skyLightColor, tint);
    this.renderer.drawWater(w, day, fogColor, skyLightColor, [1, 1, 1]);

    // ---- entities (mobs + dropped items)
    const camYaw = p.yaw;
    for (const m of this.mobs) {
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (d > viewDistBlocks) continue;
      // face the mob's own heading; deriving it from the player made mobs walk backwards
      const model = m4aim(new Float32Array(16), m.x, m.y, m.z, m.yaw || 0, 0, 1, 1, 1);
      const parts = mobPartsCached(m);
      // tint by light so mobs in caves are dark
      const lightHere = lightCurve(skyLevel(w, Math.floor(m.x), Math.floor(m.y + 0.5), Math.floor(m.z)), blockLevel(w, Math.floor(m.x), Math.floor(m.y + 0.5), Math.floor(m.z)));
      const lit = parts.map((part) => ({
        ...part,
        light: (part.light ?? 1) * (0.25 + 0.75 * lightHere) * 0.95,
        color: m.hurtTime > 0 ? [1, 0.35, 0.35, 0.6] : part.color,
        rotX: part.rotX !== undefined ? part.rotX : 0,
      }));
      // burning overlay
      if (m.burning) lit.push({ x: -m.width / 2, y: 0, z: -m.width / 2, w: m.width, h: m.height, d: m.width, color: [1, 0.55, 0.1, 0.35], light: 1.4 });
      this.renderer.drawBoxModel(model, lit, fogColor, skyLightColor);
    }

    for (const it of this.items) {
      const d = Math.hypot(it.x - p.x, it.z - p.z);
      if (d > viewDistBlocks) continue;
      const mesh = this.itemMesh(it.id);
      if (!mesh) continue;
      const model = m4aim(new Float32Array(16), it.x, it.y + 0.15 + Math.sin(it.age * 2) * 0.04, it.z, it.spin, 0, 0.24, 0.24, 0.24);
      m4translate(model, -0.5, 0, -0.5);
      const lightHere = lightCurve(skyLevel(w, Math.floor(it.x), Math.floor(it.y), Math.floor(it.z)), blockLevel(w, Math.floor(it.x), Math.floor(it.y), Math.floor(it.z)));
      this.renderer.drawBlockMesh(model, mesh.vao, mesh.quads, fogColor, skyLightColor, 0.35 + 0.65 * lightHere, 0.5);
    }

    // remote players: a simple blue figure so co-op is visible without name tags
    if (this.net && this.net.players.size) {
      for (const rp of this.net.players.values()) {
        if (!Number.isFinite(rp.x) || !Number.isFinite(rp.y) || !Number.isFinite(rp.z)) continue;
        const d = Math.hypot(rp.x - p.x, rp.z - p.z);
        if (d > viewDistBlocks) continue;
        const model = m4aim(new Float32Array(16), rp.x, rp.y, rp.z, rp.yaw || 0, 0, 1, 1, 1);
        this.renderer.drawBoxModel(model, [
          // body
          { x: -0.3, y: 0, z: -0.15, w: 0.6, h: 1.2, d: 0.3, color: [0.22, 0.55, 0.95, 1], light: 1 },
          // head
          { x: -0.22, y: 1.2, z: -0.22, w: 0.44, h: 0.44, d: 0.44, color: [0.92, 0.74, 0.56, 1], light: 1 },
          // legs
          { x: -0.26, y: -0.75, z: -0.12, w: 0.2, h: 0.75, d: 0.24, color: [0.18, 0.28, 0.55, 1], light: 1 },
          { x: 0.06, y: -0.75, z: -0.12, w: 0.2, h: 0.75, d: 0.24, color: [0.18, 0.28, 0.55, 1], light: 1 },
        ], fogColor, skyLightColor);
      }
    }

    // fishing bobber: a small cube that turns orange while a fish is biting
    if (this.bobber) {
      const b = this.bobber;
      const bobModel = m4aim(new Float32Array(16), b.x, b.y + 0.1, b.z, 0, 0, 1, 1, 1);
      const bobColor = b.state === 'biting' ? [1, 0.45, 0.25, 1] : [0.96, 0.96, 0.98, 1];
      this.renderer.drawBoxModel(bobModel, [
        { x: -0.09, y: -0.09, z: -0.09, w: 0.18, h: 0.18, d: 0.18, color: bobColor, light: 1 },
      ], fogColor, skyLightColor);
    }

    this.renderer.drawParticles(this.particles.active(), fogColor, skyLightColor);

    // ---- block outline + breaking overlay
    const hit = this.uiMode === 'playing' ? this.raycastHit() : null;
    if (hit) {
      this.renderer.drawOutline(hit.x, hit.y, hit.z, [0, 0, 0, 0.55], 2);
      if (this.mining && this.mining.key === hit.x + ',' + hit.y + ',' + hit.z && this.miningProgress > 0) {
        const s = 0.004 + this.miningProgress * 0.012;
        this.renderer.drawOutline(hit.x - s, hit.y - s, hit.z - s, [0, 0, 0, 0.75], 2 + this.miningProgress * 4);
      }
    }

    // ---- first-person held item
    if (this.uiMode === 'playing' || this.uiMode === 'inventory') {
      const held = this.player.inventory.held;
      if (held) {
        const mesh = this.itemMesh(held.id);
        if (mesh) {
          const swing = this.swingAnimation || 0;
          const model = m4identity(new Float32Array(16));
          const side = 0.42;
          const bobX = Math.sin(p.walkDistance * 6) * 0.012;
          const bobY2 = Math.abs(Math.cos(p.walkDistance * 6)) * 0.012;
          m4translate(model, p.x, p.y, p.z);
          const rotY = m4rotY(new Float32Array(16), p.yaw);
          m4multiply(model, model, rotY);
          const pitchM = m4rotX(new Float32Array(16), -p.pitch + swing * 0.7);
          m4multiply(model, model, pitchM);
          const scl = m4scale(new Float32Array(16), 0.32, 0.32, 0.32);
          m4multiply(model, model, scl);
          const trans = m4translate(new Float32Array(16), side + bobX, -0.42 + bobY2 - swing * 0.12, -0.62);
          m4multiply(model, model, trans);
          const adjust = m4translate(new Float32Array(16), -0.5, -0.5, -0.5);
          m4multiply(model, model, adjust);
          const lightHere = lightCurve(skyLevel(w, Math.floor(p.x), Math.floor(p.eyeY), Math.floor(p.z)), blockLevel(w, Math.floor(p.x), Math.floor(p.eyeY), Math.floor(p.z)));
          this.renderer.drawBlockMesh(model, mesh.vao, mesh.quads, fogColor, skyLightColor, 0.45 + 0.55 * lightHere, 0.5);
        }
      }
    }
  }

  itemMesh(id) {
    if (this.itemMeshCache.has(id)) return this.itemMeshCache.get(id);
    const built = buildBlockMesh(id);
    if (!built) { this.itemMeshCache.set(id, null); return null; }
    const gl = this.renderer.gl;
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, built.data, gl.STATIC_DRAW);
    const S = VERT_BYTES;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, S, 20);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, S, 24);
    gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 1, gl.FLOAT, false, S, 28);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.FLOAT, false, S, 32);
    gl.bindVertexArray(null);
    const mesh = { vao, vbo, quads: built.quads };
    this.itemMeshCache.set(id, mesh);
    return mesh;
  }
}

// ------------------------------------------------------------------ helpers
// Lifecycle gaps during world creation. A plain macrotask yields to the event loop so
// the loading bar can repaint, without depending on requestAnimationFrame timing.
function frameGap() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 1;
}

const mobPartsCache = new WeakMap();
function mobPartsCached(mob) { return mobParts(mob); }
