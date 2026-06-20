// radius-server.js
// Run alongside server.js: node radius-server.js
// Handles RADIUS Auth (1812) and Accounting (1813) for MikroTik hotspot.

const dgram  = require('dgram');
const radius = require('radius');
const db     = require('./db');

// ── Must match exactly what you enter in MikroTik's RADIUS config ─────────────
const RADIUS_SECRET    = 'mbuyawifi-secret';
const AUTH_PORT        = 1812;
const ACCT_PORT        = 1813;
const IDLE_TIMEOUT_SEC = 300;   // disconnect after 5 min idle

// ════════════════════════════════════════════════════════════════════════════════
// Authentication server (UDP 1812)
// MikroTik asks: "can this user log in?"
// We reply: Accept + Session-Timeout (remaining seconds), or Reject.
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
  console.log(`[AUTH] Request → ${username}`);

  const voucher = db.getVoucher(username);

  // ── Reject: unknown, disabled, or time fully used ────────────────────────────
  if (!voucher || voucher.disabled || voucher.remaining_seconds <= 0) {
    const reason = !voucher            ? 'not found'
                 : voucher.disabled    ? 'disabled'
                 :                       'session time fully used';
    console.log(`[AUTH] REJECTED: ${username} — ${!voucher ? 'not found' : voucher.disabled ? 'disabled' : 'expired'}`);

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
    authServer.send(resp, rinfo.port, rinfo.address, (err) => {
      if (err) console.error('[AUTH] Failed to send Reject:', err.message);
      else     console.log(`[AUTH] Reject sent to ${rinfo.address}:${rinfo.port}`);
    });
    return;
  }

  // ── Accept: return remaining time so MikroTik enforces the correct timeout ───
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
  authServer.send(resp, rinfo.port, rinfo.address, (err) => {
    if (err) console.error('[AUTH] Failed to send Accept:', err.message);
    else     console.log(`[AUTH] Accept sent to ${rinfo.address}:${rinfo.port}`);
  });
});

authServer.on('error', (err) => console.error('[AUTH] Server error:', err));
authServer.bind(AUTH_PORT, '0.0.0.0', () =>
  console.log(`✅ RADIUS Auth server listening on UDP ${AUTH_PORT}`));


// ════════════════════════════════════════════════════════════════════════════════
// Accounting server (UDP 1813)
// MikroTik reports: session started, seconds used so far, session ended.
// We update the database so remaining time is always accurate across logins.
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

  const statusType  = packet.attributes['Acct-Status-Type'];
  const username    = packet.attributes['User-Name'];
  const sessionId   = packet.attributes['Acct-Session-Id'];
  const sessionSecs = packet.attributes['Acct-Session-Time'] || 0;

  console.log(`[ACCT] ${statusType.padEnd(16)} → ${username} (${sessionSecs}s this session)`);

  if      (statusType === 'Start')          db.startSession(sessionId, username);
  else if (statusType === 'Interim-Update') db.updateSession(sessionId, sessionSecs);
  else if (statusType === 'Stop')           db.stopSession(sessionId, sessionSecs);

  // MikroTik requires an Accounting-Response or it will retry endlessly
  const resp = radius.encode_response({
    packet:  packet,
    code:    'Accounting-Response',
    secret:  RADIUS_SECRET,
    attributes: []
  });
  acctServer.send(resp, rinfo.port, rinfo.address, (err) => {
    if (err) console.error('[ACCT] Failed to send response:', err.message);
  });
});

acctServer.on('error', (err) => console.error('[ACCT] Server error:', err));
acctServer.bind(ACCT_PORT, '0.0.0.0', () =>
  console.log(`✅ RADIUS Acct server listening on UDP ${ACCT_PORT}`));