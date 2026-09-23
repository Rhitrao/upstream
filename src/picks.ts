/**
 * A picks view: a page made by hand, from a JSON file in data/picks/, for one reader's purpose.
 *
 * Nothing here reads the database or the network. The opinions on it are the author's, and the
 * page says so; every fact carries where it came from and how firm it is, and a claim the company
 * makes about itself is tagged so nobody reads it as checked.
 */
import { BASE_PATH, STYLES, esc } from './page';

export interface PickFact {
	label: string;
	value: string;
	basis: string;
	source: string | null;
}

export interface Pick {
	upstream_id: string;
	name: string;
	legal_name: string;
	place: string;
	facts: PickFact[];
	why: string;
	risk: string;
	question: string;
}

export interface Picks {
	id: string;
	title: string;
	checked_on: string;
	method: string;
	funnel: { label: string; value: number }[];
	thesis: string;
	picks: Pick[];
	portfolio_note: string;
}

/**
 * Plain words for every acronym, said once: the first time one appears on the page it carries its
 * meaning, and after that it stands alone. Applied as the page is drawn, so the data file stays
 * exactly as it was written.
 */
const GLOSSES: { pattern: RegExp; say: (match: string) => string }[] = [
	{ pattern: /\bAGVs and AMRs\b|\bAGVs?\b|\bAMRs?\b/, say: (m) => (/s\b/.test(m) ? 'self-driving carts (AGV/AMR)' : 'self-driving cart (AGV/AMR)') },
	{ pattern: /\bCNC\b/, say: () => 'CNC (computer-controlled)' },
	{ pattern: /\bCIN\b/, say: () => 'CIN, the company identification number,' },
	{ pattern: /\bCEO\b/, say: () => 'CEO (chief executive)' },
	{ pattern: /\bSINE\b/, say: () => 'SINE (Society for Innovation and Entrepreneurship)' },
	{ pattern: /\bIIT Bombay\b/, say: () => 'IIT Bombay (Indian Institute of Technology Bombay)' },
	{ pattern: /\bOS\b/, say: () => 'OS (operating system)' },
	{ pattern: /\bMeitY\b/, say: () => 'MeitY (Ministry of Electronics and Information Technology)' },
];

/** A fresh reader of the page's text, in order: escapes it, and glosses each acronym the first time. */
function glosser(): (text: string) => string {
	const said = new Set<number>();
	return (text: string) => {
		let out = esc(text);
		GLOSSES.forEach((g, i) => {
			if (said.has(i)) return;
			const m = out.match(g.pattern);
			if (!m || m.index === undefined) return;
			out = out.slice(0, m.index) + g.say(m[0]) + out.slice(m.index + m[0].length);
			said.add(i);
		});
		return out;
	};
}

/** How firm a fact is, as a tag class. A company's claim about itself never shares a colour with a check. */
function basisKind(basis: string): string {
	const b = basis.toLowerCase();
	if (b.includes('self-reported') || b.includes('not verified')) return 'unverified';
	if (b.includes('government')) return 'record';
	if (b.includes('checked by hand')) return 'checked';
	if (b.includes('absence')) return 'absent';
	if (b.includes('third-party')) return 'third';
	if (b.includes('founder')) return 'founder';
	return 'own';
}

function sourceLink(source: string | null): string {
	if (!source) return '<span class="pick-nosource">no source</span>';
	let host = source;
	try {
		host = new URL(source).hostname.replace(/^www\./, '');
	} catch {
		return '<span class="pick-nosource">no source</span>';
	}
	if (!/^https?:\/\//.test(source)) return '<span class="pick-nosource">no source</span>';
	return `<a class="pick-source" href="${esc(source)}" rel="noopener nofollow">${esc(host)}</a>`;
}

function shortDate(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	return `${d} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
}

export function renderPicksPage(picks: Picks): string {
	const g = glosser();
	const funnel = picks.funnel
		.map((step) => `<li><span class="funnel-n">${esc(step.value)}</span><span class="funnel-label">${g(step.label)}</span></li>`)
		.join('');

	const cards = picks.picks
		.map((pick) => {
			const href = `${BASE_PATH}/c/${encodeURIComponent(pick.upstream_id)}`;
			// The author's read first, labelled as the author's; the facts it rests on under it.
			const read = `
    <div class="pick-read" aria-label="My read">
      <p class="pick-read-note">My read, not a finding of Upstream</p>
      <h3>Why I&rsquo;d look</h3>
      <p>${g(pick.why)}</p>
      <h3>Risk</h3>
      <p>${g(pick.risk)}</p>
      <h3>First question</h3>
      <p>${g(pick.question)}</p>
    </div>`;
			const rows = pick.facts
				.map(
					(f) => `
        <tr>
          <th scope="row">${g(f.label)}</th>
          <td class="pick-value">${g(f.value)}</td>
          <td class="pick-basis"><span class="basis basis-${basisKind(f.basis)}">${esc(f.basis)}</span></td>
          <td class="pick-src">${sourceLink(f.source)}</td>
        </tr>`,
				)
				.join('');
			return `
  <article class="pick" id="${esc(pick.upstream_id)}" aria-labelledby="${esc(pick.upstream_id)}-h">
    <header class="pick-head">
      <h2 id="${esc(pick.upstream_id)}-h">${g(pick.name)}</h2>
      <p class="pick-legal">${g(pick.legal_name)} &middot; ${g(pick.place)}</p>
      <a class="pick-record" href="${esc(href)}">Upstream record &rarr;</a>
    </header>
    ${read}
    <table class="pick-facts">
      <caption class="visually-hidden">What is on record about ${esc(pick.name)}, how firm each fact is, and where it comes from</caption>
      <thead><tr><th scope="col">Fact</th><th scope="col">What it says</th><th scope="col">Basis</th><th scope="col">Source</th></tr></thead>
      <tbody>${rows}
      </tbody>
    </table>
  </article>`;
		})
		.join('');

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(picks.title)} &mdash; Upstream</title>
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/upstream/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600;700&display=optional">
<style>${STYLES}${PICKS_STYLES}</style>
</head>
<body class="picks-page">
<div class="picks-banner" role="note">
  <p>A view made for my Kalaari Fellowship application. Checked by hand on ${esc(shortDate(picks.checked_on))} from public sources. I have not spoken to either founder.</p>
  <a class="picks-close" href="${esc(BASE_PATH)}" aria-label="Close this view and go to all of Upstream"><span aria-hidden="true">&times;</span></a>
</div>
<div class="wrap picks">
<header class="intro">
  <h1>${g(picks.title)}</h1>
  <p class="lede">${g(picks.thesis)}</p>
</header>
<ol class="funnel" aria-label="How the two were found">${funnel}</ol>
${cards}
<section class="pick-portfolio" aria-labelledby="portfolio-h">
  <h2 id="portfolio-h">Portfolio note</h2>
  <p>${g(picks.portfolio_note)}</p>
</section>
<footer class="page-foot"><a href="${esc(BASE_PATH)}">&larr; All of Upstream</a></footer>
</div>
</body>
</html>`;
}

const PICKS_STYLES = `
/* the picks view */
.picks-banner { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); padding: var(--s2) var(--s4); background: var(--accent-soft); border-bottom: 1px solid var(--rule-strong); font-size: var(--t-xs); color: var(--ink); }
.picks-banner p { margin: 0; max-width: none; }
.picks-close { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border: 1px solid var(--rule-strong); border-radius: var(--radius); background: var(--raise); color: var(--ink); font-size: 1.25rem; line-height: 1; text-decoration: none; }
.picks-close:hover { border-color: var(--ink); }
.picks .intro h1 { max-width: 28ch; }
.funnel { list-style: none; margin: var(--s5) 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s3); }
.funnel li { position: relative; display: flex; flex-direction: column; gap: var(--s1); padding: var(--s3) var(--s4); border: 1px solid var(--rule-strong); border-radius: var(--radius); background: var(--raise); }
.funnel-n { font-family: var(--mono); font-size: 1.75rem; font-weight: 500; line-height: 1.1; color: var(--ink); font-variant-numeric: tabular-nums; }
.funnel-label { font-size: var(--t-sm); color: var(--body-ink); line-height: 1.4; }
.funnel li + li::before { content: '↓'; position: absolute; top: calc(-1 * var(--s3)); left: var(--s4); transform: translateY(-50%); font-family: var(--mono); color: var(--muted); background: var(--paper); padding: 0 var(--s1); }
@media (min-width: 46rem) {
  .funnel { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s5); }
  .funnel li + li::before { content: '→'; top: 50%; left: calc(-1 * var(--s5) / 2); transform: translate(-50%, -50%); }
}
.pick { margin: var(--s6) 0; padding-top: var(--s4); border-top: 2px solid var(--ink); }
.pick-head { display: grid; gap: var(--s1); margin-bottom: var(--s4); }
.pick-head h2 { font-size: var(--t-hero); line-height: 1.1; letter-spacing: -0.03em; margin: 0; }
.pick-legal { margin: 0; color: var(--muted); font-size: var(--t-sm); }
.pick-record { justify-self: start; font-family: var(--mono); font-size: var(--t-xs); color: var(--ink); text-decoration: none; box-shadow: inset 0 -0.3em 0 var(--hl); }
.pick-read { margin: 0 0 var(--s5); padding: var(--s3) var(--s4); border-left: 3px solid var(--mark); background: var(--raise); }
.pick-read-note { margin: 0 0 var(--s2); font-family: var(--mono); font-size: var(--t-xs); letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.pick-read h3 { font-size: var(--t-sm); font-weight: 700; margin: var(--s3) 0 var(--s1); }
.pick-read h3:first-of-type { margin-top: 0; }
.pick-read p { margin: 0; }
.pick-facts { width: 100%; border-collapse: collapse; font-size: var(--t-sm); }
.pick-facts thead th { text-align: left; font-family: var(--mono); font-size: var(--t-xs); font-weight: 400; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); padding: var(--s2) var(--s3) var(--s2) 0; border-bottom: 1px solid var(--rule-strong); }
.pick-facts th[scope=row] { text-align: left; font-weight: 600; white-space: nowrap; }
.pick-facts th[scope=row], .pick-facts td { vertical-align: baseline; padding: var(--s2) var(--s3) var(--s2) 0; border-bottom: 1px solid var(--rule); }
.pick-value { overflow-wrap: anywhere; }
.pick-basis, .pick-src { white-space: nowrap; }
.basis { display: inline-block; padding: 0 var(--s2); border-radius: 3px; font-size: var(--t-xs); font-weight: 600; line-height: 1.7; border: 1px solid transparent; white-space: nowrap; }
.basis-record { background: var(--sunk); color: var(--ink); border-color: var(--rule-strong); }
.basis-checked { background: var(--mark-soft); color: var(--ink); border-color: var(--mark-deep); }
.basis-own, .basis-founder, .basis-third { background: transparent; color: var(--body-ink); border-color: var(--rule-strong); }
.basis-absent { background: transparent; color: var(--muted); border: 1px dashed var(--rule-strong); font-weight: 400; }
/* A company's claim about itself: the warning colour, so nobody reads it as checked. */
.basis-unverified { background: var(--warn-bg); color: var(--warn-ink); border-color: var(--warn-rule); }
.pick-source { font-family: var(--mono); font-size: var(--t-xs); color: var(--ink); text-decoration-color: var(--rule-strong); text-underline-offset: 3px; }
.pick-nosource { font-size: var(--t-xs); color: var(--muted); font-style: italic; }
.pick-portfolio { margin: var(--s6) 0 0; padding-top: var(--s4); border-top: 1px solid var(--rule-strong); }
.pick-portfolio h2 { font-size: var(--t-h); margin: 0 0 var(--s2); }
@media (max-width: 34rem) {
  .picks-banner { padding: var(--s2) var(--s4); align-items: flex-start; }
  .picks-close { width: 44px; height: 44px; }
  /* One column: each fact is a block, its tag and source on a line under it. */
  .pick-facts thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .pick-facts, .pick-facts tbody, .pick-facts tr, .pick-facts th[scope=row], .pick-facts td { display: block; width: auto; }
  .pick-facts tr { padding: var(--s3) 0; border-bottom: 1px solid var(--rule); }
  .pick-facts th[scope=row], .pick-facts td { border: 0; padding: 0; white-space: normal; }
  .pick-facts th[scope=row] { margin-bottom: var(--s1); }
  .pick-facts .pick-basis, .pick-facts .pick-src { display: inline-block; margin: var(--s2) var(--s3) 0 0; }
  .basis { white-space: normal; }
}
`;
