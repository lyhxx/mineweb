// probe: is mouse look a one-shot delta (correct) or a runaway that keeps rotating?
(() => {
  const g = window.__MINEWEB__;
  const p = g.player;
  const input = g.input;
  const out = {};

  g.uiMode = 'playing';
  p.yaw = 0; p.pitch = 0;
  input.mouseDX = 0; input.mouseDY = 0;
  input.locked = true;

  const send = (mx, my) => {
    const ev = new MouseEvent('mousemove', { bubbles: true });
    Object.defineProperty(ev, 'movementX', { value: mx });
    Object.defineProperty(ev, 'movementY', { value: my });
    window.dispatchEvent(ev);
  };

  out.sensitivity = input.sensitivity;
  out.beforeYaw = p.yaw;

  // one event, then no more input at all
  send(100, 0);
  out.afterEvent_dx = input.mouseDX;
  g.stepFrame(1 / 60);
  const yaw1 = p.yaw;
  out.after1Frame_dx = input.mouseDX;
  const trail = [];
  for (let i = 0; i < 120; i++) {
    g.stepFrame(1 / 60);
    if (i === 1 || i === 4 || i === 59 || i === 119) trail.push({ frame: i + 2, yaw: +p.yaw.toFixed(4), dx: input.mouseDX });
  }
  out.yawAfterEvent = +yaw1.toFixed(4);
  out.trail = trail;
  out.runaway = Math.abs(p.yaw - yaw1) > 0.001;

  // does pitch stay clamped and stop?
  p.pitch = 0;
  send(0, 100000);
  out.pitchAfterHugeEvent = null;
  g.stepFrame(1 / 60);
  out.pitchAfterHugeEvent = +p.pitch.toFixed(4);
  for (let i = 0; i < 30; i++) g.stepFrame(1 / 60);
  out.pitchSettled = +p.pitch.toFixed(4);

  // simulate a fast continuous drag: 20 events per frame for 30 frames
  p.yaw = 0;
  const y0 = p.yaw;
  for (let f = 0; f < 30; f++) {
    for (let k = 0; k < 20; k++) send(50, 0);
    g.stepFrame(1 / 60);
  }
  out.dragTotalYaw = +p.yaw.toFixed(3);
  out.expectedYawFor30x20x50 = +(30 * 20 * 50 * input.sensitivity).toFixed(3);
  out.startYaw = y0;

  input.locked = false;
  p.yaw = 0; p.pitch = 0;
  return out;
})()
