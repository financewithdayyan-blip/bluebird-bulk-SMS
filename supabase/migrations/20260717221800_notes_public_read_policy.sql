create policy "Allow public read access"
on notes
for select
to anon
using (true);
