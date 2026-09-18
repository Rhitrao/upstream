import { describe, it, expect } from 'vitest';
import { SNAPSHOT, SNAPSHOT_TERMS, snapshotReconciles } from '../src/snapshot';

/**
 * The README, the methodology page and docs/snapshot-<date>.csv all quote one figure set. These
 * tests are what makes a half-finished edit to it fail the build rather than the argument: the
 * failure a reviewer would otherwise find is two numbers on the site that cannot both be true.
 */
describe('the dated snapshot', () => {
	it('adds up: placed + dropped is every record seen, and companies is every record placed', () => {
		expect(snapshotReconciles()).toBe(true);
	});

	it('states each number it publishes', () => {
		const terms = SNAPSHOT_TERMS.map((t) => t.term);
		expect(terms).toEqual(['Sources', 'Records seen', 'Placed', 'Dropped', 'Companies', 'Described']);
		// Every term says what it counts, in a sentence, not a word.
		for (const t of SNAPSHOT_TERMS) {
			expect(t.value(SNAPSHOT), `${t.term} has a value`).toBeTruthy();
			expect(t.means.length, `${t.term} defines itself`).toBeGreaterThan(40);
		}
	});

	it('carries a date and the ingest run it was taken from', () => {
		expect(SNAPSHOT.date).toMatch(/^\d{1,2} \w+ \d{4}$/);
		expect(SNAPSHOT.dataVersion).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		// The committed export is named for the same day the figures are.
		expect(SNAPSHOT.exportFile).toBe('docs/snapshot-2026-09-17.csv');
	});

	it('does not claim more sources contribute than are configured', () => {
		expect(SNAPSHOT.sourcesContributing).toBeLessThanOrEqual(SNAPSHOT.sourcesConfigured);
	});

	it('does not claim more sub-sectors are occupied than exist', () => {
		expect(SNAPSHOT.subsectorsOccupied).toBeLessThanOrEqual(SNAPSHOT.subsectorsTotal);
	});
});
