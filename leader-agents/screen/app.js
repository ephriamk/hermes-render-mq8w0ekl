// app.js: views, routing and DOM. All server I/O goes through protocol.js.
import { Gateway, Conversation, CONNECT_URL, HttpError, basename } from './protocol.js';
import {
  renderMarkdown, toolLabel, toolDetails, APPROVAL_CHOICE_LABELS, errorCopy, friendlyModel,
  EFFORTS, friendlyTime, scheduleText, formatBytes, scrub,
} from './render.js';

const $ = (id) => document.getElementById(id);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid);
  return e;
};

const gw = new Gateway();
const state = {
  me: null,
  sessions: [],
  conv: null,
  pendingFiles: [],
  effort: 'medium',
  model: null,          // {model, provider}
  models: [],           // [{model, provider, label}]
  filesRoot: null,
  filesPath: null,
  skipRoute: null,
};

// ── boot (called at the end of this file, after every module-level const exists) ──
function boot() {
  if (!gw.loadToken()) { location.replace('/_eca/open'); return; }
  wireChrome();
  wireComposer();
  gw.on('status', renderConnStatus);
  gw.on('event', onGlobalEvent);
  gw.on('connected', () => { loadSessions(); loadModels(); });
  gw.on('reconnected', () => loadSessions());
  renderConnStatus(gw.state);
  gw.connect();
  loadMe();
  window.addEventListener('hashchange', route);
  route();
}

async function loadMe() {
  try { state.me = await gw.whoami(); } catch { state.me = null; }
  const name = (state.me && state.me.name) || '';
  const first = name.trim().split(/\s+/)[0] || '';
  $('greeting').textContent = greetingFor(first);
  $('account-name').textContent = name || 'Signed in';
  $('account-initial').textContent = (first[0] || '?').toUpperCase();
  const ok = state.me && state.me.claude_signed_in;
  $('account-claude').textContent = ok ? 'Claude is connected' : 'Claude is not connected';
  $('account-claude').dataset.ok = ok ? 'true' : 'false';
}

function greetingFor(first) {
  const hr = new Date().getHours();
  const part = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  return first ? `${part}, ${first}` : part;
}

function renderConnStatus(s) {
  const el = $('conn-status');
  el.dataset.state = s;
  el.textContent = s === 'reconnecting' || s === 'offline' ? 'Reconnecting…' : s === 'connecting' ? 'Connecting…' : '';
}

function onGlobalEvent(p) {
  if (!p) return;
  if (p.type === 'sessions.changed' || p.type === 'session.updated' || p.type === 'session.title') debounce('sessions', loadSessions, 400);
  if (p.type === 'cron.changed' && currentView() === 'scheduled') debounce('jobs', loadJobs, 400);
}

const timers = {};
function debounce(key, fn, ms) { clearTimeout(timers[key]); timers[key] = setTimeout(fn, ms); }

function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(timers.toast); timers.toast = setTimeout(() => { t.hidden = true; }, 3500);
}

// ── routing ──────────────────────────────────────────────────────────────
function currentView() {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/files')) return 'files';
  if (hash.startsWith('#/scheduled')) return 'scheduled';
  if (hash.startsWith('#/c/')) return 'chat';
  return 'home';
}

function route() {
  const hash = location.hash || '#/';
  if (state.skipRoute && hash === state.skipRoute) { state.skipRoute = null; markActive(); return; }
  closeDrawer();
  const view = currentView();
  for (const v of ['home', 'chat', 'files', 'scheduled']) $('view-' + v).hidden = v !== view;
  $('composer').hidden = !(view === 'home' || view === 'chat');
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === view || (a.dataset.nav === 'home' && view === 'chat');
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (view === 'home') startDraft();
  else if (view === 'chat') openConversation(decodeURIComponent(hash.slice(4)));
  else if (view === 'files') loadFiles(state.filesPath);
  else if (view === 'scheduled') loadJobs();
  markActive();
}

// ── conversations ────────────────────────────────────────────────────────
function setConversation(conv) {
  if (state.conv) state.conv.dispose();
  state.conv = conv;
  $('transcript').replaceChildren();
  itemEls.clear();
  $('activity').textContent = '';
  if (!conv) return;
  conv.on('change', scheduleRender);
  conv.on('activity', (a) => { $('activity').textContent = activityText(a); });
  conv.on('title', () => { $('chat-title').textContent = conv.title || ''; debounce('sessions', loadSessions, 300); });
  conv.on('created', (id) => {
    const target = '#/c/' + encodeURIComponent(id);
    state.skipRoute = target;
    history.replaceState(null, '', target);
    route(); // hits skipRoute, just updates highlights
    $('view-home').hidden = true; $('view-chat').hidden = false;
    debounce('sessions', loadSessions, 800);
  });
}

function startDraft() {
  setConversation(new Conversation(gw));
  $('chat-title').textContent = '';
  renderComposerState();
  focusPrompt();
}

async function openConversation(id) {
  if (state.conv && state.conv.sessionId === id) { renderTranscript(); return; }
  const conv = new Conversation(gw);
  setConversation(conv);
  const row = state.sessions.find((s) => s.id === id);
  $('chat-title').textContent = row ? sessionTitle(row) : '';
  $('transcript').append(h('p', { class: 'loading', text: 'Loading conversation…' }));
  try {
    await conv.open(id);
    if (conv.title) $('chat-title').textContent = conv.title;
  } catch (err) {
    if (state.conv !== conv) return;
    $('transcript').replaceChildren(h('div', { class: 'card card-error' },
      h('p', { class: 'card-title', text: 'This conversation could not be opened' }),
      h('p', { text: err instanceof HttpError && err.status === 404 ? 'It may have been removed.' : 'Check your connection and try again.' }),
      h('a', { class: 'btn', href: '#/' }, 'Start a new conversation')));
    return;
  }
  renderTranscript();
  scrollToBottom();
}

function sessionTitle(s) {
  return scrub(s.title || s.preview || 'New conversation').slice(0, 120);
}

function activityText(a) {
  if (a.type === 'tool.generating') return 'Getting ready to look something up…';
  if (a.type === 'status.update') return a.text ? scrub(a.text).slice(0, 120) : '';
  return 'Thinking…';
}

// ── transcript rendering ─────────────────────────────────────────────────
const itemEls = new Map(); // item.id -> {el, sig}
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderTranscript(); });
}

function renderTranscript() {
  const conv = state.conv;
  if (!conv) return;
  const box = $('transcript');
  const scroller = $('view-chat');
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
  box.querySelector('.loading')?.remove();
  const live = new Set();
  let prev = null;
  const lastAssistant = [...conv.items].reverse().find((i) => i.kind === 'assistant');
  for (const item of conv.items) {
    live.add(item.id);
    const sig = signature(item, conv, item === lastAssistant);
    let entry = itemEls.get(item.id);
    if (!entry || entry.sig !== sig) {
      const el = renderItem(item, conv, item === lastAssistant);
      if (entry) entry.el.replaceWith(el);
      entry = { el, sig };
      itemEls.set(item.id, entry);
    }
    const want = prev ? prev.nextSibling : box.firstChild;
    if (entry.el !== want) box.insertBefore(entry.el, want);
    prev = entry.el;
  }
  for (const [id, entry] of itemEls) if (!live.has(id)) { entry.el.remove(); itemEls.delete(id); }
  const waiting = conv.items.some((i) => (i.kind === 'approval' || i.kind === 'clarify') && (i.status === 'open' || i.status === 'sending'));
  if (waiting) $('activity').textContent = 'Waiting for your answer above.';
  else if (conv.running && !conv.items.some((i) => i.kind === 'assistant' && i.streaming)) {
    if (!$('activity').textContent || $('activity').textContent.startsWith('Waiting')) $('activity').textContent = 'Working on it…';
  } else if (!conv.running) $('activity').textContent = '';
  renderComposerState();
  if (nearBottom) scrollToBottom();
}

function signature(item, conv, isLastAnswer) {
  switch (item.kind) {
    case 'assistant': return `${item.text.length}|${item.streaming}|${isLastAnswer && !conv.running}`;
    case 'tool': return `${item.status}|${item.progress}|${item.result ? item.result.length : 0}`;
    case 'approval': case 'clarify': return `${item.status}|${item.error}`;
    case 'error': return `${conv.running}`;
    default: return '1';
  }
}

function renderItem(item, conv, isLastAnswer) {
  switch (item.kind) {
    case 'user':
      return h('div', { class: 'msg msg-user' }, h('div', { class: 'bubble bubble-user' }, h('p', { class: 'user-text', text: item.text })));
    case 'assistant': return renderAnswer(item, conv, isLastAnswer);
    case 'tool': return renderTool(item);
    case 'approval': return renderApproval(item, conv);
    case 'clarify': return renderClarify(item, conv);
    case 'error': return renderError(item, conv);
    case 'notice': return h('p', { class: 'notice', text: item.text });
    default: return h('div');
  }
}

function renderAnswer(item, conv, isLastAnswer) {
  const body = h('div', { class: 'md', 'aria-busy': item.streaming ? 'true' : 'false' });
  body.append(renderMarkdown(item.text));
  const actions = item.streaming ? null : h('div', { class: 'msg-actions' },
    h('button', { class: 'link-btn', type: 'button', onclick: (e) => copyText(item.text, e.currentTarget) }, 'Copy'),
    isLastAnswer && !conv.running && conv.lastUserText ? h('button', { class: 'link-btn', type: 'button', onclick: () => conv.retry() }, 'Retry') : null);
  return h('div', { class: 'msg msg-assistant' + (item.streaming ? ' is-streaming' : '') }, h('div', { class: 'bubble bubble-assistant' }, body), actions);
}

async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
  catch { btn.textContent = 'Could not copy'; }
  setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
}

function renderTool(item) {
  const label = toolLabel(item.name, item.status === 'running' ? 'running' : 'done');
  const statusWord = item.status === 'error' ? 'Did not work' : item.status === 'stopped' ? 'Stopped' : item.status === 'running' ? (item.progress ? scrub(item.progress) : '') : '';
  const d = toolDetails(item);
  const details = h('details', { class: 'tool tool-' + item.status },
    h('summary', { class: 'tool-summary' },
      h('span', { class: 'tool-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'tool-label', text: label }),
      statusWord ? h('span', { class: 'tool-state', text: statusWord }) : null),
    h('div', { class: 'tool-body' },
      d.inputs.length ? h('ul', { class: 'tool-inputs' }, d.inputs.map((x) => h('li', { text: x }))) : null,
      d.result ? h('pre', { class: 'tool-result' }, d.result) : h('p', { class: 'tool-empty', text: item.status === 'running' ? 'Still working…' : 'No details.' })));
  return details;
}

function renderApproval(item, conv) {
  const open = item.status === 'open' || item.status === 'sending';
  const card = h('div', { class: 'card card-approval', role: 'group', 'aria-label': 'Needs your OK' },
    h('p', { class: 'card-title', text: 'Your agent wants to go ahead' }),
    item.description ? h('p', { class: 'card-body', text: scrub(item.description) }) : null,
    item.command ? h('pre', { class: 'card-detail' }, scrub(item.command)) : null);
  if (open) {
    const row = h('div', { class: 'card-actions' });
    for (const c of item.choices) {
      row.append(h('button', {
        class: 'btn ' + (c === 'deny' ? 'btn-quiet' : c === 'once' ? 'btn-primary' : ''), type: 'button',
        disabled: item.status === 'sending', onclick: () => conv.answerApproval(item.id, c),
      }, APPROVAL_CHOICE_LABELS[c] || c));
    }
    card.append(row);
    if (item.error) card.append(h('p', { class: 'card-error-text', role: 'alert', text: item.error }));
  } else {
    card.append(h('p', { class: 'card-done', text: item.status === 'answered' ? (item.answer === 'deny' ? 'You said no.' : `You said: ${APPROVAL_CHOICE_LABELS[item.answer] || item.answer}.`) : 'This question is closed.' }));
  }
  return card;
}

function renderClarify(item, conv) {
  const open = item.status === 'open' || item.status === 'sending';
  const card = h('div', { class: 'card card-clarify', role: 'group', 'aria-label': 'Question for you' },
    h('p', { class: 'card-title', text: scrub(item.question) || 'A quick question' }));
  if (!open) {
    card.append(h('p', { class: 'card-done', text: item.status === 'answered' ? (item.answer ? `You answered: ${item.answer}` : 'You skipped this.') : 'This question is closed.' }));
    return card;
  }
  const form = h('form', { class: 'clarify-form' });
  const busy = item.status === 'sending';
  if (item.choices.length && item.multi) {
    const fs = h('fieldset', { class: 'choices' }, h('legend', { class: 'visually-hidden', text: 'Pick any that apply' }));
    item.choices.forEach((c, k) => fs.append(h('label', { class: 'choice' }, h('input', { type: 'checkbox', name: 'c', value: c, id: `${item.id}-${k}` }), ' ' + scrub(c))));
    form.append(fs, h('div', { class: 'card-actions' }, h('button', { class: 'btn btn-primary', type: 'submit', disabled: busy }, 'Send answer')));
    form.addEventListener('submit', (e) => { e.preventDefault(); conv.answerClarify(item.id, [...form.querySelectorAll('input:checked')].map((x) => x.value)); });
  } else if (item.choices.length) {
    const row = h('div', { class: 'card-actions' });
    item.choices.forEach((c) => row.append(h('button', { class: 'btn', type: 'button', disabled: busy, onclick: () => conv.answerClarify(item.id, c) }, scrub(c))));
    form.append(row);
  }
  const input = h('input', { class: 'input', type: 'text', 'aria-label': 'Your answer', placeholder: item.choices.length ? 'Or type something else' : 'Type your answer' });
  const freeRow = h('div', { class: 'clarify-free' }, input,
    h('button', { class: 'btn', type: 'button', disabled: busy, onclick: () => input.value.trim() && conv.answerClarify(item.id, input.value.trim()) }, 'Send'),
    h('button', { class: 'btn btn-quiet', type: 'button', disabled: busy, onclick: () => conv.answerClarify(item.id, '') }, 'Skip'));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (input.value.trim()) conv.answerClarify(item.id, input.value.trim()); } });
  form.append(freeRow);
  card.append(form);
  if (item.error) card.append(h('p', { class: 'card-error-text', role: 'alert', text: item.error }));
  return card;
}

function renderError(item, conv) {
  const copy = errorCopy(item);
  const card = h('div', { class: 'card card-error' + (item.layer === 'auth' ? ' card-auth' : ''), role: 'alert' },
    h('p', { class: 'card-title', text: copy.title }),
    copy.body ? h('p', { class: 'card-body', text: copy.body }) : null);
  const actions = h('div', { class: 'card-actions' });
  if (copy.action === 'reconnect') actions.append(h('a', { class: 'btn btn-primary', href: CONNECT_URL }, 'Reconnect Claude'));
  if (copy.action === 'retry' && conv.lastUserText) actions.append(h('button', { class: 'btn', type: 'button', disabled: conv.running, onclick: () => conv.retry() }, 'Try again'));
  if (actions.childNodes.length) card.append(actions);
  return card;
}

function scrollToBottom() {
  const scroller = $('view-chat');
  scroller.scrollTop = scroller.scrollHeight;
}

// ── composer ─────────────────────────────────────────────────────────────
function wireComposer() {
  const ta = $('prompt');
  const effort = $('effort');
  for (const e of EFFORTS) effort.append(h('option', { value: e.value }, e.label));
  effort.value = state.effort;
  effort.addEventListener('change', async () => {
    state.effort = effort.value;
    if (state.conv && state.conv.sessionId) {
      try { await state.conv.setEffort(state.effort); } catch { toast('Could not change effort right now.'); }
    }
  });
  $('model').addEventListener('change', async () => {
    const pick = state.models[+$('model').value];
    if (!pick) return;
    state.model = pick;
    if (state.conv && state.conv.sessionId) await applyModel(state.conv, pick);
  });

  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  $('stop-btn').addEventListener('click', () => state.conv && state.conv.stop());
  $('attach-input').addEventListener('change', (e) => {
    for (const f of e.target.files) {
      if (f.size > 16 * 1024 * 1024) { toast(`${f.name} is over 16 MB and was not added.`); continue; }
      state.pendingFiles.push(f);
    }
    e.target.value = '';
    renderAttachments();
  });
  renderStarters();
}

function autosize() {
  const ta = $('prompt');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 240) + 'px';
}

function focusPrompt() { if (!$('composer').hidden) $('prompt').focus(); }

function renderAttachments() {
  const box = $('attach-list');
  box.replaceChildren(...state.pendingFiles.map((f, k) => h('span', { class: 'chip' }, f.name,
    h('button', { class: 'chip-x', type: 'button', 'aria-label': `Remove ${f.name}`, onclick: () => { state.pendingFiles.splice(k, 1); renderAttachments(); } }, '×'))));
}

function renderComposerState() {
  const running = !!(state.conv && state.conv.running);
  $('stop-btn').hidden = !running;
  $('send-btn').textContent = running ? 'Queue' : 'Send';
  $('send-btn').title = running ? 'Sends after the current answer finishes' : '';
}

async function submit() {
  const ta = $('prompt');
  const text = ta.value.trim();
  const files = state.pendingFiles.slice();
  if (!text && !files.length) return;
  let conv = state.conv;
  if (!conv) { conv = new Conversation(gw); setConversation(conv); }
  ta.value = ''; autosize();
  state.pendingFiles = []; renderAttachments();
  if (currentView() === 'home') { $('view-home').hidden = true; $('view-chat').hidden = false; }
  try {
    if (!conv.sessionId) {
      await conv.create();
      if (state.effort !== 'medium') await conv.setEffort(state.effort).catch(() => {});
      if (state.model) await applyModel(conv, state.model);
    }
    await conv.send(text, { attachments: files });
  } catch (err) {
    console.warn('[agent] send failed', err);
    if (!conv.items.length) { ta.value = text; autosize(); }
    toast(gw.state === 'ready' ? 'That did not send. Try again.' : 'Not connected yet. Try again in a moment.');
  }
}

async function applyModel(conv, pick) {
  try {
    const r = await conv.setModel(pick.model, pick.provider);
    if (r && r.status === 'confirmation_required') {
      const ok = window.confirm(`${pick.label} uses more of your plan. Switch anyway?`);
      if (ok && r.confirm) await conv._mutate('model', { model: pick.model, provider: pick.provider, confirm: r.confirm }, true);
    }
  } catch { toast('Could not switch models right now.'); }
}

function renderStarters() {
  const starters = [
    { title: 'Club numbers', text: 'How are all four clubs doing month to date? Show sales, new EFT and PT against goal.' },
    { title: 'A report', text: 'Build me a one page report on yesterday\'s sales for every club.' },
    { title: 'My pay', text: 'What does my pay look like for the current pay period?' },
    { title: 'Weekly summary', text: 'Schedule a weekly summary of club numbers every Monday at 7 am.' },
  ];
  $('starters').replaceChildren(...starters.map((s) => h('li', {},
    h('button', { class: 'starter', type: 'button', onclick: () => { $('prompt').value = s.text; submit(); } },
      h('span', { class: 'starter-title', text: s.title }),
      h('span', { class: 'starter-text', text: s.text })))));
}

async function loadModels() {
  try {
    const opts = await gw.modelOptions();
    const seen = new Set();
    const list = [];
    for (const p of opts?.providers || []) {
      if (p.authenticated === false) continue;
      for (const m of [...(p.featured_models || []), ...(p.models || [])]) {
        const label = friendlyModel(m);
        if (!label || seen.has(label)) continue;
        seen.add(label);
        list.push({ model: m, provider: p.slug, label });
      }
    }
    state.models = list;
    const sel = $('model');
    if (list.length < 2) { sel.hidden = true; return; }
    sel.replaceChildren(...list.map((m, k) => h('option', { value: String(k) }, m.label)));
    const cur = list.findIndex((m) => m.model === opts.model);
    sel.value = String(cur >= 0 ? cur : 0);
    sel.hidden = false;
  } catch { $('model').hidden = true; }
}

// ── sidebar ──────────────────────────────────────────────────────────────
async function loadSessions() {
  const box = $('session-list');
  try {
    state.sessions = await gw.listSessions();
    renderSessions();
  } catch (err) {
    if (!state.sessions.length) box.replaceChildren(h('p', { class: 'empty', text: 'Could not load conversations.' }));
  } finally { box.setAttribute('aria-busy', 'false'); }
}

function renderSessions() {
  const q = $('session-search').value.trim().toLowerCase();
  const rows = state.sessions.filter((s) => !q || sessionTitle(s).toLowerCase().includes(q) || String(s.preview || '').toLowerCase().includes(q));
  const today = new Date().toDateString();
  const groups = { Today: [], Earlier: [] };
  for (const s of rows) {
    const t = s.last_active || s.started_at;
    (t && new Date(t * 1000).toDateString() === today ? groups.Today : groups.Earlier).push(s);
  }
  const box = $('session-list');
  const out = [];
  for (const [name, list] of Object.entries(groups)) {
    if (!list.length) continue;
    const gid = 'grp-' + name;
    out.push(h('h2', { class: 'group-title', id: gid, text: name }), h('ul', { class: 'sessions', 'aria-labelledby': gid }, list.map(sessionRow)));
  }
  if (!out.length) out.push(h('p', { class: 'empty', text: q ? 'No conversations match.' : 'No conversations yet.' }));
  box.replaceChildren(...out);
  markActive();
}

function sessionRow(s) {
  const li = h('li', { class: 'session', 'data-id': s.id });
  const link = h('a', { class: 'session-link', href: '#/c/' + encodeURIComponent(s.id), text: sessionTitle(s) });
  const moreId = 'more-' + s.id.replace(/[^\w-]/g, '');
  const menu = h('div', { class: 'menu session-menu', id: moreId, role: 'menu', hidden: true },
    h('button', { class: 'menu-item', role: 'menuitem', type: 'button', onclick: () => startRename(li, s) }, 'Rename'),
    h('button', { class: 'menu-item', role: 'menuitem', type: 'button', onclick: () => archive(s) }, 'Archive'));
  const more = h('button', { class: 'icon-btn more-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': moreId, 'aria-label': `More for ${sessionTitle(s)}` }, h('span', { 'aria-hidden': 'true' }, '⋯'));
  more.addEventListener('click', () => toggleMenu(more, menu));
  li.append(link, more, menu);
  return li;
}

function markActive() {
  const id = state.conv && state.conv.sessionId;
  document.querySelectorAll('.session').forEach((li) => {
    const a = li.querySelector('.session-link');
    if (li.dataset.id === id && currentView() === 'chat') a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

function startRename(li, s) {
  closeMenus();
  const input = h('input', { class: 'input rename-input', type: 'text', value: s.title || '', 'aria-label': 'New name', maxlength: '120' });
  const link = li.querySelector('.session-link');
  link.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const title = input.value.trim();
    input.replaceWith(link);
    if (save && title && title !== s.title) {
      link.textContent = title.slice(0, 120);
      try { await gw.renameSession(s.id, title); s.title = title; if (state.conv?.sessionId === s.id) $('chat-title').textContent = title; }
      catch { toast('Could not rename. Try again.'); link.textContent = sessionTitle(s); }
    }
    link.focus();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
}

async function archive(s) {
  closeMenus();
  if (!window.confirm(`Archive "${sessionTitle(s)}"? It will leave this list.`)) return;
  try {
    await gw.archiveSession(s.id, true);
    state.sessions = state.sessions.filter((x) => x.id !== s.id);
    renderSessions();
    toast('Archived.');
    if (state.conv?.sessionId === s.id) location.hash = '#/';
  } catch { toast('Could not archive. Try again.'); }
}

// ── files ────────────────────────────────────────────────────────────────
async function loadFiles(path) {
  const status = $('files-status');
  status.textContent = 'Loading…';
  try {
    const data = await gw.listFiles(path || undefined);
    if (!state.filesRoot) state.filesRoot = data.path;
    state.filesPath = data.path;
    const entries = data.entries.filter((e) => !e.name.startsWith('.') && !e.name.startsWith('__'));
    status.textContent = entries.length ? '' : 'This folder is empty.';
    renderCrumbs();
    $('file-list').replaceChildren(...entries.map(fileRow));
  } catch (err) {
    status.textContent = 'Could not load your files.';
    if (path && state.filesRoot && path !== state.filesRoot) { state.filesPath = null; }
  }
}

function relSegments() {
  const root = state.filesRoot || '';
  const cur = state.filesPath || root;
  if (!cur.startsWith(root)) return [];
  return cur.slice(root.length).split('/').filter(Boolean);
}

function renderCrumbs() {
  const segs = relSegments();
  const root = state.filesRoot;
  const items = [h('button', { class: 'crumb', type: 'button', onclick: () => loadFiles(root), 'aria-current': segs.length ? null : 'location' }, 'Home')];
  segs.forEach((seg, k) => {
    const target = root.replace(/\/$/, '') + '/' + segs.slice(0, k + 1).join('/');
    items.push(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'),
      h('button', { class: 'crumb', type: 'button', onclick: () => loadFiles(target), 'aria-current': k === segs.length - 1 ? 'location' : null }, seg));
  });
  $('crumbs').replaceChildren(...items);
}

function fileRow(e) {
  const meta = [e.isDirectory ? 'Folder' : formatBytes(e.size), e.mtime ? friendlyTime(e.mtime) : ''].filter(Boolean).join(' · ');
  return h('li', { class: 'file' + (e.isDirectory ? ' is-folder' : '') },
    e.isDirectory
      ? h('button', { class: 'file-name link-btn', type: 'button', onclick: () => loadFiles(e.path) }, basename(e.name))
      : h('span', { class: 'file-name', text: basename(e.name) }),
    h('span', { class: 'file-meta', text: meta }),
    e.isDirectory ? null : h('button', { class: 'btn btn-small', type: 'button', onclick: (ev) => download(e, ev.currentTarget), 'aria-label': `Download ${e.name}` }, 'Download'));
}

async function download(e, btn) {
  btn.disabled = true; btn.textContent = 'Downloading…';
  try {
    const blob = await gw.downloadFile(e.path);
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: basename(e.name) });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch { toast(`Could not download ${basename(e.name)}.`); }
  btn.disabled = false; btn.textContent = 'Download';
}

async function uploadFiles(files) {
  const status = $('files-status');
  const folder = state.filesPath || state.filesRoot;
  if (!folder) { toast('Open your files first.'); return; }
  for (const f of files) {
    status.textContent = `Uploading ${f.name}…`;
    try { await gw.uploadFile(folder, f); }
    catch (err) {
      const msg = err instanceof HttpError && err.status === 409 ? `${f.name} already exists.` : err instanceof HttpError && err.status === 413 ? `${f.name} is too large.` : `Could not upload ${f.name}.`;
      toast(msg);
    }
  }
  status.textContent = '';
  loadFiles(folder);
}

// ── scheduled ────────────────────────────────────────────────────────────
async function loadJobs() {
  const status = $('jobs-status');
  status.textContent = 'Loading…';
  try {
    const jobs = await gw.listJobs();
    status.textContent = '';
    if (!jobs.length) {
      $('job-list').replaceChildren(h('li', { class: 'empty-card' },
        h('p', { text: 'Nothing is scheduled yet.' }),
        h('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/'; setTimeout(() => { $('prompt').value = 'Schedule a weekly summary of club numbers every Monday at 7 am.'; focusPrompt(); autosize(); }, 50); } }, 'Ask for a weekly summary')));
      return;
    }
    $('job-list').replaceChildren(...jobs.map(jobRow));
  } catch { status.textContent = 'Could not load your schedules.'; }
}

function jobRow(j) {
  const paused = j.enabled === false || j.state === 'paused';
  const name = scrub(j.name || (j.prompt ? String(j.prompt).slice(0, 60) : 'Scheduled task'));
  const next = !paused && j.next_run_at ? `Next: ${friendlyTime(j.next_run_at)}` : paused ? 'Paused' : '';
  const last = j.last_error ? 'The last run had a problem.' : j.last_run_at ? `Last ran ${friendlyTime(j.last_run_at)}` : '';
  const toggle = h('button', { class: 'btn btn-small', type: 'button' }, paused ? 'Resume' : 'Pause');
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try { paused ? await gw.resumeJob(j.id) : await gw.pauseJob(j.id); loadJobs(); }
    catch { toast('Could not change that schedule.'); toggle.disabled = false; }
  });
  const del = h('button', { class: 'btn btn-small btn-quiet', type: 'button' }, 'Delete');
  del.addEventListener('click', async () => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try { await gw.deleteJob(j.id); loadJobs(); toast('Deleted.'); } catch { toast('Could not delete that schedule.'); }
  });
  return h('li', { class: 'job' + (paused ? ' is-paused' : '') },
    h('div', { class: 'job-main' },
      h('p', { class: 'job-name', text: name }),
      h('p', { class: 'job-when', text: scheduleText(j) }),
      h('p', { class: 'job-meta', text: [next, last].filter(Boolean).join(' · ') })),
    h('div', { class: 'job-actions' }, toggle, del));
}

// ── chrome: drawer, menus, sign out ──────────────────────────────────────
function wireChrome() {
  $('drawer-toggle').addEventListener('click', () => (document.body.classList.contains('drawer-open') ? closeDrawer() : openDrawer()));
  $('backdrop').addEventListener('click', closeDrawer);
  $('session-search').addEventListener('input', renderSessions);
  $('file-upload').addEventListener('change', (e) => { const files = [...e.target.files]; e.target.value = ''; uploadFiles(files); });
  $('account-btn').addEventListener('click', () => toggleMenu($('account-btn'), $('account-menu')));
  $('sign-out').addEventListener('click', () => gw.signOut());
  $('new-chat').addEventListener('click', (e) => {
    if ((location.hash || '#/') === '#/') { e.preventDefault(); route(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.querySelector('.menu:not([hidden])')) { closeMenus(true); return; }
      if (document.body.classList.contains('drawer-open')) closeDrawer(true);
    }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu') && !e.target.closest('[aria-haspopup="menu"]')) closeMenus();
  });
}

function toggleMenu(btn, menu) {
  const open = menu.hidden;
  closeMenus();
  if (!open) return;
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  menu.querySelector('.menu-item')?.focus();
  menu.onkeydown = (e) => {
    const items = [...menu.querySelectorAll('.menu-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    if (e.key === 'Tab') closeMenus();
  };
}

function closeMenus(refocus) {
  document.querySelectorAll('.menu:not([hidden])').forEach((m) => {
    m.hidden = true;
    const btn = document.querySelector(`[aria-controls="${m.id}"]`);
    if (btn) { btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus(); }
  });
}

function openDrawer() {
  document.body.classList.add('drawer-open');
  $('backdrop').hidden = false;
  $('drawer-toggle').setAttribute('aria-expanded', 'true');
  $('drawer-toggle').setAttribute('aria-label', 'Close conversations');
  $('new-chat').focus();
}

function closeDrawer(refocus) {
  if (!document.body.classList.contains('drawer-open')) return;
  document.body.classList.remove('drawer-open');
  $('backdrop').hidden = true;
  $('drawer-toggle').setAttribute('aria-expanded', 'false');
  $('drawer-toggle').setAttribute('aria-label', 'Open conversations');
  if (refocus) $('drawer-toggle').focus();
}

boot();
