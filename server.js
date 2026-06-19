// server.js
const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const IOTEC_CLIENT_ID     = 'pay-019e9c6e-0cda-775d-b88e-40687853599c';
const IOTEC_CLIENT_SECRET = 'IO-NJs73yg0NVd6vMSOFaLn3a2NPDeXYUmnD';
const IOTEC_WALLET_ID     = '019e9c6e-0cfe-76b6-87b0-d94d7b547626';

const ROUTER_HOST = '192.168.88.1';
const ROUTER_USER = 'melvin';
const ROUTER_PASS = 'admin';

// ─── MikroTik REST helper ─────────────────────────────────────────────────────
async function mikrotikFetch(endpoint, options = {}) {
  const url  = `http://${ROUTER_HOST}/rest${endpoint}`;
  const auth = 'Basic ' + Buffer.from(`${ROUTER_USER}:${ROUTER_PASS}`).toString('base64');
  const resp = await fetch(url, {
    ...options,
    headers: { ...options.headers, 'Authorization': auth, 'Content-Type': 'application/json' },
  });
  if (!resp.ok) {
    const ct   = resp.headers.get('content-type') || '';
    const body = ct.includes('text/html')
      ? `MikroTik REST API not reachable (HTML ${resp.status}). Enable "www" in Winbox: IP → Services → www.`
      : await resp.text();
    throw new Error(`MikroTik error ${resp.status}: ${body}`);
  }
  return resp.json();
}

// ─── 1. Validate voucher (username only) ─────────────────────────────────────
// Returns loginAction so the browser can POST directly to MikroTik's hotspot.
// MikroTik handles the actual session — no password needed for voucher-only users.
app.post('/api/voucher/redeem', async (req, res) => {
  const code = (req.body.voucherCode || '').trim();
  if (code.length < 2)
    return res.status(400).json({ success: false, message: 'Please enter a valid voucher code.' });

  try {
    const users = await mikrotikFetch('/ip/hotspot/user');
    const user  = users.find(u => u.name === code);

    if (!user)
      return res.status(400).json({ success: false, message: 'Invalid voucher code. Please check and try again.' });

    if (user.disabled === 'true')
      return res.status(400).json({ success: false, message: 'This voucher has been disabled.' });

    // Check if the voucher has already been fully used (bytes/time limit hit)
    // MikroTik marks exhausted users; we surface a clear message
    if (user['limit-uptime'] && user['uptime'] && user['uptime'] >= user['limit-uptime'])
      return res.status(400).json({ success: false, message: 'This voucher has expired — session time fully used.' });

    // Return the MikroTik hotspot login action endpoint.
    // The browser will POST username + empty password directly to MikroTik,
    // which starts the session and redirects to our custom dashboard.
    res.json({
      success:     true,
      code,
      loginAction: `http://${ROUTER_HOST}/login`,
    });
  } catch (err) {
    console.error('Voucher error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── 2. Session info (for dashboard polling) ─────────────────────────────────
app.get('/api/session/info', async (req, res) => {
  const { user } = req.query;
  if (!user) return res.status(400).json({ error: 'Missing user param' });

  try {
    const active  = await mikrotikFetch('/ip/hotspot/active');
    const session = active.find(s => s.user === user);

    if (!session)
      return res.json({ active: false });

    res.json({
      active:    true,
      uptime:    session.uptime            || '0s',
      remaining: session['session-time-left'] || 'unlimited',
      bytesIn:   session['bytes-in']       || '0',
      bytesOut:  session['bytes-out']      || '0',
      address:   session.address           || '',
      id:        session['.id'],
    });
  } catch (err) {
    console.error('Session info error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── 3. Logout ────────────────────────────────────────────────────────────────
app.post('/api/session/logout', async (req, res) => {
  const { user } = req.body;
  if (!user) return res.status(400).json({ success: false, message: 'Missing user.' });

  try {
    const active  = await mikrotikFetch('/ip/hotspot/active');
    const session = active.find(s => s.user === user);

    if (!session)
      return res.json({ success: true, message: 'Already logged out.' });

    await mikrotikFetch(`/ip/hotspot/active/${encodeURIComponent(session['.id'])}`, { method: 'DELETE' });
    res.json({ success: true });
  } catch (err) {
    console.error('Logout error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── 4. iotec auth token ─────────────────────────────────────────────────────
async function getAuthToken() {
  try {
    const resp = await fetch('https://id.iotec.io/connect/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        client_id: IOTEC_CLIENT_ID, client_secret: IOTEC_CLIENT_SECRET, grant_type: 'client_credentials'
      })
    });
    if (!resp.ok) throw new Error(`Auth ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    if (!data.access_token) throw new Error('No access_token in response');
    return data.access_token;
  } catch (err) {
    console.error('getAuthToken failed:', err.message, err.cause || '');
    throw err;
  }
}

// ─── 5. Initiate mobile money payment ────────────────────────────────────────
app.post('/api/pay', async (req, res) => {
  try {
    const { phone, amount, packageId } = req.body;
    if (!phone || !amount || !packageId)
      return res.status(400).json({ error: 'Missing phone, amount, or packageId' });

    const token = await getAuthToken();

    let response;
    try {
      response = await fetch('https://pay.iotec.io/api/collections/collect', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          category: 'MobileMoney', currency: 'ITX', walletId: IOTEC_WALLET_ID,
          externalId: 'MBUYA-' + Date.now(), payer: phone,
          payerName: 'MBUYA WIFI Customer', payerNote: `MBUYA WIFI – ${packageId} package`,
          amount, payeeNote: `Package: ${packageId}`,
          channel: null, transactionChargesCategory: 'ChargeWallet', redirectUrl: null
        })
      });
    } catch (fetchErr) {
      console.error('Collect fetch failed:', fetchErr.message, fetchErr.cause || '');
      return res.status(502).json({ error: `Cannot reach payment gateway: ${fetchErr.cause?.code || fetchErr.message}` });
    }

    const ct = response.headers.get('content-type');
    if (!ct || !ct.includes('application/json')) {
      const text = await response.text();
      console.error('Non-JSON from iotec:', text);
      return res.status(500).json({ error: 'Unexpected response from payment gateway.' });
    }
    const data = await response.json();
    if (!response.ok)
      return res.status(response.status).json({ error: data.message || data.title || 'Payment initiation failed.' });

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Internal server error.' });
  }
});

// ─── 6. Create hotspot user after successful payment ─────────────────────────
// Uses PUT (correct REST verb for creating a record) and returns a loginAction
// so the browser can start the session directly with MikroTik.
app.post('/api/pay/connect', async (req, res) => {
  const { phone, packageId } = req.body;
  if (!phone || !packageId)
    return res.status(400).json({ success: false, message: 'Missing phone or package ID.' });

  try {
    const voucherCode = `PAY-${Date.now()}-${Math.random().toString(36).substring(2,6).toUpperCase()}`;

    await mikrotikFetch('/ip/hotspot/user', {
      method: 'PUT',
      body: JSON.stringify({ name: voucherCode, password: '', profile: packageId, disabled: 'false' }),
    });

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

// ─── 7. Poll payment transaction status ──────────────────────────────────────
app.get('/api/pay/status/:id', async (req, res) => {
  try {
    const token    = await getAuthToken();
    const response = await fetch(`https://pay.iotec.io/api/collections/status/${req.params.id}`,
      { headers: { 'Authorization': `Bearer ${token}` } });
    res.json(await response.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('✅ MBUYA WIFI server running at http://localhost:3000'));