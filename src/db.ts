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
	/** Which scraper saw it. Only the detail view asks; the list has no room to say. */
	source?: string;
	/** When we recorded it, as against `date`, which is when it happened. */
	found_at?: string;
	/** When the page or list carrying it was published, where it says. Never an event date. */
	published?: string | null;
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
	/** One sentence from the company's own homepage. Never a verified fact — see below. */
	product: string | null;
	/**
	 * Why there is or is not a product line. NULL means nobody has looked yet;
	 * 'described' is the only value that comes with a sentence. The others —
	 * 'unreachable', 'refused', 'thin', 'unclear' — are the page's material for
	 * saying what it cannot see instead of leaving a cell blank.
	 */
	product_status: string | null;
	/**
	 * Whether the website is theirs: 'discovered' (an address nothing ties to them),
	 * 'associated' (their source record gives it, their name is not on it), 'verified'
	 * (their name is), or NULL (no website, or not checked yet). Migration 0008.
	 */
	website_identity: string | null;
	website_identity_note: string | null;
	/** A year the source printed beside the name, meaning unstated. Never an age. */
	source_year: number | null;
	source_year_type: string | null;
	/** company, researcher-project, lab or unverified; NULL is read as company. */
	entity_type: string | null;
	entity_note: string | null;
	/** The founders a source names, in its words, and which source. Migration 0018. */
	founders: string | null;
	founders_source: string | null;
	/** Which source's words the description is. Migration 0023. */
	description_source: string | null;
	/**
	 * What the DPIIT register's record says: 'recognised', 'expired', 'cancelled',
	 * 'pending', or 'profile' (on Startup India, never recognised). NULL: not on it.
	 */
	dpiit_status: string | null;
	/** The stage the company chose on its register profile ("Prototype"). */
	dpiit_stage: string | null;
	/** From a verified homepage only: an address on its own domain, a contact page. */
	contact_email: string | null;
	contact_page: string | null;
	/** The website domain's RDAP registration date. The domain's age, not the company's. */
	domain_registered: string | null;
	/** The Wayback Machine's first copy of the homepage. When the web noticed the page, not the company's age. */
	web_first_capture: string | null;
	/** JSON arrays of keyword tags read from a real description (ingest/tags.py). NULL: not computed yet. */
	build_tags: string | null;
	/** JSON: careers url and roles, team page, code account, parked, homepage versions over two years. */
	site_signals: string | null;
	/** JSON list of public programmes (src/programmes.ts), their count, and publishing organisations. */
	programmes: string | null;
	programme_count: number;
	organisation_count: number;
	domain_tags: string | null;
	/** JSON: {count, works: [{title, year, url}], query_url} from OpenAlex affiliations. */
	papers: string | null;
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
	/**
	 * Free text, matched against the name and against both descriptions of what the
	 * company does. null and empty are the same thing: no search.
	 */
	search: string | null;
	/** Which scraper found it — one of SOURCES, or null for any. */
	source: string | null;
	/** Whether it publishes a website. See SiteState: 'none' is a claim, not an absence. */
	site: SiteState | null;
	/** A state as a source wrote it, or 'unknown' for records with none. null for any. */
	state?: string | null;
	/** How many public traces: one or none, two, three or more. null for any. */
	traces?: TraceBucket | null;
	/**
	 * Whose words say what the company builds, if anyone's: one state, 'said' for own or
	 * source, 'unsaid' for label or none. null for any. The page defaults to 'said'.
	 */
	described?: DescribedChoice | null;
	/** 'company' for companies, 'other' for research projects and unverified names. null for both. */
	kind?: KindChoice | null;
	/** What the DPIIT register's record says — see DPIIT_STATUS_PHRASES. null for any. */
	dpiit?: string | null;
	/** At least this many public programmes: 2 or 3. */
	programmesAtLeast?: number | null;
	/** No public trace beyond the programmes' own lists: no website of their own, no press. */
	alone?: boolean;
	/** Only companies exactly one outside source has noticed (their own website not counted). */
	noticedOnce?: boolean;
	/** Exactly these ids, as a shortlist export asks for them. */
	ids?: string[] | null;
	/** A keyword tag for what it builds (BUILD_TAGS), or null for any. */
	build?: string | null;
	/** A keyword tag for where it is used (DOMAIN_TAGS), or null for any. */
	domain?: string | null;
	/** How the list is ordered. See SORTS. */
	sort: SortChoice;
	limit: number;
}

/**
 * The four sources, as the ingest writes them. Listed so a filter cannot be handed an
 * arbitrary string and quietly return nothing, which looks identical to "no matches".
 */
export const SOURCES = ['sine-iitb', 'rtbi-iitm', 'grants-csv', 'dpiit-startup-india', 'venture-center', 'nmicps-tih', 'fsid-iisc', 'tides-iitr'] as const;

/**
 * 'has' is simple. 'none' is not an absence but an assertion — a source that publishes
 * websites went looking and came back empty — because a register with no website field
 * has said nothing at all about whether one exists, and filtering those in would turn
 * that silence into a finding.
 */
export type SiteState = 'has' | 'none';

export type SortChoice = 'obscurity' | 'newest' | 'quietest' | 'described' | 'programmes' | 'name';

/**
 * Trace counts in the three groups the page draws. "One or none" is one group because
 * the headline's claim is "one public trace at most"; a company found only through a
 * patent or an incorporation has none, and is less known rather than more.
 */
export const TRACE_BUCKETS = ['1', '2', '3+'] as const;
export type TraceBucket = (typeof TRACE_BUCKETS)[number];
const TRACE_SQL: Record<TraceBucket, string> = {
	'1': 'c.trace_count <= 1',
	'2': 'c.trace_count = 2',
	'3+': 'c.trace_count >= 3',
};

/**
 * Whose words say what a company builds.
 *
 * 'own': a sentence read from a homepage checked to be theirs. 'source': an incubator's
 * or a grant list's description. 'label': nothing but the DPIIT register's dropdown
 * ("DPIIT-recognised startup. Industry: AI. Sector: NLP."), which is not a description.
 * 'none': no text at all. The shape of the register's line is the test, not the
 * classification basis: RELSYM was classified as a SINE row and its only text is the
 * register's. src/page.ts's describedBySource is the same rule for one company.
 */
export const DESCRIBED_STATES = ['own', 'source', 'label', 'none'] as const;
export type DescribedState = (typeof DESCRIBED_STATES)[number];

/**
 * The two halves the page is split into. 'said' — a sentence, from their homepage or a
 * source, says what they build — is what the list shows by default; 'unsaid' is the
 * rest, counted and one link away. A name and a dropdown industry is a record, not a lead.
 */
export const DESCRIBED_CHOICES = [...DESCRIBED_STATES, 'said', 'unsaid'] as const;
export type DescribedChoice = (typeof DESCRIBED_CHOICES)[number];

export const KIND_CHOICES = ['company', 'other'] as const;
export type KindChoice = (typeof KIND_CHOICES)[number];
/**
 * The keyword vocabularies ingest/tags.py writes, in its order. Kept here so a filter can refuse
 * a value no row can carry rather than quietly return nothing.
 */
export const BUILD_TAGS = ['hardware', 'software', 'biological or chemical'] as const;
export const DOMAIN_TAGS = [
	'health',
	'agriculture & food',
	'energy',
	'mobility',
	'space & aerospace',
	'defence & security',
	'water & environment',
	'manufacturing & industry',
	'buildings & construction',
	'education',
	'finance',
] as const;

export interface SiteSignals {
	careers: string | null;
	careers_hosted: string | null;
	roles: number | null;
	says_no_openings: boolean;
	team: string | null;
	repo: string | null;
	parked: boolean;
	versions: number | null;
	last_change: string | null;
	since: string | null;
}

/** The stored site signals, or null when missing or malformed. */
export function siteSignalsOf(raw: string | null | undefined): SiteSignals | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as SiteSignals) : null;
	} catch {
		return null;
	}
}

/** A stored tag list, or [] for a missing or malformed one. */
export function tagsOf(raw: string | null | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
	} catch {
		return [];
	}
}

export const REGISTER_LABEL_PREFIX = 'DPIIT-recognised startup. Industry:';
/**
 * What BIRAC's BIG lists print where a project title would be: the category the award was
 * filed under (ingest/sources/grants_csv.py). A label from a fixed list of six, like the
 * register's dropdown, and treated as one everywhere a description is judged.
 */
export const GRANT_LABEL_PREFIX = 'BIRAC Biotechnology Ignition Grant awardee, category:';

/** Which kind of list label a description is, or null for a real description. */
export function labelKind(description: string | null): 'register' | 'grant' | null {
	if (!description) return null;
	if (description.startsWith(REGISTER_LABEL_PREFIX)) return 'register';
	if (description.startsWith(GRANT_LABEL_PREFIX)) return 'grant';
	return null;
}

/** The same test in SQL, for a description column. */
export function labelSql(column: string): string {
	return `(substr(${column}, 1, ${REGISTER_LABEL_PREFIX.length}) = '${REGISTER_LABEL_PREFIX}' OR substr(${column}, 1, ${GRANT_LABEL_PREFIX.length}) = '${GRANT_LABEL_PREFIX}')`;
}

/**
 * What the register's record says about recognition, in a phrase. The stored label
 * starts "DPIIT-recognised startup." for every register record, because that string is
 * what the classifier's cache is keyed on; this is what the page prints in its place.
 * NULL is a row written before the status was stored, and claims nothing either way.
 */
export const DPIIT_STATUS_PHRASES: Record<string, string> = {
	recognised: 'DPIIT recognised',
	expired: 'DPIIT recognition expired',
	cancelled: 'DPIIT recognition cancelled',
	pending: 'Startup India profile, DPIIT recognition pending',
	profile: 'Startup India profile, not DPIIT recognised',
};

/** A register label with its first sentence saying what the record actually says. */
export function registerText(description: string | null, status: string | null): string | null {
	if (!description || !description.startsWith(REGISTER_LABEL_PREFIX)) return description;
	const phrase = status ? DPIIT_STATUS_PHRASES[status] : null;
	return description.replace(/^DPIIT-recognised startup\./, phrase ? `${phrase}.` : 'On the DPIIT Startup India register.');
}

export interface PapersFound {
	count: number;
	works: { title: string; year: number | null; url: string }[];
	query_url: string;
}

/** The stored papers JSON, or null when it is missing or not the shape ingest writes. */
export function papersOf(raw: string | null): PapersFound | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as PapersFound;
		return typeof parsed?.count === 'number' && Array.isArray(parsed.works) ? parsed : null;
	} catch {
		return null;
	}
}
/**
 * Whose words say what a company builds: 'own', 'source', 'label' or 'none'. A generated column
 * since migration 0028, with this expression, so filters on it use an index; SAID_STATE_SQL is
 * the expression itself, pinned against the migration by a test.
 */
export const SAID_STATE_SQL = `CASE
  WHEN COALESCE(product, '') <> '' AND website_identity = 'verified' THEN 'own'
  WHEN COALESCE(description, '') <> '' AND NOT ${labelSql('description')} THEN 'source'
  WHEN COALESCE(description, '') <> '' THEN 'label'
  ELSE 'none' END`;
const DESCRIBED_SQL = 'c.said_state';

/**
 * The orderings, as SQL, keyed by the only names the URL is allowed to use.
 *
 * A map rather than a string from the querystring, for the obvious reason. The default
 * is the one the page is an argument for: tier first, newest inside a tier.
 */
export const SORTS: Record<SortChoice, string> = {
	obscurity: `CASE c.tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END, c.first_seen DESC`,
	newest: 'c.first_seen DESC',
	// The list's own logic, made explicit: fewest traces first. Ties break to the most
	// recently on record, so the top of this list is the newest of the least known.
	quietest: 'c.trace_count ASC, c.first_seen DESC',
	// What a reader can form a view from: their own words, a source's sentence, a site checked
	// as theirs, named founders, a way to reach them, a date. Least traced first within a score.
	described: `(CASE WHEN COALESCE(c.product, '') <> '' AND c.website_identity = 'verified' THEN 2 ELSE 0 END
	  + CASE WHEN COALESCE(c.description, '') <> '' AND NOT ${labelSql('c.description')} THEN 1 ELSE 0 END
	  + CASE WHEN c.website_identity = 'verified' THEN 1 ELSE 0 END
	  + CASE WHEN COALESCE(c.founders, '') <> '' THEN 1 ELSE 0 END
	  + CASE WHEN COALESCE(c.contact_email, '') <> '' OR COALESCE(c.contact_page, '') <> '' THEN 1 ELSE 0 END
	  + CASE WHEN c.first_seen IS NOT NULL THEN 1 ELSE 0 END) DESC, c.trace_count ASC, c.name ASC`,
	// Most public programmes first; among equals, the least traced.
	programmes: 'c.programme_count DESC, c.trace_count ASC, c.name ASC',
	name: 'c.name ASC',
};

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
	/**
	 * Everything the sector, sub-sector, search, source and website filters match —
	 * the number a coverage cell shows when only its sub-sector is chosen. The four
	 * parts below are disjoint and always add up to it, so the page can account for
	 * every company it is not showing.
	 */
	total: number;
	/** Dated, inside the age gate, inside the tier choice: the ranked list. */
	ranked: number;
	/** No date at all, from any source. The section under the ranking. */
	undated: number;
	/** Dated, and started before the age gate allows. 0 when the gate is off. */
	older: number;
	/** Dated, inside the age gate, and in a tier the current choice leaves out. */
	tierHidden: number;
	/**
	 * Ranked, but with no founding year to judge — a recognition register dates the
	 * record without saying when the company started. Part of `ranked`, not a fifth
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

	// LIKE over three columns, on a few hundred rows. FTS5 would be the right answer
	// at a hundred times this size and is theatre at this one — it would add a shadow
	// table and a trigger to keep in step, to save a scan that takes under a
	// millisecond. The escape is there because a founder's name really can contain a
	// percent sign, and an unescaped one silently matches everything.
	const search = filters.search?.trim();
	if (search) {
		const term = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
		clauses.push(`(c.name LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\' OR c.product LIKE ? ESCAPE '\\')`);
		binds.push(term, term, term);
	}

	// EXISTS rather than a join: a company can carry two signals from one source, and
	// a join would return it twice and make the list disagree with its own count.
	if (filters.source) {
		clauses.push('EXISTS (SELECT 1 FROM signals s WHERE s.company_id = c.id AND s.source = ?)');
		binds.push(filters.source);
	}

	if (filters.state === 'unknown') clauses.push("COALESCE(c.state, '') = ''");
	else if (filters.state) {
		clauses.push('c.state = ?');
		binds.push(filters.state);
	}

	if (filters.traces && filters.traces in TRACE_SQL) clauses.push(TRACE_SQL[filters.traces]);
	// said_state and is_company are generated columns (migration 0028) with an index, so the default
	// half is read through the index instead of computing a CASE for every row.
	if (filters.described === 'said') clauses.push(`c.said_state IN ('own', 'source')`);
	else if (filters.described === 'unsaid') clauses.push(`c.said_state IN ('label', 'none')`);
	else if (filters.described) {
		clauses.push(`c.said_state = ?`);
		binds.push(filters.described);
	}
	if (filters.kind === 'company') clauses.push('c.is_company = 1');
	if (filters.kind === 'other') clauses.push('c.is_company = 0');
	if (filters.dpiit) {
		clauses.push('c.dpiit_status = ?');
		binds.push(filters.dpiit);
	}
	if (filters.programmesAtLeast) {
		clauses.push('c.programme_count >= ?');
		binds.push(filters.programmesAtLeast);
	}
	if (filters.alone) clauses.push('c.other_count = 0');
	if (filters.noticedOnce) clauses.push('c.outside_count = 1');
	if (filters.ids?.length) {
		clauses.push(`c.id IN (${filters.ids.map(() => '?').join(', ')})`);
		binds.push(...filters.ids);
	}
	if (filters.build) {
		clauses.push('EXISTS (SELECT 1 FROM json_each(c.build_tags) WHERE json_each.value = ?)');
		binds.push(filters.build);
	}
	if (filters.domain) {
		clauses.push('EXISTS (SELECT 1 FROM json_each(c.domain_tags) WHERE json_each.value = ?)');
		binds.push(filters.domain);
	}

	if (filters.site === 'has') clauses.push("c.website IS NOT NULL AND c.website <> ''");
	// Only where somebody looked. See SiteState.
	if (filters.site === 'none') clauses.push("c.website_checked = 1 AND (c.website IS NULL OR c.website = '')");

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
ORDER BY ${SORTS[filters.sort] ?? SORTS.obscurity}
LIMIT ?`;

	const { results } = await env.DB.prepare(sql)
		.bind(...binds, filters.limit)
		.all<Record<string, unknown>>();

	return results.map((row) => ({ ...row, signals: parseSignals(row.signals) }) as unknown as Company);
}

/**
 * One company, with everything known about it.
 *
 * Deliberately unfiltered: the age gate, the tier toggle and the sub-sector filter all
 * shape a list, and none of them has any business deciding whether a company you asked
 * for by name exists. A row held back from the front page still has a page.
 */
export async function queryCompany(env: Env, id: string): Promise<Company | null> {
	const row = await env.DB.prepare(
		`SELECT c.*,
  (SELECT json_group_array(json_object(
      'type', s.type, 'label', s.label, 'url', s.url, 'date', s.date, 'source', s.source, 'found_at', s.found_at, 'published', s.published))
   FROM signals s WHERE s.company_id = c.id) AS signals
FROM companies c WHERE c.id = ?`,
	)
		.bind(id)
		.first<Record<string, unknown>>();

	if (row === null) return null;
	return { ...row, signals: parseSignals(row.signals) } as unknown as Company;
}

/**
 * The three buckets the current sector, sub-sector and tier filters split into. One
 * query rather than three counts, so the numbers on the page cannot disagree with
 * each other — "showing 12, 30 older, 42 undated" has to add up.
 */
export async function queryBuckets(env: Env, filters: Filters): Promise<Buckets> {
	// The date state, the age gate and the tier choice are what is being counted, so
	// none of them may also filter the count. Each becomes a condition inside the SUM
	// instead, built once and used in every bucket that needs it, in bind order.
	const { clauses, binds } = conditions({ ...filters, tiers: null, dated: null, minOriginYear: null });
	const gate = filters.minOriginYear;
	const tiers = filters.tiers ?? [];

	const aged = gate === null ? { sql: '0', binds: [] as unknown[] } : { sql: `(${ORIGIN_YEAR} IS NOT NULL AND ${ORIGIN_YEAR} < ?)`, binds: [gate] };
	const inTier = tiers.length ? { sql: `c.tier IN (${tiers.map(() => '?').join(', ')})`, binds: [...tiers] } : { sql: '1', binds: [] as unknown[] };

	const sql = `
SELECT
  COUNT(*) AS total,
  SUM(CASE WHEN c.first_seen IS NULL THEN 1 ELSE 0 END) AS undated,
  SUM(CASE WHEN c.first_seen IS NOT NULL AND ${aged.sql} THEN 1 ELSE 0 END) AS older,
  SUM(CASE WHEN c.first_seen IS NOT NULL AND NOT ${aged.sql} AND NOT ${inTier.sql} THEN 1 ELSE 0 END) AS tier_hidden,
  SUM(CASE WHEN c.first_seen IS NOT NULL AND NOT ${aged.sql} AND ${inTier.sql} THEN 1 ELSE 0 END) AS ranked,
  SUM(CASE WHEN c.first_seen IS NOT NULL AND NOT ${aged.sql} AND ${inTier.sql} AND ${ORIGIN_YEAR} IS NULL THEN 1 ELSE 0 END) AS unknown_age
FROM companies c
${whereSql(clauses)}`;

	const row = await env.DB.prepare(sql)
		.bind(
			...aged.binds,
			...aged.binds,
			...inTier.binds,
			...aged.binds,
			...inTier.binds,
			...aged.binds,
			...inTier.binds,
			...binds,
		)
		.first<Record<string, number | null>>();

	// SUM over no rows is NULL, not 0.
	const n = (key: string) => Number(row?.[key] ?? 0);
	return {
		total: n('total'),
		ranked: n('ranked'),
		undated: n('undated'),
		older: n('older'),
		tierHidden: n('tier_hidden'),
		unknownAge: n('unknown_age'),
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

/**
 * What came of looking at company websites, counted.
 *
 * The page states these as a paragraph rather than marking up every row that has no
 * product line, for the same reason the off-map companies are grouped: seventy rows
 * each apologising for themselves is noise, and one sentence saying "forty-one
 * companies publish an address that no longer answers" is a finding.
 */
export interface ProductOutcomes {
	/** Companies with a website we have not yet read, or never will. */
	total: number;
	/** Has a website at all. */
	withSite: number;
	/** We read it and it said. */
	described: number;
	/** The domain did not answer. */
	unreachable: number;
	/** The site refused an automated reader. */
	refused: number;
	/** It loaded and carried no readable text. */
	thin: number;
	/** There was text and it never said what they build. */
	unclear: number;
	/** It answered, and nothing confirmed the address is theirs, so it was not read. */
	unverified: number;
	/** An address nothing ties to the company: shared, a profile, or a different business. */
	notTheirs: number;
	/** A source that publishes websites looked, and this company has none. */
	noSite: number;
}

export async function queryProductOutcomes(env: Env): Promise<ProductOutcomes> {
	const row = await env.DB.prepare(
		`SELECT
		   COUNT(*)                                                                  AS total,
		   SUM(website IS NOT NULL AND website <> '')                                AS with_site,
		   SUM(product_status = 'described')                                         AS described,
		   SUM(product_status = 'unreachable')                                       AS unreachable,
		   SUM(product_status = 'refused')                                           AS refused,
		   SUM(product_status = 'thin')                                              AS thin,
		   SUM(product_status = 'unclear')                                           AS unclear,
		   SUM(product_status = 'unverified')                                        AS unverified,
		   SUM(website_identity = 'discovered')                                      AS not_theirs,
		   SUM(website_checked = 1 AND (website IS NULL OR website = ''))            AS no_site
		 FROM companies`,
	).first<Record<string, number | null>>();

	const n = (key: string) => Number(row?.[key] ?? 0);
	return {
		total: n('total'),
		withSite: n('with_site'),
		described: n('described'),
		unreachable: n('unreachable'),
		refused: n('refused'),
		thin: n('thin'),
		unclear: n('unclear'),
		unverified: n('unverified'),
		notTheirs: n('not_theirs'),
		noSite: n('no_site'),
	};
}

/**
 * A private note, and the company it is about.
 *
 * Notes live in their own table and are read by their own queries, never by a
 * `SELECT c.*` that some public handler also runs. The separation is the safety
 * property; these four functions are the only way in.
 */
export interface Note {
	company_id: string;
	body: string;
	author: string;
	created_at: string;
	updated_at: string;
}

/** A note with enough of its company to list it without a second query. */
export interface NoteWithCompany extends Note {
	name: string | null;
	product: string | null;
	subsector_id: string | null;
}

export async function queryNote(env: Env, companyId: string): Promise<Note | null> {
	return env.DB.prepare('SELECT * FROM notes WHERE company_id = ?').bind(companyId).first<Note>();
}

/**
 * Every note, most recently touched first — the notebook, in the order a notebook is
 * useful. LEFT JOIN because a note about a company that has since dropped out of the
 * list is still a note, and losing it silently would be the worst failure this table
 * has.
 */
export async function queryNotes(env: Env): Promise<NoteWithCompany[]> {
	const { results } = await env.DB.prepare(
		`SELECT n.*, c.name, c.product, c.subsector_id
     FROM notes n LEFT JOIN companies c ON c.id = n.company_id
     ORDER BY n.updated_at DESC`,
	).all<NoteWithCompany>();
	return results;
}

/** Write or replace one note. created_at survives an edit; updated_at does not. */
export async function saveNote(env: Env, companyId: string, body: string, author: string): Promise<void> {
	const now = new Date().toISOString();
	await env.DB.prepare(
		`INSERT INTO notes (company_id, body, author, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT(company_id) DO UPDATE SET
       body = excluded.body,
       author = excluded.author,
       updated_at = excluded.updated_at`,
	)
		.bind(companyId, body, author, now)
		.run();
}

export async function deleteNote(env: Env, companyId: string): Promise<void> {
	await env.DB.prepare('DELETE FROM notes WHERE company_id = ?').bind(companyId).run();
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
 * Would the default A+B list show anything?
 *
 * While every row came from a backfill, A and B are empty by construction, and a page
 * whose default view is empty is a broken page. The default toggle reads this and
 * opens on everything until something qualifies, then goes back to A+B on its own.
 *
 * Asked with the age gate the default list applies, not of the tier column alone: a
 * Tier B row whose origin year is past the gate is a row the default list will not show,
 * and counting it here would open the page on an empty list after all.
 */
/**
 * Fewer Tier A and B rows than this in the half being shown, and the list opens on every
 * tier instead. One row under a headline of hundreds reads as a broken page, the same way
 * an empty one did; the note above the list says why it widened.
 */
export const MIN_RANKED_TO_OPEN = 5;

export function minRankedToOpen(env: Env): number {
	const n = Number(env.MIN_RANKED_TO_OPEN);
	return Number.isInteger(n) && n > 0 ? n : MIN_RANKED_TO_OPEN;
}

export async function queryHasRanked(env: Env, minYear: number, half: Pick<Filters, 'described' | 'kind'> = {}): Promise<boolean> {
	const { clauses, binds } = conditions({
		sector: null, subsector: null, search: null, source: null, site: null, tiers: null, dated: null, minOriginYear: null,
		sort: 'obscurity', limit: 0, described: half.described ?? null, kind: half.kind ?? null,
	});
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS n FROM companies c
		 WHERE c.tier IN ('A', 'B') AND c.first_seen IS NOT NULL AND (${ORIGIN_YEAR} IS NULL OR ${ORIGIN_YEAR} >= ?)
		 ${clauses.length ? `AND ${clauses.join(' AND ')}` : ''}`,
	)
		.bind(minYear, ...binds)
		.first<{ n: number }>();
	return (row?.n ?? 0) >= minRankedToOpen(env);
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
/**
 * Records that are not, as far as anything on record shows, companies — a person's
 * funded project, a lab, a project name with no entity behind it. The headline counts
 * them apart instead of calling them companies.
 */
export async function queryNotCompanies(env: Env): Promise<number> {
	const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM companies WHERE entity_type IS NOT NULL AND entity_type <> 'company'").first<{
		n: number;
	}>();
	return row?.n ?? 0;
}

/**
 * Where the records are, by state, and how much of that is known.
 *
 * Counted over the whole database, like the coverage map, so a tile's number is the
 * number a click on it reconciles to. The ranked-list share is counted separately
 * because it is far lower — DPIIT gives a state for every company and is mostly
 * undated; the dated incubator and grant rows mostly give none — and a page that
 * quoted only the database-wide share would be flattering the list under it.
 */
export interface Places {
	states: { state: string; n: number }[];
	located: number;
	total: number;
	/** Of the located, how many a DPIIT recognition placed. */
	fromRegister: number;
	rankedLocated: number;
	rankedTotal: number;
}

export async function queryPlaces(env: Env): Promise<Places> {
	const [{ results: states }, totals] = await Promise.all([
		env.DB.prepare("SELECT state, COUNT(*) AS n FROM companies WHERE COALESCE(state, '') <> '' GROUP BY state ORDER BY n DESC, state").all<{
			state: string;
			n: number;
		}>(),
		env.DB.prepare(
			`SELECT COUNT(*) AS total,
			   SUM(COALESCE(state, '') <> '') AS located,
			   SUM(COALESCE(state, '') <> '' AND EXISTS (SELECT 1 FROM signals s WHERE s.company_id = companies.id AND s.type = 'dpiit')) AS from_register,
			   SUM(first_seen IS NOT NULL) AS ranked_total,
			   SUM(first_seen IS NOT NULL AND COALESCE(state, '') <> '') AS ranked_located
			 FROM companies`,
		).first<Record<string, number | null>>(),
	]);
	const n = (key: string) => Number(totals?.[key] ?? 0);
	return {
		states,
		located: n('located'),
		total: n('total'),
		fromRegister: n('from_register'),
		rankedLocated: n('ranked_located'),
		rankedTotal: n('ranked_total'),
	};
}

/** Where each source stands: its last attempt, and the last run whose data is on the page. */
export interface SourceHealth {
	source: string;
	last_attempt: string;
	last_status: 'ok' | 'quarantined' | 'failed';
	last_reason: string | null;
	last_success: string | null;
	last_success_records: number | null;
	data_as_of: string | null;
}

export async function querySourceHealth(env: Env): Promise<SourceHealth[]> {
	const { results } = await env.DB.prepare(
		`SELECT r.source,
		   latest.started_at AS last_attempt, latest.status AS last_status, latest.reason AS last_reason,
		   good.started_at AS last_success, good.records AS last_success_records, good.data_as_of AS data_as_of
		 FROM (SELECT DISTINCT source FROM source_runs) r
		 JOIN source_runs latest ON latest.id = (SELECT id FROM source_runs WHERE source = r.source ORDER BY started_at DESC, id DESC LIMIT 1)
		 LEFT JOIN source_runs good ON good.id = (SELECT id FROM source_runs WHERE source = r.source AND status = 'ok' ORDER BY started_at DESC, id DESC LIMIT 1)
		 ORDER BY r.source`,
	).all<SourceHealth>();
	return results;
}

/**
 * The widget row: the records in view, counted five ways.
 *
 * Every widget counts what every other filter in the view leaves, and ignores its own
 * dimension, so a reader looking at Karnataka still sees how many are in Maharashtra and
 * can move there in one click. The universe is the one the result line accounts for —
 * the tier choice, the date split and the age gate shape the list, not the population —
 * so a segment's number is the number a click on it reconciles to in "N of M".
 *
 * Counts only. Nothing here compares one run with another: the data has days of history,
 * and a change over a few days on a few hundred rows would be noise printed as a trend.
 */
export interface Widgets {
	/** Records the current filters leave, before tier, dates and age. */
	total: number;
	places: {
		states: { state: string; n: number; dated: number; districts: { name: string; n: number }[] }[];
		unknown: number;
		unknownDated: number;
		/** Of `total`, those with a state, and the same for the dated rows. */
		located: number;
		dated: number;
		datedLocated: number;
	};
	sectors: { sector_id: string; n: number }[];
	/** Records in no sunrise sector. */
	offSectors: number;
	traces: Record<TraceBucket, number>;
	described: Record<DescribedState, number>;
	sources: { source: string; n: number }[];
	/** Programme counts over the view without the programme filters: 1, 2, 3 or more, and the quiet ones. */
	programmes: { one: number; two: number; three: number; twoPlus: number; twoPlusAlone: number; twoPlusOrgs: number; total: number };
	/** Keyword tags, each counted over the view without the tag filters. */
	build: Record<string, number>;
	domain: Record<string, number>;
	/** Records in the view with no build tag and no domain tag: nothing in their words matched. */
	untagged: number;
	/** Sub-sector counts over the view without the sector and sub-sector filters: the map's cells. */
	subsectors: Record<string, number>;
	/** What each widget counts over: the view without that widget's own filter. */
	totals: { places: number; sectors: number; traces: number; described: number; sources: number; tags: number };
}

export async function queryWidgets(env: Env, filters: Filters): Promise<Widgets> {
	const base: Filters = { ...filters, tiers: null, dated: null, minOriginYear: null };
	const without = (patch: Partial<Filters>) => conditions({ ...base, ...patch });
	const all = <T>(sql: string, parts: { binds: unknown[] }) => env.DB.prepare(sql).bind(...parts.binds).all<T>();

	const place = without({ state: null });
	const sector = without({ sector: null, subsector: null });
	const trace = without({ traces: null });
	const said = without({ described: null });
	const source = without({ source: null });
	const tag = without({ build: null, domain: null });
	const prog = without({ programmesAtLeast: null, alone: false });
	const everything = without({});

	// Every count that is a plain SUM over companies is folded into one scan per distinct filter set:
	// with no filter on a widget's own dimension, its set is the view's, and six scans become one.
	const scalars: { parts: { clauses: string[]; binds: unknown[] }; select: string }[] = [
		{ parts: trace, select: TRACE_BUCKETS.map((b, i) => `SUM(CASE WHEN ${TRACE_SQL[b]} THEN 1 ELSE 0 END) AS t${i}`).join(', ') },
		{ parts: said, select: DESCRIBED_STATES.map((k) => `SUM(c.said_state = '${k}') AS said_${k}`).join(', ') },
		{ parts: source, select: 'COUNT(*) AS source_total' },
		{ parts: everything, select: 'COUNT(*) AS all_total' },
		{ parts: tag, select: "COUNT(*) AS tag_total, SUM(COALESCE(c.build_tags, '[]') = '[]' AND COALESCE(c.domain_tags, '[]') = '[]') AS untagged" },
		{
			parts: prog,
			select: `COUNT(*) AS prog_total, SUM(c.programme_count = 1) AS prog_one, SUM(c.programme_count = 2) AS prog_two, SUM(c.programme_count >= 3) AS prog_three,
			   SUM(c.programme_count >= 2) AS prog_two_plus, SUM(c.programme_count >= 2 AND c.organisation_count >= 2) AS prog_two_plus_orgs,
			   SUM(c.programme_count >= 2 AND c.other_count = 0) AS prog_two_plus_alone`,
		},
	];
	const groups = new Map<string, { parts: { clauses: string[]; binds: unknown[] }; selects: string[] }>();
	for (const m of scalars) {
		const key = `${whereSql(m.parts.clauses)}|${JSON.stringify(m.parts.binds)}`;
		const group = groups.get(key) ?? { parts: m.parts, selects: [] };
		group.selects.push(m.select);
		groups.set(key, group);
	}
	const scalarRow: Record<string, number | null> = {};
	const scalarQueries = [...groups.values()].map((g) =>
		env.DB.prepare(`SELECT ${g.selects.join(', ')} FROM companies c ${whereSql(g.parts.clauses)}`)
			.bind(...g.parts.binds)
			.first<Record<string, number | null>>()
			.then((row) => Object.assign(scalarRow, row ?? {})),
	);

	const [placeRows, sourceGroups, tagGroups, subRows] = await Promise.all([
		all<{ state: string; city: string; n: number; dated: number }>(
			`SELECT COALESCE(c.state, '') AS state, COALESCE(c.city, '') AS city, COUNT(*) AS n, SUM(c.first_seen IS NOT NULL) AS dated
			 FROM companies c ${whereSql(place.clauses)} GROUP BY 1, 2`,
			place,
		),
		// One grouped join over signals, not a correlated probe per company per source (9,733 rows a render).
		all<{ source: string; n: number }>(
			`SELECT s.source, COUNT(DISTINCT s.company_id) AS n FROM signals s JOIN companies c ON c.id = s.company_id ${whereSql(source.clauses)} GROUP BY s.source`,
			source,
		),
		// Each tag list unrolled once and grouped, not fourteen JSON probes per company (6,388 rows a render).
		all<{ kind: string; tag: string; n: number }>(
			`SELECT 'b' AS kind, j.value AS tag, COUNT(*) AS n FROM companies c, json_each(COALESCE(c.build_tags, '[]')) j ${whereSql(tag.clauses)} GROUP BY j.value
			 UNION ALL
			 SELECT 'd' AS kind, j.value AS tag, COUNT(*) AS n FROM companies c, json_each(COALESCE(c.domain_tags, '[]')) j ${whereSql(tag.clauses)} GROUP BY j.value`,
			{ binds: [...tag.binds, ...tag.binds] },
		),
		all<{ subsector_id: string | null; n: number }>(`SELECT c.subsector_id, COUNT(*) AS n FROM companies c ${whereSql(sector.clauses)} GROUP BY 1`, sector),
		...scalarQueries,
	]);
	const sectorRows = { results: [] as { sector_id: string | null; n: number }[] };
	const traceRow = scalarRow;
	const saidRows = { results: DESCRIBED_STATES.map((k) => ({ said: k, n: Number(scalarRow[`said_${k}`] ?? 0) })) };
	const sourceRow: Record<string, number | null> = { total: scalarRow.source_total ?? 0 };
	SOURCES.forEach((id, i) => (sourceRow[`s${i}`] = sourceGroups.results.find((g) => g.source === id)?.n ?? 0));
	const totalRow = { n: Number(scalarRow.all_total ?? 0) };
	const tagRow: Record<string, number | null> = { total: scalarRow.tag_total ?? 0, untagged: scalarRow.untagged ?? 0 };
	BUILD_TAGS.forEach((t, i) => (tagRow[`b${i}`] = tagGroups.results.find((g) => g.kind === 'b' && g.tag === t)?.n ?? 0));
	DOMAIN_TAGS.forEach((t, i) => (tagRow[`d${i}`] = tagGroups.results.find((g) => g.kind === 'd' && g.tag === t)?.n ?? 0));
	const progRow = {
		total: scalarRow.prog_total,
		one: scalarRow.prog_one,
		two: scalarRow.prog_two,
		three: scalarRow.prog_three,
		two_plus: scalarRow.prog_two_plus,
		two_plus_orgs: scalarRow.prog_two_plus_orgs,
		two_plus_alone: scalarRow.prog_two_plus_alone,
	};

	const byState = new Map<string, { state: string; n: number; dated: number; districts: { name: string; n: number }[] }>();
	let unknown = 0;
	let unknownDated = 0;
	for (const row of placeRows.results) {
		if (!row.state) {
			unknown += row.n;
			unknownDated += Number(row.dated ?? 0);
			continue;
		}
		const entry = byState.get(row.state) ?? { state: row.state, n: 0, dated: 0, districts: [] };
		entry.n += row.n;
		entry.dated += Number(row.dated ?? 0);
		// As each source spelled it: "Bengaluru Urban" is a district, "Bangalore" a city in
		// it. Merging them would be this page deciding what a source meant.
		if (row.city) entry.districts.push({ name: row.city, n: row.n });
		byState.set(row.state, entry);
	}
	const states = [...byState.values()]
		.map((s) => ({ ...s, districts: s.districts.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)) }))
		.sort((a, b) => b.n - a.n || a.state.localeCompare(b.state));
	const located = states.reduce((n, s) => n + s.n, 0);
	const datedLocated = states.reduce((n, s) => n + s.dated, 0);

	const sunrise = new Set(SUNRISE_SECTORS.map((g) => g.sector_id));
	const sectorCounts = new Map(sectorRows.results.map((r) => [r.sector_id ?? '', r.n]));
	const described = Object.fromEntries(DESCRIBED_STATES.map((k) => [k, 0])) as Record<DescribedState, number>;
	for (const row of saidRows.results) described[row.said] = row.n;

	return {
		total: totalRow?.n ?? 0,
		places: { states, unknown, unknownDated, located, dated: datedLocated + unknownDated, datedLocated },
		sectors: SUNRISE_SECTORS.map((g) => ({ sector_id: g.sector_id, n: sectorCounts.get(g.sector_id) ?? 0 })),
		offSectors: sectorRows.results.filter((r) => !sunrise.has(r.sector_id ?? '')).reduce((n, r) => n + r.n, 0),
		traces: Object.fromEntries(TRACE_BUCKETS.map((b, i) => [b, Number(traceRow?.[`t${i}`] ?? 0)])) as Record<TraceBucket, number>,
		described,
		sources: SOURCES.map((id, i) => ({ source: id, n: Number(sourceRow?.[`s${i}`] ?? 0) })),
		build: Object.fromEntries(BUILD_TAGS.map((t, i) => [t, Number(tagRow?.[`b${i}`] ?? 0)])),
		domain: Object.fromEntries(DOMAIN_TAGS.map((t, i) => [t, Number(tagRow?.[`d${i}`] ?? 0)])),
		untagged: Number(tagRow?.untagged ?? 0),
		programmes: {
			one: Number(progRow?.one ?? 0),
			two: Number(progRow?.two ?? 0),
			three: Number(progRow?.three ?? 0),
			twoPlus: Number(progRow?.two_plus ?? 0),
			twoPlusAlone: Number(progRow?.two_plus_alone ?? 0),
			twoPlusOrgs: Number(progRow?.two_plus_orgs ?? 0),
			total: Number(progRow?.total ?? 0),
		},
		subsectors: Object.fromEntries(subRows.results.filter((r) => r.subsector_id).map((r) => [r.subsector_id as string, r.n])),
		totals: {
			tags: Number(tagRow?.total ?? 0),
			places: located + unknown,
			sectors: sectorRows.results.reduce((n, r) => n + r.n, 0),
			traces: TRACE_BUCKETS.reduce((n, _, i) => n + Number(traceRow?.[`t${i}`] ?? 0), 0),
			described: saidRows.results.reduce((n, r) => n + r.n, 0),
			sources: Number(sourceRow?.total ?? 0),
		},
	};
}

/**
 * What a filtered view rests on, counted: how many records, how many placed from a
 * register label alone, and how many say in a sentence what they build. The question
 * box attaches this to every answer so the basis travels with it.
 */
export interface ViewSummary {
	total: number;
	fromLabel: number;
	described: number;
}

export async function queryViewSummary(env: Env, filters: Filters): Promise<ViewSummary> {
	const { clauses, binds } = conditions(filters);
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS total,
		   SUM(c.classify_basis = 'register-label') AS from_label,
		   SUM(${DESCRIBED_SQL} IN ('own', 'source')) AS described
		 FROM companies c ${whereSql(clauses)}`,
	)
		.bind(...binds)
		.first<Record<string, number | null>>();
	return { total: Number(row?.total ?? 0), fromLabel: Number(row?.from_label ?? 0), described: Number(row?.described ?? 0) };
}

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


/**
 * The page's two halves, counted over the whole database: companies a sentence
 * describes, and how many of those have left one public trace or none; research
 * projects and unverified names that are described; and every record nothing describes.
 * The three add up to every row, so the masthead can account for all of them.
 */
export interface Substance {
	total: number;
	companies: number;
	companiesQuiet: number;
	others: number;
	unsaid: number;
}

export async function querySubstance(env: Env): Promise<Substance> {
	const said = `${DESCRIBED_SQL} IN ('own', 'source')`;
	const company = "COALESCE(c.entity_type, 'company') = 'company'";
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS total,
		   SUM(${said} AND ${company}) AS companies,
		   SUM(${said} AND ${company} AND c.trace_count <= 1) AS quiet,
		   SUM(${said} AND NOT ${company}) AS others,
		   SUM(NOT ${said}) AS unsaid
		 FROM companies c`,
	).first<Record<string, number | null>>();
	return {
		total: Number(row?.total ?? 0),
		companies: Number(row?.companies ?? 0),
		companiesQuiet: Number(row?.quiet ?? 0),
		others: Number(row?.others ?? 0),
		unsaid: Number(row?.unsaid ?? 0),
	};
}

/**
 * The numbers behind the findings under the masthead, each counted from the tables the
 * rest of the page is drawn from, so a finding and the section it links to cannot
 * disagree.
 *
 *   register     every record read from the DPIIT register — placed rows and gaps — and
 *                how many have a sentence anywhere, on the row or in the gap
 *   described    every record with a sentence saying what it builds, and how many of
 *                those fit no sub-sector; the largest named holes among them
 *   recognition  register rows on the list whose record we hold, and how many are a
 *                profile DPIIT never recognised
 */
export interface Findings {
	register: { total: number; described: number };
	described: { total: number; unmapped: number; holes: { missing: string; n: number }[] };
	recognition: { withStatus: number; profile: number };
	/** Described companies, and those only one outside source has noticed (their own website not counted). */
	noticed: { companies: number; once: number };
	/** Described companies in two or more public programmes, those with no other trace, and by publishing organisations. */
	programmes: { twoPlus: number; alone: number; orgs: number; three: number };
}

/** The gap group for companies the classifier put outside the RDI scheme altogether. */
export const OUTSIDE_TAXONOMY = 'outside this taxonomy';

export async function queryFindings(env: Env): Promise<Findings> {
	const saidRow = `${DESCRIBED_SQL} IN ('own', 'source')`;
	const saidGap = `COALESCE(g.description, '') <> '' AND NOT ${labelSql('g.description')}`;
	// One pass over each table. The correlated subqueries this replaced read 17,752 rows a render
	// on 15 September 2026, most of the free daily limit spent on a paragraph nobody changed.
	const [row, gapRow, holes] = await Promise.all([
		env.DB.prepare(
			`WITH sig AS (
			   SELECT company_id, MAX(source = ?1) AS on_register, SUM(type <> 'website') AS outside,
			          SUM(type IN ('website', 'press')) AS other
			   FROM signals GROUP BY company_id
			 )
			 SELECT
			   SUM(COALESCE(sig.on_register, 0)) AS register_rows,
			   SUM(COALESCE(sig.on_register, 0) AND ${saidRow}) AS register_rows_said,
			   SUM(${saidRow}) AS rows_said,
			   SUM(c.dpiit_status IS NOT NULL) AS with_status,
			   SUM(c.dpiit_status = 'profile') AS profile,
			   SUM(${saidRow} AND COALESCE(c.entity_type, 'company') = 'company') AS companies_said,
			   SUM(${saidRow} AND COALESCE(c.entity_type, 'company') = 'company' AND COALESCE(sig.outside, 0) = 1) AS noticed_once,
			   SUM(${saidRow} AND COALESCE(c.entity_type, 'company') = 'company' AND c.programme_count >= 2) AS prog_two,
			   SUM(${saidRow} AND COALESCE(c.entity_type, 'company') = 'company' AND c.programme_count >= 3) AS prog_three,
			   SUM(${saidRow} AND COALESCE(c.entity_type, 'company') = 'company' AND c.organisation_count >= 2) AS prog_orgs,
			   SUM(${saidRow} AND COALESCE(c.entity_type, 'company') = 'company' AND c.programme_count >= 2 AND COALESCE(sig.other, 0) = 0) AS prog_alone
			 FROM companies c LEFT JOIN sig ON sig.company_id = c.id`,
		)
			.bind(REGISTER_SOURCE)
			.first<Record<string, number | null>>(),
		env.DB.prepare(
			`SELECT SUM(g.source = ?1) AS register_gaps, SUM(g.source = ?1 AND ${saidGap}) AS register_gaps_said,
			   SUM(${saidGap}) AS gaps_said, SUM(${saidGap} AND g.missing <> ?2) AS gaps_said_unmapped
			 FROM gaps g`,
		)
			.bind(REGISTER_SOURCE, NO_GAP_NAMED)
			.first<Record<string, number | null>>(),
		env.DB.prepare(
			`SELECT g.missing, COUNT(*) AS n FROM gaps g
			 WHERE ${saidGap} AND g.missing NOT IN (?1, ?2)
			 GROUP BY g.missing ORDER BY n DESC, g.missing LIMIT 3`,
		)
			.bind(NO_GAP_NAMED, OUTSIDE_TAXONOMY)
			.all<{ missing: string; n: number }>(),
	]);
	const n = (k: string) => Number(row?.[k] ?? gapRow?.[k] ?? 0);
	return {
		register: { total: n('register_rows') + n('register_gaps'), described: n('register_rows_said') + n('register_gaps_said') },
		described: { total: n('rows_said') + n('gaps_said'), unmapped: n('gaps_said_unmapped'), holes: holes.results },
		recognition: { withStatus: n('with_status'), profile: n('profile') },
		noticed: { companies: n('companies_said'), once: n('noticed_once') },
		programmes: { twoPlus: n('prog_two'), alone: n('prog_alone'), orgs: n('prog_orgs'), three: n('prog_three') },
	};
}
