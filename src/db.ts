/**
 * Every read the page and the API share. These return data, not Responses, so the
 * server-rendered page and the JSON endpoints can never drift apart.
 */
import { SUNRISE_SECTORS, SUNRISE_SUBSECTOR_IDS } from './taxonomy';
import type { Tier } from './rank';

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
	city: string | null;
	state: string | null;
	cin: string | null;
	founded_year: number | null;
	sector_id: string | null;
	subsector_id: string | null;
	project_type: string | null;
	classify_note: string | null;
	first_seen: string;
	trace_count: number;
	tier: Tier;
	updated_at: string;
	signals: Signal[];
}

export interface Filters {
	sector: string | null;
	subsector: string | null;
	/** null or empty means every tier. */
	tiers: Tier[] | null;
	limit: number;
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
 * One row per company with its signals attached as JSON, tier first and newest first
 * inside a tier. The `?n IS NULL OR ...` filters let one statement serve every
 * combination of filters. The tier clause is a set rather than a single value because
 * the page's default toggle is A+B; the API passes a set of one.
 */
function listSql(tierCount: number): string {
	const tierClause = tierCount > 0 ? `AND c.tier IN (${new Array(tierCount).fill('?').join(', ')})` : '';
	return `
SELECT c.*,
  (SELECT json_group_array(json_object(
      'type', s.type, 'label', s.label, 'url', s.url, 'date', s.date))
   FROM signals s WHERE s.company_id = c.id) AS signals
FROM companies c
WHERE (?1 IS NULL OR c.sector_id = ?1)
  AND (?2 IS NULL OR c.subsector_id = ?2)
  ${tierClause}
ORDER BY
  CASE c.tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END,
  c.first_seen DESC
LIMIT ?${3 + tierCount}`;
}

export async function queryCompanies(env: Env, filters: Filters): Promise<Company[]> {
	const tiers = filters.tiers ?? [];
	const { results } = await env.DB.prepare(listSql(tiers.length))
		.bind(filters.sector, filters.subsector, ...tiers, filters.limit)
		.all<Record<string, unknown>>();

	return results.map((row) => ({ ...row, signals: parseSignals(row.signals) }) as unknown as Company);
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

/** Companies whose first_seen falls on or after `since` — the header's "added this week". */
export async function queryAddedSince(env: Env, since: string): Promise<number> {
	const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM companies WHERE first_seen >= ?1').bind(since).first<{ n: number }>();
	return row?.n ?? 0;
}
