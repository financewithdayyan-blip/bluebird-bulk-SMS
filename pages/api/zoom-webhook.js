// Receives Zoom webhook events for incoming SMS and auto-replies to qualify
// leads. Verifies the request is really from Zoom, logs the raw event to
// `webhook_log`, and — for phone.sms_received — stores a parsed row in
// `inbound_messages` matched to a lead by phone number. When a lead matches,
// Claude drafts the next reply per that lead's saved framework and it's sent
// immediately (no human review) — this only covers the qualification
// conversation itself; once a lead is fully qualified (or opts out), the
// lead is flagged and auto-replying stops so a human takes over to make the
// actual offer. Leads are also auto-routed across the Kanban board: any
// reply lands in Replied, a declined/negative reply or opt-out moves to
// Dead (and is excluded from future bulk sends), and a fully qualified lead
// moves to Interested. A global on/off switch in Settings (`ai_settings`
// table) can disable the drafting/sending step entirely -- inbound messages
// and Kanban routing still happen, but no auto-reply goes out. Message
// reactions (tapback-style thumbs up/heart, etc.) are detected and ignored
// entirely -- they aren't real replies. Rapid multi-part texts from the same
// lead are debounced: each message waits REPLY_DELAY_MS before acting, and
// bails out if a newer message has since arrived, so only the last message
// in a burst actually drafts and sends -- using the full, by-then-complete
// transcript -- instead of every message triggering its own reply.
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
//   ANTHROPIC_API_KEY — used only server-side to draft replies.

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { getNumberConfigs, sendZoomSms } from '../../lib/zoom';

// Cheap, fast model — each reply is a small, bounded, script-following
// generation (the framework already spells out what to say), not open-ended
// reasoning, so this isn't worth spending Opus-tier tokens on. Swap to a
// more capable model here if replies need more nuance than Haiku gives.
const DRAFT_MODEL = 'claude-haiku-4-5';

// A reply that lands the instant a text comes in reads as an obvious bot.
// This also doubles as the debounce window for people who text in bursts
// (three separate messages a few seconds apart, a typo correction sent
// right after the original) -- see the supersede check in handleSmsReceived,
// which is what actually makes a longer delay merge those into one reply
// instead of just delaying multiple replies.
const REPLY_DELAY_MS = 16000;

export const config = { api: { bodyParser: false } };
export const maxDuration = 45; // the delay above + the Anthropic call + the Zoom send

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

// Drafts the next reply and reports whether the lead has now answered every
// qualification question. Photos are tracked deterministically (see
// has_attachments) rather than left for the model to infer from text alone,
// so that fact is handed to it as ground truth instead of asked to guess.
async function draftReply(sb, ownerUserId, leadId, hasAttachmentsNow) {
  const [{ data: lead }, { data: configRows }, { data: inbound }, { data: outbound }] = await Promise.all([
    sb.from('leads').select('name, address, tags').eq('id', leadId).maybeSingle(),
    sb.from('ai_reply_config').select('tag, framework_text').eq('user_id', ownerUserId),
    sb.from('inbound_messages').select('body, received_at, has_attachments').eq('lead_id', leadId).order('received_at'),
    sb.from('send_log').select('body, sent_at').eq('lead_id', leadId).not('body', 'is', null).order('sent_at'),
  ]);

  // Each lead type (Code Violation, Pre-Foreclosure, Tax Delinquent, ...) can
  // have its own framework, since the right opening move differs by tag —
  // use the first of the lead's tags that has a saved framework, else Default.
  const frameworksByTag = Object.fromEntries((configRows || []).map((r) => [r.tag, r.framework_text]));
  const matchedTag = (lead?.tags || []).find((t) => frameworksByTag[t]);
  const framework = matchedTag ? frameworksByTag[matchedTag] : frameworksByTag['Default'];
  if (!framework) throw new Error('No AI reply framework saved in Settings yet');

  const hasImages = hasAttachmentsNow || (inbound || []).some((m) => m.has_attachments);

  const transcript = [
    ...(inbound || []).map((m) => ({ at: m.received_at, line: `[Them]: ${m.body}` })),
    ...(outbound || []).map((m) => ({ at: m.sent_at, line: `[Us]: ${m.body}` })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at)).slice(-30).map((m) => m.line).join('\n');

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: DRAFT_MODEL,
    max_tokens: 300,
    system: `You are Dayyan from Bluebird Acquisitions, texting a property owner who replied to a cold outreach SMS about buying their property for cash. Draft the next text message to send them — 1 to 3 short sentences, sounding like a real person texting, not corporate. No greeting like "Dear", no signature.\n\nBefore drafting, actually read the whole conversation above, both what they've said and what you've already said, so this reply is consistent with everything already established. Don't just react to their latest message in isolation, don't ask something already answered, and don't contradict something you already said or they already told you.\n\nWrite the way people actually text: never use an em dash (—) anywhere in the message, use commas or just start a new sentence instead; a casual emoji here and there is fine where it fits naturally (not in every message, and not more than one).\n\nHave a genuinely normal, human conversation — actually respond to whatever they just said instead of ignoring it to force the next scripted step. The framework below defines your goals and the rules for specific situations, not a rigid script to recite; use judgment for anything it doesn't explicitly cover, the way a real person working from the same goals would. Never invent facts, numbers, or offers that haven't actually come up in this conversation.\n\nFramework:\n${framework}\n\nProperty address: ${lead?.address || 'unknown'}\nOwner's name on file: ${lead?.name || 'unknown'}\nPhotos received so far: ${hasImages ? 'yes' : 'no'}`,
    messages: [{ role: 'user', content: `Conversation so far (oldest to newest):\n${transcript}\n\nDraft the next reply from us, and report whether this lead is now fully qualified.` }],
    tools: [{
      name: 'submit_reply',
      description: 'Submit the next SMS reply to send, and whether the lead has now fully completed the qualification framework.',
      input_schema: {
        type: 'object',
        properties: {
          reply: { type: 'string', description: 'The exact SMS text to send next.' },
          fully_qualified: {
            type: 'boolean',
            description: 'True only if the lead has confirmed ownership, given their motivation, described the property condition, given an asking price, given a timeline, AND photos have already been received (see "Photos received so far" above). False otherwise -- including while this reply is still asking for missing information, or if the lead declined/opted out.',
          },
          negative_reply: {
            type: 'boolean',
            description: 'True if the lead is clearly declining / not interested in selling, OR this is a confirmed wrong number (they have no connection to the property or owner at all) and this reply is closing the conversation out per the framework. Do not set this for a formal STOP/DNC request (that\'s handled separately) -- just for a decline or a dead-end wrong number. False for anything else, including neutral, cautious, or mid-qualification answers.',
          },
        },
        required: ['reply', 'fully_qualified', 'negative_reply'],
      },
    }],
    tool_choice: { type: 'tool', name: 'submit_reply' },
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse) throw new Error('Model returned no structured reply');
  const { reply, fully_qualified, negative_reply } = toolUse.input || {};
  if (!reply) throw new Error('Model returned an empty reply');
  return { reply: String(reply).trim(), fullyQualified: !!fully_qualified, negativeReply: !!negative_reply };
}

// Standard carrier-recognized opt-out keywords (STOP, UNSUBSCRIBE, etc.) —
// matched on the whole trimmed message only, never as a substring, so a
// real sentence that happens to contain "stop" ("I want to stop looking")
// never gets misread as an opt-out.
const OPT_OUT_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
function isOptOutMessage(text) {
  const cleaned = String(text || '').trim().toLowerCase().replace(/[.!?,;:]+$/, '');
  return OPT_OUT_KEYWORDS.has(cleaned);
}

// Plain-English "don't contact me" requests. Anchored to the end of the
// message (allowing only a few trailing softener words) rather than matched
// anywhere -- "don't call me before 9am" or "remove my number, use this one
// instead" must NOT match, since a false positive here silently drops a live
// lead with zero reply. A phrase this strict misses shouldn't be caught
// deterministically anyway -- the AI's negativeReply classification (which
// still sends a courtesy reply) is the fallback for anything softer or less
// literal than these.
const DNC_TRAIL = String.raw`(?:\s+(?:again|anymore|please|thanks?|thank\s+you|from\s+(?:your|the|this)\s+(?:list|database|records)))*[\s.!]*$`;
const DNC_PHRASE_PATTERNS = [
  new RegExp(String.raw`\b(?:don'?t|do\s+not)\s+(?:text|contact|message|msg|call|email)\s+me` + DNC_TRAIL, 'i'),
  new RegExp(String.raw`\bstop\s+(?:texting|contacting|messaging|calling|emailing)\s+me` + DNC_TRAIL, 'i'),
  new RegExp(String.raw`\b(?:please\s+)?remove\s+(?:me|my\s+number)` + DNC_TRAIL, 'i'),
  new RegExp(String.raw`\btake\s+me\s+off\s+(?:your|the)\s+list` + DNC_TRAIL, 'i'),
  new RegExp(String.raw`\blose\s+my\s+number` + DNC_TRAIL, 'i'),
  new RegExp(String.raw`\bnever\s+(?:text|contact|message|call)\s+me\s+again` + DNC_TRAIL, 'i'),
];
function isDncPhrase(text) {
  return DNC_PHRASE_PATTERNS.some((re) => re.test(String(text || '').trim()));
}

// Profanity/hostility directed at us. Unlike the DNC phrases above, there's
// no benign reading of someone swearing at a cold-outreach text -- a bare
// curse word here is a strong enough signal on its own, so this doesn't need
// the same end-anchoring. Curated to known swear words and censored spellings
// rather than a broad wildcard, so it doesn't catch ordinary words like
// "fork", "funk", or "stuck".
const PROFANITY_PATTERNS = [
  /\bfu+c*k+(?:ing|in['’]?|er|ed|s|face|tard)?\b/i,
  /\bf[*#@$%]ck(?:ing|er|ed|s)?\b/i,
  /\bf[*#@$%]{2}k(?:ing|er|ed|s)?\b/i,
  /\bfck\b/i,
  /\bpiss\s*off\b/i,
  /\bscrew\s*you\b/i,
  /\basshole\b/i,
  /\bbitch\b/i,
  /\bgo\s+to\s+hell\b/i,
];
function isProfane(text) {
  return PROFANITY_PATTERNS.some((re) => re.test(String(text || '')));
}

// Tapback-style reactions (thumbs up/heart/etc. on one of our texts) come
// through the webhook as a normal inbound SMS whose body is Zoom's
// carrier-bridged summary of the reaction, e.g. `👍 to "our original text"`
// or `Removed 👍 from "our original text"`. These aren't an actual answer to
// anything -- treating them as a real reply was causing the AI to re-ask the
// same question it had just asked, twice (once for the react, once for the
// unreact).
const REACTION_PATTERNS = [
  /^[\p{Extended_Pictographic}️\s]+to\s+["“][\s\S]*["”]$/u,
  /^Removed\s+[\p{Extended_Pictographic}️\s]+from\s+["“][\s\S]*["”]$/iu,
];
function isReactionMessage(text) {
  return REACTION_PATTERNS.some((re) => re.test(String(text || '').trim()));
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

  const hasAttachmentsNow = Array.isArray(obj.attachments) && obj.attachments.length > 0;

  const { data: inserted, error } = await sb.from('inbound_messages').insert({
    user_id: ownerUserId,
    lead_id: leadId,
    from_phone: fromPhone,
    to_phone: toPhone,
    body: obj.message || '',
    zoom_message_id: obj.message_id || null,
    received_at: obj.date_time || new Date().toISOString(),
    has_attachments: hasAttachmentsNow,
  }).select('id').maybeSingle();
  // Zoom retries webhooks on failure — duplicate deliveries are expected and
  // harmless (zoom_message_id is unique), so only log genuinely new errors.
  if (error) {
    if (error.code !== '23505') console.error('zoom-webhook: failed to store inbound message:', error.message);
    return;
  }
  if (!leadId || !inserted) return;

  // A reaction to one of our messages, not an actual reply -- log it (done
  // above) and stop, so it never triggers a stage change or an AI reply.
  if (isReactionMessage(obj.message)) return;

  const { data: lead } = await sb.from('leads').select('ai_reply_paused, stage').eq('id', leadId).maybeSingle();
  if (!lead) return;

  // Opt-out (carrier keyword, a plain-English "don't contact me" request, or
  // outright profanity/hostility) is handled deterministically rather than
  // spending an AI call on it, and skips sending anything back entirely: no
  // courtesy reply, no Anthropic cost, just a silent move to Dead. Someone
  // cursing at a cold-outreach text isn't worth a reply either way.
  const optOut = isOptOutMessage(obj.message) || isDncPhrase(obj.message) || isProfane(obj.message);
  if (optOut) {
    const { error: optErr } = await sb.from('leads').update({ opted_out: true, stage: 'Dead', ai_reply_paused: true }).eq('id', leadId);
    if (optErr) console.error('zoom-webhook: failed to move opted-out lead to Dead:', optErr.message);
    return;
  }

  // Once paused (fully qualified, or already handled), a human has taken
  // over -- stop auto-replying.
  if (lead.ai_reply_paused) return;

  // Any reply mid-qualification surfaces the lead in the Replied column —
  // this gets upgraded to Interested below if this exact message also
  // completes qualification. This still happens even with auto-reply
  // switched off below -- only the drafting/sending is gated by that.
  if (lead.stage !== 'Replied') {
    await sb.from('leads').update({ stage: 'Replied' }).eq('id', leadId);
  }

  // Global kill switch (Settings → AI Reply Framework). Missing row means
  // the owner has never touched the toggle, which defaults to enabled.
  const { data: aiSettings } = await sb.from('ai_settings').select('auto_reply_enabled').eq('user_id', ownerUserId).maybeSingle();
  if (aiSettings && aiSettings.auto_reply_enabled === false) return;

  const numberConfig = toPhone && getNumberConfigs().find((n) => n.phone === toPhone);
  if (!numberConfig) {
    await sb.from('inbound_messages').update({ draft_error: `No configured number matches ${toPhone}` }).eq('id', inserted.id);
    return;
  }

  try {
    // Wait first, so someone texting in a burst (three short messages, a typo
    // correction sent right after the original) has a chance to finish before
    // we act. Only draft after the wait, using whatever's arrived by then.
    await new Promise((resolve) => setTimeout(resolve, REPLY_DELAY_MS));

    // If a newer message for this lead has landed while we waited, that
    // message's own invocation will wake up later and reply with the full,
    // by-then-complete transcript -- bail out here instead of sending a
    // reply based on a conversation that's already stale. This is what turns
    // "three texts in five seconds" into one reply instead of three.
    const { data: newer } = await sb.from('inbound_messages').select('id').eq('lead_id', leadId).gt('id', inserted.id).limit(1);
    if (newer && newer.length) return;

    const draft = await draftReply(sb, ownerUserId, leadId, hasAttachmentsNow);
    const sendResult = await sendZoomSms({ numberConfig, to: fromPhone, message: draft.reply });
    if (!sendResult.ok) throw new Error(sendResult.error);

    await sb.from('inbound_messages').update({ draft_reply: draft.reply }).eq('id', inserted.id);
    await sb.from('send_log').insert({
      user_id: ownerUserId, phone: fromPhone, sent_from: sendResult.from,
      sent_at: new Date().toISOString(), lead_id: leadId, body: draft.reply,
    });

    if (draft.negativeReply) {
      // Covers a softer decline the deterministic phrase check didn't catch
      // (e.g. "not interested" with no explicit "don't contact me"), and a
      // confirmed wrong number with no connection to the property at all.
      // Both get a brief closing reply, then are excluded from future bulk
      // sends -- there's no real lead at this number either way.
      await sb.from('leads').update({ ai_reply_paused: true, stage: 'Dead', opted_out: true }).eq('id', leadId);
    } else if (draft.fullyQualified) {
      await sb.from('leads').update({ ai_reply_paused: true, stage: 'Interested' }).eq('id', leadId);
    }
  } catch (e) {
    console.error('zoom-webhook: auto-reply failed:', e.message);
    await sb.from('inbound_messages').update({ draft_error: e.message }).eq('id', inserted.id);
  }
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
