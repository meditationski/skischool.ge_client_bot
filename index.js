/**
 * index.js — client-facing Telegram bot. Mirrors the web booking form's
 * steps (sport → duration → participants → days → calendar/time → personal
 * info → payment), paying via USDT through @CryptoBot.
 *
 * Architecture: this bot does NOT touch the shared MySQL database directly.
 * Once a payment is confirmed, it POSTs the completed booking to the admin
 * bot's /webhook/booking-crypto endpoint — the same order-creation,
 * admin-notification, and client-email pipeline already built and tested
 * there for PayPal bookings.
 *
 * UX: this version auto-deletes each step's message as the conversation
 * moves forward (a running "trail" of message IDs, cleaned right before the
 * next step renders), so the chat stays a single evolving screen instead of
 * a long scrollback. The one exception is the booking summary — that
 * message is never deleted; instead it's edited in place, first with the
 * confirm/cancel buttons, then (once the client taps confirm) with the
 * payment button, and finally with the payment-confirmed message. This
 * mirrors "swap the button" rather than "send another message".
 *
 * KNOWN LIMITATIONS (v1 — flagged intentionally, not oversights):
 * - In-memory session state (a Map). If this process restarts mid-booking,
 *   that booking's progress is lost and the client has to /start over. No
 *   payment is lost though — CryptoBot and the admin bot's DB are the
 *   sources of truth for anything post-payment.
 * - No "go back and edit day 2" — if a client wants to change an earlier
 *   day's date/time, they need to /cancel and start over.
 * - Booking season dates live in calendar.js (BOOKING_PERIOD) — update
 *   those before each season, same as the web form's app.js.
 * - Telegram only lets a bot delete its own messages if they're recent
 *   enough / still editable — deleteMessage calls are wrapped in try/catch
 *   and silently ignored on failure (the trail just won't fully clear in
 *   that rare case, nothing breaks).
 */

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const { calculatePrice, getTimeSlots } = require('./pricing');
const { getAvailableTimeSlots, clearAvailabilityCache } = require('./availability');
const { buildCalendarModel, isWithinBookingPeriod } = require('./calendar');
const cryptobot = require('./cryptobot');
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
const ADMIN_BOT_WEBHOOK_URL = requireEnv('ADMIN_BOT_WEBHOOK_URL');
const BOOKING_WEBHOOK_SECRET = process.env.BOOKING_WEBHOOK_SECRET || '';

const bot = new Telegraf(BOT_TOKEN);
bot.catch((err, ctx) => console.error('❌ Bot error:', err));

const app = express();
app.use(express.json());

// ============ SESSION STATE ============
const sessions = new Map();
// pendingBookings: bookingId -> { chatId, summaryMessageId, order, createdAt }
const pendingBookings = new Map();

function getSession(ctx) {
  const id = ctx.from.id;
  if (!sessions.has(id)) {
    sessions.set(id, { step: 'lang', trail: [] });
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

// ============ MESSAGE TRAIL (auto-cleanup) ============
async function cleanTrail(ctx, session) {
  if (!session.trail || session.trail.length === 0) return;
  const ids = session.trail;
  session.trail = [];
  for (const id of ids) {
    try {
      await ctx.telegram.deleteMessage(ctx.chat.id, id);
    } catch (e) {
      // Message already gone, too old to delete, or similar — not worth surfacing.
    }
  }
}

function track(session, messageId) {
  if (!session.trail) session.trail = [];
  session.trail.push(messageId);
}

async function step(ctx, session, text, extra) {
  await cleanTrail(ctx, session);
  const msg = await ctx.reply(text, extra);
  track(session, msg.message_id);
  return msg;
}

// ============ /start, /cancel ============
bot.start(async (ctx) => {
  resetSession(ctx);
  const session = getSession(ctx);
  await step(ctx, session, t(session, 'start'));
  await step(
    ctx,
    session,
    t(session, 'choose_lang'),
    Markup.inlineKeyboard([
      [Markup.button.callback('🇷🇺 Русский', 'lang_ru'), Markup.button.callback('🇬🇧 English', 'lang_en')]
    ])
  );
});

bot.command('cancel', async (ctx) => {
  const session = sessions.get(ctx.from.id);
  const had = !!session;
  if (session) await cleanTrail(ctx, session);
  resetSession(ctx);
  await ctx.reply(had ? `${I18N.ru.cancelled} / ${I18N.en.cancelled}` : `${I18N.ru.nothing_to_cancel} / ${I18N.en.nothing_to_cancel}`);
});

// ============ STEP: language ============
bot.action(/lang_(ru|en)/, async (ctx) => {
  const session = getSession(ctx);
  session.lang = ctx.match[1];
  session.step = 'sport';
  await ctx.answerCbQuery();
  await askSport(ctx, session);
});

async function askSport(ctx, session) {
  await step(
    ctx,
    session,
    t(session, 'choose_sport'),
    Markup.inlineKeyboard([
      [Markup.button.callback(t(session, 'tab_ski'), 'sport_ski')],
      [Markup.button.callback(t(session, 'tab_snowboard'), 'sport_snowboard')],
      [Markup.button.callback(t(session, 'tab_kids'), 'sport_kids')]
    ])
  );
}

// ============ STEP: sport ============
bot.action(/sport_(ski|snowboard|kids)/, async (ctx) => {
  const session = getSession(ctx);
  session.sport = ctx.match[1];
  session.step = 'duration';
  await ctx.answerCbQuery();
  await askDuration(ctx, session);
});

async function askDuration(ctx, session) {
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
  await step(ctx, session, t(session, 'choose_duration'), Markup.inlineKeyboard(buttons));
}

// ============ STEP: duration ============
bot.action(/dur_(2|3|full|half-lunch|half-nolunch)/, async (ctx) => {
  const session = getSession(ctx);
  session.duration = ctx.match[1];
  session.step = 'participants';
  await ctx.answerCbQuery();
  await askParticipants(ctx, session);
});

async function askParticipants(ctx, session) {
  const max = session.sport === 'kids' ? 6 : 5;
  const buttons = [];
  for (let i = 1; i <= max; i++) buttons.push(Markup.button.callback(String(i), `people_${i}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(buttons.slice(i, i + 5));
  await step(
    ctx,
    session,
    session.sport === 'kids' ? t(session, 'choose_kids') : t(session, 'choose_participants'),
    Markup.inlineKeyboard(rows)
  );
}

// ============ STEP: participants ============
bot.action(/people_(\d+)/, async (ctx) => {
  const session = getSession(ctx);
  session.participants = parseInt(ctx.match[1], 10);
  session.step = 'days';
  await ctx.answerCbQuery();
  await askDays(ctx, session);
});

async function askDays(ctx, session) {
  const buttons = [];
  for (let i = 1; i <= 8; i++) buttons.push(Markup.button.callback(String(i), `days_${i}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 4) rows.push(buttons.slice(i, i + 4));
  await step(ctx, session, t(session, 'choose_days'), Markup.inlineKeyboard(rows));
}

// ============ STEP: days -> initialize schedule ============
bot.action(/days_(\d+)/, async (ctx) => {
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
  session.calendarMessageId = null;
  await ctx.answerCbQuery();
  await showCalendar(ctx, session);
});

// ============ CALENDAR RENDERING ============
async function showCalendar(ctx, session) {
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
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, session.calendarMessageId, undefined, label, keyboard);
      return;
    } catch (e) {
      // Fall through and send a fresh one if editing failed for any reason.
    }
  }

  await cleanTrail(ctx, session);
  const msg = await ctx.reply(label, keyboard);
  session.calendarMessageId = msg.message_id;
  track(session, msg.message_id);
}

bot.action('noop', (ctx) => ctx.answerCbQuery());

bot.action('cal_prev', async (ctx) => {
  const session = getSession(ctx);
  session.calMonth--;
  if (session.calMonth < 0) { session.calMonth = 11; session.calYear--; }
  await ctx.answerCbQuery();
  await showCalendar(ctx, session);
});

bot.action('cal_next', async (ctx) => {
  const session = getSession(ctx);
  session.calMonth++;
  if (session.calMonth > 11) { session.calMonth = 0; session.calYear++; }
  await ctx.answerCbQuery();
  await showCalendar(ctx, session);
});

bot.action(/cal_(\d{4}-\d{2}-\d{2})/, async (ctx) => {
  const session = getSession(ctx);
  const dateStr = ctx.match[1];

  if (!isWithinBookingPeriod(dateStr)) {
    return ctx.answerCbQuery();
  }

  session.lessons[session.currentLessonIndex].date = dateStr;
  session.step = 'schedule_time';
  await ctx.answerCbQuery();
  await showTimeSlots(ctx, session);
});

// ============ TIME SLOT SELECTION ============
async function showTimeSlots(ctx, session) {
  const lesson = session.lessons[session.currentLessonIndex];
  const allSlots = getTimeSlots(session.sport, session.duration);
  const available = await getAvailableTimeSlots(lesson.date, session.sport, session.duration);

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
    await step(ctx, session, t(session, 'no_slots_this_date'));
    session.step = 'schedule_date';
    session.calendarMessageId = null;
    return showCalendar(ctx, session);
  }

  const buttons = openSlots.map(time => Markup.button.callback(time, `time_${time}`));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 3) rows.push(buttons.slice(i, i + 3));

  const label = t(session, 'choose_time', lesson.number, session.days);
  const msg = await ctx.reply(label, Markup.inlineKeyboard(rows));
  track(session, msg.message_id);
}

bot.action(/time_(\d{2}:\d{2})/, async (ctx) => {
  const session = getSession(ctx);
  session.lessons[session.currentLessonIndex].time = ctx.match[1];
  await ctx.answerCbQuery();

  const nextIndex = session.currentLessonIndex + 1;
  if (nextIndex < session.days) {
    session.currentLessonIndex = nextIndex;
    session.calendarMessageId = null;
    session.step = 'schedule_date';
    await showCalendar(ctx, session);
  } else {
    session.step = 'ask_name';
    await step(ctx, session, t(session, 'ask_name'));
  }
});

// ============ TEXT-BASED STEPS (personal info) ============
bot.on('text', async (ctx) => {
  const session = getSession(ctx);

  const stepsExpectingText = ['ask_name', 'ask_phone', 'ask_email', 'ask_age', 'ask_special'];
  if (stepsExpectingText.includes(session.step)) {
    track(session, ctx.message.message_id);
  }

  const text = ctx.message.text.trim();

  switch (session.step) {
    case 'ask_name': {
      if (text.length < 2) return;
      session.fullName = text;
      session.step = 'ask_phone';
      return step(ctx, session, t(session, 'ask_phone'));
    }
    case 'ask_phone': {
      const cleaned = text.replace(/[\s()-]/g, '');
      if (!/^\+?\d{7,15}$/.test(cleaned)) {
        return step(ctx, session, t(session, 'invalid_phone'));
      }
      session.phone = cleaned;
      session.step = 'ask_email';
      return step(ctx, session, t(session, 'ask_email'));
    }
    case 'ask_email': {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
        return step(ctx, session, t(session, 'invalid_email'));
      }
      session.email = text;
      session.step = 'ask_age';
      return step(ctx, session, t(session, 'ask_age'));
    }
    case 'ask_age': {
      const age = parseInt(text, 10);
      const isKids = session.sport === 'kids';
      const min = 5, max = isKids ? 13 : 80;
      if (isNaN(age) || age < min || age > max) {
        return step(ctx, session, isKids ? t(session, 'invalid_age_kids') : t(session, 'invalid_age_adult'));
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
      if (['schedule_date', 'schedule_time', 'sport', 'duration', 'participants', 'days', 'ask_skill', 'ask_pref_lang', 'confirm', 'paying'].includes(session.step)) {
        return ctx.reply(t(session, 'unexpected_input'));
      }
  }
});

async function askSkill(ctx, session) {
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
  await step(ctx, session, t(session, 'choose_skill'), Markup.inlineKeyboard(buttons));
}

bot.action(/skill_(first-time|beginner|intermediate|advanced)/, async (ctx) => {
  const session = getSession(ctx);
  session.skillLevel = ctx.match[1];
  session.step = 'ask_pref_lang';
  await ctx.answerCbQuery();
  await askPrefLang(ctx, session);
});

async function askPrefLang(ctx, session) {
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
  await step(ctx, session, t(session, 'choose_pref_lang'), Markup.inlineKeyboard(buttons));
}

bot.action(/pl_(english|russian|georgian|other)/, async (ctx) => {
  const session = getSession(ctx);
  session.preferredLanguage = ctx.match[1];
  session.step = 'ask_special';
  await ctx.answerCbQuery();
  await step(ctx, session, t(session, 'ask_special'), Markup.inlineKeyboard([[Markup.button.callback(t(session, 'skip'), 'skip_special')]]));
});

bot.action('skip_special', async (ctx) => {
  const session = getSession(ctx);
  session.specialRequests = '';
  session.step = 'confirm';
  await ctx.answerCbQuery();
  await showSummary(ctx, session);
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

function summaryText(session) {
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

  return lines.join('\n');
}

async function showSummary(ctx, session) {
  await cleanTrail(ctx, session);
  const text = summaryText(session);
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(t(session, 'btn_confirm'), 'confirm_booking')],
    [Markup.button.callback(t(session, 'btn_cancel'), 'cancel_booking')]
  ]);
  const msg = await ctx.reply(text, keyboard);
  session.summaryMessageId = msg.message_id;
}

bot.action('cancel_booking', async (ctx) => {
  const session = getSession(ctx);
  await ctx.answerCbQuery();
  if (session.summaryMessageId) {
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        session.summaryMessageId,
        undefined,
        `${summaryText(session)}\n\n${I18N.ru.cancelled} / ${I18N.en.cancelled}`
      );
    } catch (e) {
      await ctx.reply(`${I18N.ru.cancelled} / ${I18N.en.cancelled}`);
    }
  }
  resetSession(ctx);
});

// ============ PAYMENT ============
function generateBookingId() {
  return 'BKC' + Date.now() + Math.random().toString(36).substr(2, 5).toUpperCase();
}

bot.action('confirm_booking', async (ctx) => {
  const session = getSession(ctx);
  await ctx.answerCbQuery();

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
    paymentStatus: 'COMPLETED',
    payerEmail: session.email
  };

  const baseText = summaryText(session);

  async function updateSummaryMessage(extraText, keyboard) {
    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        session.summaryMessageId,
        undefined,
        `${baseText}\n\n${extraText}`,
        keyboard
      );
    } catch (e) {
      const msg = await ctx.reply(extraText, keyboard);
      session.summaryMessageId = msg.message_id;
    }
  }

  await updateSummaryMessage(t(session, 'creating_invoice'));

  try {
    const invoice = await cryptobot.createInvoice({
      bookingId,
      amount: session.prices.depositPrice,
      description: `SkiSchool.ge booking ${bookingId}`
    });

    pendingBookings.set(bookingId, {
      chatId: ctx.chat.id,
      summaryMessageId: session.summaryMessageId,
      order,
      createdAt: Date.now()
    });

    await updateSummaryMessage(
      t(session, 'invoice_ready', session.prices.depositPrice),
      Markup.inlineKeyboard([
        [Markup.button.url(t(session, 'btn_pay_cryptobot'), invoice.bot_invoice_url)],
        [Markup.button.callback(t(session, 'btn_check_status'), `check_${bookingId}`)]
      ])
    );
  } catch (error) {
    console.error('❌ CryptoBot invoice creation failed:', error);
    session.step = 'confirm';
    await updateSummaryMessage(
      t(session, 'invoice_error'),
      Markup.inlineKeyboard([
        [Markup.button.callback(t(session, 'btn_confirm'), 'confirm_booking')],
        [Markup.button.callback(t(session, 'btn_cancel'), 'cancel_booking')]
      ])
    );
  }
});

bot.action(/check_(.+)/, async (ctx) => {
  const session = getSession(ctx);
  const bookingId = ctx.match[1];

  if (!pendingBookings.has(bookingId)) {
    return ctx.answerCbQuery();
  }
  await ctx.answerCbQuery(t(session, 'payment_pending'), { show_alert: false });
});

// ============ CRYPTOBOT WEBHOOK ============
async function finalizeConfirmedPayment(bookingId, paymentId, paymentProvider) {
  const pending = pendingBookings.get(bookingId);
  if (!pending) return;

  pending.order.paymentId = String(paymentId);
  pending.order.paymentProvider = paymentProvider;

  try {
    const resp = await fetch(ADMIN_BOT_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Booking-Secret': BOOKING_WEBHOOK_SECRET
      },
      body: JSON.stringify(pending.order)
    });

    const session = sessions.get(pending.chatId);
    const confirmText = (session ? t(session, 'payment_confirmed') : I18N.ru.payment_confirmed) +
      bookingId +
      (session ? t(session, 'payment_confirmed_followup') : I18N.ru.payment_confirmed_followup);
    const errorText = session ? t(session, 'booking_finalize_error') : I18N.ru.booking_finalize_error;

    const finalText = resp.ok ? confirmText : errorText;
    if (!resp.ok) {
      console.error(`❌ Admin bot rejected crypto booking ${bookingId}:`, resp.status, await resp.text());
    }

    try {
      await bot.telegram.editMessageText(pending.chatId, pending.summaryMessageId, undefined, finalText);
    } catch (e) {
      await bot.telegram.sendMessage(pending.chatId, finalText);
    }

    pendingBookings.delete(bookingId);
    sessions.delete(pending.chatId);
  } catch (error) {
    console.error('❌ Error forwarding confirmed crypto booking to admin bot:', error);
  }
}

app.post('/webhook/cryptobot', async (req, res) => {
  const signature = req.get('crypto-pay-api-signature');
  const { verified, skipped } = cryptobot.verifyWebhookSignature(req.body, signature);

  if (!skipped && !verified) {
    console.warn('⚠️ Rejected CryptoBot webhook with invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  if (skipped) {
    console.warn('⚠️ Processing CryptoBot webhook WITHOUT signature verification (CRYPTOBOT_API_TOKEN not set) — INSECURE.');
  }

  const update = req.body;
  if (update.update_type !== 'invoice_paid') {
    return res.json({ ok: true });
  }

  const invoice = update.payload || {};
  const bookingId = invoice.payload;

  console.log(`📩 CryptoBot webhook for ${bookingId}: status=${invoice.status}`);

  if (invoice.status !== 'paid') {
    return res.json({ ok: true });
  }

  await finalizeConfirmedPayment(bookingId, `cryptobot_${invoice.invoice_id}`, 'cryptobot');
  res.json({ ok: true });
});

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
