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
 *
 * A DPIIT recognition is on the list and is not incorporation: the company applied,
 * a department assessed it, and the result is published in a register anyone can
 * search. That is somebody having noticed.
 */
export const TRACE_TYPES = ['website', 'press', 'grant', 'incubator', 'dpiit'] as const;

/**
 * Every signal type the ingest will accept, and the only place that decides.
 *
 * This list and TRACE_TYPES used to be documented in a comment on the signals
 * table, which is a snapshot of what was true in migration 0001 and does not
 * mention `dpiit`. A scraper that emits a type nobody knows about gets stored,
 * displayed, and silently counted as zero traces — a typo would cost a company
 * its tier and say nothing. The endpoint now refuses anything not on this list,
 * so adding a type is a deliberate edit here rather than a quiet accident there.
 */
export const SIGNAL_TYPES = [...TRACE_TYPES, 'patent', 'incorporation'] as const;

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

/**
 * The oldest thing any source says happened to the company, as an ISO date, or null.
 *
 * The earliest dated signal, or the last day of a stated origin year — the latest the
 * company can have started, so a year is never read as more recent than it is.
 */
export function earliestEvent(signalDates: readonly (string | null)[], originYear: number | null): string | null {
	const dates = signalDates.filter((d): d is string => typeof d === 'string' && d.length >= 10).map((d) => d.slice(0, 10));
	if (originYear !== null) dates.push(`${originYear}-12-31`);
	return dates.length ? dates.sort()[0] : null;
}

export function tierFor(
	firstSeen: string | null,
	basis: string | null,
	traceCount: number,
	now: Date = new Date(),
	sourceEvent: string | null = null,
	classifyBasis: string | null = null,
): Tier {
	// No date, no claim. A company we cannot place in time is not a company we found
	// early, however new it looks.
	if (firstSeen === null) return 'C';

	// An early find is a claim that there is something here worth being early to, and a
	// register label is not enough to make it. On 14 September 2026 all twenty Tier A
	// rows were DPIIT records whose whole public description was a dropdown industry and
	// a stage; five of them sat in AI in Healthcare because the dropdown said NLP. Until
	// something other than the label says what a company does, it is listed, not promoted.
	if (classifyBasis === 'register-label') return 'C';

	const age = daysSince(firstSeen, now);
	// Tier A says WE were early. Only a real discovery can say that: a cohort year
	// read off a portfolio page during a backfill is the incubator's news, not ours.
	//
	// And being new to us is not being new. Probird arrived in a live DPIIT run on
	// 13 September 2026 carrying a recognition dated 25 August 2023; the register had
	// said so for three years before we read it. Where any source dates an event, it
	// has to be under 90 days old too.
	const eventIsRecent = sourceEvent === null || daysSince(sourceEvent, now) < 90;
	if (basis === 'discovered' && age < 90 && traceCount <= 2 && eventIsRecent) return 'A';
	if (age < 180 && traceCount <= 5) return 'B';
	return 'C';
}
