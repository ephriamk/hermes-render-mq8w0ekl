# eca-payroll-parse-plan — Install & Test

How to get this skill running on your Hermes laptop, with a manual smoke test before flipping on autonomous polling.

## What this is

A Hermes skill that lets your laptop process compensation-plan parse jobs from the ECA payroll backend's queue. The whole protocol is in `SKILL.md`; this file is just the install + bootstrap steps.

---

## Step 1 — Copy the skill onto the laptop

You have three options. Pick whichever matches how you move files between machines.

### Option A — Symlink (cleanest, if both repos sync)

If you keep this Git repo cloned on the laptop:

```bash
ln -s /path/to/this/repo/hermes-skills/business/eca-payroll-parse-plan \
      ~/.hermes/skills/eca-payroll-parse-plan
```

Updating the skill = `git pull` in the repo. No copy-paste drift.

### Option B — Copy the directory

Easier if the laptop doesn't have this repo:

```bash
mkdir -p ~/.hermes/skills/eca-payroll-parse-plan/references
# Copy these four files from the repo to the laptop:
#   hermes-skills/business/eca-payroll-parse-plan/SKILL.md
#   hermes-skills/business/eca-payroll-parse-plan/README.md
#   hermes-skills/business/eca-payroll-parse-plan/references/api_protocol.md
#   hermes-skills/business/eca-payroll-parse-plan/references/trainer_coach_v1_schema.md
# (use scp, AirDrop, USB, whatever)
```

### Option C — Hub install (if/when published)

```bash
hermes skills install eca-payroll-parse-plan
```

(Not available yet — this skill isn't on the hub.)

After any option:

```bash
hermes skills list | grep eca-payroll-parse-plan
```

You should see the skill listed. If it doesn't appear, run `hermes /reload-skills` from inside an interactive Hermes session.

---

## Step 2 — Set the two env vars

On the laptop, add these to `~/.hermes/.env` (or `~/.hermes/profiles/<profile>/.env` if you've isolated a profile):

```bash
ECA_API_BASE_URL=https://your-render-backend.onrender.com
ECA_HERMES_SERVICE_TOKEN=<paste the long JWT the issuer script printed>
```

Mint the JWT on the backend by running:

```bash
cd ECACombined
./venv/bin/python -m app.scripts.issue_hermes_service_token \
    --ttl-days 365 \
    --api-base-url https://your-render-backend.onrender.com
```

The script prints a copy-paste block ready for the laptop's `.env`. The token is good for 365 days. To revoke at any time, run the same script with `--revoke-only`.

---

## Step 3 — Sanity check (no real work)

Confirm the skill loads and the env vars are visible:

```bash
hermes -s eca-payroll-parse-plan -q "Print the values of ECA_API_BASE_URL and ECA_API_TOKEN (first 12 chars only) and confirm the eca-payroll-parse-plan skill is loaded. Do not call any APIs yet."
```

Expected: Hermes acknowledges the skill, prints the URL and a truncated token, exits.

---

## Step 4 — Connectivity smoke test against the backend

This is the moment of truth. From the **backend repo** (not the laptop), enqueue a `noop` job:

```bash
# Get an admin JWT (replace with your admin login)
TOKEN=$(curl -s -X POST https://your-render-backend.onrender.com/api/employee/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@yourdomain.com","password":"<your-password>"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['token'])")

# Enqueue a noop job
curl -s -X POST https://your-render-backend.onrender.com/api/hermes/jobs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"job_type":"noop","payload":{"hello":"hermes"},"notes":"first laptop smoke test"}'
# Note the job id in the response.
```

Then on the laptop:

```bash
hermes -s eca-payroll-parse-plan -q "Run Procedure 1 from the eca-payroll-parse-plan skill. Report exactly what you see."
```

Expected sequence:
1. Hermes calls `POST /api/hermes/jobs/claim` and gets back the noop job
2. Hermes sees `job_type == "noop"` and immediately calls `POST /api/hermes/jobs/{id}/complete` with `result={"ok": true, "note": "noop processed"}`
3. Hermes reports back: "Processed job N (noop), status now done."

Verify on the backend:

```bash
curl -s https://your-render-backend.onrender.com/api/hermes/jobs/<that-job-id> \
  -H "Authorization: Bearer $TOKEN"
# status should be "done"
```

If this works, the connection is healthy.

---

## Step 5 — First real parse (Truman's PDF)

In `/admin/comp-plans`, click **Parse with Hermes** on a comp plan row. The backend enqueues a `parse_comp_plan` job. Then on the laptop:

```bash
hermes -s eca-payroll-parse-plan -q "Run Procedure 1 from the eca-payroll-parse-plan skill once."
```

Watch Hermes:
1. Claim the job
2. GET the PDF from `/api/compensation-plans/{plan_id}/pdf`
3. Extract structured data per `references/trainer_coach_v1_schema.md`
4. POST `/api/hermes/jobs/{id}/complete`

Refresh the admin UI — the row should now show **View** with structured JSON.

If something fails, the row will display the error message Hermes posted to `/fail`. Iterate from there.

---

## Step 6 — (Optional) Autonomous polling

Once you trust it, register a cron tick so Hermes processes jobs without you babysitting:

```bash
hermes cron create '1m' \
  --prompt "Run Procedure 1 from the eca-payroll-parse-plan skill if there is work to do." \
  --skills eca-payroll-parse-plan \
  --quiet
```

Verify:

```bash
hermes cron list
```

To pause: `hermes cron pause <id>`. To remove: `hermes cron remove <id>`. Whenever the laptop is awake and Hermes is running, it'll claim and process jobs every 60 seconds (Hermes cron's minimum granularity).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `403 This endpoint can only be called by the Hermes service account` | Wrong token (admin instead of service-account) | Re-mint with the issuer script and update `.env` |
| `401 Token has expired` | TTL elapsed | Re-mint, default 365d |
| `401 Employee not found or inactive` | Service account was revoked (`--revoke-only` was run, or `active` set to `'No'`) | Re-run issuer script — it auto-flips active back to `'Yes'` |
| `429` or rate-limit errors | Too many login attempts (this only affects login, not the worker endpoints) | Wait the rate-limit window or restart |
| `409 Job N could not be completed` | Stale claim — the sweeper rotated the job back to queued; you don't own it anymore | Skip this job, claim the next one |
| Job sits in `queued` forever | Laptop offline OR cron not registered | `hermes cron list` to check; or run Procedure 1 manually |
| Job lands at `failed` after every retry | Permanent parse error (corrupt PDF, schema mismatch, model hallucination) | Read `error` on the row; either fix the PDF or update the schema/skill |

---

## Files in this skill

```
eca-payroll-parse-plan/
├── SKILL.md                                          # The procedure (load me)
├── README.md                                         # This file
└── references/
    ├── api_protocol.md                               # HTTP contracts (claim/complete/fail/pdf)
    └── trainer_coach_v1_schema.md                    # JSON schema for parsed plans
```
