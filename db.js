// db.js — SQLite database for persistent voucher tracking
// Time model: WALL-CLOCK (expires_at = first_used_at + allocated_seconds)
// The timer runs from first activation regardless of whether user is connected.

const Database = require('better-sqlite3');
const path     = require('path');

const db = new Database(path.join(__dirname, 'mbuya.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS vouchers (
    code              TEXT    PRIMARY KEY,
    profile           TEXT    NOT NULL,
    allocated_seconds INTEGER NOT NULL,
    used_seconds      INTEGER NOT NULL DEFAULT 0,
    first_used_at     TEXT,
    expires_at        TEXT,
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

// ── Migrate existing databases that don't have the new columns yet ────────────
try { db.exec(`ALTER TABLE vouchers ADD COLUMN first_used_at TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE vouchers ADD COLUMN expires_at TEXT`);    } catch(e) {}

const PROFILE_SECONDS = {
  '1day':   86400,
  '1week':  604800,
  '1month': 2592000,
};

module.exports = {
  PROFILE_SECONDS,

  // ── Create voucher (admin generate or payment) ────────────────────────────
  createVoucher(code, profile) {
    const secs = PROFILE_SECONDS[profile] || 86400;
    db.prepare(`
      INSERT OR IGNORE INTO vouchers
        (code, profile, allocated_seconds, used_seconds, disabled)
      VALUES (?, ?, ?, 0, 0)
    `).run(code, profile, secs);
  },

  // ── Get voucher with WALL-CLOCK remaining time ────────────────────────────
  // remaining_seconds = expires_at - NOW  (if activated)
  //                   = allocated_seconds (if never used)
  getVoucher(code) {
    const row = db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code);
    if (!row) return null;

    let remaining_seconds;
    if (row.expires_at) {
      const expiresMs = new Date(row.expires_at).getTime();
      remaining_seconds = Math.max(0, Math.floor((expiresMs - Date.now()) / 1000));
    } else {
      // Not yet activated — full allocation available
      remaining_seconds = row.allocated_seconds;
    }

    return {
      ...row,
      disabled: row.disabled === 1,
      remaining_seconds,
    };
  },

  // ── RADIUS Accounting: Start ──────────────────────────────────────────────
  // On FIRST use: stamp first_used_at and calculate the hard expiry time.
  // On subsequent logins: expiry is already set — don't change it.
  startSession(sessionId, code) {
    const voucher = db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code);
    if (voucher && !voucher.first_used_at) {
      const now       = new Date();
      const expiresAt = new Date(now.getTime() + voucher.allocated_seconds * 1000);
      db.prepare(`UPDATE vouchers SET first_used_at = ?, expires_at = ? WHERE code = ?`)
        .run(now.toISOString(), expiresAt.toISOString(), code);
      console.log(`[DB] Voucher ${code} activated — expires ${expiresAt.toISOString()}`);
    }

    db.prepare(`
      INSERT OR REPLACE INTO sessions
        (session_id, code, started_at, last_update, session_seconds)
      VALUES (?, ?, datetime('now'), datetime('now'), 0)
    `).run(sessionId, code);
  },

  // ── RADIUS Accounting: Interim-Update ────────────────────────────────────
  // Track actual connected seconds for reporting (not used for remaining time).
  updateSession(sessionId, cumulativeSeconds) {
    const sess = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
    if (!sess) return;
    const delta = cumulativeSeconds - sess.session_seconds;
    if (delta <= 0) return;
    db.prepare(`UPDATE vouchers SET used_seconds = used_seconds + ? WHERE code = ?`)
      .run(delta, sess.code);
    db.prepare(`UPDATE sessions SET session_seconds = ?, last_update = datetime('now') WHERE session_id = ?`)
      .run(cumulativeSeconds, sessionId);
  },

  // ── RADIUS Accounting: Stop ───────────────────────────────────────────────
  stopSession(sessionId, cumulativeSeconds) {
    this.updateSession(sessionId, cumulativeSeconds);
  },
};