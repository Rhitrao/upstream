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
 *   POST /upstream/api/ingest       write endpoint, needs X-Ingest-Key
 */
import { TRACE_TYPES, TIERS, minOriginYear, tierFor, type Tier } from './rank';
import { queryBuckets, queryCompanies, queryCoverage, queryDiscoveredSince, queryGaps, queryHasRanked, type Filters } from './db';
import { renderPage, type AgeChoice, type TierChoice } from './page';
import { demoCompanies, demoGaps, splitDemo } from './demo';

const BASE = '/upstream';

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

	const companies = await queryCompanies(env, {
		sector: url.searchParams.get('sector') || null,
		subsector: url.searchParams.get('subsector') || null,
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

// --- POST /upstream/api/ingest ---------------------------------------------

interface CompanyInput {
	id: string;
	name: string;
	description?: string | null;
	website?: string | null;
	city?: string | null;
	state?: string | null;
	cin?: string | null;
	founded_year?: number | null;
	origin_year?: number | null;
	sector_id?: string | null;
	subsector_id?: string | null;
	project_type?: string | null;
	classify_note?: string | null;
}

/**
 * A company the classifier placed in a sector but in none of its sub-sectors.
 * It is not a company row: it is the evidence that the taxonomy has a hole.
 */
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
  id, name, description, website, city, state, cin, founded_year, origin_year,
  sector_id, subsector_id, project_type, classify_note,
  first_seen, first_seen_basis, discovered, trace_count, tier, updated_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0, 'C', ?17)
ON CONFLICT(id) DO UPDATE SET
  name          = excluded.name,
  description   = COALESCE(excluded.description,   companies.description),
  website       = COALESCE(excluded.website,       companies.website),
  city          = COALESCE(excluded.city,          companies.city),
  state         = COALESCE(excluded.state,         companies.state),
  cin           = COALESCE(excluded.cin,           companies.cin),
  founded_year  = COALESCE(excluded.founded_year,  companies.founded_year),
  origin_year   = COALESCE(MIN(companies.origin_year, excluded.origin_year), companies.origin_year, excluded.origin_year),
  sector_id     = COALESCE(excluded.sector_id,     companies.sector_id),
  subsector_id  = COALESCE(excluded.subsector_id,  companies.subsector_id),
  project_type  = COALESCE(excluded.project_type,  companies.project_type),
  classify_note = COALESCE(excluded.classify_note, companies.classify_note),
  first_seen       = CASE WHEN companies.first_seen IS NULL THEN ?18 ELSE companies.first_seen END,
  first_seen_basis = CASE WHEN companies.first_seen IS NULL AND ?18 IS NOT NULL THEN 'cohort' ELSE companies.first_seen_basis END,
  updated_at    = excluded.updated_at`;

const INSERT_SIGNAL_SQL = `
INSERT OR IGNORE INTO signals (company_id, type, label, date, url, source, found_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;

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
		// A junk year would quietly decide whether a company is old enough to hide.
		if (c.origin_year !== undefined && c.origin_year !== null && !isPlausibleYear(int(c.origin_year), now)) {
			return json({ error: `companies[${i}].origin_year must be a four-digit year no later than next year` }, 400);
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
		if (!label) return json({ error: `signals[${i}].label is required` }, 400);
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

	try {
		const result = await applyIngest(env, source, companies, signals, gaps, now, mode);
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
	return year === null ? null : `${year}-01-01`;
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
		const cohort = cohortDate(int(c.origin_year));
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
	// company arriving as a hole must not also be a row.
	const gapWrites: D1PreparedStatement[] = gaps.map((g) =>
		env.DB.prepare(UPSERT_GAP_SQL).bind(g.company_id, g.name, str(g.description), str(g.sector_id), g.missing, g.note, source, nowIso),
	);
	for (const id of payloadIds) gapWrites.push(env.DB.prepare(DELETE_GAP_SQL).bind(id));
	if (gapWrites.length > 0) await env.DB.batch(gapWrites);

	const touched = [...new Set([...payloadIds, ...accepted.map((s) => s.company_id)])];
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
			`SELECT c.id, c.first_seen, c.first_seen_basis,
			   (SELECT COUNT(*) FROM signals s
			     WHERE s.company_id = c.id
			       AND s.type IN (${placeholders(TRACE_TYPES.length)})) AS trace_count
			 FROM companies c WHERE c.id IN (${placeholders(group.length)})`,
		)
			.bind(...TRACE_TYPES, ...group)
			.all<{ id: string; first_seen: string | null; first_seen_basis: string | null; trace_count: number }>();

		for (const row of results) {
			updates.push(
				env.DB.prepare('UPDATE companies SET trace_count = ?1, tier = ?2, updated_at = ?3 WHERE id = ?4').bind(
					row.trace_count,
					tierFor(row.first_seen, row.first_seen_basis, row.trace_count, now),
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

// --- GET /upstream ----------------------------------------------------------

async function page(url: URL, env: Env): Promise<Response> {
	const now = new Date();
	const age = parseAgeChoice(url.searchParams.get('age'));
	const sector = url.searchParams.get('sector') || null;
	const subsector = url.searchParams.get('subsector') || null;

	// Seven invented companies, so the row design can be checked before real data lands
	// (CHECKPOINT 7). Never shown unless explicitly asked for, and always behind a banner.
	const demo = url.searchParams.get('demo') === '1';

	// Until the first live run, every row is a backfill and A+B is empty by
	// construction. Opening on an empty list would read as a broken page, so the
	// default widens to everything and the list says why. It narrows again on its own
	// the moment a real discovery lands. The sample data has both tiers already.
	const hasRanked = demo || (await queryHasRanked(env));
	const defaultTier: TierChoice = hasRanked ? 'ab' : 'all';
	const tier = parseTierChoice(url.searchParams.get('tier'), defaultTier);

	const cutoff = minOriginYear(now);
	const ranked: Filters = {
		sector,
		subsector,
		tiers: TIER_SETS[tier],
		dated: 'dated',
		minOriginYear: age === 'all' ? null : cutoff,
		limit: DEFAULT_LIMIT,
	};
	// The undated section sits outside the ranking, so the tier toggle and the age gate
	// have nothing to say about it. Sector and sub-sector still apply: clicking a
	// coverage cell has to filter the whole page, not half of it.
	const unplaceable: Filters = { ...ranked, tiers: null, dated: 'undated', minOriginYear: null };

	const weekAgo = isoDate(new Date(now.getTime() - 7 * 86_400_000));
	const [coverage, companies, undated, buckets, gaps, discoveredThisWeek] = await Promise.all([
		queryCoverage(env),
		demo ? Promise.resolve(splitDemo(demoCompanies(), now).ranked) : queryCompanies(env, ranked),
		demo ? Promise.resolve(splitDemo(demoCompanies(), now).undated) : queryCompanies(env, unplaceable),
		demo ? Promise.resolve(splitDemo(demoCompanies(), now).buckets) : queryBuckets(env, ranked, cutoff),
		demo ? Promise.resolve(demoGaps()) : queryGaps(env),
		queryDiscoveredSince(env, weekAgo),
	]);

	const html = renderPage({
		coverage,
		companies,
		undated,
		buckets,
		gaps,
		tracked: coverage.total_companies,
		discoveredThisWeek,
		sector,
		subsector,
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

		switch (path) {
			case BASE:
				return isRead ? page(url, env) : methodNotAllowed('GET, HEAD');

			case `${BASE}/api/companies`:
				return isRead ? listCompaniesApi(url, env) : methodNotAllowed('GET, HEAD');

			case `${BASE}/api/coverage`:
				return isRead ? coverageApi(env) : methodNotAllowed('GET, HEAD');

			case `${BASE}/api/gaps`:
				return isRead ? gapsApi(env) : methodNotAllowed('GET, HEAD');

			case `${BASE}/api/ingest`:
				return request.method === 'POST' ? ingest(request, env) : methodNotAllowed('POST');

			default:
				return json({ error: 'not found' }, 404);
		}
	},
} satisfies ExportedHandler<Env>;
