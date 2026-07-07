/**
 * pricing.js — ported byte-for-byte (same formulas) from the web booking
 * form's app.js `calculatePrice`/`getDiscount`/`getTimeSlots`.
 *
 * IMPORTANT: if pricing rules ever change on the website, mirror the same
 * change here. There are now three independent copies of this logic
 * (web form, this bot) — that's a known trade-off of keeping the client bot
 * as a separate service. If this starts drifting, consider extracting a
 * shared npm package both services install instead.
 */

const PRICES = {
  ski: {
    '2': { base: 100, additional: 40 },
    '3': { base: 140, additional: 50 },
    'full': { base: 250, additional: 80 }
  },
  snowboard: {
    '2': { base: 100, additional: 40 },
    '3': { base: 140, additional: 50 },
    'full': { base: 250, additional: 80 }
  },
  kids: {
    'full': 150,
    'half-lunch': 110,
    'half-nolunch': 90
  }
};

function getDiscount(sport, days) {
  if (sport === 'kids') {
    if (days >= 7) return 0.15;
    if (days >= 5) return 0.10;
    return 0;
  } else {
    if (days >= 8) return 0.20;
    if (days >= 6) return 0.15;
    if (days >= 4) return 0.10;
    return 0;
  }
}

function getTimeSlots(sport, duration) {
  if (sport === 'kids') {
    return ['10:30'];
  }
  if (duration === '2') {
    return ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00'];
  } else if (duration === '3') {
    return ['10:00', '11:00', '12:00', '13:00', '14:00'];
  } else if (duration === 'full') {
    return ['10:00'];
  }
  return ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'];
}

// booking = { sport, duration, participants, days }
function calculatePrice(booking) {
  const { sport, duration, participants, days } = booking;
  let totalPrice = 0;

  if (sport === 'kids') {
    const pricePerKid = PRICES.kids[duration];
    let pricePerDay = pricePerKid * participants;

    const fullPriceDays = Math.min(4, days);
    totalPrice = pricePerDay * fullPriceDays;

    if (days > 4) {
      const discountRate = getDiscount(sport, days);
      const discountedDays = days - 4;
      const discountedPrice = pricePerDay * (1 - discountRate);
      totalPrice += discountedPrice * discountedDays;
    }
  } else {
    const priceConfig = PRICES[sport][duration];
    let pricePerDay = priceConfig.base;

    if (participants > 1) {
      pricePerDay += (participants - 1) * priceConfig.additional;
    }

    const fullPriceDays = Math.min(3, days);
    totalPrice = pricePerDay * fullPriceDays;

    if (days > 3) {
      const discountRate = getDiscount(sport, days);
      const discountedDays = days - 3;
      const discountedPrice = pricePerDay * (1 - discountRate);
      totalPrice += discountedPrice * discountedDays;
    }
  }

  totalPrice = Math.round(totalPrice);
  const depositPrice = Math.round(totalPrice * 0.2);
  const remainingPrice = totalPrice - depositPrice;

  return { totalPrice, depositPrice, remainingPrice };
}

module.exports = { PRICES, getDiscount, getTimeSlots, calculatePrice };
