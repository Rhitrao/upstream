/**
 * The RDI taxonomy, flattened. Reads the same rdi-taxonomy.json as ingest/taxonomy.py —
 * never copy or shorten the list here, or the coverage map drifts from the classifier.
 */
import taxonomy from '../rdi-taxonomy.json';

export interface Subsector {
	sector_id: string;
	sector: string;
	sector_type: string;
	subsector_id: string;
	subsector: string;
	projects: string[];
}

export const TAXONOMY = taxonomy;

export const SUBSECTORS: Subsector[] = taxonomy.sectors.flatMap((sector) =>
	sector.subsectors.map((sub) => ({
		sector_id: sector.id,
		sector: sector.short,
		sector_type: sector.type,
		subsector_id: sub.id,
		subsector: sub.name,
		projects: sub.projects,
	})),
);

export function summary(): string {
	const sunriseSectors = taxonomy.sectors.filter((s) => s.type === 'sunrise').length;
	const sunrise = SUBSECTORS.filter((e) => e.sector_type === 'sunrise').length;
	return `${sunrise} sunrise sub-sectors across ${sunriseSectors} sectors, ${SUBSECTORS.length} total`;
}

export interface SectorGroup {
	sector_id: string;
	sector: string;
	sector_name: string;
	sector_type: string;
	subsectors: Subsector[];
}

export const SECTOR_GROUPS: SectorGroup[] = taxonomy.sectors.map((sector) => ({
	sector_id: sector.id,
	sector: sector.short,
	sector_name: sector.name,
	sector_type: sector.type,
	subsectors: SUBSECTORS.filter((sub) => sub.sector_id === sector.id),
}));

/**
 * The coverage map is the 5 sunrise sectors and their 44 sub-sectors. Sector 6 is the
 * scheme's two catch-all "other" categories: a company can be classified there, but it
 * is not a cell on the map. /api/coverage reports those separately as off_map so they
 * are never silently dropped.
 */
export const SUNRISE_SECTORS: SectorGroup[] = SECTOR_GROUPS.filter((group) => group.sector_type === 'sunrise');

export const SUNRISE_SUBSECTORS: Subsector[] = SUNRISE_SECTORS.flatMap((g) => g.subsectors);

export const SUNRISE_SUBSECTOR_IDS: ReadonlySet<string> = new Set(SUNRISE_SUBSECTORS.map((sub) => sub.subsector_id));
