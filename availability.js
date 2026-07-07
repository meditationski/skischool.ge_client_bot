/**
 * availability.js — checks lesson-slot availability against the same
 * Google Apps Script backend the web form uses, so the bot and the site
 * never show conflicting availability.
 */

const { getTimeSlots } = require('./pricing');

const AVAILABILITY_API_URL = 'https://script.google.com/macros/s/AKfycbyzf3hmuOVckf_3Td9ca-zD-Ruov_gK0JpDYK3L2fH882eNG_4YJczTfkmiHrOnojyVwQ/exec';

const cache = new Map();

async function getAvailableTimeSlots(dateStr, sport, duration) {
  const cacheKey = `${dateStr}_${sport}_${duration}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const url = `${AVAILABILITY_API_URL}?action=getAvailableSlots&date=${dateStr}&sport=${sport}&duration=${duration}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    cache.set(cacheKey, data.availableSlots);
    return data.availableSlots;
  } catch (error) {
    console.error('❌ Batch availability check failed, falling back to per-slot checks:', error.message);
    try {
      const slots = getTimeSlots(sport, duration);
      const available = [];
      for (const time of slots) {
        const ok = await checkTimeSlotAvailability(dateStr, sport, duration, time);
        if (ok) available.push(time);
      }
      cache.set(cacheKey, available);
      return available;
    } catch (error2) {
      console.error('❌ Per-slot checks also failed, showing all slots as available:', error2.message);
      const fallback = getTimeSlots(sport, duration);
      cache.set(cacheKey, fallback);
      return fallback;
    }
  }
}

async function checkTimeSlotAvailability(dateStr, sport, duration, time) {
  const cacheKey = `${dateStr}_${sport}_${duration}_${time}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  try {
    const url = `${AVAILABILITY_API_URL}?date=${dateStr}&sport=${sport}&duration=${duration}&time=${time}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    cache.set(cacheKey, data.available);
    return data.available;
  } catch (error) {
    console.error('❌ Single slot availability check failed, assuming available:', error.message);
    cache.set(cacheKey, true);
    return true;
  }
}

function clearAvailabilityCache() {
  cache.clear();
}

module.exports = { getAvailableTimeSlots, checkTimeSlotAvailability, clearAvailabilityCache };
