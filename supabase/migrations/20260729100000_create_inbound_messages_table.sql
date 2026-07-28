create table inbound_messages (
  id bigint primary key generated always as identity,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  lead_id bigint references leads (id) on delete set null,
  from_phone text not null,
  to_phone text,
  body text,
  zoom_message_id text unique,
  received_at timestamptz not null default now()
);

create index inbound_messages_user_lead_idx on inbound_messages (user_id, lead_id, received_at desc);

alter table inbound_messages enable row level security;

create policy "Users can read own inbound messages"
on inbound_messages for select to authenticated
using (user_id = (select auth.uid()));
