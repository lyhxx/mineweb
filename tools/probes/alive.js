// probe: is the game object alive and what does it expose?
(() => {
  const g = window.__MINEWEB__;
  return {
    hasGame: !!g,
    type: typeof g,
    hasAuditCrafting: g ? typeof g.auditCrafting : 'n/a',
    hasAuditBlocks: g ? typeof g.auditBlocks : 'n/a',
    fatalVisible: !document.getElementById('fatal').classList.contains('hidden'),
    fatalText: document.getElementById('fatal-text').textContent.slice(0, 500),
    loadingHidden: document.getElementById('loading').classList.contains('hidden'),
    titleHidden: document.getElementById('title').classList.contains('hidden'),
  };
})()
