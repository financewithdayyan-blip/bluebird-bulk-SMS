-- Adds outbound message context (which lead, what was actually sent) so the
-- AI reply drafter can read the full two-way conversation, not just replies.
-- send_log previously only tracked phone/timestamp for the daily-limit feature.
alter table send_log add column lead_id bigint references leads (id) on delete set null;
alter table send_log add column body text;

create index send_log_lead_idx on send_log (lead_id, sent_at);
