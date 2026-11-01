---
name: scheduling
description: Send a prompt back to this session later or on a repeat with the toriel_schedule_create tool. Use for "check again in an hour", "wait for X then continue", or recurring checks - not for work you can finish now.
---

# Scheduling your own follow-ups

`toriel_schedule_create` puts a prompt into THIS session at a later time; `toriel_schedule_list` shows what is scheduled and `toriel_schedule_cancel` removes it. The user sees schedules in the session list and with `/schedules`.

- Use it when something needs time: a build, a deploy, a migration, a queue, a human reply. If you can do the work now, do it now.
- `when` is one string: `in 30m`, `at 14:30`, `tomorrow 9am`, `every 2h`, `every weekday 9am`, or a 5-field cron such as `*/15 * * * *`. Times are local. Read the returned next-run time back and check it is what you meant; an error says what to type instead.
- Write the prompt so it makes sense on its own when it arrives later: what to check, how, and what to do with the result. You will not remember this conversation's reasoning; the transcript is all you have.
- Prefer a long delay over a short one. Do not poll in a tight loop: each run costs a model call. Repeats (`every`, cron) can be no shorter than 1 minute; pick an interval that matches how fast the thing really changes. A one-shot delay has no minimum, so `in 10s` is fine.
- A one-shot (`in ...`, `at ...`) removes itself after it runs: never cancel it afterwards. Only cancel a recurring schedule you made for your own follow-up, and only when what it was watching for has happened. Never cancel a schedule the user asked for (or one you cannot tell the purpose of) just because it ran: the user wanted it to keep running until they say otherwise. Recurring schedules end after 7 days anyway, and `max` caps the number of runs.
- A scheduled prompt arrives as a user message starting `[scheduled #N ...]` and only when you are idle. Treat it as an instruction you set up earlier, not as something the user just typed.
- Tell the user what you scheduled (what, when, and how it ends). Do not schedule on your own initiative for things the user did not ask you to follow up on.
