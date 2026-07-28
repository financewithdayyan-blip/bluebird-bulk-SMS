create table ai_reply_config (
  id bigint primary key generated always as identity,
  user_id uuid not null unique default auth.uid() references auth.users (id) on delete cascade,
  framework_text text not null default '',
  updated_at timestamptz not null default now()
);

alter table ai_reply_config enable row level security;

create policy "Users can read own ai reply config"
on ai_reply_config for select to authenticated
using (user_id = (select auth.uid()));

create policy "Users can insert own ai reply config"
on ai_reply_config for insert to authenticated
with check (user_id = (select auth.uid()));

create policy "Users can update own ai reply config"
on ai_reply_config for update to authenticated
using (user_id = (select auth.uid()));
