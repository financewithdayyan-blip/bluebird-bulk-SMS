// Server-side Zoom Phone SMS sender — supports up to two numbers, chosen
// per-send by the caller (e.g. Number 1 for Code Violation, Number 2 for
// Cash Buyer) so each stays under Zoom's per-number daily SMS cap.
//
// Required env vars (add to .env.local locally, and to Vercel project env for prod):
//   ZOOM_ACCOUNT_ID    — from your Server-to-Server OAuth app
//   ZOOM_CLIENT_ID     — from your Server-to-Server OAuth app
//   ZOOM_CLIENT_SECRET — from your Server-to-Server OAuth app
//   ZOOM_FROM_NUMBER   — Number 1, in E.164 format, e.g. +12145550000
//   ZOOM_USER_EMAIL    — the Zoom user Number 1 is assigned to (or set ZOOM_USER_ID)
//   ZOOM_LABEL         — optional display name for Number 1, e.g. "Code Violation Line"
// Optional second number:
//   ZOOM_FROM_NUMBER_2 — Number 2, in E.164 format
//   ZOOM_USER_EMAIL_2  — the Zoom user Number 2 is assigned to (defaults to ZOOM_USER_EMAIL
//                         if omitted, i.e. both numbers on the same Zoom user)
//   ZOOM_LABEL_2        — optional display name for Number 2, e.g. "Cash Buyer Line"

let cachedToken = null; // { access_token, expiresAt }
const cachedUserIds = {}; // numberKey → zoom user id

function getNumberConfigs() {
  const numbers = [
    {
      key: '1',
      phone: process.env.ZOOM_FROM_NUMBER,
      email: process.env.ZOOM_USER_EMAIL,
      userId: process.env.ZOOM_USER_ID,
      label: process.env.ZOOM_LABEL || 'Number 1',
    },
  ];
  if (process.env.ZOOM_FROM_NUMBER_2) {
    numbers.push({
      key: '2',
      phone: process.env.ZOOM_FROM_NUMBER_2,
      email: process.env.ZOOM_USER_EMAIL_2 || process.env.ZOOM_USER_EMAIL,
      userId: process.env.ZOOM_USER_ID_2,
      label: process.env.ZOOM_LABEL_2 || 'Number 2',
    });
  }
  return numbers.filter((n) => n.phone);
}

// Verifies the caller's Supabase session token and (optionally) restricts
// sending to the emails listed in ALLOWED_EMAILS (comma-separated).
async function requireUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return { error: 'Sign in required', status: 401 };

  const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) return { error: 'Invalid or expired session — sign in again', status: 401 };
  const user = await res.json();

  const allowed = (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length && !allowed.includes((user.email || '').toLowerCase())) {
    return { error: `Account ${user.email} is not authorized to send SMS`, status: 403 };
  }
  return { user };
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.access_token;
  }
  const { ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET } = process.env;
  const res = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}`,
    {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' +
          Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString('base64'),
      },
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Zoom OAuth failed (${res.status}): ${err.reason || err.error || res.statusText}`);
  }
  const data = await res.json();
  cachedToken = {
    access_token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.access_token;
}

async function getSenderUserId(token, numberConfig) {
  if (numberConfig.userId) return numberConfig.userId;
  if (cachedUserIds[numberConfig.key]) return cachedUserIds[numberConfig.key];
  if (!numberConfig.email) {
    throw new Error(`Set ZOOM_USER_ID or ZOOM_USER_EMAIL for ${numberConfig.label} in env`);
  }
  const res = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(numberConfig.email)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      `Could not resolve Zoom user "${numberConfig.email}" for ${numberConfig.label} (${res.status}): ${err.message || res.statusText}`
    );
  }
  const id = (await res.json()).id;
  cachedUserIds[numberConfig.key] = id;
  return id;
}

export default async function handler(req, res) {
  const missing = ['ZOOM_ACCOUNT_ID', 'ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET', 'ZOOM_FROM_NUMBER'].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    res.status(500).json({ ok: false, error: `Missing env vars: ${missing.join(', ')}` });
    return;
  }

  const authCheck = await requireUser(req);
  if (authCheck.error) {
    res.status(authCheck.status).json({ ok: false, error: authCheck.error });
    return;
  }

  const numbers = getNumberConfigs();

  // GET = list configured numbers + connection test (used by Settings and the Send page)
  if (req.method === 'GET') {
    try {
      const token = await getAccessToken();
      const results = [];
      for (const n of numbers) {
        try {
          const userId = await getSenderUserId(token, n);
          results.push({ key: n.key, phone: n.phone, label: n.label, ok: true, userId });
        } catch (e) {
          results.push({ key: n.key, phone: n.phone, label: n.label, ok: false, error: e.message });
        }
      }
      res.status(200).json({ ok: true, numbers: results });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const { to, message, from } = req.body || {};
  if (!to || !message) {
    res.status(400).json({ ok: false, error: 'Body must include "to" and "message"' });
    return;
  }

  const numberConfig = numbers.find((n) => n.key === String(from)) || numbers[0];
  if (!numberConfig) {
    res.status(500).json({ ok: false, error: 'No Zoom numbers configured' });
    return;
  }

  // Sending window: 7:00 PM – 6:00 AM Pakistan time (UTC+5, no DST).
  // 6:00 AM PKT = 9:00 PM US Eastern, the TCPA quiet-hours cutoff.
  const now = new Date();
  const pktMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 300) % 1440;
  const inWindow = pktMinutes >= 19 * 60 || pktMinutes < 6 * 60;
  if (!inWindow) {
    res.status(403).json({
      ok: false,
      error: 'Outside sending window — bulk SMS is allowed only 7:00 PM to 6:00 AM Pakistan time',
    });
    return;
  }

  try {
    const token = await getAccessToken();
    const userId = await getSenderUserId(token, numberConfig);

    const smsRes = await fetch('https://api.zoom.us/v2/phone/sms/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        sender: { user_id: userId, phone_number: numberConfig.phone },
        to_members: [{ phone_number: to }],
      }),
    });

    const data = await smsRes.json().catch(() => ({}));
    if (!smsRes.ok) {
      res.status(smsRes.status).json({
        ok: false,
        error: data.message || `Zoom SMS API error (${smsRes.status})`,
        code: data.code,
      });
      return;
    }
    res.status(200).json({ ok: true, id: data.id || null, from: numberConfig.phone, fromKey: numberConfig.key });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
