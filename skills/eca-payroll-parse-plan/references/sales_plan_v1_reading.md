# Reading a Frontend-Sales Comp Plan → `sales_plan_v1` (Payroll V4)

Mission in one line: **read everything, take only what pays, quote everything you take.**

You are producing a DRAFT. A human reviews and approves it in the Plan Library before
anything activates — your flags and provenance quotes are what they review. An honest
flag is worth more than a confident guess.

## The Iron Sequence (never reorder, never skip)

1. **Read the ENTIRE document** — every page, every section. Skimming is the root cause
   of both recorded extraction failures in this system's history.
2. **Locate the pay-structure section** (usually titled **"Pay Details"**, sometimes
   "Hourly vs. Commission" or "Commissions"). It defines the structure; everything else
   is context.
3. **Build the verbatim quote inventory**: every bullet/sentence that mentions a dollar
   amount, percentage, rate, draw, salary, guarantee, tier, threshold-with-dollars, or
   exclusion — copied exactly.
4. **Classify every line** into exactly one bucket (table below).
5. **Map each PAY-BEARING quote to a spec field**, applying the house interpretations.
6. **A parameter with no quote does not exist.** No defaults from templates or from
   other people's plans. If the plan has no hourly rate, the spec has `hourly_rate: null`.
7. **Attach flags** for anything ambiguous, conflicting, or unmappable.
8. Validate against `sales_plan_v1.schema.json` locally, then `/complete`. The human
   confirmation happens downstream — your job ends at the draft.

## Classification — "take only what is needed"

| Bucket | What goes here | Action |
|---|---|---|
| **PAY-BEARING** (take) | Hourly rate; salary (P1/P2); guarantee (P1/P2); **draw** ("$X draw paid on the first pay period"); commission rates per component; flat-rate clauses ("X% of total success points of all sales"); **exclusions** ("Not including RPs, 1Ws, 5 stars"); tier ladders (SSPTS bands with rates); bonuses with explicit dollars; effective dates; covered clubs | Extract → spec field + verbatim quote in `provenance` + confidence |
| **IGNORED** (read, never extract) | "Results"/expectations sections — SSPTS minimums, tours/shows/deals targets, attach rates, leads-per-day — even when computable; Role Expectations (uniform, punctuality, coachability); Health & Benefits | List under `unmodeled_terms`; zero effect on math |
| **HUMAN-JUDGMENT** (note presence only) | Conduct/forfeiture clauses ("misrepresentation → forfeit of compensation") | Add to `unmodeled_terms`; never model |
| **CONFLICT** (flag, never obey) | Anything contradicting house rules (custom points multiplier, novel P1/P2 mechanic, partial draw forgiveness) | `flags: ["CONFLICT: <short description>"]` + the quote in provenance; a human rules |

## House interpretations (apply silently, reflect in the spec)

- **"X% on EFT" means X% AFTER the ×10 points conversion.** The spec stores the rate
  as a plain decimal (`0.14`); the house compute engine applies the ×10. Never adjust
  the rate yourself.
- **"X% of total success points of all sales"** = one flat rate on EFT+PT+NB points →
  `commission: {eft: X, pt: X, nb: X}`.
- **"(Not including RPs, 1Ws, 5 stars)"** or similar → `service: "EXCLUDED"`,
  `review: "EXCLUDED"`.
- **"$X draw paid on the first pay period"** → `p1_mode: "draw_advance"`,
  `parameters.draw: X`. (The house rule repays the FULL draw from P2 commission.)
- **"$X/hour vs. Commissions"** → `p1_mode: "hourly"`, `parameters.hourly_rate: X`,
  `p2_mode: "max_trueup"` — unless a draw/salary/guarantee quote outranks it.
- Default `p2_mode` for commission-vs-base plans is `"max_trueup"`; `"additive"` only
  when the plan pays commission ON TOP of a salary; `"independent"` for hourly-only
  receptionist-style plans.
- P1/P2 mechanics, true-up, floors, bonus layering are NEVER stated in plans — they are
  fixed house rules. Do not extract or model them; just pick the modes.
- **Effective date**: the job payload carries `source.effective_date` — the
  human-selected date from the upload form. Use it verbatim as the spec's
  `effective_date`; do NOT flag it. (The backend enforces it regardless.) Only if
  the document itself prints a clearly contradicting effective date, add
  `CONFLICT:effective_date` with the quote so a human can rule.
- **Clubs**: list every club the plan covers in `identity.clubs` (5-digit, leading-zero:
  Everett 06902, Wallingford 06904, Columbia 40059, Ballinger 40054). If the document
  doesn't say, flag `CONFIRM:clubs` and use the job's source club hint if present.
- **Identity**: `identity.canonical_name` is "Last, First". The job payload's
  `source.person_name` is the human-entered name — prefer it for canonical_name; if the
  PDF clearly names a DIFFERENT person, flag `CONFIRM_IDENTITY` with both names quoted.

## Known plan shapes (founding fixtures — expect variations, NEVER assume)

| Shape | Signature quotes |
|---|---|
| Hourly-vs-commission, 5 component rates | "$21.30/hour vs. Commissions"; "14% on EFT" |
| + SSPTS tier ladder, + draw | "50,000+ SSPTS: 17% on all"; "$3,500 draw" |
| Draw P1 + flat % of sales points, events excluded | "$3500 draw paid on the first pay period"; "17% of total success points of all sales *(Not including RPs, 1Ws, 5 stars)*" |

## Named traps (each one happened in this system — do not repeat)

1. **Template projection** — assuming the 5-rate template because the document *looks*
   like the family. One real plan had a single flat rate and exclusions.
2. **Skipping Pay Details** — computing P1 as hourly when the plan said draw.
3. **Inventing parameters** — an hourly rate with no quote behind it. No quote → null.
4. **Legacy-config fallback** — there is no legacy config available to you; the plan is
   the contract. Extract only what the PDF says.
5. **Paying the scoreboard** — treating Results targets (e.g. "25,000 SSPTS minimum")
   as pay terms. They are expectations; list under `unmodeled_terms`.

## Output contract

`result.structured_data` must validate against `sales_plan_v1.schema.json`:

- `schema_version`: literal `"sales_plan_v1"`
- `identity`: `{canonical_name, clubs[], role_hint}`
- `effective_date` (`YYYY-MM-DD`), `end_date` (usually null)
- `p1_mode` ∈ salary | guarantee_floor | draw_advance | hourly
- `p2_mode` ∈ additive | max_trueup | independent
- `parameters`: hourly_rate / salary / salary_period2 / guarantee_p1 / guarantee_p2 / draw (numbers or null)
- `commission`: eft / pt / nb (decimal rate, `"EXCLUDED"`, or null) + service / review
  (`{points_per_event, rate}`, `"EXCLUDED"`, or null)
- `tiers`: SSPTS ladder or `[]`
- `bonuses`: explicit-dollar bonuses or `[]`
- `unmodeled_terms`: everything you read and ignored
- `provenance`: **one entry per extracted pay-bearing value** — `{quote, page, confidence}`
- `flags`: `CONFLICT: ...` | `NEEDS_GRAMMAR: ...` | `CONFIRM_IDENTITY` | `CONFIRM:<field>`

Numbers are numbers, never strings. Rates are decimals (`0.17`, not `17`).
Set `result.confidence` to your honest overall confidence and put per-field doubts in
`flags`/`provenance` — the reviewing human sees all of it.

## General Manager plans (role_hint: GM) — the club/exec split

GM comp is unique per person but shares a shape (Ephriam ruling 2026-06-12):
a TOTAL monthly comp split into two buckets —

1. **Club bucket** = the normal pay ladder, charged to club frontend
   payroll. Express it with the EXISTING fields: e.g. Dakota Sheffield's
   "$6,500 to club (unless >$3k commission, then $3,500 + commission)" is
   exactly `p1_mode: salary` + `parameters.salary: 3500` +
   `parameters.guarantee_p2: 3000` (floor) + commission terms. Don't invent
   new structure for the ladder — these rules map to the existing modes.
2. **Exec bucket** = `exec_comp.monthly_total` (the TOTAL monthly comp, e.g.
   9166.67 for $110k/yr) — the computer derives
   `exec_remainder = max(0, monthly_total − club bucket)`. Quote the split
   rule verbatim into `exec_comp.notes` + provenance.

Annual figures: divide by 12 and show the math in provenance ("$110,000/yr
→ 9166.67/mo"). A GM plan with NO total-comp/split language → exec_comp
null (club-only, like any salesperson). Draw-repayment wording (full vs
half-forgiven) is pay-bearing — extract it verbatim; if it contradicts the
house full-repayment rule, flag `DRIFT:draw_repayment`.

## GM exec modes (each GM is unique — extract exactly what the sheet says)

`exec_comp.mode` picks the exec formula:
- **remainder** (Dakota $9,166.67/mo, Andre $9,500/mo): "$6,500 or $3,500 +
  commission to club, whichever is higher; remainder to executive" →
  the ladder stays p1 salary 3500 + guarantee_p2 3000;
  `{mode: "remainder", monthly_total: 9500}`.
- **fixed** (Brody $4,500/mo): "$1,000 salary to Exec, $3,500 to Club" →
  ladder p1 guarantee_floor 3500 + p2 max_trueup (15% personal SSPTS, no
  max); `{mode: "fixed", fixed_monthly: 1000}`.
- **guarantee_topup** (Chase): "guarantee of $8k — if guarantee paid out,
  that extra goes to executive wages" → ladder p1 salary 3500 + p2 additive
  commission; `{mode: "guarantee_topup", guarantee_floor: 8000}`.

**Quota bonuses** ("$1,000 for 100% total quota"): a bonuses[] entry
`{condition: "<verbatim>", amount: 1000, metric: "club_total_quota_pct",
threshold_pct: 100}`. "Total quota" = the club's COMBINED quota (SP + PT,
ClubSummaryTable parity). If `club_total_quota_pct` is not in the worklist
registry yet, PROPOSE it (see below).

## Proposing new metrics (same contract as trainer plans)

When a pay term needs a number the system doesn't measure, emit
`proposed_metrics`: `[{name, description, direction, quote, recipe}]`.
Recipe vocabulary — sources: `pt_sales` (attribution trainer_roster|any,
days, window), `nb_deals`, `events` (event_name), `quota` (kpi fields),
`combined_club_sales` (club SP + trainer PT, ClubSummaryTable parity —
THE basis for "total quota" bonuses), `const`; kinds `ratio_pct` | `value`;
direction `gte` | `lte`. The canonical total-quota recipe:

```json
{"name": "club_total_quota_pct", "direction": "gte",
 "description": "Combined club sales (SP + trainer PT) as a percent of the combined club quota (all SP + PT quota fields)",
 "quote": "$1000 for 100% total quota",
 "recipe": {"kind": "ratio_pct", "round_digits": 1,
   "numerator": {"source": "combined_club_sales", "window": "full_month"},
   "denominator": {"source": "combined_club_quota"}}}
```
`combined_club_quota` is an atomic source with V1's exact math (SP quota =
nbpromo + fept + neweft×10, GM+AGM splits, plus the four PT quota fields) —
use it, never a raw quota-field sum (the neweft ×10 would be lost).
Hand-verified May values: Everett 80.2%, Ballinger 98.5%, Columbia 86.1%.
A human approves the metric with the plan.
