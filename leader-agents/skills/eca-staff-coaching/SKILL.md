---
name: eca-staff-coaching
description: "Coaching prep for one salesperson or trainer: their production against quota, the specific sales and records behind it, and talking points for the one-on-one. Use for 'how is <name> doing', 'prep me for my one-on-one with <name>', 'coach <name>'."
version: 1.1.0
author: Emerald City Athletics
metadata:
  hermes:
    tags: [ECA, coaching, staff, sales, personal-training, one-on-one]
    related_skills: [eca-weekly-club-report, eca-numbers-explained, eca-pay-questions]
---

# ECA staff coaching

## When to use

A leader asks how one salesperson or trainer is doing, wants to prepare a one-on-one, or asks why
someone is behind or ahead.

## Steps

1. Which person, which club, which month. Default: this month through yesterday.
2. `eca_staff_stats` with `club_number` (and `business_date` for a past month: its last day).
   Find the person's rows. Salesperson: NB cash, EFT, PT, units, deals, tours, closing %, average
   EFT, 1st workouts, reviews. Trainer: PT sales (new and renew), activity counts, 1st-workout show
   rate, 5-star reviews. Take the quota and projection for each where the tool gives them.
   If the name matches more than one person, ask which.
3. The records behind the numbers:
   - `eca_sales_records` with `club_number`, `category` (one of nb_promo, eft, fe_pt, coaches_pt,
     pt_units_fe_new, pt_units_be_new, pt_units_be_renew, pt_units_total, collections, pif) and
     `period` = "mtd". Keep only the rows credited to this person.
   - `eca_kpi_records` with `club_number`, `category` (deals, first_workouts,
     first_workouts_five_star, google_reviews, reprograms, five_star, downgrade_fees). Keep this
     person's rows.
   Pick the categories that explain the gap: for a salesperson behind on NB, nb_promo and deals; for
   a trainer behind on PT, coaches_pt and first_workouts.
4. Put them in context: the same lines for the club's other staff from step 2 (rank, not a ranking
   table of names unless asked).
5. When asked to rank or pick people ("who is furthest behind", "bottom two"): a row with a quota
   but no tours, no deals and no sales for the whole period is almost always someone who is not
   working sales this month (new, on leave, moved role), not someone to coach. Do not rank them.
   Name them once in a separate line ("No activity this month: <name>. Worth confirming their
   status.") and pick from the people who have activity. The same goes for a trainer with a quota
   and no sessions or sales.
6. If a term could be read two ways, check `eca_knowledge` first (closing %, average EFT, 5-star %
   and "quota %" each have more than one definition).

## What to send

Two sentences: where the person stands against quota, and the main reason the records show. Then:

```json
{"eca":"kpis","title":"Salesperson name · Ballinger · November through Nov 20","items":[
 {"label":"NB cash","value":8420,"unit":"$","delta":"88% of quota, projected","tone":"bad"},
 {"label":"Closing %","value":41,"unit":"%","hint":"12 deals from 29 tours","tone":"neutral"}]}
```

```json
{"eca":"table","title":"The sales behind NB cash","columns":["Date","Item","Amount"],
 "align":["left","left","right"],"rows":[["Nov 3","Access membership","$129"]]}
```

```json
{"eca":"list","title":"Talking points","items":[
 {"title":"Tours are there, closes are not","detail":"29 tours, 12 deals: role-play the price presentation"},
 {"title":"No deals on weekends","detail":"All 12 deals were Monday to Thursday"}]}
```

Example shapes only. Three to five talking points, each tied to a number or a record you showed.
Start with something the person is doing well if the numbers show one.

## Rules that always apply

- Read-only. The `eca` tools only read; never try to change ECA data, and never call ECA web addresses directly.
- Start with `eca_whoami` if you have not this conversation: it gives the clubs this person may see and today's Pacific date (`today_pacific`). A refusal from a tool is final.
- Say the club and the dates for every number. All dates and times are Pacific (Seattle).
- Never invent, estimate or fill in a number. If a tool did not return it, say it is not available.
- The dashboard's "quota %" is projected: `projected_pct_of_quota` = projected full month ÷ quota. `mtd_pct_of_quota` is month to date ÷ quota. Name the one you quote.
- A schedule entry with nobody booked is an open slot, not an appointment. Say "26 slots, 4 booked".
- No member names in anything meant to be shared (files, reports, emails) unless the person asks for them. Names on screen in a call list for this person's own outreach are fine.
- The sales table leaves member names out unless the person asks for them: date, item and amount are enough to coach from.
- Pay is a separate question with its own rules: use the eca-pay-questions playbook, and never put pay in coaching notes.
- A tool refusing means this person may not see that staff member's records. Do not look for another way.
