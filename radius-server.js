// radius-server.js
// Handles RADIUS Auth (1812) and Accounting (1813) for MikroTik hotspot.
// Creates/updates a local MAC user on first login for seamless re‑authentication.

const dgram  = require('dgram');
const radius = require('radius');
const db     = require('./db');

const ROUTER_HOST = '10.0.0.2';
const ROUTER_USER = 'melvin';
const ROUTER_PASS = 'admin';

const RADIUS_SECRET    = 'mbuyawifi-secret';
const AUTH_PORT        = 1812;
const ACCT_PORT        = 1813;
const IDLE_TIMEOUT_SEC = 300;

// ── Helper: create or update hotspot user ──────────────────────
async function createHotspotUser(mac, code, remainingSeconds) {
  if (remainingSeconds <= 0) {
    console.log(`[REST] Skipping user ${mac} – remaining time 0`);
    return;
  }
  const baseUrl = `http://${ROUTER_HOST}/rest/ip/hotspot/user`;
  const auth = 'Basic ' + Buffer.from(`${ROUTER_USER}:${ROUTER_PASS}`).toString('base64');
  const headers = { 'Authorization': auth, 'Content-Type': 'application/json' };

  try {
    // 1. List existing users
    const listResp = await fetch(baseUrl, { headers });
    if (!listResp.ok) {
      console.error(`[REST] Failed to list users: ${listResp.status}`);
      return;
    }
    const users = await listResp.json();
    const existing = users.find(u => u.name === mac);

    const body = {
      name: mac,
      password: '',
      profile: 'default',                     // Change to your hotspot profile if needed
      'limit-uptime': `${Math.floor(remainingSeconds)}s`,
      disabled: false,
    };

    if (existing) {
      // Update existing user with PATCH
      const updateUrl = `${baseUrl}/${existing['.id']}`;
      const resp = await fetch(updateUrl, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text();
        console.error(`[REST] Failed to update user ${mac}: ${resp.status} - ${text}`);
      } else {
        console.log(`[REST] Updated hotspot user for MAC ${mac} (limit: ${remainingSeconds}s)`);
      }
    } else {
      // Create new user with PUT
      const resp = await fetch(baseUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text();
        console.error(`[REST] Failed to create user ${mac}: ${resp.status} - ${text}`);
      } else {
        console.log(`[REST] Created hotspot user for MAC ${mac} (limit: ${remainingSeconds}s)`);
      }
    }
  } catch (e) {
    console.error('[REST] Error creating/updating user:', e.message);
  }
}

// ── Helper: remove a stray host entry (MAC never bound to a voucher) ──
// Called when a device tries MAC auto-login and we find no binding at all.
// RouterOS will simply recreate this host entry the moment the device
// sends more traffic, so removing it early is harmless — it just keeps
// the Hosts list from filling up with unauthenticated devices.
async function removeHostByMac(mac) {
  try {
    const baseUrl = `http://${ROUTER_HOST}/rest/ip/hotspot/host`;
    const auth = 'Basic ' + Buffer.from(`${ROUTER_USER}:${ROUTER_PASS}`).toString('base64');
    const headers = { 'Authorization': auth, 'Content-Type': 'application/json' };
    const listResp = await fetch(baseUrl, { headers });
    if (!listResp.ok) return;
    const hosts = await listResp.json();
    const host = hosts.find(h => (h['mac-address'] || '').toUpperCase() === mac.toUpperCase());
    if (!host) return;
    await fetch(`${baseUrl}/${host['.id']}`, { method: 'DELETE', headers });
    console.log(`[REST] Removed stale host entry for unbound MAC ${mac}`);
  } catch (e) {
    console.error('[REST] Failed to remove host:', e.message);
  }
}

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

// ── Helper: parse RouterOS duration strings like "5m30s", "1h2m3s", "45s" ──
function parseRouterUptime(str) {
  if (!str) return 0;
  const re = /(\d+)([wdhms])/g;
  const mult = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  let total = 0, match;
  while ((match = re.exec(str)) !== null) {
    total += parseInt(match[1], 10) * mult[match[2]];
  }
  return total;
}

// ── Periodic cleanup: remove stray /ip/hotspot/host entries ────────────────
// A "host" entry is created for ANY device that associates + gets an IP,
// whether or not it ever successfully logs in. Failed/abandoned login
// attempts (e.g. a MAC with no voucher binding) pile up here and are easy
// to mistake for real accounts — they are NOT the same as /ip/hotspot/user.
// This job removes host entries that are (a) not currently authorized/logged
// in, and (b) have been idle past a threshold, so the Hosts list stays clean.
//
// NOTE: verify field names against your RouterOS version — fetch
// http://<router>/rest/ip/hotspot/host once manually and confirm the
// "authorized" and "idle-time" keys match what's used below (they've
// changed across RouterOS 6 vs 7 REST responses in some builds).
const HOST_CLEANUP_INTERVAL_MS = 3 * 60 * 1000; // every 3 minutes
const HOST_IDLE_THRESHOLD_SEC  = 2 * 60;         // idle > 2 min and unauthorized → remove

async function cleanupUnboundHosts() {
  try {
    const baseUrl = `http://${ROUTER_HOST}/rest/ip/hotspot/host`;
    const auth = 'Basic ' + Buffer.from(`${ROUTER_USER}:${ROUTER_PASS}`).toString('base64');
    const headers = { 'Authorization': auth, 'Content-Type': 'application/json' };

    const resp = await fetch(baseUrl, { headers });
    if (!resp.ok) {
      console.error(`[CLEANUP] Failed to list hosts: ${resp.status}`);
      return;
    }
    const hosts = await resp.json();

    for (const host of hosts) {
      const mac = host['mac-address'];
      if (!mac) continue;

      const authorized = host['authorized'] === 'true' || host['authorized'] === true;
      const bypassed    = host['bypassed'] === 'true' || host['bypassed'] === true;
      if (authorized || bypassed) continue; // real logged-in session — leave alone

      const idleSec = parseRouterUptime(host['idle-time']);
      if (idleSec < HOST_IDLE_THRESHOLD_SEC) continue; // give it a moment, might still be logging in

      // Only remove if we genuinely have no voucher for this MAC —
      // never touch a host tied to a real (even if expired) binding here;
      // expiry is handled separately by disableHotspotUser().
      const voucher = db.getVoucherByMac(mac);
      if (voucher) continue;

      const delResp = await fetch(`${baseUrl}/${host['.id']}`, { method: 'DELETE', headers });
      if (delResp.ok) {
        console.log(`[CLEANUP] Removed stray host entry ${mac} (no voucher binding, idle ${idleSec}s)`);
      } else {
        console.error(`[CLEANUP] Failed to remove host ${mac}: ${delResp.status}`);
      }
    }
  } catch (e) {
    console.error('[CLEANUP] Error:', e.message);
  }
}

setInterval(() => cleanupUnboundHosts().catch(e => console.error('[CLEANUP]', e.message)), HOST_CLEANUP_INTERVAL_MS);

// ════════════════════════════════════════════════════════════════════════════════
// Authentication server (UDP 1812)
// ════════════════════════════════════════════════════════════════════════════════
const authServer = dgram.createSocket('udp4');

authServer.on('message', (msg, rinfo) => {
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

  const MAC_RE = /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$|^[0-9A-Fa-f]{12}$/;
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
    // MAC auto-login attempt with NO binding at all (never activated a voucher) —
    // clean up the stray host entry so it doesn't clutter the Hosts list.
    // We do NOT do this for a human typing a wrong/expired code on the login page.
    if (isMacAuth && !voucher && mac) {
      removeHostByMac(mac).catch(e => console.error(e));
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

  const mins = Math.floor(voucher.remaining_seconds / 60);
  console.log(`[AUTH] ACCEPT  → ${username} (${mins}m remaining)`);

  const resp = radius.encode_response({
    packet:  packet,
    code:    'Access-Accept',
    secret:  RADIUS_SECRET,
    attributes: [
      ['Session-Timeout', voucher.remaining_seconds],
      ['Idle-Timeout',    IDLE_TIMEOUT_SEC],
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

  // ── Respond to the router immediately ──────────────────────────
  // The router's RADIUS client times out (and retries) if it doesn't hear
  // back quickly. Our follow-up work below calls the router's OWN REST API,
  // which can be slow — so we must not make the router wait on that before
  // acking the accounting packet. Sending late = "no response" + duplicate
  // retried requests (you'll see the same session processed 2-3x).
  const resp = radius.encode_response({
    packet:  packet,
    code:    'Accounting-Response',
    secret:  RADIUS_SECRET,
    attributes: []
  });
  acctServer.send(resp, rinfo.port, rinfo.address);

  // ── Do the slower DB + REST work afterward, out of band ────────
  (async () => {
    try {
      if (statusType === 'Start') {
        db.startSession(sessionId, username);
        if (clientMac) {
          db.bindMac(clientMac, username);
          const voucher = db.getVoucher(username);
          if (voucher) {
            await createHotspotUser(clientMac, username, voucher.remaining_seconds);
          }
        }
      } else if (statusType === 'Interim-Update') {
        db.updateSession(sessionId, sessionSecs);
      } else if (statusType === 'Stop') {
        db.stopSession(sessionId, sessionSecs);
        // Re-sync the hotspot user's limit-uptime so seamless reconnect works
        if (clientMac) {
          const voucher = db.getVoucher(username);
          if (voucher && voucher.remaining_seconds > 0) {
            await createHotspotUser(clientMac, username, voucher.remaining_seconds);
          } else if (voucher && voucher.remaining_seconds <= 0) {
            await disableHotspotUser(clientMac);
          }
        }
      }
    } catch (e) {
      console.error('[ACCT] Async post-processing error:', e.message);
    }
  })();
});

acctServer.on('error', (err) => console.error('[ACCT] Server error:', err));
acctServer.bind(ACCT_PORT, '0.0.0.0', () =>
  console.log(`✅ RADIUS Acct server listening on UDP ${ACCT_PORT}`));