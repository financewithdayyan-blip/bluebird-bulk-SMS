// Server-side Zoom Phone SMS sender.
// Required env vars (add to .env.local locally, and to Vercel project env for prod):
//   ZOOM_ACCOUNT_ID    — from your Server-to-Server OAuth app
//   ZOOM_CLIENT_ID     — from your Server-to-Server OAuth app
//   ZOOM_CLIENT_SECRET — from your Server-to-Server OAuth app
//   ZOOM_FROM_NUMBER   — your Zoom Phone number in E.164 format, e.g. +12145550000
//   ZOOM_USER_EMAIL    — the Zoom user the number is assigned to (or set ZOOM_USER_ID directly)

let cachedToken = null; // { access_token, expiresAt }
let cachedUserId = null;

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

async function getSenderUserId(token) {
  if (process.env.ZOOM_USER_ID) return process.env.ZOOM_USER_ID;
  if (cachedUserId) return cachedUserId;
  const email = process.env.ZOOM_USER_EMAIL;
  if (!email) throw new Error('Set ZOOM_USER_ID or ZOOM_USER_EMAIL in env');
  const res = await fetch(`https://api.zoom.us/v2/users/${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Could not resolve Zoom user "${email}" (${res.status}): ${err.message || res.statusText}`);
  }
  cachedUserId = (await res.json()).id;
  return cachedUserId;
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

  // GET = connection test (used by the Settings "Test Connection" button)
  if (req.method === 'GET') {
    try {
      const token = await getAccessToken();
      const userId = await getSenderUserId(token);
      res.status(200).json({ ok: true, userId, from: process.env.ZOOM_FROM_NUMBER });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const { to, message } = req.body || {};
  if (!to || !message) {
    res.status(400).json({ ok: false, error: 'Body must include "to" and "message"' });
    return;
  }

  try {
    const token = await getAccessToken();
    const userId = await getSenderUserId(token);

    const smsRes = await fetch('https://api.zoom.us/v2/phone/sms/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        sender: { user_id: userId, phone_number: process.env.ZOOM_FROM_NUMBER },
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
    res.status(200).json({ ok: true, id: data.id || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
