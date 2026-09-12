/**
 * Tier rules — Part 9. No score. Two facts decide the tier:
 *   recency  — days since first_seen
 *   crowding — trace_count, how many public traces a company already has
 *
 * This will sometimes rank an unknown company above a famous one. That is the point,
 * not a bug. Do not "fix" it.
 */

/**
 * Signal types that count as a trace — evidence that other people already know.
 * Part 9's list is: live website, press mention, DPIIT listing, funding
 * announcement, accelerator badge. `incorporation` and `patent` are deliberately
 * excluded: those are how we FIND a company, not evidence anyone has noticed it.
 */
export const TRACE_TYPES = ['website', 'press', 'grant', 'incubator'] as const;

export type Tier = 'A' | 'B' | 'C';

/**
 * Where a first_seen date came from. 'discovered' means the company turned up in a run
 * after its source was already established — the date is ours and it is real.
 * 'cohort' means we read it off a published incubation year during a backfill.
 */
export type Basis = 'discovered' | 'cohort';

/**
 * The default list view stops here. Older than this and a company is history, not a
 * find — it stays in the database and in the coverage map, just not on the front page.
 * See docs/decisions/002-age-gate.md.
 */
export const MAX_AGE_YEARS = 5;

/** The earliest origin year the default view will show. */
export function minOriginYear(now: Date = new Date()): number {
	return now.getUTCFullYear() - MAX_AGE_YEARS;
}

export const TIERS: readonly Tier[] = ['A', 'B', 'C'];

/** Whole and fractional days between an ISO date (or datetime) and `now`. */
export function daysSince(iso: string, now: Date): number {
	const ms = Date.parse(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
	// An unparseable first_seen must not read as "brand new" — treat it as ancient.
	if (Number.isNaN(ms)) return Number.POSITIVE_INFINITY;
	return (now.getTime() - ms) / 86_400_000;
}

export function tierFor(firstSeen: string | null, basis: string | null, traceCount: number, now: Date = new Date()): Tier {
	// No date, no claim. A company we cannot place in time is not a company we found
	// early, however new it looks.
	if (firstSeen === null) return 'C';

	const age = daysSince(firstSeen, now);
	// Tier A says WE were early. Only a real discovery can say that: a cohort year
	// read off a portfolio page during a backfill is the incubator's news, not ours.
	if (basis === 'discovered' && age < 90 && traceCount <= 2) return 'A';
	if (age < 180 && traceCount <= 5) return 'B';
	return 'C';
}
