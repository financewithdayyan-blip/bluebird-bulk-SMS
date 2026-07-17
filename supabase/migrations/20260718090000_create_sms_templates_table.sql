create table sms_templates (
  id bigint primary key generated always as identity,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  tag text not null,
  body text not null default '',
  updated_at timestamptz not null default now(),
  unique (user_id, tag)
);

alter table sms_templates enable row level security;

create policy "Users can read own templates"
on sms_templates for select to authenticated
using (user_id = (select auth.uid()));

create policy "Users can insert own templates"
on sms_templates for insert to authenticated
with check (user_id = (select auth.uid()));

create policy "Users can update own templates"
on sms_templates for update to authenticated
using (user_id = (select auth.uid()));

create policy "Users can delete own templates"
on sms_templates for delete to authenticated
using (user_id = (select auth.uid()));
