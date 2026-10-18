// probe: sample world-creation progress over time to see whether it advances or stalls.
new Promise((resolve) => {
  const g = window.__MINEWEB__;
  const samples = [];
  let n = 0;
  const iv = setInterval(() => {
    const w = g.world;
    const chunks = w ? [...w.chunks.values()] : [];
    samples.push({
      t: n,
      uiMode: g.uiMode,
      chunks: chunks.length,
      decorated: chunks.filter((c) => c.decorated).length,
      lit: chunks.filter((c) => c.lit).length,
      meshed: chunks.filter((c) => c.mesh).length,
      pending: w ? w.pendingDecorate.size : -1,
      detail: document.getElementById('loading-detail').textContent,
    });
    if (++n >= 10 || g.running) {
      clearInterval(iv);
      resolve({ running: g.running, samples });
    }
  }, 1000);
})
