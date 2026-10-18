// core/trades.js — villager trades.
//
// Each villager rolls a small, deterministic set of offers from its profession's table
// when it is first created, so the same villager always offers the same deals. An offer
// is `{ give: {id, count}, get: {id, count}, uses, maxUses }` where `give` is what the
// player hands over and `get` is what the villager hands back.
//
// Ids are resolved lazily through `resolveIds()` so this module never has to import the
// item registry at module scope.

const PROFESSIONS = [
  { key: 'farmer', cn: '农民', color: [0.55, 0.70, 0.30] },
  { key: 'smith', cn: '铁匠', color: [0.35, 0.35, 0.40] },
  { key: 'librarian', cn: '图书管理员', color: [0.85, 0.85, 0.80] },
  { key: 'butcher', cn: '屠夫', color: [0.80, 0.45, 0.45] },
];

/** Trade tables. `give` is paid by the player, `get` is received. */
const TABLES = {
  farmer: [
    { give: { key: 'wheat', count: 18 }, get: { key: 'emerald', count: 1 }, max: 12 },
    { give: { key: 'apple', count: 6 }, get: { key: 'emerald', count: 1 }, max: 8 },
    { give: { key: 'seeds', count: 24 }, get: { key: 'emerald', count: 1 }, max: 8 },
    { give: { key: 'emerald', count: 1 }, get: { key: 'bread', count: 6 }, max: 12 },
  ],
  smith: [
    { give: { key: 'coal', count: 16 }, get: { key: 'emerald', count: 1 }, max: 12 },
    { give: { key: 'iron_ingot', count: 4 }, get: { key: 'emerald', count: 1 }, max: 12 },
    { give: { key: 'emerald', count: 3 }, get: { key: 'iron_pickaxe', count: 1 }, max: 3 },
    { give: { key: 'emerald', count: 4 }, get: { key: 'iron_chestplate', count: 1 }, max: 3 },
  ],
  librarian: [
    { give: { key: 'paper', count: 24 }, get: { key: 'emerald', count: 1 }, max: 12 },
    { give: { key: 'book', count: 3 }, get: { key: 'emerald', count: 1 }, max: 8 },
    { give: { key: 'emerald', count: 2 }, get: { key: 'book', count: 4 }, max: 6 },
    { give: { key: 'emerald', count: 5 }, get: { key: 'diamond', count: 1 }, max: 2 },
  ],
  butcher: [
    { give: { key: 'porkchop', count: 8 }, get: { key: 'emerald', count: 1 }, max: 10 },
    { give: { key: 'emerald', count: 1 }, get: { key: 'cooked_porkchop', count: 4 }, max: 10 },
    { give: { key: 'emerald', count: 2 }, get: { key: 'iron_sword', count: 1 }, max: 3 },
  ],
};

export { PROFESSIONS };

let resolveId = (key) => 0;
export function bindTradeResolver(fn) { resolveId = fn; }

function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h | 0;
}

/** Roll a deterministic profession + offer list for a villager seed. */
export function rollVillager(seed) {
  const rng = mulberry(hash32('villager:' + seed));
  const prof = PROFESSIONS[(rng() * PROFESSIONS.length) | 0];
  const table = TABLES[prof.key];
  // pick 3 of the 4 offers (or fewer if the table is short)
  const pool = table.slice();
  const offers = [];
  const n = Math.min(3, pool.length);
  for (let i = 0; i < n; i++) {
    const pick = (rng() * pool.length) | 0;
    const t = pool.splice(pick, 1)[0];
    // a small price jitter so two farmers are not identical
    const jitter = rng() < 0.35 ? 1 : 0;
    offers.push({
      give: { key: t.give.key, count: t.give.count + jitter },
      get: { key: t.get.key, count: t.get.count },
      uses: 0, max: t.max,
    });
  }
  return { profession: prof, offers };
}

/** Resolve the keys of one offer into ids, once the registry is ready. */
export function resolveOffer(offer) {
  return {
    ...offer,
    giveId: resolveId(offer.give.key),
    getId: resolveId(offer.get.key),
  };
}

/** A readable one-line summary, for tooltips and the trade UI. */
export function tradeLabel(offer, nameOf) {
  const n = (key, id) => (nameOf ? nameOf(key, id) : key);
  return `${n(offer.give.key, offer.giveId)} ×${offer.give.count} → ${n(offer.get.key, offer.getId)} ×${offer.get.count}`;
}

/** Roll offers for every profession, used by the self-check. */
export function allProfessionTables() { return Object.keys(TABLES); }
