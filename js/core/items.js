// core/items.js — the non-block item registry.
//
// Blocks use ids 0..127 (see blocks.js). Items use NEGATIVE ids so a single `ItemStack`
// number is unambiguous: id >= 0 is a block you can place, id < 0 is an item you can only
// hold, craft with or eat. That keeps the inventory, save format and HUD unchanged.
import { BLOCKS } from './blocks.js';

export const ITEMS = [];               // indexed by -id (1-based)
export const ITEM_BY_KEY = new Map();

/** Tool classes and the material tiers they come in. */
export const TOOL_CLASSES = ['pickaxe', 'axe', 'shovel', 'sword', 'hoe'];
export const TIERS = ['wood', 'stone', 'iron', 'diamond'];

/** Chinese labels for the potion effects, used to name the potion items. */
const POTION_CN = {
  healing: '治疗', regeneration: '生命恢复', strength: '力量', swiftness: '迅捷',
  fire_resistance: '抗火', night_vision: '夜视', water_breathing: '水下呼吸',
  poison: '剧毒', weakness: '虚弱', slowness: '缓慢',
};

// material tier -> { mining speed, durability, attack }
export const TIER_STATS = {
  wood: { speed: 2.0, durability: 60, attack: 2 },
  stone: { speed: 3.5, durability: 132, attack: 3 },
  iron: { speed: 5.5, durability: 251, attack: 4 },
  diamond: { speed: 8.0, durability: 1562, attack: 5 },
};

function item(id, key, cn, opts = {}) {
  const it = {
    id,                               // negative
    key, cn,
    stack: opts.stack ?? 64,
    // icons
    icon: opts.icon ?? 'ingot',       // shape family for the procedural icon
    color: opts.color ?? [0.7, 0.7, 0.7],
    color2: opts.color2 ?? null,
    tier: opts.tier ?? null,
    tool: opts.tool ?? null,          // TOOL_CLASSES entry
    armor: opts.armor ?? null,        // 'helmet' | 'chestplate' | 'leggings' | 'boots'
    armorMaterial: opts.armorMaterial ?? null,
    points: opts.points ?? 0,         // armour points contributed
    bow: opts.bow ?? false,
    material: opts.material ?? null,  // recipe material key
    damage: opts.damage ?? 1,         // sword / hand damage
    speed: opts.speed ?? 1,           // mining speed multiplier
    durability: opts.durability ?? 0, // 0 = unbreakable (stackable materials)
    food: opts.food ?? 0,             // hunger restored when eaten
    fuel: opts.fuel ?? 0,             // smelting seconds provided as fuel
    smelt: opts.smelt ?? null,        // { id, count } produced when smelted
    potion: opts.potion ?? null,      // { effect, level } for drinkable potions
    shield: opts.shield ?? false,     // right-click to block incoming damage
  };
  ITEMS[-id] = it;
  ITEM_BY_KEY.set(key, it);
  return it;
}

export function itemByKey(key) { return ITEM_BY_KEY.get(key) || null; }
export function itemById(id) { return id < 0 ? (ITEMS[-id] || null) : null; }

/** Highest item id in use (as a positive number), for the registry audit. */
export function maxItemId() {
  let max = 0;
  for (let i = 0; i < ITEMS.length; i++) if (ITEMS[i]) max = i;
  return max;
}

/** Name for any stack id (block or item). */
export function stackName(id) {
  if (id < 0) { const it = itemById(id); return it ? it.cn : '未知物品'; }
  const b = BLOCKS[id];
  return b ? b.cn : '空';
}

/** Max stack size for any id. */
export function stackLimit(id) {
  if (id < 0) { const it = itemById(id); return it ? it.stack : 64; }
  return 64;
}

/** True when the id can be placed as a block. */
export function isBlockId(id) { return id > 0 && !!BLOCKS[id]; }

// ------------------------------------------------------------------ material items
let nextItemId = -1;
const def = (key, cn, opts) => item(nextItemId--, key, cn, opts);

// raw materials
def('stick', '木棍', { icon: 'stick', color: [0.60, 0.44, 0.24], color2: [0.45, 0.32, 0.16], fuel: 5 });
def('coal', '煤炭', { icon: 'lump', color: [0.13, 0.13, 0.15], fuel: 80 });
def('charcoal', '木炭', { icon: 'lump', color: [0.20, 0.17, 0.14], fuel: 80 });
def('iron_ingot', '铁锭', { icon: 'ingot', color: [0.86, 0.86, 0.88] });
def('gold_ingot', '金锭', { icon: 'ingot', color: [0.98, 0.85, 0.28] });
def('diamond', '钻石', { icon: 'gem', color: [0.40, 0.95, 0.93] });
def('clay_ball', '黏土球', { icon: 'lump', color: [0.62, 0.66, 0.70] });
def('brick_item', '砖', { icon: 'ingot', color: [0.62, 0.36, 0.30] });
def('flint', '燧石', { icon: 'lump', color: [0.28, 0.26, 0.25] });
// paper -> book, so bookshelves are craftable and the enchanting table is reachable
def('paper', '纸', { icon: 'paper', color: [0.94, 0.94, 0.90] });
def('book', '书', { icon: 'book', color: [0.48, 0.28, 0.16], color2: [0.94, 0.94, 0.90] });
// emerald is the villager currency; smelting-free and stackable
def('emerald', '绿宝石', { icon: 'gem', color: [0.20, 0.94, 0.42], color2: [0.10, 0.55, 0.25] });
// string comes from wool, which comes from tall grass — a short but complete chain
def('string', '线', { icon: 'string', color: [0.90, 0.90, 0.90] });

// ---------------------------------------------------------------- farming
def('seeds', '小麦种子', { icon: 'seeds', color: [0.62, 0.68, 0.32] });
def('wheat', '小麦', { icon: 'wheat', color: [0.85, 0.70, 0.26] });

// ---------------------------------------------------------------- nether access
def('flint_and_steel', '打火石', {
  icon: 'flint_steel', stack: 1, color: [0.86, 0.82, 0.30], color2: [0.30, 0.32, 0.36],
  durability: 64,
});
def('obsidian_shard', '黑曜石碎片', { icon: 'gem', color: [0.24, 0.14, 0.36] });

// food
def('apple', '苹果', { icon: 'apple', color: [0.85, 0.20, 0.18], color2: [0.30, 0.58, 0.20], food: 4, stack: 64 });
def('bread', '面包', { icon: 'bread', color: [0.78, 0.58, 0.28], food: 5 });
def('cooked_porkchop', '熟猪排', { icon: 'meat', color: [0.72, 0.44, 0.26], food: 8 });
def('porkchop', '生猪排', { icon: 'meat', color: [0.86, 0.58, 0.58], food: 3, smelt: { key: 'cooked_porkchop' } });

// ------------------------------------------------------------------ tools
// A tool is a stack of `durability` uses; mining speed multiplies block progress.
const TIER_MATERIAL = { wood: 'planks', stone: 'cobblestone', iron: 'iron_ingot', diamond: 'diamond' };
const TIER_COLOR = {
  wood: [0.62, 0.45, 0.25], stone: [0.52, 0.52, 0.52],
  iron: [0.86, 0.86, 0.88], diamond: [0.42, 0.94, 0.92],
};

for (const tier of TIERS) {
  const st = TIER_STATS[tier];
  for (const cls of TOOL_CLASSES) {
    const cn = {
      pickaxe: '镐', axe: '斧', shovel: '锹', sword: '剑', hoe: '锄',
    }[cls];
    const tierCn = { wood: '木', stone: '石', iron: '铁', diamond: '钻石' }[tier];
    if (cls === 'sword') {
      def(`${tier}_sword`, `${tierCn}剑`, {
        icon: 'sword', stack: 1, color: TIER_COLOR[tier], color2: [0.45, 0.32, 0.16],
        tier, tool: cls, speed: 1.0, damage: st.attack, durability: st.durability,
      });
    } else {
      def(`${tier}_${cls}`, `${tierCn}${cn}`, {
        icon: cls, stack: 1, color: TIER_COLOR[tier], color2: [0.45, 0.32, 0.16],
        tier, tool: cls, speed: st.speed, damage: 1, durability: st.durability,
      });
    }
  }
}

// ---------------------------------------------------------------- ranged combat
def('arrow', '箭', { icon: 'arrow', color: [0.72, 0.72, 0.74], color2: [0.85, 0.85, 0.86] });
const TIER_COLOR_ARMOR = {
  leather: [0.62, 0.42, 0.26], wood: [0.62, 0.45, 0.25], stone: [0.52, 0.52, 0.52],
  iron: [0.86, 0.86, 0.88], gold: [0.98, 0.85, 0.28], diamond: [0.42, 0.94, 0.92],
};
for (const tier of TIERS) {
  def(`${tier}_bow`, `${ { wood: '木', stone: '石', iron: '铁', diamond: '钻石' }[tier]}弓`, {
    icon: 'bow', stack: 1, color: TIER_COLOR_ARMOR[tier], color2: [0.90, 0.90, 0.90],
    tier, bow: true, damage: 2 + TIERS.indexOf(tier),
    durability: { wood: 120, stone: 200, iron: 384, diamond: 900 }[tier],
  });
}

// ---------------------------------------------------------------- armour
// Armour pieces absorb a fraction of incoming damage; the total is capped like MC.
export const ARMOR_SLOTS = ['helmet', 'chestplate', 'leggings', 'boots'];
export const ARMOR_POINTS = { leather: 1, iron: 2, gold: 1.5, diamond: 3 };
export const ARMOR_DURABILITY = { leather: 80, iron: 240, gold: 112, diamond: 528 };
const ARMOR_MATERIAL = { leather: 'clay_ball', iron: 'iron_ingot', gold: 'gold_ingot', diamond: 'diamond' };
for (const mat of Object.keys(ARMOR_MATERIAL)) {
  for (const piece of ARMOR_SLOTS) {
    const cn = { helmet: '头盔', chestplate: '胸甲', leggings: '护腿', boots: '靴子' }[piece];
    const matCn = { leather: '皮革', iron: '铁', gold: '金', diamond: '钻石' }[mat];
    const isBig = piece === 'chestplate' || piece === 'leggings';
    def(`${mat}_${piece}`, `${matCn}${cn}`, {
      icon: piece, stack: 1, color: TIER_COLOR_ARMOR[mat],
      armor: piece, armorMaterial: mat,
      points: ARMOR_POINTS[mat] * (piece === 'chestplate' ? 3 : piece === 'leggings' ? 2 : 1) / 2,
      durability: ARMOR_DURABILITY[mat] * (isBig ? 1.6 : 1.2),
      material: ARMOR_MATERIAL[mat],
    });
  }
}

// ---------------------------------------------------------------- brewing
// Potion bottles are ordinary items whose key names the effect and level, so a potion is
// just a stack and the inventory/save/HUD need no changes at all.
def('empty_bottle', '玻璃瓶', { icon: 'bottle', stack: 16, color: [0.72, 0.86, 0.92] });
def('water_bottle', '水瓶', { icon: 'bottle_filled', stack: 1, color: [0.35, 0.55, 0.95] });
def('awkward_potion', '粗制的药水', { icon: 'bottle_filled', stack: 1, color: [0.55, 0.35, 0.70], potion: { effect: null } });
for (const [key, effect, level, color] of [
  ['potion_healing', 'healing', 1, [0.95, 0.25, 0.45]],
  ['potion_healing_2', 'healing', 2, [0.95, 0.25, 0.45]],
  ['potion_regeneration', 'regeneration', 1, [0.90, 0.45, 0.75]],
  ['potion_regeneration_2', 'regeneration', 2, [0.90, 0.45, 0.75]],
  ['potion_strength', 'strength', 1, [0.55, 0.20, 0.20]],
  ['potion_strength_2', 'strength', 2, [0.55, 0.20, 0.20]],
  ['potion_swiftness', 'swiftness', 1, [0.35, 0.85, 0.95]],
  ['potion_swiftness_2', 'swiftness', 2, [0.35, 0.85, 0.95]],
  ['potion_fire_resistance', 'fire_resistance', 1, [0.95, 0.60, 0.25]],
  ['potion_night_vision', 'night_vision', 1, [0.20, 0.25, 0.55]],
  ['potion_water_breathing', 'water_breathing', 1, [0.30, 0.65, 0.85]],
  ['potion_poison', 'poison', 1, [0.45, 0.75, 0.30]],
  ['potion_poison_2', 'poison', 2, [0.45, 0.75, 0.30]],
  ['potion_weakness', 'weakness', 1, [0.55, 0.55, 0.55]],
  ['potion_slowness', 'slowness', 1, [0.45, 0.45, 0.65]],
]) {
  def(key, `${POTION_CN[effect]}${level > 1 ? ' II' : ''}药水`, {
    icon: 'bottle_filled', stack: 1, color, potion: { effect, level },
  });
}
// brewing ingredients
def('nether_wart', '下界疣', { icon: 'wart', color: [0.60, 0.15, 0.20] });
def('blaze_rod', '烈焰棒', { icon: 'rod', color: [0.95, 0.78, 0.25] });
def('blaze_powder', '烈焰粉', { icon: 'powder', color: [0.98, 0.75, 0.20] });
def('magma_cream', '岩浆膏', { icon: 'lump', color: [0.85, 0.40, 0.15] });
def('ghast_tear', '恶魂之泪', { icon: 'tear', color: [0.92, 0.94, 0.90] });
def('glistering_melon', '闪烁的西瓜', { icon: 'melon', color: [0.95, 0.75, 0.25], color2: [0.35, 0.75, 0.30] });
def('golden_carrot', '金胡萝卜', { icon: 'carrot', color: [0.95, 0.78, 0.25], color2: [0.35, 0.75, 0.30] });
def('pufferfish', '河豚', { icon: 'fish', color: [0.85, 0.75, 0.35] });
def('spider_eye', '蜘蛛眼', { icon: 'eye', color: [0.75, 0.20, 0.25] });
def('fermented_spider_eye', '发酵蜘蛛眼', { icon: 'eye', color: [0.45, 0.25, 0.45] });
def('glowstone_dust', '荧石粉', { icon: 'powder', color: [0.98, 0.90, 0.55] });
def('sugar', '糖', { icon: 'powder', color: [0.96, 0.96, 0.94] });
def('melon_slice', '西瓜片', { icon: 'melon', color: [0.40, 0.78, 0.32], color2: [0.90, 0.35, 0.35] });
def('carrot', '胡萝卜', { icon: 'carrot', color: [0.95, 0.60, 0.20], color2: [0.40, 0.75, 0.30] });
def('gold_nugget', '金粒', { icon: 'nugget', color: [0.98, 0.85, 0.28] });

// ---------------------------------------------------------------- redstone
def('redstone_dust', '红石粉', { icon: 'powder', color: [0.85, 0.12, 0.10] });
def('piston_item', '活塞', { icon: 'piston', color: [0.72, 0.66, 0.50], color2: [0.55, 0.50, 0.38] });
def('repeater_item', '红石中继器', { icon: 'repeater', color: [0.62, 0.60, 0.56], color2: [0.85, 0.15, 0.12] });
def('hopper_item', '漏斗', { icon: 'hopper', color: [0.34, 0.34, 0.37] });

// ---------------------------------------------------------------- fishing
def('fishing_rod', '钓鱼竿', {
  icon: 'rod', stack: 1, color: [0.72, 0.58, 0.34], color2: [0.92, 0.92, 0.90],
  durability: 64,
});
def('cod', '鳕鱼', { icon: 'fish', color: [0.72, 0.60, 0.42], food: 2 });
def('salmon', '鲑鱼', { icon: 'fish', color: [0.86, 0.45, 0.38], food: 2 });
def('clownfish', '小丑鱼', { icon: 'fish', color: [0.95, 0.55, 0.25], food: 1 });
def('cooked_cod', '熟鳕鱼', { icon: 'fish', color: [0.80, 0.62, 0.38], food: 6 });
def('cooked_salmon', '熟鲑鱼', { icon: 'fish', color: [0.92, 0.52, 0.40], food: 6 });
// rotten flesh already exists as pufferfish? no — pufferfish is a brewing ingredient
def('rotten_flesh', '腐肉', { icon: 'meat', color: [0.48, 0.36, 0.28], food: 1 });
def('shield_item', '盾牌', {
  icon: 'shield', stack: 1, color: [0.45, 0.30, 0.16], color2: [0.80, 0.80, 0.84],
  durability: 336, shield: true,
});

// ------------------------------------------------------------------ smelting recipes
/** input id (block or item) -> { key, count } output, plus how long it takes. */
export const SMELT_RECIPES = new Map();
function smelt(inputId, outputKey, count = 1, seconds = 10) {
  SMELT_RECIPES.set(inputId, { key: outputKey, count, seconds });
}
export function resolveIds() {
  SMELT_RECIPES.clear();
  const K = (key) => (ITEM_BY_KEY.get(key) ? ITEM_BY_KEY.get(key).id : null);
  const B = (key) => {
    for (let i = 0; i < BLOCKS.length; i++) if (BLOCKS[i] && BLOCKS[i].key === key) return i;
    return null;
  };
  smelt(B('sand'), 'glass', 1, 8);
  smelt(B('cobblestone'), 'stone', 1, 10);         // stone is the block produced
  smelt(B('iron_ore'), 'iron_ingot', 1, 10);
  smelt(B('gold_ore'), 'gold_ingot', 1, 10);
  smelt(B('clay'), 'brick_item', 4, 10);
  smelt(B('log'), 'charcoal', 1, 10);
  smelt(K('porkchop'), 'cooked_porkchop', 1, 8);
  smelt(K('clay_ball'), 'brick_item', 1, 10);
}
