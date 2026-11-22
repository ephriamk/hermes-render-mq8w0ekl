---
name: eca-morning-brief
description: "Morning brief for a club leader: yesterday's numbers against quota, today's schedule, Champions classes still needing a coach, who to call, and three suggested actions. Use for 'morning brief', 'how are we doing', 'what's my day', 'catch me up'."
version: 1.0.0
author: Emerald City Athletics
metadata:
  hermes:
    tags: [ECA, brief, dashboard, schedule, daily]
    related_skills: [eca-call-list, eca-tomorrow, eca-numbers-explained]
---

# ECA morning brief

A one-screen start to the day for a general manager or other club leader.

## When to use

The person asks for a morning brief, a daily summary, "how are we doing", "what does my day look
like", or opens the day with no specific question. Also the right playbook for a scheduled daily run.

## Steps

1. `eca_whoami`. Note `today_pacific` and the clubs. Yesterday = the day before `today_pacific`.
   One club: do the steps for it. Several clubs: do step 2 with `eca_all_clubs`, then steps 3 to 5
   for the person's main club (ask once which one if their notes file does not say).
2. Numbers. `eca_club_dashboard` with `club_number` (leave `business_date` out: it defaults to
   yesterday, the last complete day). For several clubs use `eca_all_clubs` (same default).
   Pull NB/Promo, New EFT, Front End PT, New PT, Renew PT and total cash: month to date, projected,
   quota, and `projected_pct_of_quota`.
3. Today's schedule. `eca_club_schedule` with `club_number`, `date` = today, `days` = 1.
   Use `by_type`: slots, how many have someone booked, how many people.
4. Classes. `eca_champions_classes` with `club_number`, `date` = today. List any class that still
   needs a coach, and the members at or near a milestone from the day guide (counts only unless asked).
   If the tool refuses (it is for managers and head coaches), skip this part and say so in one line.
5. Who to call. `eca_first_workout_followups` with `club_number` (default 30 days). Count the new
   members with no 1st workout done, and how many of those have none booked. If refused, skip it.
6. Three actions. Each must point at a number from steps 2 to 5 (for example the metric furthest
   under 100% projected, a class with no coach, the unbooked 1st workouts). No generic advice.

## What to send

Two sentences first: the headline (cash projected vs quota) and the one thing that needs attention.
Then these cards, in this order. Leave a card out if its tool was refused or returned nothing.

```json
{"eca":"kpis","title":"Everett · month to date through Nov 20","items":[
 {"label":"NB/Promo","value":41250,"unit":"$","delta":"94% of quota, projected","tone":"warn","hint":"Quota 62,000"},
 {"label":"New EFT","value":3120,"unit":"$","delta":"103% of quota, projected","tone":"good"}]}
```

```json
{"eca":"timeline","title":"Everett · today, Sat Nov 21","items":[
 {"time":"9:00 AM","title":"Champions Training","who":"Coach name","detail":"8 booked","tone":"neutral"},
 {"time":"6:00 PM","title":"Champions Training","detail":"5 booked","badge":"Needs a coach","tone":"warn"}]}
```

```json
{"eca":"list","title":"Three things to do today","items":[
 {"title":"Assign a coach to the 6:00 PM class","detail":"5 members booked, no coach yet"},
 {"title":"Call the 7 new members with no 1st workout booked","detail":"Ask for the call list"}]}
```

The numbers above are examples of the shape only. Put real values from the tools in every field.
Use tone good at or above 100% projected, warn from 90 to 99, bad below 90.

## Rules that always apply

- Read-only. The `eca` tools only read; never try to change ECA data, and never call ECA web addresses directly.
- Start with `eca_whoami` if you have not this conversation: it gives the clubs this person may see and today's Pacific date (`today_pacific`). A refusal from a tool is final.
- Say the club and the dates for every number. All dates and times are Pacific (Seattle).
- Never invent, estimate or fill in a number. If a tool did not return it, say it is not available.
- The dashboard's "quota %" is projected: `projected_pct_of_quota` = projected full month ÷ quota. `mtd_pct_of_quota` is month to date ÷ quota. Name the one you quote.
- A schedule entry with nobody booked is an open slot, not an appointment. Say "26 slots, 4 booked".
- No member names in anything meant to be shared (files, reports, emails) unless the person asks for them. Names on screen in a call list for this person's own outreach are fine.
- Today's own sales are partial until tonight's data load. The brief reports yesterday as complete; if asked about today, say it is partial.
