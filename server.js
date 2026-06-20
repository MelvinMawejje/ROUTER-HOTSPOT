// server.js
const express = require('express');
const db      = require('./db');
const cors    = require('cors');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));  // serves your index.html, app.js, style.css

const IOTEC_CLIENT_ID     = 'pay-019e9c6e-0cda-775d-b88e-40687853599c';
const IOTEC_CLIENT_SECRET = 'IO-NJs73yg0NVd6vMSOFaLn3a2NPDeXYUmnD';
const IOTEC_WALLET_ID     = '019e9c6e-0cfe-76b6-87b0-d94d7b547626';

// ─── MikroTik router credentials ──────────────────────────────
const ROUTER_HOST = '192.168.88.1';
const ROUTER_USER = 'melvin';
const ROUTER_PASS = 'admin';

// ─── Helper: fetch from MikroTik REST API ──────────────────────
async function mikrotikFetch(endpoint, options = {}) {
  const url = `http://${ROUTER_HOST}/rest${endpoint}`;
  const auth = 'Basic ' + Buffer.from(`${ROUTER_USER}:${ROUTER_PASS}`).toString('base64');
  const resp = await fetch(url, {
    ...options,
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
  return resp.json();
}

// ─── Helper: get client MAC address from router's DHCP leases ──
async function getMacFromIp(clientIp) {
  const leases = await mikrotikFetch('/ip/dhcp-server/lease');
  const lease = leases.find(l => l['active-address'] === clientIp && l.status === 'bound');
  return lease ? lease['mac-address'] : null;
}

// ─── Voucher redemption endpoint ─────────────────────────────────────────────
// Validates against our SQLite database (covers both admin-generated vouchers
// and payment-created ones). RADIUS then handles the actual MikroTik auth.
app.post('/api/voucher/redeem', (req, res) => {
  const code = (req.body.voucherCode || '').trim().toUpperCase();
  if (code.length < 2)
    return res.status(400).json({ success: false, message: 'Please enter a valid voucher code.' });

  const voucher = db.getVoucher(code);

  if (!voucher)
    return res.status(400).json({ success: false, message: 'Invalid voucher code. Please check and try again.' });

  if (voucher.disabled)
    return res.status(400).json({ success: false, message: 'This voucher has been disabled.' });

  if (voucher.remaining_seconds <= 0)
    return res.status(400).json({ success: false, message: 'This voucher has expired — all session time has been used.' });

  // Valid — return the MikroTik hotspot login action.
  // The browser POSTs directly to MikroTik; RADIUS supplies the Session-Timeout.
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
        currency:                   'ITX',
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
    res.json(data);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error.' });
  }
});

// ─── Auto‑connect after payment ──────────────────────────────────────────────
app.post('/api/pay/connect', async (req, res) => {
  const { phone, packageId } = req.body;
  if (!phone || !packageId)
    return res.status(400).json({ success: false, message: 'Missing phone or package ID.' });

  try {
    const voucherCode = `PAY-${Date.now()}-${Math.random().toString(36).substring(2,6).toUpperCase()}`;

    // 1. Create hotspot user in MikroTik (PUT = create record via REST API)
    await mikrotikFetch('/ip/hotspot/user', {
      method: 'PUT',
      body: JSON.stringify({ name: voucherCode, password: '', profile: packageId, disabled: 'false' }),
    });

    // 2. Register in our database so RADIUS can track cumulative session time
    db.createVoucher(voucherCode, packageId);

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

app.listen(3000, () => console.log('✅ MBUYA WIFI server running at http://localhost:3000'));
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
  res.json({ vouchers: rows.map(v => ({
    ...v,
    disabled:          v.disabled === 1,
    remaining_seconds: Math.max(0, v.allocated_seconds - v.used_seconds),
  }))});
});

// ── Generate a batch of vouchers ──────────────────────────────────────────────
app.post('/api/admin/vouchers/generate', (req, res) => {
  const { profile, qty, type, length } = req.body;
  const PROFILE_SECONDS = { '1day': 86400, '1week': 604800, '1month': 2592000 };
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
    const active  = await mikrotikFetch('/ip/hotspot/active');
    const session = active.find(s => s.user === user);
    if (session) {
      const voucher   = db.getVoucher(user);
      const remaining = voucher ? voucher.remaining_seconds : 0;
      return res.json({
        active:    true,
        uptime:    session.uptime || '0s',
        remaining: secondsToDuration(remaining),
        expiresAt: voucher && voucher.expires_at ? voucher.expires_at : null,
      });
    } else {
      return res.json({ active: false });
    }
  } catch (err) {
    console.error('Session info error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/api/session/logout', async (req, res) => {
  const { user } = req.body;
  if (!user) return res.status(400).json({ error: 'Missing user' });

  try {
    const active  = await mikrotikFetch('/ip/hotspot/active');
    const session = active.find(s => s.user === user);
    if (session && session['.id']) {
      // Use /remove command — avoids the encodeURIComponent/* issue with DELETE
      await mikrotikFetch('/ip/hotspot/active/remove', {
        method: 'POST',
        body:   JSON.stringify({ '.id': session['.id'] }),
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Disable a voucher (kicks active session too) ──────────────────────────────
app.post('/api/admin/vouchers/disable', async (req, res) => {
  const { code } = req.body;
  const Database = require('better-sqlite3');
  const path     = require('path');
  const adminDb  = new Database(path.join(__dirname, 'mbuya.db'));
  adminDb.prepare('UPDATE vouchers SET disabled = 1 WHERE code = ?').run(code);

  // Also remove from MikroTik active sessions
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