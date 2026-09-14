# Near-duplicates across the 761 — a count, not a fix

Measured on 14 September 2026 against the live `/api/companies` rows (761 records,
before the register-label rule withdrew 157 placements). Nothing was merged.

## The number

**6 pairs are very probably one company listed twice — 12 of 761 rows (1.6%).**
One more pair is waiting to happen when the Venture Center finish runs.

| Pair | What gives it away | Sources |
|---|---|---|
| Call X Ringers Pvt Ltd / CallX Ringers | same name without spaces; same website | Venture Center lists it twice |
| Bylin Medtech Pvt. Ltd. / Byline Medtch Pvt Ltd | one-letter typos; same website | two grant rows |
| Cancrie Private Limited / Cancrie Inc. | same name, different legal suffix; both describe agri-waste nanocarbon for batteries | BIRAC BIG 22 grant / Venture Center |
| DrPashu AI Technologies Private Limited / Dr. Pashu Technologies Pvt Ltd | same name, one extra word | BIRAC BIG 21 grant / SINE |
| Careflex Healthcare Pvt Ltd / Careflex Health Private Limited | same name, one word shorter; both biomedical supports and splints | two SINE cohorts |
| AUDO Sens Diagnostics Pvt Ltd / Shodhsens Diagnostics Pvt Ltd | Shodhsens's website is audosens.com and its description says "AUDOSens is developing…" | SINE grant cohort / SINE incubatee |

Pending: **EyeROV Technologies Pvt Ltd** is one of the 65 Venture Center companies still
unclassified, and **Irov (EyeRov) Technologies Pvt. Ltd.** is already on the page.

## Not duplicates, but related

- **Arc Robotics / Driblet** and **Fuma Labs / CRASTE** share a website. The identity
  check already refuses to treat the address as either company's. These look like a
  source giving one company's site to another, not one company twice.
- **Ayati Devices / Ayu Devices**, **MRobotics / UmaRobotics**, **Matterwave / Matterak**:
  similar names, different companies (different websites and products).

## How it was counted

Three passes over the names and websites, then every candidate read by hand:

1. Names equal after dropping legal suffixes, punctuation and spaces: 2 pairs, both real.
2. Names at ≥ 0.90 similarity (difflib ratio) after the same cleaning: 2 pairs, 1 real.
3. The same website host on two rows: 3 pairs, 2 real.
4. A looser pass (≥ 0.80, or one name containing the other) produced 206 candidates.
   Almost all were two different companies sharing "Technologies" or "Innovations";
   it found DrPashu and Careflex, which the strict passes missed.

So no single rule gets all six without a flood of false pairs: exact-after-cleaning
finds 2, a strict fuzzy threshold adds 1 and a false one, a shared website adds 2, and
the last one (AUDO Sens) needed the website read against the *other* row's name.

## What it suggests for a rule (not decided)

- Five of the six pairs span two listings — a grant row and an incubator row, or two
  cohorts. The ids are slugs of the name, so any spelling difference makes two rows.
- A conservative automatic rule — same name after cleaning, **or** same verified website
  host — would merge 3 of the 6 and nothing wrong. The other 3 need a person or an alias
  file (`ingest/aliases.json`, hand-edited, like `gap-labels.json`).
- Merging changes counts on the page (companies, one-trace-or-none, per-cell numbers),
  so it is a headline-number change and waits for a decision.
