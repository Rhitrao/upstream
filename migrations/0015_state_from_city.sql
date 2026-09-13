-- A state for the rows whose source printed only a city (ingest/places.py).
--
-- The grants lists give a city and no state; DPIIT gives both. 37 rows had a city and
-- no state, so a view by state would have filed them under unknown. Same table as the
-- pipeline, applied to what is stored. A city not listed keeps no state.
UPDATE companies
SET state = CASE lower(trim(city))
    WHEN 'ahmedabad' THEN 'Gujarat'
    WHEN 'bangalore' THEN 'Karnataka'
    WHEN 'bengaluru' THEN 'Karnataka'
    WHEN 'bhubaneshwar' THEN 'Odisha'
    WHEN 'bhubaneswar' THEN 'Odisha'
    WHEN 'chennai' THEN 'Tamil Nadu'
    WHEN 'gandhinagar' THEN 'Gujarat'
    WHEN 'ghaziabad' THEN 'Uttar Pradesh'
    WHEN 'gwalior' THEN 'Madhya Pradesh'
    WHEN 'hosur' THEN 'Tamil Nadu'
    WHEN 'jammu, j & k' THEN 'Jammu and Kashmir'
    WHEN 'jharkhand' THEN 'Jharkhand'
    WHEN 'kanpur' THEN 'Uttar Pradesh'
    WHEN 'kochi' THEN 'Kerala'
    WHEN 'mumbai' THEN 'Maharashtra'
    WHEN 'new delhi' THEN 'Delhi'
    WHEN 'noida' THEN 'Uttar Pradesh'
    WHEN 'pune' THEN 'Maharashtra'
    WHEN 'thiruvananthapuram' THEN 'Kerala'
    WHEN 'trivandrum' THEN 'Kerala'
    WHEN 'visakhapatnam' THEN 'Andhra Pradesh'
  END
WHERE COALESCE(state, '') = '' AND COALESCE(city, '') <> '';
