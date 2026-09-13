-- What a company says it builds, read off its own homepage.
--
-- Two columns because the answer and the reason there is no answer are different
-- facts, and the second is the one this project exists to state out loud. 209 of
-- 684 companies publish a website at all; of those, roughly a third answer with
-- nothing a reader could use — a dead domain, a page that refuses an automated
-- request, a shell that renders itself in JavaScript. A blank cell would make all
-- of those look identical to "we have not looked yet", which is the one thing it
-- must never look like.
--
-- product        — one sentence, in the company's own account of itself. NULL
--                  unless product_status is 'described'.
-- product_status — NULL means nobody has looked. Otherwise it is the outcome, and
--                  every outcome that is not 'described' is a sentence the page
--                  can print instead of a blank:
--                    described   — we read it and it said what it builds
--                    unreachable — the domain did not answer
--                    refused     — the site refused an automated reader
--                    thin        — the page loaded and carried no readable text
--                    unclear     — there was text and it never said what they make
--
-- Deliberately not a claim of fact. This is marketing copy from a company's own
-- front page, read by a model; the page labels it as what the company says, with
-- the link, and never as something we verified.

ALTER TABLE companies ADD COLUMN product TEXT;
ALTER TABLE companies ADD COLUMN product_status TEXT;

-- The page filters and counts on "has a product line" and "we looked and could
-- not get one", both of which are this column.
CREATE INDEX idx_companies_product ON companies(product_status);
