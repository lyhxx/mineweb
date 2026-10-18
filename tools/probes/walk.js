// probe: hold W and watch the player move. Run via tools/quick.mjs.
new Promise((resolve) => {
  const g = window.__MINEWEB__;
  g.uiMode = 'playing';
  const p = g.player;
  p.mode = 'survival';
  p.flying = false;
  const start = [p.x, p.y, p.z];
  g.input.keys.add('KeyW');
  const samples = [];
  let n = 0;
  const iv = setInterval(() => {
    samples.push({
      pos: [Number(p.x.toFixed(2)), Number(p.y.toFixed(2)), Number(p.z.toFixed(2))],
      onGround: p.onGround,
      speed: Number(Math.hypot(p.vx, p.vz).toFixed(2)),
      mode: g.uiMode,
    });
    if (++n >= 12) {
      clearInterval(iv);
      g.input.keys.delete('KeyW');
      resolve({
        start,
        samples,
        moved: Number(Math.hypot(p.x - start[0], p.z - start[2]).toFixed(2)),
        forwardFlag: g.input.movement().forward,
      });
    }
  }, 250);
});
