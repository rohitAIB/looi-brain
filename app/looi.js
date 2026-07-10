// looi.js — LOOI base control library (Web Bluetooth).
// Foundation for the roaming-Jarvis brain. Validated on Rohit's unit 2026-07-10:
//   parent service 0x00FF · FED0 move [speed,turn] · FED1 head [angle] · FED8 battery(notify)
//   FED5/FED9 notify · FEDA handshake (0x01 → subscribe → 0x03). Watchdog needs the handshake
//   within ~5s and a 30ms move heartbeat; battery must be read via NOTIFY (a poll-read collides
//   with the move-write loop).
//
// Usage:
//   const looi = new Looi();
//   looi.addEventListener('log',     e => console.log(e.detail.msg));
//   looi.addEventListener('battery', e => console.log('batt', e.detail.value));
//   looi.addEventListener('connected',    () => ...);
//   looi.addEventListener('disconnected', () => ...);
//   await looi.connect();          // prompts BLE chooser, handshakes, starts heartbeat
//   looi.drive(90, 0);             // raw: speed/turn -127..127 (held until changed)
//   await looi.nod();              // gesture (auto-returns to rest)

const FULL = s => `0000${s}-0000-1000-8000-00805f9b34fb`;

export const CHAR = {
  MOVE: FULL('fed0'), HEAD: FULL('fed1'), SENS: FULL('fed5'),
  BATT: FULL('fed8'), TELE: FULL('fed9'), HAND: FULL('feda'),
};

const SERVICE_00FF = FULL('00ff');                              // confirmed control service
const SERVICE_NUS  = '6e400001-b5a3-f393-e0a9-e50e24dcff00';    // 2nd service (FF01/FF02) — reserve
const HEARTBEAT_MS = 30;                                        // resend move vector or motors disengage
const HEAD_REST = 128, HEAD_UP = 185, HEAD_DOWN = 70;          // FED1 angle bytes (experimental range)

// Wide net so Chrome can enumerate the service even on differing firmware.
const OPTIONAL_SERVICES = [SERVICE_00FF, SERVICE_NUS, FULL('180f'), FULL('1801'), FULL('1800')];
for (let b = 0xfe00; b <= 0xffff; b += 0x10) OPTIONAL_SERVICES.push(FULL(b.toString(16).padStart(4, '0')));

const clamp127 = v => Math.max(-127, Math.min(127, Math.round(v)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class Looi extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.chars = {};
    this.connected = false;
    this._drive = { s: 0, t: 0 };
    this._moveTimer = null;
    this._gen = 0;                    // gesture generation — a new command cancels the previous
  }

  _log(msg, cls = '') { this.dispatchEvent(new CustomEvent('log', { detail: { msg, cls } })); }

  // ---- Connection ----
  async connect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth unavailable — use Chrome on Android over HTTPS');
    this._log('requesting device…');
    this.device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: OPTIONAL_SERVICES });
    this._log(`selected ${this.device.name || '(no name)'}`, 'ok');
    this.device.addEventListener('gattserverdisconnected', () => this._onDisconnect());

    for (let i = 1; i <= 4; i++) {                              // Android GATT-133 flake → retry
      try { this.server = await this.device.gatt.connect(); break; }
      catch (e) { this._log(`connect attempt ${i}/4: ${e.message}`, 'warn'); if (i === 4) throw e; await sleep(400); }
    }
    this._log('GATT connected', 'ok');
    await this._map();
    await this._handshake();                                    // must run <~5s or watchdog drops us
    this.connected = true;
    this.dispatchEvent(new Event('connected'));
    return true;
  }

  async _map() {
    this.chars = {};
    const wanted = new Set(Object.values(CHAR));
    for (const svc of await this.server.getPrimaryServices()) {
      let cs = []; try { cs = await svc.getCharacteristics(); } catch { continue; }
      for (const c of cs) if (wanted.has(c.uuid)) this.chars[c.uuid] = c;
    }
    const got = Object.keys(this.chars).map(u => u.slice(4, 8));
    if (!this.chars[CHAR.MOVE] || !this.chars[CHAR.HAND]) throw new Error(`missing core chars (found: ${got.join(',') || 'none'})`);
    this._log(`mapped: ${got.join(', ')}`, 'ok');
  }

  async _handshake() {
    const h = this.chars[CHAR.HAND];
    await h.writeValue(Uint8Array.of(0x01));
    for (const key of ['SENS', 'TELE', 'BATT']) {               // subscribe notifies (incl. battery)
      const c = this.chars[CHAR[key]];
      if (c && c.properties.notify) {
        await c.startNotifications();
        c.addEventListener('characteristicvaluechanged', e => this._onNotify(key, e.target.value));
      }
    }
    await h.writeValue(Uint8Array.of(0x03));
    this._log('handshake complete', 'ok');
    this._startHeartbeat();
  }

  _onNotify(key, dv) {
    if (key === 'BATT') { this.dispatchEvent(new CustomEvent('battery', { detail: { value: dv.getUint8(0) } })); }
    else {
      const bytes = [...new Uint8Array(dv.buffer)];
      this.dispatchEvent(new CustomEvent('telemetry', { detail: { key, bytes } }));
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    const move = this.chars[CHAR.MOVE];
    const write = move.writeValueWithoutResponse ? move.writeValueWithoutResponse.bind(move) : move.writeValue.bind(move);
    this._moveTimer = setInterval(() => {
      write(Uint8Array.of(this._drive.s & 0xff, this._drive.t & 0xff)).catch(() => {});
    }, HEARTBEAT_MS);
  }
  _stopHeartbeat() { if (this._moveTimer) clearInterval(this._moveTimer); this._moveTimer = null; }

  _onDisconnect() {
    this._stopHeartbeat();
    this.connected = false;
    this._drive = { s: 0, t: 0 };
    this._log('disconnected', 'warn');
    this.dispatchEvent(new Event('disconnected'));
  }

  disconnect() { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); }

  // ---- Primitives ----
  // Set the drive vector; the heartbeat re-sends it every 30ms until changed. speed/turn: -127..127.
  drive(speed, turn) { this._drive.s = clamp127(speed); this._drive.t = clamp127(turn); }
  stop() { this._gen++; this.drive(0, 0); }                     // also cancels any running gesture

  async head(angle) {
    const c = this.chars[CHAR.HEAD];
    if (c) { try { await c.writeValue(Uint8Array.of(Math.max(0, Math.min(255, Math.round(angle))))); } catch (e) { this._log('head: ' + e.message, 'warn'); } }
  }

  // ---- Gesture engine ----
  // Each gesture runs under a generation token; starting another (or stop()) cancels the previous,
  // and the drive vector always returns to rest on completion/cancel.
  async _gesture(fn) {
    const gen = ++this._gen;
    const alive = () => gen === this._gen && this.connected;
    try { await fn(alive); }
    finally { if (gen === this._gen) this.drive(0, 0); }
  }

  forward(ms = 800, spd = 90)  { return this._gesture(async () => { this.drive(spd, 0);  await sleep(ms); }); }
  back(ms = 700, spd = 90)     { return this._gesture(async () => { this.drive(-spd, 0); await sleep(ms); }); }
  spin(dir = 1, ms = 700, spd = 110) { return this._gesture(async () => { this.drive(0, dir * spd); await sleep(ms); }); }
  approach(ms = 1100)          { return this.forward(ms, 80); }
  recoil()                     { return this.back(450, 110); }

  shake(times = 3, spd = 110) {                                  // "no" — quick turn alternation
    return this._gesture(async (alive) => {
      for (let i = 0; i < times && alive(); i++) {
        this.drive(0, spd);  await sleep(140);
        this.drive(0, -spd); await sleep(140);
      }
    });
  }
  wiggle(times = 4, spd = 70) { return this.shake(times, spd); }

  lookAround() {
    return this._gesture(async (alive) => {
      this.drive(0, 80);  await sleep(550); if (!alive()) return;
      this.drive(0, 0);   await sleep(300); if (!alive()) return;
      this.drive(0, -80); await sleep(1000);
    });
  }

  nod(times = 2) {                                               // "yes" — head up/down
    return this._gesture(async (alive) => {
      for (let i = 0; i < times && alive(); i++) {
        await this.head(HEAD_DOWN); await sleep(260);
        await this.head(HEAD_UP);   await sleep(260);
      }
      await this.head(HEAD_REST);
    });
  }
  lookUp()   { return this.head(HEAD_UP); }
  lookDown() { return this.head(HEAD_DOWN); }
  lookLevel(){ return this.head(HEAD_REST); }
}
