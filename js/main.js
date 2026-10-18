// main.js — bootstrap. Keeps all failure reporting on screen instead of the console.
import { Game } from './game/game.js';
import { finalizeBlocks, bindItemHelpers, BLOCKS, setBlockDrop } from './core/blocks.js';
import { stackName, stackLimit, resolveIds } from './core/items.js';

function fatal(err) {
  // Ignore non-fatal platform noise (pointer lock is unavailable in headless
  // browsers and in some embedded webviews; the game runs fine without it).
  const text = (err && (err.name || '') + ' ' + (err.message || String(err))) || '';
  if (/pointer ?lock/i.test(text) || /WrongDocumentError/i.test(text) || /user gesture/i.test(text)) {
    console.warn('non-fatal:', text);
    return;
  }
  const box = document.getElementById('fatal');
  const el = document.getElementById('fatal-text');
  if (box && el) {
    box.classList.remove('hidden');
    el.textContent = (err && (err.stack || err.message)) || String(err);
  }
  console.error(err);
}

window.addEventListener('error', (e) => fatal(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fatal(e.reason));

function boot() {
  try {
    finalizeBlocks();
    // wire the block side of the inventory to the item registry, then resolve smelting
    bindItemHelpers(stackName, stackLimit);
    resolveIds();
    // ore blocks yield materials rather than themselves
    setBlockDrop('coal_ore', 'coal');
    setBlockDrop('iron_ore', 'iron_ingot');
    setBlockDrop('gold_ore', 'gold_ingot');
    setBlockDrop('diamond_ore', 'diamond');
    setBlockDrop('clay', 'clay_ball');
    setBlockDrop('gravel', 'flint');
    // seeds come from grass; wheat comes from harvesting a ripe crop
    setBlockDrop('tall_grass', 'seeds');
    setBlockDrop('wheat', 'wheat');
    // redstone ore yields dust, like Minecraft
    setBlockDrop('redstone_ore', 'redstone_dust');
    const canvas = document.getElementById('game');
    // the Game constructor publishes itself as window.__MINEWEB__ for tooling
    const game = new Game(canvas);
    game.start();
  } catch (err) {
    fatal(err);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
