/**
 * Every read the page and the API share. These return data, not Responses, so the
 * server-rendered page and the JSON endpoints can never drift apart.
 */
import { SUNRISE_SECTORS, SUNRISE_SUBSECTOR_IDS } from './taxonomy';
import type { Basis, Tier } from './rank';

export interface Signal {
	type: string;
	label: string;
	url: string | null;
	date: string | null;
}

export interface Company {
	id: string;
	name: string;
	description: string | null;
	website: string | null;
	/** 0 when no source that publishes websites has looked at this company. */
	website_checked: number;
	city: string | null;
	state: string | null;
	cin: string | null;
	founded_year: number | null;
	origin_year: number | null;
	sector_id: string | null;
	subsector_id: string | null;
	project_type: string | null;
	classify_note: string | null;
	/** 'description', or 'register-label' where only an industry label was available. */
	classify_basis: string;
	first_seen: string | null;
	first_seen_basis: Basis | null;
	discovered: string;
	trace_count: number;
	tier: Tier;
	updated_at: string;
	signals: Signal[];
}

/** Whether a company can be placed in time at all. The page shows the two separately. */
export type DateState = 'dated' | 'undated';

export interface Filters {
	sector: string | null;
	subsector: string | null;
	/** null or empty means every tier. */
	tiers: Tier[] | null;
	/** 'dated' is the ranked list, 'undated' the section under it, null both at once. */
	dated: DateState | null;
	/** Drop anything that started earlier than this year. null lifts the age gate. */
	minOriginYear: number | null;
	limit: number;
}

/** One hole in the taxonomy, and who fell through it. */
export interface GapGroup {
	/** The missing capability, named by the classifier: "water infrastructure". */
	missing: string;
	n: number;
	/** A few names, so the group is checkable rather than just a number. */
	examples: string[];
}

/**
 * The one group name that does not mean "the taxonomy has no cell for this".
 *
 * Written by ingest/gaps.py, which owns the vocabulary; this is the reading end.
 * A test asserts the two agree, because a silent drift here would file every thin
 * description as a hole in the RDI scheme — the exact conflation the split exists
 * to undo.
 */
export const NO_GAP_NAMED = 'no gap named';

/**
 * The DPIIT recognition register, as ingest/sources/dpiit.py stamps it.
 *
 * The only source whose companies arrive with an industry label instead of a
 * description, which is why the methodology singles it out.
 */
export const REGISTER_SOURCE = 'dpiit-startup-india';

/**
 * What became of the register's companies, counted rather than written down.
 *
 * The methodology used to say "sixty-one per cent of register companies were
 * placed in no sub-sector at all" as a hand-written number. It was true when
 * written and spanned two findings that mean opposite things, so it now comes
 * from the database and arrives already split.
 */
export interface RegisterOutcomes {
	total: number;
	placed: number;
	/** The RDI taxonomy has no cell for what they build. */
	taxonomyGap: number;
	/** The register published a name and a dropdown label, and we would not guess from that. */
	undescribed: number;
}

export interface Gaps {
	total: number;
	groups: GapGroup[];
	/** Holes in the RDI taxonomy: a field it has no cell for. A finding about the scheme. */
	taxonomy: { total: number; groups: GapGroup[] };
	/** Companies whose published description was too thin to place. A finding about our sources. */
	undescribed: { total: number; groups: GapGroup[] };
}

/** How the current filters split three ways. The page states all three out loud. */
export interface Buckets {
	/** Dated and recent enough for the ranked list. */
	ranked: number;
	/** Dated, but older than the age gate allows. */
	older: number;
	/** No date at all, from any source. */
	undated: number;
	/**
	 * Ranked, but with no founding year to judge — a recognition register dates the
	 * record without saying when the company started. Part of `ranked`, not a fourth
	 * bucket: they are listed, they just cannot be aged.
	 */
	unknownAge: number;
}

export interface CoverageCell {
	subsector_id: string;
	subsector: string;
	n: number;
}

export interface CoverageSector {
	sector_id: string;
	sector: string;
	sector_name: string;
	subsectors: CoverageCell[];
}

export interface Coverage {
	subsector_count: number;
	covered: number;
	total_companies: number;
	off_map: number;
	unclassified: number;
	sectors: CoverageSector[];
}

/**
 * When a company started, as well as anyone will tell us: incubated or founded,
 * whichever is earlier. MIN() goes NULL the moment either side is, which is what the
 * COALESCE chain behind it is for.
 */
const ORIGIN_YEAR = 'COALESCE(MIN(c.origin_year, c.founded_year), c.origin_year, c.founded_year)';

/**
 * Every filter as a clause and its binds, in the order they have to be bound. Built as
 * a list rather than numbered placeholders: there are five optional conditions now,
 * and hand-counting `?7` against a variable-length tier set is how a filter silently
 * starts matching the wrong column.
 */
function conditions(filters: Filters): { clauses: string[]; binds: unknown[] } {
	const clauses: string[] = [];
	const binds: unknown[] = [];

	if (filters.sector) {
		clauses.push('c.sector_id = ?');
		binds.push(filters.sector);
	}
	if (filters.subsector) {
		clauses.push('c.subsector_id = ?');
		binds.push(filters.subsector);
	}

	// A set rather than a single value: the page's default toggle is A+B, and the API
	// passes a set of one.
	const tiers = filters.tiers ?? [];
	if (tiers.length > 0) {
		clauses.push(`c.tier IN (${new Array(tiers.length).fill('?').join(', ')})`);
		binds.push(...tiers);
	}

	if (filters.dated === 'dated') clauses.push('c.first_seen IS NOT NULL');
	if (filters.dated === 'undated') clauses.push('c.first_seen IS NULL');

	if (filters.minOriginYear !== null) {
		// An unknown origin year is not an old one, so those rows stay put.
		clauses.push(`(${ORIGIN_YEAR} IS NULL OR ${ORIGIN_YEAR} >= ?)`);
		binds.push(filters.minOriginYear);
	}

	return { clauses, binds };
}

function whereSql(clauses: string[]): string {
	return clauses.length > 0 ? `WHERE ${clauses.join('\n  AND ')}` : '';
}

/**
 * One row per company with its signals attached as JSON, tier first and newest first
 * inside a tier. Undated rows sort last within their tier, which is where SQLite puts
 * a NULL under DESC anyway and where they belong.
 */
export async function queryCompanies(env: Env, filters: Filters): Promise<Company[]> {
	const { clauses, binds } = conditions(filters);
	const sql = `
SELECT c.*,
  (SELECT json_group_array(json_object(
      'type', s.type, 'label', s.label, 'url', s.url, 'date', s.date))
   FROM signals s WHERE s.company_id = c.id) AS signals
FROM companies c
${whereSql(clauses)}
ORDER BY
  CASE c.tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END,
  c.first_seen DESC
LIMIT ?`;

	const { results } = await env.DB.prepare(sql)
		.bind(...binds, filters.limit)
		.all<Record<string, unknown>>();

	return results.map((row) => ({ ...row, signals: parseSignals(row.signals) }) as unknown as Company);
}

/**
 * The three buckets the current sector, sub-sector and tier filters split into. One
 * query rather than three counts, so the numbers on the page cannot disagree with
 * each other — "showing 12, 30 older, 42 undated" has to add up.
 */
export async function queryBuckets(env: Env, filters: Filters, minOriginYear: number): Promise<Buckets> {
	// The date state and the age gate are what we are counting, so they must not also
	// filter the count. Neither may the tier toggle: it belongs to the ranking, so it
	// narrows the first two buckets from inside the CASE and leaves the undated one
	// alone — which is exactly how the two sections of the page behave.
	const { clauses, binds } = conditions({ ...filters, tiers: null, dated: null, minOriginYear: null });
	const tiers = filters.tiers ?? [];
	const ranked = tiers.length > 0 ? `AND c.tier IN (${new Array(tiers.length).fill('?').join(', ')})` : '';
	const sql = `
SELECT
  SUM(CASE WHEN c.first_seen IS NOT NULL AND (${ORIGIN_YEAR} IS NULL OR ${ORIGIN_YEAR} >= ?) ${ranked} THEN 1 ELSE 0 END) AS ranked,
  SUM(CASE WHEN c.first_seen IS NOT NULL AND ${ORIGIN_YEAR} < ? ${ranked} THEN 1 ELSE 0 END) AS older,
  SUM(CASE WHEN c.first_seen IS NULL THEN 1 ELSE 0 END) AS undated,
  SUM(CASE WHEN c.first_seen IS NOT NULL AND ${ORIGIN_YEAR} IS NULL ${ranked} THEN 1 ELSE 0 END) AS unknown_age
FROM companies c
${whereSql(clauses)}`;

	const row = await env.DB.prepare(sql)
		.bind(minOriginYear, ...tiers, minOriginYear, ...tiers, ...tiers, ...binds)
		.first<{ ranked: number | null; older: number | null; undated: number | null; unknown_age: number | null }>();

	// SUM over no rows is NULL, not 0.
	return {
		ranked: row?.ranked ?? 0,
		older: row?.older ?? 0,
		undated: row?.undated ?? 0,
		unknownAge: row?.unknown_age ?? 0,
	};
}

function parseSignals(raw: unknown): Signal[] {
	if (typeof raw !== 'string') return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * The counts come from the companies table, but the LIST of sub-sectors comes from the
 * taxonomy — all 44, including the empty ones. Grouping the table alone would make
 * empty sub-sectors vanish and the map would be a lie.
 */
export async function queryCoverage(env: Env): Promise<Coverage> {
	const { results } = await env.DB.prepare('SELECT subsector_id, COUNT(*) AS n FROM companies GROUP BY subsector_id').all<{
		subsector_id: string | null;
		n: number;
	}>();

	const counts = new Map<string, number>();
	let totalCompanies = 0;
	let offMap = 0;
	let unclassified = 0;

	for (const row of results) {
		totalCompanies += row.n;
		if (row.subsector_id === null || row.subsector_id === '') {
			unclassified += row.n;
			offMap += row.n;
		} else if (SUNRISE_SUBSECTOR_IDS.has(row.subsector_id)) {
			counts.set(row.subsector_id, row.n);
		} else {
			// Sector 6 catch-alls, or an id the taxonomy no longer has.
			offMap += row.n;
		}
	}

	let covered = 0;
	const sectors = SUNRISE_SECTORS.map((group) => ({
		sector_id: group.sector_id,
		sector: group.sector,
		sector_name: group.sector_name,
		subsectors: group.subsectors.map((sub) => {
			const n = counts.get(sub.subsector_id) ?? 0;
			if (n > 0) covered += 1;
			return { subsector_id: sub.subsector_id, subsector: sub.subsector, n };
		}),
	}));

	return {
		subsector_count: SUNRISE_SUBSECTOR_IDS.size,
		covered,
		total_companies: totalCompanies,
		off_map: offMap,
		unclassified,
		sectors,
	};
}

/**
 * Companies with a sector but no sub-sector, grouped by the hole they fell
 * through, commonest first.
 *
 * group_concat gives us a few names per group without a query per group. Its
 * order is unspecified, which is fine: these are examples, not a ranking, and
 * the page says so.
 */
export async function queryGaps(env: Env): Promise<Gaps> {
	const { results } = await env.DB.prepare(
		`SELECT missing, COUNT(*) AS n, group_concat(name, '\n') AS names
		 FROM gaps GROUP BY missing ORDER BY n DESC, missing`,
	).all<{ missing: string; n: number; names: string | null }>();

	const groups = results.map((row) => {
		return {
			missing: row.missing,
			n: row.n,
			examples: (row.names ?? '').split('\n').filter(Boolean).slice(0, 3),
		};
	});

	return splitGaps(groups);
}

/**
 * Two different findings, and the page states them as two. One says the RDI scheme
 * has no cell for a field; the other says we could not describe the company well
 * enough to try. Counting them together let the second hide inside the first — and
 * the second was the larger of the two.
 *
 * Exported so the sample data splits by the same rule as the real thing.
 */
export function splitGaps(groups: GapGroup[]): Gaps {
	const sum = (rows: GapGroup[]) => rows.reduce((n, g) => n + g.n, 0);
	const undescribed = groups.filter((g) => g.missing === NO_GAP_NAMED);
	const taxonomy = groups.filter((g) => g.missing !== NO_GAP_NAMED);
	return {
		total: sum(groups),
		groups,
		taxonomy: { total: sum(taxonomy), groups: taxonomy },
		undescribed: { total: sum(undescribed), groups: undescribed },
	};
}

export async function queryRegisterOutcomes(env: Env): Promise<RegisterOutcomes> {
	const row = await env.DB.prepare(
		`SELECT
		   (SELECT COUNT(DISTINCT company_id) FROM signals WHERE source = ?1) AS placed,
		   (SELECT COUNT(*) FROM gaps WHERE source = ?1 AND missing = ?2)     AS undescribed,
		   (SELECT COUNT(*) FROM gaps WHERE source = ?1 AND missing != ?2)    AS taxonomy_gap`,
	)
		.bind(REGISTER_SOURCE, NO_GAP_NAMED)
		.first<{ placed: number; undescribed: number; taxonomy_gap: number }>();

	const placed = row?.placed ?? 0;
	const undescribed = row?.undescribed ?? 0;
	const taxonomyGap = row?.taxonomy_gap ?? 0;
	return { total: placed + undescribed + taxonomyGap, placed, taxonomyGap, undescribed };
}

/**
 * Is there anything in the ranking yet?
 *
 * While every row came from a backfill, A and B are empty by construction, and a page
 * whose default view is empty is a broken page. The default toggle reads this and
 * opens on everything until the first real discovery lands, then goes back to A+B on
 * its own.
 */
export async function queryHasRanked(env: Env): Promise<boolean> {
	const row = await env.DB.prepare("SELECT 1 AS found FROM companies WHERE tier IN ('A', 'B') LIMIT 1").first<{ found: number }>();
	return row !== null;
}

/**
 * Real discoveries since `since` — the header's "discovered this week".
 *
 * Deliberately not a count of rows added: a backfill adds hundreds in an afternoon
 * and none of them are this week's news. Only a first_seen we earned counts.
 */
/**
 * How many companies have at most one public trace.
 *
 * The page's whole claim is that these companies are unknown, and this is the number
 * that shows it instead of asserting it: one trace means exactly one institution
 * anywhere has said this company exists. `<= 1` rather than `= 1` because a company
 * found only through a patent or an incorporation carries no trace at all, and that is
 * less known, not more — the label above it says "at most" for that reason.
 *
 * Counted here rather than typed into the template, like every other number on this
 * page: a hand-written figure is true until the next run.
 */
export async function queryOneTraceCount(env: Env): Promise<number> {
	const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM companies WHERE trace_count <= 1').first<{ n: number }>();
	return row?.n ?? 0;
}

export async function queryDiscoveredSince(env: Env, since: string): Promise<number> {
	const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM companies WHERE first_seen_basis = 'discovered' AND first_seen >= ?1")
		.bind(since)
		.first<{ n: number }>();
	return row?.n ?? 0;
}
