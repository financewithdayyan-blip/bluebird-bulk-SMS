-- Global on/off switch for the AI auto-reply webhook, separate from each
-- lead's own ai_reply_paused flag (which tracks per-lead handoff once
-- qualified). When auto_reply_enabled is false, the webhook still logs
-- inbound messages and moves leads across the Kanban board, but skips
-- drafting/sending anything -- the owner replies manually.
create table ai_settings (
  id bigint primary key generated always as identity,
  user_id uuid not null unique default auth.uid() references auth.users (id) on delete cascade,
  auto_reply_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table ai_settings enable row level security;

create policy "Users can read own ai settings"
on ai_settings for select to authenticated
using (user_id = (select auth.uid()));

create policy "Users can insert own ai settings"
on ai_settings for insert to authenticated
with check (user_id = (select auth.uid()));

create policy "Users can update own ai settings"
on ai_settings for update to authenticated
using (user_id = (select auth.uid()));
