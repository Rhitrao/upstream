/**
 * Upstream — the Worker. Serves the HTML page and the JSON API, and nothing else.
 * It never scrapes: all the slow work already happened hours ago in GitHub Actions.
 *
 * Everything lives under /upstream because that is what the route sends us
 * (rohitrao.in/upstream* — see Part 8).
 *
 *   GET  /upstream                  the HTML page
 *   GET  /upstream/api/companies    JSON list; filters: sector, subsector, tier, age, undated, limit
 *   GET  /upstream/api/coverage     company count per sub-sector, for the coverage map
 *   GET  /upstream/api/gaps         companies the taxonomy has no cell for, grouped
 *   GET  /upstream/api/sources      per source: last attempt, last success, records
 *   POST /upstream/api/ingest       write endpoint, needs X-Ingest-Key
 *   POST /upstream/api/ask          the question box; 404 unless ASK_ENABLED is set
 *   GET  /upstream/asks             every question asked and its cost, behind Access
 *   POST /upstream/api/source-runs  what each source did in a pipeline run, needs X-Ingest-Key
 */
import { SIGNAL_TYPES, TRACE_TYPES, TIERS, earliestEvent, minOriginYear, tierFor, type Tier } from './rank';
import {
	queryBuckets,
	queryCompanies,
	queryCoverage,
	queryDiscoveredSince,
	queryOneTraceCount,
	deleteNote,
	queryCompany,
	queryNote,
	queryNotes,
	queryProductOutcomes,
	saveNote,
	SORTS,
	SOURCES,
	type SiteState,
	type SortChoice,
	queryGaps,
	queryHasRanked,
	querySourceHealth,
	queryWidgets,
	DESCRIBED_STATES,
	TRACE_BUCKETS,
	type DescribedState,
	type TraceBucket,
	queryNotCompanies,
	queryRegisterOutcomes,
	type Filters,
	DESCRIBED_CHOICES,
	type DescribedChoice,
	type KindChoice,
	querySubstance,
	queryFindings,
	papersOf,
	registerText,
	labelSql,
} from './db';
import { SUBSECTOR_BY_ID } from './taxonomy';
import { accessConfig, identify } from './access';
import { anthropicCreate, askMode, handleAsk, queryAskLog, renderAskLog } from './ask';
import { PRIVATE_HEADERS, renderNotebook, renderNoteEditor } from './notes';
import { BASE_PATH, renderCompanyPage, renderPage, type AgeChoice, type TierChoice } from './page';
import { demoCompanies, demoGaps, demoProductOutcomes, demoRegisterOutcomes, splitDemo } from './demo';

const BASE = BASE_PATH;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

/** D1 allows at most 100 bound parameters per statement. Leave room for the extras. */
const BIND_CHUNK = 70;

// --- helpers ----------------------------------------------------------------

function json(data: unknown, status = 200, cache = 'no-store'): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache },
	});
}

/** GETs are cheap to re-serve and the data only moves once a day. */
const PUBLIC_CACHE = 'public, max-age=60';

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

function placeholders(n: number): string {
	return new Array(n).fill('?').join(', ');
}

/**
 * Constant-time string compare. Digesting first means equal-length buffers always reach
 * timingSafeEqual, so the comparison leaks neither the key nor its length.
 */
async function secretsMatch(presented: string, expected: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [a, b] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(presented)),
		crypto.subtle.digest('SHA-256', encoder.encode(expected)),
	]);
	return crypto.subtle.timingSafeEqual(a, b);
}

function isoDate(now: Date): string {
	return now.toISOString().slice(0, 10);
}

// --- shared filter parsing --------------------------------------------------

/** The page's toggle (A / A+B / all) and the API's single-tier filter, in one place. */
const TIER_SETS: Record<TierChoice, Tier[] | null> = {
	a: ['A'],
	ab: ['A', 'B'],
	all: null,
};

function parseTierChoice(raw: string | null, fallback: TierChoice = 'ab'): TierChoice {
	if (raw === 'a' || raw === 'ab' || raw === 'all') return raw;
	return fallback;
}

/** The age gate is on unless asked otherwise, on the page and in the API alike. */
function parseAgeChoice(raw: string | null): AgeChoice {
	return raw === 'all' ? 'all' : 'recent';
}

function parseLimit(raw: string | null): number | null {
	if (raw === null || raw === '') return DEFAULT_LIMIT;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) return null;
	return Math.min(parsed, MAX_LIMIT);
}

/**
 * The filters that arrive as a name from a fixed list, parsed once for the page, the
 * API and the export, so all three answer the same url the same way.
 *
 * A value that is not on the list becomes null rather than a 400 on the page: a reader
 * editing a url by hand should get the unfiltered list, not an error page. The API is
 * stricter, because a client passing nonsense wants to be told.
 */
function parseSource(raw: string | null): string | null {
	return raw && (SOURCES as readonly string[]).includes(raw) ? raw : null;
}

function parseSite(raw: string | null): SiteState | null {
	return raw === 'has' || raw === 'none' ? raw : null;
}

function parseTraces(raw: string | null): TraceBucket | null {
	// "3 " is what a "+" becomes when a hand-typed url is not encoded.
	const value = raw === '3 ' ? '3+' : raw;
	return value && (TRACE_BUCKETS as readonly string[]).includes(value) ? (value as TraceBucket) : null;
}

function parseDescribed(raw: string | null): DescribedState | null {
	return raw && (DESCRIBED_STATES as readonly string[]).includes(raw) ? (raw as DescribedState) : null;
}

/**
 * The page's own reading of `described`: absent means the default half, the records a
 * sentence describes; 'all' lifts it. The JSON API keeps parseDescribed and no default,
 * because a caller asking for companies has not asked for this page's argument.
 */
function parseDescribedChoice(raw: string | null): DescribedChoice | null {
	if (raw === 'all') return null;
	return raw && (DESCRIBED_CHOICES as readonly string[]).includes(raw) ? (raw as DescribedChoice) : 'said';
}

/** Companies by default; 'other' for research projects and unverified names; 'all' for both. */
function parseKind(raw: string | null): KindChoice | null {
	if (raw === 'all') return null;
	return raw === 'other' ? 'other' : 'company';
}

function parseDpiit(raw: string | null): string | null {
	return raw && DPIIT_STATUSES.has(raw) ? raw : null;
}

function parseSort(raw: string | null): SortChoice {
	return raw !== null && raw in SORTS ? (raw as SortChoice) : 'obscurity';
}

function parseDates(raw: string | null): DatesChoice {
	return raw === 'dated' || raw === 'undated' ? raw : 'both';
}

/** Which of the two list sections a reader has asked to see. */
export type DatesChoice = 'both' | 'dated' | 'undated';

// --- GET /upstream/api/companies -------------------------------------------

async function listCompaniesApi(url: URL, env: Env): Promise<Response> {
	const tierParam = url.searchParams.get('tier');

	let tiers: Tier[] | null = null;
	if (tierParam !== null && tierParam !== '' && tierParam !== 'all') {
		const tier = tierParam.toUpperCase();
		if (!TIERS.includes(tier as Tier)) {
			return json({ error: `tier must be one of ${TIERS.join(', ')}, or all` }, 400);
		}
		tiers = [tier as Tier];
	}

	const limit = parseLimit(url.searchParams.get('limit'));
	if (limit === null) return json({ error: 'limit must be a positive integer' }, 400);

	// Same three-way split as the page: the ranked list by default, ?undated=1 for the
	// companies no source will date, ?age=all to lift the five-year gate.
	const undated = url.searchParams.get('undated') === '1';
	const age = parseAgeChoice(url.searchParams.get('age'));
	const now = new Date();

	const source = url.searchParams.get('source');
	if (source && !parseSource(source)) return json({ error: `source must be one of ${SOURCES.join(', ')}` }, 400);
	const site = url.searchParams.get('site');
	if (site && !parseSite(site)) return json({ error: "site must be 'has' or 'none'" }, 400);
	const sort = url.searchParams.get('sort');
	if (sort && !(sort in SORTS)) return json({ error: `sort must be one of ${Object.keys(SORTS).join(', ')}` }, 400);
	const traces = url.searchParams.get('traces');
	if (traces && !parseTraces(traces)) return json({ error: `traces must be one of ${TRACE_BUCKETS.join(', ')}` }, 400);
	const described = url.searchParams.get('described');
	if (described && !parseDescribed(described)) return json({ error: `described must be one of ${DESCRIBED_STATES.join(', ')}` }, 400);

	const companies = await queryCompanies(env, {
		sector: url.searchParams.get('sector') || null,
		subsector: url.searchParams.get('subsector') || null,
		search: url.searchParams.get('q') || null,
		source: parseSource(source),
		site: parseSite(site),
		state: (url.searchParams.get('state') || '').trim().slice(0, 60) || null,
		traces: parseTraces(traces),
		described: parseDescribed(described),
		sort: parseSort(sort),
		tiers,
		dated: undated ? 'undated' : 'dated',
		minOriginYear: undated || age === 'all' ? null : minOriginYear(now),
		limit,
	});

	return json({ count: companies.length, limit, undated, age, companies }, 200, PUBLIC_CACHE);
}

// --- GET /upstream/api/coverage --------------------------------------------

async function coverageApi(env: Env): Promise<Response> {
	const coverage = await queryCoverage(env);
	return json({ ...coverage, generated_at: new Date().toISOString() }, 200, PUBLIC_CACHE);
}

// --- POST /upstream/api/source-runs ----------------------------------------

const SOURCE_RUN_STATUSES = new Set(['ok', 'quarantined', 'failed']);

/**
 * What each source did in one pipeline run, written before anything is uploaded.
 *
 * Separate from /api/ingest on purpose: a source that failed or was quarantined
 * uploads nothing, so the ingest endpoint never hears of it, and that silence is the
 * failure this exists to end.
 */
async function recordSourceRuns(request: Request, env: Env): Promise<Response> {
	if (!env.INGEST_KEY) return json({ error: 'ingest is not configured' }, 503);
	if (!(await secretsMatch(request.headers.get('X-Ingest-Key') ?? '', env.INGEST_KEY))) {
		return json({ error: 'unauthorized' }, 401);
	}
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'body must be JSON' }, 400);
	}
	const runs = (body as { runs?: unknown })?.runs;
	if (!Array.isArray(runs) || runs.length === 0) return json({ error: 'runs must be a non-empty array' }, 400);

	const startedAt = new Date().toISOString();
	const writes: D1PreparedStatement[] = [];
	for (const [i, raw] of runs.entries()) {
		const r = (raw ?? {}) as Record<string, unknown>;
		const source = str(r.source);
		const status = str(r.status);
		if (!source) return json({ error: `runs[${i}].source is required` }, 400);
		if (!status || !SOURCE_RUN_STATUSES.has(status)) return json({ error: `runs[${i}].status must be ok, quarantined or failed` }, 400);
		// A quarantine or a failure with no reason is a red light with no label.
		if (status !== 'ok' && !str(r.reason)) return json({ error: `runs[${i}].reason is required when status is ${status}` }, 400);
		writes.push(
			env.DB.prepare(
				'INSERT INTO source_runs (started_at, source, status, records, previous, data_as_of, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
			).bind(startedAt, source, status, int(r.records) ?? 0, int(r.previous), str(r.data_as_of), str(r.reason)),
		);
	}
	await env.DB.batch(writes);
	return json({ recorded: writes.length });
}

// --- POST /upstream/api/ingest ---------------------------------------------

interface CompanyInput {
	id: string;
	name: string;
	description?: string | null;
	website?: string | null;
	/** False when the source publishes no website field at all, so an empty one proves nothing. */
	website_checked?: boolean;
	city?: string | null;
	state?: string | null;
	cin?: string | null;
	founded_year?: number | null;
	/** When the company began, as a source claims it. Drives the age gate. */
	origin_year?: number | null;
	/**
	 * When it entered a public record — an incubation cohort, a grant award, a
	 * recognition register. Drives first_seen. Defaults to origin_year, because for
	 * most sources the two are the same fact; DPIIT is the case where they are not.
	 */
	record_year?: number | null;
	sector_id?: string | null;
	subsector_id?: string | null;
	project_type?: string | null;
	classify_note?: string | null;
	/** 'description' or 'register-label' — what the sub-sector was chosen from. */
	classify_basis?: string | null;
	/** What the company says it builds, read off its own homepage. */
	product?: string | null;
	/** Why there is or is not a product line: see PRODUCT_STATUSES. */
	product_status?: string | null;
	/** How far the website got through the identity check: see WEBSITE_IDENTITIES. */
	website_identity?: string | null;
	website_identity_note?: string | null;
	/** A year printed beside the company whose meaning the source does not state. */
	source_year?: number | null;
	source_year_type?: string | null;
	/** company, researcher-project, lab or unverified — see ENTITY_TYPES. */
	entity_type?: string | null;
	entity_note?: string | null;
	founders?: string | null;
	founders_source?: string | null;
	description_source?: string | null;
	/** What the register's record says about recognition — see DPIIT_STATUSES. */
	dpiit_status?: string | null;
	dpiit_stage?: string | null;
	contact_email?: string | null;
	contact_page?: string | null;
	domain_registered?: string | null;
	web_first_capture?: string | null;
	/** {count, works, query_url}; stored as JSON. */
	papers?: unknown;
}

/**
 * Every outcome enrichment can report, and the only ones this endpoint will store.
 *
 * A typo here would be stored, displayed, and counted as a state the page has no
 * sentence for — the same failure the signal vocabulary was locked down to prevent.
 * Adding one is an edit here and a sentence on the page, in that order.
 */
const PRODUCT_STATUSES = new Set(['described', 'unreachable', 'refused', 'thin', 'unclear', 'unverified', 'source-described']);

/**
 * How far a website got towards being evidence about this company — migration 0008.
 * A reachable address is not proof of whose it is: Grinntech was given HyperVerge's.
 */
const WEBSITE_IDENTITIES = new Set(['discovered', 'associated', 'verified']);

/** What a record is. Only 'company' is counted as one — migration 0012. */
const ENTITY_TYPES = new Set(['company', 'researcher-project', 'lab', 'unverified']);

/**
 * What the DPIIT register's record says, and nothing it implies. 'profile' is a
 * Startup India profile DPIIT never recognised — 345 of 966 records on 14 September
 * 2026, every one of which the page used to call "DPIIT recognised". Migration 0018.
 */
export const DPIIT_STATUSES = new Set(['recognised', 'expired', 'cancelled', 'pending', 'profile']);

/**
 * A company the classifier placed in a sector but in none of its sub-sectors.
 * It is not a company row: it is the evidence that the taxonomy has a hole.
 */
/** One company listed twice: `from` is the duplicate row, `into` the one that stays. */
interface MergeInput {
	from: string;
	into: string;
}

interface GapInput {
	company_id: string;
	name: string;
	missing: string;
	note: string;
	description?: string | null;
	sector_id?: string | null;
}

interface SignalInput {
	company_id: string;
	type: string;
	label: string;
	date?: string | null;
	url?: string | null;
	source?: string | null;
	found_at?: string | null;
	published?: string | null;
}

/**
 * first_seen and discovered are written on insert and never again — note their absence
 * from the DO UPDATE list, with one deliberate exception below. Every other text
 * column uses COALESCE so a later, thinner record cannot blank out something we knew.
 *
 * The exception: a row whose first_seen is NULL can be dated later, but only by ?18,
 * the cohort year a source published. Never by excluded.first_seen — on a live run
 * that is today, and stamping today onto a row we have held for months would invent
 * a discovery out of a company we already had.
 */
const UPSERT_COMPANY_SQL = `
INSERT INTO companies (
  id, name, description, website, website_checked, city, state, cin, founded_year, origin_year,
  sector_id, subsector_id, project_type, classify_note, classify_basis, product, product_status,
  website_identity, website_identity_note, entity_type, entity_note, source_year, source_year_type,
  founders, founders_source, dpiit_status, dpiit_stage, contact_email, contact_page, domain_registered, papers,
  description_source, web_first_capture, first_seen, first_seen_basis, discovered, trace_count, tier, updated_at
) VALUES (?1, ?2, ?3, ?4, ?19, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28,
  ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38, ?14, ?15, ?16, 0, 'C', ?17)
ON CONFLICT(id) DO UPDATE SET
  name          = excluded.name,
  -- A register label never replaces a real description; a real one replaces a label.
  description   = CASE
                    WHEN excluded.description IS NULL THEN companies.description
                    WHEN ${labelSql('excluded.description')}
                     AND companies.description IS NOT NULL
                     AND NOT ${labelSql('companies.description')} THEN companies.description
                    ELSE excluded.description END,
  description_source = CASE
                    WHEN excluded.description IS NULL THEN companies.description_source
                    WHEN ${labelSql('excluded.description')}
                     AND companies.description IS NOT NULL
                     AND NOT ${labelSql('companies.description')} THEN companies.description_source
                    ELSE COALESCE(excluded.description_source, companies.description_source) END,
  -- A checked address replaces whatever was there, including with nothing: COALESCE
  -- would keep HyperVerge's address on Grinntech for ever once the parser stopped
  -- sending it. An unchecked one (a scraper posting on its own) fills gaps only.
  website       = CASE WHEN excluded.website_identity IS NOT NULL THEN excluded.website
                       ELSE COALESCE(excluded.website, companies.website) END,
  entity_type   = COALESCE(excluded.entity_type,   companies.entity_type),
  source_year      = COALESCE(excluded.source_year,      companies.source_year),
  source_year_type = COALESCE(excluded.source_year_type, companies.source_year_type),
  entity_note   = COALESCE(excluded.entity_note,   companies.entity_note),
  founders        = CASE WHEN excluded.founders IS NOT NULL THEN excluded.founders ELSE companies.founders END,
  founders_source = CASE WHEN excluded.founders IS NOT NULL THEN excluded.founders_source ELSE companies.founders_source END,
  -- The register's latest word: a recognition can lapse, and a profile can be recognised.
  dpiit_status  = COALESCE(excluded.dpiit_status,  companies.dpiit_status),
  dpiit_stage   = COALESCE(excluded.dpiit_stage,   companies.dpiit_stage),
  -- Like the product line: read off a homepage, so gone once the address is checked
  -- and found not to be theirs, whatever an earlier run learned from it.
  contact_email     = CASE WHEN excluded.website_identity IS NOT NULL AND excluded.website_identity <> 'verified' THEN NULL
                           ELSE COALESCE(excluded.contact_email, companies.contact_email) END,
  contact_page      = CASE WHEN excluded.website_identity IS NOT NULL AND excluded.website_identity <> 'verified' THEN NULL
                           ELSE COALESCE(excluded.contact_page, companies.contact_page) END,
  domain_registered = CASE WHEN excluded.website_identity IS NOT NULL AND excluded.website_identity <> 'verified' THEN NULL
                           ELSE COALESCE(excluded.domain_registered, companies.domain_registered) END,
  web_first_capture = CASE WHEN excluded.website_identity IS NOT NULL AND excluded.website_identity <> 'verified' THEN NULL
                           ELSE COALESCE(excluded.web_first_capture, companies.web_first_capture) END,
  papers        = COALESCE(excluded.papers,        companies.papers),
  website_identity      = COALESCE(excluded.website_identity,      companies.website_identity),
  website_identity_note = COALESCE(excluded.website_identity_note, companies.website_identity_note),
  -- One source that publishes websites is enough to have looked.
  website_checked = MAX(companies.website_checked, excluded.website_checked),
  city          = COALESCE(excluded.city,          companies.city),
  state         = COALESCE(excluded.state,         companies.state),
  cin           = COALESCE(excluded.cin,           companies.cin),
  founded_year  = COALESCE(excluded.founded_year,  companies.founded_year),
  origin_year   = COALESCE(MIN(companies.origin_year, excluded.origin_year), companies.origin_year, excluded.origin_year),
  sector_id     = COALESCE(excluded.sector_id,     companies.sector_id),
  subsector_id  = COALESCE(excluded.subsector_id,  companies.subsector_id),
  -- A register label supports a sub-sector at most. A project type kept from an
  -- earlier run would outlive the rule that says it was never supported.
  project_type  = CASE WHEN excluded.classify_basis = 'register-label' THEN NULL
                       ELSE COALESCE(excluded.project_type, companies.project_type) END,
  classify_note = COALESCE(excluded.classify_note, companies.classify_note),
  classify_basis  = excluded.classify_basis,
  -- COALESCE, not excluded: the four scrapers know nothing about homepages and post
  -- these as null every night. Overwriting would mean the last source to mention a
  -- company erased what reading its website cost us to learn.
  --
  -- Except once the address has been checked and is not verified: then the sentence
  -- goes, whatever an earlier run bought. A sentence kept from someone else's homepage
  -- is the exact thing the check exists to remove.
  product         = CASE WHEN excluded.website_identity IS NOT NULL AND excluded.website_identity <> 'verified' THEN NULL
                         ELSE COALESCE(excluded.product, companies.product) END,
  product_status  = CASE WHEN excluded.website_identity IS NOT NULL AND excluded.website_identity <> 'verified'
                         THEN COALESCE(excluded.product_status, 'unverified')
                         ELSE COALESCE(excluded.product_status, companies.product_status) END,
  first_seen       = CASE WHEN companies.first_seen IS NULL THEN ?18 ELSE companies.first_seen END,
  first_seen_basis = CASE WHEN companies.first_seen IS NULL AND ?18 IS NOT NULL THEN 'cohort' ELSE companies.first_seen_basis END,
  updated_at    = excluded.updated_at`;

const INSERT_SIGNAL_SQL = `
INSERT OR IGNORE INTO signals (company_id, type, label, date, url, source, found_at, published)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`;

/**
 * A company no source dated takes the date of the first event a source does date: an
 * award, a grant, an incubation. As a source's date ('cohort'), never as a discovery,
 * and at the precision the source gave — a year stays a year. A row that already has a
 * date keeps it.
 */
const DATE_FROM_EVENT_SQL = `
UPDATE companies SET first_seen = ?2, first_seen_basis = 'cohort'
WHERE id = ?1
  AND (first_seen IS NULL
       -- A source's bare year is refined by a full date in that same year, and by nothing else.
       OR (first_seen_basis = 'cohort' AND length(first_seen) = 4 AND length(?2) = 10 AND substr(?2, 1, 4) = first_seen))`;

const UPSERT_GAP_SQL = `
INSERT INTO gaps (company_id, name, description, sector_id, missing, note, source, found_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT(company_id) DO UPDATE SET
  name        = excluded.name,
  description = COALESCE(excluded.description, gaps.description),
  sector_id   = COALESCE(excluded.sector_id,   gaps.sector_id),
  missing     = excluded.missing,
  note        = excluded.note,
  source      = excluded.source`;

/**
 * A company that has since been placed is no longer a gap. Re-running a source
 * has to be able to empty this table as well as fill it, or a fixed taxonomy
 * would leave its old holes on the page forever.
 */
const DELETE_GAP_SQL = 'DELETE FROM gaps WHERE company_id = ?1';

const DELETE_STALE_REGISTER_SIGNAL_SQL = "DELETE FROM signals WHERE company_id = ?1 AND type = 'dpiit' AND label <> ?2";

/**
 * The other direction, and the one that was missing: a company the classifier can
 * no longer place is not a row any more.
 *
 * Without this the companies table only ever grew. A company placed on Monday and
 * found unplaceable on Tuesday kept its Monday row, sat in a coverage cell it no
 * longer belonged to, and was counted in the headline total — while also being
 * listed, correctly, as a hole in the taxonomy. Three companies were in both
 * tables when this was written.
 *
 * The signals go first because they carry a foreign key to the row being removed.
 * Nothing is lost that the next run cannot restore: a company that becomes
 * placeable again arrives with its traces attached, and INSERT OR IGNORE puts
 * them back.
 */
const DELETE_COMPANY_SIGNALS_SQL = 'DELETE FROM signals WHERE company_id = ?1';
const DELETE_COMPANY_SQL = 'DELETE FROM companies WHERE id = ?1';

/**
 * A website trace says something answered at the address. Signals are INSERT OR
 * IGNORE, so nothing the pipeline sends can take one back: a company whose homepage
 * has since stopped resolving arrives with product_status 'unreachable', and this is
 * where its trace goes. Without it a lapsed domain counts as live for ever, which is
 * exactly the claim the trace exists to make honestly.
 */
const DELETE_WEBSITE_TRACE_SQL = "DELETE FROM signals WHERE company_id = ?1 AND type = 'website'";

const INSERT_RUN_SQL = `
INSERT INTO runs (started_at, source, status, records_found, error)
VALUES (?1, ?2, ?3, ?4, ?5)`;

function str(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}

function int(value: unknown): number | null {
	if (typeof value === 'number' && Number.isInteger(value)) return value;
	if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
	return null;
}

/** 1900 to next year. Anything else is a parsing accident, not a founding date. */
function isPlausibleYear(year: number | null, now: Date): boolean {
	return year !== null && year >= 1900 && year <= now.getUTCFullYear() + 1;
}

async function ingest(request: Request, env: Env): Promise<Response> {
	const now = new Date();
	const startedAt = now.toISOString();

	if (!env.INGEST_KEY) {
		// Fail closed. Without the secret there is nothing to authenticate against.
		return json({ error: 'ingest is not configured' }, 503);
	}
	const presented = request.headers.get('X-Ingest-Key') ?? '';
	if (!(await secretsMatch(presented, env.INGEST_KEY))) {
		// No runs row here: unauthenticated callers must not be able to write anything.
		return json({ error: 'unauthorized' }, 401);
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'body must be JSON' }, 400);
	}
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return json({ error: 'body must be a JSON object' }, 400);
	}
	const payload = body as Record<string, unknown>;

	const source = str(payload.source);
	if (!source) return json({ error: 'source is required' }, 400);

	// Normally inferred from the runs table; the override is for re-seeding a source
	// whose history was wiped, where "has it run before" would answer wrongly.
	const mode = str(payload.mode);
	if (mode !== null && mode !== 'backfill' && mode !== 'live') {
		return json({ error: 'mode must be backfill or live' }, 400);
	}

	if (payload.companies !== undefined && !Array.isArray(payload.companies)) {
		return json({ error: 'companies must be an array' }, 400);
	}
	if (payload.signals !== undefined && !Array.isArray(payload.signals)) {
		return json({ error: 'signals must be an array' }, 400);
	}
	const rawCompanies = (payload.companies ?? []) as unknown[];
	const rawSignals = (payload.signals ?? []) as unknown[];

	const companies: CompanyInput[] = [];
	for (const [i, raw] of rawCompanies.entries()) {
		if (typeof raw !== 'object' || raw === null) {
			return json({ error: `companies[${i}] must be an object` }, 400);
		}
		const c = raw as Record<string, unknown>;
		const id = str(c.id);
		const name = str(c.name);
		if (!id) return json({ error: `companies[${i}].id is required` }, 400);
		if (!name) return json({ error: `companies[${i}].name is required` }, 400);
		const productStatus = str(c.product_status);
		if (productStatus !== null && !PRODUCT_STATUSES.has(productStatus)) {
			return json({ error: `companies[${i}].product_status must be one of ${[...PRODUCT_STATUSES].join(', ')}` }, 400);
		}
		const sourceYear = c.source_year;
		if (sourceYear !== undefined && sourceYear !== null && !isPlausibleYear(int(sourceYear), now)) {
			return json({ error: `companies[${i}].source_year must be a four-digit year no later than next year` }, 400);
		}
		// Only one meaning exists today, and it is "nobody said". A second one would be
		// a claim about what the year means, and has to be added here on purpose.
		if (str(c.source_year_type) !== null && str(c.source_year_type) !== 'unknown') {
			return json({ error: `companies[${i}].source_year_type must be unknown` }, 400);
		}
		const entityType = str(c.entity_type);
		if (entityType !== null && !ENTITY_TYPES.has(entityType)) {
			return json({ error: `companies[${i}].entity_type must be one of ${[...ENTITY_TYPES].join(', ')}` }, 400);
		}
		const identity = str(c.website_identity);
		if (identity !== null && !WEBSITE_IDENTITIES.has(identity)) {
			return json({ error: `companies[${i}].website_identity must be one of ${[...WEBSITE_IDENTITIES].join(', ')}` }, 400);
		}
		const dpiitStatus = str(c.dpiit_status);
		if (dpiitStatus !== null && !DPIIT_STATUSES.has(dpiitStatus)) {
			return json({ error: `companies[${i}].dpiit_status must be one of ${[...DPIIT_STATUSES].join(', ')}` }, 400);
		}
		// Read off a homepage, so held to the product line's gate: an address whose
		// identity was not confirmed cannot give a reader someone else's inbox.
		for (const field of ['contact_email', 'contact_page', 'domain_registered', 'web_first_capture'] as const) {
			if (str(c[field]) !== null && identity !== 'verified') {
				return json({ error: `companies[${i}].${field} needs website_identity 'verified'` }, 400);
			}
		}
		for (const field of ['domain_registered', 'web_first_capture'] as const) {
			if (str(c[field]) !== null && !/^\d{4}-\d{2}-\d{2}$/.test(str(c[field])!)) {
				return json({ error: `companies[${i}].${field} must be a YYYY-MM-DD date` }, 400);
			}
		}
		if (c.papers !== undefined && c.papers !== null && (typeof c.papers !== 'object' || Array.isArray(c.papers) || typeof (c.papers as { count?: unknown }).count !== 'number')) {
			return json({ error: `companies[${i}].papers must be an object with a count` }, 400);
		}
		// A description with no outcome attached is a sentence with no provenance, and
		// a 'described' with nothing in it is a promise the row cannot keep.
		if (str(c.product) !== null && productStatus !== 'described') {
			return json({ error: `companies[${i}].product needs product_status 'described'` }, 400);
		}
		// The gate, enforced where it cannot be forgotten: a homepage whose identity was
		// not confirmed cannot put a sentence in a company's mouth, whatever sent it.
		if (str(c.product) !== null && identity !== 'verified') {
			return json({ error: `companies[${i}].product needs website_identity 'verified'` }, 400);
		}

		const basis = str(c.classify_basis);
		if (basis !== null && basis !== 'description' && basis !== 'register-label') {
			return json({ error: `companies[${i}].classify_basis must be description or register-label` }, 400);
		}
		if (basis === 'register-label' && str(c.project_type) !== null) {
			return json({ error: `companies[${i}].project_type needs a description behind it, not a register label` }, 400);
		}
		// A junk year would quietly decide whether a company is old enough to hide.
		for (const field of ['origin_year', 'record_year'] as const) {
			const value = c[field];
			if (value !== undefined && value !== null && !isPlausibleYear(int(value), now)) {
				return json({ error: `companies[${i}].${field} must be a four-digit year no later than next year` }, 400);
			}
		}
		companies.push({ ...(c as object), id, name } as CompanyInput);
	}

	const signals: SignalInput[] = [];
	for (const [i, raw] of rawSignals.entries()) {
		if (typeof raw !== 'object' || raw === null) {
			return json({ error: `signals[${i}] must be an object` }, 400);
		}
		const s = raw as Record<string, unknown>;
		const companyId = str(s.company_id);
		const type = str(s.type);
		const label = str(s.label);
		if (!companyId) return json({ error: `signals[${i}].company_id is required` }, 400);
		if (!type) return json({ error: `signals[${i}].type is required` }, 400);
		// A type nobody knows about would be stored and then counted as nothing.
		if (!(SIGNAL_TYPES as readonly string[]).includes(type)) {
			return json({ error: `signals[${i}].type must be one of ${SIGNAL_TYPES.join(', ')}` }, 400);
		}
		if (!label) return json({ error: `signals[${i}].label is required` }, 400);
		// A full date or a bare year, and nothing padded or approximate in between: "2021"
		// is what a source said, "2021-01-01" would be a date it did not give.
		for (const field of ['date', 'published'] as const) {
			const value = str(s[field]);
			if (value !== null && !/^\d{4}(-\d{2}-\d{2})?$/.test(value)) {
				return json({ error: `signals[${i}].${field} must be YYYY-MM-DD or YYYY` }, 400);
			}
		}
		signals.push({ ...(s as object), company_id: companyId, type, label } as SignalInput);
	}

	if (payload.gaps !== undefined && !Array.isArray(payload.gaps)) {
		return json({ error: 'gaps must be an array' }, 400);
	}
	const gaps: GapInput[] = [];
	for (const [i, raw] of ((payload.gaps ?? []) as unknown[]).entries()) {
		if (typeof raw !== 'object' || raw === null) {
			return json({ error: `gaps[${i}] must be an object` }, 400);
		}
		const g = raw as Record<string, unknown>;
		const companyId = str(g.company_id);
		const name = str(g.name);
		const missing = str(g.missing);
		const note = str(g.note);
		if (!companyId) return json({ error: `gaps[${i}].company_id is required` }, 400);
		if (!name) return json({ error: `gaps[${i}].name is required` }, 400);
		if (!missing) return json({ error: `gaps[${i}].missing is required` }, 400);
		// The reason is not optional. A hole nobody argued for is a shrug, and a
		// shrug is not evidence of anything.
		if (!note) return json({ error: `gaps[${i}].note is required` }, 400);
		gaps.push({ ...(g as object), company_id: companyId, name, missing, note } as GapInput);
	}

	if (payload.merged !== undefined && !Array.isArray(payload.merged)) {
		return json({ error: 'merged must be an array' }, 400);
	}
	const merged: MergeInput[] = [];
	for (const [i, raw] of ((payload.merged ?? []) as unknown[]).entries()) {
		const m = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
		const from = str(m.from);
		const into = str(m.into);
		if (!from || !into || from === into) return json({ error: `merged[${i}] needs two different ids, from and into` }, 400);
		merged.push({ from, into });
	}

	try {
		const result = await applyIngest(env, source, companies, signals, gaps, now, mode);
		result.merged = await applyMerges(env, merged, now);
		await env.DB.prepare(INSERT_RUN_SQL).bind(startedAt, source, 'ok', companies.length, null).run();
		return json(result);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// A failed run must still leave a trace, so the next run can see the gap.
		try {
			await env.DB.prepare(INSERT_RUN_SQL).bind(startedAt, source, 'failed', companies.length, message).run();
		} catch {
			// The database is the thing that is broken; nothing useful left to do.
		}
		return json({ error: 'ingest failed', detail: message }, 500);
	}
}

interface IngestResult {
	inserted: number;
	updated: number;
	signals_added: number;
	signals_skipped: number;
	gaps_recorded: number;
	/** Duplicate rows folded into the row that stays. */
	merged?: number;
	/** Said out loud in the response, because it decides what every date in it means. */
	backfill: boolean;
}

/**
 * A source's first day is a backfill: a list of companies other people have known about
 * for years. Nothing in it is a discovery, so nothing in it gets today's date. Asked
 * per source, not globally — a source added in month three brings its own history and
 * must not inherit anyone else's.
 *
 * The test is "has this source completed a run on an EARLIER day", not "has it ever
 * run", because one sweep is many requests: 539 companies do not fit in a single
 * payload, and a rule that flipped after the first chunk would stamp today's date on
 * every company in chunks two onward. That is the exact dishonesty this is here to
 * prevent, so the rule is written to survive it.
 *
 * The runs row is written after this, so a run that fails leaves only a 'failed' row
 * and the retry is still treated as the backfill. Wrong in the safe direction.
 */
async function isBackfill(env: Env, source: string, today: string): Promise<boolean> {
	const row = await env.DB.prepare(
		"SELECT 1 AS found FROM runs WHERE source = ?1 AND status = 'ok' AND substr(started_at, 1, 10) < ?2 LIMIT 1",
	)
		.bind(source, today)
		.first<{ found: number }>();
	return row === null;
}

/**
 * A cohort year is a year, so it lands on 1 January. Flooring errs the safe way: it
 * makes a company look older than it is, never newer, so it can never manufacture a
 * Tier A and it drops a company out of the age gate slightly early rather than late.
 */
function cohortDate(year: number | null): string | null {
	// The year as the source gave it. "2023-01-01" would be a day nobody said.
	return year === null ? null : String(year);
}

async function applyIngest(
	env: Env,
	source: string,
	companies: CompanyInput[],
	signals: SignalInput[],
	gaps: GapInput[],
	now: Date,
	mode: string | null,
): Promise<IngestResult> {
	const nowIso = now.toISOString();
	const today = isoDate(now);

	const backfill = mode === null ? await isBackfill(env, source, today) : mode === 'backfill';

	const payloadIds = [...new Set(companies.map((c) => c.id))];

	// Which ids already exist decides inserted vs updated — the upsert itself cannot
	// tell us, and we need the answer before it runs.
	const existingBefore = await selectExistingIds(env, payloadIds);
	const inserted = payloadIds.filter((id) => !existingBefore.has(id)).length;
	const updated = payloadIds.length - inserted;

	const writes = companies.map((c) => {
		// What the source says about when the company began, and what that means for a
		// row we are inserting today. On a backfill the cohort year is the best we can
		// honestly claim; on a live run the company was not on this list last time, and
		// today is the truthful date of that.
		// What put them on the public record, which is not always what started them.
		const cohort = cohortDate(int(c.record_year) ?? int(c.origin_year));
		const firstSeen = backfill ? cohort : today;
		const basis = firstSeen === null ? null : backfill ? 'cohort' : 'discovered';

		return env.DB.prepare(UPSERT_COMPANY_SQL).bind(
			c.id,
			c.name,
			str(c.description),
			str(c.website),
			str(c.city),
			str(c.state),
			str(c.cin),
			int(c.founded_year),
			int(c.origin_year),
			str(c.sector_id),
			str(c.subsector_id),
			str(c.project_type),
			str(c.classify_note),
			firstSeen,
			basis,
			today,
			nowIso,
			cohort,
			c.website_checked === false ? 0 : 1,
			str(c.classify_basis) ?? 'description',
			str(c.product),
			str(c.product_status),
			str(c.website_identity),
			str(c.website_identity_note),
			str(c.entity_type),
			str(c.entity_note),
			int(c.source_year),
			str(c.source_year_type),
			str(c.founders),
			str(c.founders) ? str(c.founders_source) : null,
			str(c.dpiit_status),
			str(c.dpiit_stage),
			str(c.contact_email),
			str(c.contact_page),
			str(c.domain_registered),
			c.papers ? JSON.stringify(c.papers) : null,
			str(c.description) ? str(c.description_source) : null,
			str(c.web_first_capture),
		);
	});

	// A signal needs its company to exist, or the foreign key rejects the whole batch.
	const known = new Set([...existingBefore, ...payloadIds]);
	const unknownCompanyIds = [...new Set(signals.map((s) => s.company_id).filter((id) => !known.has(id)))];
	const alsoExisting = await selectExistingIds(env, unknownCompanyIds);
	for (const id of alsoExisting) known.add(id);

	const accepted = signals.filter((s) => known.has(s.company_id));
	const signalsSkipped = signals.length - accepted.length;

	for (const s of accepted) {
		writes.push(
			env.DB.prepare(INSERT_SIGNAL_SQL).bind(
				s.company_id,
				s.type,
				s.label,
				str(s.date),
				str(s.url),
				str(s.source) ?? source,
				str(s.found_at) ?? nowIso,
				str(s.published),
			),
		);
	}

	let signalsAdded = 0;
	if (writes.length > 0) {
		const results = await env.DB.batch(writes);
		// INSERT OR IGNORE reports 0 changes when the UNIQUE constraint swallowed a repeat.
		for (const r of results.slice(companies.length)) {
			signalsAdded += r.meta?.changes ?? 0;
		}
	}

	// A company arriving as a real row is no longer a hole in the taxonomy, and a
	// company arriving as a hole must not also be a row. Both halves, in an order
	// that makes a payload carrying the same company as both resolve the same way
	// every time: placed wins.
	const placedNow = new Set(payloadIds);
	const gapWrites: D1PreparedStatement[] = gaps.map((g) =>
		env.DB.prepare(UPSERT_GAP_SQL).bind(g.company_id, g.name, str(g.description), str(g.sector_id), g.missing, g.note, source, nowIso),
	);

	const unplaced = [...new Set(gaps.map((g) => g.company_id))].filter((id) => !placedNow.has(id));
	for (const id of unplaced) {
		gapWrites.push(env.DB.prepare(DELETE_COMPANY_SIGNALS_SQL).bind(id));
		gapWrites.push(env.DB.prepare(DELETE_COMPANY_SQL).bind(id));
	}

	for (const id of payloadIds) gapWrites.push(env.DB.prepare(DELETE_GAP_SQL).bind(id));
	for (const c of companies) {
		// A dead domain, or an address that is not theirs: neither is a trace of them.
		if (str(c.product_status) === 'unreachable' || str(c.website_identity) === 'discovered') {
			gapWrites.push(env.DB.prepare(DELETE_WEBSITE_TRACE_SQL).bind(c.id));
		}
	}
	// The register says one thing about a company at a time. Its evidence line is keyed by
	// label, so a recognition that lapses, or a profile that is recognised, would otherwise
	// sit beside the line it replaces and read as both.
	for (const s of accepted) {
		if (s.type === 'dpiit') gapWrites.push(env.DB.prepare(DELETE_STALE_REGISTER_SIGNAL_SQL).bind(s.company_id, s.label));
	}
	// Earliest first, so of two dated events arriving together the older one dates the row.
	const datedEvents = accepted.filter((s) => str(s.date) !== null).sort((a, b) => (str(a.date)! < str(b.date)! ? -1 : 1));
	for (const s of datedEvents) gapWrites.push(env.DB.prepare(DATE_FROM_EVENT_SQL).bind(s.company_id, str(s.date)));
	if (gapWrites.length > 0) await env.DB.batch(gapWrites);

	// A row that has just been deleted has no ranking to recompute.
	//
	// Every A and B row as well, touched or not. A tier is stored, and a row no source
	// sends any more — a DPIIT company scrolled out of the register's recent window —
	// kept whatever tier it had on its last visit: past its 90 days, and past a rule
	// written after it. On 14 September 2026 nine register-label rows sat in Tier A
	// that way. Nothing climbs into A or B by standing still, so C rows can wait.
	const ranked = await env.DB.prepare("SELECT id FROM companies WHERE tier IN ('A', 'B')").all<{ id: string }>();
	const removed = new Set(unplaced);
	const touched = [...new Set([...payloadIds, ...accepted.map((s) => s.company_id), ...ranked.results.map((r) => r.id)])].filter(
		(id) => !removed.has(id),
	);
	await recomputeRanking(env, touched, nowIso, now);

	return {
		inserted,
		updated,
		signals_added: signalsAdded,
		signals_skipped: signalsSkipped,
		gaps_recorded: gaps.length,
		backfill,
	};
}

/**
 * Fold a company listed twice into one row.
 *
 * The ids are slugs of names, so "Call X Ringers" and "CallX Ringers" were two rows and
 * two sets of traces. The ingest decides which spellings are one company
 * (ingest/duplicates.py) and from then on sends every copy under `into`, which brings
 * the traces across; what is left here is the old row. It goes, and takes nothing with
 * it that should stay: the earlier of the two dates is kept on `into`, because a merge
 * must not make a company look newer than either listing said, and a private note
 * moves with the company.
 *
 * Only where `into` exists. A duplicate whose surviving row never arrived is left
 * standing rather than deleted into nothing.
 */
async function applyMerges(env: Env, merges: MergeInput[], now: Date): Promise<number> {
	if (merges.length === 0) return 0;
	const present = await selectExistingIds(env, [...new Set(merges.map((m) => m.into))]);
	const doable = merges.filter((m) => present.has(m.into));
	const writes: D1PreparedStatement[] = [];
	for (const { from, into } of doable) {
		writes.push(
			env.DB.prepare(
				`UPDATE companies SET
				   first_seen       = (SELECT f.first_seen FROM companies f WHERE f.id = ?1),
				   first_seen_basis = (SELECT f.first_seen_basis FROM companies f WHERE f.id = ?1)
				 WHERE id = ?2 AND EXISTS (
				   SELECT 1 FROM companies f WHERE f.id = ?1 AND f.first_seen IS NOT NULL
				     AND (companies.first_seen IS NULL OR f.first_seen < companies.first_seen))`,
			).bind(from, into),
			env.DB.prepare('UPDATE OR IGNORE notes SET company_id = ?2 WHERE company_id = ?1').bind(from, into),
			env.DB.prepare(DELETE_COMPANY_SIGNALS_SQL).bind(from),
			env.DB.prepare(DELETE_COMPANY_SQL).bind(from),
			env.DB.prepare(DELETE_GAP_SQL).bind(from),
		);
	}
	if (writes.length > 0) await env.DB.batch(writes);
	await recomputeRanking(env, [...new Set(doable.map((m) => m.into))], now.toISOString(), now);
	return doable.length;
}

async function selectExistingIds(env: Env, ids: string[]): Promise<Set<string>> {
	const found = new Set<string>();
	for (const group of chunk(ids, BIND_CHUNK)) {
		const { results } = await env.DB.prepare(`SELECT id FROM companies WHERE id IN (${placeholders(group.length)})`)
			.bind(...group)
			.all<{ id: string }>();
		for (const row of results) found.add(row.id);
	}
	return found;
}

/** Recompute trace_count and tier, for touched companies only (Part 9). */
async function recomputeRanking(env: Env, ids: string[], nowIso: string, now: Date): Promise<void> {
	const updates: D1PreparedStatement[] = [];

	for (const group of chunk(ids, BIND_CHUNK)) {
		const { results } = await env.DB.prepare(
			`SELECT c.id, c.first_seen, c.first_seen_basis, c.origin_year, c.classify_basis,
			   (SELECT COUNT(*) FROM signals s
			     WHERE s.company_id = c.id
			       AND s.type IN (${placeholders(TRACE_TYPES.length)})) AS trace_count,
			   (SELECT MIN(s.date) FROM signals s WHERE s.company_id = c.id AND s.date IS NOT NULL) AS earliest_signal
			 FROM companies c WHERE c.id IN (${placeholders(group.length)})`,
		)
			.bind(...TRACE_TYPES, ...group)
			.all<{
				id: string;
				first_seen: string | null;
				first_seen_basis: string | null;
				origin_year: number | null;
				classify_basis: string | null;
				trace_count: number;
				earliest_signal: string | null;
			}>();

		for (const row of results) {
			updates.push(
				env.DB.prepare('UPDATE companies SET trace_count = ?1, tier = ?2, updated_at = ?3 WHERE id = ?4').bind(
					row.trace_count,
					tierFor(
						row.first_seen,
						row.first_seen_basis,
						row.trace_count,
						now,
						earliestEvent([row.earliest_signal], row.origin_year),
						row.classify_basis,
					),
					nowIso,
					row.id,
				),
			);
		}
	}

	if (updates.length > 0) await env.DB.batch(updates);
}

// --- GET /upstream/api/gaps -------------------------------------------------

async function gapsApi(env: Env): Promise<Response> {
	return json(await queryGaps(env), 200, PUBLIC_CACHE);
}

// --- one view, three answers ------------------------------------------------

/**
 * A url turned into the two list queries it means, once, for the page, its counts
 * and its CSV.
 *
 * These used to be built twice. The page defaulted the tier choice to A and B once
 * anything was ranked; the export defaulted to every tier; so "Download CSV" on the
 * front page handed over rows the page was not showing, and the counts above the
 * list were about neither. Anything that answers "what is in this view" goes through
 * here, or it is answering a different question.
 */
async function listView(url: URL, env: Env, now: Date, limit: number) {
	const demo = url.searchParams.get('demo') === '1';
	// Until something qualifies for A or B — before the first live run, or while every
	// live find is a register record with nothing but a label — A+B is empty. Opening on
	// an empty list would read as a broken page, so the default widens to everything and
	// the list says why. It narrows again on its own the moment something qualifies. The
	// sample data has both tiers already.
	const half = { described: parseDescribedChoice(url.searchParams.get('described')), kind: parseKind(url.searchParams.get('kind')) };
	const hasRanked = demo || (await queryHasRanked(env, minOriginYear(now), half));
	const defaultTier: TierChoice = hasRanked ? 'ab' : 'all';
	const tier = parseTierChoice(url.searchParams.get('tier'), defaultTier);
	const age = parseAgeChoice(url.searchParams.get('age'));
	const dates = parseDates(url.searchParams.get('dates'));

	const ranked: Filters = {
		sector: url.searchParams.get('sector') || null,
		subsector: url.searchParams.get('subsector') || null,
		// Trimmed here rather than in the query, so what the box shows, what the URL
		// says and what was searched for are one string.
		search: (url.searchParams.get('q') || '').trim() || null,
		source: parseSource(url.searchParams.get('source')),
		site: parseSite(url.searchParams.get('site')),
		traces: parseTraces(url.searchParams.get('traces')),
		described: parseDescribedChoice(url.searchParams.get('described')),
		kind: parseKind(url.searchParams.get('kind')),
		dpiit: parseDpiit(url.searchParams.get('dpiit')),
		// Bound as a value, never spliced, so any string is safe; one that names no
		// state simply matches nothing and the list says so.
		state: (url.searchParams.get('state') || '').trim().slice(0, 60) || null,
		sort: parseSort(url.searchParams.get('sort')),
		tiers: TIER_SETS[tier],
		dated: 'dated',
		minOriginYear: age === 'all' ? null : minOriginYear(now),
		limit,
	};
	// The undated section sits outside the ranking, so the tier toggle and the age gate
	// have nothing to say about it. Sector and sub-sector still apply: clicking a
	// coverage cell has to filter the whole page, not half of it.
	const undated: Filters = { ...ranked, tiers: null, dated: 'undated', minOriginYear: null };

	return { demo, hasRanked, defaultTier, tier, age, dates, ranked, undated, wantRanked: dates !== 'undated', wantUndated: dates !== 'dated' };
}

// --- GET /upstream ----------------------------------------------------------

async function page(url: URL, env: Env): Promise<Response> {
	const now = new Date();
	const view = await listView(url, env, now, DEFAULT_LIMIT);
	const { demo, hasRanked, defaultTier, tier, age, dates, ranked, undated: unplaceable } = view;
	const { sector, subsector, search, source, site, sort } = ranked;

	const weekAgo = isoDate(new Date(now.getTime() - 7 * 86_400_000));
	const [coverage, companies, undated, buckets, gaps, discoveredThisWeek, register, oneTrace, products, notCompanies, sourceHealth, widgets, substance, findings, category] = await Promise.all([
		queryCoverage(env),
		dates === 'undated'
			? Promise.resolve([])
			: demo
				? Promise.resolve(splitDemo(demoCompanies(), now).ranked)
				: queryCompanies(env, ranked),
		dates === 'dated'
			? Promise.resolve([])
			: demo
				? Promise.resolve(splitDemo(demoCompanies(), now).undated)
				: queryCompanies(env, unplaceable),
		demo ? Promise.resolve(splitDemo(demoCompanies(), now).buckets) : queryBuckets(env, ranked),
		demo ? Promise.resolve(demoGaps()) : queryGaps(env),
		queryDiscoveredSince(env, weekAgo),
		demo ? Promise.resolve(demoRegisterOutcomes()) : queryRegisterOutcomes(env),
		// The demo set has to answer this the same way the database does, or the row
		// design gets checked against a headline number that is not about it.
		demo ? Promise.resolve(demoCompanies().filter((c) => c.trace_count <= 1).length) : queryOneTraceCount(env),
		// The demo answers this from its own rows too, so the paragraph under the list
		// is about the seven companies on screen rather than about the database.
		demo ? Promise.resolve(demoProductOutcomes()) : queryProductOutcomes(env),
		demo ? Promise.resolve(0) : queryNotCompanies(env),
		querySourceHealth(env),
		// The sample rows are not in the database, and widgets counting the database over
		// them would describe a different page. The demo has none.
		demo ? Promise.resolve(null) : queryWidgets(env, ranked),
		querySubstance(env),
		demo ? Promise.resolve(null) : queryFindings(env),
		// The chosen half on its own, so the result line counts out of it.
		demo
			? Promise.resolve(null)
			: queryBuckets(env, { ...ranked, sector: null, subsector: null, search: null, source: null, site: null, state: null, traces: null }),
	]);
	const ask = askMode(env);

	const html = renderPage({
		coverage,
		companies,
		undated,
		buckets,
		gaps,
		// The two tables are disjoint — a company is a row or a hole, never both —
		// so the top of the funnel is simply their sum.
		found: coverage.total_companies + gaps.total,
		register,
		products,
		tracked: coverage.total_companies,
		notCompanies,
		sourceHealth,
		widgets,
		ask,
		state: ranked.state ?? null,
		traces: ranked.traces ?? null,
		described: ranked.described ?? null,
		kind: ranked.kind ?? null,
		dpiit: ranked.dpiit ?? null,
		substance,
		findings,
		origin: url.origin,
		category: category?.total ?? coverage.total_companies,
		oneTrace,
		discoveredThisWeek,
		sector,
		subsector,
		search,
		source,
		site,
		sort,
		dates,
		tier,
		defaultTier,
		backfillOnly: !hasRanked,
		age,
		demo,
		now,
	});

	return new Response(html, {
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': PUBLIC_CACHE },
	});
}

// --- GET /upstream/export.csv -----------------------------------------------

/**
 * One CSV field. Quoted whenever it could possibly need to be, and a leading =, +, -
 * or @ defanged with a single quote.
 *
 * That last part is not paranoia about our own data: a spreadsheet treats a cell
 * starting with = as a formula, these names and descriptions are scraped from pages we
 * do not control, and the whole point of this file is that somebody opens it in Excel.
 */
function csvField(value: unknown): string {
	if (value === null || value === undefined) return '';
	const text = String(value);
	const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
	return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * The current view as a file, with the columns that carry a decision.
 *
 * Every column is something on the page. The two that are not — the detail url and the
 * signal count — are there because a spreadsheet cannot follow a link it does not have
 * and cannot count rows it cannot see. Nothing is invented, nothing is summarised, and
 * a NULL stays empty rather than becoming "unknown", which would be this file claiming
 * something the database does not.
 */
const CSV_COLUMNS = [
	'name',
	'builds',
	'builds_from',
	'source_description',
	'website',
	'website_identity',
	'website_looked_for',
	'entity_type',
	'founders',
	'founders_source',
	'dpiit_status',
	'dpiit_stage',
	'contact_email',
	'contact_page',
	'domain_registered',
	'web_first_capture',
	'papers_found',
	'city',
	'state',
	'rdi_sector',
	'rdi_subsector',
	'rdi_project',
	'placed_from',
	'classifier_reasoning',
	'tier',
	'public_traces',
	'on_record',
	'on_record_basis',
	'started',
	'in_database',
	'signals',
	'page',
] as const;

async function exportCsv(url: URL, env: Env): Promise<Response> {
	const now = new Date();
	// A file is for taking away, so it is capped higher than the page renders. That is
	// the one way the two differ, and it differs by giving more rather than less.
	const view = await listView(url, env, now, MAX_LIMIT);

	// The page is two lists — the ranking, and the companies no source will date — and
	// "export this view" has to mean both of them when both are on screen, under the
	// same filters, in the same order.
	const [ranked, undatedRows] = await Promise.all([
		view.wantRanked ? queryCompanies(env, view.ranked) : Promise.resolve([]),
		view.wantUndated ? queryCompanies(env, view.undated) : Promise.resolve([]),
	]);
	const companies = [...ranked, ...undatedRows];

	const origin = `${url.origin}${BASE}`;
	const rows = companies.map((c) =>
		[
			c.name,
			c.product,
			// Said in the file too. A column of sentences with no provenance is exactly
			// the thing the page refuses to print. Plain text, not an HTML entity: this
			// is a spreadsheet, and &apos; in a cell is just wrong.
			c.product ? "the company's own homepage" : '',
			registerText(c.description, c.dpiit_status),
			c.website,
			c.website_identity,
			c.website_checked ? 'yes' : 'no',
			c.entity_type,
			c.founders,
			c.founders ? c.founders_source : '',
			c.dpiit_status,
			c.dpiit_stage,
			// The same gate as the page: nothing read off an address that is not theirs.
			c.website_identity === 'verified' ? c.contact_email : '',
			c.website_identity === 'verified' ? c.contact_page : '',
			c.website_identity === 'verified' ? c.domain_registered : '',
			c.website_identity === 'verified' ? c.web_first_capture : '',
			papersOf(c.papers)?.count ?? '',
			c.city,
			c.state,
			c.sector_id,
			c.subsector_id ? (SUBSECTOR_BY_ID.get(c.subsector_id)?.subsector ?? c.subsector_id) : '',
			c.project_type,
			c.classify_basis,
			c.classify_note,
			c.tier,
			c.trace_count,
			c.first_seen,
			c.first_seen_basis,
			c.origin_year ?? c.founded_year,
			c.discovered,
			c.signals.length,
			`${origin}/c/${c.id}`,
		]
			.map(csvField)
			.join(','),
	);

	// \r\n and a BOM, because the audience for this file is a spreadsheet on Windows
	// and without the BOM Excel reads UTF-8 names as mojibake.
	const body = `\uFEFF${[CSV_COLUMNS.map(csvField).join(','), ...rows].join('\r\n')}\r\n`;

	// Dated, so two exports a week apart do not overwrite each other in a downloads
	// folder — the list changes nightly and which day it was is part of the data.
	const name = `upstream-${isoDate(now)}.csv`;
	return new Response(body, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="${name}"`,
			'cache-control': PUBLIC_CACHE,
		},
	});
}

// --- GET /upstream/c/:id ----------------------------------------------------

async function companyPage(id: string, env: Env, url: URL): Promise<Response> {
	const company = await queryCompany(env, id);
	if (company === null) {
		// A plain 404 rather than a redirect to the list: a link that stops working
		// should say so, not quietly land somebody on a different page.
		return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
	}
	return new Response(renderCompanyPage({ company, now: new Date(), pageUrl: `${url.origin}${BASE_PATH}/c/${company.id}` }), {
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': PUBLIC_CACHE },
	});
}

// --- the question box ------------------------------------------------------

async function askApi(request: Request, env: Env): Promise<Response> {
	const mode = askMode(env);
	// Off is a 404, like the notebook: an endpoint that answers "resting" before anyone
	// has decided to turn it on is advertising a door.
	if (mode === null) return json({ error: 'not found' }, 404);
	if (Number(request.headers.get('content-length') ?? 0) > 4096) {
		return json({ status: 'invalid', message: 'Keep it under 300 characters.' }, 413, 'no-store');
	}
	const result = await handleAsk(request, env, mode === 'on' ? anthropicCreate(env) : undefined);
	return json(result, result.status === 'invalid' ? 400 : 200, 'no-store');
}

async function askLogPage(request: Request, env: Env): Promise<Response> {
	if (accessConfig(env) === null) return json({ error: 'not found' }, 404);
	if ((await identify(request, env)) === null) {
		return new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' } });
	}
	try {
		return new Response(renderAskLog(await queryAskLog(env)), { headers: PRIVATE_HEADERS });
	} catch {
		return new Response('The question log is not set up yet: apply migration 0016.', { status: 503, headers: PRIVATE_HEADERS });
	}
}

// --- the private notebook ---------------------------------------------------

/**
 * Everything under /upstream/notes, behind Cloudflare Access.
 *
 * Two guards, and the order matters. Unconfigured is a 404 and not a 403: before
 * ACCESS_AUD is set there is no application in front of this, so answering "forbidden"
 * would be advertising an unprotected door. Configured but unproven is a 403, which is
 * the honest answer to somebody who reached a real door without a key.
 *
 * The identity comes from `identify`, which verifies the token's signature. The
 * `Cf-Access-Authenticated-User-Email` header is never read anywhere in this file.
 */
async function notes(request: Request, url: URL, env: Env, path: string): Promise<Response> {
	if (accessConfig(env) === null) return json({ error: 'not found' }, 404);

	const who = await identify(request, env);
	if (who === null) {
		return new Response('Forbidden', {
			status: 403,
			headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' },
		});
	}

	const rest = path.slice(`${BASE}/notes`.length).replace(/^\//, '');

	if (rest === '') {
		if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
		return new Response(renderNotebook(await queryNotes(env), who.email), { headers: PRIVATE_HEADERS });
	}

	const companyId = rest;
	if (companyId.includes('/')) return json({ error: 'not found' }, 404);

	if (request.method === 'POST') {
		const form = await request.formData();
		if (form.get('delete') === '1') {
			await deleteNote(env, companyId);
		} else {
			const body = String(form.get('body') ?? '').trim();
			// An empty note is a deleted note. Storing a row with nothing in it would
			// put a blank entry in the notebook that reads as a bug.
			if (body === '') await deleteNote(env, companyId);
			else await saveNote(env, companyId, body, who.email);
		}
		// POST then redirect, so a refresh after saving does not write again.
		return new Response(null, {
			status: 303,
			headers: { location: `${BASE}/notes/${companyId}`, 'cache-control': 'private, no-store' },
		});
	}

	if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD, POST');

	const [company, note] = await Promise.all([queryCompany(env, companyId), queryNote(env, companyId)]);
	return new Response(renderNoteEditor(company, companyId, note, who.email), { headers: PRIVATE_HEADERS });
}

// --- router -----------------------------------------------------------------

function methodNotAllowed(allow: string): Response {
	return new Response(null, { status: 405, headers: { allow } });
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);
		// Trailing slashes are the same route: /upstream/ is /upstream.
		const path = url.pathname.replace(/\/+$/, '') || '/';
		const isRead = request.method === 'GET' || request.method === 'HEAD';

		// The notebook, before anything else, because it is the one part of this Worker
		// that answers differently depending on who is asking.
		if (path === `${BASE}/notes` || path.startsWith(`${BASE}/notes/`)) {
			return notes(request, url, env, path);
		}

		// One company, by slug. Checked before the switch because it is the only route
		// with a variable in it, and a slug is not a path: anything with a slash in it
		// is somebody probing, not a company.
		if (path.startsWith(`${BASE}/c/`)) {
			if (!isRead) return methodNotAllowed('GET, HEAD');
			const id = path.slice(`${BASE}/c/`.length);
			return id && !id.includes('/') ? companyPage(id, env, url) : json({ error: 'not found' }, 404);
		}

		switch (path) {
			case BASE:
				return isRead ? page(url, env) : methodNotAllowed('GET, HEAD');

			case `${BASE}/export.csv`:
				return isRead ? exportCsv(url, env) : methodNotAllowed('GET, HEAD');

			case `${BASE}/api/companies`:
				return isRead ? listCompaniesApi(url, env) : methodNotAllowed('GET, HEAD');

			case `${BASE}/api/coverage`:
				return isRead ? coverageApi(env) : methodNotAllowed('GET, HEAD');

			case `${BASE}/api/gaps`:
				return isRead ? gapsApi(env) : methodNotAllowed('GET, HEAD');

			case `${BASE}/api/ingest`:
				return request.method === 'POST' ? ingest(request, env) : methodNotAllowed('POST');

			case `${BASE}/api/sources`:
				return isRead ? json(await querySourceHealth(env), 200, PUBLIC_CACHE) : methodNotAllowed('GET, HEAD');

			case `${BASE}/api/ask`:
				return request.method === 'POST' ? askApi(request, env) : methodNotAllowed('POST');

			case `${BASE}/asks`:
				return isRead ? askLogPage(request, env) : methodNotAllowed('GET, HEAD');

			case `${BASE}/api/source-runs`:
				return request.method === 'POST' ? recordSourceRuns(request, env) : methodNotAllowed('POST');

			default:
				return json({ error: 'not found' }, 404);
		}
	},
} satisfies ExportedHandler<Env>;
