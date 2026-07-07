/**
 * nowpayments.js — creates USDT (TRC20) payment invoices via NOWPayments'
 * hosted checkout, and verifies the authenticity of their IPN webhook calls.
 *
 * Docs: https://documenter.getpostman.com/view/7907941/S1a32n38
 */

const crypto = require('crypto');

const API_BASE = 'https://api.nowpayments.io/v1';

async function createInvoice({ bookingId, depositAmount, description, ipnCallbackUrl, successUrl, cancelUrl }) {
  const apiKey = process.env.NOWPAYMENTS_API_KEY;
  if (!apiKey) {
    throw new Error('NOWPAYMENTS_API_KEY is not set');
  }

  const resp = await fetch(`${API_BASE}/invoice`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      price_amount: depositAmount,
      price_currency: 'usd',
      pay_currency: 'usdttrc20',
      order_id: bookingId,
      order_description: description,
      ipn_callback_url: ipnCallbackUrl,
      success_url: successUrl,
      cancel_url: cancelUrl,
      is_fixed_rate: true // lock the USD->USDT rate for a few minutes so it doesn't drift while the client pays
    })
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`NOWPayments invoice creation failed: ${resp.status} ${text}`);
  }

  return resp.json(); // { id, invoice_url, order_id, ... }
}

// NOWPayments signs IPN callbacks with HMAC-SHA512 over the JSON body with
// its keys sorted alphabetically (not the raw received bytes). Verifying
// this is what stops someone from just POSTing a fake "finished" status to
// our IPN endpoint directly.
function verifyIpnSignature(rawBody, signatureHeader) {
  const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!ipnSecret) {
    console.warn('⚠️ NOWPAYMENTS_IPN_SECRET not set — cannot verify IPN authenticity (INSECURE).');
    return { verified: false, skipped: true };
  }
  if (!signatureHeader) {
    return { verified: false, skipped: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch (e) {
    return { verified: false, skipped: false };
  }

  const sortedBody = JSON.stringify(sortKeysDeep(parsed));
  const computed = crypto
    .createHmac('sha512', ipnSecret)
    .update(sortedBody)
    .digest('hex');

  const verified = computed === signatureHeader;
  return { verified, skipped: false };
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortKeysDeep(value[key]);
        return acc;
      }, {});
  }
  return value;
}

module.exports = { createInvoice, verifyIpnSignature };
