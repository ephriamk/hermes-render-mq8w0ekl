---
name: eca-tomorrow
description: "Tomorrow's plan for one club: the schedule as a timeline, open personal-training slots, bonus workouts with recent PT buyers, and classes with no coach. Use for 'what does tomorrow look like', 'plan for tomorrow', 'staffing tomorrow'."
version: 1.0.0
author: Emerald City Athletics
metadata:
  hermes:
    tags: [ECA, schedule, planning, staffing, personal-training]
    related_skills: [eca-morning-brief, eca-call-list]
---

# ECA tomorrow's plan

## When to use

"What does tomorrow look like?", "plan for tomorrow", "who is working tomorrow", "any gaps
tomorrow?". Works for any single date: use that date in place of tomorrow.

## Steps

1. `eca_whoami` for `today_pacific`. Tomorrow = the next calendar day. Ask which club if the
   person has more than one and did not say.
2. `eca_club_schedule` with `club_number`, `date` = tomorrow, `days` = 1. Leave `include_names`
   out unless the person asks who is booked. Read `by_type` for slots, slots with someone booked,
   and people. If `sources.gymsales.stale` is true, say tours and walk-ins may be missing.
3. Open PT slots: from the schedule, the PT sessions with nobody booked. Give the count and the
   times by trainer. These are open time a trainer could fill, not appointments.
4. `eca_bonus_workouts` with `club_number` (it defaults to tomorrow; pass `date` for another day).
   Note each bonus or temp workout, its trainer, and which members on it bought PT recently
   (default past 30 days): those are the warm conversations for the trainer.
5. `eca_champions_classes` with `club_number`, `date` = tomorrow. List classes that still need a
   coach, with bookings.
6. Coach and staffing gaps: classes with no coach, hours with tours or 1st workouts booked but no
   staff member shown, a trainer with back-to-back sessions all day and bonus workouts on top.
   Only flag what the tools show.

If steps 4 or 5 are refused (managers and head coaches only), leave them out and say so.

## What to send

Two sentences: the shape of the day (for example "31 slots, 19 booked; busiest 4 to 7 PM") and the
biggest gap. Then:

```json
{"eca":"timeline","title":"Columbia · tomorrow, Sun Nov 22","items":[
 {"time":"8:00 AM","title":"1st Workout","who":"Trainer name","detail":"1 booked","tone":"neutral"},
 {"time":"10:00 AM","title":"PT 60 Session","who":"Trainer name","badge":"Open slot","tone":"info"},
 {"time":"5:30 PM","title":"Champions Training","detail":"9 booked","badge":"Needs a coach","tone":"warn"}]}
```

```json
{"eca":"table","title":"Tomorrow by type","columns":["Type","Slots","Booked","People"],
 "align":["left","right","right","right"],"rows":[["PT sessions","14","9","9"],["1st workouts","3","3","3"]]}
```

```json
{"eca":"list","title":"Bonus workouts with recent PT buyers","summary":"2 workouts · 3 recent buyers",
 "items":[{"title":"4:00 PM bonus workout","detail":"Trainer name · 2 members",
           "badges":[{"text":"1 bought PT in the past 30 days","tone":"good"}]}]}
```

Example shapes only. Long days: put the timeline in time order and keep it to the entries that have
someone booked plus the gaps; give the rest as counts in the table.

## Rules that always apply

- Read-only. The `eca` tools only read; never try to change ECA data, and never call ECA web addresses directly.
- Start with `eca_whoami` if you have not this conversation: it gives the clubs this person may see and today's Pacific date (`today_pacific`). A refusal from a tool is final.
- Say the club and the dates for every number. All dates and times are Pacific (Seattle).
- Never invent, estimate or fill in a number. If a tool did not return it, say it is not available.
- The dashboard's "quota %" is projected: `projected_pct_of_quota` = projected full month ÷ quota. `mtd_pct_of_quota` is month to date ÷ quota. Name the one you quote.
- A schedule entry with nobody booked is an open slot, not an appointment. Say "26 slots, 4 booked".
- No member names in anything meant to be shared (files, reports, emails) unless the person asks for them. Names on screen in a call list for this person's own outreach are fine.
- Member names appear only if the person asked who is booked (then call the schedule with `include_names` true).
