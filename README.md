# SkiSchool.ge — Client Booking Bot (USDT via @CryptoBot)

A Telegram bot for clients that mirrors the web booking form (sport →
duration → participants → days → calendar/time → personal info), then pays
via USDT through **@CryptoBot** — no separate hosted checkout page, the
whole flow stays inside Telegram.

## How it fits together

```
Client ↔ this bot ↔ @CryptoBot (invoice + webhook)
                ↓
     POST /webhook/booking-crypto (on the EXISTING admin bot service)
                ↓
     same order-creation + admin-notification + client-email pipeline
     that already exists and is already tested for PayPal bookings
```

This bot never touches the shared MySQL database directly — it only
collects the booking details and handles payment, then hands a completed,
verified booking over to the admin bot via webhook.

## The interface, interaction-wise

Rather than a long scrolling chat, each step's message is deleted as soon
as the client moves to the next one — the chat behaves like a single
evolving screen. The one message that's never deleted is the booking
summary: it starts with confirm/cancel buttons, and once the client taps
confirm, it's edited in place to show the payment button, and finally
edited again to show the payment-confirmed message. Nothing new gets sent
for that last part — the same message just keeps changing.

## Files

| File | What it does |
|---|---|
| `index.js` | Telegraf conversation flow + Express server for CryptoBot's webhook |
| `pricing.js` | Same pricing formulas as the web form (kept in sync manually — see comment at top) |
| `availability.js` | Checks lesson-slot availability against the same Google Apps Script API the form uses |
| `calendar.js` | Pure date/calendar-grid logic (season dates, week layout) — no Telegram dependency, easy to test |
| `cryptobot.js` | Creates USDT invoices via @CryptoBot's Crypto Pay API, verifies its webhook signature |
| `i18n.js` | Every RU/EN string the client sees |

## Before you deploy — setup checklist

1. **New Telegram bot.** @BotFather → `/newbot` → get a fresh token. Don't reuse the instructor bot's token.
2. **Admin bot must already have `/webhook/booking-crypto`** (added in this same round of work, along with the `payment_method` column) — deploy that there first if you haven't.
3. **CryptoBot app** — open @CryptoBot → Crypto Pay → My Apps → Create App → copy the token into **both** this service's `CRYPTOBOT_API_TOKEN` and the admin bot's `CRYPTOBOT_API_TOKEN` (same value, both services verify independently). Then in that app's settings → Webhooks → Enable → point at `<this-service-public-url>/webhook/cryptobot`.
4. **Deploy this repo to Railway** as its own service (separate from the admin bot). Set all variables from `.env.example`. Generate a public domain (Settings → Networking) — that's the URL you point CryptoBot's webhook at.
5. **Update the season dates** in `calendar.js` (`BOOKING_PERIOD`) — same reminder as the web form's `app.js`. These are currently placeholder dates from last season.

## Testing before going live (strongly recommended)

Use **@CryptoTestnetBot** instead of @CryptoBot to create a test app/token
— it works the same way but with test funds, no real money moves. Set
`CRYPTOBOT_API_TOKEN` to the testnet token and
`CRYPTOBOT_API_BASE=https://testnet-pay.crypt.bot/api` on **both** this
service and the admin bot temporarily, run a full booking through this bot,
and confirm:
- the invoice gets created and the pay button shows a payable amount,
- the webhook arrives and is accepted (check this bot's logs),
- the admin bot receives and creates the booking (check Telegram + `/webhook/booking-crypto` logs),
- the client sees the summary message update in place through each stage,
  ending with the confirmation text — and the email from the admin bot arrives too.

Afterward, swap both services back to the live `CRYPTOBOT_API_TOKEN` (and
remove the `CRYPTOBOT_API_BASE` override), and delete the test booking from
the admin bot.

## Known v1 limitations (intentional, not bugs)

- **In-memory session state.** A restart mid-conversation loses that client's progress (they just `/start` again — no payment or money is at risk, since nothing is charged until the invoice step).
- **Linear flow, no editing earlier days.** If a client wants to change day 1's date after already picking day 2, they need to `/cancel` and start over.
- **Message deletion depends on Telegram's own limits** — deleting a message that's already very old or otherwise not editable silently no-ops (wrapped in try/catch); in that rare case the trail just won't fully clear, nothing else breaks.
