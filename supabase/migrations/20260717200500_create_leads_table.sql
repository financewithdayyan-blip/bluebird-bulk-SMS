create table leads (
  id bigint primary key generated always as identity,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null default '',
  phone text not null default '',
  address text not null default '',
  stage text not null default 'Cold Call',
  opted_out boolean not null default false,
  status text not null default 'pending',
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

alter table leads enable row level security;

create policy "Users can read own leads"
on leads for select to authenticated
using (user_id = (select auth.uid()));

create policy "Users can insert own leads"
on leads for insert to authenticated
with check (user_id = (select auth.uid()));

create policy "Users can update own leads"
on leads for update to authenticated
using (user_id = (select auth.uid()));

create policy "Users can delete own leads"
on leads for delete to authenticated
using (user_id = (select auth.uid()));

create index leads_user_id_idx on leads (user_id);
