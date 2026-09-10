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
    created_at        TEXT    DEFAULT (datetime('now', '+3 hours')),
    disabled          INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    session_id      TEXT PRIMARY KEY,
    code            TEXT NOT NULL,
    started_at      TEXT DEFAULT (datetime('now', '+3 hours')),
    last_update     TEXT DEFAULT (datetime('now', '+3 hours')),
    session_seconds INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS revenue_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT    NOT NULL,
    profile     TEXT    NOT NULL,
    source      TEXT    NOT NULL,
    gross_ugx   INTEGER NOT NULL,
    net_ugx     INTEGER NOT NULL,
    recorded_at TEXT    DEFAULT (datetime('now', '+3 hours'))
  );
`);

// ── Migrate existing databases ────────────────────────────────────────────────
try { db.exec(`ALTER TABLE vouchers ADD COLUMN first_used_at TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE vouchers ADD COLUMN expires_at TEXT`);    } catch(e) {}
try { db.exec(`ALTER TABLE vouchers ADD COLUMN printed_at TEXT`);    } catch(e) {}
try { db.exec(`ALTER TABLE vouchers ADD COLUMN transaction_id TEXT`); } catch(e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_vouchers_txn ON vouchers(transaction_id)`); } catch(e) {}
try { db.exec(`
  CREATE TABLE IF NOT EXISTS revenue_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT    NOT NULL,
    profile     TEXT    NOT NULL,
    source      TEXT    NOT NULL,
    gross_ugx   INTEGER NOT NULL,
    net_ugx     INTEGER NOT NULL,
    recorded_at TEXT    DEFAULT (datetime('now', '+3 hours'))
  )
`); } catch(e) {}
try { db.exec(`
  CREATE TABLE IF NOT EXISTS mac_bindings (
    mac TEXT PRIMARY KEY, code TEXT NOT NULL,
    bound_at TEXT DEFAULT (datetime('now', '+3 hours'))
  )
`); } catch(e) {}
// pending_payments: created the moment we ask IOTEC to collect money, BEFORE
// we know whether it succeeds. Stores what the transaction was FOR (phone +
// package) so that whichever path hears about success first — the client
// calling /api/pay/connect, or the IOTEC webhook — can create the voucher.
// This is what closes the "money deducted but no voucher" gap: the webhook
// only ever gets a transaction ID + status, not the original phone/package,
// so without this table it would have nothing to create a voucher FROM.
try { db.exec(`
  CREATE TABLE IF NOT EXISTS pending_payments (
    transaction_id TEXT PRIMARY KEY,
    phone          TEXT NOT NULL,
    package_id     TEXT NOT NULL,
    voucher_code   TEXT,
    status         TEXT NOT NULL DEFAULT 'pending',
    created_at     TEXT DEFAULT (datetime('now', '+3 hours')),
    completed_at   TEXT
  )
`); } catch(e) {}
// active_mac / active_session_id track which single device currently "holds"
// the voucher, so a second device can't log in with the same code while the
// first is still connected.
try { db.exec(`ALTER TABLE vouchers ADD COLUMN active_mac TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE vouchers ADD COLUMN active_session_id TEXT`); } catch(e) {}
// revenue_recorded_at: atomic "has revenue already been logged for this
// voucher?" flag. Set the moment recordRevenue actually runs, in the SAME
// SQL statement that checks it — closes the race where /api/voucher/redeem
// gets hit more than once before RADIUS Accounting-Start sets first_used_at
// (flaky captive portal, page reload, retyped code), which used to cause
// recordRevenue to fire again on every retry.
try { db.exec(`ALTER TABLE vouchers ADD COLUMN revenue_recorded_at TEXT`); } catch(e) {}

const PROFILE_SECONDS = {
  'mini-day': 14400,
  '1day':     86400,
  '1week':    604800,
  '1month':   2592000,
};

module.exports = {
  PROFILE_SECONDS,

  // ── Create voucher (admin generate or payment) ────────────────────────────
  // Returns true if a NEW row was actually inserted, false if `code` already
  // existed (INSERT OR IGNORE silently no-op'd). Callers that generate a
  // random code should check this and retry on false — otherwise they'd
  // carry on as if they'd created a fresh voucher when they actually just
  // collided with an existing one (wrong profile/time, revenue mis-recorded
  // against someone else's voucher, transaction_id reassigned, etc).
  createVoucher(code, profile) {
    const secs = PROFILE_SECONDS[profile] || 86400;
    const result = db.prepare(`
      INSERT OR IGNORE INTO vouchers
        (code, profile, allocated_seconds, used_seconds, disabled)
      VALUES (?, ?, ?, 0, 0)
    `).run(code, profile, secs);
    return result.changes > 0;
  },

  // ── Get voucher with WALL-CLOCK remaining time ────────────────────────────
  // remaining_seconds = expires_at - NOW  (if activated)
  //                   = allocated_seconds (if never used)
  getVoucher(code) {
    const row = db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code);
    if (!row) return null;

    let remaining_seconds;
    if (row.expires_at) {
      // expires_at is stored as EAT (UTC+3), so parse it as UTC+3
      const eatStr   = row.expires_at.replace(' ', 'T') + '+03:00';
      const expiresMs = new Date(eatStr).getTime();
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

  // ── Look up voucher by IOTEC mobile-money transaction ID ──────
  // Lets a user who got disconnected retrieve their voucher by
  // pasting the transaction ID they received from MTN/Airtel/IOTEC.
  getVoucherByTransactionId(transactionId) {
    if (!transactionId) return null;
    const row = db.prepare(
      'SELECT code FROM vouchers WHERE transaction_id = ?'
    ).get(String(transactionId).trim());
    if (!row) return null;
    return this.getVoucher(row.code);
  },

  // ── Link a voucher to the IOTEC transaction ID that paid for it ─
  bindTransactionId(code, transactionId) {
    if (!code || !transactionId) return;
    db.prepare(`UPDATE vouchers SET transaction_id = ? WHERE code = ?`)
      .run(String(transactionId).trim(), code);
    console.log(`[DB] Voucher ${code} linked to transaction ${transactionId}`);
  },

  // ── Pending payments (for the IOTEC webhook) ──────────────────
  // Recorded the instant we ask IOTEC to collect, before we know the
  // outcome. Lets a later webhook call — which only knows the transaction
  // ID and status — look up what package/phone it was for.
  savePendingPayment(transactionId, phone, packageId) {
    if (!transactionId) return;
    db.prepare(`
      INSERT OR IGNORE INTO pending_payments (transaction_id, phone, package_id)
      VALUES (?, ?, ?)
    `).run(String(transactionId).trim(), phone, packageId);
    console.log(`[DB] Pending payment recorded: ${transactionId} (${packageId}, ${phone})`);
  },

  getPendingPayment(transactionId) {
    if (!transactionId) return null;
    return db.prepare('SELECT * FROM pending_payments WHERE transaction_id = ?')
      .get(String(transactionId).trim());
  },

  markPendingPaymentComplete(transactionId, voucherCode) {
    if (!transactionId) return;
    db.prepare(`
      UPDATE pending_payments
      SET voucher_code = ?, status = 'completed', completed_at = datetime('now', '+3 hours')
      WHERE transaction_id = ?
    `).run(voucherCode, String(transactionId).trim());
  },

  // ── Bind MAC to voucher (overwrites old binding) ──────────────
  bindMac(mac, code) {
    if (!mac || !code) return;
    db.prepare(`
      INSERT OR REPLACE INTO mac_bindings (mac, code, bound_at)
      VALUES (?, ?, datetime('now', '+3 hours'))
    `).run(mac.toUpperCase(), code);
    console.log(`[DB] MAC ${mac.toUpperCase()} bound to ${code}`);
  },


  // ── RADIUS Accounting: Start ──────────────────────────────────────────────
  // On FIRST use: stamp first_used_at and calculate the hard expiry time.
  // On subsequent logins: expiry is already set — don't change it.
  // Also claims this device (MAC) as the sole active holder of the voucher.
  startSession(sessionId, code, mac) {
    const voucher = db.prepare('SELECT * FROM vouchers WHERE code = ?').get(code);
    if (voucher && !voucher.first_used_at) {
      const now       = new Date();
      const expiresAt = new Date(now.getTime() + voucher.allocated_seconds * 1000);
      // Store as EAT (UTC+3) to match all other timestamps in the DB
      const toEAT = d => new Date(d.getTime() + 3 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
      db.prepare(`UPDATE vouchers SET first_used_at = ?, expires_at = ? WHERE code = ?`)
        .run(toEAT(now), toEAT(expiresAt), code);
      console.log(`[DB] Voucher ${code} activated — expires ${toEAT(expiresAt)} EAT`);
    }

    if (voucher) {
      db.prepare(`UPDATE vouchers SET active_mac = ?, active_session_id = ? WHERE code = ?`)
        .run(mac ? mac.toUpperCase() : null, sessionId, code);
    }

    db.prepare(`
      INSERT OR REPLACE INTO sessions
        (session_id, code, started_at, last_update, session_seconds)
      VALUES (?, ?, datetime('now', '+3 hours'), datetime('now', '+3 hours'), 0)
    `).run(sessionId, code);
  },

  // ── Is this voucher currently in use by a different device? ──────────────
  // Returns true only when there's an active session held by a MAC other
  // than the one asking. If we don't have a MAC to compare (mac is falsy),
  // we fail open rather than lock the owner out.
  isVoucherActiveElsewhere(code, mac) {
    if (!mac) return false;
    const row = db.prepare('SELECT active_mac FROM vouchers WHERE code = ?').get(code);
    if (!row || !row.active_mac) return false;
    return row.active_mac !== mac.toUpperCase();
  },

  //clearing old maac 
  clearActiveBinding(code) {
  db.prepare(`UPDATE vouchers SET active_mac = NULL, active_session_id = NULL WHERE code = ?`)
    .run(code);
  console.log(`[DB] Cleared stale active binding for voucher ${code}`);
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
    db.prepare(`UPDATE sessions SET session_seconds = ?, last_update = datetime('now', '+3 hours') WHERE session_id = ?`)
      .run(cumulativeSeconds, sessionId);
  },

  stopSession(sessionId, cumulativeSeconds) {
    this.updateSession(sessionId, cumulativeSeconds);
    // Free up the voucher only if the session that just stopped is still the
    // one holding it — an old, already-superseded Stop shouldn't kick off
    // whichever device is currently connected.
    const sess = db.prepare('SELECT code FROM sessions WHERE session_id = ?').get(sessionId);
    if (sess) {
      db.prepare(`
        UPDATE vouchers SET active_mac = NULL, active_session_id = NULL
        WHERE code = ? AND active_session_id = ?
      `).run(sess.code, sessionId);
    }
  },

  // ── Record a revenue event ────────────────────────────────────────────────
  // source: 'voucher' | 'mobile_money'
  // mobile_money earns 96% of face value; vouchers earn 100%
  // ── Mark vouchers as printed ──────────────────────────────────────────────
  // Prevents them from appearing in the next print batch.
  markPrinted(codes) {
    const stmt = db.prepare(
      `UPDATE vouchers SET printed_at = datetime('now', '+3 hours') WHERE code = ? AND printed_at IS NULL`
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

  // ── Record revenue exactly once per voucher ───────────────────────────────
  // Atomically claims the voucher (UPDATE ... WHERE revenue_recorded_at IS NULL)
  // and only inserts the revenue_events row if this call is the one that won
  // the claim. Safe to call on every redeem attempt, however many times a
  // user retries — duplicates are impossible because the claim and the
  // "have I already recorded this?" check happen in the same statement.
  // Returns true if revenue was recorded by this call, false if it was
  // already recorded previously (nothing done).
  tryRecordRevenue(code, profile, source) {
    const claim = db.prepare(`
      UPDATE vouchers SET revenue_recorded_at = datetime('now', '+3 hours')
      WHERE code = ? AND revenue_recorded_at IS NULL
    `).run(code);
    if (claim.changes === 0) return false; // already recorded — no-op
    this.recordRevenue(code, profile, source);
    return true;
  },

  // ── Metrics query ─────────────────────────────────────────────────────────
  // Returns calendar-aligned totals for the requested period.
  // period: 'day' | 'week' | 'month' | 'year'
  // offset: how many periods back from the CURRENT one — 0 = today/this
  //   week/this month/this year, 1 = yesterday/last week/last month/last
  //   year, 2 = two periods back, etc. Lets the admin UI page backwards
  //   through history instead of only ever seeing the current period.
  // Previously this used a rolling "last N days" window (e.g. "this month"
  // = last 30 days), which silently drifted across month/week boundaries —
  // on the 2nd of a new month "this month" still showed mostly last month.
  // Boundaries are now real calendar periods: start of this
  // day/week(Monday)/month/year through to the same point one period later.
  getMetrics(period, offset) {
    const off = Math.max(0, parseInt(offset) || 0);
    let startExpr, endExpr;

    switch (period) {
      case 'day':
        startExpr = `date('now', '+3 hours', '-${off} days')`;
        endExpr   = `date(${startExpr}, '+1 day')`;
        break;
      case 'week': {
        // Monday of the current week: step back 6 days, then roll forward
        // to the next Monday — a standard SQLite idiom that's correct even
        // when "now" already falls on a Monday.
        const mondayExpr = `date('now', '+3 hours', '-6 days', 'weekday 1')`;
        startExpr = `date(${mondayExpr}, '-${off * 7} days')`;
        endExpr   = `date(${startExpr}, '+7 days')`;
        break;
      }
      case 'year':
        startExpr = `date('now', '+3 hours', 'start of year', '-${off} years')`;
        endExpr   = `date(${startExpr}, '+1 year')`;
        break;
      case 'month':
      default:
        startExpr = `date('now', '+3 hours', 'start of month', '-${off} months')`;
        endExpr   = `date(${startExpr}, '+1 month')`;
        break;
    }

    const range = db.prepare(`SELECT ${startExpr} AS start, ${endExpr} AS end`).get();

    const rows = db.prepare(`
      SELECT
        date(recorded_at) AS day,
        SUM(gross_ugx)    AS gross,
        SUM(net_ugx)      AS net,
        COUNT(*)          AS count,
        SUM(CASE WHEN source='mobile_money' THEN net_ugx ELSE 0 END) AS mm_net,
        SUM(CASE WHEN source='voucher'      THEN net_ugx ELSE 0 END) AS v_net
      FROM revenue_events
      WHERE recorded_at >= ? AND recorded_at < ?
      GROUP BY date(recorded_at)
      ORDER BY day ASC
    `).all(range.start, range.end);

    const totals = db.prepare(`
      SELECT
        SUM(gross_ugx) AS gross,
        SUM(net_ugx)   AS net,
        COUNT(*)       AS count,
        SUM(CASE WHEN source='mobile_money' THEN net_ugx ELSE 0 END) AS mm_net,
        SUM(CASE WHEN source='voucher'      THEN net_ugx ELSE 0 END) AS v_net
      FROM revenue_events
      WHERE recorded_at >= ? AND recorded_at < ?
    `).get(range.start, range.end);

    const events = db.prepare(`
      SELECT code, profile, source, gross_ugx, net_ugx,
             strftime('%Y-%m-%d %H:%M', recorded_at) AS recorded_at
      FROM revenue_events
      WHERE recorded_at >= ? AND recorded_at < ?
      ORDER BY recorded_at ASC
    `).all(range.start, range.end);

    return {
      range,   // { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' } — exclusive end
      rows,
      totals: totals || { gross:0, net:0, count:0, mm_net:0, v_net:0 },
      events,
    };
  },

  // ── Monthly revenue series (for the trend chart) ──────────────────────────
  // Returns the last `months` calendar months, oldest → newest, one entry
  // per month with zero-filled gaps so the chart always has a continuous
  // timeline even for months with no sales.
  getMonthlyRevenue(months) {
    const n = Math.max(1, Math.min(parseInt(months) || 12, 60));

    // "Now" shifted into EAT so month boundaries line up with the rest of
    // the app's timestamps; read back with UTC getters since we already
    // did the +3h shift by hand (avoids double-applying the server's own
    // local timezone on top).
    const nowEAT = new Date(Date.now() + 3 * 3600 * 1000);
    const y = nowEAT.getUTCFullYear();
    const m = nowEAT.getUTCMonth(); // 0-indexed current month

    const monthKeys = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(y, m - i, 1));
      monthKeys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }

    const rows = db.prepare(`
      SELECT
        strftime('%Y-%m', recorded_at) AS month,
        SUM(gross_ugx) AS gross,
        SUM(net_ugx)   AS net,
        COUNT(*)       AS count
      FROM revenue_events
      WHERE recorded_at >= ?
      GROUP BY month
    `).all(`${monthKeys[0]}-01`);

    const byMonth = {};
    rows.forEach(r => { byMonth[r.month] = r; });

    return monthKeys.map(key => ({
      month: key, // 'YYYY-MM'
      gross: byMonth[key] ? byMonth[key].gross : 0,
      net:   byMonth[key] ? byMonth[key].net   : 0,
      count: byMonth[key] ? byMonth[key].count : 0,
    }));
  },
};