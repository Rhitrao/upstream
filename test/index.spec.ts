import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import { describe, it, expect, beforeEach } from 'vitest';
import { SIGNAL_TYPES, TRACE_TYPES } from '../src/rank';
import { NO_GAP_NAMED } from '../src/db';
import gapLabels from '../ingest/gap-labels.json';
import { SUBSECTORS } from '../src/taxonomy';
import { demoCompanies } from '../src/demo';
import { SNAPSHOT } from '../src/snapshot';
import { LAYOUT_VERSION } from '../src/edgecache';

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
		env.DB.prepare('DELETE FROM company_enrichment'),
		env.DB.prepare('DELETE FROM enrichment_meta'),
	]);
}

function widgetText(html: string, id: string) {
	const at = html.indexOf(`aria-labelledby="${id}"`);
	return html.slice(at, html.indexOf('</div>', html.indexOf('class="widget-meta"', at)));
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


/**
 * Every record, described or not, company or not. The page opens on the companies a
 * sentence describes; tests about something else ask for all of them, so their seeds
 * need not carry descriptions to be seen.
 */
function every(qs = ''): string {
	const all = 'described=all&kind=all';
	if (!qs) return `?${all}`;
	if (qs.startsWith('/')) return qs.includes('?') ? `${qs}&${all}` : `${qs}?${all}`;
	return qs.startsWith('?') ? `${qs}&${all}` : `?${qs}&${all}`;
}

/** The coverage and methodology page, where the list's reference half now lives. */
async function about(): Promise<string> {
	const res = await SELF.fetch(`${ORIGIN}/upstream/about`);
	expect(res.status).toBe(200);
	return res.text();
}

/** A page as a reader sees it: the briefs rows carry for copying are inert until copied. */
function visible(html: string): string {
	return html.replace(/<template class="brief">[\s\S]*?<\/template>/g, '');
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
		expect(row.first_seen).toBe('2022');
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
		expect(rows.results).toEqual([{ id: 'cancrie', first_seen: '2021', trace_count: 1 }]);
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
			{ id: 'backfilled', first_seen: `${THIS_YEAR}`, first_seen_basis: 'cohort', tier: expect.stringMatching(/B|C/) },
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
		expect(row.first_seen).toBe('2023');
		expect(row.first_seen_basis).toBe('cohort');

		await post({ source: 'grants', companies: [{ id: 'shared', name: 'Shared Co', origin_year: 2025 }] });
		row = await env.DB.prepare('SELECT * FROM companies WHERE id = ?').bind('shared').first<any>();
		expect(row.first_seen).toBe('2023');
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
		expect(detail).toContain('but nothing ties the address to');
		// Named once, in the sentence explaining why it is not theirs, and never as a link
		// in the header where it would read as their site.
		expect(detail.match(/href="http:\/\/hyperverge\.co\/"/g)).toHaveLength(1); // only in that sentence
		// The unknowns and the brief name it too, and only to say it is not theirs.
		expect(detail).toContain('Its website</strong>: a source gave hyperverge.co, and nothing ties that address to the company');
		expect(detail).toContain('http://hyperverge.co/ was given for it, and nothing ties it to them, so it is not used');
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
		const html = await (await SELF.fetch(`${ORIGIN}/upstream?age=all&tier=all&described=all&kind=all`)).text();
		const start = html.indexOf('id="c-edsix"');
		const row = html.slice(start, html.indexOf('</li>', start));
		// A hedge about our process is not a fact about the company: the row does not link an
		// address nobody confirmed, and the company's page says why.
		expect(row).not.toContain('href="http://skillangels.com/"');
		expect(await (await SELF.fetch(`${ORIGIN}/upstream/c/edsix`)).text()).toContain('not confirmed as theirs');
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
		expect(visible(html)).not.toContain('Diagnostics company.');
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
		expect(visible(html)).not.toContain('Industry: Nanotechnology');
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
				// Looked for, and there is none: an absence in the record, not a sign either way.
				{ id: 'f', name: 'F', sector_id: '5', subsector_id: '5.1' },
			],
		});

		const html = await about();
		expect(html).toMatch(/Of the 6 companies here, 5 publish a website, and <strong>1<\/strong> of them say plainly enough what they build/);
		expect(html).toMatch(/<strong>1<\/strong> publish an address that no longer answers/);
		expect(html).toMatch(/<strong>1<\/strong> refused an automated reader/);
		expect(html).toMatch(/<strong>1<\/strong> served a page with no readable text/);
		expect(html).toMatch(/<strong>1<\/strong> never said what they make/);
		expect(html).toMatch(/<strong>1<\/strong> have no website listed/);
		expect(html).not.toContain('counts in their favour');
	});
});

describe('GET /upstream (the page)', () => {
	async function page(qs = '') {
		const res = await SELF.fetch(`${ORIGIN}/upstream${every(qs)}`);
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
		// The caption counts what is there, from the data; empty cells stay dashed and say so on hover.
		expect(html).toContain('0 of the government&#39;s 44 R&amp;D sub-sectors have at least one company here. Click any cell to see its companies.');
		expect(html).toContain('title="1.1 Advanced Wind Energy Systems: No company found in these sources yet."');
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
		expect(plain).toContain('Nothing here yet');

		const demo = await page('?demo=1');
		expect(demo).toContain('Sample data');
		// Every sample row, the older one too, with a badge saying when it started.
		expect(demo.match(/<li class="company [^"]*" id="c-[^"]+"/g)).toHaveLength(7);
		expect(demo).toContain('Verve Aerospace Private Limited');
		expect(demo).toContain('Pravaha Filtration Private Limited');
		expect(demo).toContain('Saral Hydro Systems Private Limited');
		expect(demo).toMatch(/<span class="badge">started \d{4}<\/span>/);
		// The five-year toggle still holds it back.
		expect(await page('?demo=1&age=recent')).not.toContain('Saral Hydro Systems Private Limited');
		// Who has noticed a company, named on its row; the sub-sector is chosen from the map.
		expect(demo).toMatch(/<p class="trail evidence-row"><span class="f-listed">Listed by /);
	});

	it('lists an undated company after a dated one with as few references, in the same list', async () => {
		await post({ source: 'rtbi', companies: [{ id: 'undated', name: 'Undated Co' }] });
		await post({ source: 'live-source', mode: 'live', companies: [{ id: 'found', name: 'Found Co' }] });

		const html = await page();
		// One list, one numbering: no section of its own for the undated.
		expect(html).not.toContain('id="undated-h"');
		const list = html.slice(html.indexOf('id="list"'), html.indexOf('</section>', html.indexOf('id="list"')));
		expect(list).toContain('Undated Co');
		expect(list.indexOf('id="c-found"')).toBeLessThan(list.indexOf('id="c-undated"'));
		expect(list).toContain('no source dates it');
	});

	it('filters by keyword tags, says they are keywords, and refuses a tag outside the vocabulary', async () => {
		await post({
			source: 'sine-iitb',
			companies: [
				{ id: 'drone-co', name: 'Drone Co', description: 'Agricultural drones for crop spraying.', sector_id: '2', subsector_id: '2.7', build_tags: ['hardware'], domain_tags: ['agriculture & food', 'space & aerospace'] },
				{ id: 'ledger-co', name: 'Ledger Co', description: 'A blockchain document locker.', sector_id: '5', subsector_id: '5.1', build_tags: ['software'], domain_tags: [] },
				{ id: 'quiet-co', name: 'Quiet Co', description: 'Superposition, thoughtfully.', sector_id: '2', subsector_id: '2.1', build_tags: [], domain_tags: [] },
			],
		});
		const hardware = await page('?tier=all&age=all&build=hardware');
		expect(hardware).toContain('id="c-drone-co"');
		expect(hardware).not.toContain('id="c-ledger-co"');
		expect(hardware).toContain('Technology type: hardware');
		const farms = await page('?tier=all&age=all&domain=agriculture+%26+food');
		expect(farms).toContain('id="c-drone-co"');
		expect(farms).not.toContain('id="c-quiet-co"');
		// An unknown tag is ignored rather than filtering to an empty list that looks like no matches.
		expect(await page('?tier=all&age=all&build=spaceships')).toContain('id="c-ledger-co"');

		const detail1 = await detail('drone-co');
		expect(detail1).toContain('Keywords: builds <a href="/upstream?build=hardware#list">hardware</a>; used in');
		expect(detail1).toContain('These are matched on words in its description. Nobody has checked them.');
		expect(await detail('quiet-co')).toContain('Keywords: none.');

		const csv = await (await SELF.fetch(`${ORIGIN}/upstream/export.csv?tier=all&age=all&build=hardware`)).text();
		expect(csv).toContain('"hardware","agriculture & food; space & aerospace"');

		const refused = await post({ source: 'sine-iitb', companies: [{ id: 'x', name: 'X', build_tags: ['spaceships'] }] });
		expect(refused.status).toBe(400);
		expect(await refused.text()).toContain('build_tags must be a list drawn from');
	});

	it('calls a grant list category a label, not a description, and says whose label it is', async () => {
		await post({
			source: 'grants-csv',
			mode: 'live',
			companies: [
				{
					id: 'dverse',
					name: 'Dverse Technologies Private Limited',
					description: 'BIRAC Biotechnology Ignition Grant awardee, category: Medical Devices.',
					description_source: 'grants-csv',
					sector_id: '4',
					subsector_id: '4.5',
					classify_basis: 'register-label',
				},
			],
		});
		const list = await page('?tier=all&age=all&described=all&kind=all');
		const row = list.slice(list.indexOf('id="c-dverse"'), list.indexOf('</li>', list.indexOf('id="c-dverse"')));
		expect(row).toContain('No description published');
		// The basis is process, so it is on the company's page, not the row.
		expect(row).not.toContain('grant category only');
		const html = await detail('dverse');
		expect(html).toContain('This is the category the grant list filed the award under, one of six. It doesn&#39;t describe the company.');
		expect(html).toContain('the category a grant list filed its award under, one of six. That supports this sub-sector and nothing narrower.');
		// Counted with the labels, not with the companies that say what they build.
		expect(await page('?tier=all&age=all&described=said&kind=all')).not.toContain('id="c-dverse"');
		expect(await page('?tier=all&age=all&described=label&kind=all')).toContain('id="c-dverse"');

		// And a label arriving later never replaces a real description.
		await post({ source: 'sine-iitb', companies: [{ id: 'dverse', name: 'Dverse Technologies Private Limited', description: 'Portable neonatal warmers for district hospitals.', description_source: 'sine-iitb' }] });
		await post({ source: 'grants-csv', companies: [{ id: 'dverse', name: 'Dverse Technologies Private Limited', description: 'BIRAC Biotechnology Ignition Grant awardee, category: Medical Devices.', description_source: 'grants-csv' }] });
		expect(await detail('dverse')).toContain('Portable neonatal warmers for district hospitals.');
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

		// Not on the row: how a placement was made is about our process, a click away.
		const list = await page('?tier=all&age=all');
		const rowOf = (id: string) => list.slice(list.indexOf(`id="c-${id}"`), list.indexOf('</li>', list.indexOf(`id="c-${id}"`)));
		expect(rowOf('from-label')).not.toContain('register label only');

		// The order says what it selects for and admits it has never been tested against outcomes.
		// Losing this sentence would turn a description back into a recommendation.
		expect(await about()).toContain('<strong>The ranking hasn&#39;t been tested against outcomes.</strong>');
		expect(await about()).not.toContain('Read these first');
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
		expect(visible(row)).not.toContain('Industry: Nanotechnology');
		expect(await detail('relsym')).toContain('They don&#39;t describe the company.');
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
		// The row names who has noticed a company; a website is one of them only when it is theirs
		// and answered. Neither row claims a website it does not have.
		expect(row('looked')).not.toContain('own website');
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
		// Age with its basis, the source's date; when we collected it is not on the row.
		expect(row).toContain('on DPIIT register Aug 2023');
		expect(row).not.toContain('added to Upstream');
		const method = await about();
		expect(method).toContain('2 companies turned up in the last seven days in sources already being read.');
		// Each row's "added to Upstream" is the day it was written; the headline is not that count.
		expect(method).not.toContain('added to Upstream in the last seven days');
		// And the row's date says what it is, never a founding date.
		expect(html).toContain('The date on each row is the date the source gives for its own record, such as an incubator listing or a grant.');

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
			{ id: 'founded', first_seen: `${THIS_YEAR}`, origin_year: THIS_YEAR },
			{ id: 'registered', first_seen: `${THIS_YEAR}`, origin_year: null },
		]);

		const html = await page('?tier=all&age=recent');
		expect(html).toContain('dated only by a public register, which gives the date of its own record and not when the company started');
		expect(await detail('registered')).toContain('founding year unknown');
	});

	it('does not let a register date stand in for a founding year at the gate', async () => {
		await post({
			source: 'dpiit',
			companies: [{ id: 'registered', name: 'Registered Co', record_year: THIS_YEAR }],
		});

		// Unknown age is not old age: it stays listed, exactly as an undated company
		// stays visible, and the page carries the caveat instead.
		expect(await page('?tier=all&age=recent')).toContain('Registered Co');
		expect(await page('?tier=all&age=recent')).not.toContain('started more than 5 years ago');
	});

	it('holds back companies that started more than five years ago, and says so', async () => {
		await post({
			source: 'archive',
			companies: [
				{ id: 'recent', name: 'Recent Co', origin_year: THIS_YEAR },
				{ id: 'ancient', name: 'Ancient Co', origin_year: THIS_YEAR - 9 },
			],
		});

		// Listed by default, with a badge saying when it started.
		const everything = await page('?tier=all');
		expect(everything).toContain('Ancient Co');
		expect(everything).toContain(`<span class="badge">started ${THIS_YEAR - 9}</span>`);
		expect(everything).not.toContain('started more than 5 years ago');
		// An old link that lifted the gate still shows it.
		expect(await page('?tier=all&age=all')).toContain('Ancient Co');

		// The toggle holds it back, and says how many it holds back.
		const html = await page('?tier=all&age=recent');
		expect(html).toContain('Recent Co');
		expect(html).not.toContain('Ancient Co');
		expect(html).toContain('started more than 5 years ago');
		expect(html).toContain('<input type="checkbox" name="age" value="recent" checked>');
	});

	it('gives the off-map companies a section of their own', async () => {
		await post({
			source: 'test',
			gaps: [
				{ company_id: 'botsrule', name: 'Botsrule Ltd', missing: 'water infrastructure', note: 'No cell covers water distribution.' },
				{ company_id: 'ajivam', name: 'Ajivam Ltd', missing: 'water infrastructure', note: 'No cell covers water pressurisation.' },
			],
		});

		const html = await about();
		expect(html).toContain('id="off-map"');
		expect(html).toContain('water infrastructure');
		// The count is the companies, not the groups.
		expect(html).toContain('2 records fall here and are not on the list.');
		// The groups and their names are still served, for anyone checking the count.
		const gaps = await (await SELF.fetch(`${ORIGIN}/upstream/api/gaps`)).json<any>();
		expect(JSON.stringify(gaps)).toContain('Botsrule Ltd');
		// Nothing here was a description failure.
		expect(html).toContain('Of the rest, 0 were described too thinly to place, and 2 describe work the scheme has no sub-sector for.');
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

		const html = await about();
		// Two findings, two counts, and the counts do not overlap: the two we could not read are
		// not claimed as a hole in the scheme.
		expect(html).toContain('Of the rest, 2 were described too thinly to place, and 1 describes work the scheme has no sub-sector for.');
		expect(html).toContain('1 record falls here and is not on the list.');
	});

	it('says nothing about the map having holes when it has none', async () => {
		const html = await about();
		expect(html).not.toContain('records fall here');
		expect(html).not.toContain('Of the rest,');
	});

	it('defaults the tier toggle to everything and honours the other choices', async () => {
		await post({ source: 'live-source', mode: 'live', companies: [{ id: 'found', name: 'Found Co' }] });

		// Every company a reader can form a view on, not the few a tier rule promotes.
		expect(await page()).toContain('<option value="all" selected>Any</option>');
		expect(await page('?tier=a')).toContain('<option value="a" selected>A only</option>');
		expect(await page('?tier=ab')).toContain('<option value="ab" selected>A + B</option>');
		// A tier other than the default is a filter, and says so as a chip.
		expect(await page('?tier=a')).toContain('Rank tier: A only');
		expect(await page()).not.toContain('Rank tier: Any');
	});

	it('opens on every tier, backfill or not, with nothing to explain', async () => {
		await post({ source: 'archive', companies: [{ id: 'backfilled', name: 'Backfilled Co', origin_year: THIS_YEAR }] });
		const html = await page();
		expect(html).toContain('<option value="all" selected>');
		expect(html).not.toContain('Too few companies here qualify for Tier A or B today');
		expect(html).toContain('Backfilled Co');

		await post({ source: 'live-source', mode: 'live', companies: [{ id: 'found', name: 'Found Co' }] });
		const after = await page();
		expect(after).toContain('<option value="all" selected>');
		expect(after).toContain('Found Co');
		expect(after).toContain('Backfilled Co');
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
		expect(html).toContain('Spaceock');
		expect(await detail('spaceock')).toContain("is a register's dropdown label");

		// The same company, once something describes it, is a find again.
		await post({ source: 'venture-center', companies: [{ id: 'spaceock', name: 'Spaceock', sector_id: '2', subsector_id: '2.5', classify_basis: 'description' }] });
		const tier = await env.DB.prepare('SELECT tier FROM companies WHERE id = ?').bind('spaceock').first<any>();
		expect(tier.tier).toBe('A');
		// Its page says why in words, not a letter; the row carries no tier at all.
		expect(await detail('spaceock')).toContain('Recently on record, fewest references (Tier A)');
	});

	it('opens on everything when the only B row is one the age gate holds back', async () => {
		await post({ source: 'archive', companies: [{ id: 'backfilled', name: 'Backfilled Co', origin_year: THIS_YEAR }] });
		// Found live today, but started long ago: Tier B, and outside the default list.
		await post({ source: 'live-source', mode: 'live', companies: [{ id: 'veteran', name: 'Veteran Co', origin_year: 2009 }] });
		const tier = await env.DB.prepare('SELECT tier FROM companies WHERE id = ?').bind('veteran').first<any>();
		expect(tier.tier).toBe('B');

		const html = await page();
		expect(html).toContain('<option value="all" selected>');
		expect(html).toContain('Backfilled Co');
	});

	it('states the whole funnel on the methodology page, not above the proposition', async () => {
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

		const html = await about();
		// Both ends of the funnel, in full, and the share placed computed from them.
		expect(html).toContain('Of the 5 records read so far, it placed 2 (40%).');
		// The drop is stated, and split by whose fault it is: the taxonomy gap is claimed only
		// for the companies that actually are one.
		expect(html).toContain('Of the rest, 0 were described too thinly to place, and 3 describe work the scheme has no sub-sector for.');

		// And the arithmetic is not in front of the list: a stranger meets the proposition and
		// the search; the pipeline's accounting of itself is one link away.
		const home = await page('');
		expect(home).not.toContain('records read so far');
		expect(home).toContain('<a href="/upstream/about">How the data is collected &rarr;</a>');
		expect(html).not.toContain('Companies found');
		expect(html).not.toContain('Placed on the map');
	});

	it('opens on every record, described first, and says so in About these results', async () => {
		await post({
			source: 'test',
			companies: [
				// Two described companies with one trace apiece, one with three: the headline
				// counts the described ones, and the quiet ones among them.
				{ id: 'quiet-one', name: 'Quiet One', description: 'Solid-state battery cells.', sector_id: '5', subsector_id: '5.1', state: 'Karnataka' },
				{ id: 'quiet-two', name: 'Quiet Two', description: 'Satellite radar payloads.', sector_id: '5', subsector_id: '5.1' },
				{ id: 'noticed', name: 'Noticed Co', description: 'Drone autopilots.', sector_id: '5', subsector_id: '5.2' },
				// Not in the headline: a name and a register label, and a described project.
				{ id: 'label-only', name: 'Label Only', description: 'DPIIT-recognised startup. Industry: AI. Stage: Prototype.', sector_id: '5', subsector_id: '5.1' },
				{ id: 'a-project', name: 'A Project', description: 'Protein from oil cake.', sector_id: '5', subsector_id: '5.1', entity_type: 'researcher-project' },
			],
			signals: [
				{ company_id: 'quiet-one', type: 'incubator', label: 'One cohort' },
				{ company_id: 'quiet-two', type: 'incubator', label: 'One cohort' },
				{ company_id: 'noticed', type: 'incubator', label: 'One cohort' },
				{ company_id: 'noticed', type: 'website', label: 'Has a site' },
				{ company_id: 'noticed', type: 'press', label: 'Written about' },
				{ company_id: 'label-only', type: 'dpiit', label: 'Startup India profile, not DPIIT recognised' },
				{ company_id: 'a-project', type: 'incubator', label: 'One cohort' },
			],
		});

		const res = await SELF.fetch(`${ORIGIN}/upstream`);
		const html = await res.text();
		expect(html).toContain('<p class="eyebrow">Deep-tech sourcing for investors</p>');
		// What the list is, and why it is ordered the other way round, before any number.
		expect(html).toContain('<h1>Go upstream of the funding news.</h1>');
		expect(html).toContain('<p class="hero-sub">Startups show up in public records before they show up in the news.</p>');
		const lede = html.slice(html.indexOf('class="lede"'), html.indexOf('</div>', html.indexOf('class="lede"')));
		// The source count is live, as a word, and the sub-sector count comes from the taxonomy.
		expect(lede).toContain('Upstream reads eight of these sources every day, sorts each company into the government&#39;s 44 R&amp;D sub-sectors, and shows the least-known ones first.');
		expect(lede).toContain('Most investors find early companies the same way &mdash; funding news, demo days, warm introductions &mdash; so by the time a startup shows up there, every fund has already seen it.');
		expect(lede).toContain('<strong class="hero-why">Why &quot;Upstream&quot;?</strong>');
		// Three steps, each linking where it says.
		const steps = html.slice(html.indexOf('class="hero-steps"'), html.indexOf('</ol>', html.indexOf('class="hero-steps"')));
		expect([...steps.matchAll(/<li>/g)]).toHaveLength(3);
		expect(steps).toContain('<a href="#coverage">Pick a sector in the map below.</a>');
		expect(steps).toContain('<a class="hero-shortlist" href="/upstream#list">');
		// The honest limit, in the hero: an order is not a verdict.
		expect(html).toContain('<p class="hero-note">The order shows where fewer people have looked. Whether a company is any good, you&#39;ll only learn by talking to the founder.</p>');
		expect(html).toContain('<title>Upstream: go upstream of the funding news</title>');
		expect(html).toContain('<meta name="description" content="Indian deep-tech startups found in incubator, grant and startup-register records, least-known first.">');
		// The status line under the hero is gone; source health is on the methodology page.
		expect(html).not.toContain('class="coverage-line"');
		expect(html).not.toContain('contributing, as of');
		// No sweeping claim about every other list.
		expect(html).not.toContain('Every other list');
		expect(html).toContain('Sorted by the fewest references collected from the sources Upstream monitors.');
		// No stats above the list: each number is a widget sentence that filters by it.
		expect(html).not.toContain('class="stats"');
		// Every record by default.
		expect(html).toContain('<p class="result-line"><strong>5</strong> records match');
		// The breakdown under the masthead, then the search, then the results.
		expect(html.indexOf('</header>')).toBeLessThan(html.indexOf('id="coverage"'));
		expect(html.indexOf('id="coverage"')).toBeLessThan(html.indexOf('id="q"'));
		expect(html.indexOf('id="q"')).toBeLessThan(html.indexOf('id="list"'));

		// Described records first, fewest references first among them; the name-only record after.
		const rows = [...html.matchAll(/<li class="company [^"]*" id="c-([^"]+)"/g)].map((m) => m[1]);
		expect(rows.slice(0, 3).sort()).toEqual(['a-project', 'quiet-one', 'quiet-two']);
		expect(rows.slice(3)).toEqual(['noticed', 'label-only']);
		// Each row the old default hid says why, in a badge.
		const rowOf = (id: string) => html.slice(html.indexOf(`id="c-${id}"`), html.indexOf('</li>', html.indexOf(`id="c-${id}"`)));
		expect(rowOf('a-project')).toContain('<span class="badge">research project</span>');
		expect(rowOf('label-only')).toContain('<span class="badge">name only</span>');
		expect(rowOf('quiet-one')).not.toContain('class="badge"');

		// "About these results", with its numbers from the data.
		const about = html.slice(html.indexOf('id="about-results"'), html.indexOf('</details>', html.indexOf('id="about-results"')));
		expect(about).toContain(
			'Showing all 5 records. 4 have a product description, from the company&#39;s own website or from the source that lists it. 1 is a name and a register entry only, listed after the rest. Use the filters above to narrow to companies started in the last five years, or to hide research projects and unverified names.',
		);
		expect(about).toContain('Within each group, records are ordered by how little is public about them: the fewest collected references first.');
		expect(about).toContain('It says nothing about how good the company is.');
		expect(about).toContain('Upstream reads eight public sources.');
		expect(about).toContain('Your shortlist and &quot;seen&quot; marks are saved in this browser only.');

		// The three toggles, all off.
		for (const [name, value] of [['age', 'recent'], ['kind', 'company'], ['described', 'said']]) {
			expect(html).toContain(`<input type="checkbox" name="${name}" value="${value}">`);
		}

		// The old default is two toggles away, and the file follows the view.
		const narrow = await (await SELF.fetch(`${ORIGIN}/upstream?described=said&kind=company`)).text();
		expect([...narrow.matchAll(/<li class="company [^"]*" id="c-([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(['noticed', 'quiet-one', 'quiet-two']);
		expect(narrow).toContain('<p class="result-line"><strong>3</strong> companies match');
		const line = narrow.slice(narrow.indexOf('<p class="result-parts"'), narrow.indexOf('</p>', narrow.indexOf('<p class="result-parts"')));
		expect(line).toMatch(/>2 left out by the toggles<\/a>/);
		expect(line).not.toContain('hidden by filters');
		const register = await (await SELF.fetch(`${ORIGIN}/upstream?described=unsaid`)).text();
		expect([...register.matchAll(/<li class="company [^"]*" id="c-([^"]+)"/g)].map((m) => m[1])).toEqual(['label-only']);
		const csv = await (await SELF.fetch(`${ORIGIN}/upstream/export.csv?described=said&kind=company`)).text();
		expect(csv).toContain('Quiet One');
		expect(csv).not.toContain('Label Only');
		expect(csv).not.toContain('A Project');
		const all = await (await SELF.fetch(`${ORIGIN}/upstream/export.csv`)).text();
		expect(all).toContain('Label Only');

		expect(html).not.toContain('discovered in the last seven days');
	});

	it('keeps the old findings links working after the findings left the methodology page', async () => {
		await post({
			source: 'dpiit-startup-india',
			companies: [
				{ id: 'profile-co', name: 'Profile Co', description: 'DPIIT-recognised startup. Industry: AI.', sector_id: '2', subsector_id: '2.7', dpiit_status: 'profile' },
				{ id: 'recognised-co', name: 'Recognised Co', description: 'DPIIT-recognised startup. Industry: Robotics.', sector_id: '2', subsector_id: '2.7', dpiit_status: 'recognised' },
			],
			signals: [
				{ company_id: 'profile-co', type: 'dpiit', label: 'Startup India profile, not DPIIT recognised' },
				{ company_id: 'recognised-co', type: 'dpiit', label: 'DPIIT recognised (DIPP1)' },
			],
			gaps: [{ company_id: 'thin-co', name: 'Thin Co', missing: 'no gap named', note: 'n', description: 'DPIIT-recognised startup. Industry: AI.' }],
		});
		await post({
			source: 'sine-iitb',
			companies: [{ id: 'described-co', name: 'Described Co', description: 'Graphene membranes.', sector_id: '1', subsector_id: '1.4' }],
			gaps: [{ company_id: 'ev-co', name: 'EV Co', missing: 'electric vehicle infrastructure', note: 'n', description: 'Charging for e-rickshaws.' }],
		});

		// The findings section left the methodology page when it was rebuilt; the list links it
		// pointed to still work.
		expect(await (await SELF.fetch(`${ORIGIN}/upstream`)).text()).not.toContain('<section class="findings"');
		expect(await about()).not.toContain('<section class="findings"');
		const profile = await (await SELF.fetch(`${ORIGIN}/upstream?tier=all&age=all&dpiit=profile&described=all&kind=all`)).text();
		expect([...profile.matchAll(/<li class="company [^"]*" id="c-([^"]+)"/g)].map((m) => m[1])).toEqual(['profile-co']);
		expect(profile).toContain('DPIIT: Startup India profile, not DPIIT recognised');
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

		const html = await about();
		// The unplaced are split by why, and never averaged into one figure.
		expect(html).toContain('Of the 3 records read so far, it placed 1 (33%).');
		expect(html).toContain('Of the rest, 1 was described too thinly to place, and 1 describes work the scheme has no sub-sector for.');
		expect(html).not.toContain('A national startup register');
		expect(html).not.toContain('holes in the RDI taxonomy');
		// And the old undivided claim is gone for good.
		expect(html).not.toContain('placed in no sub-sector at all');
	});

	it('leads with the breakdowns under the masthead, then the search and filters, then the list', async () => {
		await post({ source: 'archive', companies: [{ id: 'backfilled', name: 'Backfilled Co', origin_year: THIS_YEAR }] });
		const html = await page('');
		expect(html.indexOf('class="topnav"')).toBeLessThan(html.indexOf('</header>'));
		// The RDI map and three breakdowns sit directly under the hero, above the search.
		expect(html.indexOf('</header>')).toBeLessThan(html.indexOf('id="breakdown"'));
		expect(html.indexOf('id="breakdown"')).toBeLessThan(html.indexOf('id="coverage"'));
		for (const id of ['p-build', 'p-domain', 'p-sources']) expect(html.indexOf(`id="${id}"`)).toBeGreaterThan(html.indexOf('id="coverage"'));
		expect(html.indexOf('id="p-sources"')).toBeLessThan(html.indexOf('id="controls"'));
		expect(html.indexOf('id="controls"')).toBeLessThan(html.indexOf('id="list"'));
		// Always open: nothing in the breakdown folds, and the other panels are gone.
		const breakdown = html.slice(html.indexOf('id="breakdown"'), html.indexOf('id="controls"'));
		expect(breakdown).not.toContain('<details');
		expect(breakdown).not.toContain('<summary');
		for (const gone of ['id="widgets"', 'breakdown-fold', 'sector-fold', 'id="w-places"', 'id="w-programmes"', 'id="w-view"', 'id="w-traces"', 'india-map']) expect(html).not.toContain(gone);
		// A sector's name is still a filter.
		expect(html).toMatch(/<a class="sector-link" href="[^"]*sector=1[^"]*#list">/);
		// The reference half is not sent with the list; its old anchors are sent on to /about.
		expect(html).not.toContain('id="reference"');
		expect(html).toContain('location.replace("/upstream/about#"+h)');
		// No prose paragraph between the masthead and the list other than panel sentences.
		expect(html.slice(html.indexOf('</header>'), html.indexOf('id="list"'))).not.toContain('class="note"');
	});

	it('lays out the filters: search, a primary row, More filters, chips, then the count beside the sort', async () => {
		await post({ source: 'archive', companies: [{ id: 'backfilled', name: 'Backfilled Co', origin_year: THIS_YEAR }] });
		const html = await (await SELF.fetch(`${ORIGIN}/upstream`)).text();
		const form = html.slice(html.indexOf('<form class="controls"'), html.indexOf('</form>'));
		// Every control has a label, in sentence case, in this order.
		const primary = form.slice(form.indexOf('id="primary-filters"'), form.indexOf('id="more-filters"'));
		expect([...primary.matchAll(/<label for="([^"]+)">([^<]+)<\/label>/g)].map((m) => `${m[1]}:${m[2]}`)).toEqual([
			'sector:Sector',
			'subsector:Sub-sector',
			'build:Technology type',
			'domain:Application',
		]);
		expect(primary).toContain('matched on words in the description');
		// The three toggles, off, under the primary row and before More filters.
		const toggles = primary.slice(primary.indexOf('id="toggles"'));
		expect([...toggles.matchAll(/<input type="checkbox" name="([^"]+)" value="([^"]+)">/g)].map((m) => `${m[1]}=${m[2]}`)).toEqual(['age=recent', 'kind=company', 'described=said']);
		expect(toggles).toContain('Started in the last 5 years');
		expect(toggles).toContain('Companies only <span class="toggle-note">(hide research projects and unverified names)</span>');
		expect(toggles).toContain('Has a product description');
		const more = form.slice(form.indexOf('id="more-filters"'), form.indexOf('</details>'));
		expect([...more.matchAll(/<label for="([^"]+)">([^<]+)<\/label>/g)].map((m) => `${m[1]}:${m[2]}`)).toEqual([
			'source:Source',
			'site:Website',
			'traces:Collected references',
			'dates:Source date',
			'tier:Rank tier',
			'status:Status',
		]);
		// Closed with nothing in it chosen, and no count.
		expect(form).toContain('<details class="more-filters" id="more-filters">');
		expect(form).toContain('<summary>More filters<span class="filter-count" id="filter-count"></span></summary>');
		// "Any" is the unfiltered choice in every select.
		for (const id of ['sector', 'subsector', 'build', 'domain', 'source', 'site', 'traces']) {
			expect(form.match(new RegExp(`<select id="${id}"[^>]*><option value=""[^>]*>([^<]+)<`))?.[1], id).toBe('Any');
		}
		expect(form).toContain('<option value="both" selected>Any</option>');
		expect(form).toContain('<option value="all" selected>Any</option>');
		expect(form).not.toMatch(/All sectors|All sub-sectors|Any number|With or without|Any technology|Any source/);
		// Search on its own row, its clear button only when there is text, Apply only without script.
		expect(form).toContain('<label for="q">Find companies</label>');
		expect(form).toMatch(/<a class="search-clear" id="q-clear" href="[^"]*" aria-label="Clear search" hidden>/);
		expect(form).toContain('<noscript><div class="apply-row"><button type="submit" class="apply">Apply filters</button></div></noscript>');
		expect(form.replace(/<noscript>[\s\S]*?<\/noscript>/, '')).not.toContain('type="submit"');
		// The count on the left and the sort on the right, the sort still part of the form.
		const bar = html.slice(html.indexOf('class="results-bar"'), html.indexOf('class="bar-foot"'));
		expect(bar.indexOf('id="result-line"')).toBeLessThan(bar.indexOf('id="sort"'));
		expect(bar).toContain('<label for="sort">Sort</label>');
		expect(bar).toContain('<select id="sort" name="sort" form="controls">');
		// Chips sit above the results.
		expect(html.indexOf('id="chips"')).toBeLessThan(html.indexOf('class="results-bar"'));

		// A secondary filter opens More filters and is counted on it; with a search, the clear button shows.
		const filtered = await (await SELF.fetch(`${ORIGIN}/upstream?source=sine-iitb&site=has&q=backfilled`)).text();
		expect(filtered).toContain('<details class="more-filters" id="more-filters" open>');
		expect(filtered).toContain('More filters<span class="filter-count" id="filter-count"> (2)</span>');
		expect(filtered).toMatch(/<a class="search-clear" id="q-clear" href="\/upstream\?source=sine-iitb&amp;site=has#list" aria-label="Clear search">/);
		expect(filtered).toContain('<li><a class="clear" href="/upstream#list">Clear all</a></li>');
	});

	it('keeps sector and sub-sector in step, and never offers a pair that can only be empty', async () => {
		await post({ source: 'archive', companies: [{ id: 'drone-co', name: 'Drone Co', origin_year: THIS_YEAR, sector_id: '2', subsector_id: '2.7', description: 'Builds drones.' }] });
		// A sub-sector alone: the sector box names its sector, and the sub-sectors are that sector's only.
		const sub = await page('?subsector=2.7');
		const form = sub.slice(sub.indexOf('<form class="controls"'), sub.indexOf('</form>'));
		expect(form).toMatch(/<select id="sector" name="sector">[\s\S]*?<option value="2" selected>/);
		const subSelect = form.slice(form.indexOf('<select id="subsector"'), form.indexOf('</select>', form.indexOf('<select id="subsector"')));
		expect(subSelect).toContain('<option value="2.7" data-sector="2" selected>');
		expect(subSelect).not.toContain('data-sector="1"');
		expect(subSelect).not.toContain('<optgroup');
		// The map cell and the panel agree with the filter.
		expect(sub).toMatch(/<a class="cell filled active" href="[^"]*"[^>]*aria-current="true">\s*<span class="cell-head"><span class="cell-id">2\.7<\/span>/);
		expect(sub).toContain('Drone Co');
		// A sub-sector outside the chosen sector is read as the sub-sector alone, not as nothing.
		const clash = await page('?sector=1&subsector=2.7');
		expect(clash).toContain('Drone Co');
		expect(clash).not.toContain('Sector: ');
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
		// The default is every tier: the old row is listed, least traced first.
		expect(await page('?age=all')).toContain('Old Known');
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
		expect(html).toContain('SINE IIT Bombay incubatee, 2024-2025 (');
		expect(html).toMatch(/incubatee, 2024-2025 \([^,]+, no exact date\):/);
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
		expect(brief.indexOf('## Open questions')).toBeGreaterThan(0);
		expect(brief.indexOf('## Open questions')).toBeLessThan(brief.indexOf('## Evidence'));
		// Only what is actually empty: the founding year and the city are known here.
		expect(brief).not.toContain('When it was founded');
		expect(brief).not.toContain('Where it is based');
		expect(brief).toContain('- What kind of product it is, within 4.2');
		expect(brief).toContain('- Its company registration: no company identification number (CIN) on record');
		expect(brief).toContain('- Founders: no source this page reads names them');
		expect(brief).toContain('- Funding and revenue: Upstream collects neither');
		// Evidence with the real link, or saying there is none.
		expect(brief).toContain('https://sineiitb.org/portfolio/');
		expect(brief).toContain('no link published');
		expect(brief).toContain('- no url for this one (press, not dated):');
		expect(brief).toContain(`Upstream record: ${ORIGIN}/upstream/c/kadamb-biolabs`);
		// The critique's template: why it is here, what not to lean on, and where to go next.
		expect(brief).toMatch(/\*\*Why it is here:\*\* \d+ collected references?(?: \([^)]+\))?, which is what the default order sorts by\. Tier [ABC]: /);
		expect(brief.indexOf('## Evidence')).toBeLessThan(brief.indexOf('## Limits of the evidence'));
		expect(brief).toContain('- The placement is automated and nobody has reviewed it');
		expect(brief).toMatch(/## Next step\n- (Ask |Write to |Their |No public contact route)/);
		expect(brief).toMatch(/Last checked: \d{1,2} [A-Z][a-z]{2} \d{4}, the last run that read a source listing it/);

		// And the same brief is a click away on the company's row, fetched when copied rather than
		// carried by every row.
		const list = await (await SELF.fetch(`${ORIGIN}/upstream?tier=all&age=all&described=all&kind=all`)).text();
		const row = list.slice(list.indexOf('id="c-kadamb-biolabs"'), list.indexOf('</li>', list.indexOf('id="c-kadamb-biolabs"')));
		expect(row).toContain('<button type="button" class="copy-row" data-brief="/upstream/c/kadamb-biolabs/brief" hidden>Copy brief</button>');
		expect(list).not.toContain('<template class="brief">');
		const fetched = await SELF.fetch(`${ORIGIN}/upstream/c/kadamb-biolabs/brief`);
		expect(fetched.headers.get('content-type')).toContain('text/markdown');
		expect(await fetched.text()).toMatch(/^# Kadamb Biolabs\n/);
		expect((await SELF.fetch(`${ORIGIN}/upstream/c/nobody/brief`)).status).toBe(404);

		// The page lists the same unknowns, and the actions are there for the script.
		expect(html).toContain('<h2 id="unknowns-h">What still needs checking</h2>');
		// Split by why it is unknown: not found in the sources checked, or not collected at all.
		expect(html.indexOf('Not found in the sources checked')).toBeLessThan(html.indexOf('Not collected by Upstream'));
		expect(html.indexOf('Not collected by Upstream')).toBeLessThan(html.indexOf('<strong>Its company registration</strong>'));
		expect(html).toContain('class="action copy-brief"');
		expect(html).toContain('data-mark="pass"');
		expect(html).toContain('Saved in this browser only');
		// The markdown preview is folded, not a second copy of the page in the reading path.
		expect(html).toMatch(/<details class="brief-fold"><summary>The brief, as markdown<\/summary><textarea/);
	});

	it('gives every company a page of its own, with the reasoning printed as written', async () => {
		await seed();
		const html = await (await SELF.fetch(`${ORIGIN}/upstream/c/kadamb-biolabs`)).text();

		expect(html).toContain('<h1>Kadamb Biolabs</h1>');
		// Verbatim, not summarised. Somebody disagreeing with a placement has to be
		// able to see exactly what was decided and on what.
		expect(html).toContain('Assay kits place this in diagnostics rather than therapeutics.');
		expect(html).toContain('its reasoning, which is not evidence');
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
		expect(html).toContain('<summary>Where it ranks</summary>');
		expect(html).toContain('Longer on record, or more references (Tier C)');
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
		await post({ source: 'test', companies: [{ id: 'kadamb-biolabs', name: 'Kadamb Biolabs Private Limited' }] });
		const res = await SELF.fetch(`${ORIGIN}/upstream/c/no-such-company`);
		expect(res.status).toBe(404);
		const html = await res.text();
		expect(html).toContain('<h1>No company at this address</h1>');
		expect(html).toContain('Search every record for "no such company"');
		// A stale link to a folded spelling offers the row it was folded into.
		const stale = await (await SELF.fetch(`${ORIGIN}/upstream/c/kadamb-bio`)).text();
		expect(stale).toContain('<a href="/upstream/c/kadamb-biolabs">Kadamb Biolabs Private Limited</a>');
	});

	it('links the row to the company rather than straight off the site', async () => {
		await seed();
		const html = await (await SELF.fetch(`${ORIGIN}/upstream?age=all&tier=all`)).text();
		const start = html.indexOf('id="c-kadamb-biolabs"');
		const row = html.slice(start, html.indexOf('</li>', start));

		expect(row).toContain('href="/upstream/c/kadamb-biolabs"');
		// The facts that change a sourcing decision: what they build, how old on whose word, and
		// who has noticed them, named rather than counted.
		expect(row).toContain('Benchtop assay kits for district hospitals.');
		expect(row).toContain('incubator listing Jan 2026');
		expect(row).toMatch(/portfolio<\/a><span class="plus"> \+ <\/span>|portfolio<\/span><span class="plus"> \+ <\/span>/);
		expect(row).toContain('press mention');
		expect(row).not.toContain('added to Upstream');
		expect(row).not.toContain('first seen');
		// And the tier badge is gone from the row: every company is Tier C today, so
		// it was a column of identical labels that read as a bug.
		expect(visible(row)).not.toContain('Tier C');
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

		const html = await (await SELF.fetch(`${ORIGIN}/upstream?tier=all&age=all&kind=all&described=all`)).text();
		expect(html).toContain('<h1>Go upstream of the funding news.</h1>');
		const start = html.indexOf('id="c-aishwarya-dasare"');
		expect(html.slice(start, html.indexOf('</li>', start))).toContain('<span class="badge">research project</span>');
		// "Companies only" leaves it out, and keeps Planys.
		const companies = await (await SELF.fetch(`${ORIGIN}/upstream?kind=company`)).text();
		expect(companies).not.toContain('id="c-aishwarya-dasare"');
		expect(companies).toContain('id="c-planys"');

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
		const html = await (await SELF.fetch(`${ORIGIN}/upstream?tier=all&age=recent`)).text();
		expect(html).toContain('Call X Ringers Pvt Ltd');

		const detail = await (await SELF.fetch(`${ORIGIN}/upstream/c/call-x-ringers`)).text();
		expect(detail).toContain('The source listing prints 2015 beside the name');
		expect(detail).toContain('doesn&#39;t say what it counts');
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

		const html = await about();
		const row = (name: string) => html.slice(html.indexOf(`<tr><td>${name}</td>`), html.indexOf('</tr>', html.indexOf(`<tr><td>${name}</td>`)));
		// The failing source says so, and what is still shown from it.
		expect(row('Government startup register (DPIIT)')).toMatch(/<strong>failed last check<\/strong><br><span class="provenance">Showing its records from the last check that worked, on \d+ [A-Z][a-z]{2} \d{4}\.<\/span>/);
		expect(row('Government startup register (DPIIT)')).toContain('newest data: 12 Sep 2026');
		// One healthy source does not vouch for the other.
		expect(row('SINE IIT Bombay')).toContain('<td>working</td>');
		expect(row('SINE IIT Bombay')).toContain('newest data: 13 Sep 2026');
		// The count of failures is on this page, not under the hero.
		expect(html).toContain('and 1 failed its last check');
		await post({ source: 'sine-iitb', companies: [{ id: 'fresh-co', name: 'Fresh Co' }] });
		expect(await (await SELF.fetch(`${ORIGIN}/upstream`)).text()).not.toContain('failed its last check');
	});

	it('never prints the day a run succeeded as the date of the data', async () => {
		// The grants file was read on 14 September 2026; its newest award is from 2025.
		await report([
			{ source: 'grants-csv', status: 'ok', records: 177, data_as_of: '2025-10-06' },
			{ source: 'rtbi-iitm', status: 'ok', records: 42 },
		]);
		const html = await about();
		const row = (name: string) => html.slice(html.indexOf(`<tr><td>${name}</td>`), html.indexOf('</tr>', html.indexOf(`<tr><td>${name}</td>`)));
		expect(row('Government grants')).toContain('newest data: 6 Oct 2025');
		expect(row('IIT Madras Incubation Cell')).toContain('newest data: date unknown');
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
	const text = async (qs: string) => (await SELF.fetch(`${ORIGIN}/upstream${every(qs)}`)).text();
	const rows = (html: string) => [...html.matchAll(/<li class="company [^"]*" id="c-([^"]+)"/g)].map((m) => m[1]).sort();

	const panel = (html: string, id: string) => {
		const at = html.indexOf(`aria-labelledby="${id}"`);
		return html.slice(at, html.indexOf('</ul>', at));
	};

	it('has no location panel, and an old ?state= link still filters and says so in a chip', async () => {
		await seed();
		const html = await text('?tier=all');
		expect(html).not.toContain('id="w-places"');
		expect(html).not.toContain('india-map');
		// No comparison with an earlier run, anywhere on the page.
		expect(html).not.toMatch(/vs\.? (previous|last)|since yesterday|[+−-]\d+%/);
	});

	it('filters the list, the counts and the file by a state, unknown included', async () => {
		await seed();
		const maharashtra = await text('?tier=all&age=all&state=Maharashtra');
		expect(rows(maharashtra)).toEqual(['pune-co', 'thane-co']);
		expect(maharashtra).toContain('5 hidden by filters');
		expect(maharashtra).toContain('Location: Maharashtra');
		expect(maharashtra).toContain('<input type="hidden" id="state" name="state" value="Maharashtra">');

		const unknown = await text('?tier=all&age=all&state=unknown');
		expect(rows(unknown)).toEqual(['a', 'b', 'c']);

		const csv = await text('/export.csv?tier=all&age=all&state=Gujarat');
		expect(csv.trim().split('\n')).toHaveLength(2);
		expect(csv).toContain('Surat Co');
	});

	it('counts every panel under the other filters, and its own dimension in full', async () => {
		await seed();
		const html = await text('?tier=all&age=all&state=Maharashtra');
		// The coverage map sees only Maharashtra's two, in their cell.
		expect(html).toContain('<span class="cell-id">2.3</span><span class="cell-n">2</span>');
		// The sources panel counts the same two, and a source with none here is said, not offered as a link.
		const sources = panel(html, 'p-sources');
		expect(sources).toMatch(/<span class="brow-name">Government startup register \(DPIIT\)<\/span><span class="brow-when">[^<]*<\/span><span class="brow-n">2<\/span>/);
		expect(sources).toMatch(/<li class="brow zero"[^>]*><span class="brow-name">SINE IIT Bombay<\/span>/);
		// Choosing a source marks its row, and the row links back to no source filter.
		const chosen = panel(await text('?tier=all&age=all&source=dpiit-startup-india'), 'p-sources');
		// The old spellings of the defaults (described=all, kind=all, age=all) are read and not written back.
		expect(chosen).toMatch(/<a class="brow active" href="\/upstream#list"[^>]*aria-current="true">\s*<span class="brow-name">Government startup register \(DPIIT\)<\/span>/);
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
	const text = async (qs: string) => (await SELF.fetch(`${ORIGIN}/upstream${every(qs)}`)).text();
	const rows = (html: string) => [...html.matchAll(/<li class="company [^"]*" id="c-([^"]+)"/g)].map((m) => m[1]).sort();

	it('filters by whose words say what a company builds, and says how many have none', async () => {
		await seed();
		const all = await text('?tier=all&age=all');
		// The product-description panel is gone; the filter stays, under More filters.
		expect(all).not.toContain('id="w-view"');
		expect(rows(await text('?tier=all&age=all&described=label'))).toEqual(['label-co']);
		expect(rows(await text('?tier=all&age=all&described=source'))).toEqual(['loud-co', 'said-co']);
		expect(await text('?tier=all&age=all&described=label')).toContain('Product description: category label only');
		const api = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?tier=all&age=all&undated=1&described=label`)).json<any>();
		expect(api.companies.map((c: any) => c.id)).toEqual(['label-co']);
		expect((await SELF.fetch(`${ORIGIN}/upstream/api/companies?described=vibes`)).status).toBe(400);
	});

	it('filters by public traces, and draws the thesis as one or none, two, three or more', async () => {
		await seed();
		const all = await text('?tier=all&age=all');
		// The references panel is gone; the filter stays, under More filters.
		expect(all).not.toContain('id="w-traces"');
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
	const text = async (qs: string) => (await SELF.fetch(`${ORIGIN}/upstream${every(qs)}`)).text();
	const rows = (html: string) => [...html.matchAll(/<li class="company [^"]*" id="c-([^"]+)"/g)].map((m) => m[1]).sort();

	it('accounts for every company a coverage cell counts, and offers all of them', async () => {
		await seed();
		// By default the cell's four are all listed.
		expect(rows(await text('?subsector=1.4'))).toEqual(['cohort-a', 'cohort-b', 'grinntech', 'old-co']);

		const html = await text('?subsector=1.4&age=recent');
		expect(html).toContain('<span class="cell-id">1.4</span><span class="cell-n">4</span>');
		// Every record accounted for: 3 shown (2 dated, 1 undated) + 1 hidden by the filter + 1 held back = 5.
		// Every record, companies or not, so the count says records.
		expect(html).toContain('<p class="result-line"><strong>3</strong> records match');
		expect(html).toContain('Showing 3 of 5 records.');
		const line = html.slice(html.indexOf('<p class="result-parts"'), html.indexOf('</p>', html.indexOf('<p class="result-parts"')));
		expect(line).toContain('>1 hidden by filters</a>');
		expect(line).toContain('>1 started more than 5 years ago</a>');
		expect(html).not.toContain('Nothing matches');
		expect(rows(html)).toEqual(['cohort-a', 'cohort-b', 'grinntech']);

		const all = line.match(/<a href="([^"]+)"[^>]*>1 started more than 5 years ago<\/a>/)![1].replace(/&amp;/g, '&');
		expect(rows(await (await SELF.fetch(`${ORIGIN}${all}`)).text())).toEqual(['cohort-a', 'cohort-b', 'grinntech', 'old-co']);
	});

	it('never prints "nothing matches" above a result', async () => {
		await seed();
		const html = await text('?q=grinntech');
		expect(html).not.toContain('Nothing matches');
		expect(html).not.toContain('Nothing here yet');
		expect(html).toContain('Search: &quot;grinntech&quot;');
		expect(rows(html)).toEqual(['grinntech']);

		const none = await text('?q=nobody-by-this-name');
		expect(none).toContain('No record here has "nobody-by-this-name" in its name or in what it builds.');
		expect(none).toContain('Remove the filter: Search: &quot;nobody-by-this-name&quot;');
		expect(none).not.toContain('once the toggles are off');
	});

	it('offers the matches outside the view when a search finds nothing inside it', async () => {
		await post({ source: 'dpiit-startup-india', companies: [{ id: 'labelled-co', name: 'Labelled Co', description: 'DPIIT-recognised startup. Industry: Robotics. Stage: Prototype.', sector_id: '2', subsector_id: '2.7', classify_basis: 'register-label' }] });
		// Listed by default; with "Has a product description" on, the empty result offers it back.
		expect(await (await SELF.fetch(`${ORIGIN}/upstream?q=labelled`)).text()).toContain('id="c-labelled-co"');
		const html = await (await SELF.fetch(`${ORIGIN}/upstream?q=labelled&described=said`)).text();
		expect(html).toContain('No record here has "labelled"');
		expect(html).toContain('Show the 1 record that matches once the toggles are off');
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
			const shown = [...html.matchAll(/<li class="company [^"]*" id="c-[^"]+"[\s\S]*?<h3>(?:<span class="row-n"[^>]*>\d+<\/span>)?<a [^>]*>([^<]+)<\/a>/g)].map((m) => m[1]).sort();
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
		const html = await (await SELF.fetch(`${ORIGIN}/upstream?q=bare&source=sine-iitb&site=none&sort=name&tier=all&age=recent&described=said&kind=company`)).text();

		// A coverage cell keeps the search, the source, the website state and the sort.
		const cell = html.slice(html.indexOf('class="cell '), html.indexOf('</a>', html.indexOf('class="cell ')));
		for (const part of ['q=bare', 'source=sine-iitb', 'site=none', 'sort=name']) {
			expect(cell).toContain(part);
		}

		// The CSV button offers the view on screen, not the whole database.
		expect(html).toMatch(/href="\/upstream\/export\.csv\?q=bare&amp;source=sine-iitb&amp;site=none&amp;described=said&amp;kind=company&amp;sort=name&amp;age=recent"/);
		// Every filter is its own chip, and each chip's link removes that filter and no other.
		const chipsHtml = html.slice(html.indexOf('id="chips"'), html.indexOf('</ul>', html.indexOf('id="chips"')));
		for (const label of ['Search: &quot;bare&quot;', 'Source: SINE IIT Bombay', 'Website: no website listed', 'Started in the last 5 years', 'Has a product description', 'Companies only']) {
			expect(chipsHtml).toContain(label);
		}
		const searchChip = chipsHtml.match(/<a class="chip filter-chip" href="([^"]+)" aria-label="Remove Search/)![1].replace(/&amp;/g, '&');
		expect(searchChip).not.toContain('q=');
		for (const part of ['source=sine-iitb', 'site=none', 'sort=name', 'age=recent', 'described=said', 'kind=company']) expect(searchChip).toContain(part);
		expect(chipsHtml).toContain('<a class="clear" href="/upstream#list">Clear all</a>');
	});

	it('states one spelling of the view as canonical', async () => {
		await seed();
		const html = await (await SELF.fetch(`${ORIGIN}/upstream?sort=obscurity&age=all&described=all&kind=all&status=any&q=bare`)).text();
		// sort, age, described, kind and status are at their defaults and drop out; the search does not.
		expect(html).toContain('<link rel="canonical" href="/upstream?q=bare">');
		// A toggle that is on is part of the spelling.
		expect(await (await SELF.fetch(`${ORIGIN}/upstream?age=recent&q=bare`)).text()).toContain('<link rel="canonical" href="/upstream?q=bare&amp;age=recent">');
	});

	it('shows only the section that was asked for', async () => {
		await post({ source: 'test', mode: 'live', companies: [{ id: 'dated', name: 'Dated Co', origin_year: THIS_YEAR }] });
		await post({ source: 'test', companies: [{ id: 'no-date', name: 'Undated Co' }] });

		const dated = await (await SELF.fetch(`${ORIGIN}/upstream?dates=dated&tier=all&age=all&described=all&kind=all`)).text();
		expect(dated).toContain('Dated Co');
		expect(dated).not.toContain('Undated Co');

		const undated = await (await SELF.fetch(`${ORIGIN}/upstream?dates=undated&tier=all&age=all&described=all&kind=all`)).text();
		expect(undated).toContain('Undated Co');
		expect(undated).not.toContain('Dated Co');
	});

	it('exports the view on screen as a spreadsheet that cannot run formulas', async () => {
		await seed();
		const res = await SELF.fetch(`${ORIGIN}/upstream/export.csv?source=sine-iitb&site=has&age=all&tier=all&described=all&kind=all`);
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
		const both = await (await SELF.fetch(`${ORIGIN}/upstream/export.csv?tier=all&age=all&described=all&kind=all`)).text();
		expect(both).toContain('Dated Co');
		expect(both).toContain('Undated Co');

		// And asking for one section gives one section.
		const onlyDated = await (await SELF.fetch(`${ORIGIN}/upstream/export.csv?tier=all&age=all&dates=dated&described=all&kind=all`)).text();
		expect(onlyDated).toContain('Dated Co');
		expect(onlyDated).not.toContain('Undated Co');

		const onlyUndated = await (await SELF.fetch(`${ORIGIN}/upstream/export.csv?tier=all&age=all&dates=undated&described=all&kind=all`)).text();
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

describe('who they are: founders, the register, contact, domain and papers', () => {
	const page = async (id: string) => (await SELF.fetch(`${ORIGIN}/upstream/c/${id}`)).text();
	const registerRow = (status: string | null, label: string) => ({
		source: 'dpiit-startup-india',
		companies: [
			{
				id: 'tatva-core',
				name: 'Tatva Core',
				description: 'DPIIT-recognised startup. Industry: Robotics. Stage: Prototype.',
				sector_id: '2',
				subsector_id: '2.7',
				classify_basis: 'register-label',
				dpiit_status: status,
				dpiit_stage: 'Prototype',
				entity_type: 'unverified',
				entity_note: 'a project or brand name, with no registered entity on record',
			},
		],
		signals: [{ company_id: 'tatva-core', type: 'dpiit', label, date: '2026-09-01', url: 'https://www.startupindia.gov.in/content/sih/en/search.html?roles=Startup&query=' }],
	});

	it('says a Startup India profile is not a recognition, and keeps one evidence line as the status changes', async () => {
		expect((await post(registerRow('profile', 'Startup India profile, not DPIIT recognised'))).status).toBe(200);
		let html = await page('tatva-core');
		expect(html).toContain('<dt>Startup register (DPIIT)</dt><dd>Startup India profile, not DPIIT recognised; stage on its profile: Prototype</dd>');
		// The stored label keeps its classifier-cache wording; the page prints what the record says.
		expect(html).toContain('Startup India profile, not DPIIT recognised. Industry: Robotics. Stage: Prototype.');
		expect(html).not.toContain('DPIIT-recognised startup.');
		expect(html).toContain('DPIIT register record 2026-09-01');

		// Recognised later: the old line goes, rather than sitting beside the new one.
		await post(registerRow('recognised', 'DPIIT recognised (DIPP777)'));
		html = await page('tatva-core');
		expect(html).toContain('DPIIT recognised (DIPP777)');
		expect(html).not.toContain('Startup India profile, not DPIIT recognised');
		const { results } = await env.DB.prepare("SELECT label FROM signals WHERE company_id = 'tatva-core'").all<{ label: string }>();
		expect(results.map((r) => r.label)).toEqual(['DPIIT recognised (DIPP777)']);
	});

	it('refuses a register status it has no sentence for, and contact details from an unconfirmed site', async () => {
		const bad = registerRow('maybe', 'x');
		expect((await post(bad)).status).toBe(400);
		const unconfirmed = {
			source: 'sine-iitb',
			companies: [{ id: 'x-co', name: 'X Co', website: 'https://x.example', website_identity: 'associated', contact_email: 'info@x.example' }],
		};
		const res = await post(unconfirmed);
		expect(res.status).toBe(400);
		expect(await res.text()).toContain("contact_email needs website_identity 'verified'");
	});

	it('shows founders with their source, contact, domain age and first archived copy from a verified site, and papers outside the trace count', async () => {
		const papers = {
			count: 2,
			works: [{ title: 'Graphene membranes for desalination', year: 2025, url: 'https://doi.org/10.1000/xyz' }],
			query_url: 'https://api.openalex.org/works?filter=raw_affiliation_strings.search:%22Kadamb%20Biolabs%22',
		};
		await post({
			source: 'sine-iitb',
			companies: [
				{
					id: 'kadamb-biolabs',
					name: 'Kadamb Biolabs Pvt Ltd',
					description: 'Benchtop assay kits for district hospitals.',
					sector_id: '4',
					subsector_id: '4.2',
					website: 'https://kadamb.example',
					website_identity: 'verified',
					website_identity_note: 'name in the domain',
					founders: 'Prof. A Rao, B Shah',
					founders_source: 'sine-iitb',
					contact_email: 'hello@kadamb.example',
					contact_page: 'https://kadamb.example/contact',
					domain_registered: '2016-03-02',
					web_first_capture: '2019-07-14',
					papers,
				},
			],
			signals: [{ company_id: 'kadamb-biolabs', type: 'incubator', label: 'SINE IIT Bombay incubatee, 2025-2026', url: 'https://sineiitb.org/portfolio/' }],
		});
		const html = await page('kadamb-biolabs');
		expect(html).toContain('<dt>Founders</dt><dd>Prof. A Rao, B Shah</dd><dd class="why">as SINE IIT Bombay lists them</dd>');
		expect(html).toContain('<a href="mailto:hello@kadamb.example" rel="noopener nofollow">hello@kadamb.example</a>');
		expect(html).toContain('<dt>Domain registered</dt><dd>2 Mar 2016</dd>');
		expect(html).toContain('This is the domain&#39;s age. A domain can be bought years before a company starts');
		expect(html).toContain('<dt>First archived</dt><dd><a href="https://web.archive.org/web/*/kadamb.example" rel="noopener nofollow">14 Jul 2019</a></dd>');
		expect(html).toContain('when the public web first noticed the page. The company may be older');
		expect(html).toContain('2 works list this company as an author affiliation, in OpenAlex');
		expect(html).toContain('Graphene membranes for desalination');
		expect(html).not.toContain('Founders: no source this page reads names them');
		expect(html).toContain('1 collected reference');

		const csv = await (await SELF.fetch(`${ORIGIN}/upstream/export.csv?tier=all&age=all`)).text();
		const [header, row] = csv.replace(/^﻿/, '').trim().split('\r\n');
		expect(header).toContain('"founders","founders_source","dpiit_status","dpiit_stage","contact_email","contact_page","domain_registered","web_first_capture","build_tags","domain_tags","public_programmes","programme_count","publishing_organisations","hiring_roles","team_page","site_versions_2y","parked_homepage","papers_found"');
		expect(row).toContain('"Prof. A Rao, B Shah","sine-iitb",,,"hello@kadamb.example","https://kadamb.example/contact","2016-03-02","2019-07-14","","","incubation at SINE, IIT Bombay","1","1","","","","","2"');

		// An address later found not to be theirs takes what was read off it with it.
		await post({ source: 'sine-iitb', companies: [{ id: 'kadamb-biolabs', name: 'Kadamb Biolabs Pvt Ltd', website: 'https://kadamb.example', website_identity: 'discovered' }] });
		const after = await page('kadamb-biolabs');
		expect(after).not.toContain('hello@kadamb.example');
		expect(after).not.toContain('Domain registered');
		expect(after).not.toContain('First archived');
		expect(after).toContain('Prof. A Rao, B Shah');
	});
});

describe('what an analyst keeps and how they order it', () => {
	it('exports exactly the shortlisted ids, whatever the view, and orders by how much is known', async () => {
		await post({
			source: 'sine-iitb',
			companies: [
				{ id: 'rich-co', name: 'Rich Co', description: 'Robots for sewers.', website: 'https://rich.example', website_identity: 'verified', website_identity_note: 'name in the domain', founders: 'A Rao', founders_source: 'sine-iitb', contact_email: 'hi@rich.example', sector_id: '2', subsector_id: '2.7', dpiit_stage: 'Prototype' },
				{ id: 'thin-co', name: 'Thin Co', description: 'Robots.', sector_id: '2', subsector_id: '2.7' },
				{ id: 'label-co', name: 'Label Co', description: 'DPIIT-recognised startup. Industry: Robotics.', sector_id: '2', subsector_id: '2.7', classify_basis: 'register-label' },
			],
		});
		const csv = await (await SELF.fetch(`${ORIGIN}/upstream/export.csv?described=all&kind=all&tier=all&age=all&ids=label-co,thin-co`)).text();
		expect(csv).toContain('Label Co');
		expect(csv).toContain('Thin Co');
		expect(csv).not.toContain('Rich Co');

		const ordered = await (await SELF.fetch(`${ORIGIN}/upstream?sort=described&tier=all&age=all`)).text();
		const ids = [...ordered.matchAll(/<li class="company [^"]*" id="c-([^"]+)"/g)].map((m) => m[1]);
		expect(ids.indexOf('rich-co')).toBeLessThan(ids.indexOf('thin-co'));
		expect(ordered).toContain('<option value="described" selected>Most described</option>');
		// How far along, only where a source says.
		const row = ordered.slice(ordered.indexOf('id="c-rich-co"'), ordered.indexOf('</li>', ordered.indexOf('id="c-rich-co"')));
		expect(row).toContain('<span class="f-stage" title="The stage the company chose on its DPIIT profile">Prototype</span>');
		// An old link that asked for the tier order gets fewest collected references.
		expect(await (await SELF.fetch(`${ORIGIN}/upstream?sort=obscurity`)).text()).toContain('<option value="quietest" selected>Fewest collected references</option>');
	});
});

describe('arriving cold, and not getting stuck', () => {
	it('tells a company page visitor what Upstream is and what the company builds, then the evidence, with the ranking folded', async () => {
		await post({
			source: 'sine-iitb',
			companies: [{ id: 'cold-co', name: 'Cold Co', description: 'Sensors for grain silos.', description_source: 'sine-iitb', sector_id: '5', subsector_id: '5.2' }],
			signals: [{ company_id: 'cold-co', type: 'incubator', label: 'SINE cohort' }],
		});
		const html = await (await SELF.fetch(`${ORIGIN}/upstream/c/cold-co`)).text();
		expect(html).toContain('A company record on <a href="/upstream">Upstream</a>, put together from public sources.');
		expect(html).toContain('It is here because SINE IIT Bombay lists it. Upstream has collected 1 reference to it (an incubator listing), and the default order puts the records with the fewest first.');
		// What it builds, then the shortlist action, then what supports it; how it ranks comes last, folded.
		expect(html.indexOf('Sensors for grain silos.')).toBeLessThan(html.indexOf('class="action mark mark-shortlist"'));
		expect(html.indexOf('class="action mark mark-shortlist"')).toBeLessThan(html.indexOf('<h2 id="evidence-h">What supports this</h2>'));
		expect(html.indexOf('<h2 id="evidence-h">What supports this</h2>')).toBeLessThan(html.indexOf('<h2 id="unknowns-h">'));
		expect(html.indexOf('<h2 id="unknowns-h">')).toBeLessThan(html.indexOf('<summary>Where it ranks</summary>'));
		expect(html).toContain('<summary>Where it sits in the government&#39;s R&amp;D sub-sectors (the RDI scheme)</summary>');
		// A way into discovery for someone who arrived from a link.
		expect(html).toContain('<a class="back" href="/upstream#c-cold-co">&larr; All companies</a>');
		expect(html).toContain('class="topnav"');
	});

	it('starts with a search, working sector presets and real results, and turns empty cells and typos into a way forward', async () => {
		await post({
			source: 'sine-iitb',
			companies: [
				{ id: 'grinntech', name: 'Grinntech Motors', description: 'Battery packs.', sector_id: '1', subsector_id: '1.4' },
				{ id: 'volt-co', name: 'Volt Co', description: 'Grid storage.', sector_id: '1', subsector_id: '1.4' },
			],
		});
		const home = await (await SELF.fetch(`${ORIGIN}/upstream`)).text();
		// One results surface: no preview list above it.
		expect(home).not.toContain('id="top-picks"');
		expect(home).toContain('<a href="/upstream/c/grinntech">Grinntech Motors</a>');
		expect(home).toContain('<label for="q">Find companies</label>');
		expect(home).toContain('placeholder="Search companies or technologies"');
		// No status line under the hero: the dated figures and source health are on the methodology page.
		expect(home).not.toContain(`<strong>${SNAPSHOT.placed}</strong> records &middot;`);
		const method = await about();
		expect(method).toContain(`The counts from ${SNAPSHOT.date} are kept fixed: ${SNAPSHOT.placed} records placed`);
		expect(method).toContain('Upstream reads 8 sources that list companies.');
		// A preset is a link to the same sub-sector filter the form sets, and only where the records hold any.
		expect(home).toContain('<a class="preset" href="/upstream?subsector=1.4#list">Energy Storage</a>');
		expect(home).not.toContain('>Medical Devices &amp; Diagnostics</a>');
		const preset = await (await SELF.fetch(`${ORIGIN}/upstream?subsector=1.4`)).text();
		expect(preset).toContain('<a class="preset active" href="/upstream#list" aria-current="true">Energy Storage</a>');
		expect(preset).toContain('<option value="1.4" data-sector="1" selected>Energy Storage</option>');
		expect(preset).toContain('Sub-sector: Energy Storage');

		const empty = await (await SELF.fetch(`${ORIGIN}/upstream?subsector=1.7`)).text();
		expect(empty).toContain('No company found in these sources yet for 1.7 Modular Nuclear Reactors.');
		expect(empty).toContain('1.4 Energy Storage (2)</a>');

		const typo = await (await SELF.fetch(`${ORIGIN}/upstream?q=grinntek`)).text();
		expect(typo).toMatch(/Did you mean <a href="[^"]*q=Grinntech\+Motors[^"]*">Grinntech Motors<\/a>\?/);
	});
});

describe('the shortlist and the methodology page', () => {
	it('shows a whole shortlist by id over every record, says it is one, and leaves it for the ordinary defaults', async () => {
		await post({
			source: 'sine-iitb',
			companies: [
				{ id: 'kept-co', name: 'Kept Co', description: 'Wave energy buoys.', sector_id: '1', subsector_id: '1.4', origin_year: THIS_YEAR - 9 },
				{ id: 'label-co', name: 'Label Co', description: 'DPIIT-recognised startup. Industry: Robotics.', sector_id: '2', subsector_id: '2.7' },
				{ id: 'other-co', name: 'Other Co', description: 'Grid batteries.', sector_id: '1', subsector_id: '1.4' },
			],
		});
		// The link the marks script builds: the ids alone, since the defaults already hold back nothing.
		const html = await (await SELF.fetch(`${ORIGIN}/upstream?ids=kept-co,label-co`)).text();
		// An old shortlist link, with the defaults spelled out, shows the same rows.
		expect([...(await (await SELF.fetch(`${ORIGIN}/upstream?described=all&kind=all&age=all&ids=kept-co,label-co`)).text()).matchAll(/<li class="company [^"]*" id="c-([^"]+)"/g)].map((m) => m[1]).sort()).toEqual(['kept-co', 'label-co']);
		const ids = [...html.matchAll(/<li class="company [^"]*" id="c-([^"]+)"/g)].map((m) => m[1]).sort();
		expect(ids).toEqual(['kept-co', 'label-co']);
		expect(html).toContain('<h1>Companies you shortlisted</h1>');
		expect(html).toContain('<meta name="robots" content="noindex, follow">');
		// One chip for the shortlist, and none for the widened defaults it needs.
		const chipsHtml = html.slice(html.indexOf('id="chips"'), html.indexOf('</ul>', html.indexOf('id="chips"')));
		expect(chipsHtml).toContain('Your shortlist (2)');
		expect(chipsHtml).not.toContain('Started:');
		expect(chipsHtml).not.toContain('Description:');
		const leave = chipsHtml.match(/<a class="chip filter-chip" href="([^"]+)" aria-label="Remove Your shortlist/)![1];
		expect(leave).toBe('/upstream#list');
		// The ids survive the form, the canonical url and the export.
		expect(html).toContain('<input type="hidden" name="ids" value="kept-co,label-co">');
		expect(html).toContain('<link rel="canonical" href="/upstream?ids=kept-co%2Clabel-co">');
		expect(html).toContain('id="export" href="/upstream/export.csv?ids=kept-co%2Clabel-co"');
		// Every row carries the same shortlist action in the same place.
		expect(html.match(/<button type="button" class="mark mark-shortlist" data-mark="shortlist" aria-pressed="false" aria-label="Shortlist [^"]+">Shortlist<\/button>/g)).toHaveLength(2);
		// The nav offers the shortlist on every page, drawn only when the browser can keep one.
		expect(html).toContain('<li class="nav-shortlist-item" hidden><a class="nav-shortlist"');
	});

	it('keeps the filters in the page flow: nothing pinned, and the sort joins the form from beside the count', async () => {
		await post({ source: 'sine-iitb', companies: [{ id: 'pin-co', name: 'Pin Co', description: 'Tidal turbines.' }] });
		const html = await (await SELF.fetch(`${ORIGIN}/upstream`)).text();
		const form = html.slice(html.indexOf('<form class="controls"'), html.indexOf('</form>', html.indexOf('<form class="controls"')));
		expect(form).toContain('id="q"');
		// The sort sits by the count, outside the form, and is still submitted with it.
		expect(form).not.toContain('id="sort"');
		expect(html).toContain('<select id="sort" name="sort" form="controls">');
		for (const id of ['quick', 'chips', 'result-line', 'export']) expect(form).not.toContain(`id="${id}"`);
		// A pinned bar that held five filters and More filters would cover a phone's screen.
		const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
		expect(css).not.toMatch(/\.controls\s*\{[^}]*position:\s*sticky/);
		expect(css).not.toMatch(/\.(stuck|pinned)[^{]*\{/);
	});

	it('serves coverage and methodology on its own page, with the source status and no list', async () => {
		await SELF.fetch(`${ORIGIN}/upstream/api/source-runs`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'X-Ingest-Key': KEY },
			body: JSON.stringify({ runs: [{ source: 'sine-iitb', status: 'ok', records: 3, data_as_of: '2026-09-12T11:00:00Z' }] }),
		});
		const res = await SELF.fetch(`${ORIGIN}/upstream/about`);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('<h1>How Upstream works</h1>');
		expect(html).toContain('<a href="/upstream/about" aria-current="page">');
		// The sections, in order, in sentence case.
		const heads = [...html.matchAll(/<h2 id="[^"]+">([^<]+)<\/h2>/g)].map((m) => m[1]);
		expect(heads).toEqual([
			'What Upstream is',
			'Where the data comes from',
			'How a company gets on the list',
			'How the list is ordered',
			'What we check',
			'What Upstream can&#39;t see',
			'How often it updates, and the dated snapshot',
			'Who built it and how',
		]);
		// One row per source: what it gives, records, last checked and status.
		expect(html).toContain('<thead><tr><th scope="col">Source</th><th scope="col">What it gives us</th><th scope="col">Records</th><th scope="col">Last checked</th><th scope="col">Status</th></tr></thead>');
		expect(html).toMatch(/<tr><td>SINE IIT Bombay<\/td><td>company name, founders, one-line description, website, incubation year<\/td><td class="mono">0<\/td><td class="mono">\d+ [A-Z][a-z]{2} \d{4}<br>/);
		expect(html).toMatch(/<tr><td>Venture Center<\/td><td>[^<]+<\/td><td class="mono">0<\/td><td class="mono">never<\/td><td>no check recorded yet<\/td><\/tr>/);
		expect(html).toContain('A check that worked means the source was read. It doesn&#39;t mean a person checked each record.');
		// The dated snapshot, with its CSV.
		expect(html).toContain('href="https://github.com/Rhitrao/upstream/blob/main/docs/snapshot-2026-09-17.csv"');
		expect(html).toContain('id="snapshot"');
		// Who built it.
		expect(html).toContain('Rohit Rao built Upstream in about two weeks with Claude Code. It runs on Cloudflare');
		// Nothing that repeats the home page's hero word for word.
		expect(html).not.toContain('Most lists rank companies by funding or press coverage, so every investor ends up looking at the same names.');
		expect(html).not.toContain('id="list"');
		expect((await SELF.fetch(`${ORIGIN}/upstream/about`, { method: 'POST' })).status).toBe(405);
	});
});

describe('what a shared link shows', () => {
	it('serves a share card and a favicon, and names them in the head of the list and a company page', async () => {
		const card = await SELF.fetch(`${ORIGIN}/upstream/og.png`);
		expect(card.status).toBe(200);
		expect(card.headers.get('content-type')).toBe('image/png');
		expect(new Uint8Array(await card.arrayBuffer()).slice(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47]));
		expect((await SELF.fetch(`${ORIGIN}/upstream/favicon.svg`)).headers.get('content-type')).toBe('image/svg+xml');
		const list = await (await SELF.fetch(`${ORIGIN}/upstream`)).text();
		expect(list).toContain(`<meta property="og:image" content="${ORIGIN}/upstream/og.png">`);
		expect(list).toContain('<link rel="icon" href="/upstream/favicon.svg" type="image/svg+xml">');
		await post({ source: 'test', companies: [{ id: 'card-co', name: 'Card Co' }] });
		expect(await (await SELF.fetch(`${ORIGIN}/upstream/c/card-co`)).text()).toContain('<meta property="og:title" content="Card Co | Upstream">');
	});
});

describe('signs of activity on their own site', () => {
	it('says what the careers, team, code and archive show, from a verified site only', async () => {
		const signals = { careers: 'https://act.example/careers', careers_hosted: null, roles: 3, says_no_openings: false, team: 'https://act.example/team', repo: 'https://github.com/actco', parked: false, versions: 5, last_change: '2026-08-01', since: '2024-09-15' };
		await post({
			source: 'sine-iitb',
			companies: [{ id: 'act-co', name: 'Act Co', website: 'https://act.example', website_identity: 'verified', website_identity_note: 'name in the domain', site_signals: signals }],
		});
		const html = await (await SELF.fetch(`${ORIGIN}/upstream/c/act-co`)).text();
		expect(html).toContain('3 roles listed');
		expect(html).toContain('not headcount');
		expect(html).toContain('<dt>Team page</dt>');
		expect(html).toContain('github.com/actco');
		expect(html).toContain('5 versions in two years, latest 1 Aug 2026');
		// Found not to be theirs, and what was read off it goes.
		await post({ source: 'sine-iitb', companies: [{ id: 'act-co', name: 'Act Co', website: 'https://act.example', website_identity: 'discovered' }] });
		expect(await (await SELF.fetch(`${ORIGIN}/upstream/c/act-co`)).text()).not.toContain('roles listed');
	});
});

describe('the generated column and the expression it mirrors', () => {
	it('keeps said_state in migration 0028 identical to SAID_STATE_SQL', async () => {
		const { SAID_STATE_SQL } = await import('../src/db');
		const migration = (await import('../migrations/0028_site_state_and_indexes.sql?raw')).default as string;
		expect(migration).toContain(`said_state TEXT GENERATED ALWAYS AS (${SAID_STATE_SQL}) VIRTUAL`);
	});
});

describe('rows read, and the edge cache', () => {
	const cachedFetch = async (path: string) => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(new Request(`${ORIGIN}${path}`), { ...env, EDGE_CACHE: 'on' } as Env, ctx);
		const body = await response.text();
		await waitOnExecutionContext(ctx);
		return { response, body };
	};

	it('says how many rows each response read, serves a repeat from the cache, and lets an ingest through', async () => {
		await post({ source: 'sine-iitb', companies: [{ id: 'cache-co', name: 'Cache Co', description: 'Thermal cameras.', sector_id: '2', subsector_id: '2.2' }] });
		const first = await cachedFetch('/upstream?q=cache');
		expect(first.response.headers.get('x-edge-cache')).toBe('miss');
		expect(Number(first.response.headers.get('x-d1-rows-read'))).toBeGreaterThan(1);
		expect(first.body).toContain('Cache Co');

		const again = await cachedFetch('/upstream?q=cache');
		expect(again.response.headers.get('x-edge-cache')).toBe('hit');
		// Only the data version's one row.
		expect(Number(again.response.headers.get('x-d1-rows-read'))).toBeLessThanOrEqual(1);

		// Another server, whose own cache is empty: the shared page store answers for a row or two.
		const version = await env.DB.prepare("SELECT value FROM site_state WHERE key = 'data'").first<{ value: string }>();
		const url = new URL(`${ORIGIN}/upstream?q=cache`);
		url.searchParams.set("__v", `${version!.value}.${(env as Env).CF_VERSION_METADATA?.id ?? "dev"}.${LAYOUT_VERSION}`);
		await caches.default.delete(new Request(url.toString()));
		const otherServer = await cachedFetch('/upstream?q=cache');
		expect(otherServer.response.headers.get('x-edge-cache')).toBe('store');
		expect(Number(otherServer.response.headers.get('x-d1-rows-read'))).toBeLessThanOrEqual(3);
		expect(otherServer.body).toContain('Cache Co');

		// An ingest moves the version, so the same url is computed afresh and shows the change.
		await post({ source: 'sine-iitb', companies: [{ id: 'cache-co', name: 'Cache Co Renamed', description: 'Thermal cameras.', sector_id: '2', subsector_id: '2.2' }] });
		const after = await cachedFetch('/upstream?q=cache');
		expect(after.response.headers.get('x-edge-cache')).toBe('miss');
		expect(after.body).toContain('Cache Co Renamed');

		const company = await cachedFetch('/upstream/c/cache-co');
		const companyAgain = await cachedFetch('/upstream/c/cache-co');
		expect(companyAgain.response.headers.get('x-edge-cache')).toBe('hit');
		expect(company.body).toContain('Cache Co Renamed');

		// D1 refusing every query (a spent daily limit): the last good copy is served, not an error.
		const refusing = { prepare: () => { throw new Error('D1_ERROR: exceeded daily rows read'); }, batch: async () => { throw new Error('refused'); }, exec: async () => { throw new Error('refused'); } };
		const ctx = createExecutionContext();
		const down = await worker.fetch(new Request(`${ORIGIN}/upstream?q=cache`), { ...env, EDGE_CACHE: 'on', DB: refusing } as unknown as Env, ctx);
		await waitOnExecutionContext(ctx);
		expect(down.status).toBe(200);
		expect(down.headers.get('x-edge-cache')).toBe('stale');
		expect(await down.text()).toContain('Cache Co Renamed');
	});
});

describe('public programmes, counted and not ranked', () => {
	it('computes the same programmes and organisations as the ingest module', async () => {
		const { programmesOf, organisationsOf } = await import('../src/programmes');
		const signals = [
			{ type: 'incubator', label: 'SINE IIT Bombay incubatee', source: 'sine-iitb' },
			{ type: 'grant', label: 'SINE IIT Bombay DST NIDHI PRAYAS, Cohort 5', source: 'sine-iitb' },
			{ type: 'grant', label: 'BIRAC BIG 21', source: 'grants-csv' },
			{ type: 'grant', label: 'SINE IIT Bombay seed investment, MeitY-SAMRIDH', source: 'sine-iitb' },
			{ type: 'website', label: 'website live', source: 'sine-iitb' },
		];
		expect(programmesOf(signals, 'recognised')).toEqual(['BIRAC', 'DPIIT recognition', 'DST', 'MeitY', 'incubation at SINE, IIT Bombay']);
		expect(organisationsOf(signals, 'recognised')).toEqual(['BIRAC', 'DPIIT', 'SINE, IIT Bombay']);
	});

	it('stores them on ingest, and makes them a row field, a filter, a sort, a lead widget and the first finding', async () => {
		await post({
			source: 'sine-iitb',
			companies: [
				{ id: 'many-co', name: 'Many Co', description: 'Neonatal warmers.', dpiit_status: 'recognised' },
				{ id: 'site-co', name: 'Site Co', description: 'Soil sensors.', website: 'https://site.example', website_identity: 'verified', website_identity_note: 'name in the domain' },
				{ id: 'one-co', name: 'One Co', description: 'Drone batteries.' },
			],
			signals: [
				{ company_id: 'many-co', type: 'incubator', label: 'SINE IIT Bombay incubatee' },
				{ company_id: 'many-co', type: 'grant', label: 'SINE IIT Bombay DST NIDHI PRAYAS, Cohort 5' },
				{ company_id: 'site-co', type: 'incubator', label: 'SINE IIT Bombay incubatee' },
				{ company_id: 'site-co', type: 'grant', label: 'SINE IIT Bombay BIG, Cohort 3' },
				{ company_id: 'site-co', type: 'website', label: 'website live' },
				{ company_id: 'one-co', type: 'incubator', label: 'SINE IIT Bombay incubatee' },
			],
		});
		const stored = await env.DB.prepare('SELECT id, programme_count, organisation_count FROM companies ORDER BY id').all<any>();
		expect(stored.results).toEqual([
			{ id: 'many-co', programme_count: 3, organisation_count: 2 },
			{ id: 'one-co', programme_count: 1, organisation_count: 1 },
			{ id: 'site-co', programme_count: 2, organisation_count: 1 },
		]);
		const html = await (await SELF.fetch(`${ORIGIN}/upstream?age=all`)).text();
		// The list page's programmes panel is gone, and so is the finding on the methodology page;
		// the filter links it made still work and say so in a chip.
		expect(html).not.toContain('id="w-programmes"');
		const row = html.slice(html.indexOf('id="c-many-co"'), html.indexOf('</li>', html.indexOf('id="c-many-co"')));
		expect(row).toContain('>3 public programmes</span>');

		const ids = (h: string) => [...h.matchAll(/<li class="company [^"]*" id="c-([^"]+)"/g)].map((m) => m[1]);
		expect(ids(await (await SELF.fetch(`${ORIGIN}/upstream?age=all&programmes=2`)).text()).sort()).toEqual(['many-co', 'site-co']);
		const alone = await (await SELF.fetch(`${ORIGIN}/upstream?age=all&programmes=2&alone=1`)).text();
		expect(ids(alone)).toEqual(['many-co']);
		expect(alone).toContain('Public programmes: 2 or more');
		expect(alone).toContain('No website or press');
		expect(ids(await (await SELF.fetch(`${ORIGIN}/upstream?age=all&sort=programmes`)).text())[0]).toBe('many-co');
		expect(await (await SELF.fetch(`${ORIGIN}/upstream/c/many-co`)).text()).toContain('<dt>Public programmes</dt>');
	});
});

describe('the finding the scatter would have drawn', () => {
	it('keeps the one-outside-source link working after the finding left the methodology page', async () => {
		await post({
			source: 'sine-iitb',
			companies: [
				{ id: 'once-co', name: 'Once Co', description: 'Lidar for mines.', website: 'https://once.example', website_identity: 'verified', website_identity_note: 'name in the domain' },
				{ id: 'twice-co', name: 'Twice Co', description: 'Radar for ports.' },
			],
			signals: [
				{ company_id: 'once-co', type: 'incubator', label: 'SINE cohort' },
				{ company_id: 'once-co', type: 'website', label: 'website live' },
				{ company_id: 'twice-co', type: 'incubator', label: 'SINE cohort' },
				{ company_id: 'twice-co', type: 'grant', label: 'BIRAC BIG 21' },
			],
		});
		expect(await about()).not.toContain('Most companies here have been noticed by exactly one outside source.');
		const only = await (await SELF.fetch(`${ORIGIN}/upstream?noticed=1&age=all`)).text();
		expect([...only.matchAll(/<li class="company [^"]*" id="c-([^"]+)"/g)].map((m) => m[1])).toEqual(['once-co']);
		expect(only).toContain('Referenced by: one outside source');
	});
});

describe('who has noticed a company, named', () => {
	it('names each trace by who left it, once, with scheme numbers and cohorts dropped', async () => {
		const { traceTrail } = await import('../src/page');
		const sig = (type: string, label: string, source: string, url: string | null = null) => ({ type, label, source, url, date: null });
		const trail = traceTrail({
			dpiit_status: 'recognised',
			website: null,
			website_identity: null,
			signals: [
				sig('incubator', 'SINE IIT Bombay incubatee', 'sine-iitb', 'https://sineiitb.org/portfolio/'),
				sig('grant', 'SINE IIT Bombay DST NIDHI PRAYAS, Cohort 5', 'sine-iitb'),
				sig('grant', 'BIRAC BIG 21', 'grants-csv'),
				sig('grant', 'BIRAC BIG 22', 'grants-csv'),
				sig('dpiit', 'DPIIT recognised (DIPP1)', 'dpiit-startup-india'),
				sig('website', 'website live', 'sine-iitb'),
			],
		}).replace(/<[^>]+>/g, '');
		expect(trail).toBe('SINE IIT Bombay portfolio + DST NIDHI PRAYAS + BIRAC BIG + DPIIT recognition + own website');
	});
});

describe('what the traces are', () => {
	it('names each kind once, counts repeats, and leaves out what is not a trace', async () => {
		const { traceShape } = await import('../src/page');
		const sig = (type: string) => ({ type, label: type, url: null, date: null });
		expect(traceShape({ signals: [sig('grant')] })).toBe('a grant');
		expect(traceShape({ signals: [sig('website'), sig('grant'), sig('incubator'), sig('grant')] })).toBe('an incubator listing, 2 grants and a live website');
		expect(traceShape({ signals: [sig('patent'), sig('incorporation')] })).toBe('');
	});
});

describe('how many ranked rows it takes to open on them', () => {
	it('waits for five by default, and reads a positive whole number from the environment', async () => {
		const { minRankedToOpen, MIN_RANKED_TO_OPEN } = await import('../src/db');
		expect(MIN_RANKED_TO_OPEN).toBe(5);
		expect(minRankedToOpen({} as Env)).toBe(5);
		expect(minRankedToOpen({ MIN_RANKED_TO_OPEN: '1' } as Env)).toBe(1);
		expect(minRankedToOpen({ MIN_RANKED_TO_OPEN: 'zero' } as Env)).toBe(5);
		expect(minRankedToOpen({ MIN_RANKED_TO_OPEN: '0' } as Env)).toBe(5);
	});
});

describe('awards as evidence on companies already held', () => {
	it('never creates a company, dates an undated one at the precision given, and counts the award as a trace', async () => {
		await post({ source: 'sine-iitb', companies: [{ id: 'held-co', name: 'Held Co', description: 'Battery cells.', sector_id: '1', subsector_id: '1.4' }] });
		const before = await env.DB.prepare("SELECT first_seen, trace_count FROM companies WHERE id = 'held-co'").first<any>();
		expect(before.first_seen).toBeNull();

		const res = await post({
			source: 'nsa-dpiit',
			signals: [
				{ company_id: 'held-co', type: 'award', label: 'National Startup Awards 2022, finalist — Energy', date: '2022', url: 'https://www.startupindia.gov.in/nsa2022results/' },
				{ company_id: 'not-held', type: 'award', label: 'National Startup Awards 2022, winner — Space', date: '2022', url: 'https://www.startupindia.gov.in/nsa2022results/' },
			],
		});
		expect(res.status).toBe(200);
		expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM companies WHERE id = 'not-held'").first<any>()).toEqual({ n: 0 });
		const after = await env.DB.prepare("SELECT first_seen, first_seen_basis, trace_count FROM companies WHERE id = 'held-co'").first<any>();
		expect(after).toEqual({ first_seen: '2022', first_seen_basis: 'cohort', trace_count: 1 });

		// A padded date is refused: "2022-01-01" is a day the source never gave, and "2022-23" is not a date.
		const padded = await post({ source: 'tdb-agreements', signals: [{ company_id: 'held-co', type: 'grant', label: 'TDB FY 2022-23', date: '2022-23' }] });
		expect(padded.status).toBe(400);

		// The page shows the list's own date apart from the event's.
		await post({
			source: 'birac-big',
			signals: [{ company_id: 'held-co', type: 'grant', label: 'BIRAC BIG round 18 awardee', published: '2021-09-03', url: 'https://birac.nic.in/big.php' }],
		});
		const page = await (await SELF.fetch(`${ORIGIN}/upstream/c/held-co`)).text();
		expect(page).toContain('not dated; list published 2021-09-03');
		expect(page).toContain('National Startup Awards 2022, finalist');
	});
});

describe('merging what each source knows', () => {
	it('never lets a register label replace a real description, and names whose words it is', async () => {
		await post({ source: 'sine-iitb', companies: [{ id: 'gigaton', name: 'Gigaton Research', description: 'Carbon capture sorbents.', description_source: 'sine-iitb', sector_id: '1', subsector_id: '1.6' }] });
		await post({ source: 'dpiit-startup-india', companies: [{ id: 'gigaton', name: 'Gigaton Research', description: 'DPIIT-recognised startup. Industry: Green Technology.', sector_id: '1', subsector_id: '1.6' }] });
		const row = await env.DB.prepare("SELECT description, description_source FROM companies WHERE id = 'gigaton'").first<any>();
		expect(row).toEqual({ description: 'Carbon capture sorbents.', description_source: 'sine-iitb' });
		const page = await (await SELF.fetch(`${ORIGIN}/upstream/c/gigaton`)).text();
		expect(page).toContain('as SINE IIT Bombay described it');
	});
});

describe('the count, the total and the row numbers agree', () => {
	it('numbers one order across every page, 100 to a page, and the count, the numbers and the pager agree', async () => {
		const dated = Array.from({ length: 203 }, (_, i) => ({ id: `d-${String(i).padStart(3, '0')}`, name: `Dated ${i}`, origin_year: THIS_YEAR, description: 'Sensors.' }));
		const undated = [0, 1].map((i) => ({ id: `u-${i}`, name: `Undated ${i}`, description: 'Sensors.' }));
		await post({ source: 'sine-iitb', companies: [...dated, ...undated] });
		const numbersOf = (h: string) => [...h.matchAll(/<span class="row-n" aria-hidden="true">(\d+)<\/span>/g)].map((m) => Number(m[1]));

		const html = await (await SELF.fetch(`${ORIGIN}/upstream`)).text();
		// 205 match; the first 100 are listed, numbered 1 to 100, and the lines above and below say exactly that.
		expect(html).toContain('<p class="result-line"><strong>205</strong> records match');
		expect(html).toContain('Showing all 205 records.');
		expect(html).toContain('Showing 1 to 100 of 205.');
		expect(html).toContain('<p class="pager-where">Showing 1 to 100 of 205</p>');
		expect(numbersOf(html)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
		expect(html).toContain('<ol class="companies" start="1">');
		expect(html).toMatch(/<a class="pager-link" href="\/upstream\?page=2#list" rel="next">Next &rarr;<\/a>/);
		expect(html).toContain('<a class="pager-link current" href="/upstream#list" aria-current="page">1</a>');

		// The last page: numbered on from the pages before, the undated after the dated.
		const last = await (await SELF.fetch(`${ORIGIN}/upstream?page=3`)).text();
		expect(numbersOf(last)).toEqual([201, 202, 203, 204, 205]);
		expect(last).toContain('<ol class="companies" start="201">');
		expect(last).toContain('Showing 201 to 205 of 205.');
		const ids = [...last.matchAll(/<li class="company [^"]*" id="c-([^"]+)"/g)].map((m) => m[1]);
		expect(ids.slice(-2).sort()).toEqual(['u-0', 'u-1']);
		// A page past the end is the last page, not an empty one.
		expect(numbersOf(await (await SELF.fetch(`${ORIGIN}/upstream?page=9`)).text())).toEqual([201, 202, 203, 204, 205]);
		// Each page is its own url, filed by the edge cache under its own key.
		expect(last).toContain('<link rel="canonical" href="/upstream?page=3">');
		expect(html).toContain('<link rel="canonical" href="/upstream">');

		// Narrowed below a page: every row listed, no pager.
		const few = await (await SELF.fetch(`${ORIGIN}/upstream?q=Undated`)).text();
		expect(few).not.toContain('class="pager"');
		expect(numbersOf(few)).toEqual([1, 2]);
		expect(few).toContain('<ol class="companies" start="1">');

		// The file is every row, not one page.
		const csv = await (await SELF.fetch(`${ORIGIN}/upstream/export.csv`)).text();
		expect(csv.trim().split('\r\n')).toHaveLength(206);
	});
});

describe('the robotics picks view', () => {
	it('renders from the file alone, labelled as a hand-made view, and is not indexed', async () => {
		const res = await SELF.fetch(`${ORIGIN}/upstream/picks/robotics`);
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('<meta name="robots" content="noindex">');
		expect(html).toContain('A view made for my Kalaari Fellowship application. Checked by hand on 23 Sep 2026 from public sources. I have not spoken to either founder.');
		// Close is a plain link: a reader arriving from a form has no history to go back to.
		expect(html).toMatch(/<a class="picks-close" href="\/upstream" aria-label="[^"]+">/);
		expect(html).not.toContain('history.back');
		// Title, thesis, the funnel in order, then the two cards in file order, each linked to its record.
		expect(html).toContain('<h1>Two robotics companies I would look at first</h1>');
		expect([...html.matchAll(/<span class="funnel-n">(\d+)<\/span>/g)].map((m) => m[1])).toEqual(['115', '10', '2']);
		expect(html.indexOf('id="vctr-labs"')).toBeLessThan(html.indexOf('id="umarobotics-technology"'));
		expect(html).toContain('href="/upstream/c/vctr-labs"');
		expect(html).toContain('href="/upstream/c/umarobotics-technology"');
		for (const h of ['Why I&#39;d look', 'Risk', 'First question']) expect(html).toContain(`<h3>${h}</h3>`);
		// The opinions are the author's, and say so.
		expect(html.match(/My read, not a finding of Upstream/g)).toHaveLength(2);
		// A company's own claim is tagged apart from anything checked.
		const claims = html.slice(html.indexOf('<th scope="row">Claims</th>'), html.indexOf('</tr>', html.indexOf('<th scope="row">Claims</th>')));
		expect(claims).toContain('<span class="basis basis-unverified">self-reported, not verified</span>');
		expect(html).toContain('<span class="basis basis-record">government record</span>');
		expect(html).toContain('<span class="basis basis-checked">checked by hand</span>');
		// Plain words: AGV/AMR is said once in full, and so is every other acronym.
		expect(html.match(/self-driving carts? \(AGV\/AMR\)/g)).toHaveLength(1);
		for (const gloss of ['CNC (computer-controlled)', 'CEO (chief executive)', 'MeitY (Ministry of Electronics and Information Technology)', 'CIN, the company identification number,']) expect(html).toContain(gloss);
		expect(html).toContain('Both overlap with Peer Robotics');
		expect(html).toContain('<a href="/upstream">&larr; All of Upstream</a>');
	});

	it('lays a hand check over the ingested row on the company page, and a nightly run cannot undo it', async () => {
		const seed = () =>
			post({
				source: 'sine-iitb',
				companies: [
					{ id: 'vctr-labs', name: 'VCTR Labs Private Limited', website: 'https://getvectorbots.com/', website_identity: 'associated', website_identity_note: 'name not in the domain' },
					{ id: 'umarobotics-technology', name: 'Umarobotics Technology Private Limited' },
				],
			});
		await seed();
		await seed(); // the nightly run, writing the same rows again
		const vctr = await (await SELF.fetch(`${ORIGIN}/upstream/c/vctr-labs`)).text();
		expect(vctr).toContain('checked by hand 23 Sep 2026: page authored by VCTR Labs, names SINE IIT Bombay');
		expect(vctr).toContain('<a class="fact-site" href="https://getvectorbots.com/"');
		expect(vctr).not.toContain('Website not confirmed.');
		const row = await env.DB.prepare("SELECT website_identity FROM companies WHERE id = 'vctr-labs'").first<{ website_identity: string }>();
		expect(row!.website_identity).toBe('associated');
		const uma = await (await SELF.fetch(`${ORIGIN}/upstream/c/umarobotics-technology`)).text();
		expect(uma).toContain('<span>Incorporated 28 Aug 2021 (MCA)</span>');
		expect(uma).not.toContain('founding year unknown');
	});
});

describe('registry and website enrichment', () => {
	type Rec = {
		id: string;
		registry: { cin: string; legal_name: string; incorporated_on: string | null; incorporated_year: number | null; status: string | null; state: string | null; source_url: string; match_note?: string } | null;
		registry_reason?: string | null;
		website?: { url: string; identity: string; source_url: string } | null;
		website_reason?: string | null;
		product?: { quote: string; source_url: string } | null;
		product_reason?: string | null;
		claims?: { quote: string; source_url: string }[];
		checked_by_person?: boolean;
	};
	// The same mapping scripts/load_enrichment.py writes.
	async function enrich(rec: Rec) {
		const r = rec.registry;
		await env.DB.prepare(
			`INSERT OR REPLACE INTO company_enrichment (id, cin, legal_name, incorporated_on, incorporated_year, reg_status, reg_state, reg_source, reg_note, reg_reason,
			   site_url, site_identity, site_source, site_reason, product_quote, product_source, product_reason, claims_json, checked_by_person, enriched_on)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, '2026-09-23')`,
		)
			.bind(
				rec.id, r?.cin ?? null, r?.legal_name ?? null, r?.incorporated_on ?? null, r?.incorporated_year ?? null, r?.status ?? null, r?.state ?? null, r?.source_url ?? null,
				r?.match_note ?? null, rec.registry_reason ?? null, rec.website?.url ?? null, rec.website?.identity ?? null, rec.website?.source_url ?? null, rec.website_reason ?? null,
				rec.product?.quote ?? null, rec.product?.source_url ?? null, rec.product_reason ?? null, JSON.stringify(rec.claims ?? []), rec.checked_by_person ? 1 : 0,
			)
			.run();
	}
	const solinas: Rec = {
		id: 'solinas-integrity',
		registry: { cin: 'U72900TN2018PTC121452', legal_name: 'SOLINAS INTEGRITY PRIVATE LIMITED', incorporated_on: '2018-03-15', incorporated_year: 2018, status: 'Active', state: 'Tamil Nadu', source_url: 'https://www.instafinancials.com/company/solinas-integrity-private-limited-U72900TN2018PTC121452' },
		website: { url: 'http://solinas.in/', identity: 'names company', source_url: 'https://solinas.in/' },
		product: { quote: 'Through state-of-the-art inspection, cleaning, and digitization, we are making operations and maintenance of water pipelines, sewers, stormwater drains, manholes, and septic tanks smarter and safer.', source_url: 'https://solinas.in/' },
		claims: [{ quote: 'Characterized > 50 Biosimilar Products', source_url: 'https://solinas.in/' }],
	};
	const coin: Rec = {
		id: 'coin-mobile-technologies',
		registry: { cin: 'U74999MH2014PTC260317', legal_name: 'COIN MOBILE TECHNOLOGIES PRIVATE LIMITED', incorporated_on: '2014-12-22', incorporated_year: 2014, status: 'Strike Off', state: 'Maharashtra', source_url: 'https://www.filesure.in/company/coin-mobile-technologies-private-limited/U74999MH2014PTC260317' },
		website_reason: 'no website found',
		product_reason: 'no company website',
	};
	// Struck off, but registered inside the window, so only the status takes it out.
	const struckRecent: Rec = { ...coin, id: 'struck-recent', registry: { ...coin.registry!, cin: 'U74999MH2024PTC260317', incorporated_on: '2024-01-02', incorporated_year: 2024 } };
	const seed = async () => {
		await post({
			source: 'rtbi-iitm',
			companies: [
				{ id: 'solinas-integrity', name: 'Solinas Integrity Private Limited', origin_year: THIS_YEAR - 1, description: 'Pipe inspection robots.', trace_count: 1 },
				{ id: 'coin-mobile-technologies', name: 'Coin Mobile Technologies', origin_year: THIS_YEAR - 1, description: 'Payments hardware.' },
				{ id: 'struck-recent', name: 'Struck Recent', origin_year: THIS_YEAR - 1, description: 'Sensors.' },
				{ id: 'plain-co', name: 'Plain Co', origin_year: THIS_YEAR - 1, description: 'Drones.' },
				{ id: 'quiet-co', name: 'Quiet Co', origin_year: THIS_YEAR - 1 },
			],
			signals: ['solinas-integrity', 'coin-mobile-technologies', 'struck-recent', 'plain-co', 'quiet-co'].map((id) => ({ company_id: id, type: 'incubator', label: 'IITM cohort' })),
		});
	};
	const ids = (html: string) => [...html.matchAll(/<li class="company [^"]*" id="c-([^"]+)"/g)].map((m) => m[1]).sort();
	const page = async (qs = '') => (await SELF.fetch(`${ORIGIN}/upstream${qs}`)).text();

	it('leaves trace_count and tier exactly as they were, before and after loading, and after the next ingest', async () => {
		await seed();
		const snap = async () => (await env.DB.prepare("SELECT id, trace_count, tier, first_seen FROM companies ORDER BY id").all()).results;
		const before = await snap();
		for (const r of [solinas, coin, struckRecent]) await enrich(r);
		expect(await snap()).toEqual(before);
		await seed(); // the nightly run, writing the same rows again
		expect(await snap()).toEqual(before);
		// And the enrichment is still there: the ingest never touches it.
		expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM company_enrichment').first<{ n: number }>())!.n).toBe(3);
	});

	it('lists a company registered before the window with a badge, and the five-year toggle takes it out', async () => {
		await seed();
		await enrich(solinas);
		const all = await page();
		expect(ids(all)).toContain('solinas-integrity');
		const row = all.slice(all.indexOf('id="c-solinas-integrity"'), all.indexOf('</li>', all.indexOf('id="c-solinas-integrity"')));
		expect(row).toContain('<span class="badge">started 2018</span>');
		// The registry's date is the row's date, and the row says whose date it is.
		expect(row).toContain('registered Mar 2018 (government registry)');
		const recent = await page('?age=recent');
		expect(ids(recent)).not.toContain('solinas-integrity');
		expect(recent).toMatch(/>1 started before \d{4}, by government registry date<\/a>/);
	});

	it('lists a struck-off company with a badge, and Status = Active or unknown takes it out', async () => {
		await seed();
		await enrich(struckRecent);
		const all = await page();
		expect(ids(all)).toContain('struck-recent');
		expect(all.slice(all.indexOf('id="c-struck-recent"'), all.indexOf('</li>', all.indexOf('id="c-struck-recent"')))).toContain('<span class="badge">struck off</span>');
		expect(all).toContain('<option value="" selected>Any</option><option value="active">Active or unknown</option>');
		// An old link that asked for every status still works.
		expect(ids(await page('?status=any'))).toContain('struck-recent');
		const active = await page('?status=active');
		expect(ids(active)).not.toContain('struck-recent');
		expect(active).toContain('Struck-off companies hidden');
		expect(active).toMatch(/>1 struck off or closed<\/a>/);
		const company = await (await SELF.fetch(`${ORIGIN}/upstream/c/struck-recent`)).text();
		expect(company).toContain('<p class="enrich-struck">The government registry lists this company as struck off.</p>');
	});

	it('shows every enrichment fact on the company page with its source link, and the company&rsquo;s words as its quotes', async () => {
		await seed();
		await enrich(solinas);
		const html = await (await SELF.fetch(`${ORIGIN}/upstream/c/solinas-integrity`)).text();
		const block = html.slice(html.indexOf('<section class="enrich"'), html.indexOf('</section>', html.indexOf('<section class="enrich"')));
		expect(block).toContain('<h2 id="enrich-h">Registry and website</h2>');
		expect(block).toContain('Registered as <strong>SOLINAS INTEGRITY PRIVATE LIMITED</strong> on 15 Mar 2018 &middot; Active &middot; Tamil Nadu');
		expect(block).toContain('government registry record (via instafinancials.com)');
		expect(block).toContain('<span class="enrich-id">Company identification number (CIN) U72900TN2018PTC121452</span>');
		// Each fact element (registry, website, quote, each claim) carries a source link.
		const facts = [...block.matchAll(/<(p class="enrich-(?:reg|site)"|figure class="enrich-quote"|li)>?[\s\S]*?<\/(p|figure|li)>/g)].map((m) => m[0]);
		expect(facts).toHaveLength(4);
		for (const fact of facts) expect(fact).toMatch(/class="enrich-src" href="https?:\/\//);
		expect(block).toContain('Website: <a href="http://solinas.in/"');
		expect(block).toContain('<span class="enrich-basis">names the company</span>');
		// The company's own words: a quote attributed to them, never Upstream's statement.
		expect(block).toMatch(/<blockquote data-source="company">Through state-of-the-art inspection/);
		expect(block).toContain('Quoted <a class="enrich-src" href="https://solinas.in/" rel="noopener nofollow">from their website</a>');
		expect(block).toMatch(/<q data-source="company">Characterized &gt; 50 Biosimilar Products<\/q> <span class="enrich-tag">self-reported<\/span>/);
		expect(block).toContain('Gathered automatically from public sources on 23 Sep 2026. Not checked by a person.');
	});

	it('says what was not found, in plain words, and marks an ambiguous match and an LLP', async () => {
		await post({ source: 'rtbi-iitm', companies: ['uniurja', 'roha', 'coin-mobile-technologies'].map((id) => ({ id, name: id, origin_year: THIS_YEAR })) });
		await enrich(coin);
		await enrich({ id: 'uniurja', registry: null, registry_reason: 'ambiguous: UNIURJA PRIVATE LIMITED (BR, struck off), UNIURJA LABS PRIVATE LIMITED (UP)', website_reason: 'no website found', product_reason: 'no confirmed company website' });
		await enrich({
			id: 'roha',
			registry: { cin: 'AAU-0767', legal_name: 'ROHA PRECISION SYSTEMS DEVELOPMENT LLP', incorporated_on: '2020-10-06', incorporated_year: 2020, status: 'Converted and Dissolved', state: 'West Bengal', source_url: 'https://www.falconebiz.com/LLP/ROHA-PRECISION-SYSTEMS-DEVELOPMENT-LLP-AAU-0767' },
			product_reason: 'no company website',
			website_reason: 'no website found',
		});
		const c = await (await SELF.fetch(`${ORIGIN}/upstream/c/coin-mobile-technologies`)).text();
		expect(c).toContain('<p class="enrich-missing">Website: not found (no website found)</p>');
		expect(c).toContain('<p class="enrich-missing">What they say they build: not found (no company website)</p>');
		const u = await (await SELF.fetch(`${ORIGIN}/upstream/c/uniurja`)).text();
		expect(u).toContain('<p class="enrich-missing">Registry record: two records could match, so neither is shown (ambiguous: UNIURJA PRIVATE LIMITED (BR, struck off), UNIURJA LABS PRIVATE LIMITED (UP))</p>');
		const r = await (await SELF.fetch(`${ORIGIN}/upstream/c/roha`)).text();
		expect(r).toContain('Registered as an LLP: <strong>ROHA PRECISION SYSTEMS DEVELOPMENT LLP</strong>');
		expect(r).toContain('<span class="enrich-id">LLP number AAU-0767</span>');
		expect(r).toContain('lists this company as converted and dissolved.');
	});

	it('says a hand-checked record was checked by hand, and drops "no person has checked it" there', async () => {
		await post({ source: 'sine-iitb', companies: [{ id: 'umarobotics-technology', name: 'Umarobotics', origin_year: THIS_YEAR, description: 'Robots that move totes.' }] });
		await enrich({
			id: 'umarobotics-technology',
			registry: { cin: 'U72900UR2021PTC012847', legal_name: 'UMAROBOTICS TECHNOLOGY PRIVATE LIMITED', incorporated_on: '2021-08-28', incorporated_year: 2021, status: 'Active', state: 'Uttarakhand', source_url: 'https://www.zaubacorp.com/UMAROBOTICS-TECHNOLOGY-PRIVATE-LIMITED-U72900UR2021PTC012847' },
			website: { url: 'https://umarobotics.com/', identity: 'names company', source_url: 'https://umarobotics.com/' },
			product_reason: 'none',
			checked_by_person: true,
		});
		const html = await (await SELF.fetch(`${ORIGIN}/upstream/c/umarobotics-technology`)).text();
		expect(html).toContain('<p class="enrich-foot">Checked by hand on 23 Sep 2026.</p>');
		expect(html).not.toContain('No person has checked it');
		// 2021 is inside the window by the year-based rule, so it stays in the default view.
		expect(ids(await page())).toContain('umarobotics-technology');
	});

	it('uses the company&rsquo;s quote on a list row only when the row has no description, and says whose words they are', async () => {
		await seed();
		await enrich({ id: 'quiet-co', registry: null, registry_reason: 'no registry record found', product: { quote: 'We build quiet pumps.', source_url: 'https://quiet.example/' } });
		await enrich({ id: 'plain-co', registry: null, registry_reason: 'no registry record found', product: { quote: 'Not shown: the row has its own description.', source_url: 'https://plain.example/' } });
		const html = await page('?described=all');
		const row = (id: string) => html.slice(html.indexOf(`id="c-${id}"`), html.indexOf('</li>', html.indexOf(`id="c-${id}"`)));
		expect(row('quiet-co')).toContain('<q data-source="company">We build quiet pumps.</q> <a class="from-site" href="https://quiet.example/" rel="noopener nofollow">(from their site)</a>');
		expect(row('plain-co')).not.toContain('Not shown');
		// Not a classification: the sub-sector and the order are the pipeline's.
		expect((await env.DB.prepare("SELECT subsector_id FROM companies WHERE id = 'quiet-co'").first<{ subsector_id: string | null }>())!.subsector_id).toBe(null);
	});

	it('explains the enrichment on the methodology page with counts from the table', async () => {
		await seed();
		for (const r of [solinas, coin, struckRecent]) await enrich(r);
		await env.DB.prepare("INSERT OR REPLACE INTO enrichment_meta (version, method, count) VALUES ('2026-09-23', 'Enriched on 23 Sep 2026 by automated web lookup.', 3)").run();
		const html = await (await SELF.fetch(`${ORIGIN}/upstream/about`)).text();
		const section = html.slice(html.indexOf('id="enrichment"'), html.indexOf('</section>', html.indexOf('id="enrichment"')));
		expect(section).toContain('<h2 id="checks-h">What we check</h2>');
		expect(section).toMatch(/Of 3 records looked up, \d+ matched a registry record; \d+ were ambiguous or not found\. 2 started before \d{4} by registry date, and 2 are listed as struck off or closed\./);
		expect(section).toContain('None of these checks changes the order: a registry lookup is Upstream&#39;s own work and doesn&#39;t count as a public record of the company.');
	});
});

describe('no recommendation language', () => {
	/**
	 * The list says where public information is thinnest, never which companies to back. Every
	 * public page the Worker draws is read as text, with the scraped fields (names, descriptions,
	 * quotes) taken out, and none of these words may appear in what is left. The picks page is the
	 * author's opinion by design, and it must say so on each card.
	 */
	const PHRASES = [
		/\brecommend/i,
		/\bworth (?:your|a|the) (?:next )?(?:research )?(?:call|look|time|money)/i,
		/\btop picks?\b/i,
		/\bbest (?:companies|startups|bets?|picks?)\b/i,
		/\bpromising\b/i,
		/\bhigh[- ]potential\b/i,
		/\bmust[- ]see\b/i,
		/\bhot (?:startups?|companies|deals?)\b/i,
		/\bshould (?:invest|call|back|fund)\b/i,
		/\bread these first\b/i,
		/\bwinners?\b/i,
	];
	const prose = (html: string) =>
		html
			.replace(/<script[\s\S]*?<\/script>/g, ' ')
			.replace(/<style[\s\S]*?<\/style>/g, ' ')
			.replace(/<textarea[\s\S]*?<\/textarea>/g, ' ')
			// Scraped and quoted text is the sources' and the companies' words, not the page's.
			.replace(/<(p|blockquote|q) class="(?:builds[^"]*|desc|note-verbatim)"[\s\S]*?<\/\1>/g, ' ')
			.replace(/<blockquote data-source="company">[\s\S]*?<\/blockquote>/g, ' ')
			.replace(/<q data-source="company">[\s\S]*?<\/q>/g, ' ')
			.replace(/<[^>]+>/g, ' ')
			.replace(/\s+/g, ' ');
	const flagged = (text: string) => PHRASES.flatMap((re) => [...text.matchAll(new RegExp(re.source, 'gi'))].map((m) => text.slice(Math.max(0, m.index! - 60), m.index! + 60)));

	it('never tells a reader which companies to back, on the list, the methodology or a company page', async () => {
		await post({
			source: 'sine-iitb',
			companies: [{ id: 'plain-co', name: 'Plain Co', description: 'The best, most promising sensors. We recommend them.', sector_id: '2', subsector_id: '2.2' }],
			signals: [{ company_id: 'plain-co', type: 'incubator', label: 'SINE cohort' }],
		});
		for (const path of ['/upstream', '/upstream?age=recent&kind=company&described=said', '/upstream/about', '/upstream/c/plain-co']) {
			const html = await (await SELF.fetch(`${ORIGIN}${path}`)).text();
			expect(flagged(prose(html)), path).toEqual([]);
		}
		// The limit is said where a reader decides, on the list and the methodology page.
		expect(await (await SELF.fetch(`${ORIGIN}/upstream`)).text()).toContain('Whether a company is any good, you&#39;ll only learn by talking to the founder.');
		expect(await (await SELF.fetch(`${ORIGIN}/upstream/about`)).text()).toContain('The ranking hasn&#39;t been tested against outcomes.');
	});

	it('labels every opinion on the picks page as the author&rsquo;s', async () => {
		const html = await (await SELF.fetch(`${ORIGIN}/upstream/picks/robotics`)).text();
		const cards = html.match(/<article class="pick"/g) ?? [];
		expect(html.match(/My read, not a finding of Upstream/g)).toHaveLength(cards.length);
	});
});
