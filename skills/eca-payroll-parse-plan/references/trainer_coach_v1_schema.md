# trainer_coach_v1 — Compensation Plan JSON Schema

Single source of truth for the JSON shape Hermes must produce when processing a `parse_comp_plan` job whose `compensation_plans.plan_type` is `trainer_coach`.

The output goes inside `result.structured_data` on the `/complete` POST. The backend stores it verbatim on `compensation_plans.structured_data` (JSONB).

**Match this schema exactly.** The `schema_version` field is how the backend (and future Hermes runs) know how to interpret older rows.

---

## Top-level shape

```json
{
  "schema_version": "trainer_coach_v1",
  "plan_meta": { ... },
  "session_commission": { ... },
  "class_pay": { ... },
  "bonuses": [ ... ],
  "policy_flags": { ... },
  "head_coach_addendum": null | { ... },
  "raw_extracted_text_summary": "string",
  "parser_self_assessment": { ... }
}
```

Required: every key above. If a section doesn't apply (e.g. `head_coach_addendum`), use `null`, not `{}`.

---

## plan_meta

```json
{
  "plan_meta": {
    "plan_title": "SEATTLE TRAINER AND COACH COMPENSATION PLAN 9.1.25",
    "effective_date": "2025-09-01",        // ISO YYYY-MM-DD
    "region": "Seattle",                    // free-text, e.g. "Seattle", "Maryland"
    "applies_to_positions": [               // array of strings
      "Personal Trainer",
      "Group Fitness Coach"
    ],
    "document_revision": "9.1.25",          // free-text version label from the doc
    "source_filename": "SEATTLE TRAINER AND COACH COMPENSATION PLAN 9.1.25.pdf"
  }
}
```

---

## session_commission

The trainer's per-session pay structure. Use cents-clean numbers (no `"$"`, no commas).

```json
{
  "session_commission": {
    "rate_table_type": "tier_based",        // "tier_based" | "flat" | "hybrid"
    "tiers": [
      {
        "tier": 1,                           // integer rank, 1 = lowest
        "label": "Trainer 1",                // exact text from the doc
        "session_count_threshold": 0,        // 0 = base; thresholds are *minimum* session counts
        "rate_per_session": 18.0,            // dollars; number, not string
        "applies_to": "all_sessions"         // "all_sessions" | "regular_only" | "pass_off_only"
      },
      {
        "tier": 2,
        "label": "Trainer 2",
        "session_count_threshold": 30,
        "rate_per_session": 20.0,
        "applies_to": "all_sessions"
      }
      // ... continue for every tier in the doc
    ],
    "pass_off_rate": 12.0,                   // explicit pass-off rate if listed; else null
    "expired_session_rate": 8.0,             // rate for sessions taken from expired packages; null if not in doc
    "graduated_pass_off_rules": null,        // explicit graduated rules object; usually null for v1
    "notes": "Tier promotion is based on rolling 90-day completed sessions."
  }
}
```

Tier ordering: ascending by `session_count_threshold`. The backend assumes the array is sorted; do the sort yourself before submitting.

---

## class_pay

Group fitness / class instruction. Independent from session commission.

```json
{
  "class_pay": {
    "structure": "per_class_flat",           // "per_class_flat" | "per_class_attendance_tiered" | "salary" | "none"
    "base_rate_per_class": 25.0,             // null if not flat
    "attendance_tiers": null,                // array of {min_attendees, rate} if tiered; else null
    "notes": "Coaches teaching their own programmed classes earn at the flat per-class rate."
  }
}
```

---

## bonuses

Array of bonus structures. **Each bonus is one object.** Empty array `[]` if the doc has no bonus section.

```json
{
  "bonuses": [
    {
      "bonus_name": "Personal PT Sales",
      "applies_to": ["fitness_director"],     // array of position labels
      "trigger": "personal_pt_sales >= 5000",  // human-readable threshold
      "trigger_threshold_amount": 5000.0,      // numeric, in dollars
      "trigger_threshold_metric": "personal_pt_sales_monthly",
      "payout_structure": "percent_of_metric", // "flat" | "percent_of_metric" | "tiered"
      "payout_value": 0.15,                    // 15% as decimal
      "payout_cap": null,                      // dollar cap, if any
      "frequency": "monthly",                  // "monthly" | "p2_only" | "annual"
      "notes": "Calculated on full month, paid in P2."
    },
    {
      "bonus_name": "1W Show",
      "applies_to": ["fitness_director"],
      "trigger": "first_workout_show_pct >= 70",
      "trigger_threshold_amount": 70.0,
      "trigger_threshold_metric": "first_workout_show_percent",
      "payout_structure": "flat",
      "payout_value": 250.0,
      "payout_cap": null,
      "frequency": "p2_only",
      "notes": "Round to integer percent."
    }
    // ... etc
  ]
}
```

Every bonus must have all eight required fields. Use `null` only where the schema explicitly allows it (`payout_cap`, occasionally `trigger_threshold_amount` for non-numeric triggers).

---

## policy_flags

Boolean / categorical flags that affect downstream payroll logic.

```json
{
  "policy_flags": {
    "draw_eligible": true,
    "guarantee_eligible": false,
    "head_coach_eligible": false,
    "audit_score_required": true,
    "expired_sessions_paid": true,
    "pass_off_sessions_paid": true,
    "ct_included_sessions_paid": true,
    "split_session_pay_method": "split_evenly", // "split_evenly" | "primary_takes_all" | "see_addendum" | "n/a"
    "notes": "Audit score < 80 reduces session rate by 10% — see audit policy doc."
  }
}
```

If a flag isn't addressed in the document, default to `false` and add a warning in `parser_self_assessment.warnings` saying which flags were defaulted.

---

## head_coach_addendum

Only present for plans that include head-coach-specific terms. `null` for regular trainer plans.

```json
{
  "head_coach_addendum": {
    "guarantee_amount": 1500.0,              // monthly guarantee
    "guarantee_paid_in_table": "group_fitness",  // "group_fitness" | "personal_training" | "split"
    "additional_responsibilities": [
      "Programming weekly classes",
      "Onboarding new coaches"
    ],
    "additional_pay": 200.0,                 // flat monthly stipend on top of guarantee, if any
    "notes": "If trainer also does PT sessions, guarantee counts only in group_fitness — PT table skips guarantee per existing payroll rules."
  }
}
```

---

## raw_extracted_text_summary

A 1–3 sentence plain-text summary of what the document actually says. Used as a sanity check / human-friendly preview in the admin UI.

```json
{
  "raw_extracted_text_summary": "Seattle trainer & coach plan, effective Sept 1 2025. Six tier levels from $18 to $35/session, gated by 30-day rolling session count. $250/$750 FD bonuses for 1W show and 30-Day RP percentages, with a 70% threshold each."
}
```

---

## parser_self_assessment

Hermes's honest read on its own output. Used to surface low-confidence parses to the human reviewer.

```json
{
  "parser_self_assessment": {
    "confidence": 0.92,                       // 0.0 to 1.0
    "warnings": [
      "tier 4 rate_per_session was specified as a range ($28-$30) — used $28 (lower bound)",
      "policy_flags.audit_score_required was not explicitly stated; defaulted to true based on regional precedent"
    ],
    "fields_extracted_directly": 24,          // count of fields lifted verbatim from the PDF
    "fields_inferred": 3,                     // count of fields inferred from context
    "fields_defaulted": 1,                    // count of fields filled with documented defaults
    "model_used": "claude-opus-4.6"           // identifier of the LLM that did the extraction
  }
}
```

`confidence < 0.7` should also include a top-level warning in `result.warnings` on the `/complete` POST so the admin UI flags the row for human review.

---

## Validation checklist before /complete

Before you POST the result, verify:

- [ ] `schema_version == "trainer_coach_v1"` exactly
- [ ] All eight top-level keys are present (use `null` where applicable, not missing)
- [ ] All numeric fields are numbers (no `"$30"`, no `"30"`)
- [ ] `plan_meta.effective_date` is a valid ISO date
- [ ] `session_commission.tiers` is sorted ascending by `session_count_threshold`
- [ ] Every bonus object has all eight required keys
- [ ] `parser_self_assessment.confidence` is between 0.0 and 1.0
- [ ] You explained every field you couldn't find in `parser_self_assessment.warnings`

If any check fails, fix it before submitting. If a check fails because the PDF genuinely doesn't have the data, document that in `warnings` and submit anyway with lowered confidence — the admin will review.
