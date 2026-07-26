create table number_limits (
  id bigint primary key generated always as identity,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  number_key text not null,
  daily_limit integer not null default 1000,
  unique (user_id, number_key)
);

alter table number_limits enable row level security;

create policy "Users can read own number limits"
on number_limits for select to authenticated
using (user_id = (select auth.uid()));

create policy "Users can insert own number limits"
on number_limits for insert to authenticated
with check (user_id = (select auth.uid()));

create policy "Users can update own number limits"
on number_limits for update to authenticated
using (user_id = (select auth.uid()));

create policy "Users can delete own number limits"
on number_limits for delete to authenticated
using (user_id = (select auth.uid()));
