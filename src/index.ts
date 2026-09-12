/**
 * Upstream — the Worker. Serves the HTML page and the JSON API, and nothing else.
 * It never scrapes: all the slow work already happened hours ago in GitHub Actions.
 *
 * Everything lives under /upstream because that is what the route sends us
 * (rohitrao.in/upstream* — see Part 8).
 *
 *   GET  /upstream                  the HTML page
 *   GET  /upstream/api/companies    JSON list; filters: sector, subsector, tier, limit
 *   GET  /upstream/api/coverage     company count per sub-sector, for the coverage map
 *   POST /upstream/api/ingest       write endpoint, needs X-Ingest-Key
 */
import { TRACE_TYPES, TIERS, tierFor, type Tier } from './rank';
import { queryAddedSince, queryCompanies, queryCoverage } from './db';
import { renderPage, type TierChoice } from './page';
import { demoCompanies } from './demo';

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

function parseTierChoice(raw: string | null): TierChoice {
	if (raw === 'a' || raw === 'all') return raw;
	return 'ab';
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

	const companies = await queryCompanies(env, {
		sector: url.searchParams.get('sector') || null,
		subsector: url.searchParams.get('subsector') || null,
		tiers,
		limit,
	});

	return json({ count: companies.length, limit, companies }, 200, PUBLIC_CACHE);
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
	sector_id?: string | null;
	subsector_id?: string | null;
	project_type?: string | null;
	classify_note?: string | null;
	first_seen?: string | null;
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
 * first_seen is the memory of when we were early, and the only thing that eventually
 * proves the whole idea worked. It is written on insert and never again — note its
 * absence from the DO UPDATE list. Every other text column uses COALESCE so a later,
 * thinner record cannot blank out something we already knew.
 */
const UPSERT_COMPANY_SQL = `
INSERT INTO companies (
  id, name, description, website, city, state, cin, founded_year,
  sector_id, subsector_id, project_type, classify_note,
  first_seen, trace_count, tier, updated_at
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 0, 'C', ?14)
ON CONFLICT(id) DO UPDATE SET
  name          = excluded.name,
  description   = COALESCE(excluded.description,   companies.description),
  website       = COALESCE(excluded.website,       companies.website),
  city          = COALESCE(excluded.city,          companies.city),
  state         = COALESCE(excluded.state,         companies.state),
  cin           = COALESCE(excluded.cin,           companies.cin),
  founded_year  = COALESCE(excluded.founded_year,  companies.founded_year),
  sector_id     = COALESCE(excluded.sector_id,     companies.sector_id),
  subsector_id  = COALESCE(excluded.subsector_id,  companies.subsector_id),
  project_type  = COALESCE(excluded.project_type,  companies.project_type),
  classify_note = COALESCE(excluded.classify_note, companies.classify_note),
  updated_at    = excluded.updated_at`;

const INSERT_SIGNAL_SQL = `
INSERT OR IGNORE INTO signals (company_id, type, label, date, url, source, found_at)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`;

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

async function ingest(request: Request, env: Env): Promise<Response> {
	const startedAt = new Date().toISOString();

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

	try {
		const result = await applyIngest(env, source, companies, signals, new Date());
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
}

async function applyIngest(env: Env, source: string, companies: CompanyInput[], signals: SignalInput[], now: Date): Promise<IngestResult> {
	const nowIso = now.toISOString();
	const today = isoDate(now);

	const payloadIds = [...new Set(companies.map((c) => c.id))];

	// Which ids already exist decides inserted vs updated — the upsert itself cannot
	// tell us, and we need the answer before it runs.
	const existingBefore = await selectExistingIds(env, payloadIds);
	const inserted = payloadIds.filter((id) => !existingBefore.has(id)).length;
	const updated = payloadIds.length - inserted;

	const writes = companies.map((c) =>
		env.DB.prepare(UPSERT_COMPANY_SQL).bind(
			c.id,
			c.name,
			str(c.description),
			str(c.website),
			str(c.city),
			str(c.state),
			str(c.cin),
			int(c.founded_year),
			str(c.sector_id),
			str(c.subsector_id),
			str(c.project_type),
			str(c.classify_note),
			str(c.first_seen) ?? today,
			nowIso,
		),
	);

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

	const touched = [...new Set([...payloadIds, ...accepted.map((s) => s.company_id)])];
	await recomputeRanking(env, touched, nowIso, now);

	return { inserted, updated, signals_added: signalsAdded, signals_skipped: signalsSkipped };
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
			`SELECT c.id, c.first_seen,
			   (SELECT COUNT(*) FROM signals s
			     WHERE s.company_id = c.id
			       AND s.type IN (${placeholders(TRACE_TYPES.length)})) AS trace_count
			 FROM companies c WHERE c.id IN (${placeholders(group.length)})`,
		)
			.bind(...TRACE_TYPES, ...group)
			.all<{ id: string; first_seen: string; trace_count: number }>();

		for (const row of results) {
			updates.push(
				env.DB.prepare('UPDATE companies SET trace_count = ?1, tier = ?2, updated_at = ?3 WHERE id = ?4').bind(
					row.trace_count,
					tierFor(row.first_seen, row.trace_count, now),
					nowIso,
					row.id,
				),
			);
		}
	}

	if (updates.length > 0) await env.DB.batch(updates);
}

// --- GET /upstream ----------------------------------------------------------

async function page(url: URL, env: Env): Promise<Response> {
	const now = new Date();
	const tier = parseTierChoice(url.searchParams.get('tier'));
	const sector = url.searchParams.get('sector') || null;
	const subsector = url.searchParams.get('subsector') || null;

	// Five invented companies, so the row design can be checked before real data lands
	// (CHECKPOINT 7). Never shown unless explicitly asked for, and always behind a banner.
	const demo = url.searchParams.get('demo') === '1';

	const weekAgo = isoDate(new Date(now.getTime() - 7 * 86_400_000));
	const [coverage, companies, addedThisWeek] = await Promise.all([
		queryCoverage(env),
		demo ? Promise.resolve(demoCompanies()) : queryCompanies(env, { sector, subsector, tiers: TIER_SETS[tier], limit: DEFAULT_LIMIT }),
		queryAddedSince(env, weekAgo),
	]);

	const html = renderPage({
		coverage,
		companies,
		tracked: coverage.total_companies,
		addedThisWeek,
		sector,
		subsector,
		tier,
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

			case `${BASE}/api/ingest`:
				return request.method === 'POST' ? ingest(request, env) : methodNotAllowed('POST');

			default:
				return json({ error: 'not found' }, 404);
		}
	},
} satisfies ExportedHandler<Env>;
