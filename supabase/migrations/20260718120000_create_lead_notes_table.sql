create table lead_notes (
  id bigint primary key generated always as identity,
  lead_id bigint not null references leads (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

alter table lead_notes enable row level security;

create policy "Users can read own lead notes"
on lead_notes for select to authenticated
using (user_id = (select auth.uid()));

create policy "Users can insert own lead notes"
on lead_notes for insert to authenticated
with check (user_id = (select auth.uid()));

create policy "Users can update own lead notes"
on lead_notes for update to authenticated
using (user_id = (select auth.uid()));

create policy "Users can delete own lead notes"
on lead_notes for delete to authenticated
using (user_id = (select auth.uid()));

create index lead_notes_lead_id_idx on lead_notes (lead_id);
