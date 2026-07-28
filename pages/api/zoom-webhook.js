// Receives Zoom webhook events (starting with incoming SMS) so the app can
// eventually auto-draft replies. Verifies the request is really from Zoom,
// logs the raw event to `webhook_log`, and — for phone.sms_received — stores
// a parsed row in `inbound_messages` matched to a lead by phone number.
//
// Required env vars:
//   ZOOM_WEBHOOK_SECRET_TOKEN — shown by Zoom when you add an Event
//     Subscription to the Server-to-Server OAuth app, under Feature >
//     Event Subscriptions. Point the subscription's endpoint URL at
//     https://<your-domain>/api/zoom-webhook.
//   OWNER_USER_ID — the Supabase auth user id that owns all leads/sends.
//     This app is single-tenant on the Zoom side (one account, gated by
//     ALLOWED_EMAILS), so incoming messages are always attributed to this
//     one user rather than resolved per-request.

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

// Zoom sends phone numbers without a leading "+" (e.g. "12174082781").
// Normalize to the same +E.164 form the app already stores in leads.phone.
function toE164(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  return '+' + digits;
}

async function handleSmsReceived(sb, body) {
  const obj = body.payload?.object;
  if (!obj) return;
  const fromPhone = toE164(obj.sender?.phone_number);
  const toPhone = toE164(obj.to_members?.[0]?.phone_number);
  if (!fromPhone) return;

  const ownerUserId = process.env.OWNER_USER_ID;
  let leadId = null;
  if (ownerUserId) {
    const { data: lead } = await sb.from('leads')
      .select('id').eq('user_id', ownerUserId).eq('phone', fromPhone).limit(1).maybeSingle();
    leadId = lead?.id || null;
  }

  const { error } = await sb.from('inbound_messages').insert({
    user_id: ownerUserId,
    lead_id: leadId,
    from_phone: fromPhone,
    to_phone: toPhone,
    body: obj.message || '',
    zoom_message_id: obj.message_id || null,
    received_at: obj.date_time || new Date().toISOString(),
  });
  // Zoom retries webhooks on failure — duplicate deliveries are expected and
  // harmless (zoom_message_id is unique), so only log genuinely new errors.
  if (error && error.code !== '23505') console.error('zoom-webhook: failed to store inbound message:', error.message);
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

  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  try {
    const { error } = await sb.from('webhook_log').insert({ event_type: body.event, payload: body });
    if (error) console.error('zoom-webhook: failed to log event:', error.message);
  } catch (e) {
    console.error('zoom-webhook: failed to log event:', e.message);
  }

  if (body.event === 'phone.sms_received') {
    try {
      await handleSmsReceived(sb, body);
    } catch (e) {
      console.error('zoom-webhook: failed to handle sms_received:', e.message);
    }
  }

  res.status(200).json({ ok: true });
}
