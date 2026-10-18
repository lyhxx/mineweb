// game/hud.js — every DOM overlay: hotbar, hearts, hunger, inventory, crafting,
// pause menu, settings, chat and toasts.
import { BLOCKS, ItemStack } from '../core/blocks.js';
import { ITEMS, itemById } from '../core/items.js';
import { rollOffers, enchantLabel, stackEnchants } from '../core/enchant.js';
import { stackName } from '../core/items.js';
import { blockIcon, stackIcon } from '../render/icons.js';
import { INVENTORY_SIZE, HOTBAR_SIZE, MAIN_SIZE, ARMOR_SIZE, ARMOR_START, RECIPES, resolveAny, maxDurability } from './inventory.js';

function el(id) { return document.getElementById(id); }

export class Hud {
  constructor(game) {
    this.game = game;
    this.refs = {
      hud: el('hud'), crosshair: el('crosshair'), debug: el('debug'), toasts: el('toasts'),
      hotbar: el('hotbar'), hearts: el('hearts'), hunger: el('hunger'), bubbles: el('bubbles'),
      xpfill: el('xpfill'), xplevel: el('xplevel'), heldName: el('held-name'),
      inventory: el('inventory'), invMain: el('inv-main-grid'), invHotbar: el('inv-hotbar-grid'),
      armorGrid: el('armor-grid'),
      craftGrid: el('craft-grid'), craftOut: el('craft-out'), creative: el('creative-grid'),
      recipeBook: el('recipe-book'), cursorStack: el('cursor-stack'),
      bossBar: el('boss-bar'), bossFill: el('boss-fill'),
      effects: el('effects'),
      brewing: el('brewing'), brewIngredient: el('brew-ingredient'), brewBottle0: el('brew-bottle0'),
      brewBottle1: el('brew-bottle1'), brewBottle2: el('brew-bottle2'), brewFill: el('brew-fill'),
      brewInv: el('brew-inv-grid'), brewHotbar: el('brew-hotbar-grid'),
      victory: el('victory'),
      trade: el('trade'), tradeTitle: el('trade-title'), tradeOffers: el('trade-offers'), tradeInv: el('trade-inv-grid'), tradeHotbar: el('trade-hotbar-grid'),
      enchant: el('enchant'), enchantSlot: el('enchant-slot'), enchantOffers: el('enchant-offers'),
      chest: el('chest'), chestGrid: el('chest-grid'), chestInv: el('chest-inv-grid'),
      chestHotbar: el('chest-hotbar-grid'),
      furnace: el('furnace'), furnaceInput: el('furnace-input'), furnaceFuel: el('furnace-fuel'),
      furnaceOutput: el('furnace-output'), furnaceBurn: el('furnace-burn'), furnaceCook: el('furnace-cook'),
      pause: el('pause'), settings: el('settings'), settingsList: el('settings-list'),
      death: el('death'), deathCause: el('death-cause'), chat: el('chat'),
      chatLog: el('chat-log'), chatInput: el('chat-input'),
      title: el('title'), loading: el('loading'), loadingBar: el('loading-bar'),
      loadingDetail: el('loading-detail'), fatal: el('fatal'), fatalText: el('fatal-text'),
      seedInput: el('seed-input'), seedValue: el('menu-seed-value'), credits: el('title-credits'),
      continueBtn: el('btn-continue'),
    };
    this.debugVisible = false;
    this.toastTimers = [];
    this._heldNameTimer = 0;
    this._lastHeldKey = null;
    game.hud = this;              // settings toggles reach back through game.hud
    this._buildStatic();
  }

  // ------------------------------------------------------------------ construction
  _buildStatic() {
    const r = this.refs;
    // hotbar slots
    r.hotbar.innerHTML = '';
    this.hotbarSlots = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const d = document.createElement('div');
      d.className = 'slot';
      d.dataset.index = String(i);
      d.innerHTML = '<img alt="" draggable="false" style="display:none"><span class="count"></span>';
      d.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (this.game.uiMode === 'inventory') this.game.inventory.clickSlot(i, e.button === 2, e.shiftKey);
        else this.game.inventory.selected = i;
        this.refreshInventory();
        this.refreshHotbar();
      });
      r.hotbar.appendChild(d);
      this.hotbarSlots.push(d);
    }

    // inventory grids
    this._buildGrid(r.invMain, 8, MAIN_SIZE, 9);
    this._buildGrid(r.invHotbar, 9, 9, 0);
    this._buildArmorGrid();
    this._buildChest();
    this._buildCraftGrid();
    this._buildFurnace();
    this._buildEnchant();
    this._buildTrade();
    this._buildBrewing();
    this._buildCreativeGrid();
    this._buildRecipeBook();
    this._buildSettings();
    this._bindMenus();
    this._bindChat();

    // slot for the crafting result
    r.craftOut.innerHTML = '';
    const out = document.createElement('div');
    out.className = 'slot';
    out.innerHTML = '<img alt="" draggable="false" style="display:none"><span class="count"></span>';
    out.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const inv = this.game.inventory;
      if (e.shiftKey) {
        // shift-click: send the result straight to the inventory and keep crafting
        if (inv.craftToInventory()) this.game.audio.eat();
      } else if (inv.craftOut) {
        if (inv.cursor) {
          // stack onto whatever the player is already holding
          if (inv.cursor.id === inv.craftOut.id && inv.cursor.count + inv.craftOut.count <= 64) {
            inv.cursor.count += inv.craftOut.count;
            inv._consumeCraftInputs();
            inv.updateCraftResult();
          }
        } else {
          inv.cursor = inv.takeCraftResult();
        }
      }
      this.refreshInventory();
      this.refreshHotbar();
    });
    r.craftOut.appendChild(out);
    this.craftOutSlot = out;

    // cursor follower
    window.addEventListener('mousemove', (e) => {
      if (this.game.uiMode !== 'inventory') return;
      this.refs.cursorStack.style.left = e.clientX + 'px';
      this.refs.cursorStack.style.top = e.clientY + 'px';
    });
  }

  _buildGrid(container, cols, count, startIndex) {
    container.innerHTML = '';
    const slots = [];
    for (let i = 0; i < count; i++) {
      const index = startIndex + i;
      const d = document.createElement('div');
      d.className = 'slot';
      d.dataset.index = String(index);
      d.innerHTML = '<img alt="" draggable="false" style="display:none"><span class="count"></span>';
      d.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.game.inventory.clickSlot(index, e.button === 2, e.shiftKey);
        this.refreshInventory();
        this.refreshHotbar();
      });
      d.addEventListener('contextmenu', (e) => e.preventDefault());
      container.appendChild(d);
      slots.push(d);
    }
    if (startIndex === 0) this.invHotbarSlots = slots;
    else this.invMainSlots = slots;
    container.style.gridTemplateColumns = `repeat(${cols}, 44px)`;
  }

  /** Build the crafting grid at the size the current UI needs (2x2 or 3x3). */
  _buildCraftGrid(size) {
    const c = this.refs.craftGrid;
    const inv = this.game.inventory;
    const n = size || (inv ? inv.craftSize : 2);
    if (this._craftGridSize === n && this.craftSlots) return;
    this._craftGridSize = n;
    c.innerHTML = '';
    c.style.gridTemplateColumns = `repeat(${n}, 44px)`;
    this.craftSlots = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const index = y * 3 + x;
        const d = document.createElement('div');
        d.className = 'slot';
        d.innerHTML = '<img alt="" draggable="false" style="display:none"><span class="count"></span>';
        d.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.game.inventory.clickCraftSlot(index, e.button === 2);
          this.refreshInventory();
        });
        d.addEventListener('contextmenu', (e) => e.preventDefault());
        c.appendChild(d);
        this.craftSlots.push(d);
      }
    }
  }

  /** The four armour slots (helmet, chestplate, leggings, boots). */
  _buildArmorGrid() {
    const c = this.refs.armorGrid;
    if (!c) return;
    c.innerHTML = '';
    this.armorSlots = [];
    for (let i = 0; i < ARMOR_SIZE; i++) {
      const index = ARMOR_START + i;
      const d = document.createElement('div');
      d.className = 'slot';
      d.title = ['头盔', '胸甲', '护腿', '靴子'][i];
      d.innerHTML = '<img alt="" draggable="false" style="display:none"><span class="count"></span>';
      d.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.game.inventory.clickSlot(index, e.button === 2, e.shiftKey);
        this.refreshInventory();
        this.refreshHotbar();
      });
      d.addEventListener('contextmenu', (e) => e.preventDefault());
      c.appendChild(d);
      this.armorSlots.push(d);
    }
  }

  /** Show or hide the boss health bar. */
  updateBossBar(boss) {
    const bar = this.refs.bossBar;
    if (!bar) return;
    if (!boss || boss.dead) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const pct = Math.max(0, Math.min(1, boss.hp / boss.maxHp));
    if (this.refs.bossFill) this.refs.bossFill.style.width = Math.round(pct * 100) + '%';
  }
  /** Victory screen after the Ender Dragon falls. */
  showVictory() { if (this.refs.victory) this.refs.victory.classList.remove('hidden'); }
  hideVictory() { if (this.refs.victory) this.refs.victory.classList.add('hidden'); }
  isVictoryOpen() { return this.refs.victory && !this.refs.victory.classList.contains('hidden'); }

  /** Brewing stand: one ingredient slot, three bottle slots, and a progress bar. */
  _buildBrewing() {
    const r = this.refs;
    if (!r.brewIngredient) return;
    const wire = (node, which) => {
      node.innerHTML = '<img alt="" draggable="false" style="display:none"><span class="count"></span>';
      node.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.game.inventory.clickBrewSlot(which, e.button === 2);
        this.refreshBrewing();
        this.refreshHotbar();
      });
      node.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    wire(r.brewIngredient, 'ingredient');
    this.brewBottleSlots = [];
    [r.brewBottle0, r.brewBottle1, r.brewBottle2].forEach((node, i) => {
      if (!node) return;
      wire(node, 'bottle' + i);
      this.brewBottleSlots.push(node);
    });
    const mkRow = (container, count, startIndex) => {
      container.innerHTML = '';
      const nodes = [];
      for (let i = 0; i < count; i++) {
        const index = startIndex + i;
        const d = document.createElement('div');
        d.className = 'slot';
        d.innerHTML = '<img alt="" draggable="false" style="display:none"><span class="count"></span>';
        d.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.game.inventory.clickSlot(index, e.button === 2, e.shiftKey);
          this.refreshBrewing();
          this.refreshHotbar();
        });
        d.addEventListener('contextmenu', (e) => e.preventDefault());
        container.appendChild(d);
        nodes.push(d);
      }
      return nodes;
    };
    this.brewInvSlots = mkRow(r.brewInv, MAIN_SIZE, 9);
    this.brewHotbarSlots = mkRow(r.brewHotbar, 9, 0);
  }

  refreshBrewing() {
    const inv = this.game.inventory;
    if (!inv) return;
    const b = inv.brewing || { ingredient: null, bottles: [null, null, null], progress: 0, total: 0 };
    this._paintSlot(this.refs.brewIngredient, b.ingredient);
    this.brewBottleSlots.forEach((n, i) => this._paintSlot(n, b.bottles[i]));
    if (this.refs.brewFill) {
      const total = b.total || 20;
      const pct = Math.max(0, Math.min(1, (b.progress || 0) / total));
      this.refs.brewFill.style.width = Math.round(pct * 100) + '%';
    }
    this.brewInvSlots.forEach((n, i) => this._paintSlot(n, inv.slots[9 + i]));
    this.brewHotbarSlots.forEach((n, i) => this._paintSlot(n, inv.slots[i]));
  }

  showBrewing() {
    this.refreshBrewing();
    this.refs.brewing.classList.remove('hidden');
  }

  hideBrewing() { this.refs.brewing.classList.add('hidden'); }
  isBrewingOpen() { return !this.refs.brewing.classList.contains('hidden'); }

  /** Show the player's active status effects as a row of chips. */
  refreshEffects(effects) {
    const box = this.refs.effects;
    if (!box) return;
    const list = effects || [];
    if (!list.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = list.map((e) => {
      const mm = Math.floor(e.time / 60);
      const ss = Math.floor(e.time % 60);
      const t = mm > 0 ? `${mm}:${String(ss).padStart(2, '0')}` : `${ss}s`;
      return `<div class="effect-chip ${e.bad ? 'bad' : ''}" title="${e.desc}">${e.cn}${e.level > 1 ? ' II' : ''} <span>${t}</span></div>`;
    }).join('');
  }

  /** Villager trading: the offer list plus the player's own slots. */
  _buildTrade() {
    const r = this.refs;
    if (!r.tradeOffers) return;
    const mkRow = (container, count, startIndex, nodes) => {
      container.innerHTML = '';
      for (let i = 0; i < count; i++) {
        const index = startIndex + i;
        const d = document.createElement('div');
        d.className = 'slot';
        d.innerHTML = '<img alt="" draggable="false" style="display:none"><span class="count"></span>';
        d.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.game.inventory.clickSlot(index, e.button === 2, e.shiftKey);
          this.refreshTrade();
          this.refreshHotbar();
        });
        d.addEventListener('contextmenu', (e) => e.preventDefault());
        container.appendChild(d);
        nodes.push(d);
      }
    };
    this.tradeInvSlots = [];
    this.tradeHotbarSlots = [];
    mkRow(r.tradeInv, MAIN_SIZE, 9, this.tradeInvSlots);
    mkRow(r.tradeHotbar, 9, 0, this.tradeHotbarSlots);
    r.tradeOffers.addEventListener('mousedown', (e) => e.preventDefault());
  }

  refreshTrade() {
    const g = this.game;
    const villager = g.tradeVillager;
    if (!villager || !this.refs.tradeOffers) return;
    if (this.refs.tradeTitle) {
      this.refs.tradeTitle.textContent = `${villager.def.name} · ${villager.profession ? villager.profession.cn : ''}`;
    }
    const box = this.refs.tradeOffers;
    box.innerHTML = '';
    const inv = g.inventory;
    for (const o of villager.offers || []) {
      const canPay = inv.count(o.giveId) >= o.give.count;
      const exhausted = o.uses >= o.max;
      const row = document.createElement('div');
      row.className = 'trade-offer';
      if (!canPay || exhausted) row.classList.add('disabled');
      row.innerHTML = `<span class="give">${stackName(o.giveId)} ×${o.give.count}</span>`
        + '<span>→</span>'
        + `<span class="get">${stackName(o.getId)} ×${o.get.count}</span>`
        + `<span class="uses">${exhausted ? '已售罄' : `${o.uses}/${o.max}`}</span>`;
      if (canPay && !exhausted) {
        row.addEventListener('click', () => {
          g.doTrade(villager, o);
          this.refreshTrade();
          this.refreshHotbar();
        });
      }
      box.appendChild(row);
    }
    if (!(villager.offers || []).length) {
      box.innerHTML = '<div class="enchant-empty">这个村民没有可交易的东西</div>';
    }
    this.tradeInvSlots.forEach((n, i) => this._paintSlot(n, inv.slots[9 + i]));
    this.tradeHotbarSlots.forEach((n, i) => this._paintSlot(n, inv.slots[i]));
  }

  showTrade() {
    this.refreshTrade();
    this.refs.trade.classList.remove('hidden');
  }

  hideTrade() { this.refs.trade.classList.add('hidden'); }
  isTradeOpen() { return !this.refs.trade.classList.contains('hidden'); }

  /** Enchanting table: one item slot plus the three rolled offers. */
  _buildEnchant() {
    const r = this.refs;
    if (!r.enchantSlot) return;
    r.enchantSlot.innerHTML = '<img alt="" draggable="false" style="display:none"><span class="count"></span>';
    r.enchantSlot.addEventListener('mousedown', (e) => {
      e.preventDefault();
      this.game.inventory.clickEnchantSlot(e.button === 2);
      this.refreshEnchant();
      this.refreshHotbar();
    });
    r.enchantSlot.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  refreshEnchant() {
    const inv = this.game.inventory;
    if (!inv) return;
    this._paintSlot(this.refs.enchantSlot, inv.enchantItem);
    const box = this.refs.enchantOffers;
    box.innerHTML = '';
    const stack = inv.enchantItem;
    if (!stack) {
      box.innerHTML = '<div class="enchant-empty">把要附魔的物品放进左边的格子</div>';
      return;
    }
    if (!inv.enchantOffers) {
      inv.enchantOffers = rollOffers(stack, this.game.player.level, this.game.enchantSeed || 0);
    }
    const offers = inv.enchantOffers;
    if (!offers.some(Boolean)) {
      box.innerHTML = '<div class="enchant-empty">该物品无法附魔，或经验等级不足（需要 1 / 5 / 10 级）</div>';
      return;
    }
    for (const o of offers) {
      if (!o) continue;
      const row = document.createElement('div');
      row.className = 'enchant-offer';
      const affordable = this.game.player.level >= o.cost;
      if (!affordable) row.classList.add('disabled');
      row.innerHTML = `<span class="lvl">${enchantLabel(o.key, o.level)}</span>`
        + `<span>${o.ench.desc(o.level)}</span>`
        + `<span class="cost">${o.cost} 级</span>`;
      if (affordable) {
        row.addEventListener('click', () => {
          this.game.applyEnchantment(o);
          this.refreshEnchant();
          this.refreshHotbar();
        });
      }
      box.appendChild(row);
    }
  }

  showEnchant() {
    this.refreshEnchant();
    this.refs.enchant.classList.remove('hidden');
  }

  hideEnchant() { this.refs.enchant.classList.add('hidden'); }
  isEnchantOpen() { return !this.refs.enchant.classList.contains('hidden'); }

  /** Chest UI: 27 storage slots plus the player's own slots for transfer. */
  _buildChest() {
    const r = this.refs;
    if (!r.chestGrid) return;
    r.chestGrid.innerHTML = '';
    this.chestSlots = [];
    for (let i = 0; i < 27; i++) {
      const d = document.createElement('div');
      d.className = 'slot';
      d.innerHTML = '<img alt="" draggable="false" style="display:none"><span class="count"></span>';
      d.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const chest = this.game.currentChest();
        if (!chest) return;
        this.game.inventory.clickChestSlot(chest, i, e.button === 2, e.shiftKey);
        this.refreshChest();
        this.refreshHotbar();
      });
      d.addEventListener('contextmenu', (e) => e.preventDefault());
      r.chestGrid.appendChild(d);
      this.chestSlots.push(d);
    }
    // the player's own pack while the chest is open (clicking moves items across)
    const mkInvRow = (container, count, startIndex) => {
      container.innerHTML = '';
      const nodes = [];
      for (let i = 0; i < count; i++) {
        const index = startIndex + i;
        const d = document.createElement('div');
        d.className = 'slot';
        d.innerHTML = '<img alt="" draggable="false" style="display:none"><span class="count"></span>';
        d.addEventListener('mousedown', (e) => {
          e.preventDefault();
          this.game.inventory.clickSlot(index, e.button === 2, e.shiftKey);
          this.refreshChest();
          this.refreshHotbar();
        });
        d.addEventListener('contextmenu', (e) => e.preventDefault());
        container.appendChild(d);
        nodes.push(d);
      }
      return nodes;
    };
    this.chestInvSlots = mkInvRow(r.chestInv, MAIN_SIZE, 9);
    this.chestHotbarSlots = mkInvRow(r.chestHotbar, 9, 0);
  }

  refreshChest() {
    const chest = this.game.currentChest();
    const inv = this.game.inventory;
    if (!chest || !inv) return;
    this.chestSlots.forEach((n, i) => this._paintSlot(n, chest[i]));
    this.chestInvSlots.forEach((n, i) => this._paintSlot(n, inv.slots[9 + i]));
    this.chestHotbarSlots.forEach((n, i) => this._paintSlot(n, inv.slots[i]));
  }

  showChest() {
    this.refreshChest();
    this.refs.chest.classList.remove('hidden');
  }

  hideChest() { this.refs.chest.classList.add('hidden'); }
  isChestOpen() { return !this.refs.chest.classList.contains('hidden'); }

  /** Wire the furnace's three slots. */
  _buildFurnace() {
    const r = this.refs;
    const mk = (node, which) => {
      if (!node) return;
      node.innerHTML = '<img alt="" draggable="false" style="display:none"><span class="count"></span>';
      node.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.game.inventory.clickFurnaceSlot(which, e.button === 2);
        this.refreshFurnace();
        this.refreshInventory();
      });
      node.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    mk(r.furnaceInput, 'input');
    mk(r.furnaceFuel, 'fuel');
    mk(r.furnaceOutput, 'output');
  }

  refreshFurnace() {
    const inv = this.game.inventory;
    if (!inv) return;
    const f = inv.furnace;
    this._paintSlot(this.refs.furnaceInput, f.input);
    this._paintSlot(this.refs.furnaceFuel, f.fuel);
    this._paintSlot(this.refs.furnaceOutput, f.output);
    if (this.refs.furnaceBurn) {
      const pct = f.burnTotal > 0 ? Math.max(0, Math.min(1, f.burn / f.burnTotal)) : 0;
      this.refs.furnaceBurn.style.height = Math.round(pct * 100) + '%';
    }
    if (this.refs.furnaceCook) {
      const rec = this.game.smeltRecipeFor(f.input);
      const pct = rec ? Math.max(0, Math.min(1, f.cook / rec.seconds)) : 0;
      this.refs.furnaceCook.style.width = Math.round(pct * 100) + '%';
    }
  }

  showFurnace() {
    this.refreshFurnace();
    this.refs.furnace.classList.remove('hidden');
  }

  hideFurnace() { this.refs.furnace.classList.add('hidden'); }

  isFurnaceOpen() { return !this.refs.furnace.classList.contains('hidden'); }

  /** Show the crafting grid at the requested size and rebuild the recipe book. */
  setCraftingSize(size) {
    const inv = this.game.inventory;
    if (inv.craftSize !== size) {
      inv.clearCrafting();
      inv.craftSize = size;
    }
    this._buildCraftGrid(size);
    this._buildRecipeBook();
  }

  _buildCreativeGrid() {
    const c = this.refs.creative;
    c.innerHTML = '';
    // every block, then every item — one flat palette
    const ids = [];
    for (let id = 1; id < BLOCKS.length; id++) if (BLOCKS[id]) ids.push(id);
    for (const it of ITEMS) if (it) ids.push(it.id);
    for (const id of ids) {
      const d = document.createElement('div');
      d.className = 'slot';
      d.title = id > 0 ? (BLOCKS[id] ? BLOCKS[id].cn : '') : (ITEMS[-id] ? ITEMS[-id].cn : '');
      d.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const inv = this.game.inventory;
        const it = id < 0 ? ITEMS[-id] : null;
        inv.cursor = new ItemStack(id, e.button === 2 ? 1 : (it && it.stack === 1 ? 1 : 64),
          it && it.durability ? it.durability : null);
        this.refreshInventory();
      });
      c.appendChild(d);
      d.dataset.blockId = String(id);
    }
  }

  /**
   * Recipe book. With a 2x2 grid only the recipes that fit are listed; with a crafting
   * table the full list shows, and clicking a recipe fills the grid with one of each
   * ingredient pulled from the inventory.
   */
  _buildRecipeBook() {
    const c = this.refs.recipeBook;
    c.innerHTML = '';
    const inv = this.game.inventory;
    const size = inv ? inv.craftSize : 2;
    const list = RECIPES.filter((rec) => rec.rows.length <= size && Math.max(...rec.rows.map((r) => r.length)) <= size);
    for (const rec of list) {
      const outId = resolveAny(rec.out.key);
      const chip = document.createElement('div');
      chip.className = 'recipe-chip';
      chip.title = `${rec.name} — 点击自动放入合成格`;
      const img = document.createElement('img');
      img.src = stackIcon(outId, 24);
      img.alt = '';
      chip.appendChild(img);
      const span = document.createElement('span');
      span.textContent = rec.name;
      chip.appendChild(span);
      chip.addEventListener('click', () => this.fillRecipe(rec));
      c.appendChild(chip);
    }
  }

  /** Pull the ingredients for one recipe out of the inventory into the crafting grid. */
  fillRecipe(rec) {
    const inv = this.game.inventory;
    const size = inv.craftSize;
    const pw = Math.max(...rec.rows.map((r) => r.length));
    if (rec.rows.length > size || pw > size) {
      this.game.hud.toast('这个配方需要工作台（3×3）');
      return;
    }
    // clear whatever is already there back into the pack
    inv.clearCrafting();
    const need = [];
    rec.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (!ch || ch === ' ') continue;
        const id = resolveAny(rec.key[ch]);
        if (id) need.push([y * 3 + x, id]);
      }
    });
    for (const [idx, id] of need) {
      for (let i = 0; i < INVENTORY_SIZE; i++) {
        const s = inv.slots[i];
        if (s && s.id === id) {
          inv.craftGrid[idx] = new ItemStack(id, 1, s.durability ?? null);
          s.count--;
          if (s.count <= 0) inv.slots[i] = null;
          break;
        }
      }
    }
    inv.updateCraftResult();
    this.refreshInventory();
  }

  _buildSettings() {
    const g = this.game;
    const list = this.refs.settingsList;
    list.innerHTML = '';
    const rows = [
      { key: 'renderDistance', label: '渲染距离（区块）', min: 3, max: 22, step: 1, get: () => g.settings.renderDistance, set: (v) => { g.settings.renderDistance = v; g.world.viewDistance = v; } },
      { key: 'fov', label: '视野 (FOV)', min: 50, max: 110, step: 1, get: () => g.settings.fov, set: (v) => { g.settings.fov = v; } },
      { key: 'sensitivity', label: '鼠标灵敏度', min: 1, max: 20, step: 1, get: () => Math.round(g.settings.sensitivity * 1000), set: (v) => { g.settings.sensitivity = v / 1000; g.input.sensitivity = g.settings.sensitivity; } },
      { key: 'volume', label: '音量', min: 0, max: 100, step: 1, get: () => Math.round(g.settings.volume * 100), set: (v) => { g.settings.volume = v / 100; g.audio.setVolume(g.settings.volume); } },
      { key: 'gamma', label: '亮度', min: 0, max: 200, step: 5, get: () => Math.round(g.settings.gamma * 100), set: (v) => { g.settings.gamma = v / 100; } },
      { key: 'maxFps', label: '最大帧率', min: 60, max: 360, step: 10, get: () => g.settings.maxFps, set: (v) => { g.settings.maxFps = v; } },
      { key: 'fog', label: '距离雾', min: 0, max: 100, step: 10, get: () => Math.round(g.settings.fog * 100), set: (v) => { g.settings.fog = v / 100; } },
      { key: 'bob', label: '视角摇晃', min: 0, max: 100, step: 10, get: () => Math.round(g.settings.bob * 100), set: (v) => { g.settings.bob = v / 100; } },
    ];
    this.settingRows = [];
    for (const row of rows) {
      const wrap = document.createElement('div');
      wrap.className = 'setting-row';
      const label = document.createElement('span');
      label.textContent = row.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(row.min); input.max = String(row.max); input.step = String(row.step);
      input.value = String(row.get());
      const value = document.createElement('span');
      value.className = 'setting-value';
      value.textContent = String(input.value);
      input.addEventListener('input', () => {
        row.set(Number(input.value));
        value.textContent = String(input.value);
        g.saveSettings();
      });
      wrap.appendChild(label); wrap.appendChild(input); wrap.appendChild(value);
      list.appendChild(wrap);
      this.settingRows.push({ row, input, value });
    }
    // toggles
    const toggles = [
      { label: '垂直同步', get: () => g.settings.vsync, set: (v) => { g.settings.vsync = v; g.applyVsync(); } },
      { label: '显示调试信息 (F3)', get: () => g.hud.debugVisible, set: (v) => { g.hud.debugVisible = v; } },
      { label: '平滑光照', get: () => g.settings.smoothLighting, set: (v) => { g.settings.smoothLighting = v; } },
      { label: '反转鼠标 Y 轴', get: () => g.settings.invertY, set: (v) => { g.settings.invertY = v; g.input.invertY = v; } },
    ];
    for (const t of toggles) {
      const wrap = document.createElement('div');
      wrap.className = 'setting-row';
      const label = document.createElement('span');
      label.textContent = t.label;
      const btn = document.createElement('button');
      btn.className = 'mc-button';
      const sync = () => { btn.textContent = t.get() ? '开' : '关'; };
      btn.addEventListener('click', () => { t.set(!t.get()); sync(); g.saveSettings(); });
      sync();
      wrap.appendChild(label); wrap.appendChild(btn);
      list.appendChild(wrap);
    }
  }

  refreshSettingValues() {
    if (!this.settingRows) return;
    for (const { row, input, value } of this.settingRows) {
      input.value = String(row.get());
      value.textContent = String(input.value);
    }
  }

  _bindMenus() {
    const g = this.game;
    el('btn-resume').addEventListener('click', () => g.resume());
    el('btn-settings').addEventListener('click', () => this.showSettings());
    el('btn-settings-back').addEventListener('click', () => { this.hideSettings(); g.showPause(); });
    el('btn-title-settings').addEventListener('click', () => { this.refs.title.classList.add('hidden'); this.showSettings(); });
    el('btn-mode').addEventListener('click', () => { g.toggleGamemode(); this.showPause(); });
    el('btn-save').addEventListener('click', () => { g.saveWorld(); this.toast('世界已保存'); });
    el('btn-new').addEventListener('click', () => {
      const seed = prompt('输入新的世界种子（留空为随机）', String(Math.floor(Math.random() * 1e9)));
      if (seed === null) return;
      g.newWorld(seed.trim());
    });
    el('btn-respawn').addEventListener('click', () => g.respawnPlayer());
    el('btn-play').addEventListener('click', () => g.startNewGame());
    this.refs.continueBtn.addEventListener('click', () => g.continueSaved());
  }

  _bindChat() {
    const g = this.game;
    const input = this.refs.chatInput;
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = input.value.trim();
        input.value = '';
        g.closeChat();
        if (text) g.handleChat(text);
      } else if (e.key === 'Escape') {
        input.value = '';
        g.closeChat();
      }
    });
  }

  // ------------------------------------------------------------------ mode switching
  showTitle() { this.refs.title.classList.remove('hidden'); }
  hideTitle() { this.refs.title.classList.add('hidden'); }
  showHud() { this.refs.hud.classList.remove('hidden'); }
  hideHud() { this.refs.hud.classList.add('hidden'); }
  showLoading(detail = '准备中') {
    this.refs.loading.classList.remove('hidden');
    this.refs.loadingDetail.textContent = detail;
  }
  setLoading(progress, detail) {
    this.refs.loadingBar.style.width = Math.round(progress * 100) + '%';
    if (detail) this.refs.loadingDetail.textContent = detail;
  }
  hideLoading() { this.refs.loading.classList.add('hidden'); }
  showInventory() {
    this.setCraftingSize(2);
    this.refs.inventory.classList.remove('hidden');
    this.refreshInventory();
  }
  showCraftingTable() {
    this.setCraftingSize(3);
    this.refs.inventory.classList.remove('hidden');
    this.refreshInventory();
  }
  hideInventory() { this.refs.inventory.classList.add('hidden'); this.refs.cursorStack.classList.add('hidden'); }
  showPause() { this.refs.pause.classList.remove('hidden'); }
  hidePause() { this.refs.pause.classList.add('hidden'); }
  showSettings() { this.refreshSettingValues(); this.refs.settings.classList.remove('hidden'); }
  hideSettings() { this.refs.settings.classList.add('hidden'); }
  showDeath(cause) {
    this.refs.deathCause.textContent = cause || '游戏结束';
    this.refs.death.classList.remove('hidden');
  }
  hideDeath() { this.refs.death.classList.add('hidden'); }
  showChat() { this.refs.chat.classList.remove('hidden'); this.refs.chatInput.focus(); }
  hideChat() { this.refs.chat.classList.add('hidden'); this.refs.chatInput.blur(); }
  isChatOpen() { return !this.refs.chat.classList.contains('hidden'); }

  showFatal(message) {
    this.refs.fatal.classList.remove('hidden');
    this.refs.fatalText.textContent = message;
  }

  setCredits(text) { this.refs.credits.textContent = text; }

  chatLine(text, color = '#ffffff') {
    const d = document.createElement('div');
    d.textContent = text;
    d.style.color = color;
    this.refs.chatLog.appendChild(d);
    while (this.refs.chatLog.childElementCount > 10) this.refs.chatLog.removeChild(this.refs.chatLog.firstChild);
    setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); }, 12000);
  }

  toast(text) {
    const d = document.createElement('div');
    d.className = 'toast';
    d.textContent = text;
    this.refs.toasts.appendChild(d);
    setTimeout(() => { d.style.transition = 'opacity .5s'; d.style.opacity = '0'; }, 2200);
    setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); }, 2900);
  }

  // ------------------------------------------------------------------ refresh
  _paintSlot(node, stack) {
    const img = node.querySelector('img');
    const count = node.querySelector('.count');
    if (!stack || stack.count <= 0) {
      img.style.display = 'none';
      count.textContent = '';
      if (node._durBar) node._durBar.style.display = 'none';
      return;
    }
    const url = stackIcon(stack.id, 48);
    if (url) { img.src = url; img.style.display = 'block'; }
    else img.style.display = 'none';
    count.textContent = stack.count > 1 ? String(stack.count) : '';
    // durability bar for tools and armour
    const max = maxDurability(stack.id);
    if (max > 0 && stack.durability !== null && stack.durability !== undefined) {
      let bar = node._durBar;
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'durability';
        bar.innerHTML = '<span></span>';
        node.appendChild(bar);
        node._durBar = bar;
      }
      const left = Math.max(0, Math.min(1, stack.durability / max));
      bar.style.display = 'block';
      const fill = bar.querySelector('span');
      fill.style.width = Math.round(left * 100) + '%';
      fill.style.background = left > 0.5 ? '#3cdc3c' : (left > 0.25 ? '#dcdc3c' : '#dc3c3c');
    } else if (node._durBar) {
      node._durBar.style.display = 'none';
    }
  }

  refreshHotbar() {
    const inv = this.game.inventory;
    if (!inv) return;
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const node = this.hotbarSlots[i];
      node.classList.toggle('selected', i === inv.selected);
      this._paintSlot(node, inv.slots[i]);
    }
    const held = inv.slots[inv.selected];
    const key = held ? held.id + ':' + held.count : 'empty';
    if (key !== this._lastHeldKey) {
      this._lastHeldKey = key;
      const name = held ? (BLOCKS[held.id]?.cn || '') : '';
      this.refs.heldName.textContent = name;
      this.refs.heldName.classList.add('show');
      clearTimeout(this._heldNameTimer);
      this._heldNameTimer = setTimeout(() => this.refs.heldName.classList.remove('show'), 1600);
    }
  }

  refreshInventory() {
    const inv = this.game.inventory;
    if (!inv) return;
    if (this.invMainSlots) this.invMainSlots.forEach((n, i) => this._paintSlot(n, inv.slots[9 + i]));
    if (this.armorSlots) this.armorSlots.forEach((n, i) => this._paintSlot(n, inv.slots[ARMOR_START + i]));
    if (this.invHotbarSlots) this.invHotbarSlots.forEach((n, i) => this._paintSlot(n, inv.slots[i]));
    if (this.craftSlots) this.craftSlots.forEach((n, i) => this._paintSlot(n, inv.craftGrid[i]));
    inv.updateCraftResult();
    if (this.craftOutSlot) this._paintSlot(this.craftOutSlot, inv.craftOut);
    // creative palette icons only need painting once
    if (this.refs.creative && !this._creativePainted) {
      this._creativePainted = true;
      for (const node of this.refs.creative.children) {
        const id = Number(node.dataset.blockId);
        node.innerHTML = `<img alt="" draggable="false" src="${stackIcon(id, 40)}">`;
      }
    }
    const cur = inv.cursor;
    const cs = this.refs.cursorStack;
    if (cur && cur.count > 0) {
      cs.classList.remove('hidden');
      cs.innerHTML = `<img alt="" src="${stackIcon(cur.id, 40)}"><span class="count">${cur.count > 1 ? cur.count : ''}</span>`;
    } else {
      cs.classList.add('hidden');
      cs.innerHTML = '';
    }
  }

  refreshStatus() {
    const p = this.game.player;
    if (!p) return;
    // hearts
    const hearts = Math.ceil(p.maxHealth / 2);
    if (!this._heartsBuilt || this._heartsBuilt !== hearts) {
      this._heartsBuilt = hearts;
      this.refs.hearts.innerHTML = '';
      for (let i = 0; i < hearts; i++) {
        const c = document.createElement('canvas');
        c.width = 18; c.height = 18;
        this.refs.hearts.appendChild(c);
      }
      this.refs.hunger.innerHTML = '';
      for (let i = 0; i < 10; i++) {
        const c = document.createElement('canvas');
        c.width = 18; c.height = 18;
        this.refs.hunger.appendChild(c);
      }
    }
    const hp = p.health;
    [...this.refs.hearts.children].forEach((c, i) => drawHeart(c, hp - i * 2));
    const hg = p.hunger;
    [...this.refs.hunger.children].forEach((c, i) => drawHunger(c, hg - i * 2));

    // bubbles
    if (p.air < p.maxAir) {
      const n = Math.ceil(p.air / (p.maxAir / 10));
      if (this._bubbles !== n) {
        this._bubbles = n;
        this.refs.bubbles.innerHTML = '';
        for (let i = 0; i < n; i++) {
          const c = document.createElement('canvas');
          c.width = 18; c.height = 18;
          drawBubble(c);
          this.refs.bubbles.appendChild(c);
        }
      }
    } else if (this._bubbles !== 0) {
      this._bubbles = 0;
      this.refs.bubbles.innerHTML = '';
    }

    // xp bar
    const need = p.xpNeeded();
    this.refs.xpfill.style.width = Math.round((p.xp / need) * 100) + '%';
    this.refs.xplevel.textContent = p.level > 0 ? String(p.level) : '';
  }

  updateDebug(text) {
    if (!this.debugVisible) return;
    this.refs.debug.classList.remove('hidden');
    this.refs.debug.textContent = text;
  }

  toggleDebug() {
    this.debugVisible = !this.debugVisible;
    this.refs.debug.classList.toggle('hidden', !this.debugVisible);
  }
}

// ------------------------------------------------------------------ tiny icon painters
function drawHeart(canvas, value) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 18, 18);
  ctx.imageSmoothingEnabled = false;
  const full = value >= 2, half = value === 1;
  const px = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };
  const outline = '#3b0b0b';
  const red = '#e02b2b';
  const shape = [
    '..XX..XX..',
    '.XOOXXOOX.',
    'XOOOOOOOOX',
    'XOOOOOOOOX',
    'XOOOOOOOOX',
    '.XOOOOOOX.',
    '..XOOOOX..',
    '...XOOX...',
    '....XX....',
    '..........',
  ];
  for (let y = 0; y < shape.length; y++) {
    for (let x = 0; x < shape[y].length; x++) {
      const ch = shape[y][x];
      if (ch === '.') continue;
      const isOutline = ch === 'X';
      let color = isOutline ? outline : red;
      if (!isOutline && !full) {
        if (half && x >= 5) color = '#4a4a4a';
        if (!half) color = '#4a4a4a';
      }
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x * 1.7), Math.round(y * 1.7), 2, 2);
    }
  }
}

function drawHunger(canvas, value) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 18, 18);
  const full = value >= 2, half = value === 1;
  const shape = [
    '.......XXX',
    '......XOOX',
    '.....XOOX.',
    '....XOOX..',
    '..XXOOX...',
    '.XOOOX....',
    'XOOOX.....',
    '.XXX......',
    '..........',
    '..........',
  ];
  for (let y = 0; y < shape.length; y++) {
    for (let x = 0; x < shape[y].length; x++) {
      const ch = shape[y][x];
      if (ch === '.') continue;
      let color = ch === 'X' ? '#3b2a0b' : '#c9803a';
      if (ch === 'O' && !full) color = half && x < 5 ? '#c9803a' : '#4a4a4a';
      ctx.fillStyle = color;
      ctx.fillRect(Math.round(x * 1.7), Math.round(y * 1.7), 2, 2);
    }
  }
}

function drawBubble(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 18, 18);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(9, 9, 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath();
  ctx.arc(7, 7, 2, 0, Math.PI * 2);
  ctx.fill();
}
