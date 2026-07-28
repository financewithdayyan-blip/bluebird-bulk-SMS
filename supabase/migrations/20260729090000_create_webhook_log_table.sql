-- Internal debug/audit log for incoming Zoom webhook events.
-- Written only by the service role (from the webhook handler) — RLS is
-- enabled with no policies, so it's invisible to the anon/authenticated
-- PostgREST roles the browser app uses; only direct Postgres access
-- (or the service role key) can read it.
create table webhook_log (
  id bigint primary key generated always as identity,
  event_type text,
  payload jsonb,
  received_at timestamptz not null default now()
);

alter table webhook_log enable row level security;
