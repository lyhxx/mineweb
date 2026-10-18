// core/potions.js
//
// Brewing and status effects.
//
// Potions are ordinary items whose key encodes the effect and the level, so a potion is
// just a stack: `potion_healing` is `healing` I, `potion_healing_2` is `healing` II. That
// means the inventory, save format and HUD need no changes at all.
//
// A brewing stand holds one ingredient plus up to three bottles; when the ingredient is
// consumed each bottle advances one step along the recipe graph.

/** effect key -> how it behaves. `instant` effects apply once and are consumed. */
export const EFFECTS = {
  healing: { cn: '治疗', instant: true, bad: false, desc: (l) => `瞬间恢复 ${l === 2 ? 8 : 4} 点生命` },
  regeneration: { cn: '生命恢复', instant: false, bad: false, desc: (l) => `${l === 2 ? 25 : 50} 秒内持续回血` },
  strength: { cn: '力量', instant: false, bad: false, desc: (l) => `${l === 2 ? 80 : 180} 秒内近战伤害 +3` },
  swiftness: { cn: '迅捷', instant: false, bad: false, desc: (l) => `${l === 2 ? 80 : 180} 秒内移动速度 +20%` },
  fire_resistance: { cn: '抗火', instant: false, bad: false, desc: () => '180 秒内免疫火焰与岩浆伤害' },
  night_vision: { cn: '夜视', instant: false, bad: false, desc: () => '180 秒内大幅提升视野亮度' },
  water_breathing: { cn: '水下呼吸', instant: false, bad: false, desc: () => '180 秒内不会溺水' },
  poison: { cn: '剧毒', instant: false, bad: true, desc: (l) => `${l === 2 ? 20 : 45} 秒内持续掉血（不会致死）` },
  weakness: { cn: '虚弱', instant: false, bad: true, desc: () => '90 秒内近战伤害 -3' },
  slowness: { cn: '缓慢', instant: false, bad: true, desc: () => '90 秒内移动速度 -15%' },
};

/** Durations in seconds, keyed by effect then level. */
export const DURATION = {
  regeneration: { 1: 50, 2: 25 },
  strength: { 1: 180, 2: 80 },
  swiftness: { 1: 180, 2: 80 },
  fire_resistance: { 1: 180, 2: 180 },
  night_vision: { 1: 180, 2: 180 },
  water_breathing: { 1: 180, 2: 180 },
  poison: { 1: 45, 2: 20 },
  weakness: { 1: 90, 2: 90 },
  slowness: { 1: 90, 2: 90 },
};

/** Parse a potion item key into { effect, level } or null. */
export function parsePotionKey(key) {
  if (!key || !key.startsWith('potion_')) return null;
  const rest = key.slice('potion_'.length);
  const m = /^(.+?)(?:_(\d))?$/.exec(rest);
  if (!m) return null;
  const effect = m[1];
  if (!EFFECTS[effect]) return null;
  return { effect, level: m[2] ? Number(m[2]) : 1 };
}

/** The item key for an effect at a level. */
export function potionKey(effect, level = 1) {
  return level > 1 ? `potion_${effect}_${level}` : `potion_${effect}`;
}

/**
 * Brewing recipes. `from` is the bottle's current state (null = water bottle or an empty
 * slot), `with` is the ingredient key, `to` is the result key. This mirrors Minecraft's
 * chain: water -> awkward -> (effect) -> (extended / level II).
 */
export const BREW_RECIPES = [
  // the base step
  { from: 'water_bottle', with: 'nether_wart', to: 'awkward_potion' },
  // effect steps from awkward
  { from: 'awkward_potion', with: 'glistering_melon', to: 'potion_healing' },
  { from: 'awkward_potion', with: 'ghast_tear', to: 'potion_regeneration' },
  { from: 'awkward_potion', with: 'blaze_powder', to: 'potion_strength' },
  { from: 'awkward_potion', with: 'sugar', to: 'potion_swiftness' },
  { from: 'awkward_potion', with: 'magma_cream', to: 'potion_fire_resistance' },
  { from: 'awkward_potion', with: 'golden_carrot', to: 'potion_night_vision' },
  { from: 'awkward_potion', with: 'pufferfish', to: 'potion_water_breathing' },
  { from: 'awkward_potion', with: 'spider_eye', to: 'potion_poison' },
  // corrupting a potion turns it into its opposite
  { from: 'potion_healing', with: 'fermented_spider_eye', to: 'potion_weakness' },
  { from: 'potion_swiftness', with: 'fermented_spider_eye', to: 'potion_slowness' },
  { from: 'potion_poison', with: 'fermented_spider_eye', to: 'potion_weakness' },
  // upgrades
  { from: 'potion_healing', with: 'glowstone_dust', to: 'potion_healing_2' },
  { from: 'potion_regeneration', with: 'glowstone_dust', to: 'potion_regeneration_2' },
  { from: 'potion_strength', with: 'glowstone_dust', to: 'potion_strength_2' },
  { from: 'potion_swiftness', with: 'glowstone_dust', to: 'potion_swiftness_2' },
  { from: 'potion_poison', with: 'glowstone_dust', to: 'potion_poison_2' },
];

/** Index for fast lookup: `${from}|${with}` -> to. */
const BREW_INDEX = new Map(BREW_RECIPES.map((r) => [`${r.from}|${r.with}`, r.to]));

/** Every item key that can be placed in a brewing stand's ingredient slot. */
export const BREW_INGREDIENTS = new Set(BREW_RECIPES.map((r) => r.with));

/** What brewing `with` on a bottle currently holding `from` produces, or null. */
export function brewResult(fromKey, withKey) {
  if (!withKey) return null;
  const from = fromKey || 'empty_bottle';
  return BREW_INDEX.get(`${from}|${withKey}`) || null;
}

/** Every recipe that applies to a bottle state (used by the recipe book / audit). */
export function recipesFor(fromKey) {
  const from = fromKey || 'empty_bottle';
  return BREW_RECIPES.filter((r) => r.from === from);
}

/**
 * Live effect tracker for the player. Small on purpose: a Map of key -> {level, time}
 * plus a helper that recomputes nothing until asked.
 */
export class EffectTracker {
  constructor() { this.active = new Map(); }

  apply(key, level, seconds) {
    if (!EFFECTS[key]) return false;
    const cur = this.active.get(key);
    // a stronger or longer dose wins, like Minecraft
    if (cur && cur.level > level) return false;
    this.active.set(key, { level, time: seconds, total: seconds });
    return true;
  }

  clear() { this.active.clear(); }

  level(key) { const e = this.active.get(key); return e ? e.level : 0; }
  has(key) { return this.active.has(key); }

  /** Advance timers; returns the keys that expired this tick. */
  tick(dt) {
    const expired = [];
    for (const [key, e] of this.active) {
      e.time -= dt;
      if (e.time <= 0) { this.active.delete(key); expired.push(key); }
    }
    return expired;
  }

  /** Serialisable form for the save file. */
  serialize() {
    const out = {};
    for (const [key, e] of this.active) out[key] = [e.level, Number(e.time.toFixed(1))];
    return out;
  }

  deserialize(data) {
    this.active.clear();
    if (!data) return;
    for (const key of Object.keys(data)) {
      const [level, time] = data[key];
      if (EFFECTS[key] && time > 0) this.active.set(key, { level, time, total: DURATION[key] ? (DURATION[key][level] || time) : time });
    }
  }

  /** Total melee damage bonus from Strength / Weakness. */
  meleeBonus() {
    return this.level('strength') * 3 - this.level('weakness') * 3;
  }

  /** Movement speed multiplier from Swiftness / Slowness. */
  speedMultiplier() {
    let m = 1;
    if (this.has('swiftness')) m += 0.2;
    if (this.has('slowness')) m -= 0.15;
    return Math.max(0.4, m);
  }

  /** Regeneration / poison damage per second, or 0. */
  healthPerSecond() {
    let hps = 0;
    if (this.has('regeneration')) hps += 1;
    if (this.has('poison')) hps -= 0.5;
    return hps;
  }
}
