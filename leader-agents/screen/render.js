// render.js: safe markdown to DOM, plus the plain-English labels the screen shows.
// Model text never goes through innerHTML. Every node is built with createElement / textContent.

// ── markdown ─────────────────────────────────────────────────────────────

const SAFE_URL = /^(https?:|mailto:)/i;

export function renderMarkdown(src, doc = document) {
  const frag = doc.createDocumentFragment();
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const el = (tag, cls) => { const e = doc.createElement(tag); if (cls) e.className = cls; return e; };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^\s*(```|~~~)\s*([\w+-]*)\s*$/);
    if (fence) {
      const close = fence[1];
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) { buf.push(lines[i]); i++; }
      i++; // closing fence (or end while streaming)
      const pre = el('pre', 'md-pre');
      const code = el('code');
      if (fence[2]) code.dataset.lang = fence[2];
      code.textContent = buf.join('\n');
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    if (!line.trim()) { i++; continue; }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(6, h[1].length + 1); // h1 in chat reads as h2
      const e = el('h' + level, 'md-h');
      inline(h[2], e, doc);
      frag.appendChild(e);
      i++; continue;
    }

    // rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { frag.appendChild(el('hr')); i++; continue; }

    // table: header row + separator row
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const aligns = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      const wrap = el('div', 'md-table-wrap');
      const table = el('table', 'md-table');
      const thead = el('thead'); const tr = el('tr');
      cells(line).forEach((c, k) => { const th = el('th'); if (aligns[k]) th.style.textAlign = aligns[k]; inline(c, th, doc); tr.appendChild(th); });
      thead.appendChild(tr); table.appendChild(thead);
      const tbody = el('tbody');
      i += 2;
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        const r = el('tr');
        cells(lines[i]).forEach((c, k) => { const td = el('td'); if (aligns[k]) td.style.textAlign = aligns[k]; inline(c, td, doc); r.appendChild(td); });
        tbody.appendChild(r); i++;
      }
      table.appendChild(tbody); wrap.appendChild(table); frag.appendChild(wrap);
      continue;
    }

    // blockquote
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      const bq = el('blockquote', 'md-quote');
      bq.appendChild(renderMarkdown(buf.join('\n'), doc));
      frag.appendChild(bq);
      continue;
    }

    // lists
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const list = el(ordered ? 'ol' : 'ul', 'md-list');
      if (ordered) { const start = parseInt(li[2], 10); if (start > 1) list.start = start; }
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m || /\d/.test(m[2]) !== ordered) break;
        const item = el('li');
        let body = m[3];
        const task = body.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) { item.className = 'md-task'; const box = el('span', 'md-check'); box.textContent = task[1].trim() ? '[x] ' : '[ ] '; item.appendChild(box); body = task[2]; }
        inline(body, item, doc);
        i++;
        // indented continuation / nested lines
        const sub = [];
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*$/.test(lines[i])) { sub.push(lines[i].replace(/^\s{2,4}/, '')); i++; }
        if (sub.length) item.appendChild(renderMarkdown(sub.join('\n'), doc));
        list.appendChild(item);
      }
      frag.appendChild(list);
      continue;
    }

    // paragraph
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(\s*(```|~~~)|#{1,6}\s|\s*>|\s*([-*+]|\d+[.)])\s+)/.test(lines[i])
      && !(/\|/.test(lines[i]) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]))) {
      buf.push(lines[i]); i++;
    }
    const p = el('p', 'md-p');
    buf.forEach((b, k) => { if (k) p.appendChild(doc.createElement('br')); inline(b, p, doc); });
    frag.appendChild(p);
  }
  return frag;
}

// Inline: code spans, links, autolinks, bold, italic, strikethrough. Text nodes only.
const INLINE_RE = /(`+)([\s\S]*?[^`])\1(?!`)|\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\s][\s\S]*?)\*|(?<![\w])_([^_\s][\s\S]*?)_(?![\w])/;

export function inline(text, parent, doc = document) {
  let rest = String(text || '');
  while (rest) {
    const m = rest.match(INLINE_RE);
    if (!m) { parent.appendChild(doc.createTextNode(rest)); break; }
    if (m.index) parent.appendChild(doc.createTextNode(rest.slice(0, m.index)));
    if (m[1]) {
      const c = doc.createElement('code'); c.className = 'md-code'; c.textContent = m[2].trim() ? m[2] : m[2]; parent.appendChild(c);
    } else if (m[3] !== undefined) {
      parent.appendChild(link(m[4], m[3], doc, true));
    } else if (m[5]) {
      parent.appendChild(link(m[5], m[5], doc, false));
    } else {
      const tag = m[6] !== undefined || m[7] !== undefined ? 'strong' : m[8] !== undefined ? 's' : 'em';
      const inner = m[6] ?? m[7] ?? m[8] ?? m[9] ?? m[10] ?? '';
      const e = doc.createElement(tag);
      inline(inner, e, doc);
      parent.appendChild(e);
    }
    rest = rest.slice(m.index + m[0].length);
  }
}

function link(href, label, doc, labelIsMarkdown) {
  if (!SAFE_URL.test(href)) {
    const span = doc.createElement('span');
    if (labelIsMarkdown) inline(label, span, doc); else span.textContent = label;
    return span;
  }
  const a = doc.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  if (labelIsMarkdown) inline(label, a, doc); else a.textContent = label;
  return a;
}

// ── words we never show ─────────────────────────────────────────────────

// Strip host paths down to file names, and scrub product names from server strings we display.
export function scrub(text) {
  return String(text ?? '')
    .replace(/(?:file:\/\/)?(?:\/[\w.@~+-]+){2,}\/?/g, (m) => {
      const parts = m.replace(/\/$/, '').split('/');
      return parts[parts.length - 1] || m;
    })
    .replace(/\b(hermes|nous(?:\s*research)?|directsdk)\b/gi, 'agent');
}

// ── tool labels ──────────────────────────────────────────────────────────

const TOOL_LABELS = {
  // ECA data tools
  club_dashboard: 'Looked up the club dashboard',
  club_numbers: 'Looked up club numbers',
  club_totals: 'Looked up club totals',
  stats: 'Looked up club stats',
  sales: 'Looked up sales',
  sales_detail: 'Looked up sales details',
  my_pay: 'Looked up your pay',
  pay: 'Looked up pay',
  payroll: 'Looked up payroll',
  attrition: 'Looked up attrition',
  kpi: 'Looked up KPI goals',
  kpi_goals: 'Looked up KPI goals',
  employees: 'Looked up the staff list',
  roster: 'Looked up the roster',
  guests: 'Looked up guest traffic',
  report: 'Built a report',
  // general agent tools
  terminal: 'Ran a step',
  execute_code: 'Ran a calculation',
  process: 'Checked a running step',
  read_file: 'Read a file',
  write_file: 'Saved a file',
  patch: 'Edited a file',
  search_files: 'Searched files',
  web_search: 'Searched the web',
  web_extract: 'Read a web page',
  browser_navigate: 'Opened a web page',
  vision_analyze: 'Looked at an image',
  image_generate: 'Made an image',
  todo: 'Updated the task list',
  memory: 'Updated its notes',
  session_search: 'Searched past conversations',
  skill_view: 'Checked how to do this',
  skills_list: 'Checked what it can do',
  cronjob: 'Set up a schedule',
  schedule_cronjob: 'Set up a schedule',
  list_cronjobs: 'Checked your schedules',
  remove_cronjob: 'Removed a schedule',
  send_message: 'Sent a message',
  delegate_task: 'Handed off part of the work',
  clarify: 'Asked you a question',
  text_to_speech: 'Made audio',
};

export function toolLabel(name, status = 'done') {
  let n = String(name || '').trim();
  // mcp_<server>_<tool>, mcp__server__tool, eca_<tool>, eca-<tool>
  n = n.replace(/^mcp_+[a-z0-9-]+?_+(?=[a-z])/i, '');
  n = n.replace(/^eca[_-]/i, '').replace(/-/g, '_').toLowerCase();
  let label = TOOL_LABELS[n];
  if (!label && n.startsWith('browser_')) label = 'Used the web browser';
  if (!label) {
    const words = n.replace(/^(get|fetch|read|query|list|lookup|search)_/, '').replace(/_/g, ' ').trim();
    label = /^(get|fetch|read|query|list|lookup|search)_/.test(n) ? `Looked up ${words || 'some data'}` : `Used ${words || 'a tool'}`;
  }
  if (status === 'running') return presentTense(label);
  return label;
}

function presentTense(label) {
  return label
    .replace(/^Looked up/, 'Looking up').replace(/^Ran/, 'Running').replace(/^Read/, 'Reading')
    .replace(/^Saved/, 'Saving').replace(/^Edited/, 'Editing').replace(/^Searched/, 'Searching')
    .replace(/^Opened/, 'Opening').replace(/^Looked at/, 'Looking at').replace(/^Made/, 'Making')
    .replace(/^Updated/, 'Updating').replace(/^Checked/, 'Checking').replace(/^Set up/, 'Setting up')
    .replace(/^Removed/, 'Removing').replace(/^Sent/, 'Sending').replace(/^Handed off/, 'Handing off')
    .replace(/^Built/, 'Building').replace(/^Used/, 'Using').replace(/^Asked/, 'Asking') + '…';
}

// Tool details: arguments and result, scrubbed and trimmed.
export function toolDetails(item) {
  const out = [];
  if (item.args && typeof item.args === 'object') {
    for (const [k, v] of Object.entries(item.args)) {
      if (/token|secret|password|key/i.test(k)) continue;
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      out.push(`${humanKey(k)}: ${scrub(val).slice(0, 300)}`);
    }
  } else if (typeof item.args === 'string' && item.args) {
    out.push(scrub(item.args).slice(0, 300));
  }
  let result = item.result;
  if (result != null && typeof result !== 'string') { try { result = JSON.stringify(result, null, 2); } catch { result = String(result); } }
  return { inputs: out, result: result ? scrub(result).slice(0, 4000) + (result.length > 4000 ? '\n…' : '') : '' };
}

function humanKey(k) { return String(k).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()); }

// ── approvals, errors, models, schedules ────────────────────────────────

export const APPROVAL_CHOICE_LABELS = {
  once: 'Allow once',
  session: 'Allow for this conversation',
  always: 'Always allow',
  deny: 'Do not allow',
};

export function errorCopy(item) {
  switch (item.layer) {
    case 'auth':
      return { title: 'Your Claude sign-in needs a refresh', body: 'Reconnect Claude, then try your question again.', action: 'reconnect' };
    case 'billing':
      if (item.code === 'usage_window') {
        return { title: 'You have reached your usage limit for now', body: item.resetsAt ? `It resets ${friendlyTime(item.resetsAt)}.` : 'It resets soon. Try again later.', action: null };
      }
      return { title: 'Your Claude plan is out of credit', body: 'Check your Claude plan, then try again.', action: null };
    case 'streaming':
      return { title: 'The answer was cut off', body: 'The connection dropped partway through.', action: 'retry' };
    case 'send':
      return { title: 'Not sent', body: item.text, action: 'retry' };
    case 'disk':
      return { title: 'Your workspace is full', body: 'Remove some files, then try again.', action: null };
    case 'provider':
    case 'endpoint':
    case 'gateway':
    default:
      return { title: 'Something went wrong', body: item.retryable === false ? 'This one cannot be retried as is. Try rephrasing.' : 'Try again in a moment.', action: item.retryable === false ? null : 'retry' };
  }
}

export function friendlyModel(id) {
  const s = String(id || '').toLowerCase();
  if (s.includes('opus')) return 'Opus - deepest';
  if (s.includes('sonnet')) return 'Sonnet - fast';
  if (s.includes('haiku')) return 'Haiku - quickest';
  return null; // anything else is not offered
}

export const EFFORTS = [
  { value: 'low', label: 'Quick' },
  { value: 'medium', label: 'Standard' },
  { value: 'high', label: 'Thorough' },
];

export function friendlyTime(t) {
  if (t == null || t === '') return '';
  const d = typeof t === 'number' ? new Date(t < 1e12 ? t * 1000 : t) : new Date(t);
  if (isNaN(d)) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `today at ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} at ${time}`;
}

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Plain English for a job's schedule. Prefers the server's own display text.
export function scheduleText(job) {
  const s = job?.schedule;
  const display = job?.schedule_display || (s && typeof s === 'object' ? s.display : null);
  const expr = (s && typeof s === 'object' ? s.expr : s) || '';
  const cron = String(expr).trim().split(/\s+/);
  if (cron.length === 5 && /^[\d*]/.test(cron[0])) {
    const [mi, hr, dom, mon, dow] = cron;
    if (/^\d+$/.test(mi) && /^\d+$/.test(hr) && mon === '*') {
      const t = clock(+hr, +mi);
      if (dom === '*' && dow === '*') return `Every day at ${t}`;
      if (dom === '*' && dow === '1-5') return `Weekdays at ${t}`;
      if (dom === '*' && /^\d$/.test(dow)) return `Every ${DOW[+dow % 7]} at ${t}`;
      if (dom === '*' && /^[\d,]+$/.test(dow)) return `Every ${dow.split(',').map((d) => DOW[+d % 7]).join(', ')} at ${t}`;
      if (/^\d+$/.test(dom) && dow === '*') return `Monthly on day ${dom} at ${t}`;
    }
  }
  if (display) return capitalise(scrub(display));
  const every = String(expr).match(/^(?:every\s+)?(\d+)\s*([mhd])$/i);
  if (every) return `Every ${every[1]} ${{ m: 'minutes', h: 'hours', d: 'days' }[every[2].toLowerCase()]}`;
  return expr ? capitalise(String(expr)) : 'On a schedule';
}

function clock(h, m) {
  const ampm = h >= 12 ? 'pm' : 'am';
  const hh = h % 12 || 12;
  return m ? `${hh}:${String(m).padStart(2, '0')} ${ampm}` : `${hh} ${ampm}`;
}
function capitalise(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

export function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
