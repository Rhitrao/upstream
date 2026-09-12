import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

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
		expect(rows.results).toEqual([{ first_seen_basis: null, n: 1 }, { first_seen_basis: 'cohort', n: 2 }]);
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

describe('GET /upstream (the page)', () => {
	async function page(qs = '') {
		const res = await SELF.fetch(`${ORIGIN}/upstream${qs}`);
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
		expect(html).toContain('Sub-sectors covered');
		expect(html).toContain('>0<span class="of">/44</span>');
	});

	it('fills a cell once a company lands in it, and keeps the other 43', async () => {
		await post({
			source: 'test',
			companies: [{ id: 'verve', name: 'Verve', sector_id: '2', subsector_id: '2.5' }],
		});
		const html = await page();
		const cells = html.match(/class="cell [^"]*"/g) ?? [];
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
		expect(demo.match(/<li class="company" id="c-[^"]+">/g)).toHaveLength(6);
		expect(demo).toContain('Verve Aerospace Private Limited');
		expect(demo).toContain('Pravaha Filtration Private Limited');
		expect(demo).not.toContain('Saral Hydro Systems Private Limited');
		expect(demo).toContain('held back');
		// The four-word lesson in how the ranking works.
		expect(demo).toContain('no website yet');
		expect(demo).toContain('RDI 2.5 &mdash; Space Technologies');
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

	it('anchors every row by slug so one can be linked to', async () => {
		await post({ source: 'test', mode: 'live', companies: [{ id: 'hexcarb-advanced-materials', name: 'Hexcarb' }] });
		expect(await page('?tier=all')).toContain('<li class="company" id="c-hexcarb-advanced-materials">');
	});

	it('only marks "no website yet" where a source actually looked', async () => {
		await post({
			source: 'test',
			mode: 'live',
			companies: [
				{ id: 'looked', name: 'Looked At Co' },
				{ id: 'register', name: 'Register Only Co', website_checked: false },
			],
		});

		const html = await page('?tier=all');
		const looked = html.slice(html.indexOf('Looked At Co'), html.indexOf('Register Only Co'));
		expect(looked).toContain('no website yet');
		expect(html.slice(html.indexOf('Register Only Co'))).not.toContain('no website yet');
	});

	it('lets one source that looked settle it for the others', async () => {
		await post({ source: 'dpiit', companies: [{ id: 'shared', name: 'Shared Co', website_checked: false }] });
		await post({ source: 'sine', companies: [{ id: 'shared', name: 'Shared Co' }] });

		const row = await env.DB.prepare('SELECT website_checked FROM companies WHERE id = ?').bind('shared').first<any>();
		expect(row.website_checked).toBe(1);
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
		expect(html).toContain('Off the map');
		expect(html).toContain('water infrastructure');
		expect(html).toContain('Botsrule Ltd');
		// The count is the companies, not the groups.
		expect(html).toContain('<h2 id="off-map-h">Off the map <span class="count">2</span></h2>');
	});

	it('says nothing about the map having holes when it has none', async () => {
		expect(await page()).not.toContain('id="off-map"');
	});

	it('defaults the tier toggle to A+B and honours the other choices', async () => {
		await post({ source: 'live-source', mode: 'live', companies: [{ id: 'found', name: 'Found Co' }] });

		expect(await page()).toContain('<label class="seg on" title="The default view"');
		expect(await page()).toContain('value="ab" checked');
		expect(await page('?tier=a')).toContain('<label class="seg on" title="New and quiet">');
		expect(await page('?tier=all')).toContain('<label class="seg on" title="Including known territory">');
	});

	it('opens on everything while every row is a backfill, and says why', async () => {
		await post({ source: 'archive', companies: [{ id: 'backfilled', name: 'Backfilled Co', origin_year: THIS_YEAR }] });

		const html = await page();
		// A+B would be empty by construction here, so the default widens.
		expect(html).toContain('value="all" checked');
		expect(html).toContain('Every company here arrived in a backfill');
		expect(html).toContain('Backfilled Co');

		// The explanation belongs to the state, not the toggle: it stands on A too.
		expect(await page('?tier=a')).toContain('Every company here arrived in a backfill');

		// One live discovery and the default narrows again, with nothing left to explain.
		await post({ source: 'live-source', mode: 'live', companies: [{ id: 'found', name: 'Found Co' }] });
		const after = await page();
		expect(after).toContain('value="ab" checked');
		expect(after).not.toContain('Every company here arrived in a backfill');
		expect(after).toContain('Found Co');
		expect(after).not.toContain('Backfilled Co');
	});

	it('keeps an explicit tier choice when the default is something else', async () => {
		await post({ source: 'archive', companies: [{ id: 'backfilled', name: 'Backfilled Co', origin_year: THIS_YEAR }] });

		// Default is 'all' here, so a chosen 'ab' has to survive a coverage-cell click.
		const html = await page('?tier=ab');
		expect(html).toContain('value="ab" checked');
		expect(html).toMatch(/href="[^"]*tier=ab[^"]*"[^>]*>\s*<span class="cell-id">/);
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
		// Nothing to link to, so the chip stays plain text.
		expect(html).toContain('<span class="chip">click &quot;me&quot;</span>');
	});
});
