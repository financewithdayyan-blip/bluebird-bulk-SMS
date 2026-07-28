// Receives Zoom webhook events (starting with incoming SMS) so the app can
// eventually auto-draft replies. For now this just verifies the request is
// really from Zoom and logs the raw event to `webhook_log` — the exact
// payload shape for phone.sms_received isn't nailed down from docs alone,
// so we inspect a real event before building the parsing/reply logic on top.
//
// Required env var: ZOOM_WEBHOOK_SECRET_TOKEN — shown by Zoom when you add
// an Event Subscription to the Server-to-Server OAuth app, under Feature >
// Event Subscriptions. Point the subscription's endpoint URL at
// https://<your-domain>/api/zoom-webhook.

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const secret = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;
  if (!secret) {
    console.error('zoom-webhook: ZOOM_WEBHOOK_SECRET_TOKEN not set');
    res.status(500).json({ ok: false, error: 'Webhook not configured' });
    return;
  }

  const raw = await readRawBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    res.status(400).json({ ok: false, error: 'Invalid JSON' });
    return;
  }

  // Zoom's one-time endpoint validation handshake — must echo back a hash
  // proving we hold the same secret token Zoom generated for this subscription.
  if (body.event === 'endpoint.url_validation') {
    const plainToken = body.payload?.plainToken || '';
    const encryptedToken = crypto.createHmac('sha256', secret).update(plainToken).digest('hex');
    res.status(200).json({ plainToken, encryptedToken });
    return;
  }

  // All other events carry an x-zm-signature header: v0=<hmac-sha256 of
  // "v0:{timestamp}:{raw body}", using the same secret token as the key>.
  const timestamp = req.headers['x-zm-request-timestamp'];
  const signature = req.headers['x-zm-signature'];
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`).digest('hex');
  if (signature !== expected) {
    res.status(401).json({ ok: false, error: 'Invalid signature' });
    return;
  }

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { error } = await sb.from('webhook_log').insert({ event_type: body.event, payload: body });
    if (error) console.error('zoom-webhook: failed to log event:', error.message);
  } catch (e) {
    console.error('zoom-webhook: failed to log event:', e.message);
  }

  res.status(200).json({ ok: true });
}
