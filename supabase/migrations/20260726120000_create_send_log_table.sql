create table send_log (
  id bigint primary key generated always as identity,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  phone text not null,
  sent_from text,
  sent_at timestamptz not null default now()
);

create index send_log_user_sent_at_idx on send_log (user_id, sent_at desc);
create index send_log_user_from_idx on send_log (user_id, sent_from, sent_at desc);

alter table send_log enable row level security;

create policy "Users can read own send log"
on send_log for select to authenticated
using (user_id = (select auth.uid()));

create policy "Users can insert own send log"
on send_log for insert to authenticated
with check (user_id = (select auth.uid()));
