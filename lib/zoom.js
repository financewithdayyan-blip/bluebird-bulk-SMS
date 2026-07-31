// Shared Zoom Phone SMS logic, used by both the browser-facing send API
// (pages/api/send-sms.js) and the incoming-webhook auto-reply handler
// (pages/api/zoom-webhook.js) so OAuth/token/user-id handling lives in one
// place instead of being duplicated across the two entry points.
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

export function getNumberConfigs() {
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

export async function getAccessToken() {
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

export async function getSenderUserId(token, numberConfig) {
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

// Sending window: 7:00 PM – 6:00 AM Pakistan time (UTC+5, no DST).
// 6:00 AM PKT = 9:00 PM US Eastern, the TCPA quiet-hours cutoff.
// Only applies to bulk cold-outreach sends -- replies within an active
// conversation (the webhook's auto-replies) aren't gated by this.
export function inSendWindow() {
  const now = new Date();
  const pktMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 300) % 1440;
  return pktMinutes >= 19 * 60 || pktMinutes < 6 * 60;
}

export async function sendZoomSms({ numberConfig, to, message }) {
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
    return {
      ok: false,
      error: data.message || `Zoom SMS API error (${smsRes.status})`,
      code: data.code,
    };
  }
  return { ok: true, id: data.id || null, from: numberConfig.phone, fromKey: numberConfig.key };
}
