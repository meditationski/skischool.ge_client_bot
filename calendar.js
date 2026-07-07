/**
 * calendar.js — pure functions for building the inline-keyboard calendar.
 * Kept separate from index.js so the date math can be unit-tested without
 * spinning up Telegraf.
 *
 * Booking window and week-start convention mirror the web form
 * (Asia/Tbilisi, week starts Monday, season Dec 27 – Feb 28). If the season
 * dates change on the site, update BOOKING_PERIOD here too.
 */

const BOOKING_PERIOD = {
  startDate: new Date('2026-07-07T00:00:00Z'),
  endDate: new Date('2026-07-10T00:00:00Z')
};

const MONTH_NAMES = {
  ru: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
};

const WEEKDAY_LABELS = {
  ru: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
  en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
};

// Returns { text, callback_data }[][] rows describing the calendar grid,
// plus the header text, so index.js can turn this into a Telegraf keyboard
// however it likes (kept framework-agnostic on purpose).
function buildCalendarModel(year, month, lang, bookedDates = []) {
  const monthNames = MONTH_NAMES[lang] || MONTH_NAMES.en;
  const header = `${monthNames[month]} ${year}`;

  const firstDay = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const daysInMonth = lastDay.getUTCDate();

  // JS getUTCDay(): 0=Sun..6=Sat. Convert to Monday-first index (0=Mon..6=Sun).
  let startOffset = firstDay.getUTCDay();
  startOffset = startOffset === 0 ? 6 : startOffset - 1;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);

  for (let day = 1; day <= daysInMonth; day++) {
    const current = new Date(Date.UTC(year, month, day));
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const disabled =
      current < today ||
      current < BOOKING_PERIOD.startDate ||
      current > BOOKING_PERIOD.endDate;

    const booked = bookedDates.includes(dateStr);

    cells.push({
      day,
      dateStr,
      disabled,
      booked,
      label: booked ? `•${day}` : String(day)
    });
  }

  const rows = [];
  for (let i = 0; i < cells.length; i += 7) {
    rows.push(cells.slice(i, i + 7));
  }

  return { header, weekdayLabels: WEEKDAY_LABELS[lang] || WEEKDAY_LABELS.en, rows };
}

function isWithinBookingPeriod(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return d >= today && d >= BOOKING_PERIOD.startDate && d <= BOOKING_PERIOD.endDate;
}

module.exports = { buildCalendarModel, isWithinBookingPeriod, BOOKING_PERIOD, MONTH_NAMES, WEEKDAY_LABELS };
