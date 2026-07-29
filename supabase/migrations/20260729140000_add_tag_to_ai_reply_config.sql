-- Frameworks now vary per lead type (Code Violation, Pre-Foreclosure, Tax
-- Delinquent, etc.), mirroring how sms_templates already keys per-tag
-- cold-outreach messages. 'Default' is the fallback for any tag without
-- its own saved framework.
alter table ai_reply_config add column tag text not null default 'Default';
alter table ai_reply_config drop constraint ai_reply_config_user_id_key;
alter table ai_reply_config add constraint ai_reply_config_user_id_tag_key unique (user_id, tag);
