// Browser-facing Zoom Phone SMS sender — supports up to two numbers, chosen
// per-send by the caller (e.g. Number 1 for Code Violation, Number 2 for
// Cash Buyer) so each stays under Zoom's per-number daily SMS cap.
// See lib/zoom.js for the required env vars and shared send logic (also
// used by pages/api/zoom-webhook.js for auto-replying to incoming texts).

import { getNumberConfigs, getAccessToken, getSenderUserId, inSendWindow, sendZoomSms } from '../../lib/zoom';

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

  if (!inSendWindow()) {
    res.status(403).json({
      ok: false,
      error: 'Outside sending window — bulk SMS is allowed only 7:00 PM to 6:00 AM Pakistan time',
    });
    return;
  }

  try {
    const result = await sendZoomSms({ numberConfig, to, message });
    if (!result.ok) {
      res.status(502).json(result);
      return;
    }
    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
