// db.js — SQLite database for persistent voucher session tracking
const Database = require('better-sqlite3');
const path     = require('path');

const db = new Database(path.join(__dirname, 'mbuya.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS vouchers (
    code              TEXT    PRIMARY KEY,
    profile           TEXT    NOT NULL,
    allocated_seconds INTEGER NOT NULL,
    used_seconds      INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT    DEFAULT (datetime('now')),
    disabled          INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    session_id      TEXT PRIMARY KEY,
    code            TEXT NOT NULL,
    started_at      TEXT DEFAULT (datetime('now')),
    last_update     TEXT DEFAULT (datetime('now')),
    session_seconds INTEGER NOT NULL DEFAULT 0
  );
`);

// Profile → total seconds mapping (must match your MikroTik profiles)
const PROFILE_SECONDS = {
  '1day':   86400,
  '1week':  604800,
  '1month': 2592000,
};

module.exports = {
  PROFILE_SECONDS,

  // ── Called when a voucher is sold (payment flow or manual creation) ──────────
  createVoucher(code, profile) {
    const secs = PROFILE_SECONDS[profile] || 86400;
    db.prepare(`
      INSERT OR IGNORE INTO vouchers (code, profile, allocated_seconds, used_seconds, disabled)
      VALUES (?, ?, ?, 0, 0)
    `).run(code, profile, secs);
  },

  // ── Look up voucher with remaining time calculated ───────────────────────────
  getVoucher(code) {
    const row = db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code);
    if (!row) return null;
    return {
      ...row,
      disabled:          row.disabled === 1,
      remaining_seconds: Math.max(0, row.allocated_seconds - row.used_seconds),
    };
  },

  // ── RADIUS Accounting: Start ─────────────────────────────────────────────────
  startSession(sessionId, code) {
    db.prepare(`
      INSERT OR REPLACE INTO sessions (session_id, code, started_at, last_update, session_seconds)
      VALUES (?, ?, datetime('now'), datetime('now'), 0)
    `).run(sessionId, code);
  },

  // ── RADIUS Accounting: Interim-Update or Stop ────────────────────────────────
  // MikroTik sends cumulative session seconds — we only add the delta to avoid
  // double-counting when multiple interim packets arrive.
  updateSession(sessionId, cumulativeSeconds) {
    const sess = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
    if (!sess) return;
    const delta = cumulativeSeconds - sess.session_seconds;
    if (delta <= 0) return;
    db.prepare('UPDATE vouchers SET used_seconds = used_seconds + ? WHERE code = ?')
      .run(delta, sess.code);
    db.prepare("UPDATE sessions SET session_seconds = ?, last_update = datetime('now') WHERE session_id = ?")
      .run(cumulativeSeconds, sessionId);
  },

  stopSession(sessionId, cumulativeSeconds) {
    this.updateSession(sessionId, cumulativeSeconds);
  },

  // ── For /api/session/info — remaining time from our database ─────────────────
  getRemainingSeconds(code) {
    const v = this.getVoucher(code);
    return v ? v.remaining_seconds : 0;
  },
};