// core/enchant.js — enchantments.
//
// An enchantment is a (key, level) pair stored on an ItemStack in `stack.ench`. The
// effects are read at the places that matter (mining speed, melee damage, bow power,
// armour mitigation, durability wear) rather than being baked into the item, so a stack
// behaves differently from the moment it is enchanted.
//
// The offers an enchanting table shows are derived from the item and the player's level,
// and are deterministic per (item, level, slot) so re-opening the table does not reroll
// them for free.
import { itemById } from './items.js';

export const ENCHANTS = [
  { key: 'efficiency', cn: '效率', max: 3, applies: ['pickaxe', 'axe', 'shovel', 'hoe'], targets: '工具',
    desc: (l) => `挖掘速度 +${l * 40}%` },
  { key: 'sharpness', cn: '锋利', max: 3, applies: ['sword'], targets: '剑',
    desc: (l) => `近战伤害 +${l}` },
  { key: 'protection', cn: '保护', max: 3, applies: ['armor'], targets: '盔甲',
    desc: (l) => `额外减伤 +${l * 4}%` },
  { key: 'power', cn: '力量', max: 3, applies: ['bow'], targets: '弓',
    desc: (l) => `箭伤害 +${l * 2}` },
  { key: 'unbreaking', cn: '耐久', max: 3, applies: ['pickaxe', 'axe', 'shovel', 'hoe', 'sword', 'armor', 'bow', 'flint'],
    targets: '全部装备', desc: (l) => `${Math.round(l * 100 / (l + 1))}% 概率不消耗耐久` },
];

export const ENCHANT_BY_KEY = new Map(ENCHANTS.map((e) => [e.key, e]));

/** Which enchantment families an item belongs to. */
export function enchantFamilies(item) {
  if (!item) return [];
  const out = [];
  if (item.tool) out.push(item.tool);
  if (item.armor) out.push('armor');
  if (item.bow) out.push('bow');
  if (item.key === 'flint_and_steel') out.push('flint');
  return out;
}

/** Enchantments that can be applied to a stack's item. */
export function eligibleEnchants(stack) {
  if (!stack || stack.id >= 0) return [];
  const item = itemById(stack.id);
  if (!item) return [];
  const fams = enchantFamilies(item);
  if (!fams.length) return [];
  return ENCHANTS.filter((e) => e.applies.some((a) => fams.includes(a)));
}

/** Total armour points including Protection, capped like MC. */
export function protectionPoints(stack) {
  return stack.enchLevel('protection');
}

/**
 * Roll three offers for a stack. The power of the offers scales with the player's level
 * (and, like MC, is capped), and is deterministic for a given (item, level, slot) so you
 * cannot reroll by closing and reopening the table.
 */
export function rollOffers(stack, playerLevel, seedExtra = 0) {
  const pool = eligibleEnchants(stack);
  if (!pool.length) return [];
  const offers = [];
  for (let slot = 0; slot < 3; slot++) {
    const seed = hash32(`${stack.id}:${playerLevel}:${slot}:${seedExtra}`);
    const rng = mulberry(seed);
    // the third slot needs more levels, exactly like the real table
    const need = [1, 5, 10][slot];
    if (playerLevel < need) { offers.push(null); continue; }
    const ench = pool[(rng() * pool.length) | 0];
    const maxLevel = Math.max(1, Math.min(ench.max, 1 + Math.floor(playerLevel / 8)));
    const level = 1 + ((rng() * maxLevel) | 0);
    // cost is in XP levels, scaled by the slot and the enchantment level
    const cost = Math.min(playerLevel, need + level + ((rng() * 3) | 0));
    offers.push({ slot, key: ench.key, level, cost, ench });
  }
  // clear duplicate enchantments on the same item so the choice is meaningful
  const seen = new Set();
  return offers.map((o) => {
    if (!o) return null;
    if (seen.has(o.key)) return null;
    seen.add(o.key);
    return o;
  });
}

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h | 0;
}

function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** All enchantments on a stack as [enchantDef, level] pairs, for the tooltip. */
export function stackEnchants(stack) {
  if (!stack || !stack.ench) return [];
  return Object.keys(stack.ench)
    .map((k) => [ENCHANT_BY_KEY.get(k), stack.ench[k]])
    .filter(([e]) => !!e);
}

/** "锋利 III" style label. */
export function enchantLabel(key, level) {
  const e = ENCHANT_BY_KEY.get(key);
  const roman = ['', 'I', 'II', 'III', 'IV', 'V'][level] || String(level);
  return `${e ? e.cn : key} ${roman}`;
}
