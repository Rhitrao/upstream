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
import { SUNRISE_SECTORS, SUNRISE_SUBSECTOR_IDS } from './taxonomy';
import { TRACE_TYPES, TIERS, tierFor, type Tier } from './rank';

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

// --- GET /upstream/api/companies -------------------------------------------

/**
 * One row per company with its signals attached as JSON, tier first and newest first
 * inside a tier. The `?n IS NULL OR ...` filters let one statement serve every
 * combination of filters.
 */
const LIST_SQL = `
SELECT c.*,
  (SELECT json_group_array(json_object(
      'type', s.type, 'label', s.label, 'url', s.url, 'date', s.date))
   FROM signals s WHERE s.company_id = c.id) AS signals
FROM companies c
WHERE (?1 IS NULL OR c.sector_id = ?1)
  AND (?2 IS NULL OR c.subsector_id = ?2)
  AND (?3 IS NULL OR c.tier = ?3)
ORDER BY
  CASE c.tier WHEN 'A' THEN 0 WHEN 'B' THEN 1 ELSE 2 END,
  c.first_seen DESC
LIMIT ?4`;

async function listCompanies(url: URL, env: Env): Promise<Response> {
	const sector = url.searchParams.get('sector');
	const subsector = url.searchParams.get('subsector');
	const tierParam = url.searchParams.get('tier');
	const limitParam = url.searchParams.get('limit');

	let tier: string | null = null;
	if (tierParam !== null && tierParam !== '' && tierParam !== 'all') {
		tier = tierParam.toUpperCase();
		if (!TIERS.includes(tier as Tier)) {
			return json({ error: `tier must be one of ${TIERS.join(', ')}, or all` }, 400);
		}
	}

	let limit = DEFAULT_LIMIT;
	if (limitParam !== null && limitParam !== '') {
		const parsed = Number(limitParam);
		if (!Number.isInteger(parsed) || parsed < 1) {
			return json({ error: 'limit must be a positive integer' }, 400);
		}
		limit = Math.min(parsed, MAX_LIMIT);
	}

	const { results } = await env.DB.prepare(LIST_SQL)
		.bind(sector || null, subsector || null, tier, limit)
		.all<Record<string, unknown>>();

	const companies = results.map((row) => ({
		...row,
		signals: parseSignals(row.signals),
	}));

	return json({ count: companies.length, limit, companies }, 200, PUBLIC_CACHE);
}

function parseSignals(raw: unknown): unknown[] {
	if (typeof raw !== 'string') return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

// --- GET /upstream/api/coverage --------------------------------------------

/**
 * The counts come from the companies table, but the LIST of sub-sectors comes from the
 * taxonomy — all 44, including the empty ones. Grouping the table alone would make
 * empty sub-sectors vanish and the map would be a lie.
 */
async function coverage(env: Env): Promise<Response> {
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

	return json(
		{
			subsector_count: SUNRISE_SUBSECTOR_IDS.size,
			covered,
			total_companies: totalCompanies,
			off_map: offMap,
			unclassified,
			generated_at: new Date().toISOString(),
			sectors,
		},
		200,
		PUBLIC_CACHE,
	);
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

/** Placeholder. The real page — coverage map, filters, list — is Part 7. */
function page(): Response {
	const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upstream</title>
</head>
<body>
<h1>Upstream</h1>
<p>Early-stage Indian companies in the RDI scheme's sunrise sectors, found from public traces.</p>
<p>The page is Part 7. The API is live:
<a href="${BASE}/api/companies">/api/companies</a> ·
<a href="${BASE}/api/coverage">/api/coverage</a></p>
</body>
</html>`;
	return new Response(body, {
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
				return isRead ? page() : methodNotAllowed('GET, HEAD');

			case `${BASE}/api/companies`:
				return isRead ? listCompanies(url, env) : methodNotAllowed('GET, HEAD');

			case `${BASE}/api/coverage`:
				return isRead ? coverage(env) : methodNotAllowed('GET, HEAD');

			case `${BASE}/api/ingest`:
				return request.method === 'POST' ? ingest(request, env) : methodNotAllowed('POST');

			default:
				return json({ error: 'not found' }, 404);
		}
	},
} satisfies ExportedHandler<Env>;
