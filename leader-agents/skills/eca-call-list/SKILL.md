---
name: eca-call-list
description: "Outreach call lists for a club: new members who have not done a 1st workout, recent personal-training buyers with no session booked, and guests who toured and did not join. Use for 'who should we call', 'call list', 'follow-ups', 'outreach'."
version: 1.0.0
author: Emerald City Athletics
metadata:
  hermes:
    tags: [ECA, outreach, calls, members, guests, personal-training]
    related_skills: [eca-morning-brief, eca-tomorrow]
---

# ECA call list

Builds a list of people to call, with the reason for each call. These tools are for managers and
their own clubs only; if one refuses, say so and stop that list.

## When to use

"Who should we call today?", "who hasn't done their first workout?", "PT buyers with nothing
booked", "guests who toured last week and didn't join", or any follow-up or outreach list.
If the person does not say which list, offer the three below and build the first.

## List 1: new members with no 1st workout

1. `eca_first_workout_followups` with `club_number`, and `days` if they gave a window (default 30,
   max 90).
2. Sort: no 1st workout booked first, then oldest join date first.
3. Each row: name, join date, salesperson, membership, "Booked" or "Not booked", phone.

## List 2: recent PT buyers with no session booked

1. `eca_search_sales` with `club_number`, `from` = 30 days ago (or their window),
   `profit_centers` = ["Personal Training - NEW", "Personal Training - RENEW"],
   `resolve_members` = true.
2. Collect the `member_id` values. `eca_search_appointments` with `club_number`, `from` = today,
   `to` = 30 days from today, `event_types` = ["pt"], `member_ids` = those ids.
3. A buyer is "not booked" when no upcoming PT appointment came back for their id. Buyers with no
   `member_id` cannot be checked: list them separately as "could not check".
4. `eca_member_lookup` with `club_number` and the not-booked `member_ids` for phone and email.
5. Each row: name, what they bought and when, who sold it, "No session booked", phone.

## List 3: guests who toured and did not join

1. `eca_search_guests` with `club_number`, `from` (default 14 days ago), `joined` = false.
2. `joined` is GymSales' own mark. To be sure someone did not join, check
   `eca_search_sales` with the same dates, `profit_centers` = ["New Business"] and `member` = their
   name; drop anyone with a New Business sale.
3. Each row: name, visit date, source, salesperson, phone.

## What to send

One sentence with the counts, then one list card per list:

```json
{"eca":"list","title":"Everett · new members without a 1st workout (joined Oct 22 to Nov 20)",
 "summary":"12 to call · 4 already booked",
 "items":[{"title":"Member name","detail":"Joined Nov 3 · sold by Salesperson","meta":"(425) 555-0100",
           "badges":[{"text":"Not booked","tone":"bad"}]}]}
```

Example shape only: every name, date and phone must come from the tools. Over 40 people: show the
first 40 on the card, say how many more, and offer to save the full list as a file in the workspace.

## Rules that always apply

- Read-only. The `eca` tools only read; never try to change ECA data, and never call ECA web addresses directly.
- Start with `eca_whoami` if you have not this conversation: it gives the clubs this person may see and today's Pacific date (`today_pacific`). A refusal from a tool is final.
- Say the club and the dates for every number. All dates and times are Pacific (Seattle).
- Never invent, estimate or fill in a number. If a tool did not return it, say it is not available.
- The dashboard's "quota %" is projected: `projected_pct_of_quota` = projected full month ÷ quota. `mtd_pct_of_quota` is month to date ÷ quota. Name the one you quote.
- A schedule entry with nobody booked is an open slot, not an appointment. Say "26 slots, 4 booked".
- No member names in anything meant to be shared (files, reports, emails) unless the person asks for them. Names on screen in a call list for this person's own outreach are fine.
- A call list on screen for this person's own outreach may show names and phone numbers. Do not put them in a file, email draft or report unless the person asks, and never in the notes file.
- Say plainly what "not booked" means in the list you built (no upcoming appointment of that type in the window you searched).
