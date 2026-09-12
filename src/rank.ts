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

export const TIERS: readonly Tier[] = ['A', 'B', 'C'];

/** Whole and fractional days between an ISO date (or datetime) and `now`. */
export function daysSince(iso: string, now: Date): number {
	const ms = Date.parse(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
	// An unparseable first_seen must not read as "brand new" — treat it as ancient.
	if (Number.isNaN(ms)) return Number.POSITIVE_INFINITY;
	return (now.getTime() - ms) / 86_400_000;
}

export function tierFor(firstSeen: string, traceCount: number, now: Date = new Date()): Tier {
	const age = daysSince(firstSeen, now);
	if (age < 90 && traceCount <= 2) return 'A';
	if (age < 180 && traceCount <= 5) return 'B';
	return 'C';
}
