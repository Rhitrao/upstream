/**
 * Which public support programmes have selected a company, counted and never ranked. The same
 * rules as ingest/programmes.py, which measured them and wrote the backfill; test/index.spec.ts
 * pins both to the same cases. See that module for why there are two counts.
 */

export const INCUBATORS: Record<string, string> = {
	'sine-iitb': 'SINE, IIT Bombay',
	'venture-center': 'Venture Center, Pune',
	'tides-iitr': 'TIDES, IIT Roorkee',
	'fsid-iisc': 'FSID, IISc',
	'rtbi-iitm': 'IIT Madras Incubation Cell',
	'nmicps-tih': 'an NM-ICPS technology hub',
};

const SCHEMES: [RegExp, string][] = [
	[/BIRAC|\bBIG\b/, 'BIRAC'],
	[/NIDHI|\bDST\b/, 'DST'],
	[/\bTDB\b/, 'TDB'],
	[/MeitY|\bTIDE\b|SAMRIDH/, 'MeitY'],
	[/iDEX/, 'iDEX'],
	[/EXIM/, 'EXIM Bank'],
];

const EVIDENCE_BODIES: Record<string, string> = { 'birac-big': 'BIRAC', 'tdb-agreements': 'TDB', idex: 'iDEX', 'nsa-dpiit': 'National Startup Awards' };

const RECOGNISED = new Set(['recognised', 'expired', 'cancelled']);

export interface ProgrammeSignal {
	type: string;
	label: string | null;
	source?: string | null;
}

export function programmesOf(signals: ProgrammeSignal[], dpiitStatus: string | null): string[] {
	const found = new Set<string>();
	if (dpiitStatus && RECOGNISED.has(dpiitStatus)) found.add('DPIIT recognition');
	for (const s of signals) {
		const label = s.label ?? '';
		const source = s.source ?? '';
		if (s.type === 'incubator' && INCUBATORS[source]) found.add(`incubation at ${INCUBATORS[source]}`);
		if (s.type === 'grant' || s.type === 'award') {
			for (const [pattern, body] of SCHEMES) if (pattern.test(label)) found.add(body);
			if (source === 'sine-iitb') found.add(`incubation at ${INCUBATORS['sine-iitb']}`);
		}
		if (EVIDENCE_BODIES[source]) found.add(EVIDENCE_BODIES[source]);
	}
	return [...found].sort();
}

export function organisationsOf(signals: ProgrammeSignal[], dpiitStatus: string | null): string[] {
	const found = new Set<string>();
	if (dpiitStatus && RECOGNISED.has(dpiitStatus)) found.add('DPIIT');
	for (const s of signals) {
		if (s.type === 'website' || s.type === 'press') continue;
		const label = s.label ?? '';
		const source = s.source ?? '';
		if (INCUBATORS[source]) found.add(INCUBATORS[source]);
		else if (source === 'grants-csv') found.add(label.includes('BIRAC') ? 'BIRAC' : /NIDHI|\bDST\b/.test(label) ? 'DST' : label);
		else if (EVIDENCE_BODIES[source]) found.add(EVIDENCE_BODIES[source]);
	}
	return [...found].sort();
}
