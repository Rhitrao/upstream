-- web_first_capture: the date of the Internet Archive's first copy of the company's
-- homepage, from the Wayback Machine's CDX index (ingest/wayback.py). When the public
-- web first noticed the page — not when the company or the domain began, and never
-- written into first_seen or origin_year. Verified websites only, like domain_registered.
ALTER TABLE companies ADD COLUMN web_first_capture TEXT;
