// core/blocks.js — the block registry: ids, properties, atlas tile layout, drop rules.
//
// A block "variant" owns ATLAS_SLOTS consecutive 16x16 tiles in the atlas:
//   slot 0 = north (-Z), 1 = south (+Z), 2 = west (-X), 3 = east (+X),
//   slot 4 = top (+Y),   5 = bottom (-Y).
// So a solid cube with one texture just repeats the same tile 6 times; grass can
// give dirt on the sides/bottom and grass on top, logs get a ring texture, etc.

export const ATLAS_SLOTS = 6;
export const ATLAS_COLS = 32;            // tiles per row
export const ATLAS_ROWS = 32;            // tile rows  (32*32 = 1024 tiles >= 142 variants*6)
export const MAX_TILE_INDEX = ATLAS_COLS * ATLAS_ROWS - 1;

// ------------------------------------------------------------------ render kinds
export const R = {
  NONE: 0,        // not rendered (air)
  CUBE: 1,        // full opaque cube
  CUTOUT: 2,      // full cube, alpha-tested (leaves, glass frame, plants inside)
  WATER: 3,       // liquid surface handling, alpha blended
  PLANT: 4,       // X-shaped billboard (flowers, saplings, tall grass)
  TORCH: 5,       // small centered post
  CACTUS: 6,      // slightly inset cube
  BED: 7,         // low slab: a 1x1/2x9/16 box
  CROP: 8,        // like PLANT but the tile depends on the growth stage
  PORTAL: 9,      // flat plane in the portal's axis, swirled and semi-transparent
  FLAT: 10,       // thin plate lying on the floor (redstone wire, pressure plates)
};

// ------------------------------------------------------------------ texture kinds
export const T = {
  SOLID: 0,       // flat colour with grain
  NOISE: 1,       // per-pixel noise (stone, dirt, sand)
  GRASS_TOP: 2,
  GRASS_SIDE: 3,
  LOG_SIDE: 4,
  LOG_TOP: 5,
  PLANK: 6,
  COBBLE: 7,
  BRICK: 8,
  ORE: 9,
  LEAVES: 10,
  WATER: 11,
  LAVA: 12,
  GLASS: 13,
  PLANT: 14,
  METAL: 15,
  WOOL: 16,
  CRAFT_TOP: 17,
  CRAFT_SIDE: 18,
  FURNACE_FRONT: 19,
  FURNACE_SIDE: 20,
  FURNACE_TOP: 21,
  BOOKSHELF: 22,
  TNT_SIDE: 23,
  TNT_TOP: 24,
  PUMPKIN_FACE: 25,
  ICE: 26,
  SNOW: 27,
  GRAVEL: 28,
  SANDSTONE: 29,
  CLAY: 30,
  CHEST: 31,
  FLOWER: 32,
  SAPLING: 33,
  TORCH_TEX: 34,
  CACTUS_SIDE: 35,
  CACTUS_TOP: 36,
  BEDROCK: 37,
  CIRCUIT: 38,
  WOOL_WHITE: 39,
  WOOL_RED: 40,
  WOOL_BLUE: 41,
  WOOL_GREEN: 42,
  WOOL_YELLOW: 43,
  WOOL_BLACK: 44,
  GLASS_PANE: 45,
  OBSIDIAN: 46,
  NETHERRACK: 47,
  SOUL_SAND: 48,
  QUARTZ: 49,
  ANVIL: 50,
  SAPLING_OAK: 51,
  TALL_GRASS: 52,
  DEAD_BUSH: 53,
  LADDER: 54,
  PUMPKIN_SIDE: 55,
  PUMPKIN_TOP: 56,
  FURNACE_LIT: 57,
  FARMLAND: 58,
  FARMLAND_TOP: 59,
  WHEAT_0: 60,
  WHEAT_1: 61,
  WHEAT_2: 62,
  WHEAT_3: 63,
  BED_TOP: 64,
  BED_SIDE: 65,
  BED_HEAD: 66,
  BED_FOOT: 67,
  PORTAL: 68,
  ENCHANT_TOP: 69,
  ENCHANT_SIDE: 70,
  ENCHANT_BOTTOM: 71,
  END_STONE: 72,
  END_FRAME_TOP: 73,
  END_FRAME_SIDE: 74,
  END_PORTAL: 75,
  PURPUR: 76,
  BREW_TOP: 77,
  BREW_SIDE: 78,
  REDSTONE_BLOCK: 79,
  REDSTONE_ORE: 80,
  REDSTONE_WIRE: 81,
  REDSTONE_TORCH: 82,
  LEVER: 83,
  BUTTON: 84,
  PLATE: 85,
  LAMP_OFF: 86,
  LAMP_ON: 87,
  PISTON_TOP: 88,
  PISTON_SIDE: 89,
  PISTON_FACE: 90,
  PISTON_BACK: 91,
  PISTON_ARM: 92,
  PISTON_ARM_TOP: 93,
  HOPPER_TOP: 94,
  HOPPER_SIDE: 95,
  DISPENSER_TOP: 96,
  DISPENSER_SIDE: 97,
  DISPENSER_FRONT: 98,
  REPEATER: 99,
};

// ------------------------------------------------------------------ registry
export const BLOCKS = [];
export const TILE = new Uint16Array(128 * ATLAS_SLOTS); // block id + face -> atlas tile

/**
 * Items that blocks yield instead of themselves (negative ids live in core/items.js).
 * Kept separate because blocks.js cannot import items.js (items.js imports BLOCKS).
 */
export const BLOCK_DROPS = new Map();
export function setBlockDrop(blockKey, itemKey) { BLOCK_DROPS.set(blockKey, itemKey); }

function def(id, key, cn, opts = {}) {
  const b = {
    id, key, cn,
    render: opts.render ?? R.CUBE,
    opaque: opts.opaque ?? true,       // blocks light / hides neighbour faces
    solid: opts.solid ?? true,         // collides with the player
    liquid: opts.liquid ?? false,
    light: opts.light ?? 0,
    hardness: opts.hardness ?? 1.5,    // seconds of hand mining
    tool: opts.tool ?? null,           // preferred tool class
    tint: opts.tint ?? null,           // [r,g,b] multiplied in shader (grass/leaves/water)
    drop: opts.drop === undefined ? id : opts.drop,
    gravity: opts.gravity ?? false,
    replaceable: opts.replaceable ?? false,
    flammable: opts.flammable ?? false,
    // When true, tex[0] is the FRONT face and it rotates to the placing player's facing.
    directional: opts.directional ?? false,
    // six texture descriptors, index 0..5 = N,S,W,E,Top,Bottom
    tex: opts.tex,
  };
  if (!b.tex) {
    const c = opts.color ? T.SOLID : T.NOISE;
    const t = opts.color || [0.6, 0.6, 0.6];
    b.tex = [0, 1, 2, 3, 4, 5].map(() => ({ kind: c, color: t }));
  }
  BLOCKS[id] = b;
  return b;
}

export function blockByKey(key) {
  for (let i = 0; i < BLOCKS.length; i++) if (BLOCKS[i] && BLOCKS[i].key === key) return BLOCKS[i];
  return null;
}
export function idOf(key) { const b = blockByKey(key); return b ? b.id : 0; }

// Fast lookup tables used by the mesher / physics hot loops.
export const OPAQUE = new Uint8Array(256);
export const SOLID = new Uint8Array(256);
export const LIQUID = new Uint8Array(256);
export const LIGHT = new Uint8Array(256);
export const RENDER = new Uint8Array(256);
export const REPLACEABLE = new Uint8Array(256);

// ------------------------------------------------------------------ atlas tile layout
// Tile index = blockId * ATLAS_SLOTS + face, so the id space and the atlas grid are
// independent: a block can have any id below MAX_BLOCKS and still address its six tiles.
// (The atlas holds 1024 tiles = 170 blocks; grow ATLAS_ROWS to add more.)

// ------------------------------------------------------------------ block ids
// A block id is 7 bits (0..127) and the top bit of the byte is reserved, so the tile for
// (id, face) is simply id * ATLAS_SLOTS + face — the atlas and the id space stay
// independent and growing the block list only needs more atlas rows.
// Facing blocks (furnace / chest / pumpkin) store their orientation in the chunk's
// parallel `facing` byte array, so the block byte stays a plain id.
export const ID_MASK = 127;
export const MAX_BLOCKS = 128;
export function baseId(v) { return v & ID_MASK; }
export function stateOf(_v) { return 0; }
export function withState(id, _state) { return id & ID_MASK; }

// ------------------------------------------------------------------ block table
// ids 0..31 (5 bits) — kept to a curated, complete-feeling survival set.
def(0, 'air', '空气', { render: R.NONE, opaque: false, solid: false, hardness: 0, replaceable: true, drop: 0 });
def(1, 'stone', '石头', { hardness: 1.5, tool: 'pickaxe', drop: 4, color: [0.50, 0.50, 0.50], tex: [{ kind: T.NOISE, color: [0.50, 0.50, 0.50], scale: 1 }] });
def(2, 'grass', '草方块', { hardness: 0.6, tool: 'shovel', tint: [0.55, 0.85, 0.35], drop: 3, tex: [
  { kind: T.GRASS_SIDE }, { kind: T.GRASS_SIDE }, { kind: T.GRASS_SIDE }, { kind: T.GRASS_SIDE },
  { kind: T.GRASS_TOP }, { kind: T.NOISE, color: [0.55, 0.40, 0.28] },
] });
def(3, 'dirt', '泥土', { hardness: 0.5, tool: 'shovel', color: [0.55, 0.40, 0.28] });
def(4, 'cobblestone', '圆石', { hardness: 2.0, tool: 'pickaxe', tex: [{ kind: T.COBBLE }] });
def(5, 'planks', '木板', { hardness: 2.0, tool: 'axe', tex: [{ kind: T.PLANK, color: [0.65, 0.48, 0.26] }] });
def(6, 'log', '原木', { hardness: 2.0, tool: 'axe', tex: [
  { kind: T.LOG_SIDE }, { kind: T.LOG_SIDE }, { kind: T.LOG_SIDE }, { kind: T.LOG_SIDE },
  { kind: T.LOG_TOP }, { kind: T.LOG_TOP },
] });
def(7, 'leaves', '树叶', { render: R.CUTOUT, opaque: false, hardness: 0.2, tint: [0.35, 0.75, 0.28], tool: 'shears', tex: [{ kind: T.LEAVES }] });
def(8, 'sand', '沙子', { hardness: 0.5, tool: 'shovel', gravity: true, color: [0.86, 0.80, 0.58] });
def(9, 'water', '水', { render: R.WATER, opaque: false, solid: false, liquid: true, hardness: 100, drop: 0, tint: [0.25, 0.45, 0.95], replaceable: true, tex: [{ kind: T.WATER }] });
def(10, 'lava', '岩浆', { render: R.WATER, opaque: false, solid: false, liquid: true, light: 15, hardness: 100, drop: 0, replaceable: true, tex: [{ kind: T.LAVA }] });
def(11, 'bedrock', '基岩', { hardness: -1, drop: 11, tex: [{ kind: T.BEDROCK }] });
def(12, 'gravel', '砂砾', { hardness: 0.6, tool: 'shovel', gravity: true, tex: [{ kind: T.GRAVEL }] });
def(13, 'sandstone', '砂岩', { hardness: 0.8, tool: 'pickaxe', tex: [
  { kind: T.SANDSTONE, part: 'side' }, { kind: T.SANDSTONE, part: 'side' }, { kind: T.SANDSTONE, part: 'side' }, { kind: T.SANDSTONE, part: 'side' },
  { kind: T.SANDSTONE, part: 'top' }, { kind: T.SANDSTONE, part: 'bottom' },
] });
def(14, 'coal_ore', '煤矿石', { hardness: 3.0, tool: 'pickaxe', tex: [{ kind: T.ORE, ore: [0.10, 0.10, 0.10] }] });
def(15, 'iron_ore', '铁矿石', { hardness: 3.0, tool: 'pickaxe', tex: [{ kind: T.ORE, ore: [0.86, 0.72, 0.60] }] });
def(16, 'gold_ore', '金矿石', { hardness: 3.0, tool: 'pickaxe', tex: [{ kind: T.ORE, ore: [0.98, 0.85, 0.25] }] });
def(17, 'diamond_ore', '钻石矿石', { hardness: 3.0, tool: 'pickaxe', tex: [{ kind: T.ORE, ore: [0.35, 0.95, 0.93] }] });
def(18, 'glass', '玻璃', { render: R.CUTOUT, opaque: false, hardness: 0.3, drop: 0, tex: [{ kind: T.GLASS }] });
def(19, 'brick', '砖块', { hardness: 2.0, tool: 'pickaxe', tex: [{ kind: T.BRICK, color: [0.62, 0.36, 0.30] }] });
def(20, 'bookshelf', '书架', { hardness: 1.5, tool: 'axe', flammable: true, tex: [
  { kind: T.BOOKSHELF }, { kind: T.BOOKSHELF }, { kind: T.BOOKSHELF }, { kind: T.BOOKSHELF },
  { kind: T.PLANK, color: [0.65, 0.48, 0.26] }, { kind: T.PLANK, color: [0.65, 0.48, 0.26] },
] });
def(21, 'crafting_table', '工作台', { hardness: 2.5, tool: 'axe', flammable: true, tex: [
  { kind: T.CRAFT_SIDE }, { kind: T.CRAFT_SIDE }, { kind: T.CRAFT_SIDE }, { kind: T.CRAFT_SIDE },
  { kind: T.CRAFT_TOP }, { kind: T.PLANK, color: [0.65, 0.48, 0.26] },
] });
// tex[0] is the FRONT face for directional blocks; the mesher rotates it to the facing
// the player had when placing. Face order is N, S, W, E, Top, Bottom.
def(22, 'furnace', '熔炉', { directional: true, hardness: 3.5, tool: 'pickaxe', tex: [
  { kind: T.FURNACE_FRONT }, { kind: T.FURNACE_SIDE }, { kind: T.FURNACE_SIDE }, { kind: T.FURNACE_SIDE },
  { kind: T.FURNACE_TOP }, { kind: T.FURNACE_TOP },
] });
def(23, 'tnt', 'TNT', { hardness: 0, flammable: true, tex: [
  { kind: T.TNT_SIDE }, { kind: T.TNT_SIDE }, { kind: T.TNT_SIDE }, { kind: T.TNT_SIDE },
  { kind: T.TNT_TOP }, { kind: T.TNT_TOP },
] });
def(24, 'pumpkin', '南瓜', { directional: true, hardness: 1.0, tool: 'axe', tex: [
  { kind: T.PUMPKIN_FACE }, { kind: T.PUMPKIN_SIDE }, { kind: T.PUMPKIN_SIDE }, { kind: T.PUMPKIN_SIDE },
  { kind: T.PUMPKIN_TOP }, { kind: T.PUMPKIN_TOP },
] });
def(25, 'snow', '雪块', { hardness: 0.6, tool: 'shovel', tex: [{ kind: T.SNOW }] });
def(26, 'ice', '冰', { render: R.CUTOUT, opaque: false, hardness: 0.5, tool: 'pickaxe', tex: [{ kind: T.ICE }] });
def(27, 'clay', '黏土', { hardness: 0.6, tool: 'shovel', tex: [{ kind: T.CLAY }] });
def(28, 'glowstone', '荧石', { hardness: 0.3, light: 15, tex: [{ kind: T.NOISE, color: [0.95, 0.85, 0.55], glow: true }] });
def(29, 'chest', '箱子', { directional: true, hardness: 2.5, tool: 'axe', flammable: true, tex: [
  { kind: T.CHEST }, { kind: T.CHEST }, { kind: T.CHEST }, { kind: T.CHEST },
  { kind: T.CHEST, top: true }, { kind: T.CHEST },
] });
def(30, 'torch', '火把', { render: R.TORCH, opaque: false, solid: false, light: 14, hardness: 0, tex: [{ kind: T.TORCH_TEX }] });
def(31, 'flower', '花', { render: R.PLANT, opaque: false, solid: false, hardness: 0, drop: 31, tex: [{ kind: T.FLOWER }] });

// ---------------------------------------------------------------- mineral blocks
def(32, 'coal_block', '煤炭块', { hardness: 5, tool: 'pickaxe', tex: [{ kind: T.NOISE, color: [0.14, 0.14, 0.14] }] });
def(33, 'iron_block', '铁块', { hardness: 5, tool: 'pickaxe', tex: [{ kind: T.METAL, color: [0.88, 0.88, 0.88] }] });
def(34, 'gold_block', '金块', { hardness: 3, tool: 'pickaxe', tex: [{ kind: T.METAL, color: [0.98, 0.85, 0.28] }] });
def(35, 'diamond_block', '钻石块', { hardness: 5, tool: 'pickaxe', tex: [{ kind: T.METAL, color: [0.42, 0.95, 0.92] }] });

// ---------------------------------------------------------------- decorative family
def(36, 'wool_white', '白色羊毛', { hardness: 0.8, tool: 'shears', tex: [{ kind: T.WOOL_WHITE }] });
def(37, 'wool_red', '红色羊毛', { hardness: 0.8, tool: 'shears', tex: [{ kind: T.WOOL_RED }] });
def(38, 'wool_blue', '蓝色羊毛', { hardness: 0.8, tool: 'shears', tex: [{ kind: T.WOOL_BLUE }] });
def(39, 'wool_green', '绿色羊毛', { hardness: 0.8, tool: 'shears', tex: [{ kind: T.WOOL_GREEN }] });
def(40, 'wool_yellow', '黄色羊毛', { hardness: 0.8, tool: 'shears', tex: [{ kind: T.WOOL_YELLOW }] });
def(41, 'wool_black', '黑色羊毛', { hardness: 0.8, tool: 'shears', tex: [{ kind: T.WOOL_BLACK }] });
def(42, 'glass_pane', '玻璃板', { render: R.CUTOUT, opaque: false, hardness: 0.3, drop: 0, tex: [{ kind: T.GLASS_PANE }] });
def(43, 'obsidian', '黑曜石', { hardness: 12, tool: 'pickaxe', tex: [{ kind: T.OBSIDIAN }] });
def(44, 'netherrack', '下界岩', { hardness: 0.4, tool: 'pickaxe', tex: [{ kind: T.NETHERRACK }] });
def(45, 'soul_sand', '灵魂沙', { hardness: 0.5, tool: 'shovel', tex: [{ kind: T.SOUL_SAND }] });
def(46, 'quartz_block', '石英块', { hardness: 0.8, tool: 'pickaxe', tex: [{ kind: T.QUARTZ }] });
def(47, 'anvil', '铁砧', { directional: true, hardness: 5, tool: 'pickaxe', tex: [
  { kind: T.ANVIL }, { kind: T.ANVIL }, { kind: T.ANVIL }, { kind: T.ANVIL },
  { kind: T.METAL, color: [0.30, 0.30, 0.32] }, { kind: T.METAL, color: [0.30, 0.30, 0.32] },
] });

// ---------------------------------------------------------------- vegetation
def(48, 'sapling', '橡树树苗', { render: R.PLANT, opaque: false, solid: false, hardness: 0, tex: [{ kind: T.SAPLING_OAK }] });
def(49, 'tall_grass', '草', { render: R.PLANT, opaque: false, solid: false, hardness: 0, drop: 0, tex: [{ kind: T.TALL_GRASS }] });
def(50, 'dead_bush', '枯死的灌木', { render: R.PLANT, opaque: false, solid: false, hardness: 0, tex: [{ kind: T.DEAD_BUSH }] });
def(51, 'cactus', '仙人掌', { hardness: 0.4, tex: [
  { kind: T.CACTUS_SIDE }, { kind: T.CACTUS_SIDE }, { kind: T.CACTUS_SIDE }, { kind: T.CACTUS_SIDE },
  { kind: T.CACTUS_TOP }, { kind: T.CACTUS_TOP },
] });
def(52, 'ladder', '梯子', { render: R.PLANT, opaque: false, solid: false, hardness: 0.4, tex: [{ kind: T.LADDER }] });
def(53, 'pumpkin', '南瓜', { directional: true, hardness: 1.0, tool: 'axe', tex: [
  { kind: T.PUMPKIN_FACE }, { kind: T.PUMPKIN_SIDE }, { kind: T.PUMPKIN_SIDE }, { kind: T.PUMPKIN_SIDE },
  { kind: T.PUMPKIN_TOP }, { kind: T.PUMPKIN_TOP },
] });

// ---------------------------------------------------------------- crafting stations
// tex[0] is the FRONT face for these; the mesher rotates it to the stored facing.
def(54, 'furnace_lit', '燃烧的熔炉', { directional: true, hardness: 3.5, tool: 'pickaxe', light: 12, drop: 22, tex: [
  { kind: T.FURNACE_LIT }, { kind: T.FURNACE_SIDE }, { kind: T.FURNACE_SIDE }, { kind: T.FURNACE_SIDE },
  { kind: T.FURNACE_TOP }, { kind: T.FURNACE_TOP },
] });

// ---------------------------------------------------------------- farming + sleep
def(55, 'farmland', '耕地', { hardness: 0.6, tool: 'shovel', drop: 3, tex: [
  { kind: T.FARMLAND }, { kind: T.FARMLAND }, { kind: T.FARMLAND }, { kind: T.FARMLAND },
  { kind: T.FARMLAND_TOP }, { kind: T.DIRT },
] });
// Wheat carries its growth stage in the chunk's facing byte (0..3).
def(56, 'wheat', '小麦', { render: R.CROP, opaque: false, solid: false, hardness: 0, drop: 0, tex: [
  { kind: T.WHEAT_0 }, { kind: T.WHEAT_1 }, { kind: T.WHEAT_2 }, { kind: T.WHEAT_3 },
] });
def(57, 'bed', '床', { render: R.BED, opaque: false, solid: false, directional: true, hardness: 0.2, tex: [
  { kind: T.BED_FOOT }, { kind: T.BED_HEAD }, { kind: T.BED_SIDE }, { kind: T.BED_SIDE },
  { kind: T.BED_TOP }, { kind: T.BED_TOP },
] });

// ---------------------------------------------------------------- nether
// The portal block is not placeable and not solid: you walk into it.
def(58, 'nether_portal', '下界传送门', {
  render: R.PORTAL, opaque: false, solid: false, hardness: -1, drop: 0, light: 11,
  replaceable: false, tex: [{ kind: T.PORTAL }],
});

// ---------------------------------------------------------------- enchanting
def(59, 'enchanting_table', '附魔台', { directional: true, hardness: 3.0, tool: 'pickaxe', light: 7, tex: [
  { kind: T.ENCHANT_SIDE }, { kind: T.ENCHANT_SIDE }, { kind: T.ENCHANT_SIDE }, { kind: T.ENCHANT_SIDE },
  { kind: T.ENCHANT_TOP }, { kind: T.ENCHANT_BOTTOM },
] });

// ---------------------------------------------------------------- the End
def(60, 'end_stone', '末地石', { hardness: 3.0, tool: 'pickaxe', tex: [
  { kind: T.END_STONE }, { kind: T.END_STONE }, { kind: T.END_STONE }, { kind: T.END_STONE },
  { kind: T.END_STONE }, { kind: T.END_STONE },
] });
def(61, 'end_portal_frame', '末地传送门框架', {
  hardness: -1, drop: 0, light: 1, tex: [
    { kind: T.END_FRAME_TOP }, { kind: T.END_FRAME_SIDE }, { kind: T.END_FRAME_SIDE }, { kind: T.END_FRAME_SIDE },
    { kind: T.END_FRAME_TOP }, { kind: T.END_FRAME_SIDE },
  ],
});
def(62, 'end_portal', '末地传送门', {
  render: R.PORTAL, opaque: false, solid: false, hardness: -1, drop: 0, light: 15,
  tex: [{ kind: T.END_PORTAL }],
});
def(63, 'purpur', '紫珀块', { hardness: 1.5, tool: 'pickaxe', tex: [
  { kind: T.PURPUR }, { kind: T.PURPUR }, { kind: T.PURPUR }, { kind: T.PURPUR },
  { kind: T.PURPUR }, { kind: T.PURPUR },
] });

// ---------------------------------------------------------------- brewing
def(64, 'brewing_stand', '酿造台', { hardness: 0.5, tool: 'pickaxe', light: 1, tex: [
  { kind: T.BREW_SIDE }, { kind: T.BREW_SIDE }, { kind: T.BREW_SIDE }, { kind: T.BREW_SIDE },
  { kind: T.BREW_TOP }, { kind: T.BREW_SIDE },
] });

// ---------------------------------------------------------------- redstone
// `power` blocks are sources that emit a fixed signal strength; `wire` carries it.
def(65, 'redstone_block', '红石块', { hardness: 1.5, tool: 'pickaxe', power: 15, tex: [
  { kind: T.REDSTONE_BLOCK }, { kind: T.REDSTONE_BLOCK }, { kind: T.REDSTONE_BLOCK }, { kind: T.REDSTONE_BLOCK },
  { kind: T.REDSTONE_BLOCK }, { kind: T.REDSTONE_BLOCK },
] });
def(66, 'redstone_ore', '红石矿石', { hardness: 3.0, tool: 'pickaxe', drop: 67, tex: [
  { kind: T.REDSTONE_ORE }, { kind: T.REDSTONE_ORE }, { kind: T.REDSTONE_ORE }, { kind: T.REDSTONE_ORE },
  { kind: T.REDSTONE_ORE }, { kind: T.REDSTONE_ORE },
] });
// The wire's strength lives in the chunk's facing byte (0..15).
def(67, 'redstone_wire', '红石线', {
  render: R.FLAT, opaque: false, solid: false, hardness: 0, drop: 0, wire: true,
  tex: [{ kind: T.REDSTONE_WIRE }],
});
def(68, 'redstone_torch', '红石火把', {
  render: R.TORCH, opaque: false, solid: false, hardness: 0, light: 7, power: 15, torch: true,
  tex: [{ kind: T.REDSTONE_TORCH }],
});
def(69, 'lever', '拉杆', {
  render: R.FLAT, opaque: false, solid: false, hardness: 0.5, power: 15, lever: true,
  tex: [{ kind: T.LEVER }],
});
def(70, 'stone_button', '石按钮', {
  render: R.FLAT, opaque: false, solid: false, hardness: 0.5, power: 15, button: true,
  tex: [{ kind: T.BUTTON }],
});
def(71, 'pressure_plate', '压力板', {
  render: R.FLAT, opaque: false, solid: false, hardness: 0.5, power: 15, plate: true,
  tex: [{ kind: T.PLATE }],
});
// The lamp lights when powered; its lit form is a separate id so lighting can use it.
def(72, 'redstone_lamp', '红石灯', { hardness: 0.3, tex: [
  { kind: T.LAMP_OFF }, { kind: T.LAMP_OFF }, { kind: T.LAMP_OFF }, { kind: T.LAMP_OFF },
  { kind: T.LAMP_OFF }, { kind: T.LAMP_OFF },
] });
def(73, 'redstone_lamp_lit', '红石灯（亮）', { hardness: 0.3, light: 15, drop: 72, tex: [
  { kind: T.LAMP_ON }, { kind: T.LAMP_ON }, { kind: T.LAMP_ON }, { kind: T.LAMP_ON },
  { kind: T.LAMP_ON }, { kind: T.LAMP_ON },
] });
// Pistons: `facing` holds the push direction (0=+X,1=-X,2=+Z,3=-Z,4=+Y,5=-Y).
def(74, 'piston', '活塞', { directional: true, hardness: 1.5, piston: true, tex: [
  { kind: T.PISTON_FACE }, { kind: T.PISTON_BACK }, { kind: T.PISTON_SIDE }, { kind: T.PISTON_SIDE },
  { kind: T.PISTON_TOP }, { kind: T.PISTON_TOP },
] });
def(75, 'piston_extended', '活塞（伸出）', { directional: true, hardness: 1.5, piston: true, drop: 74, tex: [
  { kind: T.PISTON_FACE }, { kind: T.PISTON_BACK }, { kind: T.PISTON_ARM }, { kind: T.PISTON_ARM },
  { kind: T.PISTON_TOP }, { kind: T.PISTON_TOP },
] });
def(76, 'piston_head', '活塞臂', {
  hardness: 1.5, drop: 0, opaque: false, tex: [
  { kind: T.PISTON_ARM }, { kind: T.PISTON_ARM }, { kind: T.PISTON_ARM }, { kind: T.PISTON_ARM },
  { kind: T.PISTON_ARM_TOP }, { kind: T.PISTON_ARM_TOP },
] });

// ---------------------------------------------------------------- item logistics
// The hopper is `directional` so its spout points where it was placed; the facing byte
// also carries "disabled" via the redstone power map, so a powered hopper stops moving.
def(77, 'hopper', '漏斗', { directional: true, hardness: 3.0, tool: 'pickaxe', container: 'hopper', tex: [
  { kind: T.HOPPER_SIDE }, { kind: T.HOPPER_SIDE }, { kind: T.HOPPER_SIDE }, { kind: T.HOPPER_SIDE },
  { kind: T.HOPPER_TOP }, { kind: T.HOPPER_SIDE },
] });
def(78, 'dispenser', '发射器', { directional: true, hardness: 3.5, tool: 'pickaxe', container: 'dispenser', tex: [
  { kind: T.DISPENSER_FRONT }, { kind: T.DISPENSER_SIDE }, { kind: T.DISPENSER_SIDE }, { kind: T.DISPENSER_SIDE },
  { kind: T.DISPENSER_TOP }, { kind: T.DISPENSER_TOP },
] });
// The repeater delays a signal by 0.1s..0.4s depending on its facing byte (0..3 delay).
def(79, 'repeater', '红石中继器', {
  render: R.FLAT, opaque: false, solid: false, hardness: 0, repeater: true,
  tex: [{ kind: T.REPEATER }],
});

// ------------------------------------------------------------------ derived tables
export function finalizeBlocks() {
  for (let i = 0; i < MAX_BLOCKS; i++) {
    OPAQUE[i] = 0; SOLID[i] = 0; LIQUID[i] = 0; LIGHT[i] = 0; RENDER[i] = R.NONE; REPLACEABLE[i] = 0;
  }
  TILE.fill(0);
  for (let i = 0; i < MAX_BLOCKS; i++) {
    const b = BLOCKS[i];
    if (!b) continue;
    OPAQUE[i] = b.opaque ? 1 : 0;
    SOLID[i] = b.solid ? 1 : 0;
    LIQUID[i] = b.liquid ? 1 : 0;
    LIGHT[i] = b.light;
    RENDER[i] = b.render;
    REPLACEABLE[i] = b.replaceable ? 1 : 0;
    // assign the six atlas tiles for this block id
    for (let f = 0; f < ATLAS_SLOTS; f++) {
      TILE[i * ATLAS_SLOTS + f] = (i * ATLAS_SLOTS + f) % (MAX_TILE_INDEX + 1);
    }
  }
  // Air never renders.
  RENDER[0] = R.NONE;
}

/** The item list shown in the creative inventory, roughly grouped like Minecraft's. */
export const CREATIVE_ORDER = [
  // building
  1, 4, 5, 6, 7, 2, 3, 8, 13, 12, 27, 19, 18, 42, 25, 26, 20, 21, 22, 29, 47, 53, 24, 23, 28,
  // decoration
  30, 31, 48, 49, 50, 51, 52, 36, 37, 38, 39, 40, 41, 32, 33, 34, 35, 46, 43, 44, 45,
  // nature / liquids
  14, 15, 16, 17, 11, 9, 10,
];

// ------------------------------------------------------------------ tiny item model
/**
 * A stack of anything: blocks use ids 0..127, items use negative ids (see core/items.js).
 * Tools carry a remaining-durability counter.
 */
export class ItemStack {
  constructor(id = 0, count = 0, durability = null, ench = null) {
    this.id = id; this.count = count;
    this.durability = durability;
    /**
     * Enchantment map: { key: level } for up to a few enchantments. Kept as a plain
     * object so it serialises into the save file without extra machinery.
     */
    this.ench = ench || null;
  }
  get empty() { return this.id === 0 || this.count <= 0; }
  get isItem() { return this.id < 0; }
  get name() { return stackName(this.id); }
  clone() { return new ItemStack(this.id, this.count, this.durability, this.ench ? { ...this.ench } : null); }
  maxStack() { return stackLimit(this.id); }

  /** Enchantment level for a key, 0 when absent. */
  enchLevel(key) { return this.ench && this.ench[key] ? this.ench[key] : 0; }

  addEnchant(key, level) {
    if (!this.ench) this.ench = {};
    this.ench[key] = Math.max(this.ench[key] || 0, level);
    return this;
  }

  get enchanted() { return !!(this.ench && Object.keys(this.ench).length); }
}

// Late-bound helpers so blocks.js does not need to import items.js at module scope
// (items.js already imports BLOCKS, so a direct import would be circular).
let _stackName = (id) => {
  const b = BLOCKS[id];
  return b ? b.cn : '空';
};
let _stackLimit = () => 64;
export function bindItemHelpers(nameFn, limitFn) {
  _stackName = nameFn;
  _stackLimit = limitFn;
}
export function stackName(id) { return _stackName(id); }
export function stackLimit(id) { return _stackLimit(id); }
