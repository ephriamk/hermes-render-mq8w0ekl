---
name: eca-pay-questions
description: "Answer pay questions safely: the person's own pay (eca_my_pay) and, for managers and head coaches, the team pay their portal shows (eca_club_pay), with ECA's confidentiality rules. Use for 'what's my pay', 'how was my check worked out', 'what is my team getting paid'."
version: 1.0.0
author: Emerald City Athletics
metadata:
  hermes:
    tags: [ECA, pay, payroll, confidential]
    related_skills: [eca-numbers-explained, eca-staff-coaching]
---

# ECA pay questions

Pay is the most private thing these tools return. Answer exactly what was asked, to this person only.

## When to use

"What am I getting paid?", "how was my pay worked out?", "why is my check different?", "what is my
team's pay this period?", "who has no pay plan?".

## Own pay

1. `eca_my_pay` with no arguments for the recent pay periods. For the working behind one period,
   pass `month` (YYYY-MM) and `pay_period` ("1" = the 1st to the 15th, "2" = the 16th to month end).
2. Report the amount for each period, whether it was adjusted, and (when asked how) the worksheet
   lines the tool returns, in the order it returns them.
3. To explain a line (a bonus, a tier, a guarantee, a draw), look the term up with `eca_knowledge`
   first and use its wording.

## Team pay

1. `eca_club_pay` with `month`, and `club_number`, `pay_period`, `team` (for example
   frontend-sales, personal-training, group-fitness) when given. For one person's worksheet add
   `person` = their name.
2. It returns exactly what this person's My Club page shows. If it refuses, this person's portal
   does not show team pay: say so and stop. Do not try to work pay out from sales or other tools.
3. Report totals first; individual amounts only when the person asks for them.

## What to send

Own pay: one sentence with the amount and the period, then, if they asked how it was worked out:

```json
{"eca":"table","title":"Your pay · November, period 1 (Nov 1 to 15)","columns":["Line","Amount"],
 "align":["left","right"],"rows":[["Line from the worksheet","$0.00"],["Total","$0.00"]]}
```

Team pay: the total and the count of people first; a table of names and amounts only on request.
The table above is the shape only: every line and amount must come from the tool.

## Confidentiality rules

- `eca_my_pay` is this person's own pay and never anyone else's. Do not offer to look up another
  person's pay for someone whose `eca_club_pay` is refused.
- Keep pay out of anything meant for other people: reports, files, email drafts, call lists,
  coaching notes, scheduled briefs. Only put it there if this person asks for that in so many words,
  and then say once that the file or draft now contains pay.
- Never write pay figures in the notes file (`~/ECA-notes.md`) or in a skill.
- Do not compare one named person's pay with another's unless asked, and do not comment on whether
  someone's pay is fair.
- The tools show pay as the portal shows it. You cannot change pay, and you do not decide it: for a
  correction, tell the person to raise it with payroll (Ephriam).
- If a pay period is not processed or approved yet, the amount can still change: say so.

## Rules that always apply

- Read-only. The `eca` tools only read; never try to change ECA data, and never call ECA web addresses directly.
- Start with `eca_whoami` if you have not this conversation: it gives the clubs this person may see and today's Pacific date (`today_pacific`). A refusal from a tool is final.
- Say the club and the dates for every number. All dates and times are Pacific (Seattle).
- Never invent, estimate or fill in a number. If a tool did not return it, say it is not available.
- The dashboard's "quota %" is projected: `projected_pct_of_quota` = projected full month ÷ quota. `mtd_pct_of_quota` is month to date ÷ quota. Name the one you quote.
- A schedule entry with nobody booked is an open slot, not an appointment. Say "26 slots, 4 booked".
- No member names in anything meant to be shared (files, reports, emails) unless the person asks for them. Names on screen in a call list for this person's own outreach are fine.
- Never estimate pay. If the worksheet is not there, say it is not available yet.
