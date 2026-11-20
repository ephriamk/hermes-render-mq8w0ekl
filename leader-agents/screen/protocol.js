// protocol.js: every byte that goes to or comes from the server lives here.
//
// Two layers:
//   Gateway       REST helpers + the /api/ws JSON-RPC socket (tickets, heartbeat, reconnect).
//   Conversation  The state of one chat: transcript items, streaming, tools, prompts, errors.
//
// Nothing in this file touches the DOM. All browser globals come in through `env`, so the
// node test can drive it with a fake WebSocket, fake fetch and fake timers.

const PROFILE = 'default';
const TOKEN_HEADER = 'X-Hermes-Session-Token';
const SUBPROTOCOL = 'hermes-gateway-v1';
const HEARTBEAT_MS = 15000;
const SILENCE_LIMIT_MS = 45000;
const REQUEST_TIMEOUT_MS = 60000;
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 15000];

export const SIGN_IN_URL = '/_eca/open';
export const CONNECT_URL = '/_eca/connect';

export class RpcError extends Error {
  constructor(error) {
    const e = error || {};
    super(e.message || 'request failed');
    this.code = e.code;
    this.data = e.data || null;
    this.reason = (e.data && e.data.reason) || e.message || '';
  }
}

export class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

export function sessionStorageKey(origin, basePath = '') {
  return 'hermes.webapp.session.v1:' + JSON.stringify([origin, basePath]);
}

function defaultEnv() {
  const g = globalThis;
  return {
    fetch: g.fetch && g.fetch.bind(g),
    WebSocket: g.WebSocket,
    storage: (() => { try { return g.sessionStorage; } catch { return null; } })(),
    location: g.location,
    setTimeout: g.setTimeout.bind(g),
    clearTimeout: g.clearTimeout.bind(g),
    setInterval: g.setInterval.bind(g),
    clearInterval: g.clearInterval.bind(g),
    now: () => Date.now(),
    random: Math.random,
    uuid: () => (g.crypto && g.crypto.randomUUID ? g.crypto.randomUUID()
      : 'x' + Date.now().toString(16) + Math.random().toString(16).slice(2)),
    navigate: (url) => { g.location.assign(url); },
    log: (...a) => { try { console.warn('[agent]', ...a); } catch { /* ignore */ } },
  };
}

class Emitter {
  constructor() { this._l = new Map(); }
  on(type, fn) {
    if (!this._l.has(type)) this._l.set(type, new Set());
    this._l.get(type).add(fn);
    return () => this._l.get(type)?.delete(fn);
  }
  emit(type, data) {
    for (const fn of [...(this._l.get(type) || [])]) {
      try { fn(data); } catch (err) { try { console.error(err); } catch { /* ignore */ } }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Gateway
// ─────────────────────────────────────────────────────────────────────────────

export class Gateway extends Emitter {
  constructor(envOverrides = {}) {
    super();
    this.env = { ...defaultEnv(), ...envOverrides };
    this.token = '';
    this.state = 'idle'; // idle | connecting | ready | reconnecting | offline | signed-out
    this.ws = null;
    this.ready = null;        // gateway.ready payload
    this.authority = null;    // true | false once ready
    this._nextId = 1;
    this._pending = new Map(); // id -> {resolve, reject, timer, method}
    this._heartbeatTimer = null;
    this._heartbeatN = 0;
    this._lastFrameAt = 0;
    this._attempt = 0;
    this._reconnectTimer = null;
    this._closedByUs = false;
    this._everReady = false;
    this._readyWaiters = [];
    this.serverRequestHandlers = new Map(); // method -> async (params) => result
  }

  // ── token ──────────────────────────────────────────────────────────────
  loadToken() {
    const loc = this.env.location;
    let token = '';
    try { token = this.env.storage?.getItem(sessionStorageKey(loc.origin, '')) || ''; } catch { token = ''; }
    this.token = token;
    return token;
  }

  signInAgain() {
    if (this.state === 'signed-out') return;
    this._setState('signed-out');
    this.close();
    this.emit('signin-required');
    this.env.navigate(SIGN_IN_URL);
  }

  // ── REST ───────────────────────────────────────────────────────────────
  async api(path, { method = 'GET', query, json, body, headers = {}, raw = false, auth = true } = {}) {
    let url = path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += (url.includes('?') ? '&' : '?') + s;
    }
    const h = { ...headers };
    if (auth && this.token) h[TOKEN_HEADER] = this.token;
    let payload = body;
    if (json !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
    const res = await this.env.fetch(url, { method, headers: h, body: payload, credentials: 'same-origin' });
    if (res.status === 401 && auth && url.startsWith('/api/')) {
      this.signInAgain();
      throw new HttpError(401, null);
    }
    if (raw) {
      if (!res.ok) throw new HttpError(res.status, await safeJson(res));
      return res;
    }
    const data = await safeJson(res);
    if (!res.ok) throw new HttpError(res.status, data);
    return data;
  }

  // ECA gate endpoints (same origin, no gateway token needed).
  whoami() { return this.api('/_eca/whoami', { auth: false }); }
  async signOut() {
    try { await this.api('/_eca/sign-out', { method: 'POST', auth: false }); } catch { /* go anyway */ }
    try { this.env.storage?.removeItem(sessionStorageKey(this.env.location.origin, '')); } catch { /* ignore */ }
    this.close();
    this.env.navigate('/_eca/signed-out?bye=1');
  }

  // Sessions
  async listSessions({ limit = 60, offset = 0 } = {}) {
    const data = await this.api('/api/sessions', { query: {
      limit, offset, min_messages: 1, archived: 'exclude', order: 'recent', exclude_sources: 'cron', profile: PROFILE,
    } });
    return Array.isArray(data) ? data : (data?.sessions || []);
  }
  async getMessages(id, { limit = 120, offset = 0 } = {}) {
    const data = await this.api(`/api/sessions/${encodeURIComponent(id)}/messages`, { query: {
      profile: PROFILE, limit, offset, order: 'latest', include_compacted: 'true',
    } });
    return { sessionId: data?.session_id || id, messages: data?.messages || [], pagination: data?.pagination || null };
  }
  async patchSession(id, fields) {
    // Two step revision-checked write. One retry on a revision conflict.
    const requestId = this.env.uuid();
    for (let attempt = 0; attempt < 2; attempt++) {
      const snap = await this.api(`/api/sessions/${encodeURIComponent(id)}/mutation-snapshot`, { query: { profile: PROFILE } });
      const body = { ...fields, request_id: requestId, expected_revision: snap?.runtime_revision ?? 0, profile: PROFILE };
      if (snap?.runtime_generation !== undefined && snap?.runtime_generation !== null) body.expected_generation = snap.runtime_generation;
      try {
        return await this.api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', json: body });
      } catch (err) {
        if (attempt === 0 && err instanceof HttpError && err.status === 409 && /revision/.test(JSON.stringify(err.body || ''))) continue;
        throw err;
      }
    }
    return null;
  }
  renameSession(id, title) { return this.patchSession(id, { title }); }
  archiveSession(id, archived = true) { return this.patchSession(id, { archived }); }

  // Files (managed files root = the home folder unless the deployment locks it)
  async listFiles(path) {
    const data = await this.api('/api/files', { query: path ? { path } : undefined });
    const entries = (data?.entries || []).map((e) => ({
      name: e.name,
      path: e.path,
      isDirectory: !!(e.is_directory ?? e.isDirectory),
      size: e.size ?? null,
      mtime: e.mtime ?? null,
      mime: e.mime_type || null,
    }));
    return { path: data?.path || path || '', parent: data?.parent || null, entries };
  }
  async uploadFile(folderPath, file) {
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('path', joinPath(folderPath, file.name));
    form.append('overwrite', 'false');
    return this.api('/api/files/upload-stream', { method: 'POST', body: form });
  }
  async downloadFile(path) {
    // fetch with the header, return a Blob. The UI saves it with an object URL.
    const res = await this.api('/api/fs/download', { query: { path, profile: PROFILE }, raw: true });
    return res.blob();
  }

  // Attachments for the agent to read (chat upload, then file.attach on the socket)
  async uploadChatFile(file) {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.api('/api/chat/file-upload', { method: 'POST', query: { profile: PROFILE }, body: form });
  }

  // Scheduled jobs
  async listJobs() {
    const data = await this.api('/api/cron/jobs', { query: { profile: PROFILE } });
    return Array.isArray(data) ? data : (data?.jobs || []);
  }
  pauseJob(id) { return this.api(`/api/cron/jobs/${encodeURIComponent(id)}/pause`, { method: 'POST' }); }
  resumeJob(id) { return this.api(`/api/cron/jobs/${encodeURIComponent(id)}/resume`, { method: 'POST' }); }
  deleteJob(id) { return this.api(`/api/cron/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }); }

  // Models
  modelOptions() { return this.api('/api/model/options', { query: { explicit_only: 1, profile: PROFILE } }); }

  // ── socket ─────────────────────────────────────────────────────────────
  _setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('status', s);
  }

  whenReady() {
    if (this.state === 'ready') return Promise.resolve();
    return new Promise((resolve, reject) => this._readyWaiters.push({ resolve, reject }));
  }

  async connect() {
    if (this.state === 'signed-out') return;
    if (!this.token) this.loadToken();
    if (!this.token) { this.signInAgain(); return; }
    this._closedByUs = false;
    this._setState(this._everReady ? 'reconnecting' : 'connecting');
    let ticket;
    try {
      const data = await this.api('/api/webapp/socket-ticket', { method: 'POST', query: { socket: 'gateway', profile: PROFILE } });
      ticket = data?.ticket;
      if (!ticket) throw new Error('no ticket');
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) return; // signInAgain already ran
      this.env.log('socket ticket failed', err?.status || err?.message);
      this._scheduleReconnect();
      return;
    }
    const loc = this.env.location;
    const scheme = loc.protocol === 'http:' ? 'ws:' : 'wss:';
    const url = `${scheme}//${loc.host}/api/ws?native_dial=browser`;
    let ws;
    try {
      ws = new this.env.WebSocket(url, [SUBPROTOCOL, 'hermes-gateway-ticket.' + ticket]);
    } catch (err) {
      this.env.log('socket open threw', err?.message);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    this._lastFrameAt = this.env.now();
    ws.onmessage = (ev) => this._onFrame(ws, ev.data);
    ws.onclose = (ev) => this._onClose(ws, ev);
    ws.onerror = () => { /* close follows */ };
  }

  close() {
    this._closedByUs = true;
    this._stopHeartbeat();
    if (this._reconnectTimer) { this.env.clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(1000); } catch { /* ignore */ } }
    this._failPending(new Error('closed'));
  }

  _onClose(ws, ev) {
    if (ws !== this.ws) return; // an old socket
    this.ws = null;
    this._stopHeartbeat();
    this._failPending(new Error('disconnected'));
    if (this._closedByUs || this.state === 'signed-out') return;
    const code = ev?.code;
    // 4401: ticket or sign-in rejected. The next ticket mint tells us which (401 means signed out).
    // 4403: not allowed (host/origin/profile). Retrying will not help much but we try slowly.
    // 1013: gateway restarting. 1011: server failure. 1006: handshake refused or network.
    this.env.log('socket closed', code, ev?.reason || '');
    if (code === 4403) this._attempt = Math.max(this._attempt, BACKOFF_MS.length - 2);
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._closedByUs || this.state === 'signed-out') return;
    this._setState(this._everReady ? 'reconnecting' : 'offline');
    const base = BACKOFF_MS[Math.min(this._attempt, BACKOFF_MS.length - 1)];
    this._attempt++;
    const delay = Math.round(base * (0.8 + this.env.random() * 0.4));
    if (this._reconnectTimer) this.env.clearTimeout(this._reconnectTimer);
    this._reconnectTimer = this.env.setTimeout(() => { this._reconnectTimer = null; this.connect(); }, delay);
  }

  _onFrame(ws, data) {
    if (ws !== this.ws) return;
    this._lastFrameAt = this.env.now();
    let msg;
    try { msg = JSON.parse(data); } catch { this.env.log('bad frame', String(data).slice(0, 200)); return; }
    if (!msg || typeof msg !== 'object') return;

    // Server event
    if (msg.method === 'event' && msg.id === undefined) {
      const p = msg.params || {};
      if (p.type === 'gateway.ready') { this._onReady(p.payload || {}); return; }
      this.emit('event', p);
      return;
    }
    // Server request to us
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      this._onServerRequest(msg);
      return;
    }
    // Reply to one of ours
    if (msg.id !== undefined && ('result' in msg || 'error' in msg)) {
      const entry = this._pending.get(msg.id);
      if (!entry) {
        if (msg.id === null && msg.error) this.env.log('server could not parse a frame', msg.error);
        return;
      }
      this._pending.delete(msg.id);
      this.env.clearTimeout(entry.timer);
      if (msg.error) entry.reject(new RpcError(msg.error));
      else entry.resolve(msg.result);
      return;
    }
    this.env.log('unknown frame', msg);
  }

  async _onReady(payload) {
    this.ready = payload;
    this.authority = payload.session_authority === true;
    if (!this.authority) this.env.log('gateway.ready without session_authority: legacy wire, some actions may not work');
    this._attempt = 0;
    const wasReady = this._everReady;
    this._everReady = true;
    this._setState('ready');
    this._startHeartbeat(payload.heartbeat !== false);
    // Fire and forget: harmless on the authority wire, required on the legacy one.
    this.request('client.capabilities', { server_requests: true }, { timeoutMs: 15000 })
      .catch((err) => this.env.log('client.capabilities', err?.message));
    const waiters = this._readyWaiters.splice(0);
    waiters.forEach((w) => w.resolve());
    this.emit(wasReady ? 'reconnected' : 'connected', payload);
  }

  _onServerRequest(msg) {
    const handler = this.serverRequestHandlers.get(msg.method);
    const reply = (frame) => this._send({ jsonrpc: '2.0', id: msg.id, ...frame });
    if (!handler) {
      this.env.log('declined server request', msg.method);
      reply({ error: { code: -32601, message: `no handler for server request: ${msg.method}` } });
      return;
    }
    Promise.resolve().then(() => handler(msg.params || {}))
      .then((result) => reply({ result: result ?? {} }))
      .catch((err) => reply({ error: { code: -32603, message: String(err?.message || err) } }));
  }

  _send(obj) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  request(method, params = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      if (!this._send({ jsonrpc: '2.0', id, method, params })) {
        reject(Object.assign(new Error('not connected'), { notConnected: true }));
        return;
      }
      const timer = this.env.setTimeout(() => {
        if (this._pending.delete(id)) reject(Object.assign(new Error('timed out'), { timedOut: true }));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, method });
    });
  }

  _failPending(err) {
    for (const [, entry] of this._pending) { this.env.clearTimeout(entry.timer); entry.reject(err); }
    this._pending.clear();
  }

  _startHeartbeat(enabled) {
    this._stopHeartbeat();
    this._heartbeatTimer = this.env.setInterval(() => {
      if (this.env.now() - this._lastFrameAt > SILENCE_LIMIT_MS) {
        this.env.log('socket silent, redialing');
        const ws = this.ws;
        if (ws) { try { ws.close(4000, 'silent'); } catch { /* ignore */ } this._onClose(ws, { code: 4000 }); }
        return;
      }
      if (enabled) {
        const id = 'heartbeat-' + (++this._heartbeatN);
        this._send({ jsonrpc: '2.0', id, method: 'gateway.ping', params: {} });
      }
    }, HEARTBEAT_MS);
  }
  _stopHeartbeat() {
    if (this._heartbeatTimer) { this.env.clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  }
}

async function safeJson(res) {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { text }; }
}

function joinPath(folder, name) {
  if (!folder) return name;
  return folder.replace(/\/+$/, '') + '/' + name;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation
// ─────────────────────────────────────────────────────────────────────────────

let itemSeq = 0;
const newItemId = () => 'i' + (++itemSeq);

export function textFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => {
      if (typeof p === 'string') return p;
      if (!p || typeof p !== 'object') return '';
      if (p.type === 'text' || typeof p.text === 'string') return p.text || '';
      if (p.type && /image/.test(p.type)) return '[image]';
      return '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

// Hide the long @file:/abs/path references the composer adds for attachments.
export function cleanUserText(text) {
  return String(text || '').replace(/@file:(\S+)/g, (_, p) => '[' + basename(p) + ']');
}

export function basename(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Item shapes (render.js reads these):
 *  {kind:'user', id, text}
 *  {kind:'assistant', id, text, streaming, segKey}
 *  {kind:'tool', id, toolId, name, context, args, status:'running'|'done'|'error'|'stopped', result, progress, duration}
 *  {kind:'approval', id, promptId, generation, command, description, choices, edit, status:'open'|'sending'|'answered'|'settled', answer, error}
 *  {kind:'clarify',  id, promptId, generation, question, choices, multi, status, answer, error}
 *  {kind:'error', id, layer, code, text, retryable, authKind, resetsAt}
 *  {kind:'notice', id, text}
 */
export class Conversation extends Emitter {
  constructor(gateway) {
    super();
    this.gw = gateway;
    this.sessionId = null;
    this.title = '';
    this.items = [];
    this.running = false;
    this.revision = null;
    this.generation = null;
    this.admissionId = null;
    this.lastSeq = null;
    this.replayEpoch = null;
    this.lastUserText = '';
    this.loading = false;
    this.attached = false;
    this._current = null;           // the assistant item receiving deltas
    this._segApplied = new Map();   // turn:segment -> UTF-16 length applied
    this._turnHadText = false;
    this._offEvent = gateway.on('event', (p) => this.handleEvent(p));
    this._offRe = gateway.on('reconnected', () => this.reattach());
  }

  dispose() { this._offEvent(); this._offRe(); }

  _changed() { this.emit('change', this); }

  // ── open / create ──────────────────────────────────────────────────────
  async open(id) {
    this.loading = true; this._changed();
    try {
      await this._loadTranscript(id);
      await this.gw.whenReady();
      const snap = await this.gw.request('session.resume', { session_id: id, omit_messages: true });
      this._applySnapshot(snap);
    } finally {
      this.loading = false; this._changed();
    }
  }

  async create() {
    await this.gw.whenReady();
    const snap = await this.gw.request('session.create', { request_id: this.gw.env.uuid(), source: 'gui' });
    this._applySnapshot(snap);
    this.emit('created', this.sessionId);
    this._changed();
    return this.sessionId;
  }

  async _loadTranscript(id) {
    const { sessionId, messages } = await this.gw.getMessages(id);
    this.sessionId = sessionId || id;
    this.items = transcriptToItems(messages);
    this._current = null;
    this._segApplied.clear();
  }

  _applySnapshot(snap) {
    if (!snap || typeof snap !== 'object') return;
    if (snap.session_id) this.sessionId = snap.session_id;
    this.attached = true;
    if ('running' in snap) this.running = !!snap.running;
    if (snap.revision !== undefined) this.revision = snap.revision;
    if (snap.execution_generation !== undefined) this.generation = snap.execution_generation;
    if (snap.replay_epoch) { if (snap.replay_epoch !== this.replayEpoch) this.lastSeq = null; this.replayEpoch = snap.replay_epoch; }
    if (typeof snap.last_sequence === 'number') this.lastSeq = Math.max(this.lastSeq ?? -1, snap.last_sequence);
    if (snap.info?.title) this.title = snap.info.title;
    if (Array.isArray(snap.prompts)) for (const p of snap.prompts) this._addPrompt(p, p?.kind);
    if (Array.isArray(snap.display_messages) && !this.items.length) this.items = transcriptToItems(snap.display_messages);
    this._changed();
  }

  // After a socket reconnect: replay what we missed, then attach again.
  async reattach() {
    if (!this.sessionId) return;
    const id = this.sessionId;
    let replayed = false;
    if (this.lastSeq !== null && this.replayEpoch) {
      try {
        const r = await this.gw.request('session.events.since', { session_id: id, last_seen: this.lastSeq, replay_epoch: this.replayEpoch });
        if (r && !r.snapshot_required && !r.truncated) {
          for (const ev of r.events || []) this.handleEvent(ev.params && ev.params.type ? ev.params : ev);
          replayed = true;
        }
      } catch (err) { this.gw.env.log('events.since failed', err?.reason || err?.message); }
    }
    try {
      if (!replayed) await this._loadTranscript(id);
      const snap = await this.gw.request('session.resume', { session_id: id, omit_messages: true });
      if (!replayed) { this.lastSeq = null; }
      this._applySnapshot(snap);
      if (!this.running) this._finishTurnLocal();
    } catch (err) {
      this.gw.env.log('resume after reconnect failed', err?.reason || err?.message);
    }
    this._changed();
  }

  // ── actions ───────────────────────────────────────────────────────────
  async send(text, { attachments } = {}) {
    const body = String(text || '').trim();
    if (!body && !(attachments && attachments.length)) return;
    if (!this.sessionId) await this.create();
    let full = body;
    // File attachments: upload, attach on the socket, prefix ref_text lines (stock composer order).
    if (attachments && attachments.length) {
      const refs = [];
      for (const file of attachments) {
        const up = await this.gw.uploadChatFile(file);
        const r = await this.gw.request('file.attach', { session_id: this.sessionId, name: file.name, staged_upload: up.staged_upload });
        if (r?.ref_text) refs.push(r.ref_text);
      }
      if (refs.length) full = refs.join('\n') + '\n\n' + body;
    }
    this.lastUserText = full;
    this.items.push({ kind: 'user', id: newItemId(), text: cleanUserText(full) });
    this.running = true;
    this._turnHadText = false;
    this._current = null;
    this._changed();
    const submissionId = this.gw.env.uuid();
    try {
      const receipt = await this.gw.request('prompt.submit', { session_id: this.sessionId, text: full, submission_id: submissionId });
      if (receipt?.admission_id) this.admissionId = receipt.admission_id;
      if (receipt?.status === 'terminal' && receipt?.outcome && receipt.outcome !== 'completed') {
        this.gw.env.log('prompt ended at admission', receipt.outcome);
      }
    } catch (err) {
      this.running = false;
      this.items.push({ kind: 'error', id: newItemId(), layer: 'send', text: sendErrorText(err), retryable: true });
      this._changed();
    }
  }

  async retry() {
    if (!this.lastUserText || this.running) return;
    // Remove the trailing error card(s) so the retry reads cleanly.
    while (this.items.length && this.items[this.items.length - 1].kind === 'error') this.items.pop();
    const text = this.lastUserText;
    // The user bubble is shown again by send(); drop the previous one if it is now last.
    await this.send(text);
  }

  async stop() {
    if (!this.sessionId) return;
    try {
      if (this.admissionId) {
        await this.gw.request('prompt.cancel', { session_id: this.sessionId, admission_id: this.admissionId });
        return;
      }
    } catch (err) { this.gw.env.log('prompt.cancel failed', err?.reason || err?.message); }
    try {
      await this.gw.request('session.interrupt', { session_id: this.sessionId, execution_generation: this.generation });
    } catch (err) {
      if (err?.reason === 'stale_generation' && err.data?.execution_generation !== undefined) {
        this.generation = err.data.execution_generation;
        await this.gw.request('session.interrupt', { session_id: this.sessionId, execution_generation: this.generation }).catch(() => {});
      } else { this.gw.env.log('interrupt failed', err?.reason || err?.message); }
    }
  }

  async answerApproval(itemId, choice) {
    const it = this.items.find((x) => x.id === itemId && x.kind === 'approval');
    if (!it || it.status !== 'open') return;
    it.status = 'sending'; it.error = ''; this._changed();
    try {
      const r = await this.gw.request('approval.respond', {
        session_id: this.sessionId, execution_generation: it.generation, prompt_id: it.promptId, choice,
      }, { timeoutMs: 300000 });
      it.status = 'answered'; it.answer = choice;
      if (r?.status === 'already_resolved') it.status = 'settled';
    } catch (err) {
      it.status = 'open'; it.error = 'That answer did not go through. Try again.';
      this.gw.env.log('approval.respond', err?.reason || err?.message);
    }
    this._changed();
  }

  async answerClarify(itemId, answer) {
    const it = this.items.find((x) => x.id === itemId && x.kind === 'clarify');
    if (!it || it.status !== 'open') return;
    const value = Array.isArray(answer) ? answer.join(', ') : String(answer ?? '');
    it.status = 'sending'; it.error = ''; this._changed();
    try {
      await this.gw.request('clarify.respond', {
        session_id: this.sessionId, execution_generation: it.generation, prompt_id: it.promptId, answer: value,
      }, { timeoutMs: 300000 });
      it.status = 'answered'; it.answer = value;
    } catch (err) {
      it.status = 'open'; it.error = 'That answer did not go through. Try again.';
      this.gw.env.log('clarify.respond', err?.reason || err?.message);
    }
    this._changed();
  }

  async setEffort(effort) {
    return this._mutate('reasoning', { effort }, true);
  }
  async setModel(model, provider) {
    const payload = provider ? { model, provider } : { model };
    return this._mutate('model', payload, true);
  }
  async _mutate(operation, payload, needsGeneration) {
    if (!this.sessionId) await this.create();
    const requestId = this.gw.env.uuid();
    for (let attempt = 0; attempt < 2; attempt++) {
      const params = { session_id: this.sessionId, request_id: requestId, expected_revision: this.revision ?? 0, operation, payload };
      if (needsGeneration) params.expected_generation = this.generation ?? 0;
      try {
        const r = await this.gw.request('session.mutate', params);
        if (r?.revision !== undefined) this.revision = r.revision;
        return r;
      } catch (err) {
        if (attempt === 0 && (err?.reason === 'revision_conflict' || err?.reason === 'stale_generation') && err.data) {
          if (err.data.revision !== undefined) this.revision = err.data.revision;
          if (err.data.execution_generation !== undefined) this.generation = err.data.execution_generation;
          continue;
        }
        throw err;
      }
    }
    return null;
  }

  // ── events ────────────────────────────────────────────────────────────
  handleEvent(p) {
    if (!p || typeof p !== 'object') return;
    const type = p.type;
    if (!this.sessionId) return;
    if (type === 'sessions.changed' || type === 'cron.changed' || type === 'heartbeat') return; // app-level
    if (p.session_id && p.session_id !== this.sessionId) {
      // Some lists (sessions.changed, cron.changed) are global; let the app see them.
      if (type !== 'session.title') return;
    }
    if (Number.isFinite(p.seq) && p.session_id && p.session_id === this.sessionId) {
      if (p.replay_epoch && this.replayEpoch && p.replay_epoch !== this.replayEpoch) {
        this.lastSeq = null; // new epoch, cursor restarts
      }
      if (p.replay_epoch) this.replayEpoch = p.replay_epoch;
      if (this.lastSeq !== null && p.seq <= this.lastSeq) return; // already applied
      this.lastSeq = p.seq;
    }
    if (p.execution_generation !== undefined && p.execution_generation !== null) this.generation = p.execution_generation;
    if (p.admission_id && this.running) this.admissionId = p.admission_id;
    const pl = p.payload || {};

    switch (type) {
      case 'session.info':
        if ('running' in pl) {
          const wasRunning = this.running;
          this.running = !!pl.running;
          if (wasRunning && !this.running) this._finishTurnLocal();
        }
        if (pl.execution_generation !== undefined) this.generation = pl.execution_generation;
        if (pl.revision !== undefined) this.revision = pl.revision;
        if (pl.title) this.title = pl.title;
        break;
      case 'message.start':
        this.running = true;
        this._sealCurrent();
        break;
      case 'message.delta':
        this.running = true;
        this._applyDelta(pl);
        break;
      case 'message.interim':
        if (pl.already_streamed) this._sealCurrent();
        else if (pl.text) {
          this._sealCurrent();
          this.items.push({ kind: 'assistant', id: newItemId(), text: String(pl.text), streaming: false });
          this._turnHadText = true;
        }
        break;
      case 'reasoning.delta':
      case 'thinking.delta':
      case 'tool.generating':
      case 'status.update':
        this.emit('activity', { type, text: typeof pl.text === 'string' ? pl.text : '' });
        return;
      case 'tool.start': {
        this._sealCurrent();
        const toolId = pl.tool_id || pl.tool_call_id || newItemId();
        let it = this.items.find((x) => x.kind === 'tool' && x.toolId === toolId);
        if (!it) {
          it = { kind: 'tool', id: newItemId(), toolId, name: pl.name || pl.tool_name || 'tool', context: pl.context || '', args: pl.args || null, status: 'running', result: null, progress: null };
          this.items.push(it);
        }
        break;
      }
      case 'tool.progress': {
        const it = this.items.find((x) => x.kind === 'tool' && x.toolId === (pl.tool_id || pl.tool_call_id));
        if (it) it.progress = pl.message || (pl.percent != null ? Math.round(pl.percent) + '%' : (pl.total ? `${pl.progress}/${pl.total}` : null));
        break;
      }
      case 'tool.complete': {
        const toolId = pl.tool_id || pl.tool_call_id;
        let it = this.items.find((x) => x.kind === 'tool' && x.toolId === toolId);
        if (!it) {
          it = { kind: 'tool', id: newItemId(), toolId, name: pl.name || pl.tool_name || 'tool', context: '', args: pl.args || null };
          this.items.push(it);
        }
        it.status = pl.is_error ? 'error' : 'done';
        it.result = pl.result ?? null;
        if (pl.args && !it.args) it.args = pl.args;
        it.duration = pl.duration_s ?? null;
        it.progress = null;
        break;
      }
      case 'approval.request':
        this._addPrompt({ ...pl, execution_generation: pl.execution_generation ?? p.execution_generation }, 'approval');
        break;
      case 'clarify.request':
        this._addPrompt({ ...pl, execution_generation: pl.execution_generation ?? p.execution_generation }, 'clarify');
        break;
      case 'approval.settled':
      case 'clarify.settled': {
        const it = this.items.find((x) => (x.kind === 'approval' || x.kind === 'clarify') && x.promptId === pl.prompt_id);
        if (it && it.status !== 'answered') it.status = 'settled';
        break;
      }
      case 'message.complete':
        this._complete(pl, p);
        break;
      case 'session.title':
        if (!p.session_id || p.session_id === this.sessionId || pl.session_id === this.sessionId) {
          this.title = pl.title || this.title;
          this.emit('title', this.title);
        }
        break;
      case 'session.replay_gap':
        this.reattach();
        return;
      case 'error':
        this.items.push({ kind: 'error', id: newItemId(), layer: 'gateway', text: pl.message || 'Something went wrong.', retryable: true });
        break;
      case 'todo.updated':
      case 'session.usage':
      case 'session.updated':
        break;
      default:
        if (type) this.gw.env.log('unhandled event', type);
        return;
    }
    this._changed();
  }

  _addPrompt(pl, kind) {
    if (!pl || !pl.prompt_id) return;
    const k = kind || pl.kind;
    if (this.items.some((x) => x.promptId === pl.prompt_id)) return;
    this._sealCurrent();
    if (k === 'approval') {
      this.items.push({
        kind: 'approval', id: newItemId(), promptId: pl.prompt_id, generation: pl.execution_generation ?? this.generation,
        command: pl.command || '', description: pl.description || '', edit: pl.edit || null,
        choices: Array.isArray(pl.choices) && pl.choices.length ? pl.choices : ['once', 'deny'], status: 'open', answer: null, error: '',
      });
    } else if (k === 'clarify') {
      this.items.push({
        kind: 'clarify', id: newItemId(), promptId: pl.prompt_id, generation: pl.execution_generation ?? this.generation,
        question: pl.question || '', choices: Array.isArray(pl.choices) ? pl.choices : [], multi: !!pl.multi_select,
        status: 'open', answer: null, error: '',
      });
    } else {
      this.gw.env.log('unknown prompt kind', k);
    }
  }

  _applyDelta(pl) {
    if (pl.text === null || pl.text === undefined) { this._sealCurrent(); return; }
    let text = String(pl.text);
    const key = pl.turn_id != null ? `${pl.turn_id}:${pl.segment ?? 0}` : null;
    if (key && typeof pl.offset === 'number') {
      const applied = this._segApplied.get(key) || 0;
      if (pl.offset + text.length <= applied) return;          // whole chunk already shown
      if (pl.offset < applied) text = text.slice(applied - pl.offset); // overlap
      this._segApplied.set(key, Math.max(applied, pl.offset + String(pl.text).length));
    }
    if (!text) return;
    if (!this._current || (key && this._current.segKey && this._current.segKey !== key)) {
      this._sealCurrent();
      this._current = { kind: 'assistant', id: newItemId(), text: '', streaming: true, segKey: key };
      this.items.push(this._current);
    }
    this._current.text += text;
    this._turnHadText = true;
  }

  _sealCurrent() {
    if (this._current) { this._current.streaming = false; this._current = null; }
  }

  _complete(pl) {
    const status = pl.status || (pl.outcome === 'cancelled' ? 'interrupted' : 'complete');
    const text = typeof pl.text === 'string' ? pl.text : (typeof pl.content === 'string' ? pl.content : '');
    if (status === 'error') {
      this._sealCurrent();
      const es = pl.error_surface || {};
      this.items.push({
        kind: 'error', id: newItemId(), layer: es.layer || 'unknown', code: es.code || '',
        text: text || pl.failure_reason || '', retryable: es.retryable !== false,
        authKind: es.auth_kind || null, resetsAt: es.resets_at || null,
      });
    } else {
      if (text && !this._turnHadText && !pl.response_reused) {
        this._sealCurrent();
        this.items.push({ kind: 'assistant', id: newItemId(), text, streaming: false });
      }
      if (status === 'interrupted') this.items.push({ kind: 'notice', id: newItemId(), text: 'Stopped.' });
    }
    this._finishTurnLocal();
  }

  _finishTurnLocal() {
    this._sealCurrent();
    this.running = false;
    this.admissionId = null;
    this._turnHadText = false;
    for (const it of this.items) {
      if (it.kind === 'tool' && it.status === 'running') it.status = 'stopped';
      if (it.kind === 'assistant') it.streaming = false;
    }
  }
}

function sendErrorText(err) {
  const r = err?.reason || '';
  if (r === 'queue_full') return 'Too many messages are waiting. Give it a moment and try again.';
  if (r === 'runtime_draining') return 'Your agent is restarting. Try again in a few seconds.';
  if (err?.notConnected) return 'Not connected right now. Your message was not sent.';
  return 'Your message was not sent. Try again.';
}

// Turn REST message rows into display items.
export function transcriptToItems(rows) {
  const items = [];
  const toolsByCallId = new Map();
  for (const row of rows || []) {
    if (!row || row.display_kind === 'hidden') continue;
    const role = row.role;
    const text = row.display_content != null ? textFromContent(row.display_content)
      : (typeof row.text === 'string' ? row.text : textFromContent(row.content));
    if (row.display_kind === 'failed_turn') {
      const es = row.display_metadata?.error_surface || {};
      items.push({ kind: 'error', id: newItemId(), layer: es.layer || 'unknown', code: es.code || '', text: row.display_metadata?.error || text, retryable: es.retryable !== false, authKind: es.auth_kind || null });
      continue;
    }
    if (role === 'user') {
      if (text) items.push({ kind: 'user', id: newItemId(), text: cleanUserText(text) });
    } else if (role === 'assistant') {
      if (text && text.trim()) items.push({ kind: 'assistant', id: newItemId(), text, streaming: false });
      for (const call of row.tool_calls || []) {
        const fn = call.function || {};
        let args = fn.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep string */ } }
        const it = { kind: 'tool', id: newItemId(), toolId: call.id, name: fn.name || call.name || 'tool', context: '', args, status: 'done', result: null };
        items.push(it);
        if (call.id) toolsByCallId.set(call.id, it);
      }
    } else if (role === 'tool') {
      const it = toolsByCallId.get(row.tool_call_id);
      if (it) { it.result = text; if (/^\s*\{?\s*"?error/i.test(text)) it.status = 'error'; }
    }
  }
  return items;
}
