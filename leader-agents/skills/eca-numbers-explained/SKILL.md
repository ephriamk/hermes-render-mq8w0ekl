---
name: eca-numbers-explained
description: "Explain any ECA number: look it up in the knowledge base first, name which definition is meant, show the formula, then the live number. Use for 'what is New EFT', 'how is quota % worked out', 'why does this number differ', 'what counts as a deal'."
version: 1.0.0
author: Emerald City Athletics
metadata:
  hermes:
    tags: [ECA, definitions, metrics, knowledge, dashboard]
    related_skills: [eca-morning-brief, eca-weekly-club-report, eca-staff-coaching]
---

# ECA numbers explained

Several ECA terms mean more than one thing (New EFT, Champions, "quota %", closing %, 5-star %).
Explaining the wrong one is worse than not answering.

## When to use

"What is ...?", "how is ... calculated?", "why is this different from that?", "what counts as ...?",
or whenever you are about to compare or explain a number and are not certain which definition the
screen uses.

## Steps

1. `eca_knowledge` with `query` = the term or question. Read the best topic in full with
   `eca_knowledge` and `id` = that topic's id. Do this before anything else, every time.
2. If the term has more than one definition, name the one you are explaining and say which screen
   or report uses it. If you cannot tell which one the person means, ask one short question.
3. Give the formula in plain words, then as one line of arithmetic.
4. Get the live number with the tool that matches the definition:
   - club totals, quotas, projections: `eca_club_dashboard` (one club) or `eca_all_clubs`;
   - leads, call tracking, post dates, membership mix, PT units, attrition trend: `eca_club_extended`;
   - a person's numbers: `eca_staff_stats`;
   - targets: `eca_kpi_quotas`;
   - the rows that add up to it: `eca_sales_records` or `eca_kpi_records`.
   Show the parts and the result, so the person can see the formula produce the number.
5. If two numbers the person is comparing use different definitions, say that first: it is usually
   the whole answer.
6. Not in the knowledge base, or the person corrects how a term works: say what is missing, file it
   with `eca_suggest_knowledge` (Ephriam reviews every suggestion) and say you did. Do not make up
   a definition.

## What to send

Plain words, in this order: the definition and which one it is; the formula; the live number with
club and dates; the trap, if the knowledge base lists one. A card helps when there are parts to add:

```json
{"eca":"table","title":"Everett · projected cash, month to date through Nov 20",
 "columns":["Part","Amount"],"align":["left","right"],
 "rows":[["Month to date","$182,400"],["Days elapsed","20 of 30"],["Projected (182,400 ÷ 20 × 30)","$273,600"],
         ["Quota","$280,000"],["Projected % of quota","97.7%"]]}
```

Example shape only; the values must come from the tools.

## Rules that always apply

- Read-only. The `eca` tools only read; never try to change ECA data, and never call ECA web addresses directly.
- Start with `eca_whoami` if you have not this conversation: it gives the clubs this person may see and today's Pacific date (`today_pacific`). A refusal from a tool is final.
- Say the club and the dates for every number. All dates and times are Pacific (Seattle).
- Never invent, estimate or fill in a number. If a tool did not return it, say it is not available.
- The dashboard's "quota %" is projected: `projected_pct_of_quota` = projected full month ÷ quota. `mtd_pct_of_quota` is month to date ÷ quota. Name the one you quote.
- A schedule entry with nobody booked is an open slot, not an appointment. Say "26 slots, 4 booked".
- No member names in anything meant to be shared (files, reports, emails) unless the person asks for them. Names on screen in a call list for this person's own outreach are fine.
- The knowledge base wins over your own memory of how gyms or dashboards usually work.
