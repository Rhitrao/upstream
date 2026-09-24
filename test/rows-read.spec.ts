/**
 * What a cold render of the default list costs in D1 rows read, on a database the size of the
 * real one: the 753 records of the 17 September snapshot, with their signal counts, and the
 * committed registry enrichment on top. The edge cache means this is paid once per data version
 * (and region), so the number that matters is the cold one.
 */
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/index';
import { describe, it, expect, beforeAll } from 'vitest';
import { SUBSECTORS } from '../src/taxonomy';
import snapshotCsv from '../docs/snapshot-2026-09-17.csv?raw';
import enrichmentSql from '../migrations/data/enrichment_2026-09-23.sql?raw';

const ORIGIN = 'https://rohitrao.in';

function parseCsv(text: string): Record<string, string>[] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	const src = text.replace(/^﻿/, '');
	for (let i = 0; i < src.length; i++) {
		const c = src[i];
		if (quoted) {
			if (c === '"' && src[i + 1] === '"') {
				field += '"';
				i++;
			} else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"') quoted = true;
		else if (c === ',') {
			row.push(field);
			field = '';
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && src[i + 1] === '\n') i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else field += c;
	}
	if (field || row.length) {
		row.push(field);
		rows.push(row);
	}
	const [head, ...body] = rows;
	return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const TYPES = ['incubator', 'dpiit', 'grant', 'award', 'website', 'press'];

async function seed() {
	const subByName = new Map(SUBSECTORS.map((s) => [`${s.sector_id}|${s.subsector}`, s.subsector_id]));
	const records = parseCsv(snapshotCsv);
	const now = new Date().toISOString();
	const statements: D1PreparedStatement[] = [];
	for (const r of records) {
		const id = r.page.split('/c/')[1];
		const own = r.builds_from ? r.builds : null;
		// The CSV prints a register label as the page does ("DPIIT recognised. Industry: ..."); the
		// database stores the classifier's wording, which is what marks it as a label.
		const description = (r.source_description || '').replace(/^(DPIIT recognised|DPIIT recognition (?:expired|cancelled)|Startup India profile, [^.]*|On the DPIIT Startup India register)\.(?= Industry:)/, 'DPIIT-recognised startup.') || null;
		statements.push(
			env.DB.prepare(
				`INSERT OR IGNORE INTO companies (id, name, description, product, website, website_identity, entity_type, dpiit_status, dpiit_stage, city, state,
				 sector_id, subsector_id, classify_basis, tier, trace_count, first_seen, first_seen_basis, origin_year, discovered, updated_at, programme_count)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				id, r.name, description, own, r.website || null, r.website_identity || null, r.entity_type || null, r.dpiit_status || null,
				r.dpiit_stage || null, r.city || null, r.state || null, r.rdi_sector || null, subByName.get(`${r.rdi_sector}|${r.rdi_subsector}`) ?? null,
				r.placed_from === 'register-label' ? 'register-label' : 'description', r.tier || 'C', Number(r.public_traces || 0), r.on_record || null,
				r.on_record ? r.on_record_basis || 'discovered' : null, r.started ? Number(r.started) : null, r.in_database || now.slice(0, 10), now,
				Number(r.programme_count || 0),
			),
		);
		for (let n = 0; n < Number(r.signals || 1); n++) {
			statements.push(
				env.DB.prepare('INSERT OR IGNORE INTO signals (company_id, type, label, date, url, source, found_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
					id, TYPES[n % TYPES.length], `${r.name} listing ${n}`, r.on_record || null, 'https://example.org/listing', 'sine-iitb', now,
				),
			);
		}
	}
	for (let i = 0; i < statements.length; i += 400) await env.DB.batch(statements.slice(i, i + 400));
	const enrich = enrichmentSql
		.split(/;\s*\n/)
		.map((s) => s.replace(/^\s*--.*$/gm, '').trim())
		.filter(Boolean)
		.map((s) => env.DB.prepare(s));
	for (let i = 0; i < enrich.length; i += 100) await env.DB.batch(enrich.slice(i, i + 100));
	return records.length;
}

async function cold(path: string) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(`${ORIGIN}${path}`), env as Env, ctx);
	const body = await response.text();
	await waitOnExecutionContext(ctx);
	return { rows: Number(response.headers.get('x-d1-rows-read')), heaviest: response.headers.get('x-d1-heaviest'), bytes: body.length, body };
}

describe('rows read for a cold default page, at the real size', () => {
	let seeded = 0;
	beforeAll(async () => {
		await env.DB.batch([env.DB.prepare('DELETE FROM signals'), env.DB.prepare('DELETE FROM companies'), env.DB.prepare('DELETE FROM company_enrichment')]);
		seeded = await seed();
	});

	it('lists every record, reads full rows for one page only, and stays within budget', async () => {
		expect(seeded).toBe(753);
		const page = await cold('/upstream');
		console.log(`[rows-read] /upstream: ${page.rows} rows, ${page.bytes} bytes`);
		console.log(`[rows-read] heaviest: ${page.heaviest}`);
		expect(page.body).toContain('<p class="result-line"><strong>753</strong> records match');
		expect((page.body.match(/<li class="company /g) ?? []).length).toBe(100);
		// Before this change a cold default page read 18,760 rows on this seed (216 rows drawn), and asking
		// the old code for every record read 13,326 and drew 200 of the 753.
		expect(page.rows).toBeLessThan(15_000);
		for (const path of ['/upstream?page=8', '/upstream?age=recent', '/upstream?age=recent&kind=company&described=said']) {
			const other = await cold(path);
			console.log(`[rows-read] ${path}: ${other.rows} rows, ${other.bytes} bytes`);
			// The five-year toggle reads a registry year per row; the old default's view reads 14,354 here.
			expect(other.rows).toBeLessThan(20_000);
		}
	});
});
