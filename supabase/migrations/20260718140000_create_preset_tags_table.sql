create table preset_tags (
  id bigint primary key generated always as identity,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  tag text not null,
  created_at timestamptz not null default now(),
  unique (user_id, tag)
);

alter table preset_tags enable row level security;

create policy "Users can read own preset tags"
on preset_tags for select to authenticated
using (user_id = (select auth.uid()));

create policy "Users can insert own preset tags"
on preset_tags for insert to authenticated
with check (user_id = (select auth.uid()));

create policy "Users can delete own preset tags"
on preset_tags for delete to authenticated
using (user_id = (select auth.uid()));
