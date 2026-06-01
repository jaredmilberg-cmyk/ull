
'use strict';

// ─── Dependencies ─────────────────────────────────────────────────────────────
const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');

// ─── Database Setup ───────────────────────────────────────────────────────────
// SQLite file lives next to index.js. On Render, use a persistent disk path
// by setting the DB_PATH env var (e.g. /var/data/sessions.db).
// Without a persistent disk the file resets on deploy — add one in Render's
// dashboard under your service → Disks (free tier supports 1 GB).
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'sessions.db');
const db = new Database(DB_PATH);

// Enable WAL mode: much faster concurrent reads/writes, safer crash recovery.
db.pragma('journal_mode = WAL');

// Create sessions table if it doesn't exist yet.
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    user_id      TEXT    PRIMARY KEY,
    step         INTEGER NOT NULL DEFAULT 0,
    last_service TEXT,
    last_reply_at INTEGER
  )
`);

// ─── Prepared Statements (compiled once, reused on every request) ─────────────
const stmtGet    = db.prepare('SELECT * FROM sessions WHERE user_id = ?');
const stmtUpsert = db.prepare(`
  INSERT INTO sessions (user_id, step, last_service, last_reply_at)
  VALUES (@user_id, @step, @last_service, @last_reply_at)
  ON CONFLICT(user_id) DO UPDATE SET
    step          = excluded.step,
    last_service  = excluded.last_service,
    last_reply_at = excluded.last_reply_at
`);

// ─── Session Helpers ──────────────────────────────────────────────────────────
const DEFAULT_SESSION = { step: 0, last_service: null, last_reply_at: null };

/** Read session from DB. Returns a plain object — never null. */
function getSession(userId) {
  const row = stmtGet.get(userId);
  if (!row) return { ...DEFAULT_SESSION, user_id: userId };
  return row;
}

/** Persist a full session object back to DB. */
function saveSession(session) {
  stmtUpsert.run(session);
}

// ─── Duplicate-Reply Guard: 20-second cooldown ────────────────────────────────
const COOLDOWN_MS = 20_000;

function isDuplicate(session) {
  if (!session.last_reply_at) return false;
  return Date.now() - session.last_reply_at < COOLDOWN_MS;
}

// ─── Input Normalisation ──────────────────────────────────────────────────────
function normalise(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Trigger Detection ────────────────────────────────────────────────────────
function isQuoteTrigger(text) {
  return /^quote\.?$/i.test(text.trim());
}

function isInstructionsTrigger(text) {
  return /^instructions\.?$/i.test(text.trim());
}

// ─── Service Prices ───────────────────────────────────────────────────────────
const PRICES = {
  'Lawn Mowing – Front & Back':                                         '$125',
  'Lawn Mowing + Weed Control – Front Yard':                           '$130',
  'Lawn Mowing + Weed Control – Backyard':                             '$130',
  'Lawn Mowing + Weed Control – Front & Back':                         '$165',
  'Lawn Mowing – Front & Back (Subscription/Recurring)':               '$125',
  'Lawn Mowing + Weed Control – Front Yard (Subscription/Recurring)':  '$130',
  'Lawn Mowing + Weed Control – Backyard (Subscription/Recurring)':    '$130',
  'Lawn Mowing + Weed Control – Front & Back (Subscription/Recurring)':'$165',
  'Branch & Debris Removal – Front Yard':                              '$200',
  'Branch & Debris Removal – Backyard':                                '$210',
  'Branch & Debris Removal – Front & Back':                            '$365',
  'Branch & Debris Removal – Front Yard (Heavy Duty)':                 '$350',
  'Branch & Debris Removal – Backyard (Heavy Duty)':                   '$365',
  'Branch & Debris Removal – Front & Back (Heavy Duty)':               '$730',
};

// ─── Safe Service Matching ────────────────────────────────────────────────────
// Pass 1 — exact normalised match (safest).
// Pass 2 — user input contains the full service name (handles minor noise).
// No reverse fuzzy — prevents wrong-service matches.
function findService(input) {
  const normInput = normalise(input);

  for (const [label, price] of Object.entries(PRICES)) {
    if (normInput === normalise(label)) return { label, price };
  }

  for (const [label, price] of Object.entries(PRICES)) {
    if (normInput.includes(normalise(label))) return { label, price };
  }

  return null;
}

// ─── Message Templates ────────────────────────────────────────────────────────
const SERVICE_MENU = `What service would you like a quote for?

• Lawn Mowing – Front & Back
• Lawn Mowing + Weed Control – Front Yard
• Lawn Mowing + Weed Control – Backyard
• Lawn Mowing + Weed Control – Front & Back
• Lawn Mowing – Front & Back (Subscription/Recurring)
• Lawn Mowing + Weed Control – Front Yard (Subscription/Recurring)
• Lawn Mowing + Weed Control – Backyard (Subscription/Recurring)
• Lawn Mowing + Weed Control – Front & Back (Subscription/Recurring)
• Branch & Debris Removal – Front Yard
• Branch & Debris Removal – Backyard
• Branch & Debris Removal – Front & Back
• Branch & Debris Removal – Front Yard (Heavy Duty)
• Branch & Debris Removal – Backyard (Heavy Duty)
• Branch & Debris Removal – Front & Back (Heavy Duty)

TO SELECT THE SERVICE YOU WANT, REPLY WITH THE NAME OF THE SERVICE EXACTLY.`;

function buildQuoteReply(price) {
  return `For this service the price is ${price}.

Right now you can get $40 off the service you just selected for the next 30 minutes if you book right now on our site.

Use coupon code: 40ULL
Book here: https://urban-leaf-landscaping.base44.app/Services

Thanks and we look forward to serving you.

(Note: if you are booking and need further instructions on what to do, reply "instructions" and we will guide you through the booking process)`;
}

const INSTRUCTIONS_MESSAGE = `Here's how to complete your booking:

1. Upon visiting the website, select the service you were just quoted for. By clicking on the three sections (Snow Removal, Lawn Care, or Yard Cleanup) a drop-down of available services will appear — select the one you were quoted for.

2. Hit "Book and Schedule" at the bottom after selecting your service. Fill in your details, continue to the calendar, and select a day and time. If this is a subscription, we will aim to return at this time for the frequency you selected.
   Example: Lawn mowing scheduled for May 7th 3:00pm → next visit May 14th 3:00pm.

3. You will then be redirected to pay using Stripe. Remember to use coupon code 40ULL at checkout for $40 off if booked within 30 minutes of receiving this offer.

Upon paying, you will receive a confirmation email of your purchase and upcoming appointment with Urban Leaf Landscaping.

We look forward to helping you. 🌿`;

const NO_MATCH_MESSAGE =
  `I couldn't match that service exactly. Please select one from the list and reply with the name exactly as shown:\n\n${SERVICE_MENU}`;

const INSTRUCTIONS_TOO_EARLY_MESSAGE =
  `Please send "quote" first to get a price — I'll guide you through booking after that.`;

// ─── Core Logic ───────────────────────────────────────────────────────────────
// All DB reads/writes use better-sqlite3's synchronous API, so no async needed.
// better-sqlite3 is deliberately synchronous — it's safe and fast for this use case.
function handleMessage(userId, text) {
  const session = getSession(userId);
  const raw     = text.trim();

  // ── INSTRUCTIONS trigger ──────────────────────────────────────────────────
  if (isInstructionsTrigger(raw)) {
    if (session.step >= 2) {
      // No state change needed — just reply
      return { reply: INSTRUCTIONS_MESSAGE };
    }
    return { reply: INSTRUCTIONS_TOO_EARLY_MESSAGE };
  }

  // ── QUOTE trigger — (re)starts the flow ──────────────────────────────────
  if (isQuoteTrigger(raw)) {
    saveSession({
      user_id:       userId,
      step:          1,
      last_service:  null,
      last_reply_at: null, // clear cooldown so the menu always goes out
    });
    return { reply: SERVICE_MENU };
  }

  // ── Step 1: waiting for service selection ─────────────────────────────────
  if (session.step === 1) {
    const match = findService(raw);

    if (match) {
      saveSession({
        user_id:       userId,
        step:          2,
        last_service:  match.label,
        last_reply_at: Date.now(),
      });
      return { reply: buildQuoteReply(match.price) };
    }

    return { reply: NO_MATCH_MESSAGE };
  }

  // ── Step 0 / Step 2: only quote or instructions trigger a response ─────────
  return null;
}

// ─── Meta Messenger Send ──────────────────────────────────────────────────────
// Sends a DM reply back to the user via the Instagram Graph API.
// Requires PAGE_ACCESS_TOKEN to be set as an environment variable on Render.
async function sendMessage(userId, text) {
  const url = `https://graph.facebook.com/v19.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      recipient: { id: userId },
      message:   { text },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error(`[SEND ERROR] user=${userId} status=${res.status} body=${errBody}`);
  }
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// POST /webhook — incoming Instagram DM
app.post('/webhook', async (req, res) => {
  try {
    const entry     = req.body?.entry?.[0];
    const messaging = entry?.messaging?.[0];

    if (!messaging) {
      return res.status(400).json({ error: 'Invalid payload: missing entry.messaging' });
    }

    const userId      = messaging?.sender?.id;
    const messageText = messaging?.message?.text;

    if (!userId) {
      return res.status(400).json({ error: 'Cannot extract sender.id from payload' });
    }

    if (!messageText) {
      // Reaction, story reply, sticker, etc.
      return res.status(200).json({ status: 'ignored', reason: 'no text in message' });
    }

    // Cooldown check — read from DB
    const existingSession = getSession(userId);
    if (isDuplicate(existingSession)) {
      console.log(`[COOLDOWN] Skipping duplicate reply for user ${userId}`);
      return res.status(200).json({ status: 'skipped', reason: 'cooldown active' });
    }

    const result = handleMessage(userId, messageText);

    if (!result) {
      return res.status(200).json({ status: 'no_action' });
    }

    // Stamp cooldown on the persisted session (handleMessage may have already
    // saved a new session; we update last_reply_at without overwriting step).
    const updatedSession = getSession(userId);
    saveSession({ ...updatedSession, last_reply_at: Date.now() });

    console.log(`[REPLY] user=${userId} step=${getSession(userId).step}`);
    await sendMessage(userId, result.reply);
    return res.sendStatus(200);

  } catch (err) {
    console.error('[ERROR]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /webhook — Meta webhook verification challenge
app.get('/webhook', (req, res) => {
  const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'urban_leaf_verify_token';
  const mode         = req.query['hub.mode'];
  const token        = req.query['hub.verify_token'];
  const challenge    = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[WEBHOOK] Meta verification challenge accepted');
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ error: 'Forbidden' });
});

// GET /health — uptime / session count check
app.get('/health', (_req, res) => {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM sessions').get();
  res.json({ status: 'ok', totalSessions: count, dbPath: DB_PATH });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅  Urban Leaf Webhook API running on port ${PORT}`);
  console.log(`💾  SQLite database: ${DB_PATH}`);
});

module.exports = app;
