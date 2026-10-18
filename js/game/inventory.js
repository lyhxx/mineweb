// game/inventory.js — hotbar + 27 slot inventory + crafting grid (2x2 or 3x3) + furnace.
//
// Stacks hold either a block id (>= 0) or an item id (< 0); see core/items.js. The same
// Inventory object therefore serves the personal grid, the crafting table's 3x3 grid and
// the furnace's three slots — only the grid size and the open UI differ.
import { ItemStack, stackLimit, stackName, BLOCKS } from '../core/blocks.js';
import { itemByKey, itemById, TIER_STATS } from '../core/items.js';
import { eligibleEnchants, rollOffers, enchantFamilies, stackEnchants, protectionPoints } from '../core/enchant.js';
import { brewResult as brewRecipes } from '../core/potions.js';
import { BREW_INGREDIENTS } from '../core/potions.js';

export const HOTBAR_SIZE = 9;
export const MAIN_SIZE = 24;
export const ARMOR_SIZE = 4;
export const CRAFT_GRID_2 = 4;
export const CRAFT_GRID_3 = 9;
export const ARMOR_ORDER = ['helmet', 'chestplate', 'leggings', 'boots'];
// slot layout: [0..8] hotbar, [9..32] main pack, [33..36] armour (helmet..boots)
export const ARMOR_START = HOTBAR_SIZE + MAIN_SIZE;
export const INVENTORY_SIZE = ARMOR_START + ARMOR_SIZE;

/** Resolve a recipe key ('planks', 'stick', 'iron_pickaxe', ...) to a stack id. */
function idFor(key) {
  if (!key) return 0;
  if (key === 'air') return 0;
  const it = itemByKey(key);
  if (it) return it.id;
  // block key
  return BLOCK_IDS.get(key) ?? 0;
}

const BLOCK_IDS = new Map();
export function registerBlockKeys(blocks) {
  BLOCK_IDS.clear();
  for (let i = 0; i < blocks.length; i++) if (blocks[i]) BLOCK_IDS.set(blocks[i].key, i);
}
export function blockIdOfKey(key) { return BLOCK_IDS.get(key) ?? 0; }

/**
 * Crafting recipes. `key` is a legend of single characters; `rows` is the pattern using
 * those characters ('' or ' ' = empty). Patterns are matched anywhere inside the grid,
 * exactly like Minecraft, so 2x2 recipes also work on a 3x3 table.
 */
export const RECIPES = [
  // ---------------------------------------------------------------- basics
  { id: 'planks', name: '木板', key: { P: 'log' }, rows: ['P'], out: { key: 'planks', count: 4 } },
  { id: 'stick', name: '木棍', key: { P: 'planks' }, rows: ['P', 'P'], out: { key: 'stick', count: 4 } },
  { id: 'torch', name: '火把', key: { C: 'coal', S: 'stick' }, rows: ['C', 'S'], out: { key: 'torch', count: 4 } },
  { id: 'crafting_table', name: '工作台', key: { P: 'planks' }, rows: ['PP', 'PP'], out: { key: 'crafting_table', count: 1 } },
  { id: 'furnace', name: '熔炉', key: { C: 'cobblestone', ' ': 'air' }, rows: ['CCC', 'C C', 'CCC'], out: { key: 'furnace', count: 1 } },
  { id: 'chest', name: '箱子', key: { P: 'planks', ' ': 'air' }, rows: ['PPP', 'P P', 'PPP'], out: { key: 'chest', count: 1 } },

  // ---------------------------------------------------------------- stone / building
  { id: 'stone_bricks', name: '石头', key: { C: 'cobblestone' }, rows: ['CC', 'CC'], out: { key: 'stone', count: 4 } },
  { id: 'bricks', name: '砖块', key: { B: 'brick_item' }, rows: ['BB', 'BB'], out: { key: 'brick', count: 1 } },
  { id: 'sandstone', name: '砂岩', key: { S: 'sand' }, rows: ['SS', 'SS'], out: { key: 'sandstone', count: 1 } },
  { id: 'glass_pane', name: '玻璃板', key: { G: 'glass' }, rows: ['GGG', 'GGG'], out: { key: 'glass_pane', count: 16 } },

  // ---------------------------------------------------------------- mineral blocks
  { id: 'coal_block', name: '煤炭块', key: { C: 'coal' }, rows: ['CCC', 'CCC', 'CCC'], out: { key: 'coal_block', count: 1 } },
  { id: 'iron_block', name: '铁块', key: { I: 'iron_ingot' }, rows: ['III', 'III', 'III'], out: { key: 'iron_block', count: 1 } },
  { id: 'gold_block', name: '金块', key: { G: 'gold_ingot' }, rows: ['GGG', 'GGG', 'GGG'], out: { key: 'gold_block', count: 1 } },
  { id: 'diamond_block', name: '钻石块', key: { D: 'diamond' }, rows: ['DDD', 'DDD', 'DDD'], out: { key: 'diamond_block', count: 1 } },

  // ---------------------------------------------------------------- misc
  { id: 'bookshelf', name: '书架', key: { P: 'planks', B: 'brick' }, rows: ['PPP', 'BBB', 'PPP'], out: { key: 'bookshelf', count: 1 } },
  { id: 'tnt', name: 'TNT', key: { S: 'sand', C: 'coal' }, rows: ['SCS', 'CSC', 'SCS'], out: { key: 'tnt', count: 1 } },
  { id: 'glowstone', name: '荧石', key: { G: 'gold_ingot', B: 'brick_item' }, rows: ['GB', 'BG'], out: { key: 'glowstone', count: 1 } },
  { id: 'ladder', name: '梯子', key: { S: 'stick', P: 'planks' }, rows: ['P P', 'PPP', 'P P'], out: { key: 'ladder', count: 3 } },
  { id: 'anvil', name: '铁砧', key: { I: 'iron_ingot', B: 'iron_block' }, rows: ['III', ' B ', 'BBB'], out: { key: 'anvil', count: 1 } },
  { id: 'netherrack', name: '下界岩(合成)', key: { R: 'gravel', L: 'lava' }, rows: ['RR', 'RR'], out: { key: 'netherrack', count: 4 } },
  { id: 'wool_white', name: '白色羊毛(合成)', key: { C: 'tall_grass' }, rows: ['CC', 'CC'], out: { key: 'wool_white', count: 1 } },
  { id: 'wool_red', name: '红色羊毛(合成)', key: { W: 'wool_white', F: 'flower' }, rows: ['WF'], out: { key: 'wool_red', count: 1 } },
  { id: 'string', name: '线', key: { W: 'wool_white' }, rows: ['W'], out: { key: 'string', count: 4 } },
  // farming: wheat bakes into bread, wool plus planks makes a bed
  { id: 'bread', name: '面包', key: { W: 'wheat' }, rows: ['WWW'], out: { key: 'bread', count: 1 } },
  { id: 'bed', name: '床', key: { W: 'wool_white', P: 'planks' }, rows: ['WWW', 'PPP'], out: { key: 'bed', count: 1 } },
  // nether access: iron ingot + flint
  { id: 'flint_and_steel', name: '打火石', key: { I: 'iron_ingot', F: 'flint' }, rows: ['I ', ' F'], out: { key: 'flint_and_steel', count: 1 } },
];

// ---------------------------------------------------------------- tool recipes
// Pattern positions are literal, so a tool needs a 3x3 grid (i.e. a crafting table),
// exactly like Minecraft.
const TOOL_MATERIAL = { wood: 'planks', stone: 'cobblestone', iron: 'iron_ingot', diamond: 'diamond' };
const TOOL_NAME = { wood: '木', stone: '石', iron: '铁', diamond: '钻石' };
const CLASS_NAME = { pickaxe: '镐', axe: '斧', shovel: '锹', sword: '剑', hoe: '锄' };
for (const [tier, mat] of Object.entries(TOOL_MATERIAL)) {
  const M = mat;
  RECIPES.push({ id: `${tier}_pickaxe`, name: `${TOOL_NAME[tier]}镐`, key: { M, S: 'stick', ' ': 'air' }, rows: ['MMM', ' S ', ' S '], out: { key: `${tier}_pickaxe`, count: 1 } });
  RECIPES.push({ id: `${tier}_axe`, name: `${TOOL_NAME[tier]}斧`, key: { M, S: 'stick', ' ': 'air' }, rows: ['MM', 'MS', ' S'], out: { key: `${tier}_axe`, count: 1 } });
  RECIPES.push({ id: `${tier}_shovel`, name: `${TOOL_NAME[tier]}锹`, key: { M, S: 'stick', ' ': 'air' }, rows: ['M', 'S', 'S'], out: { key: `${tier}_shovel`, count: 1 } });
  RECIPES.push({ id: `${tier}_sword`, name: `${TOOL_NAME[tier]}剑`, key: { M, S: 'stick', ' ': 'air' }, rows: ['M', 'M', 'S'], out: { key: `${tier}_sword`, count: 1 } });
  RECIPES.push({ id: `${tier}_hoe`, name: `${TOOL_NAME[tier]}锄`, key: { M, S: 'stick', ' ': 'air' }, rows: ['MM', ' S', ' S'], out: { key: `${tier}_hoe`, count: 1 } });
}

// ---------------------------------------------------------------- ranged + armour
RECIPES.push({ id: 'arrow', name: '箭', key: { F: 'flint', S: 'stick', P: 'planks' }, rows: ['F', 'S', 'P'], out: { key: 'arrow', count: 4 } });
// bow: bent wood with a string down the left side (three sticks + three string)
RECIPES.push({ id: 'bow', name: '弓', key: { S: 'stick', T: 'string', ' ': 'air' }, rows: [' ST', 'S T', ' ST'], out: { key: 'wood_bow', count: 1 } });
// armour: 3/5/4/2 pieces of the material in the classic shapes (leather uses clay balls
// as the stand-in "hide" so it is craftable without adding a leather item chain)
for (const mat of ['leather', 'iron', 'gold', 'diamond']) {
  const M = mat === 'leather' ? 'clay_ball' : `${mat}_ingot`;
  const name = { leather: '皮革', iron: '铁', gold: '金', diamond: '钻石' }[mat];
  RECIPES.push({ id: `${mat}_helmet`, name: `${name}头盔`, key: { M }, rows: ['MMM', 'M M'], out: { key: `${mat}_helmet`, count: 1 } });
  RECIPES.push({ id: `${mat}_chestplate`, name: `${name}胸甲`, key: { M }, rows: ['M M', 'MMM', 'MMM'], out: { key: `${mat}_chestplate`, count: 1 } });
  RECIPES.push({ id: `${mat}_leggings`, name: `${name}护腿`, key: { M }, rows: ['MMM', 'M M', 'M M'], out: { key: `${mat}_leggings`, count: 1 } });
  RECIPES.push({ id: `${mat}_boots`, name: `${name}靴子`, key: { M }, rows: ['M M', 'M M'], out: { key: `${mat}_boots`, count: 1 } });
  // a 2x2-friendly shortcut so leather armour is reachable early
  if (mat === 'leather') {
    RECIPES.push({ id: 'leather_boots_2x2', name: '皮革靴子(小)', key: { M }, rows: ['MM'], out: { key: 'leather_boots', count: 1 } });
  }
}

// ---------------------------------------------------------------- enchanting
// paper comes from sugar cane in MC; here tall grass is the fibre source
RECIPES.push({ id: 'paper', name: '纸', key: { C: 'tall_grass' }, rows: ['CCC'], out: { key: 'paper', count: 3 } });
RECIPES.push({ id: 'book', name: '书', key: { P: 'paper' }, rows: ['PP', 'PP'], out: { key: 'book', count: 1 } });
RECIPES.push({ id: 'bookshelf_recipe', name: '书架', key: { P: 'planks', B: 'book' }, rows: ['PPP', 'BBB', 'PPP'], out: { key: 'bookshelf', count: 1 } });
RECIPES.push({ id: 'enchanting_table', name: '附魔台', key: { O: 'obsidian', D: 'diamond', B: 'book' }, rows: [' B ', 'DOD', 'OOO'], out: { key: 'enchanting_table', count: 1 } });

// a villager-style emerald recipe so the currency is obtainable without trading
RECIPES.push({ id: 'emerald', name: '绿宝石', key: { I: 'iron_ingot', D: 'diamond' }, rows: ['III', 'IDI', 'III'], out: { key: 'emerald', count: 2 } });

// ---------------------------------------------------------------- brewing support
RECIPES.push({ id: 'brewing_stand', name: '酿造台', key: { R: 'blaze_rod', C: 'cobblestone' }, rows: [' R ', 'CCC'], out: { key: 'brewing_stand', count: 1 } });
RECIPES.push({ id: 'glass_bottle', name: '玻璃瓶', key: { G: 'glass' }, rows: ['G G', ' G '], out: { key: 'empty_bottle', count: 3 } });
RECIPES.push({ id: 'sugar', name: '糖', key: { C: 'tall_grass' }, rows: ['C'], out: { key: 'sugar', count: 2 } });
RECIPES.push({ id: 'gold_nugget', name: '金粒', key: { G: 'gold_ingot' }, rows: ['G'], out: { key: 'gold_nugget', count: 9 } });
RECIPES.push({ id: 'golden_carrot', name: '金胡萝卜', key: { N: 'gold_nugget', C: 'carrot' }, rows: ['NNN', 'NCN', 'NNN'], out: { key: 'golden_carrot', count: 1 } });
RECIPES.push({ id: 'blaze_powder', name: '烈焰粉', key: { R: 'blaze_rod' }, rows: ['R'], out: { key: 'blaze_powder', count: 2 } });
RECIPES.push({ id: 'glistering_melon', name: '闪烁的西瓜', key: { N: 'gold_nugget', M: 'melon_slice' }, rows: ['NNN', 'NMN', 'NNN'], out: { key: 'glistering_melon', count: 1 } });

// ---------------------------------------------------------------- redstone
RECIPES.push({ id: 'redstone_block', name: '红石块', key: { R: 'redstone_dust' }, rows: ['RRR', 'RRR', 'RRR'], out: { key: 'redstone_block', count: 1 } });
RECIPES.push({ id: 'redstone_torch', name: '红石火把', key: { R: 'redstone_dust', S: 'stick' }, rows: ['R', 'S'], out: { key: 'redstone_torch', count: 1 } });
RECIPES.push({ id: 'lever', name: '拉杆', key: { S: 'stick', C: 'cobblestone' }, rows: ['S', 'C'], out: { key: 'lever', count: 1 } });
RECIPES.push({ id: 'stone_button', name: '石按钮', key: { C: 'stone' }, rows: ['C'], out: { key: 'stone_button', count: 1 } });
RECIPES.push({ id: 'pressure_plate', name: '压力板', key: { C: 'stone' }, rows: ['CC'], out: { key: 'pressure_plate', count: 1 } });
RECIPES.push({ id: 'redstone_lamp', name: '红石灯', key: { R: 'redstone_dust', G: 'glass' }, rows: [' R ', 'RGR', ' R '], out: { key: 'redstone_lamp', count: 1 } });
RECIPES.push({ id: 'piston', name: '活塞', key: { P: 'planks', C: 'cobblestone', I: 'iron_ingot', R: 'redstone_dust' }, rows: ['PPP', 'CIC', 'CRC'], out: { key: 'piston', count: 1 } });

// ---------------------------------------------------------------- item logistics
RECIPES.push({ id: 'hopper', name: '漏斗', key: { I: 'iron_ingot', C: 'chest' }, rows: ['I I', 'ICI', ' I '], out: { key: 'hopper', count: 1 } });
RECIPES.push({ id: 'dispenser', name: '发射器', key: { C: 'cobblestone', B: 'bow', R: 'redstone_dust' }, rows: ['CCC', 'CBC', 'CRC'], out: { key: 'dispenser', count: 1 } });
RECIPES.push({ id: 'repeater', name: '红石中继器', key: { S: 'stone', R: 'redstone_torch', D: 'redstone_dust' }, rows: ['SSS', 'RDR'], out: { key: 'repeater_item', count: 1 } });

// ---------------------------------------------------------------- fishing + shield
RECIPES.push({ id: 'fishing_rod', name: '钓鱼竿', key: { S: 'stick', T: 'string' }, rows: ['  S', ' ST', 'S T'], out: { key: 'fishing_rod', count: 1 } });
RECIPES.push({ id: 'shield', name: '盾牌', key: { P: 'planks', I: 'iron_ingot' }, rows: ['PPP', 'PIP', ' P '], out: { key: 'shield_item', count: 1 } });

/** Look up a recipe by its id (the recipe book UI uses this). */
export function recipeById(id) { return RECIPES.find((r) => r.id === id) || null; }

/** The resolved output stack of a recipe. */
export function recipeOutput(recipe) {
  return new ItemStack(idFor(recipe.out.key), recipe.out.count);
}

/**
 * Match a crafting grid of `size` × `size` against every recipe.
 * Returns the recipe plus the offset it matched at, or null.
 */
export function matchRecipe(grid, size) {
  for (const rec of RECIPES) {
    const ph = rec.rows.length, pw = Math.max(...rec.rows.map((r) => r.length));
    if (ph > size || pw > size) continue;
    for (let oy = 0; oy + ph <= size; oy++) {
      for (let ox = 0; ox + pw <= size; ox++) {
        let ok = true;
        for (let y = 0; y < size && ok; y++) {
          for (let x = 0; x < size; x++) {
            const row = y - oy, col = x - ox;
            const ch = (row >= 0 && row < ph && col >= 0 && col < pw) ? (rec.rows[row][col] || ' ') : ' ';
            const want = (ch === ' ' || ch === undefined) ? 0 : idFor(rec.key[ch]);
            const have = grid[y * size + x] ? grid[y * size + x].id : 0;
            if (want !== have) { ok = false; break; }
          }
        }
        if (ok) return { recipe: rec, ox, oy };
      }
    }
  }
  return null;
}

/** Recipes the player can currently make from their inventory (for the recipe book). */
export function availableRecipes(inv) {
  const counts = new Map();
  for (const s of inv.slots) {
    if (!s) continue;
    counts.set(s.id, (counts.get(s.id) || 0) + s.count);
  }
  return RECIPES.filter((rec) => {
    const need = new Map();
    for (const row of rec.rows) {
      for (const ch of row) {
        if (ch === ' ' || ch === undefined) continue;
        const id = idFor(rec.key[ch]);
        if (!id) continue;
        need.set(id, (need.get(id) || 0) + 1);
      }
    }
    for (const [id, n] of need) if ((counts.get(id) || 0) < n) return false;
    return true;
  });
}

// ------------------------------------------------------------------ food / tools helpers
export function foodValue(id) { const it = itemById(id); return it ? it.food : 0; }
export function toolInfo(id) {
  const it = itemById(id);
  if (!it || !it.tool) return null;
  return { tool: it.tool, speed: it.speed, damage: it.damage, durability: it.durability, tier: it.tier };
}
export function maxDurability(id) { const it = itemById(id); return it ? it.durability : 0; }
export function armorInfo(id) {
  const it = itemById(id);
  if (!it || !it.armor) return null;
  return { slot: it.armor, points: it.points, durability: it.durability, material: it.armorMaterial };
}
export function isBow(id) { const it = itemById(id); return !!(it && it.bow); }
export function bowPower(id) { const it = itemById(id); return it && it.bow ? it.damage : 0; }

/** The armour pieces currently worn in the four armour slots. */
export function wornArmor(inv) {
  const out = [];
  for (let i = ARMOR_START; i < INVENTORY_SIZE; i++) {
    const s = inv.slots[i];
    if (s) out.push({ index: i, stack: s, info: armorInfo(s.id) });
  }
  return out;
}

/** Total armour points, including the Protection enchantment on each piece. */
export function armorPoints(inv) {
  let total = 0;
  for (const a of wornArmor(inv)) {
    if (!a.info) continue;
    total += a.info.points + protectionPoints(a.stack);
  }
  return Math.min(20, total);
}

/** Extra damage reduction (0..0.4) granted by the Protection enchantment. */
export function enchantMitigation(inv) {
  let pct = 0;
  for (const a of wornArmor(inv)) if (a.info) pct += protectionPoints(a.stack) * 0.04;
  return Math.min(0.4, pct);
}

export class Inventory {
  constructor() {
    this.slots = new Array(INVENTORY_SIZE).fill(null);
    this.cursor = null;              // stack held by the mouse
    this.selected = 0;               // hotbar index
    this.creative = false;
    this.craftSize = 2;              // 2 = personal grid, 3 = crafting table
    this.craftGrid = new Array(CRAFT_GRID_3).fill(null);
    this.craftOut = null;
    this.recipe = null;
    // enchanting table state
    // brewing stand state
    this.brewing = { ingredient: null, bottles: [null, null, null], progress: 0, total: 0 };
    this.enchantItem = null;
    this.enchantOffers = null;
    // furnace state (shared with the Furnace UI)
    this.furnace = {
      input: null, fuel: null, output: null,
      burn: 0, burnTotal: 0, cook: 0,
    };
  }

  get held() { return this.slots[this.selected]; }
  get heldId() { return this.slots[this.selected]?.id ?? 0; }

  setSlot(i, stack) { this.slots[i] = stack && stack.count > 0 ? stack : null; }

  /** Add a stack; returns the number of items that did not fit. */
  add(id, count = 1) {
    const limit = stackLimit(id);
    let left = count;
    for (let i = 0; i < INVENTORY_SIZE && left > 0; i++) {
      const s = this.slots[i];
      if (!s || s.id !== id || s.count >= limit) continue;
      const take = Math.min(limit - s.count, left);
      s.count += take; left -= take;
    }
    for (let i = 0; i < INVENTORY_SIZE && left > 0; i++) {
      if (this.slots[i]) continue;
      const take = Math.min(limit, left);
      this.slots[i] = new ItemStack(id, take);
      left -= take;
    }
    return left;
  }

  count(id) {
    let n = 0;
    for (const s of this.slots) if (s && s.id === id) n += s.count;
    return n;
  }

  /** Consume one item from the currently held stack. */
  consumeHeld(n = 1) {
    if (this.creative) return;
    const s = this.held;
    if (!s) return;
    s.count -= n;
    if (s.count <= 0) this.slots[this.selected] = null;
  }

  /**
   * Damage the held tool by one use. Returns true when it broke.
   * Tools are consumed here rather than in consumeHeld, so placing blocks does not wear
   * a pickaxe down.
   */
  damageHeld(amount = 1) {
    if (this.creative) return false;
    const s = this.held;
    if (!s) return false;
    // any item with durability can be damaged, not just tools (bows, flint & steel)
    const info = toolInfo(s.id);
    const maxDur = info ? info.durability : maxDurability(s.id);
    if (!maxDur || maxDur <= 0) return false;
    if (s.durability === null || s.durability === undefined) s.durability = maxDur;
    const ub = s.enchLevel('unbreaking');
    if (ub > 0 && Math.random() < ub / (ub + 1)) return false;
    s.durability -= amount;
    if (s.durability <= 0) {
      this.slots[this.selected] = null;
      return true;
    }
    return false;
  }

  /**
   * Damage the worn armour. Returns the number of pieces that broke.
   * Unbreaking gives a chance to skip the wear entirely.
   */
  damageArmor(amount = 1) {
    if (this.creative) return 0;
    let broke = 0;
    for (let i = ARMOR_START; i < INVENTORY_SIZE; i++) {
      const s = this.slots[i];
      if (!s) continue;
      const info = armorInfo(s.id);
      if (!info || info.durability <= 0) continue;
      if (s.durability === null || s.durability === undefined) s.durability = info.durability;
      const ub = s.enchLevel('unbreaking');
      if (ub > 0 && Math.random() < ub / (ub + 1)) continue;
      s.durability -= amount;
      if (s.durability <= 0) { this.slots[i] = null; broke++; }
    }
    return broke;
  }

  /**
   * Generic slot click over any slot array. The main inventory, the chest and the
   * furnace all funnel through here so the rules stay identical everywhere.
   *
   * Armour slots only accept the matching piece; the chest/armour arrays are never
   * shift-click targets for each other's contents.
   */
  clickArraySlot(arr, index, rightClick, shift, opts = {}) {
    const armorOnly = !!opts.armorIndex;         // index is inside the armour block
    const slot = arr[index];
    const accepts = (stack) => {
      if (!stack) return false;
      if (!armorOnly) return true;
      const want = ARMOR_ORDER[index - ARMOR_START];
      const info = armorInfo(stack.id);
      return !!info && info.slot === want;
    };

    if (shift && slot) {
      // quick-move into the main inventory (or out of it)
      const inArmor = armorOnly;
      const range = inArmor ? [0, INVENTORY_SIZE] : [0, INVENTORY_SIZE];
      const limit = stackLimit(slot.id);
      for (let i = range[0]; i < range[1]; i++) {
        if (i === index) continue;
        if (i >= ARMOR_START && !accepts(slot)) continue;
        if (i >= ARMOR_START && armorOnly) continue;
        const s = arr[i];
        if (s && s.id === slot.id && s.count < limit) {
          const take = Math.min(limit - s.count, slot.count);
          s.count += take; slot.count -= take;
          if (slot.count <= 0) { arr[index] = null; return; }
        }
      }
      for (let i = range[0]; i < range[1]; i++) {
        if (i === index || arr[i]) continue;
        if (i >= ARMOR_START && !accepts(slot)) continue;
        if (i >= ARMOR_START && armorOnly) continue;
        arr[i] = slot; arr[index] = null; return;
      }
      return;
    }

    if (!this.cursor) {
      if (!slot) return;
      if (rightClick) {
        const half = Math.ceil(slot.count / 2);
        this.cursor = new ItemStack(slot.id, half, slot.durability);
        slot.count -= half;
        if (slot.count <= 0) arr[index] = null;
      } else {
        this.cursor = slot;
        arr[index] = null;
      }
      return;
    }

    if (!accepts(this.cursor)) return;

    if (!slot) {
      if (rightClick) {
        arr[index] = new ItemStack(this.cursor.id, 1, this.cursor.durability);
        this.cursor.count--;
        if (this.cursor.count <= 0) this.cursor = null;
      } else {
        arr[index] = this.cursor;
        this.cursor = null;
      }
      return;
    }
    const limit = stackLimit(slot.id);
    if (slot.id === this.cursor.id && slot.count < limit) {
      const take = rightClick ? 1 : Math.min(limit - slot.count, this.cursor.count);
      slot.count += take; this.cursor.count -= take;
      if (this.cursor.count <= 0) this.cursor = null;
      return;
    }
    const tmp = arr[index];
    arr[index] = this.cursor;
    this.cursor = tmp;
  }

  /** Click handling shared by the hotbar and the inventory screen. */
  clickSlot(index, rightClick, shift) {
    // anything in the armour block follows the armour rules
    return this.clickArraySlot(this.slots, index, rightClick, shift, { armorIndex: index >= ARMOR_START });
  }

  /** Click handling for a chest's 27 slots (never an armour index). */
  clickChestSlot(chest, index, rightClick, shift) {
    return this.clickArraySlot(chest, index, rightClick, shift, { armorIndex: false });
  }


  /** Fill the hotbar with a starter kit (survival) or a broad palette (creative). */
  giveStarterKit() {
    this.slots.fill(null);
    const kit = [
      { key: 'planks', count: 32 }, { key: 'cobblestone', count: 32 },
      { key: 'crafting_table', count: 1 }, { key: 'torch', count: 16 },
      { key: 'wood_pickaxe', count: 1 }, { key: 'wood_axe', count: 1 },
      { key: 'bread', count: 3 }, { key: 'stick', count: 16 },
      { key: 'furnace', count: 1 },
    ];
    kit.forEach((entry, i) => {
      const id = resolveAny(entry.key);
      if (id) {
        const it = itemById(id);
        this.slots[i] = new ItemStack(id, entry.count, it && it.durability ? it.durability : null);
      }
    });
  }

  /** Creative palette: the first hotbar row of every interesting block and item. */
  /**
   * Creative palette: the hotbar plus the first two pack rows are filled with blocks so
   * creative mode is immediately usable. Stacks never deplete (see consumeHeld), and the
   * full catalogue — every block and item — stays reachable through the creative tab in
   * the inventory screen.
   */
  giveCreativePalette() {
    this.slots.fill(null);
    if (!this.creative) return;
    // hotbar first: the blocks you reach for constantly
    const hotbar = [
      'grass', 'dirt', 'stone', 'cobblestone', 'planks', 'log', 'sand', 'glass', 'torch',
    ];
    const used = new Set();
    let slot = 0;
    // stop before the armour block: those four slots only ever hold armour
    const limit = ARMOR_START;
    const put = (key, count = 64) => {
      const id = resolveAny(key);
      if (!id || used.has(id) || slot >= limit) return;
      used.add(id);
      this.slots[slot++] = new ItemStack(id, count);
    };
    for (const key of hotbar) put(key);
    // then the rest of the catalogue in block-id order, so nothing is unreachable
    for (let id = 1; id < BLOCKS.length && slot < limit; id++) {
      if (!BLOCKS[id]) continue;
      put(BLOCKS[id].key);
    }
  }

  serialize() {
    return {
      slots: this.slots.map((s) => (s ? [s.id, s.count, s.durability ?? null] : null)),
      selected: this.selected,
    };
  }

  deserialize(data) {
    if (!data) return;
    this.slots = new Array(INVENTORY_SIZE).fill(null);
    data.slots.forEach((s, i) => { if (s) this.slots[i] = new ItemStack(s[0], s[1], s[2] ?? null); });
    this.selected = data.selected || 0;
  }

  // ---------------------------------------------------------------- crafting grid
  /** The grid cells actually in play (2x2 or 3x3). */
  activeGrid() {
    const n = this.craftSize;
    const out = new Array(n * n).fill(null);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) out[y * n + x] = this.craftGrid[y * 3 + x];
    }
    return out;
  }

  updateCraftResult() {
    const grid = this.activeGrid();
    const m = matchRecipe(grid, this.craftSize);
    this.recipe = m ? m.recipe : null;
    this.craftOut = this.recipe ? recipeOutput(this.recipe) : null;
  }

  _consumeCraftInputs() {
    const n = this.craftSize;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * 3 + x;
        const s = this.craftGrid[i];
        if (!s) continue;
        s.count--;
        if (s.count <= 0) this.craftGrid[i] = null;
      }
    }
    // a shrinking grid must not leave stale cells behind
    if (n === 2) for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) if (x > 1 || y > 1) this.craftGrid[y * 3 + x] = null;
  }

  /** Click a grid cell: place / take / split, mirroring the main slots. */
  clickCraftSlot(index, rightClick) {
    const s = this.craftGrid[index];
    if (!this.cursor) {
      if (!s) return;
      this.craftGrid[index] = null;
      this.cursor = s;
      this.updateCraftResult();
      return;
    }
    if (!s) {
      const take = rightClick ? 1 : this.cursor.count;
      this.craftGrid[index] = new ItemStack(this.cursor.id, take, this.cursor.durability);
      this.cursor.count -= take;
      if (this.cursor.count <= 0) this.cursor = null;
      this.updateCraftResult();
      return;
    }
    const limit = stackLimit(s.id);
    if (s.id === this.cursor.id && s.count < limit) {
      const take = rightClick ? 1 : Math.min(limit - s.count, this.cursor.count);
      s.count += take; this.cursor.count -= take;
      if (this.cursor.count <= 0) this.cursor = null;
      this.updateCraftResult();
      return;
    }
    const tmp = this.craftGrid[index];
    this.craftGrid[index] = this.cursor;
    this.cursor = tmp;
    this.updateCraftResult();
  }

  /** Take the crafting result, consuming one item from each used grid cell. */
  takeCraftResult() {
    this.updateCraftResult();
    if (!this.craftOut) return null;
    const out = this.craftOut.clone();
    this._consumeCraftInputs();
    this.updateCraftResult();
    return out;
  }

  /** Send the crafting result straight to the inventory (shift-click / the arrow). */
  craftToInventory() {
    this.updateCraftResult();
    if (!this.craftOut) return false;
    const left = this.add(this.craftOut.id, this.craftOut.count);
    if (left !== 0) return false;
    this._consumeCraftInputs();
    this.updateCraftResult();
    return true;
  }

  /** Return any grid contents (and the cursor) to the inventory. */
  clearCrafting() {
    for (let i = 0; i < CRAFT_GRID_3; i++) {
      const s = this.craftGrid[i];
      if (s) { this.add(s.id, s.count); this.craftGrid[i] = null; }
    }
    this.updateCraftResult();
  }

  // ---------------------------------------------------------------- furnace
  /**
   * Advance the furnace. Called every frame with the elapsed seconds.
   * Returns true when the visible state changed (so the UI can repaint).
   */
  tickFurnace(dt, smeltRecipes) {
    const f = this.furnace;
    let changed = false;
    const recipe = f.input ? smeltRecipes.get(f.input.id) : null;
    const outputId = recipe ? resolveAny(recipe.key) : 0;
    const canSmelt = !!recipe && outputId !== 0
      && (!f.output || (f.output.id === outputId && f.output.count + recipe.count <= stackLimit(outputId)));

    if (f.burn > 0) { f.burn = Math.max(0, f.burn - dt); changed = true; }
    if (f.burn <= 0 && canSmelt && f.fuel) {
      // light the furnace with one unit of fuel
      const fuelItem = itemById(f.fuel.id);
      const burnSeconds = fuelItem && fuelItem.fuel ? fuelItem.fuel : 0;
      const isFuelBlock = f.fuel.id > 0 && (f.fuel.id === 32 /* coal block */);
      const seconds = burnSeconds || (isFuelBlock ? 800 : 0);
      if (seconds > 0) {
        f.burnTotal = seconds;
        f.burn = seconds;
        f.fuel.count--;
        if (f.fuel.count <= 0) f.fuel = null;
        changed = true;
      }
    }
    if (f.burn > 0 && canSmelt) {
      f.cook += dt;
      const need = recipe.seconds;
      if (f.cook >= need) {
        f.cook = 0;
        f.input.count--;
        if (f.input.count <= 0) f.input = null;
        if (!f.output) f.output = new ItemStack(outputId, recipe.count);
        else f.output.count += recipe.count;
      }
      changed = true;
    } else if (f.cook > 0) {
      f.cook = Math.max(0, f.cook - dt * 2);
      changed = true;
    }
    return changed;
  }

  // ---------------------------------------------------------------- enchanting
  /** Put a stack into the table's single slot (worn armour and tools only). */
  setEnchantItem(stack) {
    this.enchantItem = stack || null;
    this.enchantOffers = null;
  }

  /** Click the table slot: place the held item, or take it back. */
  clickEnchantSlot(rightClick) {
    if (!this.cursor) {
      if (!this.enchantItem) return;
      this.cursor = this.enchantItem;
      // brewing stand state
    this.brewing = { ingredient: null, bottles: [null, null, null], progress: 0, total: 0 };
    this.enchantItem = null;
      this.enchantOffers = null;
      return;
    }
    const info = itemById(this.cursor.id);
    if (!info || !enchantFamilies(info).length) return;     // not enchantable
    const tmp = this.enchantItem;
    this.enchantItem = new ItemStack(this.cursor.id, 1, this.cursor.durability, this.cursor.ench ? { ...this.cursor.ench } : null);
    this.cursor.count -= 1;
    if (this.cursor.count <= 0) this.cursor = null;
    if (tmp) this.add(tmp.id, tmp.count);
    this.enchantOffers = null;
  }

  // ---------------------------------------------------------------- brewing
  /**
   * Click one of the stand's four slots: 'ingredient', or 'bottle0'..'bottle2'.
   * Bottles only accept bottle-ish items, the ingredient slot only accepts ingredients,
   * so a stray tool cannot be dropped in.
   */
  clickBrewSlot(which, rightClick) {
    const brew = this.brewing || (this.brewing = { ingredient: null, bottles: [null, null, null], progress: 0, total: 0 });
    const isBottle = (id) => {
      const it = itemById(id);
      return !!it && (it.key === 'empty_bottle' || it.key === 'water_bottle' || it.key.endsWith('_potion') || it.key === 'awkward_potion');
    };
    const isIngredient = (id) => {
      const it = itemById(id);
      if (!it) return false;
      return BREW_INGREDIENTS.has(it.key);
    };
    const arr = which === 'ingredient' ? { get: () => brew.ingredient, set: (v) => { brew.ingredient = v; }, accept: isIngredient }
      : {
        get: () => brew.bottles[Number(which.slice(6))],
        set: (v) => { brew.bottles[Number(which.slice(6))] = v; },
        accept: isBottle,
      };
    const slot = arr.get();
    if (!this.cursor) {
      if (!slot) return;
      arr.set(null);
      this.cursor = slot;
      return;
    }
    if (!arr.accept(this.cursor.id)) return;
    if (!slot) {
      const take = rightClick ? 1 : this.cursor.count;
      arr.set(new ItemStack(this.cursor.id, take, this.cursor.durability));
      this.cursor.count -= take;
      if (this.cursor.count <= 0) this.cursor = null;
      return;
    }
    const limit = stackLimit(slot.id);
    if (slot.id === this.cursor.id && slot.count < limit) {
      const take = rightClick ? 1 : Math.min(limit - slot.count, this.cursor.count);
      slot.count += take; this.cursor.count -= take;
      if (this.cursor.count <= 0) this.cursor = null;
      return;
    }
    arr.set(this.cursor);
    this.cursor = slot;
  }

  /**
   * Advance the stand. Returns true when the visible state changed.
   * Brewing takes 20 seconds per step, exactly like Minecraft's blaze-powder stand.
   */
  tickBrewing(dt, recipes) {
    const brew = this.brewing || (this.brewing = { ingredient: null, bottles: [null, null, null], progress: 0, total: 0 });
    const ingredient = brew.ingredient;
    const withKey = ingredient ? (itemById(ingredient.id) || {}).key : null;
    // is there at least one bottle that this ingredient would actually change?
    const anyValid = withKey && brew.bottles.some((b) => {
      if (!b) return false;
      const fromKey = (itemById(b.id) || {}).key;
      return !!recipes(fromKey, withKey);
    });
    if (!anyValid) {
      if (brew.progress > 0) { brew.progress = 0; return true; }
      return false;
    }
    brew.total = brew.total || 20;
    brew.progress += dt;
    if (brew.progress < brew.total) return true;
    // finish one step: every bottle that can advance does so
    brew.progress = 0;
    for (let i = 0; i < brew.bottles.length; i++) {
      const b = brew.bottles[i];
      if (!b) continue;
      const fromKey = (itemById(b.id) || {}).key;
      const toKey = recipes(fromKey, withKey);
      if (!toKey) continue;
      const toId = resolveAny(toKey);
      if (!toId) continue;
      brew.bottles[i] = new ItemStack(toId, 1, null);
    }
    ingredient.count -= 1;
    if (ingredient.count <= 0) brew.ingredient = null;
    return true;
  }

  /** Click one of the furnace's three slots. */
  clickFurnaceSlot(which, rightClick) {    const f = this.furnace;
    const slot = f[which];
    if (!this.cursor) {
      if (!slot) return;
      // taking the output yields the whole stack
      f[which] = null;
      this.cursor = slot;
      return;
    }
    if (which === 'output') return;                 // cannot insert into the output
    if (!slot) {
      const take = rightClick ? 1 : this.cursor.count;
      f[which] = new ItemStack(this.cursor.id, take, this.cursor.durability);
      this.cursor.count -= take;
      if (this.cursor.count <= 0) this.cursor = null;
      return;
    }
    const limit = stackLimit(slot.id);
    if (slot.id === this.cursor.id && slot.count < limit) {
      const take = rightClick ? 1 : Math.min(limit - slot.count, this.cursor.count);
      slot.count += take; this.cursor.count -= take;
      if (this.cursor.count <= 0) this.cursor = null;
      return;
    }
    const tmp = f[which];
    f[which] = this.cursor;
    this.cursor = tmp;
  }
}

/** Resolve a block key or item key to its stack id. */
export function resolveAny(key) {
  const it = itemByKey(key);
  if (it) return it.id;
  return BLOCK_IDS.get(key) ?? 0;
}
