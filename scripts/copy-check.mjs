#!/usr/bin/env node
/**
 * Counts dashes and banned phrases in the site's user-facing copy.
 *
 *   node scripts/copy-check.mjs            counts per file, and the total
 *   node scripts/copy-check.mjs --lines    the lines behind every count
 *
 * Only text a reader can see is counted: string and template literals in the page templates (not
 * comments, identifiers or the stylesheet), quoted strings inside the client scripts, and every
 * string value in the picks file. HTML tags are stripped and entities decoded first, so &mdash;
 * counts as a dash. Code, urls and CSS are not prose, and are left out.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const TEMPLATES = ['src/page.ts', 'src/picks.ts', 'src/snapshot.ts', 'src/db.ts'];
const DATA = ['data/picks/robotics.json'];
// Constants that hold CSS or client code rather than copy.
const CODE_CONSTS = new Set(['STYLES', 'PICKS_STYLES', 'CAPABILITY_SCRIPT', 'STORE_SQL', 'SAID_STATE_SQL', 'SORTS', 'TRACE_SQL']);
const SCRIPT_CONSTS = new Set(['MARKS_SCRIPT', 'LIST_SCRIPT', 'ASK_SCRIPT', 'DETAIL_SCRIPT']);
// Copy the owner wrote with its dashes on purpose (the discovery hero), left out of the count.
const EXEMPT_FUNCTIONS = new Set(['hero']);

export const PATTERNS = [
	['em dash', /—|&mdash;/g],
	['en dash', /–|&ndash;/g],
	...['crucial', 'robust', 'leverage', 'seamless', 'delve', 'showcase', 'pivotal', 'valuable', 'testament', 'landscape', 'boasts', 'serves as']
		.map((w) => [w, new RegExp(`\\b${w}\\w*`, 'gi')]),
	['key (adjective)', /\bkey (?!to\b)[a-z]+/gi],
	["here's the thing", /here(?:'|’|&rsquo;)s the thing/gi],
	['in short', /\bin short\b/gi],
	['rather than', /\brather than\b/gi],
	['not X but Y', /\bnot [^.;:,]{1,60}?, but\b|\bnot [a-z]+ but\b/gi],
	['X, not Y', /, not (?!only\b|yet\b|all\b)[a-z]/gi],
];

function decode(text) {
	return text.replace(/<[^>]*>/g, ' ');
}

function literals(file) {
	const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
	const out = [];
	const visit = (node, inScript) => {
		if (ts.isFunctionDeclaration(node) && node.name && EXEMPT_FUNCTIONS.has(node.name.text)) return;
		if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
			if (CODE_CONSTS.has(node.name.text)) return;
			if (SCRIPT_CONSTS.has(node.name.text)) inScript = true;
		}
		// Import paths and property names are not copy.
		if (ts.isImportDeclaration(node)) return;
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
			const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
			const text = node.text ?? '';
			if (inScript) {
				for (const m of text.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) out.push({ line, text: m[1] });
			} else out.push({ line, text });
		}
		ts.forEachChild(node, (child) => visit(child, inScript));
	};
	visit(source, false);
	return out;
}

function jsonStrings(file) {
	const out = [];
	const walk = (v) => {
		if (typeof v === 'string') out.push({ line: 0, text: v });
		else if (Array.isArray(v)) v.forEach(walk);
		else if (v && typeof v === 'object') Object.values(v).forEach(walk);
	};
	walk(JSON.parse(readFileSync(file, 'utf8')));
	return out;
}

export function count() {
	const totals = Object.fromEntries(PATTERNS.map(([name]) => [name, 0]));
	const hits = [];
	for (const file of [...TEMPLATES, ...DATA]) {
		const items = file.endsWith('.json') ? jsonStrings(file) : literals(file);
		for (const { line, text } of items) {
			// A url or a bare identifier is not prose.
			if (/^(https?:|\/|[a-z0-9_.-]+$)/i.test(text.trim())) continue;
			const plain = decode(text);
			for (const [name, re] of PATTERNS) {
				const found = plain.match(re);
				if (!found) continue;
				totals[name] += found.length;
				hits.push(`${file}:${line} [${name}] ${plain.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
			}
		}
	}
	return { totals, hits };
}

const { totals, hits } = count();
if (process.argv.includes('--lines')) console.log(hits.join('\n'));
const sum = Object.values(totals).reduce((a, b) => a + b, 0);
for (const [name, n] of Object.entries(totals)) console.log(`${String(n).padStart(5)}  ${name}`);
console.log(`${String(sum).padStart(5)}  total`);
