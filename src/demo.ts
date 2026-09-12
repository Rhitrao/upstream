/**
 * Five invented companies, used only by /upstream?demo=1 so the row design can be
 * checked before any real data lands (CHECKPOINT 7).
 *
 * These are NOT real companies and must never appear on the page unasked: the page
 * renders them only for that explicit query parameter, and always behind a banner
 * saying so. Delete this file once the ingest in Part 10 is producing real rows.
 */
import type { Company } from './db';

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
			city: 'Bengaluru',
			state: 'Karnataka',
			cin: 'U35100KA2026PTC000000',
			founded_year: 2026,
			sector_id: '2',
			subsector_id: '2.5',
			project_type: 'Launch vehicle and satellite subsystem development',
			classify_note: 'Sub-orbital launch vehicles — space technologies.',
			first_seen: daysAgo(12),
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
			city: 'Chennai',
			state: 'Tamil Nadu',
			cin: 'U40100TN2026PTC000000',
			founded_year: 2026,
			sector_id: '1',
			subsector_id: '1.5',
			project_type: 'Green hydrogen production and storage',
			classify_note: 'Electrolyser hardware — hydrogen economy.',
			first_seen: daysAgo(31),
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
			city: 'Hyderabad',
			state: 'Telangana',
			cin: 'U73100TG2026PTC000000',
			founded_year: 2025,
			sector_id: '4',
			subsector_id: '4.2',
			project_type: 'Affordable diagnostics and medical devices',
			classify_note: 'Reagents for diagnostics — bio and health.',
			first_seen: daysAgo(74),
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
			city: 'Pune',
			state: 'Maharashtra',
			cin: 'U31900MH2026PTC000000',
			founded_year: 2026,
			sector_id: '1',
			subsector_id: '1.4',
			project_type: 'Grid-scale and distributed storage systems',
			classify_note: 'Sodium-ion storage hardware — energy storage.',
			first_seen: daysAgo(5),
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
			city: 'Bengaluru',
			state: 'Karnataka',
			cin: 'U72900KA2025PTC000000',
			founded_year: 2025,
			sector_id: '2',
			subsector_id: '2.1',
			project_type: 'Semiconductor design and fabrication',
			classify_note: 'Processor IP design — semiconductors.',
			first_seen: daysAgo(212),
			trace_count: 6,
			tier: 'C',
			updated_at: daysAgo(0),
			signals: [
				{ type: 'incubator', label: 'IISc incubation', url: 'https://iisc.ac.in/', date: daysAgo(212) },
				{ type: 'press', label: 'covered in a trade weekly', url: 'https://example.invalid/press', date: daysAgo(120) },
				{ type: 'website', label: 'website live', url: 'https://example.invalid/anvaya', date: daysAgo(190) },
			],
		},
	];
}
