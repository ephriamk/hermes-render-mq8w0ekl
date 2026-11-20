# ECA Agent screen

A plain HTML + ES module client for a leader's agent gateway, served by the nginx front gate at `/ui/` on the same origin as the gateway. No build step, no framework, no network dependencies: every file here works offline.

Protocol reference: `ECAMain/portal/eca-agent-screen-protocol.md` (upstream commit `ae2a81c`). Section numbers below refer to it.

## Files

| File | What it does |
|---|---|
| `index.html` | Static markup for every view (home, conversation, files, scheduled, sidebar, account menu). |
| `protocol.js` | **All server I/O.** `Gateway` (REST helpers, socket ticket, `/api/ws` JSON-RPC, heartbeat, reconnect) and `Conversation` (transcript items, streaming, tools, approvals, clarify, errors, stop, reattach). No DOM. Browser globals are injected, so node can test it. |
| `render.js` | Safe markdown to DOM (never `innerHTML`), tool labels, path and name scrubbing, error copy, schedule wording, model and effort names. |
| `app.js` | Views, routing (`#/`, `#/c/<id>`, `#/files`, `#/scheduled`), DOM rendering, sidebar, menus, drawer. |
| `styles.css` | Structure plus plain defaults. Every colour, size and radius is a custom property on `:root`, with a dark block. |
| `test/protocol.test.mjs` | Node test (no packages): `node test/protocol.test.mjs`. |
| `test/demo.html` | Offline visual demo with a fake gateway in the page. `python3 -m http.server` in this folder, then open `/test/demo.html`. Type "report" (approval), "which" (clarify), "pay" (auth error), "drop" (disconnect mid answer). |

## How it works

1. **Sign-in hand-off.** Reads the token from `sessionStorage["hermes.webapp.session.v1:" + JSON.stringify([location.origin, ""])]` (a raw 43 character string, confirmed in upstream `browser-launch-session.ts` and the `_LAUNCH_SCRIPT` in `web_routers/webapp.py`). Missing token, or any `401` from `/api/*`, sends the tab to `/_eca/open`.
2. **Socket.** `POST /api/webapp/socket-ticket?socket=gateway&profile=default` with `X-Hermes-Session-Token`, then `new WebSocket("wss://<host>/api/ws?native_dial=browser", ["hermes-gateway-v1", "hermes-gateway-ticket.<ticket>"])`. A new ticket for every dial.
3. **On `gateway.ready`:** sends `client.capabilities {server_requests:true}`, starts a `gateway.ping` every 15 s (`id: "heartbeat-N"`), and redials if nothing at all arrives for 45 s (checked every 15 s, so the redial lands at 45 to 60 s).
4. **Server requests** (`srq-` ids) are all answered with `-32601` so the agent never waits out a timeout. Unknown events and unparseable frames are logged to the console as `[agent] ...` and ignored.
5. **New chat:** `session.create {request_id, source:"gui"}` on first send, then `prompt.submit {session_id, text, submission_id}`. The `session_id` from the reply is used from then on.
6. **Open chat:** REST transcript (`/api/sessions/{id}/messages?order=latest&limit=120&include_compacted=true`), then `session.resume {session_id, omit_messages:true}`. Open approval and clarify prompts in the resume reply are rebuilt as cards.
7. **Streaming:** `message.delta` appends; `text:null` seals the bubble so tool lines sit between paragraphs; `turn_id + segment + offset` drops chunks already applied; `seq` per session drops replayed frames. `message.complete` ends the turn: empty `text` keeps the streamed text; `status:"error"` becomes an error card keyed on `error_surface.layer`; `status:"interrupted"` adds "Stopped."
8. **Approvals and clarify** arrive as events. Answers use exactly `{session_id, execution_generation, prompt_id, choice|answer}` with the generation from the prompt payload. Cards close on `*.settled`.
9. **Stop:** `prompt.cancel {session_id, admission_id}` when the admission id is known, otherwise `session.interrupt {session_id, execution_generation}` (one retry with the fresh generation on `stale_generation`).
10. **Reconnect:** backoff 0.5, 1, 2, 4, 8, 15 s with jitter, new ticket each time, a quiet "Reconnecting…" in the top bar. For the open chat: `session.events.since {session_id, last_seen, replay_epoch}`, apply the events, then `session.resume`. If replay is unavailable (`snapshot_required`, `truncated`, or an error) it re-reads the REST transcript and resumes.
11. **Sidebar:** `GET /api/sessions?...&archived=exclude&exclude_sources=cron&profile=default`, grouped Today / Earlier by `last_active`, filtered client side. Rename and archive use `GET .../mutation-snapshot` then `PATCH /api/sessions/{id}` with `request_id`, `expected_revision`, `expected_generation` (one retry on a 409 revision conflict). Refreshes on `sessions.changed`, `session.updated`, `session.title`.
12. **Files:** `GET /api/files` (managed files root, the home folder), dot entries hidden, folders browsable, only names shown. Upload: `POST /api/files/upload-stream` (multipart `file`, `path`, `overwrite=false`). Download: `fetch /api/fs/download?path=&profile=default` with the header, saved through an object URL (no ticket needed).
13. **Scheduled:** `GET /api/cron/jobs?profile=default` (array, or `{jobs}`), pause, resume, delete. Common cron expressions are worded in plain English; otherwise the server's `schedule_display`. Refreshes on `cron.changed`.
14. **Model and effort:** effort select Quick / Standard / Thorough = `low` / `medium` / `high`, applied with `session.mutate operation:"reasoning"`. The model select only appears when at least two models map to a friendly name ("Sonnet - fast", "Opus - deepest", "Haiku - quickest"); applied with `session.mutate operation:"model"`, honouring `confirmation_required`.
15. **Never shown:** host paths (scrubbed to file names in tool details, approvals and job names), the product names, version numbers, provider and model ids. Tool rows read like "Looked up the club dashboard"; the raw `terminal` tool reads "Ran a step".

## Protocol assumptions not confirmed (ranked by risk)

1. **Our gate rewrites `Host` and `Origin` so the gateway accepts `/api/ws` from `/ui/`.** If not, the socket closes before accept and the browser reports 1006. The page will sit in "Reconnecting…" forever. (Protocol note UNCONFIRMED 2.)
2. **The gate leaves `Sec-WebSocket-Protocol` intact.** The ticket rides in it. If nginx strips or rewrites the header, every dial fails. Fallback if needed: `?ticket=` in the URL (accepted by the server, but it lands in logs).
3. **`gateway.ready.session_authority === true` on our gateways.** If false (legacy wire), approvals and clarify come as `srq-` server requests, which this client declines with `-32601`, so the agent will treat every approval as refused. A console warning is printed. (UNCONFIRMED 1.)
4. **The REST transcript after a reconnect with no replay.** If the in-flight turn is not yet persisted, the partial answer disappears from view until the turn finishes and persists. Live deltas continue into a new bubble.
5. **`session.events.since` works before `session.resume` on a fresh socket** (the stock client does this order). If it is refused with `permission_denied`, the code falls back to REST reload plus resume, so behaviour degrades but does not break.
6. **Multi-select clarify answers** are sent as one string joined with ", " (UNCONFIRMED 6).
7. **`/api/files` root is the home folder** on our deployment. If `HERMES_DASHBOARD_FILES_ROOT` or `/opt/data` locks it elsewhere, Files shows that folder instead.
8. **`/api/fs/download` serves files under the managed root** with the header (not traced end to end through `_fs_download_authority`). If refused, switch to `/api/files/download?path=` (same header) or a file ticket.
9. **`session.mutate` reply shapes** for `reasoning` and `model` (`revision`, `status:"confirmation_required"`, `confirm`) are taken from the stock adapter, not traced on the server.
10. **Effort values `low` / `medium` / `high`** and model names containing "sonnet" / "opus" / "haiku" in `/api/model/options`.
11. **Shape of `prompts` in the resume reply** is assumed to match the `approval.request` / `clarify.request` payloads (`kind`, `prompt_id`, `execution_generation`, ...). That is what `session_pending_controls.py` stores, so this one is low risk.
12. **Cron job fields** beyond `id`, `name`, `schedule {expr, display}`, `schedule_display`, `enabled`, `state`, `next_run_at`, `last_run_at`, `last_error` (UNCONFIRMED 7). `next_run_at` is handled as unix seconds, milliseconds or an ISO string.

## What to test live first (in this order)

1. Open DevTools Network, load `/_eca/open`, confirm the tab lands on `/ui/` and the sessionStorage key exists with origin and `""`.
2. `POST /api/webapp/socket-ticket?socket=gateway&profile=default` returns 200 with a ticket (not 401, not 400 for the profile).
3. The `/api/ws` request shows `101 Switching Protocols` with response `Sec-WebSocket-Protocol: hermes-gateway-v1`. If it is 1006 instead, check the gate's Host / Origin rewrite and that it forwards the subprotocol header.
4. In the WS frames tab: first frame is `gateway.ready` with `session_authority: true`; `client.capabilities` gets a result; `gateway.ping` gets `{ok:true}` every 15 s.
5. Send "hello": `session.create` reply has a `session_id`; `prompt.submit` reply has `admission_id`; deltas stream; `message.complete` arrives.
6. Ask for something that needs approval; click "Allow once"; confirm `approval.respond` returns `resolved` and `approval.settled` follows.
7. Press Stop mid answer: `prompt.cancel` reply, then `message.complete` with `status:"interrupted"`.
8. Kill the socket (DevTools offline for 5 s): "Reconnecting…" appears, a new ticket is minted, `session.events.since` then `session.resume` are sent, the answer continues.
9. Sign out of Claude (or use an expired login) and confirm the auth card and "Reconnect Claude" button.
10. Sidebar rename and archive (watch for 409 on the PATCH), Files list and download, Scheduled pause / resume.
11. Confirm the console shows no `[agent] unhandled event ...` for common events; any that appear are cheap to add.

## Accessibility notes

Keyboard order follows the page; every control is a real button, link or input; focus ring is `--focus-ring`. The transcript is `role="log"` with `aria-live="polite"`; a streaming answer is `aria-busy="true"` until it completes, so screen readers read it once. Menus open on click, move with arrow keys and close on Escape (focus returns to the trigger). The drawer closes on Escape or backdrop click. Not done yet: a focus trap inside the open drawer.

## CSS custom properties (for the designer)

Override these on `:root` (and in the `prefers-color-scheme: dark` block). Nothing else in `styles.css` hard-codes a colour, size or radius except layout percentages.

| Property | Default (light) |
|---|---|
| `--color-bg` | `#ffffff` |
| `--color-surface` | `#f6f7f8` |
| `--color-surface-2` | `#eceef1` |
| `--color-text` | `#16181b` |
| `--color-text-muted` | `#5b616b` |
| `--color-border` | `#d6d9de` |
| `--color-accent` | `#0b6b4f` |
| `--color-accent-text` | `#ffffff` |
| `--color-accent-soft` | `#e3f1ec` |
| `--color-link` | `#0a5c8a` |
| `--color-focus` | `#1a73e8` |
| `--color-danger` | `#b3261e` |
| `--color-danger-soft` | `#fbeceb` |
| `--color-warning-soft` | `#fff6e0` |
| `--color-warning-border` | `#e5b649` |
| `--color-user-bubble` | `#e8eef7` |
| `--color-user-text` | `#16181b` |
| `--color-assistant-bubble` | `transparent` |
| `--color-code-bg` | `#f0f2f4` |
| `--color-backdrop` | `rgba(0, 0, 0, 0.35)` |
| `--color-shadow` | `rgba(0, 0, 0, 0.12)` |
| `--font-body` | `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` |
| `--font-mono` | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` |
| `--font-size-xs` | `0.75rem` |
| `--font-size-sm` | `0.875rem` |
| `--font-size-md` | `1rem` |
| `--font-size-lg` | `1.25rem` |
| `--font-size-xl` | `1.75rem` |
| `--line-height` | `1.55` |
| `--font-weight-bold` | `600` |
| `--space-1` | `4px` |
| `--space-2` | `8px` |
| `--space-3` | `12px` |
| `--space-4` | `16px` |
| `--space-5` | `24px` |
| `--space-6` | `32px` |
| `--radius-sm` | `6px` |
| `--radius-md` | `10px` |
| `--radius-lg` | `16px` |
| `--radius-pill` | `999px` |
| `--border-width` | `1px` |
| `--focus-ring` | `0 0 0 3px var(--color-focus)` |
| `--shadow-menu` | `0 6px 24px var(--color-shadow)` |
| `--topbar-height` | `56px` |
| `--sidebar-width` | `280px` |
| `--content-max` | `760px` |
| `--composer-max` | `760px` |
| `--drawer-breakpoint` | `760px` (documentation only; the media query is literal `760px`) |
| `--transition` | `160ms ease` |

Main class hooks for the design: `.topbar`, `.sidebar`, `.session`, `.view-home`, `.starter`, `.transcript`, `.msg-user .bubble-user`, `.msg-assistant .md`, `.tool` (`.tool-running`, `.tool-done`, `.tool-error`, `.tool-stopped`), `.card-approval`, `.card-clarify`, `.card-error`, `.card-auth`, `.composer`, `.file`, `.job`, `.menu`, `.toast`.
