/**
 * Seven invented companies, used only by /upstream?demo=1 so the row design can be
 * checked before any real data lands (CHECKPOINT 7). Seven rather than five because
 * a date now has three states worth looking at: found by us, taken from a cohort
 * year, and unknown.
 *
 * These are NOT real companies and must never appear on the page unasked: the page
 * renders them only for that explicit query parameter, and always behind a banner
 * saying so. Delete this file once the ingest in Part 10 is producing real rows.
 */
import { NO_GAP_NAMED, splitGaps, type Buckets, type Company, type Gaps, type ProductOutcomes, type RegisterOutcomes } from './db';
import { minOriginYear } from './rank';

/** Dates are written relative to render time so the "first seen N days ago" line stays sane. */
function daysAgo(n: number): string {
	return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

export function demoCompanies(): Company[] {
	return [
		{
			id: 'verve-aerospace',
			name: 'Verve Aerospace Private Limited',
			description: 'Small reusable launch vehicles for sub-orbital payloads.',
			website: null,
			website_checked: 1,
			city: 'Bengaluru',
			state: 'Karnataka',
			cin: 'U35100KA2026PTC000000',
			founded_year: 2026,
			origin_year: 2026,
			sector_id: '2',
			subsector_id: '2.5',
			project_type: 'Launch vehicle and satellite subsystem development',
			classify_note: 'Sub-orbital launch vehicles — space technologies.',
			classify_basis: 'description',
			product: null,
			product_status: null,
			website_identity: null,
			website_identity_note: null,
			entity_type: 'company',
			entity_note: 'a source lists it with a legal suffix',
			founders: null,
			founders_source: null,
			dpiit_status: null,
			dpiit_stage: null,
			contact_email: null,
			contact_page: null,
			domain_registered: null,
			papers: null,
			source_year: null,
			source_year_type: null,
			first_seen: daysAgo(12),
			first_seen_basis: 'discovered',
			discovered: daysAgo(12),
			trace_count: 1,
			tier: 'A',
			updated_at: daysAgo(0),
			signals: [
				{ type: 'incubator', label: 'SINE IIT-B cohort 2026', url: 'https://sineiitb.org/', date: daysAgo(12) },
				{ type: 'incorporation', label: 'incorporated 2026-03', url: null, date: '2026-03-04' },
			],
		},
		{
			id: 'thaara-electrolysers',
			name: 'Thaara Electrolysers Private Limited',
			description: 'Anion-exchange-membrane electrolyser stacks built for intermittent renewable input.',
			website: null,
			website_checked: 1,
			city: 'Chennai',
			state: 'Tamil Nadu',
			cin: 'U40100TN2026PTC000000',
			founded_year: 2026,
			origin_year: 2026,
			sector_id: '1',
			subsector_id: '1.5',
			project_type: 'Green hydrogen production and storage',
			classify_note: 'Electrolyser hardware — hydrogen economy.',
			classify_basis: 'description',
			product: null,
			product_status: null,
			website_identity: null,
			website_identity_note: null,
			entity_type: 'company',
			entity_note: 'a source lists it with a legal suffix',
			founders: null,
			founders_source: null,
			dpiit_status: null,
			dpiit_stage: null,
			contact_email: null,
			contact_page: null,
			domain_registered: null,
			papers: null,
			source_year: null,
			source_year_type: null,
			first_seen: daysAgo(31),
			first_seen_basis: 'discovered',
			discovered: daysAgo(31),
			trace_count: 2,
			tier: 'A',
			updated_at: daysAgo(0),
			signals: [
				{ type: 'grant', label: 'BIRAC BIG round 2026', url: 'https://birac.nic.in/', date: daysAgo(31) },
				{ type: 'incubator', label: 'IITM RTBI cohort 2026', url: 'https://rtbi.in/', date: daysAgo(28) },
			],
		},
		{
			id: 'kadamb-biolabs',
			name: 'Kadamb Biolabs Private Limited',
			description: 'Cell-free protein expression kits for diagnostics manufacturers.',
			website: 'https://example.invalid/kadamb',
			website_checked: 1,
			city: 'Hyderabad',
			state: 'Telangana',
			cin: 'U73100TG2026PTC000000',
			founded_year: 2025,
			origin_year: 2025,
			sector_id: '4',
			subsector_id: '4.2',
			project_type: 'Affordable diagnostics and medical devices',
			classify_note: 'Reagents for diagnostics — bio and health.',
			classify_basis: 'description',
			product: 'Benchtop assay kits that let a district hospital run antimicrobial-resistance panels without a reference lab.',
			product_status: 'described',
			website_identity: 'verified',
			website_identity_note: "given in the company's own source record, with the company's name in the domain",
			entity_type: 'company',
			entity_note: 'a source lists it with a legal suffix',
			founders: null,
			founders_source: null,
			dpiit_status: null,
			dpiit_stage: null,
			contact_email: null,
			contact_page: null,
			domain_registered: null,
			papers: null,
			source_year: null,
			source_year_type: null,
			first_seen: daysAgo(74),
			first_seen_basis: 'discovered',
			discovered: daysAgo(74),
			trace_count: 3,
			tier: 'B',
			updated_at: daysAgo(0),
			signals: [
				{ type: 'incubator', label: 'ITIC IIT Hyderabad', url: 'https://iticincubator.in/', date: daysAgo(74) },
				{ type: 'website', label: 'website live', url: 'https://example.invalid/kadamb', date: daysAgo(40) },
				{ type: 'patent', label: 'IN patent application filed', url: null, date: daysAgo(60) },
			],
		},
		{
			id: 'nistara-grid',
			name: 'Nistara Grid Systems Private Limited',
			description: 'Sodium-ion packs for distribution-level storage in areas with weak grid backup.',
			website: null,
			website_checked: 1,
			city: 'Pune',
			state: 'Maharashtra',
			cin: 'U31900MH2026PTC000000',
			founded_year: 2026,
			origin_year: 2026,
			sector_id: '1',
			subsector_id: '1.4',
			project_type: 'Grid-scale and distributed storage systems',
			classify_note: 'Sodium-ion storage hardware — energy storage.',
			classify_basis: 'description',
			product: null,
			product_status: null,
			website_identity: null,
			website_identity_note: null,
			entity_type: 'company',
			entity_note: 'a source lists it with a legal suffix',
			founders: null,
			founders_source: null,
			dpiit_status: null,
			dpiit_stage: null,
			contact_email: null,
			contact_page: null,
			domain_registered: null,
			papers: null,
			source_year: null,
			source_year_type: null,
			first_seen: daysAgo(5),
			first_seen_basis: 'discovered',
			discovered: daysAgo(5),
			trace_count: 0,
			tier: 'A',
			updated_at: daysAgo(0),
			signals: [{ type: 'incorporation', label: 'incorporated 2026-08', url: null, date: '2026-08-19' }],
		},
		{
			id: 'anvaya-silicon',
			name: 'Anvaya Silicon Private Limited',
			description: 'RISC-V control cores hardened for industrial temperature ranges.',
			website: 'https://example.invalid/anvaya',
			website_checked: 1,
			city: 'Bengaluru',
			state: 'Karnataka',
			cin: 'U72900KA2025PTC000000',
			founded_year: 2025,
			origin_year: 2026,
			sector_id: '2',
			subsector_id: '2.1',
			project_type: 'Semiconductor design and fabrication',
			classify_note: 'Processor IP design — semiconductors.',
			classify_basis: 'description',
			product: null,
			product_status: 'unreachable',
			website_identity: 'associated',
			website_identity_note: "given in the company's own source record; the homepage could not be read to check the name",
			entity_type: 'company',
			entity_note: 'a source lists it with a legal suffix',
			founders: null,
			founders_source: null,
			dpiit_status: null,
			dpiit_stage: null,
			contact_email: null,
			contact_page: null,
			domain_registered: null,
			papers: null,
			source_year: null,
			source_year_type: null,
			first_seen: '2026-01-01',
			first_seen_basis: 'cohort',
			discovered: daysAgo(212),
			trace_count: 5,
			tier: 'C',
			updated_at: daysAgo(0),
			// No website trace: the domain is unreachable, and a dead domain is not one.
			signals: [
				{ type: 'incubator', label: 'IISc incubation', url: 'https://iisc.ac.in/', date: daysAgo(212) },
				{ type: 'press', label: 'covered in a trade weekly', url: 'https://example.invalid/press', date: daysAgo(120) },
			],
		},
		{
			id: 'saral-hydro',
			name: 'Saral Hydro Systems Private Limited',
			description: 'Micro-hydro turbines for canal drops, installed across three states.',
			website: 'https://example.invalid/saral',
			website_checked: 1,
			city: 'Dehradun',
			state: 'Uttarakhand',
			cin: 'U40100UR2013PTC000000',
			founded_year: 2013,
			origin_year: 2013,
			sector_id: '1',
			subsector_id: '1.2',
			project_type: 'Renewable generation and integration',
			classify_note: 'Micro-hydro generation — renewables.',
			classify_basis: 'description',
			product: null,
			product_status: 'thin',
			website_identity: 'verified',
			website_identity_note: "given in the company's own source record, with the company's name in the domain",
			entity_type: 'company',
			entity_note: 'a source lists it with a legal suffix',
			founders: null,
			founders_source: null,
			dpiit_status: null,
			dpiit_stage: null,
			contact_email: null,
			contact_page: null,
			domain_registered: null,
			papers: null,
			source_year: null,
			source_year_type: null,
			first_seen: '2013-01-01',
			first_seen_basis: 'cohort',
			discovered: daysAgo(212),
			trace_count: 4,
			tier: 'C',
			updated_at: daysAgo(0),
			signals: [
				{ type: 'incubator', label: 'IITM RTBI portfolio', url: 'https://rtbi.in/', date: null },
				{ type: 'website', label: 'website live', url: 'https://example.invalid/saral', date: daysAgo(300) },
			],
		},
		{
			id: 'pravaha-filtration',
			name: 'Pravaha Filtration Private Limited',
			description: 'Ceramic membrane filtration for small municipal water utilities.',
			website: 'https://example.invalid/pravaha',
			website_checked: 0,
			city: null,
			state: null,
			cin: null,
			founded_year: null,
			origin_year: null,
			sector_id: '3',
			subsector_id: '3.3',
			project_type: 'Water treatment and reuse',
			classify_note: 'Membrane filtration — water security.',
			classify_basis: 'register-label',
			// The one row that shows what this column is for: placed from a register
			// label, so the source's own line is a dropdown choice, and the homepage
			// is the only thing here that says what the company actually makes.
			product: 'Ceramic membrane modules that let a small municipal utility run filtration without a chemical dosing plant.',
			product_status: 'described',
			website_identity: 'verified',
			website_identity_note: "given in the company's own source record, with the company's name in the domain",
			entity_type: 'company',
			entity_note: 'a source lists it with a legal suffix',
			founders: null,
			founders_source: null,
			dpiit_status: null,
			dpiit_stage: null,
			contact_email: null,
			contact_page: null,
			domain_registered: null,
			papers: null,
			source_year: null,
			source_year_type: null,
			first_seen: null,
			first_seen_basis: null,
			discovered: daysAgo(212),
			trace_count: 2,
			tier: 'C',
			updated_at: daysAgo(0),
			signals: [{ type: 'incubator', label: 'IITM RTBI portfolio', url: 'https://rtbi.in/', date: null }],
		},
	];
}

/**
 * The same three-way split the SQL does, applied in TypeScript so the demo shows the
 * real page rather than a tidier one: ranked, older than the age gate, and undated.
 */
export function splitDemo(companies: Company[], now: Date): { ranked: Company[]; undated: Company[]; buckets: Buckets } {
	const cutoff = minOriginYear(now);
	const origin = (c: Company) => c.origin_year ?? c.founded_year;

	const undated = companies.filter((c) => c.first_seen === null);
	const dated = companies.filter((c) => c.first_seen !== null);
	const older = dated.filter((c) => (origin(c) ?? cutoff) < cutoff);
	const ranked = dated.filter((c) => (origin(c) ?? cutoff) >= cutoff);

	return {
		ranked,
		undated,
		buckets: {
			total: companies.length,
			ranked: ranked.length,
			older: older.length,
			undated: undated.length,
			// The sample is not tier-filtered: every dated recent row is on screen.
			tierHidden: 0,
			unknownAge: ranked.filter((c) => c.origin_year === null && c.founded_year === null).length,
		},
	};
}

/** Three invented holes, so the off-map section can be seen before real data lands. */
/** The register split, in the same proportions the real one shows. */
export function demoRegisterOutcomes(): RegisterOutcomes {
	return { total: 12, placed: 5, taxonomyGap: 5, undescribed: 2 };
}

/**
 * What the seven demo companies came to when we read their websites.
 *
 * Counted from the rows themselves rather than typed, so the paragraph under the
 * demo list and the demo list cannot disagree — which is the same rule the real page
 * follows, and the one a sample is most tempting to break.
 */
export function demoProductOutcomes(): ProductOutcomes {
	const companies = demoCompanies();
	const count = (status: string) => companies.filter((c) => c.product_status === status).length;
	return {
		total: companies.length,
		withSite: companies.filter((c) => Boolean(c.website)).length,
		described: count('described'),
		unreachable: count('unreachable'),
		refused: count('refused'),
		thin: count('thin'),
		unclear: count('unclear'),
		unverified: count('unverified'),
		notTheirs: companies.filter((c) => c.website_identity === 'discovered').length,
		noSite: companies.filter((c) => !c.website && c.website_checked === 1).length,
	};
}

export function demoGaps(): Gaps {
	// Both kinds, because a sample that showed only taxonomy holes would not
	// demonstrate the distinction the section is built around.
	return splitGaps([
		{ missing: 'water infrastructure', n: 3, examples: ['Ajivam Water Pvt Ltd', 'Botsrule Pvt Ltd'] },
		{ missing: 'geospatial services', n: 2, examples: ['Bhugol GIS Pvt Ltd'] },
		{ missing: 'digital health infrastructure', n: 2, examples: ['Chainworks Digital Pvt Ltd'] },
		{ missing: NO_GAP_NAMED, n: 4, examples: ['Sundar Systems Pvt Ltd', 'Meera Devices Pvt Ltd'] },
	]);
}
