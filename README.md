# SkiSchool.ge — Client Booking Bot (crypto/USDT)

A Telegram bot for clients that mirrors the web booking form (sport →
duration → participants → days → calendar/time → personal info), but pays
via USDT (TRC20 network) through NOWPayments instead of PayPal.

## How it fits together

```
Client ↔ this bot ↔ NOWPayments (invoice + IPN)
                ↓
     POST /webhook/booking-crypto (on the EXISTING admin bot service)
                ↓
     same order-creation + admin-notification + client-email pipeline
     that already exists and is already tested for PayPal bookings
```

This bot never touches the shared MySQL database directly — it only
collects the booking details and handles payment, then hands a completed,
verified booking over to the admin bot via webhook. That pipeline (saving
the order, notifying the admin on Telegram, emailing the client) is shared
code with the PayPal flow, so a fix there benefits both.

## Files

| File | What it does |
|---|---|
| `index.js` | Telegraf conversation flow + Express server for the NOWPayments IPN webhook |
| `pricing.js` | Same pricing formulas as the web form (kept in sync manually — see comment at top) |
| `availability.js` | Checks lesson-slot availability against the same Google Apps Script API the form uses |
| `calendar.js` | Pure date/calendar-grid logic (season dates, week layout) — no Telegram dependency, easy to test |
| `nowpayments.js` | Creates USDT invoices, verifies NOWPayments' IPN signature |
| `i18n.js` | Every RU/EN string the client sees |

## Before you deploy — setup checklist

1. **New Telegram bot.** @BotFather → `/newbot` → get a fresh token. Don't reuse the instructor bot's token.
2. **Add the crypto webhook to the existing admin bot.** This was already added to that service's `index.js` in this same round of work (`/webhook/booking-crypto` + `payment_method` column) — just make sure that's deployed there first.
3. **NOWPayments account** — nowpayments.io → sign up → set your payout wallet/bank in Settings (this is where confirmed USDT actually ends up) → create an API key → set an IPN secret key. Put both in this service's env vars.
4. **Deploy this repo to Railway** as its own service (separate from the admin bot). Set all variables from `.env.example`. Generate a public domain (Settings → Networking) — that URL is your `PUBLIC_URL`.
5. **Update the season dates** in `calendar.js` (`BOOKING_PERIOD`) — same reminder as the web form's `app.js`. These are currently placeholder dates from last season.

## Testing before going live (strongly recommended)

NOWPayments has a sandbox environment (test API keys, test coins — no real
money moves) similar to PayPal's sandbox we used earlier for the web form.
Check **nowpayments.io → API sandbox docs** for current setup steps (they
change these occasionally, so check the live docs rather than trusting a
fixed URL here) — general shape is: get sandbox API/IPN keys, point
`NOWPAYMENTS_API_KEY`/`NOWPAYMENTS_IPN_SECRET` at them temporarily, run a
full booking through this bot, confirm:
- the invoice gets created and shows a payable amount,
- the IPN arrives and is accepted (check this bot's logs),
- the admin bot receives and creates the booking (check Telegram + `/webhook/booking-crypto` logs),
- the client gets the confirmation message here **and** the email from the admin bot.

Same rule as the PayPal sandbox test: change sandbox keys back to live ones
on **both** services afterward, and delete the test booking from the admin
bot once done.

## Known v1 limitations (intentional, not bugs)

- **In-memory session state.** A restart mid-conversation loses that client's progress (they just `/start` again — no payment or money is at risk, since nothing is charged until the invoice step). If this becomes a real pain point, sessions could be persisted to the database instead of a `Map`.
- **Linear flow, no editing earlier days.** If a client wants to change day 1's date after already picking day 2, they need to `/cancel` and start over. The web form allows jumping between days; this v1 keeps things simpler. Worth revisiting if it comes up in practice.
- **One instructor-language / one skill-level list, matching the web form's rules** (Kids Club: fewer skill/language options, ages 5–13; everyone else: ages 5–80).
