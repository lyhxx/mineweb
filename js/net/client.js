// net/client.js
//
// Browser side of the co-op protocol implemented in tools/server.mjs.
//
// The client is deliberately dumb: it relays edits and positions and hands everything to
// callbacks. All of the world authority lives on the server, which keeps a single edit log
// so a player who joins later sees the same world.
//
//   const net = new NetClient('ws://127.0.0.1:8138/', 'steve', { onEdit, onMove, ... });
//   net.connect();
//   net.send({ t: 'edit', x, y, z, block });

const MOVE_INTERVAL = 0.1;   // seconds between position updates

export class NetClient {
  constructor(url, name, handlers = {}) {
    this.url = url;
    this.name = name || 'player';
    this.handlers = handlers;
    this.ws = null;
    this.id = 0;
    this.connected = false;
    this.players = new Map();   // id -> {id, name, x, y, z, yaw, pitch}
    this.retries = 0;
    this.closedByUser = false;
    this._moveTimer = 0;
  }

  connect() {
    this.closedByUser = false;
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) {
      this._status('地址无效：' + this.url);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.retries = 0;
      ws.send(JSON.stringify({ t: 'join', name: this.name }));
      this._status('已连接');
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      this._handle(msg);
    };

    ws.onclose = () => {
      this.connected = false;
      this.id = 0;
      this.players.clear();
      if (this.closedByUser) { this._status('已断开'); return; }
      // reconnect with a capped backoff so a server restart is survivable
      this.retries++;
      const delay = Math.min(8000, 500 * 2 ** Math.min(this.retries, 4));
      this._status(`连接断开，${(delay / 1000).toFixed(0)} 秒后重试`);
      setTimeout(() => { if (!this.closedByUser) this.connect(); }, delay);
    };

    ws.onerror = () => { /* onclose does the bookkeeping */ };
  }

  _status(text) {
    if (this.handlers.onStatus) this.handlers.onStatus(text);
  }

  _handle(msg) {
    const h = this.handlers;
    switch (msg.t) {
      case 'welcome': {
        this.id = msg.id;
        for (const p of msg.players || []) this.players.set(p.id, { ...p });
        if (h.onWelcome) h.onWelcome(msg);
        break;
      }
      case 'join':
        this.players.set(msg.id, { id: msg.id, name: msg.name, ...(msg.player || {}) });
        if (h.onJoin) h.onJoin(msg);
        break;
      case 'leave':
        this.players.delete(msg.id);
        if (h.onLeave) h.onLeave(msg);
        break;
      case 'move': {
        const p = this.players.get(msg.id);
        if (p) { p.x = msg.x; p.y = msg.y; p.z = msg.z; p.yaw = msg.yaw; p.pitch = msg.pitch; }
        else this.players.set(msg.id, { id: msg.id, name: 'player', ...msg });
        if (h.onMove) h.onMove(msg);
        break;
      }
      case 'edit':
        if (h.onEdit) h.onEdit(msg);
        break;
      case 'chat':
        if (h.onChat) h.onChat(msg);
        break;
      case 'error':
        this._status('服务器：' + msg.msg);
        break;
      default:
        break;
    }
  }

  send(obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
  }

  /** Called from the frame loop; rate-limits position updates. */
  tick(dt, player) {
    if (!this.connected || !this.id || !player) return;
    this._moveTimer -= dt;
    if (this._moveTimer > 0) return;
    this._moveTimer = MOVE_INTERVAL;
    this.send({
      t: 'move',
      x: Math.round(player.x * 100) / 100,
      y: Math.round(player.y * 100) / 100,
      z: Math.round(player.z * 100) / 100,
      yaw: Math.round(player.yaw * 1000) / 1000,
      pitch: Math.round(player.pitch * 1000) / 1000,
    });
  }

  chat(text) { return this.send({ t: 'chat', msg: text }); }

  edit(x, y, z, block) { return this.send({ t: 'edit', x, y, z, block }); }

  close() {
    this.closedByUser = true;
    if (this.ws) { try { this.ws.close(); } catch (e) { /* ignore */ } }
    this.connected = false;
  }
}
