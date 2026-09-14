-- What the sources and a company's own site already say, and the page did not show.
--
-- founders / founders_source: the names an incubator's card gives, in its words. Not
--   looked up and not linked: decision 006 still holds, and a name is not a profile.
-- dpiit_status / dpiit_stage: what the register's record says. 'profile' is a Startup
--   India profile DPIIT never recognised — 345 of 966 records we hold, all of which
--   the page called "DPIIT recognised" until now.
-- contact_email / contact_page: an address on the company's own domain and its contact
--   page, read off a verified homepage and nothing else.
-- domain_registered: the RDAP registration date of the website's domain. A domain can be
--   older than the company that owns it; the page says so beside it.
-- papers: JSON {count, works: [{title, year, url}], query_url} — works whose author
--   affiliation names the company, from OpenAlex. Evidence, not a trace: it does not
--   move a company in the ranking.

ALTER TABLE companies ADD COLUMN founders TEXT;
ALTER TABLE companies ADD COLUMN founders_source TEXT;
ALTER TABLE companies ADD COLUMN dpiit_status TEXT;
ALTER TABLE companies ADD COLUMN dpiit_stage TEXT;
ALTER TABLE companies ADD COLUMN contact_email TEXT;
ALTER TABLE companies ADD COLUMN contact_page TEXT;
ALTER TABLE companies ADD COLUMN domain_registered TEXT;
ALTER TABLE companies ADD COLUMN papers TEXT;
