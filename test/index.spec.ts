import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { SIGNAL_TYPES, TRACE_TYPES } from '../src/rank';
import { NO_GAP_NAMED } from '../src/db';
import gapLabels from '../ingest/gap-labels.json';
import { SUBSECTORS } from '../src/taxonomy';
import { demoCompanies } from '../src/demo';

const KEY = 'test-ingest-key';
const ORIGIN = 'https://rohitrao.in';

const TODAY = new Date().toISOString().slice(0, 10);
const THIS_YEAR = new Date().getUTCFullYear();

async function clearDb() {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM signals'),
		env.DB.prepare('DELETE FROM companies'),
		env.DB.prepare('DELETE FROM runs'),
		env.DB.prepare('DELETE FROM gaps'),
		env.DB.prepare('DELETE FROM source_runs'),
	]);
}

function post(body: unknown, key: string | null = KEY) {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (key !== null) headers['X-Ingest-Key'] = key;
	return SELF.fetch(`${ORIGIN}/upstream/api/ingest`, {
		method: 'POST',
		headers,
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
}

beforeEach(clearDb);

describe('routing', () => {
	it('serves the page at /upstream and at /upstream/', async () => {
		for (const path of ['/upstream', '/upstream/']) {
			const res = await SELF.fetch(`${ORIGIN}${path}`);
			expect(res.status).toBe(200);
			expect(res.headers.get('content-type')).toContain('text/html');
		}
	});

	it('404s anything outside the four paths', async () => {
		const res = await SELF.fetch(`${ORIGIN}/upstream/api/nope`);
		expect(res.status).toBe(404);
	});

	it('405s a GET on ingest and a POST on coverage', async () => {
		expect((await SELF.fetch(`${ORIGIN}/upstream/api/ingest`)).status).toBe(405);
		const res = await SELF.fetch(`${ORIGIN}/upstream/api/coverage`, { method: 'POST' });
		expect(res.status).toBe(405);
	});
});

describe('GET /upstream/api/coverage', () => {
	it('returns all 44 sunrise sub-sectors with zero counts on an empty database', async () => {
		const res = await SELF.fetch(`${ORIGIN}/upstream/api/coverage`);
		expect(res.status).toBe(200);
		const body = await res.json<any>();

		const cells = body.sectors.flatMap((s: any) => s.subsectors);
		expect(body.sectors).toHaveLength(5);
		expect(cells).toHaveLength(44);
		expect(body.subsector_count).toBe(44);
		expect(body.covered).toBe(0);
		expect(body.total_companies).toBe(0);
		expect(cells.every((c: any) => c.n === 0)).toBe(true);
	});

	it('keeps empty sub-sectors in the map once one is filled', async () => {
		await post({
			source: 'test',
			companies: [{ id: 'verve', name: 'Verve', sector_id: '2', subsector_id: '2.5' }],
		});

		const body = await (await SELF.fetch(`${ORIGIN}/upstream/api/coverage`)).json<any>();
		const cells = body.sectors.flatMap((s: any) => s.subsectors);

		expect(cells).toHaveLength(44);
		expect(body.covered).toBe(1);
		expect(body.total_companies).toBe(1);
		expect(cells.find((c: any) => c.subsector_id === '2.5').n).toBe(1);
	});

	it('counts a sector-6 company as off_map rather than dropping it', async () => {
		await post({
			source: 'test',
			companies: [{ id: 'strategic', name: 'Strategic Co', sector_id: '6', subsector_id: '6.1' }],
		});

		const body = await (await SELF.fetch(`${ORIGIN}/upstream/api/coverage`)).json<any>();
		expect(body.sectors.flatMap((s: any) => s.subsectors)).toHaveLength(44);
		expect(body.covered).toBe(0);
		expect(body.total_companies).toBe(1);
		expect(body.off_map).toBe(1);
	});
});

describe('POST /upstream/api/ingest', () => {
	it('rejects a missing or wrong key with 401', async () => {
		expect((await post({ source: 'test', companies: [] }, null)).status).toBe(401);
		expect((await post({ source: 'test', companies: [] }, 'wrong')).status).toBe(401);
		expect((await post({ source: 'test', companies: [] }, `${KEY}x`)).status).toBe(401);
	});

	it('rejects a malformed body with 400', async () => {
		expect((await post('not json')).status).toBe(400);
		expect((await post({ companies: [] })).status).toBe(400);
		expect((await post({ source: 'test', companies: {} })).status).toBe(400);
		expect((await post({ source: 'test', companies: [{ name: 'No id' }] })).status).toBe(400);
	});

	it('inserts with the cohort date, then updates without touching either date', async () => {
		const first = await post({
			source: 'sine_iitb',
			companies: [
				{
					id: 'verve-aerospace',
					name: 'Verve Aerospace',
					description: 'Small reusable launch vehicles.',
					city: 'Bengaluru',
					sector_id: '2',
					subsector_id: '2.5',
					origin_year: 2022,
				},
			],
			signals: [{ company_id: 'verve-aerospace', type: 'incubator', label: 'SINE IIT-B cohort 2022' }],
		});
		expect(await first.json()).toMatchObject({
			inserted: 1,
			updated: 0,
			signals_added: 1,
			signals_skipped: 0,
			backfill: true,
		});

		const second = await post({
			source: 'sine_iitb',
			mode: 'live',
			companies: [
				// A thinner record, on a live run. Neither date may move.
				{ id: 'verve-aerospace', name: 'Verve Aerospace Private Limited', origin_year: 2024 },
			],
			signals: [
				// The same signal again — the UNIQUE constraint must swallow it.
				{ company_id: 'verve-aerospace', type: 'incubator', label: 'SINE IIT-B cohort 2022' },
			],
		});
		expect(await second.json()).toMatchObject({ inserted: 0, updated: 1, signals_added: 0, backfill: false });

		const row = await env.DB.prepare('SELECT * FROM companies WHERE id = ?').bind('verve-aerospace').first<any>();
		expect(row.first_seen).toBe('2022-01-01');
		expect(row.first_seen_basis).toBe('cohort');
		expect(row.discovered).toBe(TODAY);
		// The earliest claim wins, so a later cohort year cannot age a company forward.
		expect(row.origin_year).toBe(2022);
		expect(row.name).toBe('Verve Aerospace Private Limited');
		// COALESCE keeps what we already knew.
		expect(row.description).toBe('Small reusable launch vehicles.');
		expect(row.city).toBe('Bengaluru');
	});

	it('skips signals for companies it has never heard of', async () => {
		const res = await post({
			source: 'test',
			companies: [{ id: 'known', name: 'Known' }],
			signals: [
				{ company_id: 'known', type: 'website', label: 'known.in' },
				{ company_id: 'ghost', type: 'website', label: 'ghost.in' },
			],
		});
		expect(await res.json()).toMatchObject({ signals_added: 1, signals_skipped: 1 });
	});

	it('writes one runs row per call', async () => {
		await post({ source: 'sine_iitb', companies: [{ id: 'a', name: 'A' }] });
		const runs = await env.DB.prepare('SELECT * FROM runs').all<any>();
		expect(runs.results).toHaveLength(1);
		expect(runs.results[0]).toMatchObject({
			source: 'sine_iitb',
			status: 'ok',
			records_found: 1,
			error: null,
		});
	});

	it('recomputes trace_count and tier for touched companies', async () => {
		await post({
			source: 'test',
			mode: 'live',
			companies: [
				{ id: 'quiet', name: 'Quiet Co' },
				{ id: 'loud', name: 'Loud Co' },
			],
			signals: [
				// incorporation is not a trace: it is how we found them.
				{ company_id: 'quiet', type: 'incorporation', label: 'incorporated 2026-03' },
				{ company_id: 'loud', type: 'website', label: 'loud.in' },
				{ company_id: 'loud', type: 'press', label: 'Mint piece' },
				{ company_id: 'loud', type: 'grant', label: 'BIRAC grant' },
				{ company_id: 'loud', type: 'incubator', label: 'Accelerator badge' },
			],
		});
		await post({ source: 'archive', companies: [{ id: 'old', name: 'Old Co', origin_year: 2020 }] });

		const rows = await env.DB.prepare('SELECT id, trace_count, tier FROM companies ORDER BY id').all<any>();
		expect(rows.results).toEqual([
			{ id: 'loud', trace_count: 4, tier: 'B' },
			{ id: 'old', trace_count: 0, tier: 'C' },
			{ id: 'quiet', trace_count: 0, tier: 'A' },
		]);
	});

	it('re-ranks an A or B row that no source sends any more', async () => {
		// Ranked before the register-label rule, then out of the register's window: no
		// upload names it again, and its stored tier must not outlive the rule.
		await post({ source: 'dpiit-startup-india', mode: 'live', companies: [{ id: 'stale', name: 'Stale Co', sector_id: '3', subsector_id: '3.2' }] });
		await env.DB.prepare("UPDATE companies SET classify_basis = 'register-label', tier = 'A' WHERE id = 'stale'").run();

		await post({ source: 'sine-iitb', companies: [{ id: 'other', name: 'Other Co' }] });

		const row = await env.DB.prepare('SELECT tier FROM companies WHERE id = ?').bind('stale').first<any>();
		expect(row).toEqual({ tier: 'C' });
	});

	it('folds a company listed twice into one row, keeping the earlier date and the note', async () => {
		await post({ source: 'grants-csv', mode: 'backfill', companies: [{ id: 'cancrie', name: 'Cancrie Private Limited', origin_year: 2023 }] });
		await post({
			source: 'venture-center',
			mode: 'backfill',
			companies: [{ id: 'cancrie-inc', name: 'Cancrie Inc.', origin_year: 2021 }],
			signals: [{ company_id: 'cancrie-inc', type: 'incubator', label: 'Venture Center portfolio' }],
		});
		await env.DB.prepare("INSERT INTO notes (company_id, body, author, created_at, updated_at) VALUES ('cancrie-inc', 'call them', 'me', 'x', 'x')").run();

		// The next run sends Venture Center's copy under the surviving id, and says so.
		const res = await post({
			source: 'venture-center',
			companies: [{ id: 'cancrie', name: 'Cancrie Inc.' }],
			signals: [{ company_id: 'cancrie', type: 'incubator', label: 'Venture Center portfolio' }],
			merged: [
				{ from: 'cancrie-inc', into: 'cancrie' },
				{ from: 'orphan', into: 'never-arrived' },
			],
		});
		expect((await res.json<any>()).merged).toBe(1);

		const rows = await env.DB.prepare('SELECT id, first_seen, trace_count FROM companies ORDER BY id').all<any>();
		expect(rows.results).toEqual([{ id: 'cancrie', first_seen: '2021-01-01', trace_count: 1 }]);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM signals WHERE company_id = 'cancrie-inc'").first<any>()).toEqual({ n: 0 });
		expect(await env.DB.prepare('SELECT company_id FROM notes').first<any>()).toEqual({ company_id: 'cancrie' });

		expect((await post({ source: 'x', merged: [{ from: 'a', into: 'a' }] })).status).toBe(400);
	});

	it('treats a whole first day as a backfill, however many requests it takes', async () => {
		// One sweep, three chunks, because 500 companies do not fit in one payload.
		for (const chunk of [
			[{ id: 'one', name: 'One', origin_year: THIS_YEAR }],
			[{ id: 'two', name: 'Two', origin_year: THIS_YEAR }],
			[{ id: 'three', name: 'Three' }],
		]) {
			expect(await (await post({ source: 'sine', companies: chunk })).json()).toMatchObject({ backfill: true });
		}

		const rows = await env.DB.prepare('SELECT first_seen_basis, COUNT(*) AS n FROM companies GROUP BY 1 ORDER BY 1').all<any>();
		expect(rows.results).toEqual([
			{ first_seen_basis: null, n: 1 },
			{ first_seen_basis: 'cohort', n: 2 },
		]);
	});

	it('treats a run on a later day as live, per source', async () => {
		await post({ source: 'sine', companies: [{ id: 'backfilled', name: 'Backfilled', origin_year: THIS_YEAR }] });
		// Yesterday's sweep, so today's run is this source's second day.
		await env.DB.prepare("UPDATE runs SET started_at = '2020-01-01T00:00:00.000Z' WHERE source = 'sine'").run();

		const second = await post({
			source: 'sine',
			companies: [
				{ id: 'backfilled', name: 'Backfilled' },
				{ id: 'found', name: 'Found Today' },
			],
		});
		expect(await second.json()).toMatchObject({ backfill: false, inserted: 1, updated: 1 });

		// A different source starts its own history, however long we have been running.
		const other = await post({ source: 'rtbi', companies: [{ id: 'other', name: 'Other' }] });
		expect(await other.json()).toMatchObject({ backfill: true });

		const rows = await env.DB.prepare('SELECT id, first_seen, first_seen_basis, tier FROM companies ORDER BY id').all<any>();
		expect(rows.results).toEqual([
			{ id: 'backfilled', first_seen: `${THIS_YEAR}-01-01`, first_seen_basis: 'cohort', tier: expect.stringMatching(/B|C/) },
			{ id: 'found', first_seen: TODAY, first_seen_basis: 'discovered', tier: 'A' },
			{ id: 'other', first_seen: null, first_seen_basis: null, tier: 'C' },
		]);
	});

	it('never stamps a live run onto a company it already had', async () => {
		await post({ source: 'rtbi', companies: [{ id: 'undated', name: 'Undated Co' }] });
		await post({ source: 'rtbi', mode: 'live', companies: [{ id: 'undated', name: 'Undated Co' }] });

		const row = await env.DB.prepare('SELECT * FROM companies WHERE id = ?').bind('undated').first<any>();
		// Seeing it again is not finding it. It stays undated, and it stays out of A.
		expect(row.first_seen).toBe(null);
		expect(row.first_seen_basis).toBe(null);
		expect(row.tier).toBe('C');
		expect(row.discovered).toBe(TODAY);
	});

	it('lets a later source date an undated company, but never redate a dated one', async () => {
		await post({ source: 'rtbi', companies: [{ id: 'shared', name: 'Shared Co' }] });
		await post({ source: 'sine', companies: [{ id: 'shared', name: 'Shared Co', origin_year: 2023 }] });

		let row = await env.DB.prepare('SELECT * FROM companies WHERE id = ?').bind('shared').first<any>();
		expect(row.first_seen).toBe('2023-01-01');
		expect(row.first_seen_basis).toBe('cohort');

		await post({ source: 'grants', companies: [{ id: 'shared', name: 'Shared Co', origin_year: 2025 }] });
		row = await env.DB.prepare('SELECT * FROM companies WHERE id = ?').bind('shared').first<any>();
		expect(row.first_seen).toBe('2023-01-01');
	});

	it('keeps a cohort date out of Tier A however recent it is', async () => {
		await post({ source: 'test', mode: 'live', companies: [{ id: 'found', name: 'Found' }] });
		expect((await env.DB.prepare('SELECT tier FROM companies WHERE id = ?').bind('found').first<any>()).tier).toBe('A');

		// Same date, different provenance: only the provenance changes.
		await env.DB.prepare("UPDATE companies SET first_seen_basis = 'cohort' WHERE id = ?").bind('found').run();
		await post({ source: 'test', mode: 'live', companies: [{ id: 'found', name: 'Found' }] });

		expect((await env.DB.prepare('SELECT tier FROM companies WHERE id = ?').bind('found').first<any>()).tier).toBe('B');
	});

	it('refuses a signal type nobody knows about', async () => {
		const res = await post({
			source: 'test',
			companies: [{ id: 'a', name: 'A' }],
			// One letter wrong, and without this it would store, display, and count
			// as zero traces.
			signals: [{ company_id: 'a', type: 'incubater', label: 'SINE' }],
		});
		expect(res.status).toBe(400);
		expect((await res.json<any>()).error).toContain('must be one of');
	});

	it('counts a DPIIT listing as a trace', async () => {
		await post({
			source: 'dpiit',
			mode: 'live',
			companies: [{ id: 'quiet', name: 'Quiet Co' }],
			signals: [{ company_id: 'quiet', type: 'dpiit', label: 'DPIIT recognised 2026 (DIPP280898)' }],
		});

		// A register entry is somebody having noticed — BUILD Part 9 lists it.
		const row = await env.DB.prepare('SELECT trace_count, tier FROM companies WHERE id = ?').bind('quiet').first<any>();
		expect(row).toMatchObject({ trace_count: 1, tier: 'A' });
	});

	it('withdraws a website trace once the homepage stops answering', async () => {
		const company = { id: 'lapsed', name: 'Lapsed Co', website: 'https://lapsed.example' };
		await post({
			source: 'sine-iitb',
			mode: 'live',
			companies: [{ ...company, product_status: 'thin' }],
			signals: [
				{ company_id: 'lapsed', type: 'incubator', label: 'SINE IIT Bombay' },
				{ company_id: 'lapsed', type: 'website', label: 'website live', url: company.website },
			],
		});
		const trace = 'SELECT trace_count FROM companies WHERE id = ?';
		expect(await env.DB.prepare(trace).bind('lapsed').first<any>()).toMatchObject({ trace_count: 2 });

		// The next night the domain is dead. The pipeline sends no website trace, and
		// INSERT OR IGNORE alone would leave last night's counting as live.
		await post({
			source: 'sine-iitb',
			companies: [{ ...company, product_status: 'unreachable' }],
			signals: [{ company_id: 'lapsed', type: 'incubator', label: 'SINE IIT Bombay' }],
		});
		expect(await env.DB.prepare(trace).bind('lapsed').first<any>()).toMatchObject({ trace_count: 1 });
		const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM signals WHERE company_id = ? AND type = 'website'").bind('lapsed').first<any>();
		expect(left.n).toBe(0);
	});

	it('rejects a nonsense mode or year', async () => {
		expect((await post({ source: 'test', mode: 'sideways', companies: [] })).status).toBe(400);
		expect((await post({ source: 'test', companies: [{ id: 'a', name: 'A', origin_year: 12 }] })).status).toBe(400);
		expect((await post({ source: 'test', companies: [{ id: 'a', name: 'A', record_year: 12 }] })).status).toBe(400);
		expect((await post({ source: 'test', companies: [{ id: 'a', name: 'A', origin_year: THIS_YEAR + 5 }] })).status).toBe(400);
		expect((await post({ source: 'test', companies: [{ id: 'a', name: 'A', origin_year: 'soon' }] })).status).toBe(400);
	});
});

describe('GET /upstream/api/companies', () => {
	// Three companies, one of each date state the page has to tell apart: found by us,
	// backfilled from a cohort year old enough to hold back, and never dated at all.
	beforeEach(async () => {
		await post({
			source: 'archive',
			companies: [
				{ id: 'c-old', name: 'C Old', sector_id: '1', subsector_id: '1.1', origin_year: 2019 },
				{ id: 'b-undated', name: 'B Undated', sector_id: '3', subsector_id: '3.3' },
			],
		});
		await post({
			source: 'live-source',
			mode: 'live',
			companies: [{ id: 'a-new', name: 'A New', sector_id: '2', subsector_id: '2.5', origin_year: THIS_YEAR }],
		});
	});

	it('returns the ranked list by default: dated, and recent enough', async () => {
		const body = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies`)).json<any>();
		expect(body.count).toBe(1);
		expect(body.companies.map((c: any) => c.id)).toEqual(['a-new']);
		expect(body.companies[0].signals).toEqual([]);
		expect(body.companies[0].first_seen_basis).toBe('discovered');
	});

	it('lifts the age gate for age=all and lists the undated separately', async () => {
		const all = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?age=all&tier=all`)).json<any>();
		expect(all.companies.map((c: any) => c.id)).toEqual(['a-new', 'c-old']);

		const undated = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?undated=1`)).json<any>();
		expect(undated.companies.map((c: any) => c.id)).toEqual(['b-undated']);
		expect(undated.companies[0].first_seen).toBe(null);
	});

	it('filters by sector, subsector and tier', async () => {
		const one = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?sector=1&age=all&tier=all`)).json<any>();
		expect(one.companies.map((c: any) => c.id)).toEqual(['c-old']);

		const two = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?subsector=2.5`)).json<any>();
		expect(two.companies.map((c: any) => c.id)).toEqual(['a-new']);

		const three = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?tier=a`)).json<any>();
		expect(three.companies.map((c: any) => c.id)).toEqual(['a-new']);
	});

	it('honours limit and rejects nonsense', async () => {
		const limited = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?age=all&tier=all&limit=1`)).json<any>();
		expect(limited.count).toBe(1);

		expect((await SELF.fetch(`${ORIGIN}/upstream/api/companies?limit=0`)).status).toBe(400);
		expect((await SELF.fetch(`${ORIGIN}/upstream/api/companies?tier=Z`)).status).toBe(400);
	});

	it('counts every company in the coverage map, gated or undated', async () => {
		const body = await (await SELF.fetch(`${ORIGIN}/upstream/api/coverage`)).json<any>();
		expect(body.total_companies).toBe(3);
		expect(body.covered).toBe(3);
	});
});

describe('gaps — companies the taxonomy has no cell for', () => {
	const gap = (id: string, missing: string) => ({
		company_id: id,
		name: `${id} Ltd`,
		missing,
		note: `Nothing under the chosen sector covers ${id}.`,
		sector_id: '5',
	});

	it('records them, groups them commonest first, and keeps a few names', async () => {
		const res = await post({
			source: 'test',
			gaps: [gap('botsrule', 'water infrastructure'), gap('ajivam', 'water infrastructure'), gap('bhugol', 'geospatial services')],
		});
		expect(await res.json()).toMatchObject({ gaps_recorded: 3 });

		const body = await (await SELF.fetch(`${ORIGIN}/upstream/api/gaps`)).json<any>();
		expect(body.total).toBe(3);
		expect(body.groups.map((g: any) => [g.missing, g.n])).toEqual([
			['water infrastructure', 2],
			['geospatial services', 1],
		]);
		expect(body.groups[0].examples).toHaveLength(2);
	});

	it('stops being a gap the moment the company arrives as a real row', async () => {
		await post({ source: 'test', gaps: [gap('botsrule', 'water infrastructure')] });
		expect((await (await SELF.fetch(`${ORIGIN}/upstream/api/gaps`)).json<any>()).total).toBe(1);

		// A taxonomy that gets fixed must not leave its old holes on the page.
		await post({ source: 'test', companies: [{ id: 'botsrule', name: 'Botsrule Ltd', sector_id: '5', subsector_id: '5.1' }] });
		expect((await (await SELF.fetch(`${ORIGIN}/upstream/api/gaps`)).json<any>()).total).toBe(0);
	});

	it('stops being a row the moment the company arrives as a hole', async () => {
		// The other half of the invariant, and the half that was missing: a company
		// placed on Monday and found unplaceable on Tuesday kept its Monday row,
		// counted in the headline total and sitting in a coverage cell, while also
		// being listed as a hole. Three companies were in both tables in production.
		await post({ source: 'test', companies: [{ id: 'botsrule', name: 'Botsrule Ltd', sector_id: '5', subsector_id: '5.1' }] });
		expect((await (await SELF.fetch(`${ORIGIN}/upstream/api/coverage`)).json<any>()).total_companies).toBe(1);

		await post({ source: 'test', gaps: [gap('botsrule', 'water infrastructure')] });

		const coverage = await (await SELF.fetch(`${ORIGIN}/upstream/api/coverage`)).json<any>();
		expect(coverage.total_companies).toBe(0);
		expect((await (await SELF.fetch(`${ORIGIN}/upstream/api/gaps`)).json<any>()).total).toBe(1);
	});

	it('never leaves a company in both tables, whichever order the two arrive in', async () => {
		const row = { id: 'botsrule', name: 'Botsrule Ltd', sector_id: '5', subsector_id: '5.1' };
		const hole = gap('botsrule', 'water infrastructure');

		// Placed then gapped, gapped then placed, and both in one payload. Every
		// sequence has to end with the company in exactly one table.
		const sequences: { label: string; payloads: any[] }[] = [
			{ label: 'placed then gapped', payloads: [{ companies: [row] }, { gaps: [hole] }] },
			{ label: 'gapped then placed', payloads: [{ gaps: [hole] }, { companies: [row] }] },
			{ label: 'both at once', payloads: [{ companies: [row], gaps: [hole] }] },
			{ label: 'gapped twice', payloads: [{ gaps: [hole] }, { gaps: [hole] }] },
		];

		for (const { label, payloads } of sequences) {
			await clearDb();
			for (const payload of payloads) await post({ source: 'test', ...payload });

			const placed = (await (await SELF.fetch(`${ORIGIN}/upstream/api/coverage`)).json<any>()).total_companies;
			const holes = (await (await SELF.fetch(`${ORIGIN}/upstream/api/gaps`)).json<any>()).total;
			expect({ label, in_both: placed === 1 && holes === 1 }).toEqual({ label, in_both: false });
			expect({ label, total: placed + holes }).toEqual({ label, total: 1 });
		}
	});

	it('refuses a gap with no reason attached', async () => {
		const bad = { company_id: 'x', name: 'X Ltd', missing: 'water infrastructure' };
		expect((await post({ source: 'test', gaps: [bad] })).status).toBe(400);
		expect((await post({ source: 'test', gaps: [{ ...bad, note: 'because' }, { name: 'no id' }] })).status).toBe(400);
		expect((await post({ source: 'test', gaps: 'not an array' })).status).toBe(400);
	});

	it('keeps them out of the companies table and the coverage map', async () => {
		await post({ source: 'test', gaps: [gap('botsrule', 'water infrastructure')] });

		const coverage = await (await SELF.fetch(`${ORIGIN}/upstream/api/coverage`)).json<any>();
		expect(coverage.total_companies).toBe(0);
		const list = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?age=all&tier=all`)).json<any>();
		expect(list.count).toBe(0);
	});
});

describe('what a company builds', () => {
	it('refuses a product_status it has no sentence for', async () => {
		const res = await post({ source: 'test', companies: [{ id: 'verve', name: 'Verve', product_status: 'probably-fine' }] });
		expect(res.status).toBe(400);
		expect((await res.json<any>()).error).toMatch(/product_status must be one of/);
	});

	it('refuses a description with no outcome behind it', async () => {
		// A sentence with no provenance is the one thing this column must not store:
		// it would read exactly like a read homepage and be nothing of the kind.
		const res = await post({
			source: 'test',
			companies: [{ id: 'verve', name: 'Verve', product: 'Builds drones', product_status: 'unclear' }],
		});
		expect(res.status).toBe(400);
		expect((await res.json<any>()).error).toMatch(/product needs product_status 'described'/);
	});

	it('refuses a sentence read from a homepage nobody confirmed is theirs', async () => {
		for (const website_identity of [undefined, 'discovered', 'associated']) {
			const res = await post({
				source: 'enrich',
				companies: [{ id: 'verve', name: 'Verve', product: 'Builds drones', product_status: 'described', website_identity }],
			});
			expect(res.status).toBe(400);
			expect((await res.json<any>()).error).toMatch(/product needs website_identity 'verified'/);
		}
		expect((await post({ source: 'enrich', companies: [{ id: 'verve', name: 'Verve', website_identity: 'probably' }] })).status).toBe(400);
	});

	it("takes a stranger's address off a company, with its sentence and its trace", async () => {
		// The state Grinntech was in: HyperVerge's address, HyperVerge's product, and
		// — once website traces were collected — HyperVerge's homepage counted as theirs.
		const grinntech = { id: 'grinntech', name: 'Grinntech Motors & Services Private Limited', sector_id: '1', subsector_id: '1.4', origin_year: THIS_YEAR };
		await post({
			source: 'rtbi-iitm',
			mode: 'live',
			companies: [
				{ ...grinntech, website: 'http://hyperverge.co/', product: 'Identity verification and KYC software.', product_status: 'described', website_identity: 'verified' },
			],
			signals: [
				{ company_id: 'grinntech', type: 'incubator', label: 'IITM RTBI portfolio' },
				{ company_id: 'grinntech', type: 'website', label: 'website live', url: 'http://hyperverge.co/' },
			],
		});

		// The corrected run: the parser gives the card's own link, and the check does not
		// verify it. Nothing sends a null product; the check alone has to clear it.
		await post({
			source: 'rtbi-iitm',
			companies: [
				{
					...grinntech,
					website: 'http://grinntech.com/',
					product_status: 'unverified',
					website_identity: 'associated',
					website_identity_note: 'given in the company\'s own source record, but the homepage does not name the company',
				},
			],
		});
		const row = await env.DB.prepare('SELECT website, product, product_status, website_identity FROM companies WHERE id = ?').bind('grinntech').first<any>();
		expect(row).toEqual({ website: 'http://grinntech.com/', product: null, product_status: 'unverified', website_identity: 'associated' });

		// And an address nothing ties to them loses the trace it earned while it was
		// wrongly theirs.
		await post({
			source: 'rtbi-iitm',
			companies: [{ ...grinntech, website: 'http://hyperverge.co/', product_status: 'unverified', website_identity: 'discovered', website_identity_note: 'the same address is given for another company, so it cannot identify this one' }],
		});
		const traces = await env.DB.prepare("SELECT COUNT(*) AS n FROM signals WHERE company_id = ? AND type = 'website'").bind('grinntech').first<any>();
		expect(traces.n).toBe(0);
		expect(await env.DB.prepare('SELECT trace_count FROM companies WHERE id = ?').bind('grinntech').first<any>()).toEqual({ trace_count: 1 });

		const html = await (await SELF.fetch(`${ORIGIN}/upstream?age=all&tier=all`)).text();
		const start = html.indexOf('id="c-grinntech"');
		const listRow = html.slice(start, html.indexOf('</li>', start));
		expect(listRow).not.toContain('hyperverge');
		expect(listRow).not.toContain('>website<');
		expect(listRow).not.toContain('Identity verification');

		const detail = await (await SELF.fetch(`${ORIGIN}/upstream/c/grinntech`)).text();
		expect(detail).toContain('is not treated as');
		// Named once, in the sentence explaining why it is not theirs, and never as a link
		// in the header where it would read as their site.
		expect(detail.match(/href="http:\/\/hyperverge\.co\/"/g)).toHaveLength(1); // only in that sentence
		// The unknowns and the brief name it too, and only to say it is not theirs.
		expect(detail).toContain('Its website</strong> &mdash; hyperverge.co was given for it, and is not treated as theirs');
		expect(detail).toContain('http://hyperverge.co/ was given for it and is NOT treated as theirs');
		expect(detail).not.toContain('class="fact-site" href="http://hyperverge.co/"');
		expect(detail).toContain('the same address is given for another company');
		expect(detail).not.toContain('Identity verification');
	});

	it('marks an address their record gives but their homepage does not name', async () => {
		await post({
			source: 'sine-iitb',
			mode: 'live',
			companies: [
				{ id: 'edsix', name: 'Edsix Brain Lab', website: 'http://skillangels.com/', sector_id: '5', subsector_id: '5.1', origin_year: THIS_YEAR, product_status: 'unverified', website_identity: 'associated', website_identity_note: 'given in the company\'s own source record, but the homepage does not name the company' },
			],
		});
		const html = await (await SELF.fetch(`${ORIGIN}/upstream?age=all&tier=all`)).text();
		const start = html.indexOf('id="c-edsix"');
		const row = html.slice(start, html.indexOf('</li>', start));
		expect(row).toContain('href="http://skillangels.com/"');
		expect(row).toContain('not confirmed as theirs');
	});

	it('puts the sentence on the row, attributed, and never as our own claim', async () => {
		await post({
			source: 'test',
			companies: [
				{
					id: 'kadamb',
					name: 'Kadamb Biolabs',
					description: 'Diagnostics company.',
					website: 'https://example.invalid/kadamb',
					sector_id: '4',
					subsector_id: '4.2',
					product: 'Benchtop assay kits for district hospitals.',
					product_status: 'described',
					website_identity: 'verified',
				},
			],
		});

		const html = await (await SELF.fetch(`${ORIGIN}/upstream?age=all&tier=all`)).text();
		expect(html).toContain('Benchtop assay kits for district hospitals.');
		// The attribution travels with it. Without this the row is asserting a fact
		// about a company that we read off that company's own marketing page.
		expect(html).toMatch(/Benchtop assay kits for district hospitals\.\s*<span class="says">in their own words<\/span>/);
		// One line per row: the homepage sentence wins it, and the source's description
		// still stands on the company's own page.
		expect(html).not.toContain('Diagnostics company.');
		expect(await (await SELF.fetch(`${ORIGIN}/upstream/c/kadamb`)).text()).toContain('Diagnostics company.');
	});

	it('drops a register label once the homepage has said it better', async () => {
		await post({
			source: 'dpiit-startup-india',
			companies: [
				{
					id: 'relsym',
					name: 'Relsym',
					description: 'DPIIT-recognised startup. Industry: Nanotechnology. Stage: Prototype.',
					website: 'https://example.invalid/relsym',
					sector_id: '2',
					subsector_id: '2.2',
					classify_basis: 'register-label',
					product: 'Software that models CMOS reliability for chip design teams.',
					product_status: 'described',
					website_identity: 'verified',
				},
			],
		});

		const html = await (await SELF.fetch(`${ORIGIN}/upstream?age=all&tier=all`)).text();
		expect(html).toContain('Software that models CMOS reliability for chip design teams.');
		// The dropdown line is gone. It was never a description of the company — it
		// was an industry the founder picked from a list — and printing it under a
		// sentence about what they actually make costs the row its clarity.
		expect(html).not.toContain('Industry: Nanotechnology');
	});

	it('does not let a scraper that knows nothing about websites erase what reading one cost', async () => {
		await post({
			source: 'enrich',
			companies: [
				{
					id: 'kadamb',
					name: 'Kadamb',
					sector_id: '4',
					subsector_id: '4.2',
					origin_year: THIS_YEAR,
					product: 'Assay kits.',
					product_status: 'described',
					website_identity: 'verified',
				},
			],
		});
		// The nightly scrapers post every company again with no product fields at all.
		await post({
			source: 'sine-iitb',
			companies: [{ id: 'kadamb', name: 'Kadamb', sector_id: '4', subsector_id: '4.2', origin_year: THIS_YEAR }],
		});

		const list = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?age=all&tier=all`)).json<any>();
		expect(list.companies[0].product).toBe('Assay kits.');
		expect(list.companies[0].product_status).toBe('described');
	});

	it('counts every way reading a website failed, and names each one', async () => {
		await post({
			source: 'test',
			companies: [
				{
					id: 'a',
					name: 'A',
					website: 'https://a.invalid',
					sector_id: '5',
					subsector_id: '5.1',
					product: 'Makes A.',
					product_status: 'described',
					website_identity: 'verified',
				},
				{ id: 'b', name: 'B', website: 'https://b.invalid', sector_id: '5', subsector_id: '5.1', product_status: 'unreachable' },
				{ id: 'c', name: 'C', website: 'https://c.invalid', sector_id: '5', subsector_id: '5.1', product_status: 'refused' },
				{ id: 'd', name: 'D', website: 'https://d.invalid', sector_id: '5', subsector_id: '5.1', product_status: 'thin' },
				{ id: 'e', name: 'E', website: 'https://e.invalid', sector_id: '5', subsector_id: '5.1', product_status: 'unclear' },
				// Looked for, and there is none. On this list that is a point in their favour.
				{ id: 'f', name: 'F', sector_id: '5', subsector_id: '5.1' },
			],
		});

		const html = await (await SELF.fetch(`${ORIGIN}/upstream?age=all&tier=all`)).text();
		expect(html).toMatch(/Of the 6 companies here, 5 publish a website/);
		expect(html).toMatch(/<strong>1<\/strong> of them say plainly enough what they build/);
		expect(html).toMatch(/<strong>1<\/strong> publish an address that no longer answers/);
		expect(html).toMatch(/<strong>1<\/strong> refused an automated reader/);
		expect(html).toMatch(/<strong>1<\/strong> served a page with no readable text/);
		expect(html).toMatch(/<strong>1<\/strong> never said what they make/);
		expect(html).toMatch(/<strong>1<\/strong> have no website at all/);
	});
});

describe('GET /upstream (the page)', () => {
	async function page(qs = '') {
		const res = await SELF.fetch(`${ORIGIN}/upstream${qs}`);
		expect(res.status).toBe(200);
		return res.text();
	}

	async function detail(id: string) {
		const res = await SELF.fetch(`${ORIGIN}/upstream/c/${id}`);
		expect(res.status).toBe(200);
		return res.text();
	}

	it('renders 44 coverage cells, all empty, on an empty database', async () => {
		const html = await page();
		// Nothing has arrived in a backfill either, so the page says nothing about one.
		expect(html).not.toContain('arrived in a backfill');
		const cells = html.match(/class="cell [^"]*"/g) ?? [];
		expect(cells).toHaveLength(44);
		expect(cells.every((c) => c.includes('empty'))).toBe(true);
		// The stat counts the empty squares, not the covered ones: an RDI priority with
		// nothing in it is the finding, and on an empty database all 44 are that.
		expect(html).toContain('Sub-sectors still empty');
		expect(html).toContain('>44<span class="of">/44</span>');
	});

	it('fills a cell once a company lands in it, and keeps the other 43', async () => {
		await post({
			source: 'test',
			companies: [{ id: 'verve', name: 'Verve', sector_id: '2', subsector_id: '2.5' }],
		});
		const html = await page();
		const map = html.slice(html.indexOf('id="coverage"'), html.indexOf('</section>', html.indexOf('id="coverage"')));
		const cells = map.match(/class="cell [^"]*"/g) ?? [];
		expect(cells).toHaveLength(44);
		expect(cells.filter((c) => c.includes('filled'))).toHaveLength(1);
	});

	it('shows the sample companies behind a banner for ?demo=1 only', async () => {
		const plain = await page();
		expect(plain).not.toContain('Sample data');
		expect(plain).toContain('Nothing matches yet');

		const demo = await page('?demo=1');
		expect(demo).toContain('Sample data');
		// Five ranked and one undated; the seventh is held back by the age gate.
		expect(demo.match(/<li class="company [^"]*" id="c-[^"]+"/g)).toHaveLength(6);
		expect(demo).toContain('Verve Aerospace Private Limited');
		expect(demo).toContain('Pravaha Filtration Private Limited');
		expect(demo).not.toContain('Saral Hydro Systems Private Limited');
		expect(demo).toContain('held back');
		// The two-word lesson in how the ranking works, still carrying the page's one
		// yellow — it moved from a pill to the fact itself and kept its meaning.
		expect(demo).toContain('<span class="fact-none">no website</span>');
		// The sub-sector is a filter link on the row now, not a sentence.
		expect(demo).toMatch(/<a class="rdi" href="\?subsector=2\.5">2\.5 Space Technologies<\/a>/);
	});

	it('puts undated companies in their own section, out of the ranking', async () => {
		await post({ source: 'rtbi', companies: [{ id: 'undated', name: 'Undated Co' }] });
		await post({ source: 'live-source', mode: 'live', companies: [{ id: 'found', name: 'Found Co' }] });

		const html = await page();
		expect(html).toContain('id="undated"');
		expect(html).toContain('place in time yet');
		expect(html).toContain('Undated Co');

		// The ranked list is above it and holds only the company we actually found.
		const ranked = html.slice(html.indexOf('id="list"'), html.indexOf('id="undated"'));
		expect(ranked).toContain('Found Co');
		expect(ranked).not.toContain('Undated Co');
	});

	it('marks a sub-sector that came from a register label, and only that one', async () => {
		await post({
			source: 'test',
			mode: 'live',
			companies: [
				{ id: 'from-label', name: 'Label Co', sector_id: '2', subsector_id: '2.7', classify_basis: 'register-label' },
				{ id: 'from-desc', name: 'Description Co', sector_id: '2', subsector_id: '2.7' },
			],
		});

		// The marker left the row when the row was cut to four facts, and it went
		// somewhere with room to say it properly: each company's own page, in the
		// classifier's words. What must not happen is it quietly disappearing.
		const label = await detail('from-label');
		const desc = await detail('from-desc');
		expect(label).toContain("register's industry label");
		expect(label).toContain('supports this sub-sector and nothing narrower');
		expect(desc).toContain('Placed from the description above.');

		// Beside the placement on the row too, not only a click away.
		const list = await page('?tier=all&age=all');
		const rowOf = (id: string) => list.slice(list.indexOf(`id="c-${id}"`), list.indexOf('</li>', list.indexOf(`id="c-${id}"`)));
		expect(rowOf('from-label')).toContain('register label only');
		// A description-based placement is the unmarked case; only the weak one is flagged.
		expect(rowOf('from-desc')).not.toContain('register label only');

		// And the finding is written up, not just marked.
		expect(await page('?tier=all')).toContain('Two official classifications that do not meet');
	});

	it('lets a register label place a company in a sub-sector and no further', async () => {
		// Probird: "Industry: Robotics. Stage: Validation." was given the project type
		// "Modular robotic platforms". Nothing published about it says that.
		const refused = await post({
			source: 'dpiit-startup-india',
			companies: [{ id: 'probird', name: 'Probird', sector_id: '2', subsector_id: '2.3', project_type: 'Modular robotic platforms', classify_basis: 'register-label' }],
		});
		expect(refused.status).toBe(400);
		expect((await refused.json<any>()).error).toMatch(/project_type needs a description/);

		// A row that got one before the rule existed loses it on the next run that
		// sends it, however that run is worded.
		await post({ source: 'grants-csv', companies: [{ id: 'probird', name: 'Probird', sector_id: '2', subsector_id: '2.3', project_type: 'Modular robotic platforms' }] });
		await post({ source: 'dpiit-startup-india', companies: [{ id: 'probird', name: 'Probird', sector_id: '2', subsector_id: '2.3', classify_basis: 'register-label' }] });
		const row = await env.DB.prepare('SELECT subsector_id, project_type FROM companies WHERE id = ?').bind('probird').first<any>();
		expect(row).toEqual({ subsector_id: '2.3', project_type: null });
		expect(await detail('probird')).toContain('Project type: unknown');
	});

	it('never prints a register label as what a company builds, whatever its basis says', async () => {
		// RELSYM: owned by a SINE listing with no sentence, so classified as 'description',
		// with the register's label as the only text stored.
		const label = 'DPIIT-recognised startup. Industry: Nanotechnology. Stage: Prototype.';
		await post({ source: 'sine-iitb', companies: [{ id: 'relsym', name: 'Relsym', sector_id: '2', subsector_id: '2.2', description: label }] });

		const list = await page('?tier=all&age=all&dates=both');
		const row = list.slice(list.indexOf('id="c-relsym"'), list.indexOf('</li>', list.indexOf('id="c-relsym"')));
		expect(row).toContain('No description published');
		expect(row).not.toContain('Industry: Nanotechnology');
		expect(await detail('relsym')).toContain('not a description');
	});

	it('refuses a classify_basis nobody defined', async () => {
		const res = await post({ source: 'test', companies: [{ id: 'a', name: 'A', classify_basis: 'vibes' }] });
		expect(res.status).toBe(400);
	});

	it('anchors every row by slug so one can be linked to', async () => {
		await post({ source: 'test', mode: 'live', companies: [{ id: 'hexcarb-advanced-materials', name: 'Hexcarb' }] });
		expect(await page('?tier=all')).toMatch(/<li class="company [^"]*" id="c-hexcarb-advanced-materials"/);
	});

	it('only says "no website" where a source actually looked', async () => {
		await post({
			source: 'test',
			mode: 'live',
			companies: [
				{ id: 'looked', name: 'Looked At Co' },
				{ id: 'register', name: 'Register Only Co', website_checked: false },
			],
		});

		const html = await page('?tier=all');
		// Sliced to the row, not to the end of the document: the methodology below
		// counts these companies in a sentence containing the same words, and a looser
		// slice would pass or fail for reasons that have nothing to do with the row.
		const row = (id: string) => {
			const start = html.indexOf(`id="c-${id}"`);
			return html.slice(start, html.indexOf('</li>', start));
		};
		expect(row('looked')).toContain('<span class="fact-none">no website</span>');
		// A register with no website field has said nothing about whether one exists,
		// and the row must not turn that silence into a claim.
		expect(row('register')).not.toContain('no website');
	});

	it('lets one source that looked settle it for the others', async () => {
		await post({ source: 'dpiit', companies: [{ id: 'shared', name: 'Shared Co', website_checked: false }] });
		await post({ source: 'sine', companies: [{ id: 'shared', name: 'Shared Co' }] });

		const row = await env.DB.prepare('SELECT website_checked FROM companies WHERE id = ?').bind('shared').first<any>();
		expect(row.website_checked).toBe(1);
	});

	it('keeps the source event and the collection date apart, and only a new event reaches Tier A', async () => {
		// Probird, as it was on 13 September 2026: a live DPIIT run found it that day,
		// carrying a recognition from 25 August 2023, and it was ranked Tier A.
		const recent = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
		await post({
			source: 'dpiit-startup-india',
			mode: 'live',
			companies: [
				// Described, as though another source said what they build: a label alone
				// keeps a company out of A and B whatever its dates, which is tested below.
				{ id: 'probird', name: 'Probird', sector_id: '2', subsector_id: '2.3', classify_basis: 'description' },
				{ id: 'fresh', name: 'Fresh Co', sector_id: '2', subsector_id: '2.3', classify_basis: 'description' },
			],
			signals: [
				{ company_id: 'probird', type: 'dpiit', label: 'DPIIT recognised 2023', date: '2023-08-25' },
				{ company_id: 'fresh', type: 'dpiit', label: `DPIIT recognised ${recent.slice(0, 4)}`, date: recent },
			],
		});

		const tiers = await env.DB.prepare('SELECT id, first_seen_basis, tier FROM companies ORDER BY id').all<any>();
		expect(tiers.results).toEqual([
			{ id: 'fresh', first_seen_basis: 'discovered', tier: 'A' },
			// Still new to us, so still inside B's window; no longer claimed as early.
			{ id: 'probird', first_seen_basis: 'discovered', tier: 'B' },
		]);

		const html = await page('?tier=all&age=all');
		const start = html.indexOf('id="c-probird"');
		const row = html.slice(start, html.indexOf('</li>', start));
		expect(row).toContain('DPIIT recognised Aug 2023');
		expect(row).toContain('added to Upstream today');
		expect(row.indexOf('Aug 2023')).toBeLessThan(row.indexOf('added to Upstream'));
		expect(html).toContain('2 companies turned up in the last seven days in a source we were already watching.');
		// Each row's "added to Upstream" is the day it was written; the headline is not that count.
		expect(html).not.toContain('added to Upstream in the last seven days');

		const detailHtml = await detail('probird');
		expect(detailHtml).toContain('A source dates this company to 25 Aug 2023');
	});

	it('marks a company dated by a register rather than a founding year', async () => {
		await post({
			source: 'dpiit',
			companies: [
				// A register knows when it recognised them, not when they started.
				{ id: 'registered', name: 'Registered Co', record_year: THIS_YEAR },
				{ id: 'founded', name: 'Founded Co', origin_year: THIS_YEAR },
			],
		});

		const rows = await env.DB.prepare('SELECT id, first_seen, origin_year FROM companies ORDER BY id').all<any>();
		expect(rows.results).toEqual([
			// Both dated; only one claims to know when the company began.
			{ id: 'founded', first_seen: `${THIS_YEAR}-01-01`, origin_year: THIS_YEAR },
			{ id: 'registered', first_seen: `${THIS_YEAR}-01-01`, origin_year: null },
		]);

		const html = await page('?tier=all');
		expect(html).toContain('founding year unknown');
		expect(html).toContain('dated by a public register rather than by a');
		// The one with a founding year is listed without the caveat.
		const founded = html.slice(html.indexOf('Founded Co'), html.indexOf('Founded Co') + 400);
		expect(founded).not.toContain('founding year unknown');
	});

	it('does not let a register date stand in for a founding year at the gate', async () => {
		await post({
			source: 'dpiit',
			companies: [{ id: 'registered', name: 'Registered Co', record_year: THIS_YEAR }],
		});

		// Unknown age is not old age: it stays listed, exactly as an undated company
		// stays visible, and the page carries the caveat instead.
		expect(await page('?tier=all')).toContain('Registered Co');
		expect(await page('?tier=all')).not.toContain('started more than 5 years ago');
	});

	it('holds back companies that started more than five years ago, and says so', async () => {
		await post({
			source: 'archive',
			companies: [
				{ id: 'recent', name: 'Recent Co', origin_year: THIS_YEAR },
				{ id: 'ancient', name: 'Ancient Co', origin_year: THIS_YEAR - 9 },
			],
		});

		const html = await page('?tier=all');
		expect(html).toContain('Recent Co');
		expect(html).not.toContain('Ancient Co');
		expect(html).toContain('started more than 5 years ago');

		const everything = await page('?tier=all&age=all');
		expect(everything).toContain('Ancient Co');
		expect(everything).not.toContain('held back');
	});

	it('gives the off-map companies a section of their own', async () => {
		await post({
			source: 'test',
			gaps: [
				{ company_id: 'botsrule', name: 'Botsrule Ltd', missing: 'water infrastructure', note: 'No cell covers water distribution.' },
				{ company_id: 'ajivam', name: 'Ajivam Ltd', missing: 'water infrastructure', note: 'No cell covers water pressurisation.' },
			],
		});

		const html = await page();
		expect(html).toContain('id="off-map"');
		expect(html).toContain('water infrastructure');
		expect(html).toContain('Botsrule Ltd');
		// The count is the companies, not the groups.
		expect(html).toContain('<h2 id="off-map-h">Unmapped under the current taxonomy and classifier <span class="count">2</span></h2>');
		// Nothing here was a description failure, so that section is absent entirely.
		expect(html).not.toContain('id="undescribed"');
	});

	it('states a thin description as our failure, not as a hole in the taxonomy', async () => {
		await post({
			source: 'test',
			gaps: [
				{ company_id: 'botsrule', name: 'Botsrule Ltd', missing: 'water infrastructure', note: 'No cell covers water distribution.' },
				{ company_id: 'anon-one', name: 'Anon One Ltd', missing: 'no gap named', note: 'The register published a name and an industry.' },
				{ company_id: 'anon-two', name: 'Anon Two Ltd', missing: 'no gap named', note: 'The register published a name and an industry.' },
			],
		});

		const html = await page();
		// Two findings, two headings, two counts — and the counts do not overlap.
		expect(html).toContain('<h2 id="off-map-h">Unmapped under the current taxonomy and classifier <span class="count">1</span></h2>');
		expect(html).toContain('<h2 id="undescribed-h">Companies we could not describe well enough to place <span class="count">2</span></h2>');
		// The taxonomy section must not claim the two we simply could not read.
		const taxonomySection = html.slice(html.indexOf('id="off-map"'), html.indexOf('id="undescribed"'));
		expect(taxonomySection).not.toContain('Anon One Ltd');
		expect(taxonomySection).toContain('Botsrule Ltd');
	});

	it('says nothing about the map having holes when it has none', async () => {
		expect(await page()).not.toContain('id="off-map"');
	});

	it('defaults the tier toggle to A+B and honours the other choices', async () => {
		await post({ source: 'live-source', mode: 'live', companies: [{ id: 'found', name: 'Found Co' }] });

		expect(await page()).toContain('<option value="ab" selected>A + B</option>');
		expect(await page('?tier=a')).toContain('<option value="a" selected>A only</option>');
		expect(await page('?tier=all')).toContain('<option value="all" selected>Everything</option>');
		// A tier other than the default is a filter, and says so as a chip.
		expect(await page('?tier=a')).toContain('Tier: A only');
		expect(await page()).not.toContain('Tier: A + B');
	});

	it('opens on everything while every row is a backfill, and says why', async () => {
		await post({ source: 'archive', companies: [{ id: 'backfilled', name: 'Backfilled Co', origin_year: THIS_YEAR }] });

		const html = await page();
		// A+B would be empty by construction here, so the default widens.
		expect(html).toContain('<option value="all" selected>');
		expect(html).toContain('Nothing qualifies for Tier A or B today');
		expect(html).toContain('Backfilled Co');

		// The explanation belongs to the state, not the toggle: it stands on A too.
		expect(await page('?tier=a')).toContain('Nothing qualifies for Tier A or B today');

		// One live discovery and the default narrows again, with nothing left to explain.
		await post({ source: 'live-source', mode: 'live', companies: [{ id: 'found', name: 'Found Co' }] });
		const after = await page();
		expect(after).toContain('<option value="ab" selected>');
		expect(after).not.toContain('Nothing qualifies for Tier A or B today');
		expect(after).toContain('Found Co');
		expect(after).not.toContain('Backfilled Co');
	});

	it('keeps a company placed from a register label alone out of A and B, and still opens on everything', async () => {
		// 14 September 2026: every Tier A row was a DPIIT record like this one.
		const recent = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
		await post({ source: 'dpiit-startup-india', companies: [{ id: 'old', name: 'Old Co', sector_id: '2', subsector_id: '2.5', classify_basis: 'register-label' }] });
		await post({
			source: 'dpiit-startup-india',
			mode: 'live',
			companies: [{ id: 'spaceock', name: 'Spaceock', sector_id: '2', subsector_id: '2.5', classify_basis: 'register-label' }],
			signals: [{ company_id: 'spaceock', type: 'dpiit', label: `DPIIT recognised ${recent.slice(0, 4)}`, date: recent }],
		});

		const row = await env.DB.prepare('SELECT first_seen_basis, tier FROM companies WHERE id = ?').bind('spaceock').first<any>();
		expect(row).toEqual({ first_seen_basis: 'discovered', tier: 'C' });

		// A live find, so the headline still counts it; nothing ranked, so the default widens.
		const html = await page();
		expect(html).toContain('<option value="all" selected>');
		expect(html).toContain('Nothing qualifies for Tier A or B today');
		expect(html).toContain('Spaceock');
		expect(await detail('spaceock')).toContain("is a register's dropdown label");

		// The same company, once something describes it, is a find again.
		await post({ source: 'venture-center', companies: [{ id: 'spaceock', name: 'Spaceock', sector_id: '2', subsector_id: '2.5', classify_basis: 'description' }] });
		const tier = await env.DB.prepare('SELECT tier FROM companies WHERE id = ?').bind('spaceock').first<any>();
		expect(tier.tier).toBe('A');
		expect(await page()).toContain('<option value="ab" selected>');
	});

	it('opens on everything when the only B row is one the age gate holds back', async () => {
		await post({ source: 'archive', companies: [{ id: 'backfilled', name: 'Backfilled Co', origin_year: THIS_YEAR }] });
		// Found live today, but started long ago: Tier B, and outside the default list.
		await post({ source: 'live-source', mode: 'live', companies: [{ id: 'veteran', name: 'Veteran Co', origin_year: 2009 }] });
		const tier = await env.DB.prepare('SELECT tier FROM companies WHERE id = ?').bind('veteran').first<any>();
		expect(tier.tier).toBe('B');

		const html = await page();
		expect(html).toContain('<option value="all" selected>');
		expect(html).toContain('Nothing qualifies for Tier A or B today');
	});

	it('states the whole funnel, under the map rather than above the proposition', async () => {
		// Two placed, three off the map. Both numbers still have to be said — a figure
		// that silently meant "the subset that fitted" was the one place on this page
		// where something disappeared without being named — but they are the pipeline
		// explaining itself, and they no longer come before the page has said what it
		// is. They sit with the map they are about.
		await post({
			source: 'test',
			companies: [
				{ id: 'placed-one', name: 'Placed One', sector_id: '5', subsector_id: '5.1' },
				{ id: 'placed-two', name: 'Placed Two', sector_id: '5', subsector_id: '5.1' },
			],
			gaps: [
				{ company_id: 'hole-a', name: 'Hole A', missing: 'water infrastructure', note: 'n', sector_id: '5' },
				{ company_id: 'hole-b', name: 'Hole B', missing: 'water infrastructure', note: 'n', sector_id: '5' },
				{ company_id: 'hole-c', name: 'Hole C', missing: 'geospatial services', note: 'n', sector_id: '5' },
			],
		});

		const html = await page('');
		// Both ends of the funnel, in full.
		expect(html).toMatch(/5 companies have reached this pipeline and 2 are on the map above/);
		// The drop is stated, not left for the reader to compute, and it is split by
		// whose fault it is — the taxonomy gap is claimed only for the companies that
		// actually are one.
		expect(html).toMatch(/Of the 3 that are not, <a href="#off-map">3<\/a> were not mapped to any sub-sector under the current taxonomy and classifier/);
		// Scoped to the funnel note: the methodology below links to the same anchors
		// when there is something to link to, which there is not here.
		const note = html.slice(html.indexOf('class="funnel-note"'), html.indexOf('</p>', html.indexOf('class="funnel-note"')));
		expect(note).not.toContain('#undescribed');

		// And the arithmetic is below the claim, not in front of it. A stranger meets
		// the proposition first; the pipeline's accounting of itself comes after the
		// map it describes.
		expect(html.indexOf('class="hook"')).toBeLessThan(html.indexOf('class="funnel-note"'));
		expect(html).not.toContain('Companies found');
		expect(html).not.toContain('Placed on the map');
	});

	it('opens with the proposition and three numbers that back it up', async () => {
		await post({
			source: 'test',
			companies: [
				// One trace apiece for two of them, three for the third: the headline
				// counts the quiet ones, which is the claim the page is making.
				{ id: 'quiet-one', name: 'Quiet One', sector_id: '5', subsector_id: '5.1' },
				{ id: 'quiet-two', name: 'Quiet Two', sector_id: '5', subsector_id: '5.1' },
				{ id: 'noticed', name: 'Noticed Co', sector_id: '5', subsector_id: '5.2' },
			],
			signals: [
				{ company_id: 'quiet-one', type: 'incubator', label: 'One cohort' },
				{ company_id: 'quiet-two', type: 'incubator', label: 'One cohort' },
				{ company_id: 'noticed', type: 'incubator', label: 'One cohort' },
				{ company_id: 'noticed', type: 'website', label: 'Has a site' },
				{ company_id: 'noticed', type: 'press', label: 'Written about' },
			],
		});

		const html = await page('');
		// The name is not the proposition. It is there, and it is not the headline.
		expect(html).toContain('<p class="eyebrow">Upstream</p>');
		expect(html).toMatch(/<h1>3 Indian deep-tech companies, sorted by obscurity\.<\/h1>/);
		// The argument, with the repeatable half emphasised.
		expect(html).toMatch(/which is why <strong>every fund\s+keeps finding the same twenty names<\/strong>/);

		// The proof arrives last, and only after the rule that gives it meaning. A
		// reader who meets "2 have left one public trace or none" before being told
		// what a trace is has been shown the best number on the page at the one moment
		// it cannot mean anything.
		const lede = html.slice(html.indexOf('class="hook"'), html.indexOf('</p>', html.indexOf('class="hook"')));
		expect(lede).toMatch(/one incubator listing and no\s+website beats a known name and a press cycle\./);
		expect(lede.indexOf('incubator listing')).toBeLessThan(lede.indexOf('one public trace or none'));
		expect(lede).toMatch(/Of the 3 here, 2 have left one public trace or none\./);

		// And the headline owns "obscurity" — the lede under it has to do different
		// work than repeat the word.
		expect(lede).not.toContain('obscurity');

		expect(html).toContain('<dt>Companies</dt><dd>3</dd>');
		expect(html).toContain('<dt>One public trace at most</dt><dd>2</dd>');
		// 44 sub-sectors, two of them now occupied.
		expect(html).toContain('<dt>Sub-sectors still empty</dt><dd>42<span class="of">/44</span>');

		// Nothing was discovered live, so the liveness line is absent rather than
		// reporting a zero that reads as a broken pipeline.
		expect(html).not.toContain('discovered in the last seven days');
	});

	it("splits the register's unplaced companies into the two things they actually are", async () => {
		// Three from the register: one placed, one the taxonomy has no cell for, one
		// the register described too thinly. The methodology must not average them.
		// Gaps take the payload's source, not a per-row one, so this posts as the
		// register does.
		await post({
			source: 'dpiit-startup-india',
			companies: [{ id: 'placed', name: 'Placed Co', sector_id: '5', subsector_id: '5.1' }],
			signals: [{ company_id: 'placed', type: 'dpiit', label: 'DPIIT recognised 2026' }],
			gaps: [
				{ company_id: 'hole', name: 'Hole Co', missing: 'water infrastructure', note: 'n', sector_id: '5' },
				{ company_id: 'thin', name: 'Thin Co', missing: 'no gap named', note: 'n', sector_id: '5' },
			],
		});

		const html = await page('');
		// Whitespace-tolerant: the template wraps these sentences across lines.
		expect(html).toMatch(/Of the 3 companies read from the register,\s+1 reached a sub-sector and\s+2 did not/);
		expect(html).toMatch(/<strong>1<\/strong> are unplaced because the classifier found/);
		expect(html).toMatch(/<strong>1<\/strong> are unplaced because[\s\S]*?the register never said what they do/);
		// The share is of every register company, not of the unplaced ones.
		expect(html).toMatch(/Of the 3 records we took from the register, 33&nbsp;per&nbsp;cent\s+are described too thinly/);
		// About the records read, never the register as a whole.
		expect(html).toContain('not a sample of the 473,000 companies the register holds');
		expect(html).not.toContain('A national startup register');
		expect(html).not.toContain('holes in the RDI taxonomy');
		// And the old undivided claim is gone for good.
		expect(html).not.toContain('placed in no sub-sector at all');
	});

	it('puts the controls and the list before the coverage map, and folds the map', async () => {
		await post({ source: 'archive', companies: [{ id: 'backfilled', name: 'Backfilled Co', origin_year: THIS_YEAR }] });

		// A tool puts its controls first. The map is the argument, so it follows the
		// list, folded, with its count in the summary — no script needed to open it.
		const html = await page('');
		expect(html.indexOf('id="controls"')).toBeLessThan(html.indexOf('id="list"'));
		expect(html.indexOf('id="list"')).toBeLessThan(html.indexOf('id="coverage"'));
		expect(html).toContain('<details class="map-fold">');
		expect(html).toMatch(/<summary>[\s\S]*?Coverage map[\s\S]*?0 of 44 sub-sectors have companies[\s\S]*?<\/summary>/);

		// Arriving from a cell, the map is open so the chosen cell is not hidden.
		expect(await page('?subsector=1.1')).toContain('<details class="map-fold" open>');
	});

	it('keeps an explicit tier choice when the default is something else', async () => {
		await post({ source: 'archive', companies: [{ id: 'backfilled', name: 'Backfilled Co', origin_year: THIS_YEAR }] });

		// Default is 'all' here, so a chosen 'ab' has to survive a coverage-cell click.
		const html = await page('?tier=ab');
		expect(html).toContain('<option value="ab" selected>');
		expect(html).toMatch(/href="[^"]*tier=ab[^"]*"[^>]*>\s*<span class="cell-head">/);
	});

	it('applies the tier toggle to the list', async () => {
		await post({ source: 'archive', companies: [{ id: 'old-known', name: 'Old Known', origin_year: 2019 }] });
		await post({ source: 'live-source', mode: 'live', companies: [{ id: 'new-quiet', name: 'New Quiet' }] });

		expect(await page('?tier=a&age=all')).not.toContain('Old Known');
		expect(await page('?tier=all&age=all')).toContain('Old Known');
		expect(await page('?tier=a&age=all')).toContain('New Quiet');
		// A live discovery exists, so the default is back to A+B and hides the old row.
		expect(await page('?age=all')).not.toContain('Old Known');
	});

	it('escapes scraped text and refuses a javascript: url', async () => {
		await post({
			source: 'test',
			companies: [{ id: 'xss', name: '<script>alert(1)</script>', website: 'javascript:alert(1)' }],
			signals: [{ company_id: 'xss', type: 'press', label: 'click "me"', url: 'javascript:alert(2)' }],
		});

		const html = await page('?tier=all');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).not.toContain('<script>alert(1)</script>');
		expect(html).not.toContain('javascript:');

		// The signal labels moved to the company's own page, and so does this. A
		// javascript: url is refused an href and the label stays text either way.
		const one = await detail('xss');
		expect(one).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(one).not.toContain('javascript:');
		expect(one).toContain('click &quot;me&quot;');
		expect(one).toContain('no link published');
	});
});

describe('searching and one company at a time', () => {
	async function seed() {
		await post({
			source: 'test',
			mode: 'live',
			companies: [
				{
					id: 'kadamb-biolabs',
					name: 'Kadamb Biolabs',
					description: 'DPIIT-recognised startup. Industry: Biotechnology. Stage: Prototype.',
					website: 'https://kadamb.example',
					city: 'Pune',
					state: 'Maharashtra',
					origin_year: THIS_YEAR,
					sector_id: '4',
					subsector_id: '4.2',
					classify_note: 'Assay kits place this in diagnostics rather than therapeutics.',
					classify_basis: 'register-label',
					product: 'Benchtop assay kits for district hospitals.',
					product_status: 'described',
					website_identity: 'verified',
				},
				{
					id: 'nistara-grid',
					name: 'Nistara Grid',
					description: 'Grid-scale flow batteries.',
					origin_year: THIS_YEAR,
					sector_id: '1',
					subsector_id: '1.4',
				},
			],
			signals: [
				{
					company_id: 'kadamb-biolabs',
					type: 'incubator',
					label: 'SINE cohort 2026',
					url: 'https://sineiitb.org/portfolio/',
					date: '2026-01-04',
				},
				{ company_id: 'kadamb-biolabs', type: 'press', label: 'no url for this one' },
			],
		});
	}

	it('searches the name, the source description and what they build', async () => {
		await seed();
		const listed = async (q: string) => {
			const body = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?age=all&tier=all&q=${encodeURIComponent(q)}`)).json<any>();
			return body.companies.map((c: any) => c.id).sort();
		};

		expect(await listed('kadamb')).toEqual(['kadamb-biolabs']);
		// The homepage sentence is searchable, which is most of the point of having it:
		// "assay" appears nowhere in this company's name or in the register's line.
		expect(await listed('assay')).toEqual(['kadamb-biolabs']);
		expect(await listed('flow batteries')).toEqual(['nistara-grid']);
		expect(await listed('nothing here')).toEqual([]);
	});

	it('treats a percent sign as a character, not as every row', async () => {
		await seed();
		const body = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?age=all&tier=all&q=%25`)).json<any>();
		expect(body.companies).toHaveLength(0);
	});

	it('keeps the search when a coverage cell or the age gate is clicked', async () => {
		await seed();
		const html = await (await SELF.fetch(`${ORIGIN}/upstream?q=assay&tier=all&age=all`)).text();
		// Every link that changes the view has to carry what was typed, or the reader
		// loses their search by touching the map.
		expect(html).toMatch(/href="\?q=assay&amp;subsector=4\.2[^"]*"/);
		expect(html).toContain('value="assay"');
	});

	it('does not call a claim that names its years undated', async () => {
		await post({
			source: 'sine-iitb',
			companies: [{ id: 'cohort-co', name: 'Cohort Co', sector_id: '2', subsector_id: '2.3' }],
			signals: [{ company_id: 'cohort-co', type: 'incubator', label: 'SINE IIT Bombay incubatee, 2024-2025' }],
		});
		const html = await (await SELF.fetch(`${ORIGIN}/upstream/c/cohort-co`)).text();
		expect(html).toContain('SINE IIT Bombay incubatee, 2024-2025 — ');
		expect(html).toMatch(/incubatee, 2024-2025 — [^,]+, no exact date:/);
		expect(html).toContain('<span class="no-link">no exact date</span>');
	});

	it('writes a brief from a template, with the unknowns before the evidence', async () => {
		await seed();
		const html = await (await SELF.fetch(`${ORIGIN}/upstream/c/kadamb-biolabs`)).text();
		const brief = html
			.slice(html.indexOf('<textarea id="brief-text"'), html.indexOf('</textarea>'))
			.replace(/^[^>]*>/, '')
			.replace(/&amp;/g, '&')
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>');

		expect(brief.startsWith('# Kadamb Biolabs')).toBe(true);
		expect(brief).toContain('**What it builds:** Benchtop assay kits for district hospitals.');
		// Unknown is a section of the same rank as Evidence, and comes first.
		expect(brief.indexOf('## Unknown')).toBeGreaterThan(0);
		expect(brief.indexOf('## Unknown')).toBeLessThan(brief.indexOf('## Evidence'));
		// Only what is actually empty: the founding year and the city are known here.
		expect(brief).not.toContain('When it was founded');
		expect(brief).not.toContain('Where it is based');
		expect(brief).toContain('- What kind of product it is, within 4.2');
		expect(brief).toContain('- Its company registration: no CIN on record');
		expect(brief).toContain('- Founders, funding and revenue: Upstream collects none of these');
		// Evidence with the real link, or saying there is none.
		expect(brief).toContain('https://sineiitb.org/portfolio/');
		expect(brief).toContain('no link published');
		expect(brief).toContain('- no url for this one — press, not dated:');
		expect(brief).toContain(`Upstream: ${ORIGIN}/upstream/c/kadamb-biolabs`);

		// The page lists the same unknowns, and the actions are there for the script.
		expect(html).toContain('<h2>What is not known</h2>');
		expect(html).toContain('<strong>Its company registration</strong>');
		expect(html).toContain('class="action copy-brief"');
		expect(html).toContain('data-mark="pass"');
		expect(html).toContain('stored in this browser on this device only');
	});

	it('gives every company a page of its own, with the reasoning printed as written', async () => {
		await seed();
		const html = await (await SELF.fetch(`${ORIGIN}/upstream/c/kadamb-biolabs`)).text();

		expect(html).toContain('<h1>Kadamb Biolabs</h1>');
		// Verbatim, not summarised. Somebody disagreeing with a placement has to be
		// able to see exactly what was decided and on what.
		expect(html).toContain('Assay kits place this in diagnostics rather than therapeutics.');
		expect(html).toContain('its reasoning, not evidence');
		expect(html).toContain('register label only');
		expect(html).toContain('4.2');
		expect(html).toContain('Project type: unknown');

		// Every signal, with the page it came from — and the one with no url saying so
		// rather than silently rendering as text.
		expect(html).toContain('sineiitb.org');
		expect(html).toContain('SINE cohort 2026');
		expect(html).toContain('no link published');

		// The dates are separate because they mean different things.
		expect(html).toContain('Source event');
		expect(html).toContain('Added to Upstream');
		expect(html).toContain('Last checked');

		// And the tier, with the rule that produced it rather than just the letter.
		// Kadamb was placed from a register label, and that is the rule that decided.
		expect(html).toContain('<h2>Tier C</h2>');
		expect(html).toContain("is a register's dropdown label");
	});

	it('says what reading the homepage came to, whichever way it went', async () => {
		await post({
			source: 'test',
			companies: [
				{ id: 'dead', name: 'Dead Domain Co', website: 'https://dead.example', product_status: 'unreachable' },
				{ id: 'shell', name: 'Shell Co', website: 'https://shell.example', product_status: 'thin' },
			],
		});

		expect(await (await SELF.fetch(`${ORIGIN}/upstream/c/dead`)).text()).toContain('it does not answer');
		expect(await (await SELF.fetch(`${ORIGIN}/upstream/c/shell`)).text()).toContain('draws itself in the');

		// A website nobody has read yet is not a company without a website. Getting
		// this wrong invents a finding out of a queue.
		await post({ source: 'test', companies: [{ id: 'queued', name: 'Queued Co', website: 'https://queued.example' }] });
		const queued = await (await SELF.fetch(`${ORIGIN}/upstream/c/queued`)).text();
		expect(queued).toContain('Nobody has read it yet');
		expect(queued).not.toContain('No website');
	});

	it('shows a company the front page is holding back', async () => {
		// Undated, so it never appears in the ranking. Asking for it by name still
		// works: a filter shapes a list and has no business deciding what exists.
		await post({ source: 'test', companies: [{ id: 'undated-co', name: 'Undated Co', sector_id: '5', subsector_id: '5.1' }] });
		const res = await SELF.fetch(`${ORIGIN}/upstream/c/undated-co`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('<h1>Undated Co</h1>');
	});

	it('404s a company that is not there, rather than landing somebody on the list', async () => {
		const res = await SELF.fetch(`${ORIGIN}/upstream/c/no-such-company`);
		expect(res.status).toBe(404);
	});

	it('links the row to the company rather than straight off the site', async () => {
		await seed();
		const html = await (await SELF.fetch(`${ORIGIN}/upstream?age=all&tier=all`)).text();
		const start = html.indexOf('id="c-kadamb-biolabs"');
		const row = html.slice(start, html.indexOf('</li>', start));

		expect(row).toContain('href="/upstream/c/kadamb-biolabs"');
		// The four facts that change a sourcing decision, and the trace count said out
		// loud rather than left to be inferred from counting chips.
		expect(row).toContain('Benchtop assay kits for district hospitals.');
		expect(row).toContain('2 public traces');
		expect(row).toContain('website');
		expect(row).toContain('incubator listing Jan 2026');
		expect(row).toContain('added to Upstream today');
		expect(row).not.toContain('first seen');
		// And the tier badge is gone from the row: every company is Tier C today, so
		// it was a column of identical labels that read as a bug.
		expect(row).not.toContain('Tier C');
	});
});

describe('people and projects are not companies', () => {
	it('counts them apart, tags the row, and says so on their page', async () => {
		await post({
			source: 'sine-iitb',
			mode: 'live',
			companies: [
				{
					id: 'aishwarya-dasare',
					name: 'Aishwarya Dasare',
					description: 'Development of plant-based protein source from waste oil cake residues',
					sector_id: '4',
					subsector_id: '4.2',
					classify_note: 'The company extracts plant-based protein from oil cake residues.',
					entity_type: 'researcher-project',
					entity_note: "listed under a person's name for a funded project; no company is on record",
				},
				{ id: 'planys', name: 'Planys Technologies Private Limited', sector_id: '2', subsector_id: '2.3', entity_type: 'company' },
			],
		});

		const html = await (await SELF.fetch(`${ORIGIN}/upstream?tier=all&age=all`)).text();
		expect(html).toContain('1 Indian deep-tech companies and 1 research projects, sorted by obscurity.');
		expect(html).toContain('<div><dt>Companies</dt><dd>1</dd></div>');
		expect(html).toContain('<div><dt>Projects, not companies</dt><dd>1</dd></div>');
		const start = html.indexOf('id="c-aishwarya-dasare"');
		expect(html.slice(start, html.indexOf('</li>', start))).toContain('a researcher&rsquo;s project, not a company');

		const detail = await (await SELF.fetch(`${ORIGIN}/upstream/c/aishwarya-dasare`)).text();
		expect(detail).toContain('no company is on record');
		expect(detail).toContain('Nothing on record shows one exists.');

		const bad = await post({ source: 'sine-iitb', companies: [{ id: 'x', name: 'X', entity_type: 'person' }] });
		expect(bad.status).toBe(400);
	});
});

describe('a year a source does not explain', () => {
	it('is stored and shown as printed, and dates and ranks nothing', async () => {
		await post({
			source: 'venture-center',
			mode: 'live',
			companies: [
				{
					id: 'call-x-ringers',
					name: 'Call X Ringers Pvt Ltd',
					description: 'Closing the loop on lithium-ion batteries.',
					sector_id: '1',
					subsector_id: '1.4',
					source_year: 2015,
					source_year_type: 'unknown',
					website: 'https://lithiumionbattery-recycling.com/',
					website_identity: 'associated',
					product_status: 'source-described',
				},
			],
		});
		const row = await env.DB.prepare('SELECT origin_year, source_year, source_year_type, product_status FROM companies WHERE id = ?').bind('call-x-ringers').first<any>();
		expect(row).toEqual({ origin_year: null, source_year: 2015, source_year_type: 'unknown', product_status: 'source-described' });

		// 2015 would be past the five-year gate if it were read as a start year. It is not.
		const html = await (await SELF.fetch(`${ORIGIN}/upstream?tier=all`)).text();
		expect(html).toContain('Call X Ringers Pvt Ltd');

		const detail = await (await SELF.fetch(`${ORIGIN}/upstream/c/call-x-ringers`)).text();
		expect(detail).toContain('The source listing prints 2015 beside the name');
		expect(detail).toContain('no word on what it counts');
		expect(detail).toContain('listing already says what they build');

		const claimed = await post({ source: 'venture-center', companies: [{ id: 'y', name: 'Y', source_year: 2015, source_year_type: 'founded' }] });
		expect(claimed.status).toBe(400);
		const impossible = await post({ source: 'venture-center', companies: [{ id: 'y', name: 'Y', source_year: 1015 }] });
		expect(impossible.status).toBe(400);
	});
});

describe('source health', () => {
	async function report(runs: unknown[], key = KEY) {
		return SELF.fetch(`${ORIGIN}/upstream/api/source-runs`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'X-Ingest-Key': key },
			body: JSON.stringify({ runs }),
		});
	}

	it('records every verdict, and refuses an anonymous or unexplained one', async () => {
		expect((await report([{ source: 'sine-iitb', status: 'ok', records: 233 }], 'wrong')).status).toBe(401);
		expect((await report([{ source: 'dpiit-startup-india', status: 'quarantined', records: 0 }])).status).toBe(400);
		expect((await report([{ source: 'dpiit-startup-india', status: 'sleepy', records: 0 }])).status).toBe(400);
		expect((await report([{ source: 'sine-iitb', status: 'ok', records: 233, data_as_of: '2026-09-12T11:00:00Z' }])).status).toBe(200);
	});

	it('keeps the last good run beside a failure, and says both on the page', async () => {
		await report([
			{ source: 'dpiit-startup-india', status: 'ok', records: 330, data_as_of: '2026-09-12T15:07:00Z' },
			{ source: 'sine-iitb', status: 'ok', records: 233, data_as_of: '2026-09-12T15:07:00Z' },
		]);
		await report([
			{ source: 'dpiit-startup-india', status: 'failed', records: 0, reason: 'HTTPError: 403 Forbidden' },
			{ source: 'sine-iitb', status: 'ok', records: 235, data_as_of: '2026-09-13T08:00:00Z' },
		]);

		const sources = await (await SELF.fetch(`${ORIGIN}/upstream/api/sources`)).json<any[]>();
		const dpiit = sources.find((s) => s.source === 'dpiit-startup-india');
		expect(dpiit).toMatchObject({ last_status: 'failed', last_reason: 'HTTPError: 403 Forbidden', last_success_records: 330 });
		expect(dpiit.last_success).not.toBeNull();

		const html = await (await SELF.fetch(`${ORIGIN}/upstream`)).text();
		const line = html.slice(html.indexOf('<p class="freshness">'), html.indexOf('</p>', html.indexOf('<p class="freshness">')));
		expect(line).toContain('DPIIT register <strong>failed on');
		expect(line).toContain('showing 12 Sep 2026');
		// One healthy source does not vouch for the other.
		expect(line).toContain('SINE IIT Bombay 13 Sep 2026');
	});

	it('never prints the day a run succeeded as the date of the data', async () => {
		// The grants file was read on 14 September 2026; its newest award is from 2025.
		await report([
			{ source: 'grants-csv', status: 'ok', records: 177, data_as_of: '2025-10-06' },
			{ source: 'rtbi-iitm', status: 'ok', records: 42 },
		]);
		const html = await (await SELF.fetch(`${ORIGIN}/upstream`)).text();
		const line = html.slice(html.indexOf('<p class="freshness">'), html.indexOf('</p>', html.indexOf('<p class="freshness">')));
		expect(line).toContain('Government grants 6 Oct 2025');
		expect(line).toContain('IIT Madras RTBI date unknown');
	});
});

describe('where they are', () => {
	async function seed() {
		// The real shape: the register gives a state and no date, the incubators a date
		// and no state.
		await post({
			source: 'dpiit-startup-india',
			companies: [
				{ id: 'pune-co', name: 'Pune Co', state: 'Maharashtra', city: 'Pune', sector_id: '2', subsector_id: '2.3' },
				{ id: 'thane-co', name: 'Thane Co', state: 'Maharashtra', sector_id: '2', subsector_id: '2.3' },
				{ id: 'surat-co', name: 'Surat Co', state: 'Gujarat', sector_id: '2', subsector_id: '2.3' },
			],
			signals: ['pune-co', 'thane-co', 'surat-co'].map((id) => ({ company_id: id, type: 'dpiit', label: 'DPIIT recognised 2026' })),
		});
		await post({
			source: 'sine-iitb',
			companies: [
				{ id: 'a', name: 'A Co', origin_year: THIS_YEAR, sector_id: '2', subsector_id: '2.3' },
				{ id: 'b', name: 'B Co', origin_year: THIS_YEAR, sector_id: '2', subsector_id: '2.3' },
				{ id: 'c', name: 'C Co', origin_year: THIS_YEAR, sector_id: '2', subsector_id: '2.3' },
				{ id: 'd', name: 'D Co', origin_year: THIS_YEAR, sector_id: '2', subsector_id: '2.3', state: 'Karnataka' },
			],
		});
	}
	const text = async (qs: string) => (await SELF.fetch(`${ORIGIN}/upstream${qs}`)).text();
	const rows = (html: string) => [...html.matchAll(/<li class="company [^"]*" id="c-([^"]+)"/g)].map((m) => m[1]).sort();

	const widget = (html: string, id: string) => {
		const at = html.indexOf(`aria-labelledby="${id}"`);
		const next = html.indexOf('aria-labelledby="w-', at + 1);
		return html.slice(at, next === -1 ? html.indexOf('</section>', at) : next);
	};

	it('says what it does not know in the widget header, with unknown as the first tile', async () => {
		await seed();
		const html = await text('?tier=all');
		// Above the controls, under the masthead.
		expect(html.indexOf('id="widgets"')).toBeGreaterThan(html.indexOf('class="masthead"'));
		expect(html.indexOf('id="widgets"')).toBeLessThan(html.indexOf('id="controls"'));

		const places = widget(html, 'w-places');
		expect(places).toContain('<strong>4 of 7</strong> have a location, and only <strong>1 of the 4</strong> dated rows do.');
		const tiles = [...places.matchAll(/<span class="cell-n">(\d+)<\/span><\/span>\s*<span class="cell-name">([^<]+)<\/span>/g)].map((m) => `${m[2]} ${m[1]}`);
		expect(tiles).toEqual(['location unknown 3', 'Maharashtra 2', 'Gujarat 1', 'Karnataka 1']);
		// No comparison with an earlier run, anywhere on the page.
		expect(html).not.toMatch(/vs\.? (previous|last)|since yesterday|[+−-]\d+%/);
	});

	it('draws India with each state shaded by its count and linked to its view', async () => {
		await seed();
		const places = widget(await text('?tier=all&age=all&state=Maharashtra'), 'w-places');
		const map = places.slice(places.indexOf('<figure class="india-map">'), places.indexOf('</figure>'));
		expect(map).toContain('aria-hidden="true"');
		// Every state and union territory is drawn, the ones with nothing in view too.
		expect(map.match(/<path class="state[ "]/g)).toHaveLength(36);
		expect(map).toContain('<title>Ladakh: none in view</title>');
		// The most gets the most ink; a state with half as many gets less.
		expect(map).toMatch(/style="--ink-share:80%" d="[^"]+"><title>Maharashtra: 2<\/title>/);
		expect(map).toMatch(/style="--ink-share:61%" d="[^"]+"><title>Gujarat: 1<\/title>/);
		// Out of the tab order: the tiles beside it are the control.
		expect(map).toMatch(/<a href="\/upstream\?age=all#widgets" tabindex="-1" class="state-link active">/);
		expect(map).toContain('<path class="state-outline"');
		expect(map).toContain('CC BY 4.0');
		// The unknown tile still comes before any state.
		expect(places.indexOf('location unknown')).toBeLessThan(places.indexOf('<span class="cell-name">Maharashtra</span>'));
	});

	it('filters the list, the counts and the file by a tile, unknown included', async () => {
		await seed();
		const maharashtra = await text('?tier=all&age=all&state=Maharashtra');
		expect(rows(maharashtra)).toEqual(['pune-co', 'thane-co']);
		expect(maharashtra).toContain('5 hidden by filters');
		expect(maharashtra).toContain('Location: Maharashtra');
		expect(maharashtra).toContain('<input type="hidden" id="state" name="state" value="Maharashtra">');
		// The district is the detail, as the source wrote it.
		expect(maharashtra).toContain('In Maharashtra, by city or district: Pune <span class="n">1</span>');

		const unknown = await text('?tier=all&age=all&state=unknown');
		expect(rows(unknown)).toEqual(['a', 'b', 'c']);

		const csv = await text('/export.csv?tier=all&age=all&state=Gujarat');
		expect(csv.trim().split('\n')).toHaveLength(2);
		expect(csv).toContain('Surat Co');
	});

	it('counts every widget under the other filters, and its own dimension in full', async () => {
		await seed();
		const html = await text('?tier=all&age=all&state=Maharashtra');
		// The sector widget sees only Maharashtra's two.
		expect(widget(html, 'w-sectors')).toContain('<strong>2 of 2</strong> placed');
		// Over its own population, not the filtered one: "192 of 26" was this bug.
		expect(widget(html, 'w-places')).toContain('<strong>4 of 7</strong> have a location');
		// The places widget still shows every state, so a reader can move to another.
		expect(widget(html, 'w-places')).toMatch(/<span class="cell-n">1<\/span><\/span>\s*<span class="cell-name">Gujarat<\/span>/);
		// And the chosen tile is marked, and links back to no location filter.
		expect(widget(html, 'w-places')).toMatch(/class="cell seg filled active" href="\/upstream\?age=all#widgets"/);
	});
});

describe('what they build, and how many traces', () => {
	async function seed() {
		await post({
			source: 'dpiit-startup-india',
			companies: [{ id: 'label-co', name: 'Label Co', sector_id: '2', subsector_id: '2.3', description: 'DPIIT-recognised startup. Industry: Robotics. Stage: Prototype.', classify_basis: 'register-label' }],
			signals: [{ company_id: 'label-co', type: 'dpiit', label: 'DPIIT recognised 2026' }],
		});
		await post({
			source: 'sine-iitb',
			companies: [
				{ id: 'said-co', name: 'Said Co', sector_id: '2', subsector_id: '2.3', description: 'Cobots for small workshops.' },
				{ id: 'loud-co', name: 'Loud Co', sector_id: '2', subsector_id: '2.3', description: 'Drones.' },
			],
			signals: [
				{ company_id: 'said-co', type: 'incubator', label: 'SINE cohort' },
				...['incubator', 'grant', 'press'].map((type) => ({ company_id: 'loud-co', type, label: `${type} trace` })),
			],
		});
	}
	const text = async (qs: string) => (await SELF.fetch(`${ORIGIN}/upstream${qs}`)).text();
	const rows = (html: string) => [...html.matchAll(/<li class="company [^"]*" id="c-([^"]+)"/g)].map((m) => m[1]).sort();

	it('filters by whose words say what a company builds, and says how many have none', async () => {
		await seed();
		const all = await text('?tier=all&age=all');
		expect(all).toContain("<strong>1 of 3</strong> have no sentence saying so, only the DPIIT register's dropdown label.");
		expect(rows(await text('?tier=all&age=all&described=label'))).toEqual(['label-co']);
		expect(rows(await text('?tier=all&age=all&described=source'))).toEqual(['loud-co', 'said-co']);
		expect(await text('?tier=all&age=all&described=label')).toContain('What it builds: register label only');
		const api = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?tier=all&age=all&undated=1&described=label`)).json<any>();
		expect(api.companies.map((c: any) => c.id)).toEqual(['label-co']);
		expect((await SELF.fetch(`${ORIGIN}/upstream/api/companies?described=vibes`)).status).toBe(400);
	});

	it('filters by public traces, and draws the thesis as one or none, two, three or more', async () => {
		await seed();
		const all = await text('?tier=all&age=all');
		expect(all).toContain('<strong>2 of 3</strong> have one or none.');
		expect(rows(await text('?tier=all&age=all&traces=3%2B'))).toEqual(['loud-co']);
		expect(rows(await text('?tier=all&age=all&traces=1'))).toEqual(['label-co', 'said-co']);
		const csv = await text('/export.csv?tier=all&age=all&traces=1');
		expect(csv.trim().split('\n')).toHaveLength(3);
	});
});

describe('counts that reconcile', () => {
	// Energy Storage, as the reviewer found it: the cell said 14, the list under it
	// was empty, four undated rows sat below, and the other ten were not accounted
	// for anywhere. Here: four in 1.4, one of each way a company can be out of view.
	async function seed() {
		// Something ranked elsewhere, so the default narrows to Tier A and B.
		await post({ source: 'dpiit-startup-india', mode: 'live', companies: [{ id: 'fresh', name: 'Fresh Co', sector_id: '2', subsector_id: '2.3' }] });
		await post({
			source: 'rtbi-iitm',
			mode: 'backfill',
			companies: [
				{ id: 'grinntech', name: 'Grinntech Motors', sector_id: '1', subsector_id: '1.4' },
				{ id: 'cohort-a', name: 'Cohort A', sector_id: '1', subsector_id: '1.4', origin_year: THIS_YEAR },
				{ id: 'cohort-b', name: 'Cohort B', sector_id: '1', subsector_id: '1.4', origin_year: THIS_YEAR - 1 },
				{ id: 'old-co', name: 'Old Co', sector_id: '1', subsector_id: '1.4', origin_year: THIS_YEAR - 9 },
			],
		});
	}
	const text = async (qs: string) => (await SELF.fetch(`${ORIGIN}/upstream${qs}`)).text();
	const rows = (html: string) => [...html.matchAll(/<li class="company [^"]*" id="c-([^"]+)"/g)].map((m) => m[1]).sort();

	it('accounts for every company a coverage cell counts, and offers all of them', async () => {
		await seed();
		const html = await text('?subsector=1.4');
		expect(html).toContain('<span class="cell-id">1.4</span><span class="cell-n">4</span>');

		// Every record accounted for: 0 shown + 1 hidden by the filter + 3 held back + 1 undated = 5.
		const line = html.slice(html.indexOf('<p class="result-line"'), html.indexOf('</p>', html.indexOf('<p class="result-line"')));
		expect(line).toContain('<strong>0</strong> in the list of 5');
		expect(line).toContain('>1 hidden by filters</a>');
		expect(line).toContain('>3 held back by tier or age</a>');
		expect(line).toContain('>1 undated</a>');
		expect(line).toContain('1 started more than 5 years ago and is held back by the age filter; 2 are Tier C, and the list is showing Tier A and B');
		expect(html).not.toContain('Nothing matches');
		expect(rows(html)).toEqual(['grinntech']);

		const all = line.match(/<a href="([^"]+)"[^>]*>3 held back by tier or age<\/a>/)![1].replace(/&amp;/g, '&');
		expect(rows(await (await SELF.fetch(`${ORIGIN}${all}`)).text())).toEqual(['cohort-a', 'cohort-b', 'grinntech', 'old-co']);
	});

	it('never prints "nothing matches" above a result', async () => {
		await seed();
		const html = await text('?q=grinntech');
		expect(html).not.toContain('Nothing matches');
		expect(html).toContain('>1 undated</a>');
		expect(html).toContain('Search: “grinntech”');
		expect(rows(html)).toEqual(['grinntech']);

		expect(await text('?q=nobody-by-this-name')).toContain('Nothing matches these filters.');
	});

	it('exports the rows the page is showing, not a wider default', async () => {
		await seed();
		for (const qs of ['?subsector=1.4', '', '?tier=all&age=all', '?q=cohort&tier=all']) {
			const html = await text(qs);
			const csv = await text(`/export.csv${qs}`);
			const names = csv
				.trim()
				.split('\n')
				.slice(1)
				.map((line) => line.split(',')[0].replace(/"/g, ''))
				.sort();
			const shown = [...html.matchAll(/<li class="company [^"]*" id="c-[^"]+"[\s\S]*?<h3><a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]).sort();
			expect(names, qs).toEqual(shown);
		}
	});
});

describe('slicing the list', () => {
	async function seed() {
		await post({
			source: 'sine-iitb',
			mode: 'live',
			companies: [
				{
					id: 'sine-sited',
					name: 'Sine Sited Co',
					website: 'https://a.example',
					origin_year: THIS_YEAR,
					sector_id: '2',
					subsector_id: '2.5',
					trace_count: 1,
				},
				{ id: 'sine-bare', name: 'Sine Bare Co', origin_year: THIS_YEAR, sector_id: '2', subsector_id: '2.5' },
			],
			signals: [
				{ company_id: 'sine-sited', type: 'incubator', label: 'SINE cohort' },
				{ company_id: 'sine-bare', type: 'incubator', label: 'SINE cohort' },
				{ company_id: 'sine-bare', type: 'press', label: 'written about' },
				{ company_id: 'sine-bare', type: 'grant', label: 'a grant' },
			],
		});
		await post({
			source: 'dpiit-startup-india',
			mode: 'live',
			companies: [
				// No website field from the register, so "no website" must not claim this one.
				{
					id: 'dpiit-unknown',
					name: 'Dpiit Unknown Co',
					website_checked: false,
					origin_year: THIS_YEAR,
					sector_id: '4',
					subsector_id: '4.2',
				},
			],
			signals: [{ company_id: 'dpiit-unknown', type: 'dpiit', label: 'DPIIT recognised' }],
		});
	}

	const ids = async (qs: string) => {
		const body = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?age=all&tier=all&${qs}`)).json<any>();
		return body.companies.map((c: any) => c.id);
	};

	it('filters by the source that found it', async () => {
		await seed();
		expect((await ids('source=sine-iitb')).sort()).toEqual(['sine-bare', 'sine-sited']);
		expect(await ids('source=dpiit-startup-india')).toEqual(['dpiit-unknown']);
	});

	it('counts a company once even when one source gave it several signals', async () => {
		await seed();
		// sine-bare carries three signals from one source. A join would return it three
		// times and the count beside the list would stop matching the list.
		expect((await ids('source=sine-iitb')).filter((id: string) => id === 'sine-bare')).toHaveLength(1);
	});

	it('treats "no website" as something somebody checked, not as an empty column', async () => {
		await seed();
		expect(await ids('site=has')).toEqual(['sine-sited']);
		// sine-bare was looked for and has none. dpiit-unknown was never looked for, so
		// it is absent from both answers rather than counted as either.
		expect(await ids('site=none')).toEqual(['sine-bare']);
	});

	it('combines filters rather than letting the last one win', async () => {
		await seed();
		expect(await ids('source=sine-iitb&site=has')).toEqual(['sine-sited']);
		expect(await ids('source=sine-iitb&site=has&sector=4')).toEqual([]);
		expect(await ids('source=sine-iitb&site=none&q=bare')).toEqual(['sine-bare']);
	});

	it('sorts by what was asked for, and refuses what it does not know', async () => {
		await seed();
		// Fewest traces first. sine-sited and dpiit-unknown both have one and both went
		// on record today, so which of the two leads is a tie and not a fact — the
		// assertion is that the company with three traces comes last.
		const quietest = await ids('sort=quietest');
		expect(quietest).toHaveLength(3);
		expect(quietest[2]).toBe('sine-bare');
		expect(await ids('sort=name')).toEqual(['dpiit-unknown', 'sine-bare', 'sine-sited']);

		const res = await SELF.fetch(`${ORIGIN}/upstream/api/companies?sort=; DROP TABLE companies`);
		expect(res.status).toBe(400);
		// And the table is still there.
		expect((await (await SELF.fetch(`${ORIGIN}/upstream/api/coverage`)).json<any>()).total_companies).toBe(3);
	});

	it('rejects a source or a site state nobody defined', async () => {
		expect((await SELF.fetch(`${ORIGIN}/upstream/api/companies?source=linkedin`)).status).toBe(400);
		expect((await SELF.fetch(`${ORIGIN}/upstream/api/companies?site=maybe`)).status).toBe(400);
	});

	it('carries every filter into every link, so none of them is silently dropped', async () => {
		await seed();
		const html = await (await SELF.fetch(`${ORIGIN}/upstream?q=bare&source=sine-iitb&site=none&sort=name&tier=all&age=all`)).text();

		// A coverage cell keeps the search, the source, the website state and the sort.
		const cell = html.slice(html.indexOf('class="cell '), html.indexOf('</a>', html.indexOf('class="cell ')));
		for (const part of ['q=bare', 'source=sine-iitb', 'site=none', 'sort=name']) {
			expect(cell).toContain(part);
		}

		// The CSV button offers the view on screen, not the whole database.
		expect(html).toMatch(/href="\/upstream\/export\.csv\?q=bare&amp;source=sine-iitb&amp;site=none&amp;sort=name[^"]*"/);
		// Every filter is its own chip, and each chip's link removes that filter and no other.
		const chipsHtml = html.slice(html.indexOf('id="chips"'), html.indexOf('</ul>', html.indexOf('id="chips"')));
		for (const label of ['Search: “bare”', 'Found by: SINE IIT Bombay', 'Website: no website', 'Tier: Everything', 'Started: every year']) {
			expect(chipsHtml).toContain(label);
		}
		const searchChip = chipsHtml.match(/<a class="chip filter-chip" href="([^"]+)" aria-label="Remove Search/)![1].replace(/&amp;/g, '&');
		expect(searchChip).not.toContain('q=');
		for (const part of ['source=sine-iitb', 'site=none', 'sort=name', 'tier=all', 'age=all']) expect(searchChip).toContain(part);
		expect(chipsHtml).toContain('Remove all 5');
	});

	it('states one spelling of the view as canonical', async () => {
		await seed();
		const html = await (await SELF.fetch(`${ORIGIN}/upstream?sort=obscurity&age=recent&q=bare`)).text();
		// sort and age are at their defaults and drop out; the search does not.
		expect(html).toContain('<link rel="canonical" href="/upstream?q=bare">');
	});

	it('shows only the section that was asked for', async () => {
		await post({ source: 'test', mode: 'live', companies: [{ id: 'dated', name: 'Dated Co', origin_year: THIS_YEAR }] });
		await post({ source: 'test', companies: [{ id: 'no-date', name: 'Undated Co' }] });

		const dated = await (await SELF.fetch(`${ORIGIN}/upstream?dates=dated&tier=all&age=all`)).text();
		expect(dated).toContain('Dated Co');
		expect(dated).not.toContain('Undated Co');

		const undated = await (await SELF.fetch(`${ORIGIN}/upstream?dates=undated&tier=all&age=all`)).text();
		expect(undated).toContain('Undated Co');
		expect(undated).not.toContain('Dated Co');
	});

	it('exports the view on screen as a spreadsheet that cannot run formulas', async () => {
		await seed();
		const res = await SELF.fetch(`${ORIGIN}/upstream/export.csv?source=sine-iitb&site=has&age=all&tier=all`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('text/csv');
		expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="upstream-\d{4}-\d{2}-\d{2}\.csv"/);

		// A BOM, or Excel reads scraped names as mojibake. Asserted on the bytes rather
		// than on the decoded text, because Response.text() strips a leading U+FEFF and
		// would report it missing when it is on the wire.
		const bytes = new Uint8Array(await res.clone().arrayBuffer());
		expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

		const csv = await res.text();
		expect(csv).toContain('"name","builds","builds_from"');
		// Nothing HTML-escaped reaches a spreadsheet: this file is not a web page, and
		// an &amp; or an &apos; in a cell is a bug a reader would have to undo by hand.
		expect(csv).not.toMatch(/&[a-z]+;|&#\d+;/);
		expect(csv).toContain('"Sine Sited Co"');
		// The filters applied: the bare one is excluded by site=has.
		expect(csv).not.toContain('Sine Bare Co');
		// A link back, because a spreadsheet cannot follow one it does not have.
		expect(csv).toContain('/upstream/c/sine-sited');
		expect(csv.split('\r\n').filter(Boolean)).toHaveLength(2);
	});

	it('exports both lists when both are on screen', async () => {
		await post({ source: 'test', mode: 'live', companies: [{ id: 'dated', name: 'Dated Co', origin_year: THIS_YEAR }] });
		await post({ source: 'test', companies: [{ id: 'no-date', name: 'Undated Co' }] });

		// The page is two lists. A file that claims to be this view and silently drops
		// the second one is the quiet gap this whole project refuses to leave.
		const both = await (await SELF.fetch(`${ORIGIN}/upstream/export.csv?tier=all&age=all`)).text();
		expect(both).toContain('Dated Co');
		expect(both).toContain('Undated Co');

		// And asking for one section gives one section.
		const onlyDated = await (await SELF.fetch(`${ORIGIN}/upstream/export.csv?tier=all&age=all&dates=dated`)).text();
		expect(onlyDated).toContain('Dated Co');
		expect(onlyDated).not.toContain('Undated Co');

		const onlyUndated = await (await SELF.fetch(`${ORIGIN}/upstream/export.csv?tier=all&age=all&dates=undated`)).text();
		expect(onlyUndated).toContain('Undated Co');
		expect(onlyUndated).not.toContain('Dated Co');
	});

	it('defangs a scraped name that a spreadsheet would run as a formula', async () => {
		await post({
			source: 'test',
			mode: 'live',
			companies: [{ id: 'formula', name: '=HYPERLINK("http://evil.example")', description: 'has a "quote" in it', origin_year: THIS_YEAR }],
		});

		const csv = await (await SELF.fetch(`${ORIGIN}/upstream/export.csv?age=all&tier=all`)).text();
		// Prefixed with an apostrophe, so Excel shows the text instead of calling out.
		expect(csv).toContain('"\'=HYPERLINK(""http://evil.example"")"');
		expect(csv).toContain('"has a ""quote"" in it"');
	});

	it('gives each sunrise sector a glyph, hidden from anything that reads aloud', async () => {
		const html = await (await SELF.fetch(`${ORIGIN}/upstream`)).text();
		expect(html.match(/class="sector-icon"/g)).toHaveLength(5);
		// The sector name is already text beside it; announcing the drawing too would
		// be describing the decoration.
		expect(html).toMatch(/class="sector-icon"[^>]*aria-hidden="true"/);
	});
});

describe('lists that only one file is allowed to own', () => {
	it('keeps every trace type inside the accepted vocabulary', () => {
		// TRACE_TYPES is a subset of SIGNAL_TYPES by construction; this fails if
		// someone ever rewrites it as a second hand-maintained list.
		for (const type of TRACE_TYPES) {
			expect(SIGNAL_TYPES as readonly string[]).toContain(type);
		}
	});

	it('keeps the one gap-label name that Python writes and TypeScript reads', () => {
		// ingest/gaps.py owns this vocabulary and src/db.ts splits the page on it.
		// If a --regroup ever renames the group, gap-labels.json stops containing
		// it and this fails — instead of the page silently presenting 147 thin
		// descriptions as holes in the RDI taxonomy.
		const groups = new Set(Object.values(gapLabels as Record<string, string>));
		expect(groups).toContain(NO_GAP_NAMED);
	});

	it('only uses sub-sector ids the taxonomy actually has', () => {
		// The sample rows carry hand-written ids. A taxonomy edit that orphaned one
		// would show as "Not yet classified" on the demo page and nowhere else.
		const valid = new Set(SUBSECTORS.map((s) => s.subsector_id));
		for (const company of demoCompanies()) {
			if (company.subsector_id) expect(valid).toContain(company.subsector_id);
		}
	});
});
