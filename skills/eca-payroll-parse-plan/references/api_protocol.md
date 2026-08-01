# ECA Hermes Job Queue — API Protocol (v2)

Exact HTTP contracts for the endpoints this skill calls. All paths are relative to `${ECA_API_BASE_URL}`. Every request includes:

```
Authorization: Bearer ${ECA_HERMES_SERVICE_TOKEN}
Content-Type: application/json
```

The token is the long-lived JWT minted for the Hermes service account. The backend re-validates the token on every request (it queries the `employees` row), so revoking the account in the DB instantly invalidates every issued token.

**Contract version:** v2 (Hermes design review 2026-05-14). Lease-token model, heartbeat, job-scoped PDF, structured failures, server-side schema validation.

---

## Lease-token model in 60 seconds

1. `POST /claim` returns a `job_id` together with a `lease_token` (UUID) and a `locked_until` timestamp.
2. To do anything else with that job (download the PDF, send a heartbeat, complete, or fail), Hermes **must** present the matching `lease_token`. The backend verifies it on every mutation.
3. If the lease expires before Hermes finishes, the sweeper rotates the row back to `queued` and the lease becomes invalid. Hermes' next `/heartbeat`, `/complete`, or `/fail` against that job returns **409**, and Hermes should give up on it.
4. Long-running jobs should call `/heartbeat` before `locked_until - 30s` to extend the lease.

This means a crashed laptop is recovered automatically: nothing dangling, no manual cleanup.

---

## 1. POST /api/hermes/jobs/claim

Atomically claim the next queued job. Uses `FOR UPDATE SKIP LOCKED` server-side, so multiple concurrent ticks (or multiple Hermes workers) cannot collide.

### Request

```http
POST /api/hermes/jobs/claim
Authorization: Bearer ${ECA_HERMES_SERVICE_TOKEN}
Content-Type: application/json

{
  "job_types": ["parse_comp_plan", "noop"],   // optional filter; omit for any
  "lease_seconds": 300,                        // optional; 30..3600, default 300
  "worker_label": "hermes-2"                   // optional; per-worker id (see below)
}
```

**Running N workers?** All workers share one service token, so by default they all
claim as the same identity and the pool is invisible. Pass a distinct
`worker_label` per worker (e.g. `hermes-1`, `hermes-2`, or an instance/tick id) so
`GET /api/v4/agent/status` and `worker_heartbeats` list each one separately and you
can confirm every worker is alive. The label is sanitized to `[A-Za-z0-9-_.]`, max
32 chars, and appended as `…@…#label`.

### Successful response (200) — there was a job

```json
{
  "message": "Claimed job 42 (parse_comp_plan).",
  "job_id": 42,
  "lease_token": "8f1a2c4e-7b9d-4f0e-9a3a-1234567890ab",
  "locked_until": "2026-05-14T17:13:01.123Z",
  "schema_version": "trainer_coach_v1",
  "source": {
    "compensation_plan_id": 7,
    "employee_email": "truman@emeraldcityathletics.com",
    "employee_name": "Truman Curry",
    "club_number": 40059,
    "plan_type": "trainer_coach",
    "pdf_filename": "SEATTLE TRAINER AND COACH COMPENSATION PLAN 9.1.25.pdf",
    "pdf_sha256": "..."
  },
  "job": { /* full job row, see GET /api/hermes/jobs/{id} */ }
}
```

`schema_version` and `source` are mirrored from the job's `payload` so workers can decide what to do without parsing payload conventions per `job_type`.

### Successful response (200) — queue empty

```json
{
  "message": "Queue is empty.",
  "job": null,
  "job_id": null,
  "lease_token": null,
  "locked_until": null,
  "schema_version": null,
  "source": null
}
```

### Error responses

| Status | Meaning |
|---|---|
| 401 | Token invalid / expired — re-mint, update env, restart Hermes |
| 403 | Token is not for the service account |
| 400 | `lease_seconds` outside 30..3600 |

After this returns, treat the lease as the credential. **Lose it = lose the job.**

---

## 2. POST /api/hermes/jobs/{job_id}/heartbeat

Extend the lease on a job Hermes is still working on. Required before `locked_until` to avoid losing the claim.

### Request

```http
POST /api/hermes/jobs/42/heartbeat
Authorization: Bearer ${ECA_HERMES_SERVICE_TOKEN}
Content-Type: application/json

{
  "lease_token": "8f1a2c4e-7b9d-4f0e-9a3a-1234567890ab",
  "extend_seconds": 300
}
```

### Successful response (200)

The full job row, with `locked_until` pushed forward by `extend_seconds`.

### Error responses

| Status | Meaning |
|---|---|
| 409 | Lease invalid / expired / job no longer `claimed` — give up on this job |
| 400 | `extend_seconds` outside 30..3600 |

---

## 3. GET /api/hermes/jobs/{job_id}/pdf

Job-scoped PDF download. Hermes can only fetch the PDF whose plan_id is referenced by the job it currently leases. There is **no** unscoped PDF download for the worker.

### Request

```http
GET /api/hermes/jobs/42/pdf?lease_token=8f1a2c4e-7b9d-4f0e-9a3a-1234567890ab
Authorization: Bearer ${ECA_HERMES_SERVICE_TOKEN}
```

### Successful response (200)

```http
Content-Type: application/pdf
Content-Disposition: inline; filename="SEATTLE TRAINER AND COACH COMPENSATION PLAN 9.1.25.pdf"
Cache-Control: private, no-store
X-Hermes-Job-Id: 42
X-Hermes-Plan-Id: 7
X-Hermes-PDF-SHA256: <hex>

<binary PDF body>
```

The `X-Hermes-PDF-SHA256` header lets Hermes verify the bytes it processed match what's stored. Recommend Hermes re-hash the body and confirm.

### Error responses

| Status | Meaning |
|---|---|
| 403 | Lease token doesn't match the active lease — fail the job, retryable=false |
| 404 | Job or plan missing — fail the job, retryable=false |
| 409 | Job not in `claimed` status, or lease expired |
| 400 | Job has no `compensation_plan_id` in payload |

---

## 4. POST /api/hermes/jobs/{job_id}/complete

Mark the job done. The backend validates `result.structured_data` against the JSON Schema for `schema_version` before accepting.

### Request

```http
POST /api/hermes/jobs/42/complete
Authorization: Bearer ${ECA_HERMES_SERVICE_TOKEN}
Content-Type: application/json

{
  "lease_token": "8f1a2c4e-7b9d-4f0e-9a3a-1234567890ab",
  "schema_version": "trainer_coach_v1",
  "result": {
    "structured_data": { /* the parsed object — must match trainer_coach_v1.schema.json */ },
    "parser_version": "hermes/claude-opus-4.6",
    "confidence": 0.92,
    "warnings": []
  }
}
```

### Validation

- `lease_token` must match the active lease.
- `schema_version` must match what the job's payload requested (or be omitted, in which case the payload's `schema_version` is used).
- For known schema_versions (currently `trainer_coach_v1`), the backend validates `result.structured_data` against the JSON Schema. Bad output → 422.

### Successful response (200)

The full job row, with `status: "done"`, `completed_at` populated, and `result` echoed back.

### Error responses

| Status | Meaning |
|---|---|
| 409 | Lease invalid / expired / job not `claimed` |
| 422 | `structured_data` failed schema validation. Body has `error_code`, `errors[]` (path: message), and `schema_version`. **Don't retry** — fix the output and either resubmit or `/fail` the job |
| 400 | `schema_version` mismatch with job payload |

### 422 example body

```json
{
  "detail": {
    "error_code": "SCHEMA_VALIDATION_FAILED",
    "schema_version": "trainer_coach_v1",
    "errors": [
      "session_commission/tiers/0/rate_per_session: '18.0' is not of type 'number'",
      "policy_flags/draw_eligible: 'true' is not of type 'boolean'"
    ],
    "message": "result did not validate against the JSON Schema for 'trainer_coach_v1'. Fix the listed paths and resubmit."
  }
}
```

---

## 5. POST /api/hermes/jobs/{job_id}/fail

Report failure. Backend either requeues (if `retryable=true` and `attempts < max_attempts`) or marks `failed`.

### Request

```http
POST /api/hermes/jobs/42/fail
Authorization: Bearer ${ECA_HERMES_SERVICE_TOKEN}
Content-Type: application/json

{
  "lease_token": "8f1a2c4e-7b9d-4f0e-9a3a-1234567890ab",
  "error_code": "PARSE_FAILED",
  "error_message": "Could not extract base_session_rate — PDF table is malformed",
  "retryable": false
}
```

### Recommended `error_code` values

| error_code | Meaning | Typical retryable |
|---|---|---|
| `TRANSIENT_NETWORK` | Network timeout / 5xx from downstream | true |
| `MODEL_RATE_LIMITED` | LLM rate-limit / quota | true |
| `MODEL_FAILED` | LLM returned malformed JSON | true |
| `PARSE_FAILED` | Could not extract content from PDF | false |
| `PDF_INVALID` | File is not a PDF / corrupt | false |
| `SCHEMA_IMPOSSIBLE` | PDF lacks data the schema requires | false |
| `UNKNOWN_JOB_TYPE` | Hermes doesn't know how to handle `job_type` | false |
| `INTERNAL_ERROR` | Unhandled exception in worker | true |

If unsure, use `retryable=true` — the backend caps total attempts at `max_attempts` (default 3).

### Successful response (200)

Full job row. `status` is `queued` (will retry) or `failed` (terminal).

### Error responses

| Status | Meaning |
|---|---|
| 409 | Lease mismatch — give up on this job |
| 400 | `error_code` or `error_message` missing/empty |

---

## Quick reference card

```
POST /api/hermes/jobs/claim                            → claim + lease
POST /api/hermes/jobs/{id}/heartbeat                   → extend lease
GET  /api/hermes/jobs/{id}/pdf?lease_token=...         → fetch PDF
POST /api/hermes/jobs/{id}/complete                    → submit result, schema-validated
POST /api/hermes/jobs/{id}/fail                        → structured failure
GET  /api/hermes/jobs/{id}                             → read state (debug, admin or worker)
```

All require `Authorization: Bearer ${ECA_HERMES_SERVICE_TOKEN}` (worker calls) or an admin JWT (admin calls).

---

## Idempotency & race protection

- Two ticks claiming simultaneously: only one wins (`FOR UPDATE SKIP LOCKED`); the loser sees `Queue is empty`.
- Worker crashes mid-job: lease expires → sweeper rotates the row back to `queued` → next claim mints a fresh `lease_token`. The dead worker's old token is now invalid; `complete`/`fail`/`heartbeat` all return 409.
- Worker calls `complete` and then `fail` (or vice versa): the second call fails with 409 because the row is no longer `claimed`. State is never corrupted.
- Worker presents a stale lease (e.g. retried after the sweeper kicked in): 409. Don't retry — claim a fresh job instead.
