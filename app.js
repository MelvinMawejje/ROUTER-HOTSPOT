// app.js

const PKG_AMOUNTS = { '1day': 1000, '1week': 5000, '1month': 20000 };
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_TRIES   = 20;

// ─── On load: check if we've been redirected back from MikroTik login ────────
document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const linkLoginOnly = params.get('link-login-only');

  // Store it globally so your functions can access it
  window.linkLoginOnly = linkLoginOnly;

  if (params.get('connected') === '1') {
    const user = params.get('user');
    if (user) {
      showDashboard(user);
      return;
    }
  }
  initPortal();
});

// ─── Portal init ──────────────────────────────────────────────────────────────
function initPortal() {
  let selectedPkg = null;
  let pollTimer   = null;
  let sessionPollTimer = null;

  // Package selection
  window.selectPkg = function(el) {
    document.querySelectorAll('.pkg-card').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
    const id    = el.dataset.pkg;
    const price = el.dataset.price;
    const label = el.querySelector('.pkg-duration').textContent;
    selectedPkg = { id, price, rawAmount: PKG_AMOUNTS[id] };
    document.getElementById('pkgSummaryText').textContent = `${label} — UGX ${price}`;
    document.getElementById('pkgSummary').style.display = 'block';
  };

  // ── Voucher submission ───────────────────────────────────────────────────────
  window.submitVoucher = async function() {
    const code = document.getElementById('voucherInput').value.trim();
    if (code.length < 2) { showErrorModal('Please enter a valid voucher code.'); return; }

    const btn = document.querySelector('#voucherSection .btn-teal');
    btn.textContent = 'Validating…';
    btn.disabled = true;

    try {
      const resp = await fetch('/api/voucher/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voucherCode: code }),
      });
      const data = await resp.json();

      if (!data.success) {
        showErrorModal(data.message || 'Invalid voucher.');
        return;
      }

      // Voucher is valid — submit hidden form to MikroTik's hotspot login.
      // MikroTik authenticates the client and redirects to our dashboard.
      document.getElementById('voucherInput').value = '';
      submitToMikrotik(data.code, '');

    } catch (err) {
      showErrorModal('Network error. Please try again.');
    } finally {
      btn.textContent = 'Connect with Voucher';
      btn.disabled = false;
    }
  };

  window.autoConnectAfterPayment = async function(voucherCode) {
    try {
      submitToMikrotik(voucherCode, '');
    } catch (err) {
      showErrorModal('Could not start your session. Please enter voucher code: ' + voucherCode);
    }
  };

  // ── Submit credentials to MikroTik's hotspot login page ─────────────────────
  // CRITICAL: form.action must be MikroTik's own link-login-only URL (from the
  // redirect params it appended to our portal URL). Posting to a hardcoded
  // /login URL causes 501 because MikroTik can't match it to the client session.
  function submitToMikrotik(username, password) {
    const loginUrl = window.linkLoginOnly || 'http://192.168.88.1/login';
    const dst      = `${window.location.origin}/?connected=1&user=${encodeURIComponent(username)}`;

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = loginUrl;   // ← THIS is what was wrong: must be linkLoginOnly
    form.style.display = 'none';

    const fields = { username, password, dst };
    Object.entries(fields).forEach(([n, v]) => {
      const inp = Object.assign(document.createElement('input'), { type: 'hidden', name: n, value: v });
      form.appendChild(inp);
    });

    document.body.appendChild(form);
    form.submit();
  }

  // ── Mobile money ─────────────────────────────────────────────────────────────
  window.submitMobileMoney = async function() {
    const phone = document.getElementById('phoneInput').value.trim();
    if (!selectedPkg) { alert('Please select a data package first.'); return; }
    if (!/^[0-9]{10}$/.test(phone)) { alert('Please enter a valid 10-digit phone number.'); return; }

    showWaitingModal(phone, selectedPkg.price);

    try {
      const resp = await fetch('/api/pay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '256' + phone.substring(1), amount: selectedPkg.rawAmount, packageId: selectedPkg.id }),
      });
      const ct = resp.headers.get('content-type');
      if (!ct || !ct.includes('application/json')) throw new Error('Server returned non-JSON response.');
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      if (!data.id) throw new Error('No transaction ID returned.');
      pollPaymentStatus(data.id, phone, selectedPkg);
    } catch (err) {
      closeWaitingModal();
      showErrorModal(err.message || 'Network error.');
    }
  };

  function pollPaymentStatus(txId, phone, pkg, tries = 0) {
    pollTimer = setTimeout(async () => {
      try {
        const resp = await fetch(`/api/pay/status/${txId}`);
        const data = await resp.json();

        if (data.status === 'Success') {
          closeWaitingModal();
          // Create the hotspot user and get the login action
          const cr = await fetch('/api/pay/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: '256' + phone.substring(1), packageId: pkg.id }),
          });
          const cd = await cr.json();
          if (cd.success) {
            autoConnectAfterPayment(cd.voucher);
          } else {
            showErrorModal(cd.message || 'Could not create your session.');
          }
        } else if (data.status === 'Failed') {
          closeWaitingModal();
          showErrorModal(data.statusMessage || 'Payment declined. Please try again.');
        } else if (tries >= POLL_MAX_TRIES) {
          closeWaitingModal();
          showErrorModal('Timed out waiting for payment. Please try again.');
        } else {
          updateWaitingStatus(data.status);
          pollPaymentStatus(txId, phone, pkg, tries + 1);
        }
      } catch (err) {
        if (tries >= POLL_MAX_TRIES) { closeWaitingModal(); showErrorModal('Could not verify payment.'); }
        else pollPaymentStatus(txId, phone, pkg, tries + 1);
      }
    }, POLL_INTERVAL_MS);
  }

  // ── Modals ───────────────────────────────────────────────────────────────────
  window.showWaitingModal = function(phone, price) {
    document.getElementById('modalPhone').textContent = '+256' + phone;
    document.getElementById('modalPrice').textContent = 'UGX ' + price;
    document.getElementById('modalStatus').textContent = 'Waiting for PIN entry…';
    document.getElementById('waitingModal').style.display = 'flex';
  };
  window.closeWaitingModal = function() { document.getElementById('waitingModal').style.display = 'none'; };
  function updateWaitingStatus(status) {
    const el = document.getElementById('modalStatus');
    if (el) el.textContent = status === 'SentToVendor' ? 'Processing with MTN/Airtel…' : 'Waiting for PIN entry on your phone…';
  }
  window.showErrorModal = function(msg) {
    document.getElementById('errorMsg').textContent = msg || 'Something went wrong. Please try again.';
    document.getElementById('errorModal').style.display = 'flex';
  };
  window.closeErrorModal = function() { document.getElementById('errorModal').style.display = 'none'; };
  window.showSuccessModal = function() { document.getElementById('successModal').style.display = 'flex'; };
  window.closeSuccessModal = function() { document.getElementById('successModal').style.display = 'none'; };
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
let dashTimer = null;

function showDashboard(user) {
  // Replace entire page with dashboard
  document.getElementById('portalView').style.display  = 'none';
  document.getElementById('dashboardView').style.display = 'block';
  document.getElementById('dashUser').textContent = user;

  // Clean URL without reloading
  window.history.replaceState({}, '', `/?connected=1&user=${encodeURIComponent(user)}`);

  fetchAndRenderSession(user);
  dashTimer = setInterval(() => fetchAndRenderSession(user), 15000);
}

async function fetchAndRenderSession(user) {
  try {
    const resp = await fetch(`/api/session/info?user=${encodeURIComponent(user)}`);
    const data = await resp.json();

    if (!data.active) {
      // Session ended — voucher expired or was removed
      clearInterval(dashTimer);
      document.getElementById('dashStatus').textContent      = 'Session Ended';
      document.getElementById('dashStatus').style.color      = '#ff6b6b';
      document.getElementById('dashUptime').textContent      = '--';
      document.getElementById('dashRemaining').textContent   = '--';
      document.getElementById('dashLogoutBtn').style.display = 'none';
      document.getElementById('dashExpiredMsg').style.display = 'block';
      return;
    }

    document.getElementById('dashUptime').textContent    = formatDuration(data.uptime);
    document.getElementById('dashRemaining').textContent = data.remaining === 'unlimited' ? '∞' : formatDuration(data.remaining);
    document.getElementById('dashStatus').textContent    = '🟢 Connected';
  } catch (err) {
    console.error('Session poll error:', err);
  }
}

window.logoutSession = async function() {
  const user = new URLSearchParams(window.location.search).get('user');
  if (!user) { window.location.href = '/'; return; }

  document.getElementById('dashLogoutBtn').textContent = 'Logging out…';
  document.getElementById('dashLogoutBtn').disabled = true;

  try {
    await fetch('/api/session/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user }),
    });
  } catch (e) { /* ignore */ }

  clearInterval(dashTimer);

  // Redirect to MikroTik's hotspot logout endpoint, which clears the network session,
  // then bounce back to our portal.
  window.location.href = `http://192.168.88.1/logout?dst=${encodeURIComponent(window.location.origin + '/')}`;
};

// ─── Util: parse MikroTik duration string (e.g. "2d3h15m40s") ────────────────
function formatDuration(str) {
  if (!str || str === '0s') return '0m';
  // MikroTik returns e.g. "1d2h3m4s", "45m", "3h20m10s"
  const match = str.match(/(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
  if (!match) return str;
  const [, d, h, m] = match.map(v => parseInt(v) || 0);
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}