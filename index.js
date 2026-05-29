
'use strict';

const express = require('express');
const app = express();
app.use(express.json());

// ─── In-Memory State ──────────────────────────────────────────────────────────
// sessions[user_id] = { step: 0|1|2, lastReplyAt: timestamp }
const sessions = {};

// ─── Duplicate-reply guard: 20-second cooldown per user ──────────────────────
const COOLDOWN_MS = 20_000;

function isDuplicate(userId) {
  const session = sessions[userId];
  if (!session || !session.lastReplyAt) return false;
  return Date.now() - session.lastReplyAt < COOLDOWN_MS;
}

function touchReply(userId) {
  if (!sessions[userId]) sessions[userId] = { step: 0, lastReplyAt: null };
  sessions[userId].lastReplyAt = Date.now();
}

// ─── Service Prices ───────────────────────────────────────────────────────────
const PRICES = {
  'Lawn Mowing – Front & Back': '$125',
  'Lawn Mowing + Weed Control – Front Yard': '$130',
  'Lawn Mowing + Weed Control – Backyard': '$130',
  'Lawn Mowing + Weed Control – Front & Back': '$165',
  'Lawn Mowing – Front & Back (Subscription/Recurring)': '$125',
  'Lawn Mowing + Weed Control – Front Yard (Subscription/Recurring)': '$130',
  'Lawn Mowing + Weed Control – Backyard (Subscription/Recurring)': '$130',
  'Lawn Mowing + Weed Control – Front & Back (Subscription/Recurring)': '$165',
  'Branch & Debris Removal – Front Yard': '$200',
  'Branch & Debris Removal – Backyard': '$210',
  'Branch & Debris Removal – Front & Back': '$365',
  'Branch & Debris Removal – Front Yard (Heavy Duty)': '$350',
  'Branch & Debris Removal – Backyard (Heavy Duty)': '$365',
  'Branch & Debris Removal – Front & Back (Heavy Duty)': '$730',
};

// ─── Message Templates ────────────────────────────────────────────────────────
const SERVICE_MENU = `Which service do you want the instant quote for?
(TYPE THE EXACT SERVICE YOU WANT AS YOUR REPLY)

Lawn Mowing – Front & Back
Lawn Mowing + Weed Control – Front Yard
Lawn Mowing + Weed Control – Backyard
Lawn Mowing + Weed Control – Front & Back
Lawn Mowing – Front & Back (Subscription/Recurring)
Lawn Mowing + Weed Control – Front Yard (Subscription/Recurring)
Lawn Mowing + Weed Control – Backyard (Subscription/Recurring)
Lawn Mowing + Weed Control – Front & Back (Subscription/Recurring)
Branch & Debris Removal – Front Yard
Branch & Debris Removal – Backyard
Branch & Debris Removal – Front & Back
Branch & Debris Removal – Front Yard (Heavy Duty)
Branch & Debris Removal – Backyard (Heavy Duty)
Branch & Debris Removal – Front & Back (Heavy Duty)`;

const BOOKING_MESSAGE = `You can book instantly through our site by choosing your preferred time and date:
https://urban-leaf-landscaping.base44.app/Services

Use coupon code ULL40 at checkout for $40 off your first service.

After booking, you will receive a confirmation email.

We look forward to getting to work! 🌿
— Urban Leaf Landscaping`;

// ─── Helper: get or initialise session ───────────────────────────────────────
function getSession(userId) {
  if (!sessions[userId]) {
    sessions[userId] = { step: 0, lastReplyAt: null };
  }
  return sessions[userId];
}

// ─── Core Logic ───────────────────────────────────────────────────────────────
function handleMessage(userId, text) {
  const session = getSession(userId);
  const trimmed = text.trim();

  // Step 0 – waiting for keyword
  if (session.step === 0) {
    if (/quote/i.test(trimmed)) {
      session.step = 1;
      return { reply: SERVICE_MENU };
    }
    // Not the right keyword – ignore silently (no reply)
    return null;
  }

  // Step 1 – waiting for service selection
  if (session.step === 1) {
    const price = PRICES[trimmed];
    if (price) {
      session.step = 2;
      // Return both messages joined; Base44 can split on "\n\n---\n\n" or just
      // deliver them as one block. Adjust if Base44 supports multi-message.
      const priceMsg = `The price for "${trimmed}" is ${price}.`;
      return {
        reply: priceMsg,
        followUp: BOOKING_MESSAGE,
      };
    }
    // Unrecognised service – prompt again
    return {
      reply: `Sorry, I didn't recognise that service. Please type the service name exactly as shown:\n\n${SERVICE_MENU}`,
    };
  }

  // Step 2 – conversation complete
  // Reset so the user can start a new quote flow
  if (/quote/i.test(trimmed)) {
    session.step = 1;
    session.lastReplyAt = null; // allow immediate reply
    return { reply: SERVICE_MENU };
  }

  return null; // no action
}

// ─── POST /webhook ────────────────────────────────────────────────────────────
app.post('/webhook', (req, res) => {
  try {
    const body = req.body;

    // Validate basic payload shape
    const entry = body?.entry?.[0];
    const messaging = entry?.messaging?.[0];

    if (!messaging) {
      return res.status(400).json({ error: 'Invalid payload: missing entry.messaging' });
    }

    const userId = messaging?.sender?.id;
    const messageText = messaging?.message?.text;

    if (!userId) {
      return res.status(400).json({ error: 'Cannot extract sender.id from payload' });
    }

    if (!messageText) {
      // Could be a reaction, story reply, etc. — acknowledge and skip
      return res.status(200).json({ status: 'ignored', reason: 'no text in message' });
    }

    // Duplicate-reply guard
    if (isDuplicate(userId)) {
      console.log(`[COOLDOWN] Skipping duplicate reply for user ${userId}`);
      return res.status(200).json({ status: 'skipped', reason: 'cooldown active' });
    }

    const result = handleMessage(userId, messageText);

    if (!result) {
      // No reply needed
      return res.status(200).json({ status: 'no_action' });
    }

    touchReply(userId);

    // If there's a follow-up (price + booking link), combine into one response
    // with a clear separator that Base44 / your integration layer can split.
    // Alternatively, return both as an array of replies.
    if (result.followUp) {
      console.log(`[REPLY] user=${userId} step=price+booking`);
      return res.status(200).json({
        replies: [result.reply, result.followUp],
        // Convenience: single string version (separated by double newline)
        reply: `${result.reply}\n\n${result.followUp}`,
      });
    }

    console.log(`[REPLY] user=${userId}`);
    return res.status(200).json({ reply: result.reply });

  } catch (err) {
    console.error('[ERROR]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── GET /webhook – Meta verification challenge ───────────────────────────────
// Meta sends a GET to verify the webhook URL. Handle it here if you ever
// connect this server directly to Meta (not via Base44).
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'urban_leaf_verify_token';
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[WEBHOOK] Meta verification challenge accepted');
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: 'Forbidden' });
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', activeSessions: Object.keys(sessions).length });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅  Urban Leaf Webhook API running on port ${PORT}`);
});

module.exports = app; // exported for testing
