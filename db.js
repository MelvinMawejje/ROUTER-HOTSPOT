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

  CREATE TABLE IF NOT EXISTS revenue_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT    NOT NULL,
    profile     TEXT    NOT NULL,
    source      TEXT    NOT NULL,
    gross_ugx   INTEGER NOT NULL,
    net_ugx     INTEGER NOT NULL,
    recorded_at TEXT    DEFAULT (datetime('now'))
  );
`);

// ── Migrate existing databases ────────────────────────────────────────────────
try { db.exec(`ALTER TABLE vouchers ADD COLUMN first_used_at TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE vouchers ADD COLUMN expires_at TEXT`);    } catch(e) {}
try { db.exec(`ALTER TABLE vouchers ADD COLUMN printed_at TEXT`);    } catch(e) {}
try { db.exec(`
  CREATE TABLE IF NOT EXISTS revenue_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT    NOT NULL,
    profile     TEXT    NOT NULL,
    source      TEXT    NOT NULL,
    gross_ugx   INTEGER NOT NULL,
    net_ugx     INTEGER NOT NULL,
    recorded_at TEXT    DEFAULT (datetime('now'))
  )
`); } catch(e) {}
try { db.exec(`
  CREATE TABLE IF NOT EXISTS mac_bindings (
    mac TEXT PRIMARY KEY, code TEXT NOT NULL,
    bound_at TEXT DEFAULT (datetime('now'))
  )
`); } catch(e) {}

const PROFILE_SECONDS = {
  'mini-day': 14400,
  '1day':     86400,
  '1week':    604800,
  '1month':   2592000,
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

   // ── Look up voucher by MAC address ────────────────────────────
  getVoucherByMac(mac) {
    if (!mac) return null;
    const binding = db.prepare(
      'SELECT code FROM mac_bindings WHERE mac = ?'
    ).get(mac.toUpperCase());
    if (!binding) return null;
    return this.getVoucher(binding.code);
  },

  // ── Bind MAC to voucher (overwrites old binding) ──────────────
  bindMac(mac, code) {
    if (!mac || !code) return;
    db.prepare(`
      INSERT OR REPLACE INTO mac_bindings (mac, code, bound_at)
      VALUES (?, ?, datetime('now'))
    `).run(mac.toUpperCase(), code);
    console.log(`[DB] MAC ${mac.toUpperCase()} bound to ${code}`);
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

  stopSession(sessionId, cumulativeSeconds) {
    this.updateSession(sessionId, cumulativeSeconds);
  },

  // ── Record a revenue event ────────────────────────────────────────────────
  // source: 'voucher' | 'mobile_money'
  // mobile_money earns 96% of face value; vouchers earn 100%
  // ── Mark vouchers as printed ──────────────────────────────────────────────
  // Prevents them from appearing in the next print batch.
  markPrinted(codes) {
    const stmt = db.prepare(
      `UPDATE vouchers SET printed_at = datetime('now') WHERE code = ? AND printed_at IS NULL`
    );
    const run = db.transaction(() => codes.forEach(c => stmt.run(c)));
    run();
  },

  recordRevenue(code, profile, source) {
    const PRICES   = { 'mini-day': 500, '1day': 1000, '1week': 5000, '1month': 20000 };
    const gross    = PRICES[profile] || 0;
    const net      = source === 'mobile_money' ? Math.floor(gross * 0.96) : gross;
    db.prepare(`
      INSERT INTO revenue_events (code, profile, source, gross_ugx, net_ugx)
      VALUES (?, ?, ?, ?, ?)
    `).run(code, profile, source, gross, net);
  },

  // ── Metrics query ─────────────────────────────────────────────────────────
  // Returns daily totals and per-day rows for the requested period
  getMetrics(period) {
    // period: 'day' | 'week' | 'month' | 'year'
    const cutoffs = { day: 1, week: 7, month: 30, year: 365 };
    const days    = cutoffs[period] || 30;
    const rows    = db.prepare(`
      SELECT
        date(recorded_at) AS day,
        SUM(gross_ugx)    AS gross,
        SUM(net_ugx)      AS net,
        COUNT(*)          AS count,
        SUM(CASE WHEN source='mobile_money' THEN net_ugx ELSE 0 END) AS mm_net,
        SUM(CASE WHEN source='voucher'      THEN net_ugx ELSE 0 END) AS v_net
      FROM revenue_events
      WHERE recorded_at >= datetime('now', '-${days} days')
      GROUP BY date(recorded_at)
      ORDER BY day ASC
    `).all();

    const totals = db.prepare(`
      SELECT
        SUM(gross_ugx) AS gross,
        SUM(net_ugx)   AS net,
        COUNT(*)       AS count,
        SUM(CASE WHEN source='mobile_money' THEN net_ugx ELSE 0 END) AS mm_net,
        SUM(CASE WHEN source='voucher'      THEN net_ugx ELSE 0 END) AS v_net
      FROM revenue_events
      WHERE recorded_at >= datetime('now', '-${days} days')
    `).get();

    return { rows, totals: totals || { gross:0, net:0, count:0, mm_net:0, v_net:0 } };
  },
};