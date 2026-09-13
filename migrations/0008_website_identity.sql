-- Whether a website is the company's, separately from whether it answers.
--
-- RTBI's portfolio page has about a hundred empty <a href="http://hyperverge.co/">
-- tags left in other companies' cards by its editor. The scraper took the first link
-- in each card, Grinntech Motors (EV battery packs) got HyperVerge's address, the
-- homepage answered, and the page published an identity-verification product as
-- Grinntech's own words. ZedBee got the same address and the same sentence.
--
-- website_identity — how far the address got through ingest/identity.py:
--   discovered  a URL exists, but nothing ties it to this company (another record
--               gives the same address, it is a profile on another platform, or its
--               homepage describes a different business from the source record)
--   associated  the company's own source record gives it and nothing contradicts
--               it, but the homepage does not name the company
--   verified    associated, and the company's name is in the domain or on the page
--   NULL        no website, or not yet checked
-- website_identity_note — the reason, in a sentence, for the detail page.
--
-- A product sentence is only ever read from a verified homepage, and the ingest
-- endpoint refuses one attached to anything else.

ALTER TABLE companies ADD COLUMN website_identity TEXT;
ALTER TABLE companies ADD COLUMN website_identity_note TEXT;

-- Quarantine. Every sentence already on the page was read before anything checked
-- whose homepage it came from, so none of them is published until the next ingest run
-- has checked it. Verified ones come back from ingest/cache/products.json at no cost;
-- the rest stay unread. The status goes with the sentence: 'described' with no
-- sentence is a promise the row cannot keep.
UPDATE companies SET product = NULL, product_status = NULL WHERE product_status = 'described';
