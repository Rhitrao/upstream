/**
 * Facts checked by hand, laid over a company's ingested row when its page is drawn.
 *
 * Kept here, in the code, rather than written into the companies table: the nightly ingest
 * rewrites those rows, and a hand check stored there would be quietly undone the next morning.
 * Each entry says what was checked, when, and against what. Only the company page and its brief
 * read these; the list and the ranking are left to the ingested data.
 */
import type { Company } from './db';

export interface CompanyOverride {
	/** The address, when the row has none or has it differently. */
	website?: string;
	/** Confirmed as the company's own site, and the note saying how. */
	website_identity?: 'verified';
	website_identity_note?: string;
	/** A founding year from a filing the sources do not carry. */
	founded_year?: number;
	/** Said on the page in place of "founded <year>", with where it comes from. */
	incorporated?: string;
}

export const OVERRIDES: Record<string, CompanyOverride> = {
	'vctr-labs': {
		website: 'https://getvectorbots.com/',
		website_identity: 'verified',
		website_identity_note: 'checked by hand 23 Sep 2026: page authored by VCTR Labs, names SINE IIT Bombay',
	},
	'umarobotics-technology': {
		founded_year: 2021,
		incorporated: 'Incorporated 28 Aug 2021 (MCA)',
	},
};

/** The row as the company page should show it: the ingested row with any hand check laid over it. */
export function withOverrides(company: Company): { company: Company; incorporated: string | null } {
	const o = OVERRIDES[company.id];
	if (!o) return { company, incorporated: null };
	return {
		company: {
			...company,
			website: o.website ?? company.website,
			website_identity: o.website_identity ?? company.website_identity,
			website_identity_note: o.website_identity_note ?? company.website_identity_note,
			founded_year: o.founded_year ?? company.founded_year,
		},
		incorporated: o.incorporated ?? null,
	};
}
