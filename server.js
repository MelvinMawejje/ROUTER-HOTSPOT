// server.js
require('dotenv').config();
const express = require('express');
const db      = require('./db');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));  // serves your index.html, app.js, style.css

const IOTEC_CLIENT_ID     = process.env.IOTEC_CLIENT_ID;
const IOTEC_CLIENT_SECRET = process.env.IOTEC_CLIENT_SECRET;
const IOTEC_WALLET_ID     = process.env.IOTEC_WALLET_ID;

// ─── MikroTik router credentials ──────────────────────────────
const ROUTER_HOST = process.env.ROUTER_HOST;
const ROUTER_USER = process.env.ROUTER_USER;
const ROUTER_PASS = process.env.ROUTER_PASS;

const PORT = process.env.PORT || 3000;

// Fail loudly on startup rather than silently misbehaving in production
// with an empty password or undefined host.
const REQUIRED_VARS = [
  'IOTEC_CLIENT_ID', 'IOTEC_CLIENT_SECRET', 'IOTEC_WALLET_ID',
  'ROUTER_HOST', 'ROUTER_USER', 'ROUTER_PASS',
  'METRICS_PIN',
];
const missing = REQUIRED_VARS.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing required .env variables: ${missing.join(', ')}`);
  console.error('   Copy .env.example to .env and fill in real values.');
  process.exit(1);
}

// ─── Helper: fetch from MikroTik REST API ──────────────────────
// Hard timeout so a flaky router doesn't hang requests for a long time, plus
// one automatic retry — most "fetch failed" hiccups are transient (a dropped
// keep-alive socket or a momentary blip reaching the router).
const ROUTER_TIMEOUT_MS = 5000;

async function mikrotikFetch(endpoint, options = {}, attempt = 1) {
  const url = `http://${ROUTER_HOST}/rest${endpoint}`;
  const auth = 'Basic ' + Buffer.from(`${ROUTER_USER}:${ROUTER_PASS}`).toString('base64');
  try {
    const resp = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(ROUTER_TIMEOUT_MS),
      headers: {
        ...options.headers,
        'Authorization': auth,
        'Content-Type': 'application/json',
      },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`MikroTik API error: ${resp.status} - ${text}`);
    }
    return await resp.json();
  } catch (e) {
    if (attempt < 2) {
      console.warn(`[MikroTik] ${endpoint} failed (${e.message}) — retrying once`);
      await new Promise(r => setTimeout(r, 400));
      return mikrotikFetch(endpoint, options, attempt + 1);
    }
    const cause = e.cause ? ` (${e.cause.code || e.cause.message})` : '';
    throw new Error(`Router unreachable at ${ROUTER_HOST}: ${e.message}${cause}`);
  }
}

// ── Force-remove any active hotspot session for a given MAC ──────────────
// Used when a transaction-ID lookup needs to reclaim a voucher whose
// active_mac is stale (e.g. the customer's device rotated its MAC).
async function forceDisconnectMac(mac) {
  if (!mac) return;
  const active  = await mikrotikFetch('/ip/hotspot/active');
  const matches = active.filter(a => (a['mac-address'] || '').toUpperCase() === mac.toUpperCase());
  for (const session of matches) {
    if (session['.id']) {
      await mikrotikFetch('/ip/hotspot/active/remove', {
        method: 'POST',
        body:   JSON.stringify({ '.id': session['.id'] }),
      });
    }
  }
}

// ─── Helper: get client MAC address from router's DHCP leases ──
async function getMacFromIp(clientIp) {
  const leases = await mikrotikFetch('/ip/dhcp-server/lease');
  const lease = leases.find(l => l['active-address'] === clientIp && l.status === 'bound');
  return lease ? lease['mac-address'] : null;
}

app.get('/api/mac/check', (req, res) => {
  const mac = (req.query.mac || '').toUpperCase();
  if (!mac) return res.json({ found: false });
  const voucher = db.getVoucherByMac(mac);
  if (voucher && !voucher.disabled && voucher.remaining_seconds > 0) {
    return res.json({ found: true, code: voucher.code });
  }
  res.json({ found: false });
});

// ─── Voucher redemption endpoint ─────────────────────────────────────────────
// Validates against our SQLite database (covers both admin-generated vouchers
// and payment-created ones). RADIUS then handles the actual MikroTik auth.
app.post('/api/voucher/redeem', (req, res) => {
  const code = (req.body.voucherCode || '').trim().toUpperCase();
  const mac  = (req.body.mac || '').trim();
  if (code.length < 2)
    return res.status(400).json({ success: false, message: 'Please enter a valid voucher code.' });

  const voucher = db.getVoucher(code);

  if (!voucher)
    return res.status(400).json({ success: false, message: 'Invalid voucher code. Please check and try again.' });

  if (voucher.disabled)
    return res.status(400).json({ success: false, message: 'This voucher has been disabled.' });

  if (voucher.remaining_seconds <= 0)
    return res.status(400).json({ success: false, message: 'This voucher has expired — all session time has been used.' });

  // Same "one device at a time" rule RADIUS enforces — catch it here so the
  // user gets an immediate, visible message instead of silently failing
  // inside the hidden MikroTik login iframe.
  if (db.isVoucherActiveElsewhere(code, mac))
    return res.status(409).json({ success: false, message: 'This voucher is already connected on another device. Please disconnect it there first, then try again here.' });

  // Record revenue on first use — wrapped in try/catch so a DB hiccup
  // never prevents the user from logging in
  if (!voucher.first_used_at) {
    try {
      const source = code.startsWith('PAY') ? 'mobile_money' : 'voucher';
      db.recordRevenue(code, voucher.profile, source);
    } catch (e) {
      console.error('[revenue] recordRevenue failed (non-fatal):', e.message);
    }
  }

  res.json({
    success:     true,
    code,
    loginAction: `http://${ROUTER_HOST}/login`,
  });
});

// ── Step 1: Get auth token ────────────────────────────────────────────────────
async function getAuthToken() {
  const resp = await fetch('https://id.iotec.io/connect/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     IOTEC_CLIENT_ID,
      client_secret: IOTEC_CLIENT_SECRET,
      grant_type:    'client_credentials'
    })
  });
  const data = await resp.json();
  return data.access_token;
}

// ── Route: Initiate payment ───────────────────────────────────────────────────
app.post('/api/pay', async (req, res) => {
  try {
    const { phone, amount, packageId } = req.body;
    if (!phone || !amount || !packageId) {
      return res.status(400).json({ error: 'Missing phone, amount, or packageId' });
    }
    const token = await getAuthToken();

    const response = await fetch('https://pay.iotec.io/api/collections/collect', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        category:                   'MobileMoney',
        currency:                   'UGX',
        walletId:                    IOTEC_WALLET_ID,
        externalId:                 'MBUYA-' + Date.now(),
        payer:                       phone,
        payerName:                  'MBUYA WIFI Customer',
        payerNote:                  `MBUYA WIFI – ${packageId} package`,
        amount:                      amount,
        payeeNote:                  `Package: ${packageId}`,
        channel:                     null,
        transactionChargesCategory: 'ChargeWallet',
        redirectUrl:                 null
      })
    });

     // Check if response is JSON
    const contentType = response.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      console.error('Non‑JSON response from iotec:', text);
      return res.status(500).json({ error: 'Unexpected response from payment gateway.' });
    }
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || data.title || 'Payment initiation failed.' });
    }

    // Record what this transaction is FOR before we tell the client
    // anything — so if their tab dies right after this, the webhook still
    // has enough information to create the voucher independently.
    // NOTE: confirm the actual ID field IOTEC returns here (checking both
    // `id` and `transactionId` as a safety net — remove whichever is wrong
    // once confirmed against a real response).
    const iotecTxnId = data.id || data.transactionId;
    if (iotecTxnId) {
      try {
        db.savePendingPayment(iotecTxnId, phone, packageId);
      } catch (e) {
        console.error('[pending-payment] save failed (non-fatal):', e.message);
      }
    } else {
      console.warn('[pay] No transaction ID found in IOTEC response — webhook fallback will not work for this payment:', JSON.stringify(data));
    }

    res.json(data);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error.' });
  }
});

// ─── Shared: create (or return existing) voucher for a completed payment ────
// Idempotent on transactionId. Both the client-triggered route below AND the
// IOTEC webhook call this — whichever fires first actually creates the
// voucher; the other becomes a no-op that just hands back the same code.
// This is the piece that prevents double-crediting revenue if both paths
// fire for the same payment.
//
// NOTE: We intentionally do NOT create a local MikroTik hotspot user here.
// If a local user exists, MikroTik authenticates it locally and never sends
// RADIUS accounting — so expires_at never gets set and the wall-clock timer
// never starts. Keeping the voucher in RADIUS only (our db) forces MikroTik
// to go through RADIUS for auth AND accounting, which is what we want.
function createVoucherForPayment(phone, packageId, transactionId) {
  if (transactionId) {
    const existing = db.getVoucherByTransactionId(transactionId);
    if (existing) return { voucherCode: existing.code, alreadyExisted: true };
  }

  // Generate PAY + 8 alphanumeric chars, no hyphens (e.g. PAY3F7K9XZ)
  // Same charset as admin vouchers — no ambiguous chars (0/O/1/I/L)
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let voucherCode = 'PAY';
  for (let i = 0; i < 8; i++) voucherCode += chars[Math.floor(Math.random() * chars.length)];

  // Register in our database — RADIUS handles authentication from here
  db.createVoucher(voucherCode, packageId);

  // Link this voucher to the IOTEC transaction ID so the user can retrieve
  // it later (e.g. after getting disconnected) by pasting the transaction
  // ID back into the portal.
  if (transactionId) {
    try {
      db.bindTransactionId(voucherCode, transactionId);
    } catch (e) {
      console.error('[txn-link] bindTransactionId failed (non-fatal):', e.message);
    }
  }

  // Record revenue (96% net for mobile money) — non-fatal if DB not ready
  try {
    db.recordRevenue(voucherCode, packageId, 'mobile_money');
  } catch (e) {
    console.error('[revenue] recordRevenue failed (non-fatal):', e.message);
  }

  if (transactionId) {
    try {
      db.markPendingPaymentComplete(transactionId, voucherCode);
    } catch (e) {
      console.error('[pending-payment] mark complete failed (non-fatal):', e.message);
    }
  }

  return { voucherCode, alreadyExisted: false };
}

// ─── Auto‑connect after payment (client-triggered path) ─────────────────────
// Fires when the customer's browser is still alive and sees the payment
// succeed. The webhook below is the independent, server-side backstop for
// when it isn't.
app.post('/api/pay/connect', async (req, res) => {
  const { phone, packageId, transactionId } = req.body;
  if (!phone || !packageId)
    return res.status(400).json({ success: false, message: 'Missing phone or package ID.' });

  try {
    const { voucherCode } = createVoucherForPayment(phone, packageId, transactionId);

    res.json({
      success:     true,
      voucher:     voucherCode,
      loginAction: `http://${ROUTER_HOST}/login`,
      message:     'Payment confirmed! Starting your session…',
    });
  } catch (err) {
    console.error('Pay/connect error:', err.message);
    res.status(500).json({ success: false, message: err.message || 'Server error.' });
  }
});

// ─── IOTEC payment webhook (server-side backstop) ────────────────────────────
// Server-to-server notification the instant a collection succeeds or fails —
// independent of whether the customer's browser is still open. This is what
// actually closes the "money deducted but no voucher" gap: /api/pay/connect
// only fires if the client is alive to call it; this fires regardless.
//
// ACTION NEEDED: register this URL (http://139.84.226.141:3000/api/webhooks/iotec)
// with IOTEC — check your merchant dashboard or ask their support where
// webhook URLs get configured for your account, since it wasn't visible in
// their public docs. Once you get a real sample payload from them, confirm
// the field names below match (they're currently a best guess covering a
// few common variants so this doesn't silently break on a name mismatch).
app.post('/api/webhooks/iotec', async (req, res) => {
  // IOTEC's callback auth, confirmed with their support: a custom header
  // named "mbuya-wifi-auth" is sent on every callback call, with a value
  // set in the ioTec Pay portal (Wallet → Settings → Callback URLs).
  //
  // ⚠️ SECURITY NOTE: the current configured value ("1") is a placeholder
  // for testing. Anyone who guesses it can hit this endpoint and mint free
  // vouchers. Once the full flow is confirmed working end-to-end, generate
  // a long random value (e.g. `openssl rand -hex 32`), update it in BOTH
  // the ioTec Pay portal and IOTEC_WEBHOOK_SECRET in .env, then restart.
  const WEBHOOK_HEADER_NAME = process.env.IOTEC_WEBHOOK_HEADER_NAME || 'mbuya-wifi-auth';
  const expectedSecret      = process.env.IOTEC_WEBHOOK_SECRET;

  if (expectedSecret) {
    const gotSecret = req.headers[WEBHOOK_HEADER_NAME.toLowerCase()];
    if (gotSecret !== expectedSecret) {
      console.warn(`[webhook] Rejected — "${WEBHOOK_HEADER_NAME}" header was "${gotSecret}", expected "${expectedSecret}"`);
      return res.status(401).json({ error: 'unauthorized' });
    }
  } else {
    console.warn('[webhook] WARNING: IOTEC_WEBHOOK_SECRET not set in .env — accepting all callbacks unauthenticated!');
  }

  const body = req.body || {};
  console.log('[webhook] IOTEC payload:', JSON.stringify(body));

  // Ack fast so IOTEC doesn't retry-storm us on a slow response — real work
  // happens after the response is sent.
  res.json({ received: true });

  const transactionId = body.id || body.transactionId || body.paymentId || body.vendorTransactionId;
  const status = (body.status || body.transactionStatus || body.state || '').toString().toLowerCase();

  if (!transactionId) {
    console.warn('[webhook] No transaction ID found in payload — cannot process');
    return;
  }

  const isSuccess = ['success', 'successful', 'completed', 'paid'].includes(status);
  if (!isSuccess) {
    console.log(`[webhook] Transaction ${transactionId} status=${status || 'unknown'} — not a success, skipping`);
    return;
  }

  const pending = db.getPendingPayment(transactionId);
  if (!pending) {
    console.warn(`[webhook] Success for ${transactionId} but no matching pending payment on file — cannot determine package/phone. (Was /api/pay's transaction ID field name wrong?)`);
    return;
  }

  if (pending.voucher_code) {
    console.log(`[webhook] ${transactionId} already processed → voucher ${pending.voucher_code}`);
    return;
  }

  try {
    const { voucherCode, alreadyExisted } = createVoucherForPayment(pending.phone, pending.package_id, transactionId);
    console.log(`[webhook] ${alreadyExisted ? 'Matched existing' : 'Created'} voucher ${voucherCode} for transaction ${transactionId}`);
  } catch (e) {
    console.error('[webhook] Failed to create voucher:', e.message);
  }
});

// ─── Retrieve a voucher by IOTEC transaction ID ──────────────────────────────
// Lets a user who got disconnected (e.g. router reboot, MAC binding lost)
// paste the transaction ID from their mobile money payment to recover their
// voucher code and reconnect, instead of having to pay again.
app.post('/api/voucher/lookup-by-transaction', async (req, res) => {
  const transactionId = (req.body.transactionId || '').trim();
  const mac = (req.body.mac || '').trim();
  if (!transactionId)
    return res.status(400).json({ success: false, message: 'Please enter your transaction ID.' });

  const voucher = db.getVoucherByTransactionId(transactionId);

  if (!voucher)
    return res.status(404).json({ success: false, message: 'No voucher found for that transaction ID.' });

  if (voucher.disabled)
    return res.status(400).json({ success: false, message: 'This voucher has been disabled.' });

  if (voucher.remaining_seconds <= 0)
    return res.status(400).json({ success: false, message: 'This voucher has expired — all session time has been used.' });

  // Knowing the transaction ID is proof of ownership straight from the
  // customer's payment SMS — stronger than a MAC match. If the voucher is
  // currently bound to a different MAC (e.g. iPhone Private Wi-Fi Address
  // rotated), release that binding and boot the stale session off the
  // router so this device can claim it immediately.
  if (voucher.active_mac && mac && voucher.active_mac !== mac.toUpperCase()) {
    console.log(`[txn-lookup] Overriding active MAC ${voucher.active_mac} -> ${mac.toUpperCase()} for voucher ${voucher.code} (txn ${transactionId})`);
    try {
      await forceDisconnectMac(voucher.active_mac);
    } catch (e) {
      console.error('[txn-lookup] force-disconnect failed (non-fatal):', e.message);
    }
    db.clearActiveBinding(voucher.code);
  }

  res.json({
    success:           true,
    code:               voucher.code,
    masked:             voucher.code.slice(0, 4) + '••••' + voucher.code.slice(-2),
    remaining_seconds:  voucher.remaining_seconds,
  });
});

// ── Route: Poll transaction status ────────────────────────────────────────────
app.get('/api/pay/status/:id', async (req, res) => {
  try {
    const token = await getAuthToken();
    const response = await fetch(
      `https://pay.iotec.io/api/collections/status/${req.params.id}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ MBUYA WIFI server running at http://localhost:${PORT}`));
// ════════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES  —  served at /api/admin/*
// Keep these behind a password in production (or add IP restriction)
// ════════════════════════════════════════════════════════════════════════════════

// ── List all vouchers ─────────────────────────────────────────────────────────
app.get('/api/admin/vouchers', (req, res) => {
  const Database = require('better-sqlite3');
  const path     = require('path');
  const adminDb  = new Database(path.join(__dirname, 'mbuya.db'));
  const rows     = adminDb.prepare('SELECT * FROM vouchers ORDER BY created_at DESC').all();
  res.json({ vouchers: rows.map(v => {
    let remaining_seconds;
    if (v.expires_at) {
      const expiresMs = new Date(v.expires_at).getTime();
      remaining_seconds = Math.max(0, Math.floor((expiresMs - Date.now()) / 1000));
    } else {
      remaining_seconds = v.allocated_seconds;
    }
    return { ...v, disabled: v.disabled === 1, remaining_seconds };
  })});
});

// ── Generate a batch of vouchers ──────────────────────────────────────────────
app.post('/api/admin/vouchers/generate', (req, res) => {
  const { profile, qty, type, length } = req.body;
  const PROFILE_SECONDS = { 'mini-day': 14400, '1day': 86400, '1week': 604800, '1month': 2592000 };
  if (!PROFILE_SECONDS[profile]) return res.status(400).json({ success: false, message: 'Invalid profile.' });

  const count  = Math.min(parseInt(qty) || 1, 500);
  const secs   = PROFILE_SECONDS[profile];
  const codeLen = Math.min(Math.max(parseInt(length) || 8, 6), 16);

  // Character sets — no ambiguous chars (0/O, 1/I/L) for readability
  const NUMERIC      = '23456789';
  const ALPHANUMERIC = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const chars = type === 'numeric' ? NUMERIC : ALPHANUMERIC;

  function makeCode() {
    let code = '';
    for (let i = 0; i < codeLen; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  const Database = require('better-sqlite3');
  const path     = require('path');
  const adminDb  = new Database(path.join(__dirname, 'mbuya.db'));
  const insert   = adminDb.prepare(
    'INSERT OR IGNORE INTO vouchers (code, profile, allocated_seconds, used_seconds, disabled) VALUES (?, ?, ?, 0, 0)'
  );

  const generated = [];
  const insertMany = adminDb.transaction(() => {
    let attempts = 0;
    while (generated.length < count && attempts < count * 5) {
      attempts++;
      const code = makeCode();
      const result = insert.run(code, profile, secs);
      if (result.changes > 0) generated.push(code); // only add if not duplicate
    }
  });
  insertMany();

  res.json({ success: true, count: generated.length, codes: generated });
});

//______________________seek voucher login code____________________________
function secondsToDuration(seconds) {
  if (!seconds || seconds <= 0) return '0s';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  let parts = [];
  if (d) parts.push(d + 'd');
  if (h) parts.push(h + 'h');
  if (m) parts.push(m + 'm');
  if (s) parts.push(s + 's');
  return parts.join('') || '0s';
}
app.get('/api/session/info', async (req, res) => {
  const user = req.query.user;
  if (!user) return res.status(400).json({ error: 'Missing user' });

  try {
    const active = await mikrotikFetch('/ip/hotspot/active');
    const session = active.find(s => s.user === user);
    if (session) {
      // `user` is whatever MikroTik authenticated the live session with —
      // that's the voucher code for a manual/mobile-money login, but the
      // device's MAC address for an automatic mac-binding reconnect.
      // Try both so the real voucher (and its wall-clock remaining time)
      // is found either way.
      const voucher = db.getVoucher(user) || db.getVoucherByMac(user);
      const remaining = voucher ? voucher.remaining_seconds : 0;
      return res.json({
        reachable: true,
        active: true,
        code: voucher ? voucher.code : user,
        uptime: session.uptime || '0s',
        remaining: secondsToDuration(remaining),
      });
    } else {
      // We successfully reached the router and confirmed this user is not
      // in its active-session list — this is a real, confirmed disconnect.
      return res.json({ reachable: true, active: false });
    }
  } catch (err) {
    console.error('Session info error:', err.message);
    // Router unreachable/slow — this is NOT a confirmed disconnect. Say so
    // explicitly so the frontend doesn't treat a network hiccup as a logout.
    res.status(503).json({ reachable: false, error: err.message });
  }
});
app.post('/api/session/logout', async (req, res) => {
  const { user } = req.body;
  if (!user) return res.status(400).json({ error: 'Missing user' });

  try {
    const active  = await mikrotikFetch('/ip/hotspot/active');
    const session = active.find(s => s.user === user);
    if (session && session['.id']) {
      await mikrotikFetch('/ip/hotspot/active/remove', {
        method: 'POST',
        body:   JSON.stringify({ '.id': session['.id'] }),
      });
    }
    res.json({ success: true, reachable: true });
  } catch (err) {
    console.error('Logout error:', err.message);
    // Router unreachable — we can't confirm the session was actually
    // removed, so don't report success.
    res.status(503).json({ success: false, reachable: false, error: err.message });
  }
});

// ── Mark a batch of vouchers as printed ───────────────────────────────────────
app.post('/api/admin/vouchers/mark-printed', (req, res) => {
  const codes = req.body.codes;
  if (!Array.isArray(codes) || !codes.length)
    return res.status(400).json({ success: false, message: 'No codes provided.' });
  try {
    db.markPrinted(codes);
    res.json({ success: true, count: codes.length });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Disable a voucher (kicks active session too) ──────────────────────────────
app.post('/api/admin/vouchers/disable', async (req, res) => {
  const { code } = req.body;
  const Database = require('better-sqlite3');
  const path     = require('path');
  const adminDb  = new Database(path.join(__dirname, 'mbuya.db'));
  adminDb.prepare('UPDATE vouchers SET disabled = 1 WHERE code = ?').run(code);

  try {
    const active  = await mikrotikFetch('/ip/hotspot/active');
    const session = active.find(s => s.user === code);
    if (session) {
      await mikrotikFetch('/ip/hotspot/active/remove', {
        method: 'POST',
        body:   JSON.stringify({ '.id': session['.id'] }),
      });
    }
  } catch (e) { /* non-fatal */ }

  res.json({ success: true });
});

// ── Live sessions (proxied from MikroTik) ─────────────────────────────────────
app.get('/api/admin/sessions', async (req, res) => {
  try {
    const active = await mikrotikFetch('/ip/hotspot/active');
    res.json({ sessions: active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ── Metrics endpoint ──────────────────────────────────────────────────────────
const METRICS_PIN = process.env.METRICS_PIN;

// Used only by the admin UI to unlock the summary cards (net/gross totals).
// The underlying metrics data below is NOT gated by this — tabs, calendar,
// and per-transaction detail stay open; only the cumulative summary cards
// are meant to be hidden from casual viewing.
app.get('/api/admin/verify-pin', (req, res) => {
  res.json({ ok: req.query.pin === METRICS_PIN });
});

app.get('/api/admin/metrics', (req, res) => {
  const period  = req.query.period || 'month';
  const data    = db.getMetrics(period);

  // Also return individual events for transaction-level filtering
  const cutoffs = { day: 1, week: 7, month: 30, year: 365 };
  const days    = cutoffs[period] || 30;
  const Database = require('better-sqlite3');
  const path     = require('path');
  const adminDb  = new Database(path.join(__dirname, 'mbuya.db'));
  const events   = adminDb.prepare(`
    SELECT id, code, profile, source, gross_ugx, net_ugx,
           strftime('%Y-%m-%d %H:%M', recorded_at) AS recorded_at
    FROM revenue_events
    WHERE recorded_at >= datetime('now', '-${days} days')
    ORDER BY recorded_at DESC
    LIMIT 1000
  `).all();

  res.json({ ...data, events });
});