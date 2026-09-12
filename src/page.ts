/**
 * The page. Server-rendered from a template string — no React, no build step, no
 * framework. This is a list of text and it has to load instantly on a phone, which is
 * where a shared link gets opened.
 *
 * The only JavaScript on the page submits the filter form on change. Everything works
 * without it: the filters are a GET form and every coverage cell is a link.
 */
import { SECTOR_GROUPS, SUBSECTOR_BY_ID } from './taxonomy';
import { daysSince, MAX_AGE_YEARS, type Tier } from './rank';
import type { Buckets, Company, Coverage, Signal } from './db';

/** The tier toggle has its own vocabulary: A, A+B (the default), everything. */
export type TierChoice = 'a' | 'ab' | 'all';

/** The age gate: the last five years by default, or every year we hold. */
export type AgeChoice = 'recent' | 'all';

export interface PageView {
	coverage: Coverage;
	/** The ranked list: dated, and recent enough to clear the age gate. */
	companies: Company[];
	/** Companies no source will place in time. Listed below the ranking, never inside it. */
	undated: Company[];
	buckets: Buckets;
	tracked: number;
	discoveredThisWeek: number;
	sector: string | null;
	subsector: string | null;
	tier: TierChoice;
	age: AgeChoice;
	demo: boolean;
	now: Date;
}

const ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
};

/** Everything interpolated below is scraped text. All of it goes through here. */
function esc(value: unknown): string {
	return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Signal URLs come from scrapers, so only http(s) is allowed to become an href. */
function safeUrl(raw: string | null): string | null {
	if (!raw) return null;
	try {
		const url = new URL(raw);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
	} catch {
		return null;
	}
}

function query(params: Record<string, string | null | undefined>): string {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value) search.set(key, value);
	}
	const s = search.toString();
	return s ? `?${s}` : '';
}

function ago(firstSeen: string, now: Date): string {
	const days = Math.floor(daysSince(firstSeen, now));
	if (!Number.isFinite(days)) return 'first seen — date unknown';
	if (days <= 0) return 'first seen today';
	if (days === 1) return 'first seen yesterday';
	if (days < 60) return `first seen ${days} days ago`;
	const months = Math.round(days / 30);
	return `first seen about ${months} months ago`;
}

/**
 * What a row is allowed to say about its own date.
 *
 * "First seen" is a claim that we found it, so only a real discovery gets to make it.
 * A backfilled row says whose year it is reading, and a row with no date says nothing
 * at all — the section it sits in has already said it.
 */
function dateLine(company: Company, now: Date): string | null {
	if (company.first_seen === null) return null;
	if (company.first_seen_basis === 'cohort') {
		const year = company.origin_year ?? company.first_seen.slice(0, 4);
		return `listed by its incubator for ${year}`;
	}
	return ago(company.first_seen, now);
}

function tierLabel(tier: Tier): string {
	return `Tier ${tier}`;
}

// --- pieces -----------------------------------------------------------------

function header(view: PageView): string {
	const { coverage, tracked, discoveredThisWeek } = view;
	return `
<header class="masthead">
  <h1>Upstream</h1>
  <p class="lede">Early-stage Indian deep-tech companies that have left a public trace and not much else &mdash;
    ordered by how few people know about them, never by how impressive they look.</p>
  <dl class="stats">
    <div><dt>Companies tracked</dt><dd>${tracked}</dd></div>
    <div><dt>Discovered this week</dt><dd>${discoveredThisWeek}</dd></div>
    <div><dt>Sub-sectors covered</dt><dd>${coverage.covered}<span class="of">/${coverage.subsector_count}</span></dd></div>
  </dl>
</header>`;
}

function coverageMap(view: PageView): string {
	const { coverage, subsector, sector, tier, age } = view;

	const sectors = coverage.sectors
		.map((group) => {
			const cells = group.subsectors
				.map((cell) => {
					const active = subsector === cell.subsector_id;
					// Clicking the active cell clears the filter, so the map is a toggle.
					const href = `${query({
						sector,
						subsector: active ? null : cell.subsector_id,
						tier: tier === 'ab' ? null : tier,
						age: age === 'recent' ? null : age,
					})}#list`;
					const classes = ['cell', cell.n > 0 ? 'filled' : 'empty', active ? 'active' : ''].filter(Boolean).join(' ');
					return `<a class="${classes}" href="${esc(href)}" title="${esc(cell.subsector_id)} &mdash; ${esc(cell.subsector)}: ${cell.n}"${
						active ? ' aria-current="true"' : ''
					}>
        <span class="cell-id">${esc(cell.subsector_id)}</span>
        <span class="cell-name">${esc(cell.subsector)}</span>
        <span class="cell-n">${cell.n}</span>
      </a>`;
				})
				.join('\n');

			return `<div class="sector">
      <h3><span class="sector-id">${esc(group.sector_id)}</span> ${esc(group.sector)}</h3>
      <div class="grid">
${cells}
      </div>
    </div>`;
		})
		.join('\n');

	return `
<section class="coverage" aria-labelledby="coverage-h">
  <h2 id="coverage-h">Coverage</h2>
  <p class="note">All ${coverage.subsector_count} sunrise sub-sectors of the RDI scheme. An outlined cell is one we have
    found nothing in yet &mdash; a gap in what we can see, not proof the sector is empty. Pick a cell to filter the list.
    Counts here are every company we hold, including the ones the list below sets aside as old or undated.</p>
  <div class="sectors">
${sectors}
  </div>
</section>`;
}

function filters(view: PageView): string {
	const { sector, subsector, tier, age } = view;

	const options = [`<option value=""${sector ? '' : ' selected'}>All sectors</option>`]
		.concat(
			SECTOR_GROUPS.map(
				(group) =>
					`<option value="${esc(group.sector_id)}"${sector === group.sector_id ? ' selected' : ''}>${esc(group.sector_id)} &mdash; ${esc(
						group.sector,
					)}</option>`,
			),
		)
		.join('\n      ');

	const choices: Array<[TierChoice, string, string]> = [
		['a', 'A', 'New and quiet'],
		['ab', 'A + B', 'The default view'],
		['all', 'Everything', 'Including known territory'],
	];
	const toggle = choices
		.map(
			([value, label, hint]) => `<label class="seg${tier === value ? ' on' : ''}" title="${esc(hint)}">
        <input type="radio" name="tier" value="${value}"${tier === value ? ' checked' : ''}> ${esc(label)}
      </label>`,
		)
		.join('\n      ');

	const ages: Array<[AgeChoice, string, string]> = [
		['recent', `Last ${MAX_AGE_YEARS} years`, 'The default view'],
		['all', 'Every year', 'Including companies that are history by now'],
	];
	const ageToggle = ages
		.map(
			([value, label, hint]) => `<label class="seg${age === value ? ' on' : ''}" title="${esc(hint)}">
        <input type="radio" name="age" value="${value}"${age === value ? ' checked' : ''}> ${esc(label)}
      </label>`,
		)
		.join('\n      ');

	const clear = subsector
		? `<a class="clear" href="${esc(
				query({ sector, tier: tier === 'ab' ? null : tier, age: age === 'recent' ? null : age }),
			)}#list">Clear ${esc(subsector)}</a>`
		: '';

	return `
<form class="filters" method="get" action="#list">
  <div class="field">
    <label for="sector">Sector</label>
    <select id="sector" name="sector">
      ${options}
    </select>
  </div>
  <div class="field">
    <span class="legend">Tier</span>
    <div class="segmented">
      ${toggle}
    </div>
  </div>
  <div class="field">
    <span class="legend">Started</span>
    <div class="segmented">
      ${ageToggle}
    </div>
  </div>
  ${subsector ? `<input type="hidden" name="subsector" value="${esc(subsector)}">` : ''}
  <button type="submit" class="apply">Apply</button>
  ${clear}
</form>`;
}

function chips(company: Company): string {
	const items = company.signals.map((signal: Signal) => {
		const href = safeUrl(signal.url);
		const label = esc(signal.label);
		return href
			? `<li><a class="chip" href="${esc(href)}" rel="noopener nofollow">${label}</a></li>`
			: `<li><span class="chip">${label}</span></li>`;
	});

	// Said out loud, and marked, because here it is a point in the company's favour.
	if (!company.website) {
		items.push('<li><span class="chip positive">no website yet</span></li>');
	}

	return items.length ? `<ul class="chips">${items.join('')}</ul>` : '';
}

function companyRow(company: Company, now: Date): string {
	const sub = company.subsector_id ? SUBSECTOR_BY_ID.get(company.subsector_id) : undefined;
	const rdi = sub
		? `<p class="rdi">RDI ${esc(sub.subsector_id)} &mdash; ${esc(sub.subsector)}</p>`
		: '<p class="rdi unclassified">Not yet classified</p>';
	const site = safeUrl(company.website);
	const name = site ? `<a href="${esc(site)}" rel="noopener nofollow">${esc(company.name)}</a>` : esc(company.name);

	return `
  <li class="company">
    <div class="row-head">
      <span class="tier t${esc(company.tier).toLowerCase()}">${esc(tierLabel(company.tier))}</span>
      <h3>${name}</h3>
      ${company.city ? `<span class="place">${esc(company.city)}</span>` : ''}
    </div>
    ${company.description ? `<p class="desc">${esc(company.description)}</p>` : ''}
    ${rdi}
    ${chips(company)}
    ${dateLine(company, now) ? `<p class="seen">${esc(dateLine(company, now))}</p>` : ''}
  </li>`;
}

/**
 * The held-back line. A coverage cell can say 3 while the list shows 1, and the page
 * has to account for the other two rather than let the map look like it lied.
 */
function heldBack(view: PageView): string {
	const { buckets, sector, subsector, tier, age } = view;
	if (age === 'all' || buckets.older === 0) return '';

	const n = buckets.older;
	const href = `${query({ sector, subsector, tier: tier === 'ab' ? null : tier, age: 'all' })}#list`;
	return `<p class="note">${n} ${n === 1 ? 'company' : 'companies'} here started more than ${MAX_AGE_YEARS} years ago
    and ${n === 1 ? 'is' : 'are'} held back. <a href="${esc(href)}">Show ${n === 1 ? 'it' : 'them'}</a>.</p>`;
}

/**
 * How many companies the ranked list is actually offering. The buckets always split at
 * the age gate, because the held-back line needs that number even when the gate is off
 * — so with the gate lifted, the older ones are part of what is listed.
 */
function listed(view: PageView): number {
	return view.age === 'all' ? view.buckets.ranked + view.buckets.older : view.buckets.ranked;
}

/** Said only when the limit actually bit, so the count above stays trustworthy. */
function truncated(shown: number, total: number): string {
	return shown < total ? `<p class="note">Showing the first ${shown}.</p>` : '';
}

function list(view: PageView): string {
	const { companies, now, demo } = view;

	if (companies.length === 0) {
		return `
<section class="list" id="list">
  <h2>Companies</h2>
  <p class="empty">Nothing matches yet. Either the filters are narrow, or the ingest has not put anything here.</p>
  ${heldBack(view)}
</section>`;
	}

	const banner = demo
		? `<p class="demo-banner"><strong>Sample data.</strong> These companies are invented, so the layout can be
      checked before real data lands. The numbers above and the coverage map are the real, and currently empty, database.</p>`
		: '';

	return `
<section class="list" id="list">
  <h2>Companies <span class="count">${listed(view)}</span></h2>
  ${banner}
  ${heldBack(view)}
  ${truncated(companies.length, listed(view))}
  <ol class="companies">
${companies.map((company) => companyRow(company, now)).join('\n')}
  </ol>
</section>`;
}

/**
 * Companies with no date from any source. They sit below the ranking rather than
 * inside it: a tier is a claim about time, and we have nothing to make one with.
 * Visible, counted, and not pretending to be recent.
 */
function undatedList(view: PageView): string {
	const { undated, buckets, now } = view;
	if (undated.length === 0) return '';

	const n = buckets.undated;
	return `
<section class="list undated-list" id="undated" aria-labelledby="undated-h">
  <h2 id="undated-h">Undated <span class="count">${n}</span></h2>
  <p class="note">${n} ${n === 1 ? 'company we can&rsquo;t' : 'companies we can&rsquo;t'} place in time yet. IIT Madras
    RTBI publishes no incubation years, so there is no honest date to rank these by. Dating them from incorporation
    filings is on the roadmap; until then they are listed here, counted in the coverage map above, and left out of the
    tiers rather than shown as if they were new.</p>
  ${truncated(undated.length, n)}
  <ol class="companies">
${undated.map((company) => companyRow(company, now)).join('\n')}
  </ol>
</section>`;
}

function methodology(): string {
	return `
<section class="method" aria-labelledby="method-h">
  <h2 id="method-h">Methodology</h2>

  <h3>Where this comes from</h3>
  <p>Public sources only, nothing behind a login: incubator portfolios
    (<a href="https://sineiitb.org/" rel="noopener">SINE IIT Bombay</a>,
    <a href="https://rtbi.in/" rel="noopener">IIT Madras RTBI</a>,
    <a href="https://iticincubator.in/" rel="noopener">ITIC IIT Hyderabad</a>, IISc and others),
    government grant lists (<a href="https://birac.nic.in/" rel="noopener">BIRAC BIG</a>, NIDHI-PRAYAS, iDEX),
    new incorporations filed with the <a href="https://www.mca.gov.in/" rel="noopener">MCA</a>,
    filings at the <a href="https://ipindia.gov.in/" rel="noopener">Indian Patent Office</a>,
    and whether a company has a working website at all. Every row carries the evidence that put it there.</p>

  <h3>How the tiers are decided</h3>
  <p>There is no score. A number between 0 and 100 would pretend to a precision we do not have. Two facts decide the tier:
    how recently we first saw the company, and how many public traces it already has &mdash; a working website, a press
    mention, a grant, an accelerator badge.</p>
  <ul class="rules">
    <li><span class="tier ta">Tier A</span> Found by us under 90 days ago, at most 2 traces. New and quiet. Read these first.</li>
    <li><span class="tier tb">Tier B</span> First seen under 180 days ago, at most 5 traces. Early, some visibility.</li>
    <li><span class="tier tc">Tier C</span> Everything else. Known territory &mdash; listed, not promoted.</li>
  </ul>
  <p>This will sometimes put a company nobody has heard of above a famous one. That is the point, not a bug.</p>

  <h3>What the dates mean</h3>
  <p>Two different facts, kept apart on purpose. A company we found ourselves &mdash; it appeared in a run of a source
    we were already watching &mdash; carries the date we found it, and only those rows can reach Tier A. A company that
    arrived in the first sweep of a new source carries the incubation year its incubator published, because that sweep
    is a backfill and nothing in it was ours to discover. The rest carry no date at all and are listed separately at the
    foot of the page.</p>
  <p>The list shows companies that started within the last ${MAX_AGE_YEARS} years. Older ones are still here, still
    counted in the coverage map, and one link away &mdash; they are history rather than a find, and putting them in the
    same list would be flattering the wrong thing.</p>

  <h3>What this misses</h3>
  <p>A fair amount, and it is worth being blunt about it. There is no LinkedIn here, and no stealth companies: if a company
    has not appeared anywhere public, this page cannot see it and will not pretend otherwise. The list leans toward
    institutions that publish their portfolios, which means well-documented incubators are over-represented and quieter
    regional ones are under-represented. An empty cell in the coverage map above means we have found nothing there yet
    &mdash; it is a gap in our sources, not evidence that nothing exists. Classification into RDI sub-sectors is automated
    and will sometimes be wrong.</p>
</section>`;
}

// --- styles -----------------------------------------------------------------

const STYLES = `
:root {
  color-scheme: light dark;
  --paper: #fbfaf8;
  --raise: #ffffff;
  --ink: #141310;
  --muted: #6e6a62;
  --rule: #e5e1d9;
  --mark: #ffd84a;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #141310;
    --raise: #1d1b17;
    --ink: #f1eee8;
    --muted: #9b968c;
    --rule: #2e2a24;
  }
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 16px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  /* Scraped names and labels can be long and unbroken; never let one scroll the page. */
  overflow-wrap: break-word;
}
.wrap { max-width: 60rem; margin: 0 auto; padding: 2rem 1.15rem 4rem; }
a { color: inherit; }
h1, h2, h3 { line-height: 1.2; letter-spacing: -0.015em; }
p { margin: 0 0 0.75rem; }

/* header */
.masthead h1 { font-size: 1.9rem; margin: 0 0 0.4rem; font-weight: 600; }
.lede { color: var(--muted); max-width: 34rem; margin-bottom: 1.4rem; }
.stats { display: flex; flex-wrap: wrap; gap: 1.6rem; margin: 0 0 2.4rem; padding: 0; }
.stats dt { font-size: 0.75rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
.stats dd {
  margin: 0.1rem 0 0;
  font-family: "DM Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 1.5rem;
  font-weight: 500;
}
.stats .of { color: var(--muted); font-size: 1rem; }

/* section furniture */
section { margin: 0 0 2.6rem; }
section > h2 {
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.09em;
  color: var(--muted);
  font-weight: 500;
  margin: 0 0 0.5rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--rule);
}
.note { color: var(--muted); font-size: 0.87rem; max-width: 42rem; margin-bottom: 1.1rem; }

/* coverage map */
.sector { margin-bottom: 1.3rem; }
.sector h3 {
  font-size: 0.8rem;
  font-weight: 500;
  margin: 0 0 0.45rem;
  color: var(--muted);
}
.sector-id { font-family: "DM Mono", ui-monospace, monospace; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: 0.35rem; }
.cell {
  display: flex;
  flex-direction: column;
  min-height: 74px;
  padding: 0.4rem 0.45rem;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  text-decoration: none;
  position: relative;
}
.cell-id { font-family: "DM Mono", ui-monospace, monospace; font-size: 0.68rem; color: var(--muted); }
.cell-name {
  font-size: 0.72rem;
  line-height: 1.25;
  margin-top: 0.1rem;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.cell-n {
  margin-top: auto;
  font-family: "DM Mono", ui-monospace, monospace;
  font-size: 0.78rem;
  align-self: flex-end;
}
.cell.empty { color: var(--muted); border-style: dashed; }
.cell.empty .cell-n { opacity: 0.45; }
.cell.filled { background: var(--raise); border-color: color-mix(in srgb, var(--ink) 22%, transparent); }
.cell.filled .cell-n { font-weight: 500; }
.cell:hover { border-color: color-mix(in srgb, var(--ink) 45%, transparent); }
.cell.active { border-color: var(--ink); border-style: solid; box-shadow: inset 0 0 0 1px var(--ink); }

/* filters */
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.9rem;
  padding: 0.9rem 0;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
  margin-bottom: 1.6rem;
}
.field { display: flex; flex-direction: column; gap: 0.3rem; }
.field label, .legend {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
select {
  font: inherit;
  font-size: 0.9rem;
  color: inherit;
  background: var(--raise);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  padding: 0.42rem 0.55rem;
  max-width: 100%;
}
.segmented { display: flex; border: 1px solid var(--rule); border-radius: var(--radius); overflow: hidden; }
.seg {
  font-size: 0.85rem;
  padding: 0.42rem 0.7rem;
  cursor: pointer;
  background: var(--raise);
  border-right: 1px solid var(--rule);
  white-space: nowrap;
}
.seg:last-child { border-right: 0; }
.seg input { position: absolute; opacity: 0; pointer-events: none; }
.seg.on { background: var(--ink); color: var(--paper); }
.apply {
  font: inherit;
  font-size: 0.85rem;
  padding: 0.45rem 0.9rem;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--raise);
  color: inherit;
  cursor: pointer;
}
.clear { font-size: 0.82rem; color: var(--muted); }

/* list */
.list h2 .count { font-family: "DM Mono", ui-monospace, monospace; }
.companies { list-style: none; margin: 0; padding: 0; }
.company { padding: 1.25rem 0; border-bottom: 1px solid var(--rule); }
.row-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.55rem; margin-bottom: 0.35rem; }
.row-head h3 { font-size: 1.02rem; font-weight: 600; margin: 0; flex: 1 1 auto; }
.row-head h3 a { text-decoration-color: var(--rule); text-underline-offset: 2px; }
.place { font-size: 0.82rem; color: var(--muted); }
.tier {
  font-family: "DM Mono", ui-monospace, monospace;
  font-size: 0.68rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 0.12rem 0.4rem;
  border-radius: 4px;
  border: 1px solid var(--rule);
  color: var(--muted);
  white-space: nowrap;
}
/* The yellow appears exactly twice on this page: on a Tier A marker and on
   "no website yet". Both say the same thing — this one is still unnoticed. */
.tier.ta { background: var(--mark); border-color: var(--mark); color: #141310; }
.desc { margin: 0 0 0.35rem; max-width: 46rem; }
.rdi { font-size: 0.82rem; color: var(--muted); margin: 0 0 0.5rem; font-family: "DM Mono", ui-monospace, monospace; }
.rdi.unclassified { font-style: italic; }
.chips { list-style: none; display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0 0 0.5rem; padding: 0; }
.chip {
  display: inline-block;
  font-size: 0.78rem;
  padding: 0.16rem 0.5rem;
  border: 1px solid var(--rule);
  border-radius: 999px;
  background: var(--raise);
  color: var(--muted);
  text-decoration: none;
}
a.chip { color: var(--ink); }
a.chip:hover { border-color: color-mix(in srgb, var(--ink) 45%, transparent); }
.chip.positive { background: var(--mark); border-color: var(--mark); color: #141310; }
.seen { font-size: 0.78rem; color: var(--muted); margin: 0; }
.empty { color: var(--muted); }
/* Below the ranking and visibly outside it — same rows, no claim about time. */
.undated-list { margin-top: 2.2rem; padding-top: 1.4rem; border-top: 1px solid var(--rule); }
.undated-list h2 { color: var(--muted); }
.demo-banner {
  font-size: 0.85rem;
  color: var(--muted);
  border: 1px dashed var(--rule);
  border-radius: var(--radius);
  padding: 0.7rem 0.85rem;
  margin: 0.9rem 0 0.2rem;
}

/* methodology */
.method h3 { font-size: 0.92rem; margin: 1.4rem 0 0.4rem; }
.method p, .method li { font-size: 0.89rem; color: var(--muted); max-width: 44rem; }
.method a { color: var(--ink); }
.rules { list-style: none; margin: 0 0 0.9rem; padding: 0; }
.rules li { margin-bottom: 0.4rem; display: flex; gap: 0.5rem; align-items: baseline; }
.rules .tier { flex: 0 0 auto; }

/* wider screens */
@media (min-width: 46rem) {
  .wrap { padding: 3rem 2rem 5rem; }
  .masthead h1 { font-size: 2.4rem; }
  .grid { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); }
  .row-head h3 { font-size: 1.08rem; }
}

/* The radio inputs behind the segmented control are visually hidden but still
   focusable, so the focus ring has to be drawn on the label. */
.seg:has(input:focus-visible) { outline: 2px solid var(--ink); outline-offset: -2px; }
a:focus-visible, select:focus-visible, .apply:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

@media (prefers-reduced-motion: no-preference) {
  .cell, .chip, .apply { transition: border-color 120ms ease, background 120ms ease; }
}
`;

// --- the page ---------------------------------------------------------------

export function renderPage(view: PageView): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upstream &mdash; early-stage Indian deep tech, sorted by obscurity</title>
<meta name="description" content="Early-stage Indian deep-tech companies that have left a public trace and little else, ranked by how few people know about them. Every row carries its evidence.">
<meta name="color-scheme" content="light dark">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap">
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
${header(view)}
${coverageMap(view)}
${filters(view)}
${list(view)}
${undatedList(view)}
${methodology()}
</div>
<script>
  // Progressive enhancement only: without this the Apply button does the same job.
  (function () {
    var form = document.querySelector('.filters');
    if (!form) return;
    form.querySelector('.apply').hidden = true;
    form.addEventListener('change', function () { form.submit(); });
  })();
</script>
</body>
</html>`;
}
