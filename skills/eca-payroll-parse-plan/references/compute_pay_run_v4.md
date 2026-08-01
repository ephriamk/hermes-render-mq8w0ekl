# Computing a Pay Run → worksheets (Payroll V4)

For `compute_pay_run_v4` jobs. You are the payroll clerk: for every person in the
run you decide WHAT to compute from their approved spec + the house rules below,
and you write it out as an explicit WORKSHEET. You never do arithmetic in your
head and trust it — every line you post is re-executed mechanically by the server
against the run's frozen facts snapshot. A wrong stated value gets flagged and the
server's evaluated value is stored. Flexibility is yours; determinism is enforced.

## Procedure

1. Claim the job (standard transport, see `api_protocol.md`). Payload carries
   `run_id`, `club_number`, `month`, `pay_period`, and OPTIONALLY `people_filter`
   (a list of names) + `slice` (`{index, count}`). `schema_version` is null —
   worksheets are validated by the evaluator, not a JSON Schema.
2. Fetch the worklist:
   `GET ${ECA_API_BASE_URL}/api/v4/runs/${run_id}/worklist`
   **Sliced / targeted runs — you MUST honor `people_filter`.** If the claimed
   job's `payload.people_filter` is a non-empty list, this run was split across
   workers (or is a targeted re-process): pass those names so the worklist returns
   ONLY them, and compute ONLY them — never anyone else's pay:
   ```bash
   # PEOPLE_FILTER_JSON = the payload.people_filter array as JSON
   PF=$(python3 -c "import urllib.parse,json,sys;print(urllib.parse.quote('||'.join(json.loads(sys.argv[1]))))" "$PEOPLE_FILTER_JSON")
   curl -s "${AUTH[@]}" "${ECA_API_BASE_URL}/api/v4/runs/${run_id}/worklist?people=${PF}"
   ```
   Skipping the filter makes every slice recompute the WHOLE roster — still correct
   (the server ignores worksheets outside the filter) but it wastes the entire
   point of slicing, so the run gets no faster. Always scope to your slice.
   The worklist returns, per person: `canonical_name`, `position`, `has_spec`, `spec_id`,
   `spec` (the full approved sales_plan_v1 object), and `namespace` — the flat
   dict of **named numbers your worksheet may reference**: frozen facts
   (`eft_points`, `pt_points`, `nb_cash_points`, `service_points`,
   `five_star_points`, `total_sspts`, `hours_p1_regular`, `hours_p1_overtime`,
   `hours_p1_sick`, `hours_period_*`, `hours_full_*`, dollar fields) plus every
   numeric leaf of the spec (`spec_parameters_draw`, `spec_commission_eft`,
   `spec_tiers_1_rates_all`, `spec_tiers_1_sspts_min`, …).
3. For each person, produce ONE worksheet (format below):
   - `has_spec: false` → fail-closed row: empty steps, `amount_step: null`,
     `flags: ["NO_ACTIVE_SPEC"]`, a one-line note. NEVER invent pay for them.
   - `has_spec: true` → read the spec, apply the house rules, write the steps.
4. `/complete` with:
   ```json
   {
     "lease_token": "...",
     "schema_version": null,
     "result": {
       "results": [ <worksheet per person — EVERY person on the worklist> ],
       "parser_version": "hermes/<model-id>",
       "prompt_version": "compute-pay-run v1",
       "agent_summary": "N computed, M fail-closed (no plan), anomalies: ..."
     }
   }
   ```

## Worksheet format

```json
{
  "canonical_name": "Hopkins, Dallas",
  "pay_period": 2,
  "spec_id": 3,
  "inputs": {"eft_points": 12030.0, "spec_parameters_draw": 3500.0},
  "steps": [
    {"id": "sales_points", "expr": "eft_points + pt_points + nb_cash_points",
     "value": 38256.0, "label": "Sales points only — plan excludes RPs, 1Ws, 5-stars"},
    {"id": "commission", "expr": "round(sales_points * spec_commission_eft, 2)",
     "value": 6503.52, "label": "Commission = 17% of total success points of all sales"},
    {"id": "p1_paid", "expr": "spec_parameters_draw", "value": 3500.0,
     "label": "P1 already paid (draw advance)"},
    {"id": "p2_pay", "expr": "max(commission, p1_paid) - p1_paid", "value": 3003.52,
     "label": "P2 = MAX(full-month commission, P1 paid) - P1 paid (full draw repaid)"}
  ],
  "amount_step": "p2_pay",
  "flags": [],
  "notes": "Flat 17% over sales points; service/review EXCLUDED per plan."
}
```

Rules of the format:
- **`inputs`**: name → value pairs, names taken ONLY from the person's `namespace`.
  The server verifies each against the frozen snapshot; an invented or wrong value
  is flagged and overridden. Copy the values verbatim from the worklist.
- **`steps`**: ordered. `expr` is arithmetic over input names, earlier step ids,
  and structural constants only (allowed: `+ - * / ( )`, `max`, `min`, `round`,
  `abs`, numeric literals for things like OT × 1.5 or rounding digits — never for
  facts or plan parameters). `value` is your computed result (use a calculator
  tool, not mental math). `label` is the human-readable line on the paycheck.
- **`amount_step`**: the step id whose value is this period's pay. Null = fail-closed.
- **`flags`**: anything a human should look at (`CONFIRM:* outstanding on spec`,
  `COMMISSION_BELOW_DRAW`, `ZERO_SALES_FOR_COVERED_PERSON`, `CONFLICT: ...`).
- **`notes`**: your judgment narrative (tier chosen and why, anomalies, etc.).

## House rules (fixed — plans never override these)

- **Periods**: P1 = 1st–15th, P2 = 16th–EOM. Commission is ALWAYS full-month.
- **P1 ladder** (mutually exclusive, by spec `p1_mode`):
  `salary` → `spec_parameters_salary`; `guarantee_floor` → `spec_parameters_guarantee_p1`;
  `draw_advance` → `spec_parameters_draw`; `hourly` →
  `(hours_p1_regular + hours_p1_sick) * spec_parameters_hourly_rate + hours_p1_overtime * spec_parameters_hourly_rate * 1.5`.
- **P2 by spec `p2_mode`**:
  - `max_trueup`: `max(commission, p1_paid) - p1_paid`. The FULL draw/advance is
    repaid — never half. If commission < P1 paid, P2 = 0 (no negative, no clawback).
    `guarantee_p2` (if set) is a floor on the result; `salary_period2` (if set) adds on top.
  - `additive`: P2 base (salary_period2 or hourly over the P2 window) + full-month commission.
  - `independent`: hours-based only, no commission interplay.
- **Points are pre-converted in the namespace** — `eft_points` already includes the
  ×10; service events ×50 and reviews ×35 are already applied. NEVER multiply by 10
  again. "14% on EFT" = `eft_points * 0.14`.
- **Exclusions**: a spec commission component of `"EXCLUDED"` contributes nothing —
  leave it out of the points sum.
- **Tier ladders**: qualification total = sum of the points of NON-excluded
  components. Pick the highest tier whose `sspts_min` ≤ total. `rates: "base"` →
  per-component rates; `rates: {"all": X}` → flat X on the whole eligible total.
  State the tier judgment in `notes`.
- **Rounding**: dollar results `round(x, 2)`.
- **Fail closed, always**: no approved spec → no number. A spec with open
  `CONFIRM:*` flags still computes, but carry the flag forward.
- **Adjustments** (manual bonus / deductions / final-pay override) are a separate
  human-owned layer — do NOT model them in worksheets.

## What you may NOT do

- No arithmetic outside `expr` steps (the server re-executes everything).
- No operand that isn't in the namespace (facts come from the frozen snapshot only —
  never query live data for a run).
- No paying a person without an active spec, no matter what other context suggests.
- No modeling of conduct/forfeiture clauses — flag for a human.

## General Managers — the club/exec split (Ephriam ruling 2026-06-12)

A spec with `exec_comp.monthly_total` is a GM. Their CLUB pay computes
exactly like anyone else (the ladder above — typically p1 salary + p2
commission with guarantee_p2 floor). The worksheet `amount` IS the club
bucket — it's what club frontend payroll is charged.

THEN, on the P2 (or full-month) worksheet only, add a trailing INFO step:

```
club_month  = p1_ladder_amount + p2_amount          (this month's club bucket)
exec_remainder = round(max(0, spec_exec_comp_monthly_total - club_month), 2)
```

with label "Exec bucket (corporate — NOT club payroll)" and items showing
monthly_total, club_month, and the remainder. CRITICAL: exec_remainder is
NEVER added to `amount` — it is display/accounting data. When commission
pushes the club bucket above monthly_total, exec_remainder is 0 and the GM
simply earns more (no cap, no clawback).

Worked example — Dakota-shaped GM, May (commission $1,575.45):
```
p1          = 3500.00                                  (salary, paid P1)
p2          = max(commission, 3000)   = 3000.00        (guarantee_p2 floor)
amount(P2)  = 3000.00                                  (club bucket, P2)
club_month  = 3500 + 3000             = 6500.00
exec        = max(0, 9166.67 - 6500)  = 2666.67        (INFO step, not amount)
```

## GM exec modes + registry-metric bonuses

`spec_exec_comp_*` in the namespace tells you the mode. Club pay (= the
worksheet `amount`) ALWAYS computes per the normal ladder first. Then the
trailing INFO step (never added to amount), on the P2/full-month worksheet:

- **remainder**: `exec = round(max(0, spec_exec_comp_monthly_total − (p1 + p2)), 2)`
- **fixed**: `exec = spec_exec_comp_fixed_monthly` (every month, flat)
- **guarantee_topup**: `topup = round(max(0, spec_exec_comp_guarantee_floor − (p1 + p2)), 2)`
  — the GM is OWED the topup (their month totals the floor) but it is
  charged to exec, not club: amount stays the computed club pay; the INFO
  step carries the topup with a note "guarantee top-up — paid via exec".

**Registry-metric bonuses** (same rule as trainer plans): a bonuses[] entry
with `metric` + `threshold_pct` → look up `metric_<name>` in the namespace
(direction from the worklist's registry_metrics): `bonus = amount *
(metric_<name> >= threshold)` (or `<=` for lte). Bonus dollars are CLUB pay
— add to the period amount (P2, full-month basis). Missing metric → $0 +
`CONFIRM:unknown_metric:<name>`.

Worked example — Brody-shaped GM, P2 (commission $4,605.38, quota metric 87.2%):
```
commission  = 0.15 * total_sspts            = 4605.38
p2_trueup   = max(commission, 3500) - 3500  = 1105.38
b_quota     = 1000 * (metric_club_total_quota_pct >= 100)   = 0.0
amount(P2)  = 1105.38 + 0.0                 = 1105.38
exec        = 1000.00   (fixed mode — INFO step, not in amount)
```
