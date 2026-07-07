/**
 * cryptobot.js — integration with @CryptoBot's Crypto Pay API, as a second
 * payment option alongside NOWPayments. Same "verify before trusting"
 * principle as the other payment modules in this codebase.
 *
 * Get an API token: open @CryptoBot (or @CryptoTestnetBot for testing) →
 * Crypto Pay → My Apps → Create App.
 * Enable webhooks in that same app's settings → Webhooks → point at
 * `${PUBLIC_URL}/webhook/cryptobot` (no separate secret to generate — the
 * app token itself is used to derive the signing key, see below).
 *
 * Docs: https://help.send.tg/en/articles/10279948-crypto-pay-api
 */

const crypto = require('crypto');

function apiBase() {
  return process.env.CRYPTOBOT_API_BASE || 'https://pay.crypt.bot/api';
}

async function createInvoice({ bookingId, amount, description }) {
  const token = process.env.CRYPTOBOT_API_TOKEN;
  if (!token) {
    throw new Error('CRYPTOBOT_API_TOKEN is not set');
  }

  const resp = await fetch(`${apiBase()}/createInvoice`, {
    method: 'POST',
    headers: {
      'Crypto-Pay-API-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      asset: 'USDT',
      amount: String(amount),
      description,
      payload: bookingId, // round-tripped back to us in the webhook, unmodified
      expires_in: 3600
    })
  });

  const data = await resp.json();
  if (!resp.ok || !data.ok) {
    throw new Error(`CryptoBot invoice creation failed: ${resp.status} ${JSON.stringify(data)}`);
  }

  return data.result; // { invoice_id, bot_invoice_url, mini_app_invoice_url, web_app_invoice_url, ... }
}

// Official recipe (see docs link above): the signing key is the SHA-256
// digest of the app token (not the token itself), and the signed string is
// JSON.stringify(body) of the ALREADY-PARSED request body — not a
// re-sorted or raw-bytes version, unlike NOWPayments' scheme. Don't mix
// the two up.
function verifyWebhookSignature(body, signatureHeader) {
  const token = process.env.CRYPTOBOT_API_TOKEN;
  if (!token) {
    console.warn('⚠️ CRYPTOBOT_API_TOKEN not set — cannot verify CryptoBot webhook signature (INSECURE).');
    return { verified: false, skipped: true };
  }
  if (!signatureHeader) {
    return { verified: false, skipped: false };
  }

  const secret = crypto.createHash('sha256').update(token).digest();
  const checkString = JSON.stringify(body);
  const hmac = crypto.createHmac('sha256', secret).update(checkString).digest('hex');

  return { verified: hmac === signatureHeader, skipped: false };
}

module.exports = { createInvoice, verifyWebhookSignature };
