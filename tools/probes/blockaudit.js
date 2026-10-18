// probe: run the Game's own registry audit.
(() => {
  const g = window.__MINEWEB__;
  const out = { hasAudit: typeof g.auditBlocks === 'function' };
  if (out.hasAudit) out.audit = g.auditBlocks();
  return out;
})()
