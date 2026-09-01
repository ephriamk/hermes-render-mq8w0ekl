# parse_pt_agreement_v1 — reading scanned PT agreement forms

This is the authoritative reading contract for single-page scanned Emerald
City Athletics **Personal Training agreement** forms (often handwritten). The
bounded worker makes one primary visual read, one fresh independent verification
read, and deterministic arithmetic/identity/schedule checks. Neither model may
write directly to the PT Postdates tracker or Client Tracker v2. Contract:
`prompt_version pt-agreement-v11-nonfunded-row-verification`, `schema_version pdn-v1`.

## Job shape

Payload: `{"asset_ids": [123]}` — exactly one document per job. A multi-asset
payload is rejected so one lease, one memory boundary, and one audit record map
to one scanned page.

1. Download the PDF (job-scoped):
   `GET $ECA_API_BASE_URL/api/hermes/jobs/{job_id}/pt-asset/{asset_id}/pdf?lease_token={lease_token}`
2. The primary reader reads the complete page plus overlapping identity and PD
   detail views. It must record a draft `member_number` from the page before
   source context is fetched. Zoom on anything faint before calling it blank.
3. Fetch the job-scoped identity cross-check:
   `GET $ECA_API_BASE_URL/api/hermes/jobs/{job_id}/pt-asset/{asset_id}/context?lease_token={lease_token}`.
   Compare `expected_member_number` with the independently read draft. If they
   differ, return to the member-number field, zoom/crop it tightly, and reread
   it left-to-right and right-to-left. Use the source value only when the page
   visibly supports it. If the page visibly differs or remains uncertain,
   preserve the best visible read, mark the extraction partial, and warn about
   the exact uncertain position; deterministic review will hold it.
4. A fresh verifier receives the page views without source metadata or the
   primary answer. It independently returns member/date/form identity, every
   printed PD row 1–5, any row 6+, and an explicit overflow-row decision.
5. Deterministic code compares the two reads and posts the extraction:
   `POST $ECA_API_BASE_URL/api/hermes/jobs/{job_id}/pt-asset/{asset_id}/parse`
   with `{"lease_token": "...", "extraction": { ...pdn-v1 fields... }}`.
   A response of `already_parsed` is fine — move on.
6. If a document cannot be read at all (corrupt download, blank scan), post
   `{"lease_token": "...", "error": "<one line why>"}` instead — NEVER skip
   silently. The error counts toward a retry cap and the ops alert.

After the one asset is acknowledged, `POST /{job_id}/complete` as usual.

## Extraction rules (visible agreement truth, never invented values)

* Extract the agreement as visibly written. Printed values control unless a
  linked handwritten correction is crossed out, arrowed/careted, and/or
  initialled; then the corrected value controls. Preserve what changed in the
  affected field or slot's `note` and never create both an old and corrected
  value as separate money.
* If the form is arithmetically impossible, record the visible values without
  adjusting money and describe the exact difference in `warnings`.
* Not a PT agreement (membership form, waiver, e-sign email, workers-comp
  note...)? → `is_pt_agreement: false`, `form_type: "unknown"`,
  `plan_type: "unclear"`, one warning saying what the document actually is.
  Extract nothing else.
* Always emit `status`, `legible`, `is_pt_agreement`, `form_type`,
  `plan_type`, `agreement_date`, and `contract_version`. Missing promotion
  fields are stored for review and cannot affect the live tracker.
* `plan_type`: `payment_plan` when the PD schedule has funded rows;
  `paid_in_full` only when there are no funded PD rows, paid today equals the
  page total, and remaining balance is zero or blank; else `unclear`. A signing
  payment by itself never proves paid-in-full and never proves collection.
* Dates ISO (`YYYY-MM-DD`) in `*_iso`/date fields; the controlling visible form
  is preserved in `*_text` fields.
* `member_number` is an identity field: first copy it from the PDF digit by
  digit with leading zeros, then fetch the job-scoped context and compare the
  two strings position by position. On any mismatch, tightly zoom/crop the
  printed field and independently reread it from right to left before
  submitting. Never transpose, reorder, or blindly copy context to fit an
  expectation. If any digit remains uncertain, keep the literal best visible
  read, set `status: "partial"`, and name the uncertain position in `warnings`
  so source mismatch review can catch it.

## pd_slots — one entry per PD row on the page, in order

```json
{"ordinal": 1, "state": "filled", "amount_text": "221.0", "amount_value": 221.0,
 "date_text": "04/10/2026", "date_iso": "2026-04-10", "note": null}
```
`state`: `filled` (real date + amount) · `zero` (0/0.00) · `blank`.

**The slip prints five rows. That is a property of the paper, not a limit on
the plan.** When a plan runs longer, staff write the extra postdates BY HAND
underneath the printed slip, usually initialled. Those are real, signed,
collectable charges and you MUST record them — continue the ordinals past 5
(6, 7, …) exactly as they appear down the page. Note the handwriting in that
slot's `note` (e.g. "handwritten below the printed slip, initialled"), never
as a reason to omit it.

### Corrections are edits, not extra slots

Before assigning an ordinal to handwriting below the slip, decide whether it
is a genuinely new installment or a correction linked to an existing row.

* A separate overflow installment needs its own visible amount and date (or an
  unmistakable repeat/ditto amount associated with that new date).
* A strike-through, arrow, caret, "change to" mark, or initialled replacement
  linked to an existing amount/date updates that same slot. Store only the
  controlling value and explain the replaced text in `note`.
* When a linked correction changes only the date, retain the amount already
  written on that same installment. This is row association, not an inferred
  extra charge.
* Do not create a blank-amount slot for a standalone date when an arrow or
  correction mark visibly connects it to the preceding installment.

Concrete pattern: five printed rows are followed by handwritten
`242.77 6/26/26`, then an arrow from that date to an initialled `6/19/2026`.
That is one ordinal 6 with amount `242.77`, controlling date `2026-06-19`, and
a note that `6/26/26` was corrected. It is not ordinals 6 and 7.

Do not cap at five. An earlier contract did, and the reader dutifully wrote
"not recordable as ordinal 6 (schema caps at 5)" while $12,352 of postdates
across 30 agreements went uncaptured — every one of them read correctly and
then discarded. `check_pd_sum_equals_remaining` failing while all five printed
rows are filled is the signature of exactly this: look below the slip before
you conclude the form is inconsistent.

Ordinals are accepted up to 20. If a page genuinely appears to carry more than
that, record the first 20 and say so loudly in `warnings` rather than guessing.

## Independent verification — fail closed

The verifier must explicitly return rows 1–5 even when every row is blank or
zero. Missing/malformed rows, duplicate/non-contiguous ordinals, invalid row
states, or an omitted overflow decision force `status: "partial"` and human
review. `overflow_rows_seen: true` without matching row 6+ transcriptions also
forces review. Empty-vs-empty fingerprints are never accepted as proof that a
schedule is absent unless the verifier explicitly covered all five printed
rows and confirmed that no overflow rows were seen.

## contract_version — copy the `schema_version` from the top of THIS file

Set `contract_version` to the `schema_version` value printed in the header
above, verbatim, on every extraction. It is not decoration: this file is
mirrored to the worker's machine, and on 2026-07-30 the repo copy was updated
while the worker kept reading a stale mirror — so a fix that had shipped
silently never reached the reader. Echoing the version you actually read makes
that mismatch announce itself on the first document instead of never.

## The five checks (booleans computed from controlling visible values; explain any
failure in `warnings`)

| check | meaning |
|---|---|
| `check_sessions_math` | sessions × amount_per_session = sub_total |
| `check_subtotal_plus_tax_equals_total` | sub_total + tax = total |
| `check_paid_plus_remaining_eq_total` | total_paid_today + remaining_balance = total |
| `check_pd_sum_equals_remaining` | Σ funded PD amounts = remaining_balance |
| `check_tax_rate_sane` | tax / sub_total ≈ 8–11% (WA) |

Arithmetic checks describe the paper; they do not measure legibility. When
every relevant value is readable but a check is false, keep `status: "ok"`,
set the check to `false`, and write the discrepancy in `warnings`. Use
`status: "partial"` only when content needed for the extraction is genuinely
illegible, cut off, or uncertain. Never alter an installment to force a check
to pass.

## Full field list

`is_pt_agreement, legible,
status ("ok"|"partial"|"unreadable" — REQUIRED; "ok" when the form read cleanly;
"partial" when sections were illegible or cut off; "unreadable" when the
scan is garbage; omission routes the extraction to review and does not
promote it),
form_type ("New PT"|"Renew PT"|"unknown"),
plan_type, agreement_date, start_date, expiration_date, member_last_name,
member_first_name, member_number, trainer, sold_by, number_of_sessions,
amount_per_session, sub_total, tax, total, total_paid_today,
remaining_balance, duration_of_sessions, number_of_months, sessions_per_week,
signature_present, pd_slots[], the five checks, confidence (0–1),
contract_version, source_sha256, warnings[]` — warnings verbose and specific,
one string per observation (e.g. "Sub Total 400.00 + Tax 40.00 = 440.00 does
not equal printed Total 442.00 (off by 2.00)").

### source_sha256 — the cross-attribution guard (REQUIRED)

Set `source_sha256` to the SHA-256 hex digest of the EXACT PDF bytes you
extracted from — compute it on the downloaded file itself (`sha256sum` /
`hashlib.sha256`), per document, before reading. When a job carries several
asset_ids, compute each document's hash separately and keep it paired with
that document's extraction to the end.

Why it is required: batch reads on 2026-07-31/08-01 posted extractions
against each other's assets in off-by-one rotations — 20 documents ended up
carrying another member's parse, and live charges displayed the wrong
member's signed agreement. The server refuses any extraction whose
`source_sha256` does not match the asset it is posted to, so a mis-paired
write now fails loudly at delivery instead of silently mis-filing. An
extraction without the field is still accepted (older contract), but always
send it.

## Promotion boundary

The backend always stores the extraction as immutable evidence. It promotes
the attempt into the live tracker only when the contract matches, the document
is explicitly complete and legible, the PT form/plan/identity are recognized,
every funded row has both date and amount, and no required arithmetic check is
MISSING. A check that is present and explicitly `false` — internally
inconsistent printed numbers, faithfully transcribed — promotes anyway
(owner ruling 2026-09-01): the schedule reaches the tracker flagged
`header_math_inconsistent`, and your warnings are what the human reads to
resolve the paper, so keep them verbose and exact. A blank printed
remaining-balance box does not invalidate an otherwise complete future
schedule. Signature presence and `total_paid_today` never prove collection.
