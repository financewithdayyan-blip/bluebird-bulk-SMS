-- Captures the full lead/property data set from CSV imports (first/last
-- name, a second phone, email, city/state/zip as their own fields instead of
-- folded into the address string, and property details) instead of just
-- name/phone/address. Kept as text throughout (like the existing phone/zip
-- handling) since real-world lead-list CSVs have messy, inconsistent
-- formatting for beds/baths/sqft/dates -- a numeric or date type would
-- reject rows a plain re-import shouldn't fail on.
alter table leads add column first_name text;
alter table leads add column last_name text;
alter table leads add column phone2 text;
alter table leads add column email text;
alter table leads add column city text;
alter table leads add column state text;
alter table leads add column zip text;
alter table leads add column beds text;
alter table leads add column baths text;
alter table leads add column sqft text;
alter table leads add column lot_size text;
alter table leads add column property_type text;
alter table leads add column auction_date text;
alter table leads add column source text;
