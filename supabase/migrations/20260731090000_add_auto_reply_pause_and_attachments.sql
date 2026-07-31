-- Lets the webhook stop auto-replying to a lead once it's fully qualified
-- (or opted out), handing the conversation off for a human to make the offer.
alter table leads add column ai_reply_paused boolean not null default false;

-- Deterministic "did they actually send photos" signal, since that's not
-- reliably inferable from message text alone.
alter table inbound_messages add column has_attachments boolean not null default false;
