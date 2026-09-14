-- Founder lines with their names told apart, for rows 0019 wrote (ingest/sources/base.py,
-- founder_line). SINE lists some companies twice, once with commas and once without, and
-- 0019 took the first; other lines used a slash, or ran two titled names together. Each
-- update names the old value, so a line the nightly has already rewritten is left alone.

UPDATE companies SET founders = 'Prof. Padma Devarajan, Mrs. Maharukh Rustomjee' WHERE id = 'amaterasu-lifesciences' AND founders = 'Prof. Padma Devarajan Mrs. Maharukh Rustomjee';
UPDATE companies SET founders = 'Kamendra Sharma, Shobhna kapoor' WHERE id = 'bonarep-materials' AND founders = 'Kamendra Sharma/Shobhna kapoor';
UPDATE companies SET founders = 'Krishna Thiruvengadam, Sameer Malik' WHERE id = 'dverse-technologies' AND founders = 'Krishna Thiruvengadam/Sameer Malik';
UPDATE companies SET founders = 'Nisha Yadav, Saugandha Das' WHERE id = 'edhaa-innovations' AND founders = 'Nisha Yadav Saugandha Das';
UPDATE companies SET founders = 'DHINESH R KANAGARAJ (IITM alumnus)' WHERE id = 'fabheads-automation' AND founders = 'DHINESH R KANAGARAJ (IITM alumnus) /fabheads-automation/';
UPDATE companies SET founders = 'Dr. Charu Sharma, Dr. Sachin Bhardwaj, Dr. Rohit Srivastava' WHERE id = 'femacare' AND founders = 'Dr. Charu Sharma Dr. Sachin Bhardwaj Dr. Rohit Srivastava';
UPDATE companies SET founders = 'DR. NIVEDITA SARKAR, PROF. SUBHADEEP BANERJEE' WHERE id = 'fluoresight-bioprobes' AND founders = 'DR. NIVEDITA SARKAR/PROF. SUBHADEEP BANERJEE';
UPDATE companies SET founders = 'Kavita Kiran Prasad, Rangarajan' WHERE id = 'kavirise-technologies' AND founders = 'Kavita Kiran Prasad Rangarajan';
UPDATE companies SET founders = 'Kumudha A, Dr Selvakuma' WHERE id = 'magnimous-info-tech' AND founders = 'Kumudha A/Dr Selvakuma';
UPDATE companies SET founders = 'Prof. Subramaniam Chandramouli, Shubham Tiwari' WHERE id = 'ncf-green-energy' AND founders = 'Prof. Subramaniam Chandramouli Shubham Tiwari';
UPDATE companies SET founders = 'Prof. Udayan Ganguly, Prof. Swaroop Ganguly' WHERE id = 'numelo-technologies' AND founders = 'Prof. Udayan Ganguly Prof. Swaroop Ganguly';
UPDATE companies SET founders = 'Rohan M Despande, Ayush S Gaikwadi' WHERE id = 'raycura-medical-technologies' AND founders = 'Rohan M Despande/Ayush S Gaikwadi';
