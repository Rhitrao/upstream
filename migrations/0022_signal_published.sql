-- When the page or list carrying a signal was published, kept apart from `date` (when the
-- source says the thing happened) and `found_at` (when we collected it). An upload
-- timestamp on a grant PDF is the first of these, never the second.
ALTER TABLE signals ADD COLUMN published TEXT;
