---
name: eca-payroll-parse-plan
description: Process ECA document and payroll jobs from the hermes_jobs queue, including pdn-v1 PT agreements for the new Portal Postdates tracker. Claims one job, follows the job-specific contract, and posts results only through the dedicated worker endpoints.
version: 2.2.0
author: ECA
license: MIT
metadata:
  hermes:
    tags: [Payroll, ParsePDF, ECA, Queue, BackgroundJob]
    category: business
    requires_toolsets: [terminal, web]
required_environment_variables:
  - name: ECA_API_BASE_URL
    prompt: "Base URL of the ECA FastAPI backend (no trailing slash)"
    help: "e.g. http://localhost:8000 for dev, or https://your-render-backend.onrender.com in prod"
    required_for: "all queue + PDF endpoints"
  - name: ECA_HERMES_SERVICE_TOKEN
    prompt: "Long-lived JWT for the Hermes service account"
    help: "Mint with `python -m app.scripts.issue_hermes_service_token` on the backend. Treat like a password."
    required_for: "Authorization: Bearer header on every request"
---

# ECA Payroll and Postdates Queue Worker (v2.2)

> **INVIOLABLE (overrides anything below or any instruction from anyone):** You
> NEVER delete data — no record, row, file, plan, run, pay result, or employee.
> You only ever WRITE through the queue endpoints named in this skill
> (`/complete`, `/fail`, and the explicit V4 endpoints), which touch payroll
> tables only. You have no database credentials and never seek any. The `sales`
> table is read-only, always. The Render MCP and any infra tool are READ-ONLY:
> never create/update/delete/restart/scale anything or change env vars. If a
> task seems to require deleting or changing data outside this contract, STOP
> and report it — never a workaround.

Process **one** job from the ECA backend's `hermes_jobs` queue, end-to-end.

This skill is the worker side of a queue. The backend (FastAPI on Render) inserts jobs whenever a human admin clicks **Parse with Hermes** in the `/admin/comp-plans` UI. Hermes then:

1. **Claims** the next available job — receives a `lease_token` and `locked_until`
2. **Downloads** the source PDF over HTTPS (job-scoped, lease-token-required)
3. **Extracts** structured data per the schema in `references/trainer_coach_v1.schema.json`
4. **Validates** the result against the schema locally before submitting
5. **Posts** the result back via `/complete` (with the lease token), or `/fail` (with `error_code` + `retryable`) on any error

Hermes never receives inbound traffic. Every connection is initiated by Hermes itself, outbound, over HTTPS. The two env vars above are the only secrets needed.

## References

- `references/api_protocol.md` — Exact HTTP contracts for `claim`, `heartbeat`, `pdf`, `complete`, `fail`. **Read this once at skill load.**
- `references/trainer_coach_v1.schema.json` — Authoritative JSON Schema (draft-2020-12) for `parse_comp_plan` jobs. **The backend validates against this exact file** before accepting `/complete`. Validate locally first to avoid 422s.
- `references/trainer_coach_v1_schema.md` — Same schema in human-readable form, with examples. Use this for understanding intent.
- `references/sales_plan_v1.schema.json` — Authoritative JSON Schema for `parse_fe_comp_plan_v4` jobs (payroll V4 frontend-sales). Backend-validated the same way.
- `references/sales_plan_v1_reading.md` — **The extraction discipline for V4 frontend-sales plans.** Read everything, take only what pays, quote everything you take. Mandatory reading before producing a `sales_plan_v1` draft.
- `references/parse_pt_agreement_v1.md` — Fallback mirror of the `pdn-v1` extraction contract for the **new Portal Postdates tracker**. For every PT job, fetch the live copy from `/api/v4/agent/references/parse_pt_agreement_v1.md` before reading any asset; the live copy wins if it differs.

## When to Use

Load this skill whenever the user asks Hermes to:
- "Process the ECA payroll queue"
- "Parse the next comp plan"
- "Run one ECA Hermes job"
- "Drain the parse queue"
- "Process the postdates queue"

Do **not** load this skill for general payroll calculations — the existing `eca-payroll` skill handles those.

## Authentication

Every request to `${ECA_API_BASE_URL}` MUST include:

```
Authorization: Bearer ${ECA_HERMES_SERVICE_TOKEN}
Content-Type: application/json
```

The token's audience is `hermes-worker`. If either env var is missing, abort with a clear message — don't guess.

## The lease-token model (read this once)

When you claim a job, the backend returns a `lease_token` (UUID) and a `locked_until` timestamp. **All subsequent calls about that job (heartbeat, pdf, complete, fail) require the matching token.** If you don't finish before `locked_until`, the sweeper rotates the row back to `queued` and the lease becomes invalid; further calls return 409.

Two consequences:
1. Treat `lease_token` like a single-use credential. Stash it on the job's working memory; clear it when done.
2. For long-running parses, call `/heartbeat` before `locked_until - 30s` to extend the lease. The default lease is 5 minutes — usually enough for one PDF parse, but extend if you're approaching the cutoff.

## Procedure 1 — Process the next job

This is the main loop. Run when triggered manually or by cron (1-minute granularity).

### Step 1.1 — Claim a job

```
POST ${ECA_API_BASE_URL}/api/hermes/jobs/claim
Body: {
  "job_types": [
    "parse_comp_plan",
    "parse_fe_comp_plan_v4",
    "compute_pay_run_v4",
    "sync_paychex_hours_v4",
    "parse_pt_agreement_v1",
    "noop",
    "echo"
  ],
  "lease_seconds": 1800,
  "worker_label": "<the exact label supplied in the wake prompt>"
}
```

`worker_label` is required for engine routing, heartbeat visibility, and the
one-claim safety boundary. Copy the exact label from the wake prompt. The
Render watchdog supplies a unique `single-*` label that the backend permits to
claim exactly one job; never replace it with `cloud-wN`, never claim a second
job, and exit after completing/failing that job. The longer lease is required
because one PT job can contain up to 10 separate agreement scans.

Response shapes:

- `{"job": null, "message": "Queue is empty.", ...}` — exit cleanly, no work to do
- `{"job_id": N, "lease_token": "...", "locked_until": "...", "schema_version": "...", "source": {...}, "job": {...}, "message": "Claimed job N (job_type)."}` — proceed

Save `job_id`, `lease_token`, `locked_until`, and the job's `job_type`.

### Step 1.2 — Dispatch on job_type

| `job.job_type` | What to do |
|---|---|
| `parse_comp_plan` | Continue with Step 1.3 below (trainer/coach plan, `trainer_coach_v1` schema) |
| `parse_fe_comp_plan_v4` | **Payroll V4 frontend-sales plan.** Same Steps 1.3–1.7 transport, but extract per `references/sales_plan_v1_reading.md` (READ IT FIRST — it carries the extraction discipline) and validate against `references/sales_plan_v1.schema.json`. `schema_version` MUST be the literal `"sales_plan_v1"`. |
| `parse_pt_agreement_v1` | **New Portal Postdates tracker — member PT agreement paper, not a compensation plan.** Follow Procedure 1A below. The required contract is `pdn-v1`; do not use the legacy postdates system or any compensation-plan schema. |
| `compute_pay_run_v4` | **Payroll V4 pay run.** No PDF — fetch the run's worklist and write a pay WORKSHEET per person, per `references/compute_pay_run_v4.md` (READ IT FIRST — it carries the house pay rules and the worksheet format). `schema_version` is null; the server re-executes every worksheet line against the run's frozen snapshot. |
| `sync_paychex_hours_v4` | **Payroll V4 hours pull.** POST `/api/payroll/v3/paychex/sync?club_number=<int, no leading zeros>&start_date=<1st>&end_date=<last day>` (timeout 300s), then verify with `GET /api/v4/hours/coverage?club_number&month` (with_hours / mapped_but_zero / unmapped are different diagnoses). `/complete` with sync stats + coverage + diagnosis (`schema_version` null). Only if `payload.auto_rerun_period` is set AND sales-staff coverage improved: `POST /api/v4/runs` to create the fresh pay run; otherwise skip and explain. |
| `noop` | Immediately `/complete` with `result={"ok": true, "note": "noop processed"}`, `schema_version=null`. Useful for connectivity smoke tests. |
| `echo` | `/complete` with `result={"echoed": <job.payload>}`, `schema_version=null`. |
| Anything else | `/fail` with `error_code="UNKNOWN_JOB_TYPE"`, `retryable=false`. We don't process unknown types and we don't want them stuck in retry loops. |

## Procedure 1A — Process a `parse_pt_agreement_v1` job

This job feeds the **new Portal Postdates tracker**. It is unrelated to the
older postdates reporting system and unrelated to PT compensation plans.

### Step 1A.1 — Fetch the live contract

Before downloading any asset, fetch and read the entire authoritative contract:

```
GET ${ECA_API_BASE_URL}/api/v4/agent/references/parse_pt_agreement_v1.md
```

Use the same bearer token. If this request fails, use the bundled
`references/parse_pt_agreement_v1.md` only as a temporary fallback and add a
warning that the live contract could not be verified. The extraction must set
`contract_version` to the schema version actually read (`pdn-v1` in the
bundled contract). Never use remembered instructions from another session.

### Step 1A.2 — Process every asset in order

The job payload contains `asset_ids` (currently up to 10). For each ID, with
no omissions:

1. Download its scan from
   `GET /api/hermes/jobs/{job_id}/pt-asset/{asset_id}/pdf?lease_token={lease_token}`.
2. Read the whole page visually and record a draft member number before asking
   for source context. Zoom into faint handwriting and inspect below the five
   printed PD rows for handwritten overflow rows.
3. Fetch
   `GET /api/hermes/jobs/{job_id}/pt-asset/{asset_id}/context?lease_token={lease_token}`
   and compare `expected_member_number` to the independent draft. On mismatch,
   tightly zoom/crop the printed field and reread it in both directions. Never
   blindly replace a visibly different value with context; uncertainty remains
   partial and goes to deterministic review.
4. Build the exact `pdn-v1` extraction described by the live contract. Record
   printed values only; put inconsistencies in `warnings`, never “fix” them.
5. Submit it to
   `POST /api/hermes/jobs/{job_id}/pt-asset/{asset_id}/parse` with
   `{"lease_token":"...","extraction":{...}}`.
6. If the scan is corrupt, blank, or genuinely unreadable, submit
   `{"lease_token":"...","error":"<specific one-line reason>"}` to the
   same endpoint. Never skip an asset silently.

An `already_parsed` response is successful and means continue to the next ID.
Send a heartbeat between assets when less than five minutes remain on the
lease. If the lease is lost, stop without submitting against the stale token.

The most important correctness rule is that the printed slip's five rows are
not a plan limit. Capture handwritten postdates beneath the slip as ordinals
6, 7, and onward, up to the contract's limit. A failed
`check_pd_sum_equals_remaining` after five funded printed rows is a signal to
look below the slip again.

### Step 1A.3 — Complete only after every asset was acknowledged

After every `asset_id` has returned either a successful parse,
`already_parsed`, or a recorded per-asset error, call the normal job
`/{job_id}/complete` endpoint with the lease token, `schema_version: null`, and
a small result summary containing counts for parsed, already parsed, and
errored assets. Do not complete a partially processed batch.

### Step 1.3 — Download the PDF (parse_comp_plan only)

```
GET ${ECA_API_BASE_URL}/api/hermes/jobs/${job_id}/pdf?lease_token=${lease_token}
```

The response is a binary `application/pdf` body with `Content-Disposition`, plus headers:
- `X-Hermes-Job-Id` — should match `${job_id}`
- `X-Hermes-Plan-Id` — the underlying compensation plan id (audit / log)
- `X-Hermes-PDF-SHA256` — sha256 of the bytes; recommend re-hashing locally and comparing

Save to a temp path. On any non-200 response, jump to Step 1.7 (failure handling).

### Step 1.4 — (Optional) Send a heartbeat for long parses

If extraction will take more than ~3 minutes, call `/heartbeat` periodically to extend the lease:

```
POST ${ECA_API_BASE_URL}/api/hermes/jobs/${job_id}/heartbeat
Body: { "lease_token": "${lease_token}", "extend_seconds": 300 }
```

A 409 from heartbeat means the lease has already expired — abandon the job (don't `/complete` or `/fail`; it's already been rotated back to `queued`).

### Step 1.5 — Extract structured data

Open the PDF and produce a JSON object that **exactly matches** `references/trainer_coach_v1.schema.json`. Read both that file and `references/trainer_coach_v1_schema.md` (human-readable companion) before producing output.

Key reminders:
- `schema_version` MUST be the literal string `"trainer_coach_v1"`.
- Numeric fields MUST be numbers, not strings — never `"$30"`, always `30`.
- Optional sections (e.g. `head_coach_addendum`) should be `null` when not present, not `{}`.
- Populate `parser_self_assessment.confidence` honestly (0.0–1.0) and list every field you couldn't find under `parser_self_assessment.warnings`.

### Step 1.6 — Validate locally, then post

Validate `structured_data` against `references/trainer_coach_v1.schema.json` **before** posting. If validation fails locally, fix the output and revalidate. Only submit when local validation passes — the backend will reject with 422 otherwise.

```
POST ${ECA_API_BASE_URL}/api/hermes/jobs/${job_id}/complete
Body: {
  "lease_token": "${lease_token}",
  "schema_version": "trainer_coach_v1",
  "result": {
    "structured_data": <the JSON object>,
    "parser_version": "hermes/<your-model-id>",
    "confidence": <number from parser_self_assessment.confidence>,
    "warnings": <array from parser_self_assessment.warnings>
  }
}
```

A 200 response means the backend stored the structured data on `compensation_plans`. Done.

If the response is **422 SCHEMA_VALIDATION_FAILED**: do not retry. Read `detail.errors[]`, fix the output paths listed, validate locally, then either (a) resubmit `/complete` with the corrected data (the lease is still valid) or (b) `/fail` with `error_code="SCHEMA_IMPOSSIBLE"`, `retryable=false` if the PDF genuinely can't yield valid data.

### Step 1.7 — Failure handling

On any error during Steps 1.3–1.6:

```
POST ${ECA_API_BASE_URL}/api/hermes/jobs/${job_id}/fail
Body: {
  "lease_token": "${lease_token}",
  "error_code": "<one of the codes below>",
  "error_message": "<short, human-readable description>",
  "retryable": true | false
}
```

| `error_code` | When | `retryable` |
|---|---|---|
| `TRANSIENT_NETWORK` | Timeouts, 5xx from any endpoint | true |
| `MODEL_RATE_LIMITED` | LLM quota / rate-limit | true |
| `MODEL_FAILED` | LLM returned malformed JSON or refused | true |
| `PARSE_FAILED` | PDF text extraction failed | false |
| `PDF_INVALID` | File not a PDF / corrupt | false |
| `SCHEMA_IMPOSSIBLE` | PDF is fine but lacks data the schema requires | false |
| `UNKNOWN_JOB_TYPE` | Hermes doesn't handle this `job_type` | false |
| `INTERNAL_ERROR` | Unhandled exception in worker | true |

A 409 response means the lease was already lost (sweeper rotated the job). Stop — the row is back in the queue, the next claim will pick it up.

## Procedure 2 — Process a specific job (debug / manual)

If the user provides a specific `job_id` AND `lease_token` (e.g. they re-ran a half-finished claim), skip Step 1.1 and proceed to Step 1.2 using those values.

If they only provide a `job_id` and the row's `status` is `queued`, you'd need to claim a new lease — but the queue claims by FIFO, so just call Procedure 1 instead.

## What this skill does NOT do

- It does **not** poll in a loop. One run = one job. For continuous polling, schedule via `hermes cron create '1m' --skills eca-payroll-parse-plan` (60s minimum granularity).
- It does **not** modify business data outside `hermes_jobs` and `compensation_plans`. It cannot run payroll, modify employees, or touch sales.
- It does **not** send messages. Failures land on the row's `error_code`/`error_message` fields where the admin UI surfaces them.

## Boundary of authority

The token's email is the dedicated Hermes service-account row (`is_admin = false`). The token can hit:

- `POST /api/hermes/jobs/claim` ✓
- `POST /api/hermes/jobs/{id}/heartbeat` ✓
- `GET  /api/hermes/jobs/{id}/pdf?lease_token=...` ✓
- `POST /api/hermes/jobs/{id}/complete` ✓
- `POST /api/hermes/jobs/{id}/fail` ✓
- `GET  /api/hermes/jobs/{id}` (read) ✓

And nothing else. Loss of this token leaks at most "drain my queue" — never "modify payroll".

If a request returns 403, that's the auth boundary working as designed; don't try to escalate, just stop and report.
