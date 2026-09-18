/**
 * One dated figure set, quoted everywhere.
 *
 * The README once said five sources while the live page said eight. Both were true on the day
 * they were written, which is worse than either being wrong: a reader who spots it has no way to
 * tell which other number has quietly moved. So there is now exactly one set of counts, taken from
 * the database at a named moment, defined term by term, and quoted verbatim by the README, the
 * methodology page and the static fallback. Live counts still appear on the list itself — they are
 * what the database holds right now — but nothing *argues* from a number that is not in here.
 *
 * To move it: re-run the query in docs/snapshot-2026-09-17.md against the live database, replace
 * every field below, refresh docs/snapshot-<date>.csv, and update the same table in README.md. A
 * test pins the arithmetic so a half-finished edit fails the build rather than the argument.
 */
export interface Snapshot {
	/** The day the figures were taken, as a reader should see it. */
	date: string;
	/** The ingest run the database held when they were taken. */
	dataVersion: string;
	sourcesConfigured: number;
	sourcesContributing: number;
	recordsSeen: number;
	placed: number;
	dropped: number;
	companies: number;
	notCompanies: number;
	described: number;
	describedOwnSite: number;
	describedFromSource: number;
	labelOnly: number;
	subsectorsTotal: number;
	subsectorsOccupied: number;
	/** The committed export the figures were counted from. */
	exportFile: string;
}

export const SNAPSHOT: Snapshot = {
	date: '17 September 2026',
	dataVersion: '2026-09-17T08:58:42Z',
	sourcesConfigured: 8,
	sourcesContributing: 7,
	recordsSeen: 2218,
	placed: 753,
	dropped: 1465,
	companies: 618,
	notCompanies: 135,
	described: 525,
	describedOwnSite: 180,
	describedFromSource: 345,
	labelOnly: 228,
	subsectorsTotal: 44,
	subsectorsOccupied: 36,
	exportFile: 'docs/snapshot-2026-09-17.csv',
};

/** What each number counts, in the words the page and the README both use. */
export const SNAPSHOT_TERMS: { term: string; value: (s: Snapshot) => string; means: string }[] = [
	{
		term: 'Sources',
		value: (s) => `${s.sourcesConfigured} configured, ${s.sourcesContributing} contributing`,
		means:
			'Scrapers in the pipeline. One of the eight (the NM-ICPS technology hubs list) had put no record on the page by this date, so seven is the number that earned a row.',
	},
	{
		term: 'Records seen',
		value: (s) => `${s.recordsSeen.toLocaleString('en-IN')}`,
		means:
			'Records read from those sources. Not companies: a record can be a research project or a name with nothing behind it. Treat this as an upper bound — duplicates are folded only where two names match once punctuation and legal suffixes are removed, or where a person read the pair and wrote it into ingest/aliases.json. Two sources spelling one company differently enough to defeat that test are still two records here.',
	},
	{
		term: 'Placed',
		value: (s) => `${s.placed}`,
		means:
			'Records given a row on the page and one of the 44 RDI sub-sectors. These are the only records the page shows. They fall in ' +
			'36 of the 44 sub-sectors.',
	},
	{
		term: 'Dropped',
		value: (s) => `${s.dropped.toLocaleString('en-IN')}`,
		means:
			'Records read but not placed, each kept in the gaps table with the reason it could not be placed. Dropped is not rejected: most were too thinly described to classify, not judged uninteresting.',
	},
	{
		term: 'Companies',
		value: (s) => `${s.companies}`,
		means:
			'Placed records whose entity type is a company. The other 135 are unverified names, research projects and one laboratory, counted beside the companies and never inside them.',
	},
	{
		term: 'Described',
		value: (s) => `${s.described}`,
		means:
			'Placed records carrying a published sentence saying what they do — 180 quoted from a website confirmed as theirs, 345 from the source that listed them. The remaining 228 have only a register or grant label.',
	},
];

/** Placed and dropped account for every record seen, and companies for every record placed. */
export function snapshotReconciles(s: Snapshot = SNAPSHOT): boolean {
	return (
		s.placed + s.dropped === s.recordsSeen &&
		s.companies + s.notCompanies === s.placed &&
		s.describedOwnSite + s.describedFromSource === s.described &&
		s.described + s.labelOnly === s.placed
	);
}
