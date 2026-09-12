/**
 * The RDI taxonomy, flattened. Reads the same rdi-taxonomy.json as ingest/taxonomy.py —
 * never copy or shorten the list here, or the coverage map drifts from the classifier.
 */
import taxonomy from "../rdi-taxonomy.json";

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
	const sunriseSectors = taxonomy.sectors.filter((s) => s.type === "sunrise").length;
	const sunrise = SUBSECTORS.filter((e) => e.sector_type === "sunrise").length;
	return `${sunrise} sunrise sub-sectors across ${sunriseSectors} sectors, ${SUBSECTORS.length} total`;
}
