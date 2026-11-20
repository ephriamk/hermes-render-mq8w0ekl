// Run: node test/protocol.test.mjs   (no packages needed)
// Drives protocol.js with a fake WebSocket, fake fetch and a fake clock, replaying the frame
// sequences from the protocol note: ready, create, submit, deltas, a tool call, an approval,
// a clarify, completion, an auth error, stop, a disconnect + replay + resume, a snapshot reset,
// unknown server requests and events, heartbeat, silence redial, and a signed-out ticket.

import assert from 'node:assert/strict';
import { Gateway, Conversation, sessionStorageKey, transcriptToItems } from '../protocol.js';
import { renderMarkdown, toolLabel, scrub, scheduleText, friendlyModel } from '../render.js';

const ORIGIN = 'https://eca-agents-trial.onrender.com';
const TOKEN = 'T'.repeat(43);
let passed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push('ok   ' + name); }
  catch (err) { results.push('FAIL ' + name + '\n     ' + (err.stack || err).toString().split('\n').slice(0, 4).join('\n     ')); process.exitCode = 1; }
}
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ── fake clock ──────────────────────────────────────────────────────────
function makeClock() {
  let now = 1_000_000; let nextId = 1; const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms, every: ms }); return id; },
    clearInterval: (id) => timers.delete(id),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let best = null;
        for (const [id, t] of timers) if (t.at <= end && (!best || t.at < best[1].at)) best = [id, t];
        if (!best) break;
        const [id, t] = best; now = t.at;
        if (t.every) t.at += t.every; else timers.delete(id);
        t.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

// ── fake server ─────────────────────────────────────────────────────────
function makeServer() {
  const sockets = [];
  const handlers = {};            // method -> (params, frame, ws) => result | {error}
  const sent = [];                // every client frame, parsed
  let ticketN = 0;
  let ticketStatus = 200;
  const fetchLog = [];
  const rest = {};                // 'GET /api/x' -> body

  class FakeWS {
    constructor(url, protocols) {
      this.url = url; this.protocols = protocols; this.readyState = 1; this.closed = null;
      sockets.push(this);
    }
    send(data) {
      const msg = JSON.parse(data);
      sent.push(msg);
      if (msg.id !== undefined && msg.method) {
        const h = handlers[msg.method];
        queueMicrotask(() => {
          if (this.readyState !== 1) return;
          if (msg.method === 'gateway.ping') return this.push({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
          if (!h) return;
          const out = h(msg.params, msg, this);
          if (out === undefined) return; // reply later by hand
          if (out && out.__error) this.push({ jsonrpc: '2.0', id: msg.id, error: out.__error });
          else this.push({ jsonrpc: '2.0', id: msg.id, result: out });
        });
      }
    }
    close(code = 1000) { this.readyState = 3; this.closed = code; }
    push(obj) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }); }
    event(type, payload, extra = {}) { this.push({ jsonrpc: '2.0', method: 'event', params: { type, payload, ...extra } }); }
    serverClose(code) { this.readyState = 3; this.onclose && this.onclose({ code, reason: '' }); }
  }

  async function fakeFetch(url, opts = {}) {
    const method = opts.method || 'GET';
    fetchLog.push({ url, method, headers: opts.headers || {}, body: opts.body });
    const path = url.split('?')[0];
    let status = 200; let body = null;
    if (path === '/api/webapp/socket-ticket') {
      status = ticketStatus;
      body = status === 200 ? { ticket: 'tk' + (++ticketN), ttl_seconds: 30 } : { detail: 'Unauthorized' };
    } else if (rest[`${method} ${path}`] !== undefined) {
      body = rest[`${method} ${path}`];
    } else { status = 404; body = { detail: 'Not found' }; }
    const text = body == null ? '' : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => body, blob: async () => text };
  }

  return {
    sockets, handlers, sent, fetchLog, rest, FakeWS, fakeFetch,
    get ws() { return sockets[sockets.length - 1]; },
    setTicketStatus(s) { ticketStatus = s; },
    lastSent(method) { return [...sent].reverse().find((m) => m.method === method); },
  };
}

function makeGateway() {
  const clock = makeClock();
  const server = makeServer();
  const store = new Map([[sessionStorageKey(ORIGIN, ''), TOKEN]]);
  const navigations = [];
  const logs = [];
  let u = 0;
  const gw = new Gateway({
    fetch: server.fakeFetch,
    WebSocket: server.FakeWS,
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
    location: { origin: ORIGIN, host: 'eca-agents-trial.onrender.com', protocol: 'https:' },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval, clearInterval: clock.clearInterval,
    now: clock.now, random: () => 0.5,
    uuid: () => 'uuid-' + (++u),
    navigate: (url) => navigations.push(url),
    log: (...a) => logs.push(a.map(String).join(' ')),
  });
  return { gw, clock, server, navigations, logs, store };
}

const READY = { skin: {}, change_events: true, heartbeat: true, replay_epoch: 'E1', session_authority: true };

function snapshot(extra = {}) {
  return { session_id: 's1', stored_session_id: 's1', messages: [], message_count: 0, running: false,
    authority_epoch: 12, replay_epoch: 'E1', last_sequence: 0, subscription_id: 'sub', revision: 1,
    execution_generation: 0, pending: [], prompts: [], open_requests: [], info: { title: null }, ...extra };
}

async function connected() {
  const ctx = makeGateway();
  const { gw, server } = ctx;
  server.handlers['client.capabilities'] = () => ({ server_requests: ['approval', 'clarify'] });
  server.handlers['session.create'] = () => snapshot();
  let adm = 0;
  server.handlers['prompt.submit'] = (p) => ({ admission_id: 'a' + (++adm), ref: { session_id: p.session_id }, sequence: adm, status: 'queued', outcome: null });
  gw.connect();
  await flush();
  server.ws.event('gateway.ready', READY);
  await flush();
  return ctx;
}

// ── tests ───────────────────────────────────────────────────────────────

await test('reads the token from sessionStorage and mints a ticket with the header', async () => {
  const { server, gw } = await connected();
  const t = server.fetchLog.find((f) => f.url.startsWith('/api/webapp/socket-ticket'));
  assert.equal(t.method, 'POST');
  assert.match(t.url, /socket=gateway/);
  assert.match(t.url, /profile=default/);
  assert.equal(t.headers['X-Hermes-Session-Token'], TOKEN);
  assert.equal(gw.state, 'ready');
});

await test('dials /api/ws with both subprotocols and no token in the URL', async () => {
  const { server } = await connected();
  assert.equal(server.ws.url, 'wss://eca-agents-trial.onrender.com/api/ws?native_dial=browser');
  assert.deepEqual(server.ws.protocols, ['hermes-gateway-v1', 'hermes-gateway-ticket.tk1']);
  assert.ok(!server.ws.url.includes(TOKEN));
});

await test('sends client.capabilities after gateway.ready', async () => {
  const { server } = await connected();
  const cap = server.lastSent('client.capabilities');
  assert.deepEqual(cap.params, { server_requests: true });
  assert.equal(cap.jsonrpc, '2.0');
});

await test('full turn: create, submit, deltas with replay dedup, tool, approval, clarify, completion', async () => {
  const { gw, server } = await connected();
  const conv = new Conversation(gw);
  await conv.send('How did Everett do yesterday?');
  await flush();
  const create = server.lastSent('session.create');
  assert.deepEqual(Object.keys(create.params).sort(), ['request_id', 'source']);
  assert.equal(create.params.source, 'gui');
  const submit = server.lastSent('prompt.submit');
  assert.deepEqual(Object.keys(submit.params).sort(), ['session_id', 'submission_id', 'text']);
  assert.equal(submit.params.session_id, 's1');
  assert.equal(conv.admissionId, 'a1');
  assert.equal(conv.running, true);

  const ws = server.ws;
  const ev = (type, payload, seq, extra = {}) => ws.event(type, payload, { session_id: 's1', seq, replay_epoch: 'E1', execution_generation: 5, admission_id: 'a1', ...extra });
  ev('session.info', { running: true, execution_generation: 5, revision: 2 }, 1);
  ev('message.start', {}, 2);
  ev('message.delta', { text: 'Yester', turn_id: 't1', segment: 0, offset: 0 }, 3);
  ev('message.delta', { text: 'day **Everett** ', turn_id: 't1', segment: 0, offset: 6 }, 4);
  // A replayed chunk with a fresh seq but an old offset must not double the text.
  ev('message.delta', { text: 'day **Everett** ', turn_id: 't1', segment: 0, offset: 6 }, 5);
  // A replayed frame with an old seq is dropped outright.
  ev('message.delta', { text: 'Yester', turn_id: 't1', segment: 0, offset: 0 }, 3);
  ev('message.delta', { text: null, turn_id: 't1', segment: 0 }, 6);
  ev('tool.start', { tool_id: 'call_1', name: 'eca_club_dashboard', context: 'club 06902', args: { club_number: '06902' } }, 7);
  ev('tool.progress', { tool_id: 'call_1', name: 'eca_club_dashboard', progress: 1, total: 2 }, 8);
  ev('tool.complete', { tool_id: 'call_1', name: 'eca_club_dashboard', args: { club_number: '06902' }, is_error: false, result: '{"nb":1200}', duration_s: 0.4 }, 9);
  ev('approval.request', { kind: 'approval', prompt_id: 'p1', execution_generation: 5, command: 'export report', description: 'Save a report', choices: ['once', 'deny', 'session', 'always'], timeout_s: 300 }, 10);
  await flush();

  assert.equal(conv.generation, 5);
  assert.equal(conv.revision, 2);
  const asst = conv.items.filter((i) => i.kind === 'assistant');
  assert.equal(asst.length, 1);
  assert.equal(asst[0].text, 'Yesterday **Everett** ');
  assert.equal(asst[0].streaming, false, 'null delta seals the bubble');
  const tool = conv.items.find((i) => i.kind === 'tool');
  assert.equal(tool.status, 'done');
  assert.equal(tool.result, '{"nb":1200}');
  const appr = conv.items.find((i) => i.kind === 'approval');
  assert.equal(appr.status, 'open');
  assert.deepEqual(appr.choices, ['once', 'deny', 'session', 'always']);

  server.handlers['approval.respond'] = (p) => ({ status: 'resolved', prompt_id: p.prompt_id });
  await conv.answerApproval(appr.id, 'once');
  const ar = server.lastSent('approval.respond');
  assert.deepEqual(ar.params, { session_id: 's1', execution_generation: 5, prompt_id: 'p1', choice: 'once' });
  assert.equal(appr.status, 'answered');
  ev('approval.settled', { prompt_id: 'p1', execution_generation: 5 }, 11);

  ev('clarify.request', { kind: 'clarify', prompt_id: 'p2', execution_generation: 5, question: 'Which club?', choices: ['Everett', 'Ballinger'], multi_select: false }, 12);
  await flush();
  const cl = conv.items.find((i) => i.kind === 'clarify');
  server.handlers['clarify.respond'] = (p) => ({ status: 'resolved', prompt_id: p.prompt_id });
  await conv.answerClarify(cl.id, 'Ballinger');
  assert.deepEqual(server.lastSent('clarify.respond').params, { session_id: 's1', execution_generation: 5, prompt_id: 'p2', answer: 'Ballinger' });
  ev('clarify.settled', { prompt_id: 'p2', execution_generation: 5 }, 13);

  ev('message.delta', { text: 'Done.', turn_id: 't1', segment: 1, offset: 0 }, 14);
  ev('message.complete', { text: '', content: '', admission_id: 'a1', outcome: 'completed', status: 'complete', persisted_turn: { submission_id: submit.params.submission_id } }, 15);
  ev('session.info', { running: false, execution_generation: 5, revision: 3 }, 16);
  await flush();

  const texts = conv.items.filter((i) => i.kind === 'assistant').map((i) => i.text);
  assert.deepEqual(texts, ['Yesterday **Everett** ', 'Done.'], 'empty completion text keeps streamed text');
  assert.equal(conv.running, false);
  assert.equal(conv.admissionId, null);
  assert.equal(conv.lastSeq, 16);
  assert.deepEqual(conv.items.map((i) => i.kind), ['user', 'assistant', 'tool', 'approval', 'clarify', 'assistant']);
});

await test('completion text is shown when nothing streamed', async () => {
  const { gw, server } = await connected();
  const conv = new Conversation(gw);
  await conv.send('hi');
  server.ws.event('message.complete', { text: 'Hello there', status: 'complete', outcome: 'completed' }, { session_id: 's1', seq: 1, replay_epoch: 'E1' });
  await flush();
  assert.equal(conv.items.at(-1).text, 'Hello there');
});

await test('auth error surfaces as an auth error card', async () => {
  const { gw, server } = await connected();
  const conv = new Conversation(gw);
  await conv.send('my pay');
  server.ws.event('message.complete', { text: 'Provider rejected the credential', status: 'error', outcome: 'failed',
    error_surface: { layer: 'auth', code: 'auth', retryable: false, provider: 'anthropic', auth_kind: 'oauth' } },
  { session_id: 's1', seq: 1, replay_epoch: 'E1' });
  await flush();
  const err = conv.items.at(-1);
  assert.equal(err.kind, 'error');
  assert.equal(err.layer, 'auth');
  assert.equal(err.authKind, 'oauth');
  assert.equal(conv.running, false);
});

await test('stop: prompt.cancel with the admission id, then interrupted completion', async () => {
  const { gw, server } = await connected();
  const conv = new Conversation(gw);
  await conv.send('long report');
  server.handlers['prompt.cancel'] = () => ({ status: 'terminal', outcome: 'cancelled' });
  await conv.stop();
  assert.deepEqual(server.lastSent('prompt.cancel').params, { session_id: 's1', admission_id: 'a1' });
  server.ws.event('message.complete', { text: '', status: 'interrupted', outcome: 'cancelled' }, { session_id: 's1', seq: 1, replay_epoch: 'E1' });
  await flush();
  assert.equal(conv.running, false);
  assert.equal(conv.items.at(-1).kind, 'notice');
});

await test('stop without an admission id falls back to session.interrupt with the generation', async () => {
  const { gw, server } = await connected();
  const conv = new Conversation(gw);
  server.handlers['session.resume'] = () => snapshot({ running: true, execution_generation: 7 });
  server.rest['GET /api/sessions/s1/messages'] = { session_id: 's1', messages: [{ role: 'user', content: 'hi', id: 1 }] };
  await conv.open('s1');
  server.handlers['session.interrupt'] = () => ({ execution_state: 'running' });
  await conv.stop();
  assert.deepEqual(server.lastSent('session.interrupt').params, { session_id: 's1', execution_generation: 7 });
});

await test('unknown server request is answered with -32601; unknown event does not crash', async () => {
  const { gw, server, logs } = await connected();
  const conv = new Conversation(gw);
  await conv.send('x');
  server.ws.push({ jsonrpc: '2.0', id: 'srq-1a2b', method: 'sudo', params: { session_id: 's1', command: 'x' } });
  server.ws.event('brand.new.event', { what: 1 }, { session_id: 's1', seq: 1, replay_epoch: 'E1' });
  server.ws.push({ nonsense: true });
  server.ws.onmessage({ data: 'not json' });
  await flush();
  const reply = server.sent.find((m) => m.id === 'srq-1a2b');
  assert.equal(reply.error.code, -32601);
  assert.ok(logs.some((l) => l.includes('unhandled event brand.new.event')));
});

await test('request errors come back as RpcError with the reason', async () => {
  const { gw, server } = await connected();
  server.handlers['session.resume'] = () => ({ __error: { code: 4001, message: 'not_found', data: { reason: 'not_found' } } });
  await assert.rejects(gw.request('session.resume', { session_id: 'nope' }), (e) => e.reason === 'not_found' && e.code === 4001);
});

await test('disconnect: backoff, fresh ticket, events.since replay, then session.resume', async () => {
  const { gw, server, clock } = await connected();
  const conv = new Conversation(gw);
  await conv.send('report');
  const ev = (ws, type, payload, seq) => ws.event(type, payload, { session_id: 's1', seq, replay_epoch: 'E1', execution_generation: 5 });
  ev(server.ws, 'message.delta', { text: 'Part one. ', turn_id: 't1', segment: 0, offset: 0 }, 1);
  await flush();
  const statuses = [];
  gw.on('status', (s) => statuses.push(s));

  server.ws.serverClose(1006);
  await flush();
  assert.equal(gw.state, 'reconnecting');
  assert.equal(server.sockets.length, 1);

  server.handlers['session.events.since'] = (p) => {
    assert.deepEqual(p, { session_id: 's1', last_seen: 1, replay_epoch: 'E1' });
    return { events: [
      { type: 'message.delta', session_id: 's1', seq: 1, replay_epoch: 'E1', payload: { text: 'Part one. ', turn_id: 't1', segment: 0, offset: 0 } },
      { type: 'message.delta', session_id: 's1', seq: 2, replay_epoch: 'E1', payload: { text: 'Part two.', turn_id: 't1', segment: 0, offset: 10 } },
    ], latest_seq: 2, replay_epoch: 'E1', truncated: false, snapshot_required: false };
  };
  server.handlers['session.resume'] = (p) => { assert.deepEqual(p, { session_id: 's1', omit_messages: true }); return snapshot({ running: true, execution_generation: 5, last_sequence: 2 }); };

  await clock.advance(1000); // backoff 500ms * jitter
  assert.equal(server.sockets.length, 2, 'redialed');
  assert.deepEqual(server.ws.protocols, ['hermes-gateway-v1', 'hermes-gateway-ticket.tk2'], 'new one-use ticket');
  server.ws.event('gateway.ready', READY);
  await flush(10);
  assert.equal(gw.state, 'ready');
  assert.ok(statuses.includes('reconnecting') && statuses.includes('ready'));
  const since = server.sent.findIndex((m) => m.method === 'session.events.since');
  const resume = server.sent.findIndex((m) => m.method === 'session.resume');
  assert.ok(since >= 0 && resume > since, 'events.since before resume');
  const asst = conv.items.filter((i) => i.kind === 'assistant');
  assert.equal(asst.length, 1);
  assert.equal(asst[0].text, 'Part one. Part two.');
  assert.equal(conv.running, true);
  // live events keep flowing on the new socket
  ev(server.ws, 'message.complete', { text: '', status: 'complete', outcome: 'completed' }, 3);
  await flush();
  assert.equal(conv.running, false);
});

await test('reconnect with snapshot_required reloads the transcript over REST', async () => {
  const { gw, server, clock } = await connected();
  const conv = new Conversation(gw);
  await conv.send('report');
  server.ws.event('message.delta', { text: 'old', turn_id: 't', segment: 0, offset: 0 }, { session_id: 's1', seq: 4, replay_epoch: 'E1' });
  await flush();
  server.handlers['session.events.since'] = () => ({ events: [], snapshot_required: true, replay_epoch: 'E2' });
  server.handlers['session.resume'] = () => snapshot({ replay_epoch: 'E2', last_sequence: 9, running: false });
  server.rest['GET /api/sessions/s1/messages'] = { session_id: 's1', messages: [
    { id: 1, role: 'user', content: 'report' },
    { id: 2, role: 'assistant', content: 'Here it is.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'eca_club_dashboard', arguments: '{"club_number":"40054"}' } }] },
    { id: 3, role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
    { id: 4, role: 'system', display_kind: 'hidden', content: 'hidden row' },
  ] };
  server.ws.serverClose(1011);
  await clock.advance(1000);
  server.ws.event('gateway.ready', READY);
  await flush(10);
  const msgFetch = server.fetchLog.find((f) => f.url.startsWith('/api/sessions/s1/messages'));
  assert.ok(msgFetch, 'transcript re-read');
  assert.match(msgFetch.url, /order=latest/);
  assert.deepEqual(conv.items.map((i) => i.kind), ['user', 'assistant', 'tool']);
  assert.equal(conv.items[2].result, '{"ok":true}');
  assert.equal(conv.replayEpoch, 'E2');
  assert.equal(conv.lastSeq, 9);
  assert.equal(conv.running, false);
});

await test('heartbeat pings every 15s; 45s of silence forces a redial', async () => {
  const { gw, server, clock } = await connected();
  await clock.advance(15000);
  const ping = server.sent.find((m) => m.method === 'gateway.ping');
  assert.ok(ping);
  assert.equal(ping.id, 'heartbeat-1');
  // Stop the fake server answering anything: silence.
  server.ws.readyState = 1;
  const silentWs = server.ws;
  silentWs.send = () => {};
  await clock.advance(62000); // checked every 15s, so the redial lands between 45s and 60s of silence
  assert.ok(server.sockets.length >= 2, 'redialed after silence');
  assert.notEqual(server.ws, silentWs);
  void gw;
});

await test('a 401 on the ticket sends the browser back through sign-in', async () => {
  const { gw, server, clock, navigations } = await connected();
  server.setTicketStatus(401);
  server.ws.serverClose(4401);
  await clock.advance(2000);
  assert.deepEqual(navigations, ['/_eca/open']);
  assert.equal(gw.state, 'signed-out');
});

await test('missing token goes straight to /_eca/open without any request', async () => {
  const ctx = makeGateway();
  ctx.store.clear();
  await ctx.gw.connect();
  assert.deepEqual(ctx.navigations, ['/_eca/open']);
  assert.equal(ctx.server.fetchLog.length, 0);
});

await test('resume restores open approval cards from prompts', async () => {
  const { gw, server } = await connected();
  server.rest['GET /api/sessions/s1/messages'] = { session_id: 's1', messages: [] };
  server.handlers['session.resume'] = () => snapshot({ running: true, execution_generation: 3,
    prompts: [{ kind: 'approval', prompt_id: 'pp', execution_generation: 3, command: 'x', choices: ['once', 'deny'] }] });
  const conv = new Conversation(gw);
  await conv.open('s1');
  const card = conv.items.find((i) => i.kind === 'approval');
  assert.equal(card.promptId, 'pp');
  assert.equal(card.generation, 3);
});

await test('events for another session are ignored', async () => {
  const { gw, server } = await connected();
  const conv = new Conversation(gw);
  await conv.send('x');
  server.ws.event('message.delta', { text: 'not mine' }, { session_id: 'other', seq: 1 });
  await flush();
  assert.equal(conv.items.filter((i) => i.kind === 'assistant').length, 0);
});

await test('REST rename uses mutation-snapshot then PATCH with identity', async () => {
  const { gw, server } = await connected();
  server.rest['GET /api/sessions/s1/mutation-snapshot'] = { session_id: 's1', exists: true, runtime_revision: 10, runtime_generation: 5 };
  server.rest['PATCH /api/sessions/s1'] = { ok: true };
  await gw.renameSession('s1', 'Weekly sales');
  const patch = server.fetchLog.find((f) => f.method === 'PATCH');
  const body = JSON.parse(patch.body);
  assert.equal(body.title, 'Weekly sales');
  assert.equal(body.expected_revision, 10);
  assert.equal(body.expected_generation, 5);
  assert.ok(body.request_id);
  assert.equal(patch.headers['X-Hermes-Session-Token'], TOKEN);
});

await test('transcript rows: display_content, @file refs and failed turns', async () => {
  const items = transcriptToItems([
    { role: 'user', content: '@file:/home/u/uploads/budget.xlsx\n\nCheck this' },
    { role: 'assistant', content: 'raw', display_content: 'shown' },
    { role: 'assistant', display_kind: 'failed_turn', content: '', display_metadata: { error: 'nope', error_surface: { layer: 'auth', auth_kind: 'oauth' } } },
  ]);
  assert.equal(items[0].text, '[budget.xlsx]\n\nCheck this');
  assert.equal(items[1].text, 'shown');
  assert.equal(items[2].kind, 'error');
  assert.equal(items[2].layer, 'auth');
});

// ── render helpers (tiny fake DOM) ──────────────────────────────────────
function fakeDoc() {
  class Node {
    constructor(tag, text) { this.tagName = tag; this.children = []; this._text = text ?? ''; this.dataset = {}; this.style = {}; this.attrs = {}; }
    appendChild(c) { if (c.tagName === '#frag') this.children.push(...c.children); else this.children.push(c); return c; }
    set textContent(v) { this.children = []; this._text = String(v); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    get innerHTML() { throw new Error('innerHTML not allowed'); }
  }
  return {
    createElement: (t) => new Node(t.toUpperCase()),
    createTextNode: (t) => new Node('#text', t),
    createDocumentFragment: () => new Node('#frag'),
  };
}
const walk = (n, out = []) => { out.push(n); n.children.forEach((c) => walk(c, out)); return out; };

await test('markdown: raw HTML stays text, unsafe links are not links, safe links open safely', async () => {
  const doc = fakeDoc();
  const frag = renderMarkdown('Hi <script>alert(1)</script> [bad](javascript:alert(1)) [good](https://x.com/a) **b**\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n\n```\n<b>x</b>\n```', doc);
  const nodes = walk(frag);
  assert.ok(!nodes.some((n) => n.tagName === 'SCRIPT'));
  const links = nodes.filter((n) => n.tagName === 'A');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://x.com/a');
  assert.equal(links[0].rel, 'noopener noreferrer');
  assert.equal(links[0].target, '_blank');
  assert.ok(nodes.some((n) => n.tagName === 'STRONG'));
  assert.ok(nodes.some((n) => n.tagName === 'TABLE'));
  assert.ok(frag.textContent.includes('<script>alert(1)</script>'));
  assert.ok(nodes.some((n) => n.tagName === 'PRE' && n.textContent.includes('<b>x</b>')));
});

await test('labels: tool names, scrubbed paths and names, schedules, models', async () => {
  assert.equal(toolLabel('eca_club_dashboard'), 'Looked up the club dashboard');
  assert.equal(toolLabel('mcp_eca_club_dashboard'), 'Looked up the club dashboard');
  assert.equal(toolLabel('eca_club_dashboard', 'running'), 'Looking up the club dashboard…');
  assert.equal(toolLabel('terminal'), 'Ran a step');
  assert.equal(toolLabel('eca_get_membership_mix'), 'Looked up membership mix');
  assert.equal(scrub('saved to /home/ceo/.hermes/reports/q3.pdf by Hermes'), 'saved to q3.pdf by agent');
  assert.equal(scheduleText({ schedule: { kind: 'cron', expr: '0 7 * * 1-5' } }), 'Weekdays at 7 am');
  assert.equal(scheduleText({ schedule: { kind: 'cron', expr: '30 9 * * 1' } }), 'Every Monday at 9:30 am');
  assert.equal(scheduleText({ schedule_display: 'every monday 9am' }), 'Every monday 9am');
  assert.equal(friendlyModel('claude-opus-4-1'), 'Opus - deepest');
  assert.equal(friendlyModel('gpt-x'), null);
});

console.log(results.join('\n'));
console.log(`\n${passed}/${results.length} passed`);
