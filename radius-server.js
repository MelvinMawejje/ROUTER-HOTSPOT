// radius-server.js
// Handles RADIUS Auth (1812) and Accounting (1813) for MikroTik hotspot.
// Creates/updates a local MAC user on first login for seamless re‑authentication.

require('dotenv').config();
const dgram  = require('dgram');
const radius = require('radius');
const db     = require('./db');

const ROUTER_HOST = process.env.ROUTER_HOST;
const ROUTER_USER = process.env.ROUTER_USER;
const ROUTER_PASS = process.env.ROUTER_PASS;

const RADIUS_SECRET    = process.env.RADIUS_SECRET;
const AUTH_PORT        = 1812;
const ACCT_PORT        = 1813;
const IDLE_TIMEOUT_SEC = 43200;

const REQUIRED_VARS = ['ROUTER_HOST', 'ROUTER_USER', 'ROUTER_PASS', 'RADIUS_SECRET'];
const missing = REQUIRED_VARS.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing required .env variables: ${missing.join(', ')}`);
  console.error('   Copy .env.example to .env and fill in real values.');
  process.exit(1);
}

// Matches a MAC address in either colon/hyphen or bare-hex form — used to
// detect when RouterOS has authenticated a device by its own MAC-auth
// mechanism instead of via our login page (where User-Name is the voucher
// code entered by the person).
const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$|^[0-9A-Fa-f]{12}$/;

// NOTE: We no longer create local MikroTik hotspot users keyed by MAC.
// MAC-based reconnection is already handled entirely through RADIUS
// (see getVoucherByMac / isMacAuth below) via Session-Timeout on each
// Access-Accept. A local user with the same MAC caused RouterOS to
// hijack active RADIUS sessions and re-authenticate through its own
// native login page instead of the custom one.

// ── Helper: disable hotspot user (when voucher expires) ─────────
async function disableHotspotUser(mac) {
  try {
    const baseUrl = `http://${ROUTER_HOST}/rest/ip/hotspot/user`;
    const auth = 'Basic ' + Buffer.from(`${ROUTER_USER}:${ROUTER_PASS}`).toString('base64');
    const headers = { 'Authorization': auth, 'Content-Type': 'application/json' };
    const listResp = await fetch(baseUrl, { headers });
    if (!listResp.ok) return;
    const users = await listResp.json();
    const user = users.find(u => u.name === mac);
    if (!user) return;
    await fetch(`${baseUrl}/${user['.id']}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ disabled: 'true' }),
    });
    console.log(`[REST] Disabled hotspot user ${mac}`);
  } catch (e) {
    console.error('[REST] Failed to disable user:', e.message);
  }
}

// ── Helper: is this MAC currently a live session on the router? ─────────
// Returns true/false when we got a real answer, or null when we couldn't
// tell (router unreachable/timeout) — callers should fail safe on null.
async function isMacActiveOnRouter(mac) {
  if (!mac) return null; // unknown
  try {
    const url = `http://${ROUTER_HOST}/rest/ip/hotspot/active`;
    const auth = 'Basic ' + Buffer.from(`${ROUTER_USER}:${ROUTER_PASS}`).toString('base64');
    const resp = await fetch(url, { headers: { Authorization: auth } });
    if (!resp.ok) return null; // router unreachable — unknown
    const active = await resp.json();
    return active.some(a => (a['mac-address'] || '').toUpperCase() === mac.toUpperCase());
  } catch (e) {
    console.error('[REST] Failed to check active sessions:', e.message);
    return null; // unknown
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// Authentication server (UDP 1812)
// ════════════════════════════════════════════════════════════════════════════════
const authServer = dgram.createSocket('udp4');

authServer.on('message', async (msg, rinfo) => {
  let packet;
  try {
    packet = radius.decode({ packet: msg, secret: RADIUS_SECRET });
  } catch (e) {
    console.error('[AUTH] Decode error:', e.message);
    return;
  }
  if (packet.code !== 'Access-Request') return;

  const username = packet.attributes['User-Name'];
  const mac = packet.attributes['Calling-Station-Id'] || null;
  console.log(`[AUTH] Request → ${username} (MAC: ${mac || 'none'})`);

  const isMacAuth = MAC_RE.test(username);

  let voucher;
  if (isMacAuth) {
    voucher = db.getVoucherByMac(username);
    if (voucher) {
      console.log(`[AUTH] MAC lookup → ${voucher.code} (${Math.floor(voucher.remaining_seconds/60)}m remaining)`);
    } else {
      console.log(`[AUTH] MAC ${username} has no binding — will show login page`);
    }
  } else {
    voucher = db.getVoucher(username);
  }

  if (!voucher || voucher.disabled || voucher.remaining_seconds <= 0) {
    const reason = !voucher ? 'not found' : voucher.disabled ? 'disabled' : 'expired';
    console.log(`[AUTH] REJECTED: ${username} — ${reason}`);
    if (voucher && voucher.remaining_seconds <= 0 && mac) {
      disableHotspotUser(mac).catch(e => console.error(e));
    }
    const resp = radius.encode_response({
      packet:  packet,
      code:    'Access-Reject',
      secret:  RADIUS_SECRET,
      attributes: [['Reply-Message',
        voucher && voucher.remaining_seconds <= 0
          ? 'Voucher expired. Please purchase a new one.'
          : 'Invalid voucher code.'
      ]]
    });
    authServer.send(resp, rinfo.port, rinfo.address);
    return;
  }

  // ── Enforce one active device per voucher ─────────────────────────────
  // If this voucher is already connected on a different MAC, don't reject
  // outright — first check whether that old MAC is actually still a live
  // session on the router. iOS Private Wi-Fi Address rotation means the
  // rightful owner can show up as a "new" MAC without ever cleanly
  // disconnecting the old one, so a stale active_mac shouldn't lock them
  // out forever. Only reject when the old MAC is confirmed still live
  // (real second device) or when we can't verify (fail safe).
  // (When isMacAuth is true, the voucher was found via its own MAC binding,
  // so it can only ever match the device that's already using it.)
  if (!isMacAuth && db.isVoucherActiveElsewhere(voucher.code, mac)) {
    const stillLive = await isMacActiveOnRouter(voucher.active_mac);

    if (stillLive === false) {
      // Old MAC is confirmed gone (rotated/disconnected) — release it
      console.log(`[AUTH] Stale binding: ${voucher.active_mac} no longer active on router — releasing ${voucher.code} for new MAC ${mac}`);
      db.clearActiveBinding(voucher.code);
      // falls through to Access-Accept below
    } else {
      // stillLive === true, or null (router unreachable) — fail safe, reject
      console.log(`[AUTH] REJECTED: ${username} — voucher already in use on another device (active MAC: ${voucher.active_mac})`);
      const resp = radius.encode_response({
        packet, code: 'Access-Reject', secret: RADIUS_SECRET,
        attributes: [['Reply-Message', 'This voucher is already in use on another device. Please disconnect it first.']]
      });
      authServer.send(resp, rinfo.port, rinfo.address);
      return;
    }
  }

  const mins = Math.floor(voucher.remaining_seconds / 60);
  console.log(`[AUTH] ACCEPT  → ${username} (${mins}m remaining)`);

  const resp = radius.encode_response({
    packet:  packet,
    code:    'Access-Accept',
    secret:  RADIUS_SECRET,
    attributes: [
      ['Session-Timeout', voucher.remaining_seconds],
      ['Reply-Message',   `Welcome! You have ${mins} minutes remaining.`],
    ]
  });
  authServer.send(resp, rinfo.port, rinfo.address);
});

authServer.on('error', (err) => console.error('[AUTH] Server error:', err));
authServer.bind(AUTH_PORT, '0.0.0.0', () =>
  console.log(`✅ RADIUS Auth server listening on UDP ${AUTH_PORT}`));

// ════════════════════════════════════════════════════════════════════════════════
// Accounting server (UDP 1813)
// ════════════════════════════════════════════════════════════════════════════════
const acctServer = dgram.createSocket('udp4');

acctServer.on('message', (msg, rinfo) => {
  let packet;
  try {
    packet = radius.decode({ packet: msg, secret: RADIUS_SECRET });
  } catch (e) {
    console.error('[ACCT] Decode error:', e.message);
    return;
  }
  if (packet.code !== 'Accounting-Request') return;

  const statusType  = packet.attributes['Acct-Status-Type'] || 'Unknown';
  const username    = packet.attributes['User-Name'];
  const sessionId   = packet.attributes['Acct-Session-Id'];
  const sessionSecs = packet.attributes['Acct-Session-Time'] || 0;
  const clientMac   = packet.attributes['Calling-Station-Id'] || null;

  console.log(`[ACCT] ${statusType.padEnd(16)} → ${username} (${sessionSecs}s)${clientMac ? ' MAC:'+clientMac : ''}`);

  // Respond immediately — don't make the router wait on anything else
  const resp = radius.encode_response({
    packet:  packet,
    code:    'Accounting-Response',
    secret:  RADIUS_SECRET,
    attributes: []
  });
  acctServer.send(resp, rinfo.port, rinfo.address);

  // Do the DB bookkeeping afterward, out of band
  (async () => {
    try {
      // If RouterOS authenticated this session by MAC (its own mac-auth
      // mechanism, not our login page), User-Name here is the MAC address
      // itself, not the voucher code. Resolve it back to the real code —
      // otherwise startSession() looks up a voucher row that doesn't exist
      // (silently no-op, leaving active_mac stale) and bindMac() overwrites
      // the correct mac→code binding with mac→mac, breaking status.html and
      // any future MAC lookups for this device.
      let code = username;
      if (MAC_RE.test(username)) {
        const voucherByMac = db.getVoucherByMac(username);
        if (voucherByMac) {
          code = voucherByMac.code;
        } else {
          console.warn(`[ACCT] MAC ${username} has no voucher binding — skipping bookkeeping`);
        }
      }

      if (statusType === 'Start') {
        db.startSession(sessionId, code, clientMac);
        if (clientMac) {
          db.bindMac(clientMac, code);
        }
      } else if (statusType === 'Interim-Update') {
        db.updateSession(sessionId, sessionSecs);
      } else if (statusType === 'Stop') {
        db.stopSession(sessionId, sessionSecs);
      }
    } catch (e) {
      console.error('[ACCT] Async post-processing error:', e.message);
    }
  })();
});

acctServer.on('error', (err) => console.error('[ACCT] Server error:', err));
acctServer.bind(ACCT_PORT, '0.0.0.0', () =>
  console.log(`✅ RADIUS Acct server listening on UDP ${ACCT_PORT}`));