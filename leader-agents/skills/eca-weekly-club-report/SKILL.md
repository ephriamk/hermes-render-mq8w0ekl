---
name: eca-weekly-club-report
description: "One-page weekly report for a club: this week against last week, month to date against quota, staff standings, leads and show rates. Saves a file in the workspace and shows a summary card. Use for 'weekly report', 'week in review', 'how did the week go'."
version: 1.0.0
author: Emerald City Athletics
metadata:
  hermes:
    tags: [ECA, report, weekly, dashboard, staff, leads]
    related_skills: [eca-morning-brief, eca-staff-coaching, eca-numbers-explained]
---

# ECA weekly club report

A one-page report a general manager can read in two minutes or hand to their boss.

## When to use

"Weekly report", "week in review", "how did last week go", or a scheduled weekly run. One club per
report; for several clubs write one report each, or use `eca_all_clubs` for a side-by-side table.

## Dates

- The week is Monday to Sunday, Pacific. Default: the most recent complete week. `eca_whoami`
  gives `today_pacific`.
- Call the week's last day E, the Sunday before it P, and the Sunday before that PP.

## Steps

1. Month to date and quota: `eca_club_dashboard` with `club_number`, `business_date` = E.
2. This week against last week. The dashboard is month to date, so a week is a difference:
   - this week = month to date at E minus month to date at P;
   - last week = month to date at P minus month to date at PP.
   Call `eca_club_dashboard` at P and PP too. If a week crosses the 1st of a month, add the two
   parts: (month to date at E) plus (the earlier month's final figure, from `business_date` = that
   month's last day, minus its month to date at P). Do this for NB/Promo, New EFT, Front End PT,
   New PT, Renew PT and deals. State in the report that weekly figures are differences of
   month-to-date totals. If a difference comes out negative (a refund or correction), show it and
   say so; do not hide it.
3. Staff standings: `eca_staff_stats` with `club_number`, `business_date` = E. Top lines per
   salesperson (NB cash, EFT, deals, closing %) and per trainer (PT sales), each with quota and
   projection where the tool gives them.
4. Leads and show rates: `eca_club_extended` with `club_number`, `business_date` = E. Web leads
   and shows by source, call tracking, 1st-workout show rate if present.
5. Before comparing or explaining any figure whose meaning could be read two ways (New EFT, quota %,
   closing %), check `eca_knowledge` and use its wording.

## The file

Save `~/reports/weekly-<club name>-<E as YYYY-MM-DD>.md` in the workspace (create the folder). One
page, in this order: title with club and dates; three-line summary; "This week vs last week" table;
"Month to date vs quota" table (month to date, projected, quota, projected % of quota); "Staff"
table; "Leads and shows" table; "Notes" (anything missing, partial or refused). Staff names are
fine (it is their production). No member names. No pay figures.

## What to send

Two sentences with the headline and where the file is, then:

```json
{"eca":"kpis","title":"Wallingford · week of Nov 9 to Nov 15","items":[
 {"label":"NB/Promo this week","value":9840,"unit":"$","delta":"+12% vs last week","tone":"good"},
 {"label":"Cash, projected","value":97,"unit":"%","delta":"of quota, month to date through Nov 15","tone":"warn"}]}
```

```json
{"eca":"bar","title":"Projected % of quota, month to date","unit":"%","items":[
 {"label":"NB/Promo","value":94,"target":100,"tone":"warn"},{"label":"New EFT","value":103,"target":100,"tone":"good"}]}
```

Example shapes only; every value must come from the tools or from the subtraction in step 2.

## Rules that always apply

- Read-only. The `eca` tools only read; never try to change ECA data, and never call ECA web addresses directly.
- Start with `eca_whoami` if you have not this conversation: it gives the clubs this person may see and today's Pacific date (`today_pacific`). A refusal from a tool is final.
- Say the club and the dates for every number. All dates and times are Pacific (Seattle).
- Never invent, estimate or fill in a number. If a tool did not return it, say it is not available.
- The dashboard's "quota %" is projected: `projected_pct_of_quota` = projected full month ÷ quota. `mtd_pct_of_quota` is month to date ÷ quota. Name the one you quote.
- A schedule entry with nobody booked is an open slot, not an appointment. Say "26 slots, 4 booked".
- No member names in anything meant to be shared (files, reports, emails) unless the person asks for them. Names on screen in a call list for this person's own outreach are fine.
- A percentage change needs both weeks. If last week is zero or missing, give the two amounts and no percentage.
