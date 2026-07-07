/**
 * index.js — client-facing Telegram bot. Mirrors the web booking form's
 * steps (sport → duration → participants → days → calendar/time → personal
 * info → payment), but pays via USDT (NOWPayments) instead of PayPal.
 *
 * Architecture: this bot does NOT touch the shared MySQL database directly.
 * Once a payment is confirmed, it POSTs the completed booking to the admin
 * bot's /webhook/booking-crypto endpoint — the same order-creation,
 * admin-notification, and client-email pipeline already built and tested
 * there. This bot's only jobs are: collect the booking details, and handle
 * the crypto payment.
 *
 * KNOWN LIMITATIONS (v1 — flagged intentionally, not oversights):
 * - In-memory session state (a Map). If this process restarts mid-booking,
 *   that booking's progress is lost and the client has to /start over. No
 *   payment is lost though — NOWPayments and the admin bot's DB are the
 *   sources of truth for anything post-payment.
 * - No "go back and edit day 2" — if a client wants to change an earlier
 *   day's date/time, they need to /cancel and start over. The web form
 *   supports jumping between days; this v1 keeps the conversation linear
 *   for simplicity. Worth adding later if clients ask for it.
 * - Booking season dates live in calendar.js (BOOKING_PERIOD) — update
 *   those before each season, same as the web form's app.js.
 */

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const { calculatePrice, getTimeSlots } = require('./pricing');
const { getAvailableTimeSlots, clearAvailabilityCache } = require('./availability');
const { buildCalendarModel, isWithinBookingPeriod, BOOKING_PERIOD } = require('./calendar');
const { createInvoice, verifyIpnSignature } = require('./nowpayments');
const { I18N } = require('./i18n');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`❌ Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const BOT_TOKEN = requireEnv('BOT_TOKEN');
const ADMIN_BOT_WEBHOOK_URL = requireEnv('ADMIN_BOT_WEBHOOK_URL'); // e.g. https://skischoolgebot-production.up.railway.app/webhook/booking-crypto
const BOOKING_WEBHOOK_SECRET = process.env.BOOKING_WEBHOOK_SECRET || '';
const PUBLIC_URL = requireEnv('PUBLIC_URL'); // this bot's own public URL, for the NOWPayments IPN callback

const bot = new Telegraf(BOT_TOKEN);
bot.catch((err, ctx) => console.error('❌ Bot error:', err));

const app = express();
// NOWPayments IPN needs the raw body to verify the signature, so capture it
// before express.json() parses it.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); }
}));

// ============ SESSION STATE ============
const sessions = new Map();
// pendingBookings: bookingId -> { chatId, order }. Populated when an invoice
// is created, consumed when the IPN confirms payment (or expires — see cron
// cleanup at the bottom).
const pendingBookings = new Map();

function getSession(ctx) {
  const id = ctx.from.id;
  if (!sessions.has(id)) {
    sessions.set(id, { step: 'lang' });
  }
  return sessions.get(id);
}

function resetSession(ctx) {
  sessions.delete(ctx.from.id);
}

function t(session, key, ...args) {
  const lang = session.lang || 'ru';
  const entry = I18N[lang][key];
  return typeof entry === 'function' ? entry(...args) : entry;
}

// ============ /start, /cancel ============
bot.start((ctx) => {
  resetSession(ctx);
  const session = getSession(ctx);
  ctx.reply(t(session, 'start'));
  ctx.reply(
    t(session, 'choose_lang'),
    Markup.inlineKeyboard([
      [Markup.button.callback('🇷🇺 Русский', 'lang_ru'), Markup.button.callback('🇬🇧 English', 'lang_en')]
    ])
  );
});

bot.command('cancel', (ctx) => {
  const had = sessions.has(ctx.from.id);
  resetSession(ctx);
  const lang = I18N.ru.cancelled ? 'ru' : 'ru';
  ctx.reply(had ? I18N.ru.cancelled + ' / ' + I18N.en.cancelled : I18N.ru.nothing_to_cancel + ' / ' + I18N.en.nothing_to_cancel);
});

// ============ STEP: language ============
bot.action(/lang_(ru|en)/, (ctx) => {
  const session = getSession(ctx);
  session.lang = ctx.match[1];
  session.step = 'sport';
  ctx.answerCbQuery();
  askSport(ctx, session);
});

function askSport(ctx, session) {
  ctx.reply(
    t(session, 'choose_sport'),
    Markup.inlineKeyboard([
      [Markup.button.callback(t(session, 'tab_ski'), 'sport_ski')],
      [Markup.button.callback(t(session, 'tab_snowboard'), 'sport_snowboard')],
      [Markup.button.callback(t(session, 'tab_kids'), 'sport_kids')]
    ])
  );
}

// ============ STEP: sport ============
bot.action(/sport_(ski|snowboard|kids)/, (ctx) => {
  const session = getSession(ctx);
  session.sport = ctx.match[1];
  session.step = 'duration';
  ctx.answerCbQuery();
  askDuration(ctx, session);
});

function askDuration(ctx, session) {
  const buttons = session.sport === 'kids'
    ? [
        [Markup.button.callback(t(session, 'kids_full'), 'dur_full')],
        [Markup.button.callback(t(session, 'kids_half_lunch'), 'dur_half-lunch')],
        [Markup.button.callback(t(session, 'kids_half_nolunch'), 'dur_half-nolunch')]
      ]
    : [
        [Markup.button.callback(t(session, 'duration_2'), 'dur_2')],
        [Markup.button.callback(t(session, 'duration_3'), 'dur_3')],
        [Markup.button.callback(t(session, 'duration_full'), 'dur_full')]
      ];
  ctx.reply(t(session, 'choose_duration'), Markup.inlineKeyboard(buttons));
}

// ============ STEP: duration ============
bot.action(/dur_(2|3|full|half-lunch|half-nolunch)/, (ctx) => {
  const session = getSession(ctx);
  session.duration = ctx.match[1];
  session.step = 'participants';
  ctx.answerCbQuery();
  askParticipants(ctx, session);
});

function askParticipants(ctx, session) {
  const max = session.sport === 'kids' ? 6 : 5;
  const row1 = [];
  for (let i = 1; i <= max; i++) row1.push(Markup.button.callback(String(i), `people_${i}`));
  // Split into rows of up to 5 buttons for readability
  const rows = [];
  for (let i = 0; i < row1.length; i += 5) rows.push(row1.slice(i, i + 5));
  ctx.reply(
    session.sport === 'kids' ? t(session, 'choose_kids') : t(session, 'choose_participants'),
    Markup.inlineKeyboard(rows)
  );
}

// ============ STEP: participants ============
bot.action(/people_(\d+)/, (ctx) => {
  const session = getSession(ctx);
  session.participants = parseInt(ctx.match[1], 10);
  session.step = 'days';
  ctx.answerCbQuery();
  askDays(ctx, session);
});

function askDays(ctx, session) {
  const buttons = [];
  for (let i = 1; i <= 8; i++) buttons.push(Markup.button.callback(String(i), `days_${i}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  ctx.reply(t(session, 'choose_days'), Markup.inlineKeyboard(rows));
}

// ============ STEP: days -> initialize schedule ============
bot.action(/days_(\d+)/, (ctx) => {
  const session = getSession(ctx);
  session.days = parseInt(ctx.match[1], 10);
  session.lessons = [];
  for (let i = 0; i < session.days; i++) session.lessons.push({ number: i + 1, date: null, time: null });
  session.currentLessonIndex = 0;
  clearAvailabilityCache();
  const now = new Date();
  session.calYear = now.getUTCFullYear();
  session.calMonth = now.getUTCMonth();
  session.step = 'schedule_date';
  ctx.answerCbQuery();
  showCalendar(ctx, session);
});

// ============ CALENDAR RENDERING ============
function showCalendar(ctx, session) {
  const lesson = session.lessons[session.currentLessonIndex];
  const bookedDates = session.lessons.filter(l => l.date).map(l => l.date);
  const model = buildCalendarModel(session.calYear, session.calMonth, session.lang, bookedDates);

  const rows = [];
  rows.push([Markup.button.callback(model.header, 'noop')]);
  rows.push(model.weekdayLabels.map(w => Markup.button.callback(w, 'noop')));

  for (const row of model.rows) {
    rows.push(row.map(cell => {
      if (!cell) return Markup.button.callback(' ', 'noop');
      if (cell.disabled) return Markup.button.callback('·', 'noop');
      return Markup.button.callback(cell.label, `cal_${cell.dateStr}`);
    }));
  }

  rows.push([
    Markup.button.callback(t(session, 'prev_month'), 'cal_prev'),
    Markup.button.callback(t(session, 'next_month'), 'cal_next')
  ]);

  const label = t(session, 'day_label', lesson.number, session.days);
  const keyboard = Markup.inlineKeyboard(rows);

  if (session.calendarMessageId) {
    ctx.telegram.editMessageText(ctx.chat.id, session.calendarMessageId, undefined, label, keyboard)
      .catch(() => ctx.reply(label, keyboard).then(msg => { session.calendarMessageId = msg.message_id; }));
  } else {
    ctx.reply(label, keyboard).then(msg => { session.calendarMessageId = msg.message_id; });
  }
}

bot.action('noop', (ctx) => ctx.answerCbQuery());

bot.action('cal_prev', (ctx) => {
  const session = getSession(ctx);
  session.calMonth--;
  if (session.calMonth < 0) { session.calMonth = 11; session.calYear--; }
  ctx.answerCbQuery();
  showCalendar(ctx, session);
});

bot.action('cal_next', (ctx) => {
  const session = getSession(ctx);
  session.calMonth++;
  if (session.calMonth > 11) { session.calMonth = 0; session.calYear++; }
  ctx.answerCbQuery();
  showCalendar(ctx, session);
});

bot.action(/cal_(\d{4}-\d{2}-\d{2})/, async (ctx) => {
  const session = getSession(ctx);
  const dateStr = ctx.match[1];

  if (!isWithinBookingPeriod(dateStr)) {
    return ctx.answerCbQuery();
  }

  session.lessons[session.currentLessonIndex].date = dateStr;
  session.step = 'schedule_time';
  ctx.answerCbQuery();
  await showTimeSlots(ctx, session);
});

// ============ TIME SLOT SELECTION ============
async function showTimeSlots(ctx, session) {
  const lesson = session.lessons[session.currentLessonIndex];
  const allSlots = getTimeSlots(session.sport, session.duration);
  const available = await getAvailableTimeSlots(lesson.date, session.sport, session.duration);

  // Prevent overlapping bookings across the days already chosen in this
  // session, same rule as the web form: same date + overlapping duration
  // window means that slot isn't offered.
  const durationHours = { '2': 2, '3': 3, 'full': 7 }[session.duration] || 1;
  const conflictsWith = session.lessons.filter((l, i) => i !== session.currentLessonIndex && l.date === lesson.date && l.time);

  const openSlots = allSlots.filter(time => {
    if (!available.includes(time)) return false;
    const startH = parseInt(time.split(':')[0], 10);
    const endH = startH + durationHours;
    return !conflictsWith.some(other => {
      const otherStart = parseInt(other.time.split(':')[0], 10);
      const otherEnd = otherStart + durationHours;
      return startH < otherEnd && endH > otherStart;
    });
  });

  if (openSlots.length === 0) {
    await ctx.reply(t(session, 'no_slots_this_date'));
    session.step = 'schedule_date';
    return showCalendar(ctx, session);
  }

  const buttons = openSlots.map(time => Markup.button.callback(time, `time_${time}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));

  const label = t(session, 'choose_time', lesson.number, session.days);
  await ctx.reply(label, Markup.inlineKeyboard(rows));
}

bot.action(/time_(\d{2}:\d{2})/, (ctx) => {
  const session = getSession(ctx);
  session.lessons[session.currentLessonIndex].time = ctx.match[1];
  ctx.answerCbQuery();

  const nextIndex = session.currentLessonIndex + 1;
  if (nextIndex < session.days) {
    session.currentLessonIndex = nextIndex;
    session.calendarMessageId = null;
    session.step = 'schedule_date';
    showCalendar(ctx, session);
  } else {
    session.step = 'ask_name';
    ctx.reply(t(session, 'ask_name'));
  }
});

// ============ TEXT-BASED STEPS (personal info) ============
bot.on('text', async (ctx) => {
  const session = getSession(ctx);
  const text = ctx.message.text.trim();

  switch (session.step) {
    case 'ask_name': {
      if (text.length < 2) return; // ignore empty/garbage, keep prompting implicitly
      session.fullName = text;
      session.step = 'ask_phone';
      return ctx.reply(t(session, 'ask_phone'));
    }
    case 'ask_phone': {
      const cleaned = text.replace(/[\s()-]/g, '');
      if (!/^\+?\d{7,15}$/.test(cleaned)) {
        return ctx.reply(t(session, 'invalid_phone'));
      }
      session.phone = cleaned;
      session.step = 'ask_email';
      return ctx.reply(t(session, 'ask_email'));
    }
    case 'ask_email': {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        return ctx.reply(t(session, 'invalid_email'));
      }
      session.email = text;
      session.step = 'ask_age';
      return ctx.reply(t(session, 'ask_age'));
    }
    case 'ask_age': {
      const age = parseInt(text, 10);
      const isKids = session.sport === 'kids';
      const min = 5, max = isKids ? 13 : 80;
      if (isNaN(age) || age < min || age > max) {
        return ctx.reply(isKids ? t(session, 'invalid_age_kids') : t(session, 'invalid_age_adult'));
      }
      session.age = age;
      session.step = 'ask_skill';
      return askSkill(ctx, session);
    }
    case 'ask_special': {
      session.specialRequests = text;
      session.step = 'confirm';
      return showSummary(ctx, session);
    }
    default:
      // Not currently expecting free text (e.g. mid-calendar) — nudge toward buttons.
      if (['schedule_date', 'schedule_time', 'sport', 'duration', 'participants', 'days', 'ask_skill', 'ask_pref_lang', 'confirm', 'paying'].includes(session.step)) {
        return ctx.reply(t(session, 'unexpected_input'));
      }
  }
});

function askSkill(ctx, session) {
  const isKids = session.sport === 'kids';
  const buttons = isKids
    ? [
        [Markup.button.callback(t(session, 'skill_beginner'), 'skill_beginner')],
        [Markup.button.callback(t(session, 'skill_intermediate'), 'skill_intermediate')]
      ]
    : [
        [Markup.button.callback(t(session, 'skill_first'), 'skill_first-time')],
        [Markup.button.callback(t(session, 'skill_beginner'), 'skill_beginner')],
        [Markup.button.callback(t(session, 'skill_intermediate'), 'skill_intermediate')],
        [Markup.button.callback(t(session, 'skill_advanced'), 'skill_advanced')]
      ];
  ctx.reply(t(session, 'choose_skill'), Markup.inlineKeyboard(buttons));
}

bot.action(/skill_(first-time|beginner|intermediate|advanced)/, (ctx) => {
  const session = getSession(ctx);
  session.skillLevel = ctx.match[1];
  session.step = 'ask_pref_lang';
  ctx.answerCbQuery();
  askPrefLang(ctx, session);
});

function askPrefLang(ctx, session) {
  const isKids = session.sport === 'kids';
  const buttons = isKids
    ? [
        [Markup.button.callback(t(session, 'pref_lang_english'), 'pl_english')],
        [Markup.button.callback(t(session, 'pref_lang_russian'), 'pl_russian')]
      ]
    : [
        [Markup.button.callback(t(session, 'pref_lang_english'), 'pl_english')],
        [Markup.button.callback(t(session, 'pref_lang_russian'), 'pl_russian')],
        [Markup.button.callback(t(session, 'pref_lang_georgian'), 'pl_georgian')],
        [Markup.button.callback(t(session, 'pref_lang_other'), 'pl_other')]
      ];
  ctx.reply(t(session, 'choose_pref_lang'), Markup.inlineKeyboard(buttons));
}

bot.action(/pl_(english|russian|georgian|other)/, (ctx) => {
  const session = getSession(ctx);
  session.preferredLanguage = ctx.match[1];
  session.step = 'ask_special';
  ctx.answerCbQuery();
  ctx.reply(t(session, 'ask_special'), Markup.inlineKeyboard([[Markup.button.callback(t(session, 'skip'), 'skip_special')]]));
});

bot.action('skip_special', (ctx) => {
  const session = getSession(ctx);
  session.specialRequests = '';
  session.step = 'confirm';
  ctx.answerCbQuery();
  showSummary(ctx, session);
});

// ============ SUMMARY + PRICE ============
function sportLabel(session) {
  if (session.sport === 'kids') return t(session, 'tab_kids');
  return session.sport === 'ski' ? t(session, 'tab_ski') : t(session, 'tab_snowboard');
}

function durationLabel(session) {
  const map = session.sport === 'kids'
    ? { full: 'kids_full', 'half-lunch': 'kids_half_lunch', 'half-nolunch': 'kids_half_nolunch' }
    : { '2': 'duration_2', '3': 'duration_3', full: 'duration_full' };
  return t(session, map[session.duration]);
}

function showSummary(ctx, session) {
  const prices = calculatePrice(session);
  session.prices = prices;

  const datesText = session.lessons
    .map((l, i) => `${i + 1}. ${l.date} ${l.time}`)
    .join('\n');

  const lines = [
    t(session, 'summary_title'),
    '',
    `${t(session, 'summary_sport')}: ${sportLabel(session)}, ${durationLabel(session)}`,
    `${t(session, 'summary_participants')}: ${session.participants}`,
    `${t(session, 'summary_dates')}:\n${datesText}`,
    '',
    `${t(session, 'summary_name')}: ${session.fullName}`,
    `${t(session, 'summary_phone')}: ${session.phone}`,
    `${t(session, 'summary_email')}: ${session.email}`,
    `${t(session, 'summary_age')}: ${session.age}`,
    `${t(session, 'summary_skill')}: ${session.skillLevel}`,
    `${t(session, 'summary_pref_lang')}: ${session.preferredLanguage}`,
    session.specialRequests ? `${t(session, 'summary_special')}: ${session.specialRequests}` : '',
    '',
    `${t(session, 'total')}: $${prices.totalPrice}`,
    `${t(session, 'deposit')}: $${prices.depositPrice}`,
    `${t(session, 'remaining')}: $${prices.remainingPrice}`
  ].filter(Boolean);

  ctx.reply(
    lines.join('\n'),
    Markup.inlineKeyboard([
      [Markup.button.callback(t(session, 'btn_confirm'), 'confirm_booking')],
      [Markup.button.callback(t(session, 'btn_cancel'), 'cancel_booking')]
    ])
  );
}

bot.action('cancel_booking', (ctx) => {
  resetSession(ctx);
  ctx.answerCbQuery();
  ctx.reply(I18N.ru.cancelled + ' / ' + I18N.en.cancelled);
});

// ============ PAYMENT ============
function generateBookingId() {
  return 'BKC' + Date.now() + Math.random().toString(36).substr(2, 5).toUpperCase();
}

bot.action('confirm_booking', async (ctx) => {
  const session = getSession(ctx);
  ctx.answerCbQuery();

  const bookingId = generateBookingId();
  session.bookingId = bookingId;
  session.step = 'paying';

  const order = {
    bookingId,
    fullName: session.fullName,
    phone: session.phone,
    email: session.email,
    age: session.age,
    skillLevel: session.skillLevel,
    preferredLanguage: session.preferredLanguage,
    additionalInfo: session.specialRequests || '',
    sport: session.sport,
    duration: session.duration,
    participants: session.participants,
    days: session.days,
    selectedDates: session.lessons.map(l => ({ date: l.date, time: l.time })),
    total: session.prices.totalPrice,
    deposit: session.prices.depositPrice,
    remaining: session.prices.remainingPrice,
    paymentStatus: 'COMPLETED', // set only once actually confirmed — see IPN handler
    payerEmail: session.email
  };

  await ctx.reply(t(session, 'creating_invoice'));

  try {
    const invoice = await createInvoice({
      bookingId,
      depositAmount: session.prices.depositPrice,
      description: `SkiSchool.ge booking ${bookingId}`,
      ipnCallbackUrl: `${PUBLIC_URL}/ipn/nowpayments`,
      successUrl: `https://t.me/${ctx.botInfo.username}`,
      cancelUrl: `https://t.me/${ctx.botInfo.username}`
    });

    pendingBookings.set(bookingId, { chatId: ctx.chat.id, order, createdAt: Date.now() });

    await ctx.reply(
      t(session, 'invoice_ready', session.prices.depositPrice),
      Markup.inlineKeyboard([
        [Markup.button.url(t(session, 'btn_pay'), invoice.invoice_url)],
        [Markup.button.callback(t(session, 'btn_check_status'), `check_${bookingId}`)]
      ])
    );
  } catch (error) {
    console.error('❌ Invoice creation failed:', error);
    await ctx.reply(t(session, 'invoice_error'));
    session.step = 'confirm';
  }
});

bot.action(/check_(.+)/, async (ctx) => {
  const session = getSession(ctx);
  const bookingId = ctx.match[1];
  ctx.answerCbQuery();

  if (!pendingBookings.has(bookingId)) {
    // Either already finalized (client got the confirmation message already)
    // or expired — either way, nothing pending to report here.
    return;
  }
  await ctx.reply(t(session, 'payment_pending'));
});

// ============ NOWPAYMENTS IPN ============
app.post('/ipn/nowpayments', async (req, res) => {
  const signature = req.get('x-nowpayments-sig');
  const { verified, skipped } = verifyIpnSignature(req.rawBody, signature);

  if (!skipped && !verified) {
    console.warn('⚠️ Rejected IPN with invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  if (skipped) {
    console.warn('⚠️ Processing IPN WITHOUT signature verification (NOWPAYMENTS_IPN_SECRET not set) — INSECURE.');
  }

  const payload = req.body;
  const bookingId = payload.order_id;
  const pending = pendingBookings.get(bookingId);

  console.log(`📩 IPN for ${bookingId}: status=${payload.payment_status}`);

  if (!pending) {
    console.warn(`⚠️ IPN for unknown/already-finalized booking ${bookingId}`);
    return res.json({ ok: true });
  }

  const isFinal = payload.payment_status === 'finished' || payload.payment_status === 'confirmed';
  if (!isFinal) {
    // Still waiting/confirming — nothing to do yet, NOWPayments will call again.
    return res.json({ ok: true });
  }

  pending.order.paymentId = String(payload.payment_id);

  try {
    const resp = await fetch(ADMIN_BOT_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Booking-Secret': BOOKING_WEBHOOK_SECRET
      },
      body: JSON.stringify(pending.order)
    });

    const session = sessions.get(
      // We only have chatId, not the Telegram user id the session Map is
      // keyed by — but chat.id === from.id for private chats, which is all
      // this bot supports, so this lookup is safe here.
      pending.chatId
    );

    if (resp.ok) {
      const text = (session ? t(session, 'payment_confirmed') : I18N.ru.payment_confirmed) +
        bookingId +
        (session ? t(session, 'payment_confirmed_followup') : I18N.ru.payment_confirmed_followup);
      await bot.telegram.sendMessage(pending.chatId, text);
      pendingBookings.delete(bookingId);
      sessions.delete(pending.chatId);
    } else {
      console.error(`❌ Admin bot rejected crypto booking ${bookingId}:`, resp.status, await resp.text());
      await bot.telegram.sendMessage(pending.chatId, session ? t(session, 'booking_finalize_error') : I18N.ru.booking_finalize_error);
    }
  } catch (error) {
    console.error('❌ Error forwarding confirmed crypto booking to admin bot:', error);
  }

  res.json({ ok: true });
});

// Clean up pending bookings that never got paid, so the Map doesn't grow
// forever (NOWPayments invoices expire on their side after ~20-60 minutes
// depending on plan; give it a couple hours of buffer here).
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [bookingId, pending] of pendingBookings.entries()) {
    if (pending.createdAt < cutoff) pendingBookings.delete(bookingId);
  }
}, 15 * 60 * 1000);

app.get('/', (req, res) => res.send('SkiSchool.ge client bot is running'));
app.get('/health', (req, res) => res.json({ status: 'OK' }));

bot.launch().then(() => console.log('✅ Client bot started!'));

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Client bot server running on port ${PORT}`));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
