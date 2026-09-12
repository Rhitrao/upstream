import { env, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';

const KEY = 'test-ingest-key';
const ORIGIN = 'https://rohitrao.in';

async function clearDb() {
	await env.DB.batch([env.DB.prepare('DELETE FROM signals'), env.DB.prepare('DELETE FROM companies'), env.DB.prepare('DELETE FROM runs')]);
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

	it('inserts, then updates without touching first_seen', async () => {
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
					first_seen: '2026-01-10',
				},
			],
			signals: [{ company_id: 'verve-aerospace', type: 'incubator', label: 'SINE IIT-B cohort 2026' }],
		});
		expect(await first.json()).toMatchObject({
			inserted: 1,
			updated: 0,
			signals_added: 1,
			signals_skipped: 0,
		});

		const second = await post({
			source: 'sine_iitb',
			companies: [
				// A thinner record, and a later first_seen that must be ignored.
				{ id: 'verve-aerospace', name: 'Verve Aerospace Private Limited', first_seen: '2026-09-01' },
			],
			signals: [
				// The same signal again — the UNIQUE constraint must swallow it.
				{ company_id: 'verve-aerospace', type: 'incubator', label: 'SINE IIT-B cohort 2026' },
			],
		});
		expect(await second.json()).toMatchObject({ inserted: 0, updated: 1, signals_added: 0 });

		const row = await env.DB.prepare('SELECT * FROM companies WHERE id = ?').bind('verve-aerospace').first<any>();
		expect(row.first_seen).toBe('2026-01-10');
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
		const today = new Date().toISOString().slice(0, 10);
		await post({
			source: 'test',
			companies: [
				{ id: 'quiet', name: 'Quiet Co', first_seen: today },
				{ id: 'loud', name: 'Loud Co', first_seen: today },
				{ id: 'old', name: 'Old Co', first_seen: '2020-01-01' },
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

		const rows = await env.DB.prepare('SELECT id, trace_count, tier FROM companies ORDER BY id').all<any>();
		expect(rows.results).toEqual([
			{ id: 'loud', trace_count: 4, tier: 'B' },
			{ id: 'old', trace_count: 0, tier: 'C' },
			{ id: 'quiet', trace_count: 0, tier: 'A' },
		]);
	});
});

describe('GET /upstream/api/companies', () => {
	beforeEach(async () => {
		const today = new Date().toISOString().slice(0, 10);
		await post({
			source: 'test',
			companies: [
				{ id: 'a-new', name: 'A New', sector_id: '2', subsector_id: '2.5', first_seen: today },
				{ id: 'c-old', name: 'C Old', sector_id: '1', subsector_id: '1.1', first_seen: '2019-05-05' },
			],
		});
	});

	it('returns companies with parsed signals, tier first', async () => {
		const body = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies`)).json<any>();
		expect(body.count).toBe(2);
		expect(body.companies.map((c: any) => c.id)).toEqual(['a-new', 'c-old']);
		expect(body.companies[0].signals).toEqual([]);
	});

	it('filters by sector, subsector and tier', async () => {
		const one = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?sector=1`)).json<any>();
		expect(one.companies.map((c: any) => c.id)).toEqual(['c-old']);

		const two = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?subsector=2.5`)).json<any>();
		expect(two.companies.map((c: any) => c.id)).toEqual(['a-new']);

		const three = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?tier=a`)).json<any>();
		expect(three.companies.map((c: any) => c.id)).toEqual(['a-new']);

		const all = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?tier=all`)).json<any>();
		expect(all.count).toBe(2);
	});

	it('honours limit and rejects nonsense', async () => {
		const limited = await (await SELF.fetch(`${ORIGIN}/upstream/api/companies?limit=1`)).json<any>();
		expect(limited.count).toBe(1);

		expect((await SELF.fetch(`${ORIGIN}/upstream/api/companies?limit=0`)).status).toBe(400);
		expect((await SELF.fetch(`${ORIGIN}/upstream/api/companies?tier=Z`)).status).toBe(400);
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

	it('shows five sample companies behind a banner for ?demo=1 only', async () => {
		const plain = await page();
		expect(plain).not.toContain('Sample data');
		expect(plain).toContain('Nothing matches yet');

		const demo = await page('?demo=1');
		expect(demo).toContain('Sample data');
		expect(demo.match(/<li class="company">/g)).toHaveLength(5);
		expect(demo).toContain('Verve Aerospace Private Limited');
		// The four-word lesson in how the ranking works.
		expect(demo).toContain('no website yet');
		expect(demo).toContain('RDI 2.5 &mdash; Space Technologies');
	});

	it('defaults the tier toggle to A+B and honours the other choices', async () => {
		expect(await page()).toContain('<label class="seg on" title="The default view">');
		expect(await page('?tier=a')).toContain('<label class="seg on" title="New and quiet">');
		expect(await page('?tier=all')).toContain('<label class="seg on" title="Including known territory">');
	});

	it('applies the tier toggle to the list', async () => {
		const today = new Date().toISOString().slice(0, 10);
		await post({
			source: 'test',
			companies: [
				{ id: 'new-quiet', name: 'New Quiet', first_seen: today },
				{ id: 'old-known', name: 'Old Known', first_seen: '2019-01-01' },
			],
		});

		expect(await page('?tier=a')).not.toContain('Old Known');
		expect(await page('?tier=all')).toContain('Old Known');
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
