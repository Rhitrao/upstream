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
import {
	SORTS,
	SOURCES,
	type Buckets,
	type Company,
	type Coverage,
	type Gaps,
	type ProductOutcomes,
	type RegisterOutcomes,
	type Signal,
	type SiteState,
	type SortChoice,
} from './db';

/**
 * Where this whole site lives. Defined here rather than in the router because the
 * page builds links and the router matches them, and the two disagreeing is how a
 * detail link 404s.
 */
export const BASE_PATH = '/upstream';

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
	/** Companies the taxonomy has no cell for, grouped by the hole they fell through. */
	gaps: Gaps;
	/** Every company the pipeline holds: placed plus off-map. The top of the funnel. */
	found: number;
	/** The ones that reached a cell on the coverage map. */
	tracked: number;
	/** How many of those have at most one public trace — the obscurity claim, counted. */
	oneTrace: number;
	/** What became of the register's companies, for the methodology's own arithmetic. */
	register: RegisterOutcomes;
	/** What came of reading company websites — including every way it failed. */
	products: ProductOutcomes;
	discoveredThisWeek: number;
	sector: string | null;
	subsector: string | null;
	/** What was typed in the search box, trimmed. null when nothing was. */
	search: string | null;
	/** Which scraper found it, or null for any. */
	source: string | null;
	/** Whether it publishes a website, or null for either. */
	site: SiteState | null;
	sort: SortChoice;
	/** Which of the two list sections to show. */
	dates: 'both' | 'dated' | 'undated';
	tier: TierChoice;
	/** What the toggle means by "default" right now — it widens while the ranking is empty. */
	defaultTier: TierChoice;
	/** Nothing has been discovered live yet, so A and B are empty by construction. */
	backfillOnly: boolean;
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

/**
 * Everything interpolated below is scraped text. All of it goes through here.
 *
 * Exported because the notebook renders the same scraped text on its own pages, and a
 * second escaper is a second thing to get wrong.
 */
export function esc(value: unknown): string {
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

/**
 * A querystring from the parts that are not at their default.
 *
 * Defaults are omitted rather than written out, so a shared link carries what the
 * reader actually chose and nothing else — and so the same view always has the same
 * url, whichever control got it there.
 */
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
 * A backfilled row says what year it was on record by — an incubator cohort, a grant
 * award — without claiming we were there. A row with no date says nothing at all; the
 * section it sits in has already said it.
 */
function dateLine(company: Company, now: Date): string | null {
	if (company.first_seen === null) return null;

	const said =
		company.first_seen_basis === 'cohort'
			? `on public record from ${esc(company.origin_year ?? company.first_seen.slice(0, 4))}`
			: esc(ago(company.first_seen, now));

	// A register can date the record without saying when the company started, and a
	// row in that state has to say so: otherwise the date reads as a founding year,
	// which is how a 2019 company recognised last week comes to look brand new.
	return ageKnown(company) ? said : `${said} &middot; founding year unknown`;
}

function ageKnown(company: Company): boolean {
	return company.origin_year !== null || company.founded_year !== null;
}

/**
 * The proposition and the argument for it — the sentences a first-time reader is
 * actually guaranteed to read.
 *
 * Kept here rather than inline in the template because they get rewritten far more
 * often than the markup around them, and because a reader who disagrees with this page
 * disagrees with these sentences and should be able to find them in one grep.
 *
 * Every count is interpolated for the same reason every other number on this page is:
 * a hand-typed 684 is true until tomorrow morning's run.
 */
function proposition(tracked: number): string {
	return `${tracked} Indian deep-tech companies, sorted by obscurity.`;
}

/**
 * The argument, in the order it has to land.
 *
 * One: what everyone else does and why it fails — and this is the sentence written to
 * be repeated to a colleague, so it carries the emphasis. The emphasis is weight, not
 * colour: the one yellow on this page already means "nobody has noticed this company
 * yet", and a second meaning would have cost it the first.
 *
 * Two: the rule, in the concrete. It deliberately does not say "obscurity" — the
 * headline above owns that word, and a lede that repeats it has spent a sentence
 * saying nothing new. Naming what actually beats what is the sentence that makes the
 * ranking arguable instead of merely stated.
 *
 * Three: the number, and only now. 587 is the best figure on this page and it is
 * meaningless before a reader knows what a trace is, which is what sentence two just
 * told them. Held back until it can land.
 */
function hook(tracked: number, oneTrace: number): string {
	const argument = `Every other list ranks by how impressive a company looks, which is why <strong>every fund
    keeps finding the same twenty names</strong>. This one ranks the other way: one incubator listing and no
    website beats a known name and a press cycle.`;

	// On an empty database there is no proof to offer, and "0 of 0" is not a modest
	// claim, it is a broken one. The argument stands on its own until there is.
	if (oneTrace === 0) return argument;

	// "or none" rather than "a single trace", because the count is companies with at
	// most one, and a company found through an incorporation filing alone has left no
	// trace at all. That one is less known, not more, and belongs in this number.
	return `${argument} Of the ${tracked} here, ${oneTrace} have left one public trace or none.`;
}

/**
 * One glyph per sunrise sector, so the five blocks of the coverage map are findable
 * by shape before they are read.
 *
 * Inline, because an artifact of this page is that it loads instantly on a phone and
 * five sprites would be five requests for five small drawings. Drawn from the sector's
 * own subject rather than from a generic icon set: a bolt for energy, an orbit for deep
 * tech and space, a node graph for AI, a helix for biotech, a grid for the digital
 * economy. currentColor throughout, so they follow the theme without a second palette.
 *
 * aria-hidden on all of them. The sector name is right there in text; a screen reader
 * announcing "bolt" before it would be describing the decoration, not the thing.
 */
const SECTOR_ICONS: Record<string, string> = {
	'1': '<path d="M13 2 4.5 13H10l-1 9 8.5-11H12l1-9Z"/>',
	'2': '<circle cx="12" cy="12" r="3.2"/><ellipse cx="12" cy="12" rx="10" ry="4.6" transform="rotate(-28 12 12)"/>',
	'3': '<circle cx="5" cy="7" r="2"/><circle cx="5" cy="17" r="2"/><circle cx="18" cy="12" r="2.4"/><path d="M7 7.8l8.6 3M7 16.2l8.6-3"/>',
	'4': '<path d="M8.5 2c0 5 7 5 7 10s-7 5-7 10"/><path d="M15.5 2c0 5-7 5-7 10s7 5 7 10"/><path d="M9.2 7h5.6M9.2 17h5.6"/>',
	'5': '<rect x="3.5" y="3.5" width="7" height="7" rx="1"/><rect x="13.5" y="3.5" width="7" height="7" rx="1"/><rect x="3.5" y="13.5" width="7" height="7" rx="1"/><rect x="13.5" y="13.5" width="7" height="7" rx="1"/>',
};

function sectorIcon(id: string): string {
	const glyph = SECTOR_ICONS[id];
	if (!glyph) return '';
	return `<svg class="sector-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${glyph}</svg>`;
}

// --- pieces -----------------------------------------------------------------

/**
 * The funnel, in the masthead, in the order it happens.
 *
 * "Companies tracked" used to head this on its own, and it counted only the ones
 * a classifier could fit into an RDI sub-sector — 702 of 1,545. Everywhere else
 * this page refuses to let anything disappear quietly: 843 off-map companies are
 * listed under the name of the hole they fell through, undated companies get
 * their own section, empty cells are left visibly empty. A headline number that
 * silently meant "the placed subset" was the one place that broke the rule.
 *
 * So both numbers, adjacent, and the drop between them legible without scrolling.
 * The drop is not an embarrassment to be smoothed over — it is the argument.
 */
/**
 * What happened to the ones that did not make the map, split by whose fault it is.
 *
 * The first draft of this line said all 843 were "what the taxonomy had no room
 * for". 147 of them were nothing of the kind — they were companies whose only
 * published description was a name and a dropdown industry. Claiming those as a
 * finding about the RDI scheme overstates the critique and hides the admission.
 */
/**
 * What the map does not show, said under the map instead of above the list.
 *
 * This used to head the page, where it explained the pipeline to someone who did not
 * yet know what the pipeline was for. The arithmetic still has to be stated somewhere
 * and stated in full — a headline number that quietly means "the subset that fitted"
 * is the one thing this page must never do — so it sits with the map it is about, and
 * still links down to the sections that hold the companies it is counting.
 */
function funnelNote(view: PageView): string {
	const { gaps, found, tracked } = view;
	if (gaps.total === 0) return '';
	const parts: string[] = [];
	if (gaps.taxonomy.total > 0) {
		parts.push(`<a href="#off-map">${gaps.taxonomy.total}</a> fell outside every sub-sector the taxonomy offers`);
	}
	if (gaps.undescribed.total > 0) {
		parts.push(`<a href="#undescribed">${gaps.undescribed.total}</a> we could not describe well enough to place`);
	}
	return `<p class="funnel-note">${found} companies have reached this pipeline and ${tracked} are on the map above.
    Of the ${gaps.total} that are not, ${parts.join(', and ')}.</p>`;
}

/**
 * The top of the page. Three things and nothing else: who this is, what it claims, and
 * three numbers that back the claim up.
 *
 * What used to be here and is not any more: the pipeline's own arithmetic — companies
 * found, how many we managed to place, how far the two diverge. All of it is true and
 * none of it is an answer to the question a stranger arrives with, which is what this
 * is and why they should care. It now sits under the coverage map, with the map it is
 * about. See funnelNote.
 *
 * The three that stayed are the three a reader could act on. The empty sub-sectors are
 * the finding rather than the shortfall, so the stat counts the empty ones and not the
 * covered ones: a national priority with nothing in it is the interesting square.
 */
function header(view: PageView): string {
	const { coverage, tracked, oneTrace, discoveredThisWeek } = view;
	const empty = coverage.subsector_count - coverage.covered;
	return `
<header class="masthead">
  <p class="eyebrow">Upstream</p>
  <h1>${esc(proposition(tracked))}</h1>
  <p class="hook">${hook(tracked, oneTrace)}</p>
  <dl class="stats">
    <div><dt>Companies</dt><dd>${tracked}</dd></div>
    <div><dt>One public trace at most</dt><dd>${oneTrace}</dd></div>
    <div><dt>Sub-sectors still empty</dt><dd>${empty}<span class="of">/${coverage.subsector_count}</span></dd></div>
  </dl>
  ${
		// Only when there is something to report. A liveness line that reads "0
		// discovered in the last seven days" every day until the first discovery lands
		// says the machine is broken, which is not what it means.
		discoveredThisWeek > 0 ? `<p class="fresh">${discoveredThisWeek} discovered in the last seven days.</p>` : ''
	}
</header>`;
}

function coverageMap(view: PageView): string {
	const { coverage, subsector } = view;

	const sectors = coverage.sectors
		.map((group) => {
			const cells = group.subsectors
				.map((cell) => {
					const active = subsector === cell.subsector_id;
					// Clicking the active cell clears the filter, so the map is a toggle.
					const href = `${query(viewParams(view, { subsector: active ? null : cell.subsector_id }))}#list`;
					const classes = ['cell', cell.n > 0 ? 'filled' : 'empty', active ? 'active' : ''].filter(Boolean).join(' ');
					return `<a class="${classes}" href="${esc(href)}" title="${esc(cell.subsector_id)} &mdash; ${esc(cell.subsector)}: ${cell.n}"${
						active ? ' aria-current="true"' : ''
					}>
        <span class="cell-head"><span class="cell-id">${esc(cell.subsector_id)}</span><span class="cell-n">${cell.n}</span></span>
        <span class="cell-name">${esc(cell.subsector)}</span>
      </a>`;
				})
				.join('\n');

			return `<div class="sector">
      <h3>${sectorIcon(group.sector_id)}<span class="sector-id">${esc(group.sector_id)}</span> ${esc(group.sector)}</h3>
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
    found nothing in yet &mdash; our blind spot, not proof the sector is empty. Pick a cell to filter the list; the counts
    include the companies the list below sets aside as old or undated.</p>
  <details class="map-fold" open>
    <summary>
      <span class="map-fold-label">Coverage map</span>
      <span class="map-fold-meta">${coverage.covered} of ${coverage.subsector_count} sub-sectors have companies</span>
    </summary>
    <div class="sectors">
${sectors}
    </div>
  </details>
  ${funnelNote(view)}
</section>`;
}

/**
 * Every filter in the view, as querystring parameters, with the defaults left out.
 *
 * One function so that the coverage map, the held-back link, the sort control, the
 * clear link and the CSV button cannot drift apart — the bug this replaces is a link
 * that silently drops a filter the reader set, which reads as the page ignoring them.
 * Overrides are merged on top, so a link that changes one thing says only that.
 */
function viewParams(view: PageView, overrides: Record<string, string | null> = {}): Record<string, string | null> {
	return {
		q: view.search,
		sector: view.sector,
		subsector: view.subsector,
		source: view.source,
		site: view.site,
		sort: view.sort === 'obscurity' ? null : view.sort,
		dates: view.dates === 'both' ? null : view.dates,
		tier: view.tier === view.defaultTier ? null : view.tier,
		age: view.age === 'recent' ? null : view.age,
		...overrides,
	};
}

/** The labels for the four sources, since the ids are not written for reading. */
const SOURCE_LABELS: Record<string, string> = {
	'sine-iitb': 'SINE IIT Bombay',
	'rtbi-iitm': 'IIT Madras RTBI',
	'grants-csv': 'Government grants',
	'dpiit-startup-india': 'DPIIT register',
};

const SORT_LABELS: Record<SortChoice, string> = {
	obscurity: 'Obscurity',
	quietest: 'Fewest traces',
	newest: 'Newest on record',
	name: 'Name',
};

function filters(view: PageView): string {
	const { sector, subsector, search, source, site, sort, dates, tier, defaultTier, age } = view;

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

	// The hint follows the default rather than naming a fixed one: while the ranking is
	// empty the default is Everything, and a toggle that claimed otherwise would lie.
	const choices: Array<[TierChoice, string, string]> = [
		['a', 'A', 'New and quiet'],
		['ab', 'A + B', defaultTier === 'ab' ? 'The default view' : 'Once the ranking fills'],
		['all', 'Everything', defaultTier === 'all' ? 'The default view' : 'Including known territory'],
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

	const sourceOptions = [`<option value=""${source ? '' : ' selected'}>Any source</option>`]
		.concat(SOURCES.map((id) => `<option value="${esc(id)}"${source === id ? ' selected' : ''}>${esc(SOURCE_LABELS[id] ?? id)}</option>`))
		.join('\n      ');

	const siteOptions = [
		['', 'Website or not'],
		['has', 'Has a website'],
		// Worth its own option: on this list the absence is the signal.
		['none', 'No website'],
	]
		.map(([value, label]) => `<option value="${value}"${(site ?? '') === value ? ' selected' : ''}>${esc(label)}</option>`)
		.join('\n      ');

	const datesOptions = [
		['both', 'Dated and not'],
		['dated', 'On record only'],
		['undated', 'Undated only'],
	]
		.map(([value, label]) => `<option value="${value}"${dates === value ? ' selected' : ''}>${esc(label)}</option>`)
		.join('\n      ');

	const sortOptions = (Object.keys(SORTS) as SortChoice[])
		.map((value) => `<option value="${value}"${sort === value ? ' selected' : ''}>${esc(SORT_LABELS[value])}</option>`)
		.join('\n      ');

	// Every filter that is not at its default, counted, so "clear" can say what it
	// clears and a reader can see at a glance that the list is narrowed.
	const active = Object.entries(viewParams(view)).filter(([, value]) => value !== null && value !== '');
	const clear = active.length
		? `<a class="clear" href="${esc(BASE_PATH)}#list">Clear ${active.length} filter${active.length === 1 ? '' : 's'}</a>`
		: '';

	return `
<form class="filters" method="get" action="#list">
  <div class="field field-search">
    <label for="q">Search</label>
    <input type="search" id="q" name="q" value="${esc(search ?? '')}" placeholder="name or what they build"
      autocomplete="off" spellcheck="false">
  </div>
  <div class="field">
    <label for="sector">Sector</label>
    <select id="sector" name="sector">
      ${options}
    </select>
  </div>
  <div class="field">
    <label for="source">Found by</label>
    <select id="source" name="source">
      ${sourceOptions}
    </select>
  </div>
  <div class="field">
    <label for="site">Website</label>
    <select id="site" name="site">
      ${siteOptions}
    </select>
  </div>
  <div class="field">
    <label for="dates">Dates</label>
    <select id="dates" name="dates">
      ${datesOptions}
    </select>
  </div>
  <div class="field">
    <label for="sort">Sort by</label>
    <select id="sort" name="sort">
      ${sortOptions}
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
  <a class="export" href="${esc(`${BASE_PATH}/export.csv${query(viewParams(view))}`)}">Download CSV</a>
</form>`;
}

/**
 * How many people already know, as a number rather than as an implication.
 *
 * This is the quantity the whole list is sorted by and the row never printed it — a
 * reader had to count the chips and know that two of the seven signal types are not
 * traces. 587 of 699 companies have one or none, which is the page's central claim;
 * a row that states its own trace count is a row that can be checked.
 */
function traceLine(company: Company): string {
	const n = company.trace_count;
	const said = n === 0 ? 'no public trace' : n === 1 ? '1 public trace' : `${n} public traces`;
	// Emphasised only where it is the finding. At five traces it is just a number.
	return `<span class="traces${n <= 1 ? ' quiet' : ''}">${said}</span>`;
}

function companyRow(company: Company, now: Date): string {
	const sub = company.subsector_id ? SUBSECTOR_BY_ID.get(company.subsector_id) : undefined;
	// A sub-sector chosen from a register's industry label is a claim about two
	// vocabularies agreeing, not about the company. The detail view spells that out;
	// the row carries the id and the name, which is what a reader scans by.
	const rdi = sub
		? `<a class="rdi" href="${esc(query({ subsector: sub.subsector_id }))}">${esc(sub.subsector_id)} ${esc(sub.subsector)}</a>`
		: '<span class="rdi unclassified">not yet classified</span>';
	// An address nothing ties to the company is not linked from its row as "website":
	// that label is a claim, and for Grinntech it was HyperVerge's. The address and the
	// reason stay on the detail page, where there is room to say why.
	const site = company.website_identity === 'discovered' ? null : safeUrl(company.website);
	const unconfirmed = company.website_identity !== 'verified';
	// The name goes to the detail view, not to the company. Everything we hold is on
	// that page, including the link out — and a row whose only link leaves the site is
	// a row that cannot be looked into.
	const name = `<a href="${esc(`${BASE_PATH}/c/${company.id}`)}">${esc(company.name)}</a>`;

	// What the company says it builds, read off its own homepage. Attributed on every
	// row that carries one, because this is the only line here that is not a fact
	// somebody published about the company in a register — it is the company's own
	// account of itself, and the difference is the whole reason the label is there.
	const builds = company.product && company.website_identity === 'verified' ? `<p class="builds">${esc(company.product)} <span class="says">in their own words</span></p>` : '';

	// The source's description is kept unless the homepage has already said it better.
	// A register-label row's "description" is an industry picked from a dropdown —
	// printing "Industry: Nanotechnology. Stage: Prototype." under a sentence about
	// what the company actually makes adds nothing and costs the row its clarity.
	const keepDescription = company.description && !(company.product && company.classify_basis === 'register-label');

	// Anchored by slug so a single row can be linked to and argued with, rather than
	// "it is somewhere in the list under 2.6".
	return `
  <li class="company" id="c-${esc(company.id)}">
    <div class="row-head">
      <h3>${name}</h3>
      ${rdi}
    </div>
    ${builds}
    ${keepDescription ? `<p class="desc">${esc(company.description)}</p>` : ''}
    <p class="facts">
      ${traceLine(company)}
      ${
				// Four fields, and this is the one a reader acts on fastest: no website
				// means genuinely early, and it also means you will have to work to reach
				// them. Only said where a source that publishes websites went looking.
				site
					? `<a class="fact-site" href="${esc(site)}" rel="noopener nofollow">website</a>${unconfirmed ? ' <span class="fact-unconfirmed">not confirmed as theirs</span>' : ''}`
					: company.website_checked
						? '<span class="fact-none">no website</span>'
						: ''
			}
      ${dateLine(company, now) ? `<span class="fact-seen">${dateLine(company, now)}</span>` : ''}
    </p>
  </li>`;
}

/**
 * The held-back line. A coverage cell can say 3 while the list shows 1, and the page
 * has to account for the other two rather than let the map look like it lied.
 */
function heldBack(view: PageView): string {
	const { buckets, age } = view;
	if (age === 'all' || buckets.older === 0) return '';

	const n = buckets.older;
	const href = `${query(viewParams(view, { age: 'all' }))}#list`;
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

/**
 * Why the tiers are empty, said once, above the list. A page that opened on an empty
 * A+B would look broken; a page that widened the view without explaining it would be
 * quietly changing its own promise.
 */
function backfillNote(view: PageView): string {
	// On an empty database it is vacuously true and reads as an excuse. Nothing to
	// explain until there is something to explain.
	if (!view.backfillOnly || view.tracked === 0) return '';
	return `<p class="note">Every company here arrived in a backfill. Tier A and B are for companies we see appear
    &mdash; those fill in from the first live run onward.</p>`;
}

/**
 * The companies the age gate cannot judge, counted where the gate is described.
 *
 * They are in the list rather than held back, on the same rule as an undated
 * company: "we do not know" is not "it is old". But the gate is the page's claim
 * to be showing recent companies, and it is not making that claim about these.
 */
function unknownAge(view: PageView): string {
	const n = view.buckets.unknownAge;
	if (n === 0) return '';

	return `<p class="note">${n} of these ${n === 1 ? 'is dated' : 'are dated'} by a public register rather than by a
    founding year &mdash; DPIIT publishes when it recognised a company, not when the company started. The
    ${MAX_AGE_YEARS}-year filter cannot be applied to ${n === 1 ? 'it' : 'them'}, and ${n === 1 ? 'its row says' : 'their rows say'} so.</p>`;
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
  ${backfillNote(view)}
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
  ${backfillNote(view)}
  ${heldBack(view)}
  ${unknownAge(view)}
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

/**
 * The companies we read, understood, and could not file.
 *
 * They are not a failure to report — they are the most specific thing this page
 * knows about the map it is drawn on. A coverage map that only showed what fit
 * would be measuring its own taxonomy rather than the country.
 */
function gapList(groups: { missing: string; n: number; examples: string[] }[]): string {
	return groups
		.map(
			(group) => `    <li>
      <span class="gap-n">${group.n}</span>
      <span class="gap-name">${esc(group.missing)}</span>
      ${group.examples.length > 0 ? `<span class="gap-eg">${esc(group.examples.join(', '))}</span>` : ''}
    </li>`,
		)
		.join('\n');
}

function offMap(view: PageView): string {
	const { gaps } = view;
	if (gaps.total === 0) return '';

	// Two sections, because they are two findings and only one of them is about
	// the taxonomy. Lumped together, the larger — companies we could not describe
	// — sat inside a heading that called it a hole in the RDI scheme. It is not.
	// It is a fact about what our sources publish, and it reads as an admission
	// rather than a critique, which is the honest way round.
	const taxonomy =
		gaps.taxonomy.total === 0
			? ''
			: `
<section class="list off-map" id="off-map" aria-labelledby="off-map-h">
  <h2 id="off-map-h">Companies the RDI taxonomy has no cell for <span class="count">${gaps.taxonomy.total}</span></h2>
  <p class="note">These landed in a sector whose sub-sectors do not cover what they do. Rather than stretch each one
    into the nearest cell &mdash; which would put a wrong tag on the map above and make it useless &mdash; they are
    kept here under the name of what is missing. Read this as a list of holes in the RDI taxonomy, not as a list of
    companies that failed: a map that only showed what fitted would be measuring itself.</p>
  <ul class="gap-groups">
${gapList(gaps.taxonomy.groups)}
  </ul>
</section>`;

	const undescribed =
		gaps.undescribed.total === 0
			? ''
			: `
<section class="list off-map" id="undescribed" aria-labelledby="undescribed-h">
  <h2 id="undescribed-h">Companies we could not describe well enough to place <span class="count">${gaps.undescribed.total}</span></h2>
  <p class="note">Nothing is wrong with the taxonomy here, and nothing is known to be wrong with these companies.
    Most arrived from the DPIIT register, where the only published facts are a name and an industry picked from a
    dropdown &mdash; not enough to say what the company does, and so not enough to place it. This is a limit of what
    our sources publish, and counting it as a gap in the RDI scheme would be blaming the scheme for our own blind spot.</p>
  <ul class="gap-groups">
${gapList(gaps.undescribed.groups)}
  </ul>
</section>`;

	return `${taxonomy}${undescribed}`;
}

/**
 * The register's companies, split by why each one did or did not place.
 *
 * This used to be one hand-written sentence — "sixty-one per cent of register
 * companies were placed in no sub-sector at all" — and it was true. It was also
 * two findings in one figure, pointing opposite ways: one says the RDI taxonomy
 * has no cell for what these companies build, the other says DPIIT published a
 * name and a dropdown label and we would not guess from that. Reported whole,
 * the second hides inside the first and reads as our shortcoming. It is not; it
 * is the more interesting half, and it is about the register.
 *
 * Counted rather than written down, so it cannot quietly stop being true — which
 * is exactly what the hand-written version did.
 */
function registerSplit(view: PageView): string {
	const { register } = view;
	if (register.total === 0) return '';

	const unplaced = register.taxonomyGap + register.undescribed;
	// Rounded once, here, so the prose cannot disagree with the numbers beside it.
	const share = Math.round((register.undescribed / register.total) * 100);

	const taxonomy =
		register.taxonomyGap === 0
			? ''
			: `
  <p><strong>${register.taxonomyGap}</strong> are unplaced because the RDI taxonomy has
    <a href="#off-map">no cell for what they build</a>. That is the scheme's boundary showing: a vocabulary written
    for five sunrise sectors, meeting companies nobody drafted it around.</p>`;

	const undescribed =
		register.undescribed === 0
			? ''
			: `
  <p><strong>${register.undescribed}</strong> are unplaced because
    <a href="#undescribed">the register never said what they do</a>. DPIIT recognition publishes a company name and
    an industry the founder picked from a dropdown, and for these ${register.undescribed} that is the entire public
    record. Enough to know they exist; nothing like enough to say what they build. They are left unplaced rather than
    guessed at.</p>
  <p>This is the more interesting half. A national startup register &mdash; the government's own list of who is doing
    this work &mdash; describes ${share}&nbsp;per&nbsp;cent of its companies too thinly for anyone to tell what they
    are. Not too thinly for us in particular: too thinly for anyone reading it. That is a finding about the register,
    and it deserves better than being averaged into a single number about sub-sectors.</p>`;

	return `
  <p>Of the ${register.total} companies read from the register, ${register.placed} reached a sub-sector and
    ${unplaced} did not. Reported whole, that second number says two different things at once, so it is split here.</p>${taxonomy}${undescribed}`;
}

/**
 * What came of reading company websites, including every way it did not work.
 *
 * The reason this is a paragraph and not a marker on every row: seventy rows each
 * saying "we could not read this one" is noise, and one sentence saying how many
 * publish an address that no longer answers is a finding. It is the same decision
 * the off-map companies got — group the absence, count it, name it.
 *
 * Every number is counted from the same database the rows come from. The temptation
 * here is to print only the successes; a column that appears on a fifth of the rows
 * and says nothing about the other four fifths is exactly the kind of quiet gap this
 * page exists to refuse.
 */
function productNote(view: PageView): string {
	const p = view.products;
	if (p.total === 0) return '';

	const failures: string[] = [];
	if (p.unreachable > 0) failures.push(`<strong>${p.unreachable}</strong> publish an address that no longer answers`);
	if (p.refused > 0) failures.push(`<strong>${p.refused}</strong> refused an automated reader`);
	if (p.thin > 0) failures.push(`<strong>${p.thin}</strong> served a page with no readable text on it`);
	if (p.unclear > 0) failures.push(`<strong>${p.unclear}</strong> never said what they make`);
	if (p.unverified > 0)
		failures.push(`<strong>${p.unverified}</strong> answered but could not be confirmed as the company&rsquo;s own site, so were not read`);

	const read = `Of the ${p.total} companies here, ${p.withSite} publish a website. Before reading one we check it is
    theirs &mdash; that the company&rsquo;s own source record gives it, that no other record gives the same address, and
    that their name is in the domain or on the page. A working address proves nothing about whose it is.${
			p.notTheirs > 0 ? ` <strong>${p.notTheirs}</strong> addresses failed that and are not linked as anyone&rsquo;s website.` : ''
		} <strong>${p.described}</strong> of them say plainly enough what they build for it to be worth quoting, and
    that sentence sits on the row, attributed, in their words and not ours. It is what a company claims about itself,
    which is not the same thing as a fact, and the link is there so you can disagree with it.`;

	const rest = failures.length
		? ` The rest did not work, and how they did not work is worth saying: ${failures.join(', ')}.
    A DPIIT-recognised startup whose domain has stopped resolving is a finding, not a missing cell.`
		: '';

	const none =
		p.noSite > 0
			? ` A further <strong>${p.noSite}</strong> have no website at all, where a source that publishes websites went
    looking and came back with nothing. On this list that counts in their favour.`
			: '';

	const never = p.total - p.withSite - p.noSite;
	const unlooked =
		never > 0
			? ` For the remaining ${never} no source has ever published a website field, so we do not know whether one
    exists and the page does not guess.`
			: '';

	return `
  <h3>What they build</h3>
  <p>${read}${rest}${none}${unlooked}</p>`;
}

function methodology(view: PageView): string {
	return `
<section class="method" aria-labelledby="method-h">
  <h2 id="method-h">Methodology</h2>

  <h3>Where this comes from</h3>
  <p>Public sources only, nothing behind a login. Four are read today: two incubator portfolios
    (<a href="https://www.sineiitb.org/portfolio/" rel="noopener">SINE IIT Bombay</a> and
    <a href="https://rtbi.in/incubationiitm/portfolio.html" rel="noopener">IIT Madras RTBI</a>), the published award lists
    of two grant programmes (<a href="https://birac.nic.in/" rel="noopener">BIRAC BIG</a> rounds 21&ndash;24 and
    DST NIDHI-PRAYAS, typed up by hand from the lists themselves), and the
    <a href="https://www.startupindia.gov.in/content/sih/en/search.html?roles=Startup" rel="noopener">DPIIT Startup India
    recognition register</a>. Patent filings, new incorporations at the MCA and every other incubator would all
    belong here and none of them is read yet, so nothing they would show is on this page. Every row carries the evidence that put it there.</p>

  ${productNote(view)}

  <h3>How the tiers are decided</h3>
  <p>There is no score. A number between 0 and 100 would pretend to a precision we do not have. Two facts decide the tier:
    how recently we first saw the company, and how many public traces it already has &mdash; today that means an
    incubator listing, a grant award, a DPIIT recognition and a website that answered when we fetched it. A domain that
    no longer resolves is not a trace, and stops being one the night it stops answering. A press mention ought to count
    as well; nothing collects it yet, so for now it does not, and the trace counts on this page are lower than they
    would be.</p>
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

  <h3>Two official classifications that do not meet</h3>
  <p>DPIIT's recognition register files every startup under its own industry vocabulary &mdash; 56 industries, chosen
    by the founder from a list when they applied. The RDI scheme has 44 sub-sectors, written by a different department
    for a different purpose. Neither was drawn up with the other in mind, and putting the same companies through both
    shows how little they overlap.</p>
  <p>Where the two vocabularies happen to have a near-twin, a company places almost automatically: DPIIT's
    &ldquo;Robotics&rdquo; against the scheme's &ldquo;Intelligent Systems &amp; Robotics&rdquo; placed 80 of 81. Where
    they have none, almost nothing places: 3 of 87 for &ldquo;Computer Vision&rdquo;, 7 of 83 for &ldquo;AI&rdquo;.
    Same companies, same government, two filing systems that do not map onto each other. That is a finding about the
    taxonomies, not a fault in either.</p>
  <p>It does mean a row placed this way rests on the register's label rather than on anything published about what the
    company does, and should be read as exactly that much. Each company's own page says which of the two it was, in the
    classifier's own words. It also means the fuller cells of the coverage map above are partly a map of where the two
    vocabularies agree.</p>
${registerSplit(view)}

  <h3>What this misses</h3>
  <p>A fair amount, and it is worth being blunt about it. There is no LinkedIn here, and no stealth companies: if a company
    has not appeared anywhere public, this page cannot see it and will not pretend otherwise. The list leans toward
    institutions that publish their portfolios, which means well-documented incubators are over-represented and quieter
    regional ones are under-represented. An empty cell in the coverage map above means we have found nothing there yet
    &mdash; it is a gap in our sources, not evidence that nothing exists. Classification into RDI sub-sectors is automated
    and will sometimes be wrong.</p>
</section>`;
}

// --- one company ------------------------------------------------------------

export interface CompanyView {
	company: Company;
	now: Date;
}

/** Why this company is in the tier it is in, in the words of the rule that decided. */
function whyTier(company: Company): string {
	if (company.first_seen === null) {
		return `No source will say when this company became visible, so it cannot be called an early find
      however new it looks. A row with no date is Tier C by the rule, not by judgement.`;
	}
	if (company.first_seen_basis === 'cohort') {
		return `The date here was read off a published cohort or award year during a backfill. That is the
      incubator's news rather than ours, and only a company we watched arrive can reach Tier A.`;
	}
	const traces = company.trace_count;
	return `Found in a run of a source that was already running, with ${traces === 1 ? '1 public trace' : `${traces} public traces`}
    at the time. Tier A is a discovery under 90 days old with at most 2 traces; Tier B under 180 days with
    at most 5.`;
}

/** What reading the homepage came to, said in full on the one page with room for it. */
function productDetail(company: Company): string {
	const site = safeUrl(company.website);
	const link = site ? ` <a href="${esc(site)}" rel="noopener nofollow">${esc(site)}</a>` : '';

	// Whose address it is comes before anything read from it, because it decides
	// whether anything was read at all.
	if (site && company.website_identity === 'discovered') {
		return `<p class="provenance identity">A source gives${link} for this company, and it is not treated as
        theirs: ${esc(company.website_identity_note ?? 'nothing ties the address to them')}. Nothing on it is shown
        here.</p>`;
	}
	const identity =
		site && company.website_identity
			? `<p class="provenance identity">Website ${company.website_identity === 'verified' ? 'identity checked' : 'not confirmed as theirs'}:
        ${esc(company.website_identity_note ?? '')}.</p>`
			: '';

	return identity + productStatusDetail(company, link, site);
}

function productStatusDetail(company: Company, link: string, site: string | null): string {
	switch (company.product_status) {
		case 'described':
			if (!company.product || company.website_identity !== 'verified') break;
			return `<p class="builds">${esc(company.product)} <span class="says">in their own words</span></p>
        <p class="provenance">Read from${link || ' their homepage'}, whose name was checked and whose content was not.
        It is what the company says about itself.</p>`;
		case 'unverified':
			return `<p class="provenance">${link || 'Their site'} answered, but nothing on it confirmed the address is
        theirs, so it was not read. A sentence from someone else's homepage is worse than none.</p>`;
		case 'unreachable':
			return `<p class="provenance">They publish${link}, and it does not answer. A recognised startup whose
        own domain has stopped resolving is worth knowing about.</p>`;
		case 'refused':
			return `<p class="provenance">${link || 'Their site'} refused an automated reader, which is its right. What
        they build is on that page; nobody here has read it.</p>`;
		case 'thin':
			return `<p class="provenance">${link || 'Their site'} answered with a page that draws itself in the
        browser and carries no readable text, so there was nothing on it to read.</p>`;
		case 'unclear':
			return `<p class="provenance">We read${link || ' their homepage'} and it never said what they make.</p>`;
	}

	// No status at all, which is three different situations and not one. The first is
	// the trap: a company with a website we simply have not read yet is not a company
	// without a website, and saying so would invent a finding out of a queue.
	if (site) {
		return `<p class="provenance">They publish${link}. Nobody has read it yet &mdash; the nightly run works
          through new companies a few at a time.</p>`;
	}
	return company.website_checked
		? `<p class="provenance">No website. A source that publishes them went looking and came back with
          nothing, which on this list counts in their favour.</p>`
		: `<p class="provenance">No source has published a website for this company, so we do not know
          whether there is one.</p>`;
}

/**
 * Everything held about one company, on a page of its own.
 *
 * The list has to choose four facts; this chooses none. The classifier's reasoning is
 * printed verbatim rather than summarised, every signal is a link back to the page it
 * came from, and all four dates are separate because they mean four different things.
 * Somebody disagreeing with a placement should be able to see exactly what was decided
 * and on what, without an API key and without reading the source.
 */
export function renderCompanyPage(view: CompanyView): string {
	const { company, now } = view;
	const sub = company.subsector_id ? SUBSECTOR_BY_ID.get(company.subsector_id) : undefined;
	// Not a discovered address: the header link reads as "their site", and for Grinntech
	// it was HyperVerge's. productDetail still names the address, with the reason.
	const site = company.website_identity === 'discovered' ? null : safeUrl(company.website);

	const signals = company.signals.length
		? `<ul class="evidence">${company.signals
				.map((signal) => {
					const href = safeUrl(signal.url);
					const where = href
						? `<a href="${esc(href)}" rel="noopener nofollow">${esc(new URL(href).hostname)}</a>`
						: '<span class="no-link">no link published</span>';
					const when = signal.date ? `<span class="ev-date">${esc(signal.date)}</span>` : '';
					return `<li>
        <span class="ev-type">${esc(signal.type)}</span>
        <span class="ev-label">${esc(signal.label)}</span>
        ${when}
        ${where}
      </li>`;
				})
				.join('')}</ul>`
		: '<p class="provenance">No signals recorded, which should not be possible &mdash; every company here arrived with at least one.</p>';

	const dates = [
		['Started', company.origin_year ?? company.founded_year, 'The year a source says the company began. This is what the age gate reads.'],
		[
			'On record',
			company.first_seen,
			company.first_seen_basis === 'cohort' ? 'Read off a published cohort or award year.' : 'The day it appeared in a run of ours.',
		],
		['In this database', company.discovered, 'The day the row was written. Never a claim about the company.'],
	] as const;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(company.name)} &mdash; Upstream</title>
<meta name="description" content="${esc(company.product ?? company.description ?? company.name)}">
<meta name="color-scheme" content="light dark">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap">
<style>${STYLES}</style>
</head>
<body>
<div class="wrap detail">
  <p class="eyebrow"><a href="${esc(BASE_PATH)}">&larr; Upstream</a></p>

  <header class="masthead">
    <h1>${esc(company.name)}</h1>
    <p class="facts">
      ${traceLine(company)}
      ${site ? `<a class="fact-site" href="${esc(site)}" rel="noopener nofollow">${esc(new URL(site).hostname)}</a>` : ''}
      ${company.city ? `<span class="fact-seen">${esc(company.city)}${company.state ? `, ${esc(company.state)}` : ''}</span>` : ''}
    </p>
  </header>

  <section>
    <h2>What they build</h2>
    ${productDetail(company)}
    ${company.description ? `<p class="desc">${esc(company.description)}<span class="says">as the source described it</span></p>` : ''}
  </section>

  <section>
    <h2>Where it sits in the RDI scheme</h2>
    ${
			sub
				? `<p class="rdi-full"><a href="${esc(`${BASE_PATH}${query({ subsector: sub.subsector_id })}`)}">${esc(sub.subsector_id)} &mdash; ${esc(sub.subsector)}</a></p>
      ${company.project_type ? `<p class="provenance">Matched project: ${esc(company.project_type)}</p>` : ''}
      ${
				// The note is quoted when there is one; what the classifier was working from
				// is stated either way. That distinction used to be a marker on the row, and
				// nesting it inside the quote would have let it vanish for every company
				// placed without a recorded reason.
				company.classify_note ? `<blockquote class="note-verbatim">${esc(company.classify_note)}</blockquote>` : ''
			}
      <p class="provenance">${company.classify_note ? 'That is the classifier&rsquo;s reasoning, printed as it was written. It' : 'The classifier'}
        was working from ${
					company.classify_basis === 'register-label'
						? "a register's industry label, not a description of what the company does, so this placement rests on two vocabularies agreeing rather than on anything published about the company"
						: 'the description above'
				}.</p>`
				: '<p class="provenance">Not placed in any sub-sector.</p>'
		}
  </section>

  <section>
    <h2>Evidence</h2>
    <p class="provenance">Everything that put this company on the list, with the page it came from.</p>
    ${signals}
  </section>

  <section>
    <h2>Dates</h2>
    <dl class="dates">
      ${dates
				.filter(([, value]) => value)
				.map(([label, value, why]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd><dd class="why">${why}</dd></div>`)
				.join('')}
    </dl>
    ${company.first_seen === null ? '<p class="provenance">No source will say when this company became visible, so the list keeps it out of the ranking.</p>' : ''}
  </section>

  <section>
    <h2>Tier ${esc(company.tier)}</h2>
    <p class="provenance">${whyTier(company)}</p>
  </section>
</div>
</body>
</html>`;
}

// --- styles -----------------------------------------------------------------

export const STYLES = `
:root {
  color-scheme: light dark;

  /* Ink on paper, the same two as rohitrao.in. --raise is the one step up from the
     page: the surface a row or a control sits on when it is being touched. */
  --paper: #fbfaf8;
  --raise: #ffffff;
  --ink: #141310;
  --muted: #6e6a62;
  --rule: #e5e1d9;
  /* A second weight of line, so "this is a boundary" and "this is the boundary that
     matters" do not have to be the same hairline. */
  --rule-strong: #d3cec3;

  /* The one yellow. It means exactly one thing on this page — nobody has noticed this
     company yet — and it is spent on the Tier A marker and the "no website yet" chip.
     Everything else that needs emphasis gets weight or space instead, because a colour
     that means two things means neither. */
  --mark: #ffd84a;

  --sans: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "DM Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  /* One ladder of space. Every margin and every pad below is a rung on it, which is
     the whole difference between a page with rhythm and a page of decisions taken one
     at a time. */
  /* Below the ladder on purpose, and only for the inside of a pill: a chip or a badge
     padded to a full quarter-rem stops reading as a label and starts reading as a
     button. Two rungs, so the exception cannot quietly become the rule. */
  --s0: 0.125rem;
  --s0h: 0.375rem;

  --s1: 0.25rem;
  --s2: 0.5rem;
  --s3: 0.75rem;
  --s4: 1rem;
  --s5: 1.5rem;
  --s6: 2rem;
  --s7: 3rem;

  /* And one ladder of type. Phone first: only the two largest sizes grow with the
     viewport, and everything else holds still — a body size that scales with the
     screen is how a list stops feeling like the same list on a laptop. */
  --t-hero: clamp(1.6rem, 5.4vw, 2.45rem);
  --t-lede: clamp(1rem, 1.9vw, 1.12rem);
  --t-stat: 1.6rem;
  --t-h: 1.05rem;
  --t-body: 1rem;
  --t-sm: 0.875rem;
  --t-xs: 0.8rem;
  --t-micro: 0.72rem;
  /* The map only. Forty-four cells on a phone is the one place on this page that
     has to go below the smallest size the prose is allowed to use. */
  --t-nano: 0.66rem;

  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #141310;
    --raise: #1d1b17;
    --ink: #f1eee8;
    --muted: #9b968c;
    --rule: #2e2a24;
    --rule-strong: #423c33;
  }
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  font-size: var(--t-body);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  /* Scraped names and labels can be long and unbroken; never let one scroll the page. */
  overflow-wrap: break-word;
}
.wrap { max-width: 60rem; margin: 0 auto; padding: var(--s6) var(--s4) var(--s7); }
a { color: inherit; }
h1, h2, h3 { line-height: 1.2; letter-spacing: -0.015em; }
p { margin: 0 0 var(--s3); }
/* Long unbroken scraped names stay inside their column; headings break where a
   reader would rather they did. */
h1, h2, h3, .hook, .note { text-wrap: pretty; }

/* header */
.masthead { margin-bottom: var(--s7); }
/* The wordmark, demoted on purpose. The name is not the proposition, and a reader
   who has never heard of this needs the second thing first. */
.eyebrow {
  font-family: var(--mono);
  font-size: var(--t-micro);
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--muted);
  margin: 0 0 var(--s3);
}
.masthead h1 {
  font-size: var(--t-hero);
  line-height: 1.08;
  letter-spacing: -0.03em;
  font-weight: 600;
  margin: 0 0 var(--s4);
  /* Measured in characters, so the line breaks at a readable length on any screen
     rather than at whatever width the viewport happens to be. */
  max-width: 26ch;
  text-wrap: balance;
}
.hook { font-size: var(--t-lede); color: var(--muted); max-width: 48ch; margin: 0 0 var(--s6); }
/* The half worth repeating, lifted out of the muted text by weight alone. */
.hook strong { color: var(--ink); font-weight: 500; }
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
  gap: var(--s4) var(--s5);
  margin: 0;
  padding: var(--s4) 0 0;
  border-top: 1px solid var(--rule);
}
.stats dt {
  font-size: var(--t-micro);
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  line-height: 1.35;
}
.stats dd {
  margin: var(--s1) 0 0;
  font-family: var(--mono);
  font-size: var(--t-stat);
  font-weight: 500;
  letter-spacing: -0.03em;
  line-height: 1.1;
}
.stats .of { color: var(--muted); font-size: var(--t-sm); letter-spacing: 0; }
/* Only rendered when it is not zero, so this is always news. */
.fresh { font-size: var(--t-xs); color: var(--muted); margin: var(--s4) 0 0; }
.funnel-note { color: var(--muted); font-size: var(--t-xs); max-width: 46ch; margin: var(--s5) 0 0; }

/* section furniture */
section { margin: 0 0 var(--s7); }
/* Everything that is not the list gets the quiet head: a label on a rule. */
section > h2 {
  font-size: var(--t-micro);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted);
  font-weight: 500;
  margin: 0 0 var(--s2);
  padding-bottom: var(--s2);
  border-bottom: 1px solid var(--rule);
}
/* The list is the page. Its head is the one that reads as a heading rather than as
   furniture — every section looking equally important is how a product reads as a
   report. */
.list > h2 {
  font-size: var(--t-h);
  text-transform: none;
  letter-spacing: -0.015em;
  color: var(--ink);
  font-weight: 600;
  padding-bottom: var(--s3);
  border-bottom-color: var(--rule-strong);
}
.note { color: var(--muted); font-size: var(--t-xs); max-width: 52ch; margin-bottom: var(--s4); }

/* coverage map */
.sector { margin-bottom: var(--s5); }
.sector h3 {
  display: flex;
  align-items: center;
  gap: var(--s2);
  font-size: var(--t-xs);
  font-weight: 500;
  margin: 0 0 var(--s2);
  color: var(--muted);
}
/* Sized in em so it tracks the heading rather than being pinned to a pixel, and
   flex-shrink: 0 so a long sector name cannot squash it. */
.sector-icon { width: 1.35em; height: 1.35em; flex: 0 0 auto; opacity: 0.75; }
.sector-id { font-family: var(--mono); }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(64px, 1fr)); gap: var(--s1); }
.cell {
  display: flex;
  flex-direction: column;
  min-height: 46px;
  padding: var(--s1) var(--s0h);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  text-decoration: none;
  position: relative;
}
/* id and count share a line. Two stacked lines was most of the cell's height,
   and the count is the thing being compared across cells — putting it next to
   the id reads better than parking it at the bottom. */
.cell-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s1); line-height: 1.2; }
.cell-id { font-family: var(--mono); font-size: var(--t-nano); color: var(--muted); }
.cell-name {
  font-size: var(--t-nano);
  line-height: 1.2;
  margin-top: var(--s0);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.cell-n {
  font-family: var(--mono);
  font-size: var(--t-micro);
}
.cell.empty { color: var(--muted); border-style: dashed; }
.cell.empty .cell-n { opacity: 0.45; }
.cell.filled { background: var(--raise); border-color: color-mix(in srgb, var(--ink) 22%, transparent); }
.cell.filled .cell-n { font-weight: 500; }
.cell:hover { border-color: var(--rule-strong); background: var(--raise); }
.cell.filled:hover { border-color: color-mix(in srgb, var(--ink) 45%, transparent); }
.cell:active { transform: translateY(1px); }
.cell.active { border-color: var(--ink); border-style: solid; box-shadow: inset 0 0 0 1px var(--ink); }

/* The map folds on a narrow screen only. Above the breakpoint the summary is
   not rendered at all and the section looks exactly as it always has. */
.map-fold > summary { display: none; }
@media (max-width: 699px) {
  .map-fold > summary {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--s2);
    cursor: pointer;
    padding: var(--s2) var(--s3);
    margin-bottom: var(--s4);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    list-style: none;
  }
  .map-fold > summary::-webkit-details-marker { display: none; }
  .map-fold-label { font-weight: 500; }
  .map-fold-meta { color: var(--muted); font-size: var(--t-xs); }
  /* The affordance, written by CSS so the two states cannot disagree. */
  .map-fold > summary::after { content: "show"; margin-left: auto; color: var(--muted); font-size: var(--t-xs); }
  .map-fold[open] > summary::after { content: "hide"; }
}

/* filters */
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  /* Seven controls now. On a phone they stack two-up rather than one long column,
     which is why the selects are allowed to shrink below their content width. */
  gap: var(--s3) var(--s4);
  padding: var(--s4) 0;
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
  margin-bottom: var(--s5);
}
.field { display: flex; flex-direction: column; gap: var(--s1); }
.field label, .legend {
  font-size: var(--t-micro);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
select {
  font: inherit;
  font-size: var(--t-sm);
  color: inherit;
  background: var(--raise);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  padding: var(--s2) var(--s3);
  max-width: 100%;
}
select:hover, .apply:hover { border-color: var(--rule-strong); }
/* Without this a select refuses to go narrower than its longest option and the bar
   pushes the page sideways on a phone. */
.filters .field { flex: 1 1 9rem; min-width: 0; }
.filters select { width: 100%; }
.seg:hover:not(.on) { background: var(--paper); }
.segmented { display: flex; border: 1px solid var(--rule); border-radius: var(--radius); overflow: hidden; }
.seg {
  font-size: var(--t-sm);
  padding: var(--s2) var(--s3);
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
  font-size: var(--t-sm);
  padding: var(--s2) var(--s4);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--raise);
  color: inherit;
  cursor: pointer;
}
.clear { font-size: var(--t-xs); color: var(--muted); }
.export {
  font-size: var(--t-xs);
  color: var(--muted);
  text-decoration-color: var(--rule-strong);
  text-underline-offset: 3px;
  margin-left: auto;
}
.export:hover { color: var(--ink); text-decoration-color: currentColor; }

/* list */
.list h2 .count { font-family: var(--mono); }
.companies { list-style: none; margin: 0; padding: 0; }
/* Padded past the text column and pulled back by the same amount, so a row can take
   a background on hover without the text appearing to shift. */
.company {
  padding: var(--s5) var(--s3);
  margin-inline: calc(var(--s3) * -1);
  border-bottom: 1px solid var(--rule);
}
@media (hover: hover) {
  .company:hover { background: var(--raise); }
}
/* Keyboard and link-sharing get the same acknowledgement as a mouse. Rows are
   anchored by slug precisely so one can be sent to someone; arriving at it should
   show which one was meant. */
.company:focus-within { background: var(--raise); }
.company:target { background: var(--raise); box-shadow: inset 2px 0 0 var(--ink); }
.row-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s2) var(--s3); margin-bottom: var(--s2); }
.row-head h3 { font-size: var(--t-h); font-weight: 600; margin: 0; flex: 1 1 auto; }
.row-head h3 a { text-decoration-color: var(--rule-strong); text-underline-offset: 3px; }
.row-head h3 a:hover { text-decoration-color: currentColor; }
.place { font-size: var(--t-xs); color: var(--muted); }
.tier {
  font-family: var(--mono);
  font-size: var(--t-micro);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: var(--s0) var(--s0h);
  border-radius: 4px;
  border: 1px solid var(--rule);
  color: var(--muted);
  white-space: nowrap;
}
/* The yellow appears exactly twice on this page: on a Tier A marker and on
   "no website yet". Both say the same thing — this one is still unnoticed. */
.tier.ta { background: var(--mark); border-color: var(--mark); color: #141310; }
/* On a dark screen a solid fill of this yellow is the brightest thing on the page by
   a wide margin, which turns a quiet marker into a siren. Washed back to a
   highlighter — the way the same yellow is used on rohitrao.in — it still reads as
   marked without taking over the row. */
@media (prefers-color-scheme: dark) {
  .tier.ta, .chip.positive {
    background: color-mix(in srgb, var(--mark) 20%, transparent);
    border-color: color-mix(in srgb, var(--mark) 45%, transparent);
    color: var(--ink);
  }
}
/* What the company says it builds. One rung up from the source's description
   because on most rows it is the only concrete sentence there — and set in ink
   rather than muted, so a row that has one reads differently at a glance from a
   row that does not. */
.builds { margin: 0 0 var(--s0h); max-width: 56ch; color: var(--ink); }
/* The attribution is not decoration. This line is the company's own account of
   itself and the row must never let it read as something we checked. */
.says {
  font-size: var(--t-micro);
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.07em;
  white-space: nowrap;
}
.desc { margin: 0 0 var(--s0h); max-width: 56ch; color: var(--muted); font-size: var(--t-sm); }
.rdi {
  font-family: var(--mono);
  font-size: var(--t-micro);
  color: var(--muted);
  text-decoration: none;
  white-space: nowrap;
  border: 1px solid var(--rule);
  border-radius: 999px;
  padding: var(--s0) var(--s2);
}
a.rdi:hover { border-color: var(--rule-strong); color: var(--ink); }
.rdi.unclassified { font-style: italic; border-style: dashed; }
.from-label {
  margin-left: var(--s2);
  padding: var(--s0) var(--s0h);
  border: 1px solid var(--rule);
  border-radius: 4px;
  font-size: var(--t-micro);
  font-family: var(--sans);
  white-space: nowrap;
}
.chips { list-style: none; display: flex; flex-wrap: wrap; gap: var(--s0h); margin: 0 0 var(--s2); padding: 0; }
.chip {
  display: inline-block;
  font-size: var(--t-xs);
  padding: var(--s0) var(--s2);
  border: 1px solid var(--rule);
  border-radius: 999px;
  background: var(--raise);
  color: var(--muted);
  text-decoration: none;
}
a.chip { color: var(--ink); }
a.chip:hover { border-color: color-mix(in srgb, var(--ink) 45%, transparent); }
.chip.positive { background: var(--mark); border-color: var(--mark); color: #141310; }

/* the four facts a row carries */
.facts {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--s2) var(--s3);
  margin: 0;
  font-size: var(--t-xs);
  color: var(--muted);
}
.facts > * { white-space: nowrap; }
/* The number the list is sorted by. Set in ink at one trace or none, because that
   is the claim; at five it is just a number and stays muted. */
.traces { font-family: var(--mono); }
.traces.quiet { color: var(--ink); }
/* The page's one yellow, and the same meaning it has always had: nobody has noticed
   this company yet. It moved off a pill and onto the fact itself, which is a
   highlighter rather than a badge — and the way this yellow is used on rohitrao.in. */
.fact-none {
  background: linear-gradient(to top, var(--mark) 0%, var(--mark) 45%, transparent 45%);
  color: var(--ink);
  padding: 0 var(--s0h) var(--s0);
}
.fact-site { color: var(--ink); text-decoration-color: var(--rule-strong); text-underline-offset: 3px; }
.fact-site:hover { text-decoration-color: currentColor; }
.fact-unconfirmed { color: var(--muted); font-size: 0.92em; }
.seen { font-size: var(--t-xs); color: var(--muted); margin: 0; }
.empty { color: var(--muted); }
/* Below the ranking and visibly outside it — same rows, no claim about time. */
.undated-list { margin-top: var(--s6); padding-top: var(--s5); border-top: 1px solid var(--rule); }
.undated-list h2 { color: var(--muted); }
.off-map { margin-top: var(--s6); padding-top: var(--s5); border-top: 1px solid var(--rule); }
.off-map h2 { color: var(--muted); }
.gap-groups { list-style: none; margin: 0; padding: 0; }
.gap-groups li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--s2);
  padding: var(--s2) 0;
  border-bottom: 1px solid var(--rule);
}
.gap-n {
  font-family: var(--mono);
  font-size: var(--t-xs);
  min-width: 2.2rem;
  text-align: right;
  color: var(--muted);
}
.gap-name { font-weight: 500; }
.gap-eg { font-size: var(--t-xs); color: var(--muted); flex: 1 1 14rem; }
.demo-banner {
  font-size: var(--t-sm);
  color: var(--muted);
  border: 1px dashed var(--rule);
  border-radius: var(--radius);
  padding: var(--s3) var(--s4);
  margin: var(--s4) 0 var(--s1);
}

/* search */
.field-search { flex: 1 1 14rem; min-width: 0; }
input[type='search'] {
  font: inherit;
  font-size: var(--t-sm);
  color: inherit;
  background: var(--raise);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  padding: var(--s2) var(--s3);
  width: 100%;
  min-width: 0;
}
input[type='search']:hover { border-color: var(--rule-strong); }
input[type='search']:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

/* one company */
.detail section { margin-bottom: var(--s6); }
.detail section > h2 {
  font-size: var(--t-micro);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted);
  font-weight: 500;
  margin: 0 0 var(--s3);
  padding-bottom: var(--s2);
  border-bottom: 1px solid var(--rule);
}
.detail .masthead h1 { max-width: 20ch; }
.detail .eyebrow a { text-decoration: none; }
.detail .eyebrow a:hover { color: var(--ink); }
/* Why a thing is what it is. Muted, because it is always explaining something else
   on the page rather than being the thing itself. */
.provenance { font-size: var(--t-sm); color: var(--muted); max-width: 60ch; }
/* The classifier's reasoning, printed as written. Set apart so it cannot be mistaken
   for the page speaking in its own voice. */
.note-verbatim {
  margin: var(--s3) 0;
  padding: var(--s3) var(--s4);
  border-left: 2px solid var(--rule-strong);
  background: var(--raise);
  font-size: var(--t-sm);
  max-width: 60ch;
}
.rdi-full { font-family: var(--mono); font-size: var(--t-sm); margin: 0 0 var(--s2); }
.evidence { list-style: none; margin: 0; padding: 0; }
.evidence li {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--s2) var(--s3);
  padding: var(--s3) 0;
  border-bottom: 1px solid var(--rule);
  font-size: var(--t-sm);
}
.ev-type {
  font-family: var(--mono);
  font-size: var(--t-micro);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  flex: 0 0 5.5rem;
}
.ev-label { flex: 1 1 16rem; }
.ev-date { font-family: var(--mono); font-size: var(--t-micro); color: var(--muted); }
.no-link { color: var(--muted); font-style: italic; }
.dates { margin: 0; }
.dates > div {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--s2) var(--s3);
  padding: var(--s3) 0;
  border-bottom: 1px solid var(--rule);
}
.dates dt { flex: 0 0 8rem; font-size: var(--t-xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.dates dd { margin: 0; font-family: var(--mono); font-size: var(--t-sm); }
.dates dd.why { font-family: var(--sans); font-size: var(--t-xs); color: var(--muted); flex: 1 1 18rem; }

/* the notebook */
.whoami { font-family: var(--mono); text-transform: none; letter-spacing: 0; margin-left: var(--s2); }
textarea {
  font: inherit;
  font-size: var(--t-body);
  line-height: 1.6;
  color: inherit;
  background: var(--raise);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  padding: var(--s3);
  width: 100%;
  resize: vertical;
}
textarea:hover { border-color: var(--rule-strong); }
textarea:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.note-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s3); margin-top: var(--s3); }
/* Destructive, so it is a plain word rather than a button competing with Save. */
.clear-button {
  font: inherit;
  font-size: var(--t-xs);
  color: var(--muted);
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.clear-button:hover { color: var(--ink); }

/* methodology */
.method h3 { font-size: var(--t-body); margin: var(--s5) 0 var(--s2); }
.method p, .method li { font-size: var(--t-sm); color: var(--muted); max-width: 56ch; }
.method a { color: var(--ink); }
.rules { list-style: none; margin: 0 0 var(--s4); padding: 0; }
.rules li { margin-bottom: var(--s0h); display: flex; gap: var(--s2); align-items: baseline; }
.rules .tier { flex: 0 0 auto; }

/* wider screens */
@media (min-width: 46rem) {
  .wrap { padding: var(--s7) var(--s6) calc(var(--s7) * 1.5); }
  .grid { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); }
  .company { padding-inline: var(--s4); margin-inline: calc(var(--s4) * -1); }
}

/* The radio inputs behind the segmented control are visually hidden but still
   focusable, so the focus ring has to be drawn on the label. */
.seg:has(input:focus-visible) { outline: 2px solid var(--ink); outline-offset: -2px; }
a:focus-visible, select:focus-visible, .apply:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

@media (prefers-reduced-motion: no-preference) {
  .cell, .chip, .apply, .company, select, .seg { transition: border-color 120ms ease, background 120ms ease; }
}
`;

// --- the page ---------------------------------------------------------------

export function renderPage(view: PageView): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upstream &mdash; Indian deep tech, ranked by obscurity</title>
<meta name="description" content="Every other list ranks by how impressive a company looks, which is why every fund keeps finding the same twenty names. ${view.tracked} early-stage Indian deep-tech companies, sorted by obscurity, with the evidence on every row.">
<meta name="color-scheme" content="light dark">
<!-- The same list is reachable by several orderings of the same parameters, and by
     parameters sitting at their defaults. This is the one spelling of it. -->
<link rel="canonical" href="${esc(`${BASE_PATH}${query(viewParams(view))}`)}">
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
${offMap(view)}
${methodology(view)}
</div>
<script>
  // Progressive enhancement only: without this the Apply button does the same job.
  (function () {
    var form = document.querySelector('.filters');
    if (!form) return;
    form.querySelector('.apply').hidden = true;
    form.addEventListener('change', function () { form.submit(); });
  })();

  // The coverage map is six rows on a desktop and eleven on a phone, which puts
  // the company list below the fold on the device most likely to be reading it.
  // The markup ships open, so without this the map behaves as it always has.
  (function () {
    var fold = document.querySelector('.map-fold');
    if (!fold || !window.matchMedia) return;
    var narrow = window.matchMedia('(max-width: 699px)');
    function sync() { fold.open = !narrow.matches; }
    sync();
    // Only on crossing the breakpoint, so a reader who opens the map by hand
    // keeps it open, and one who arrives on a desktop never finds it shut with
    // the summary hidden and no way back.
    if (narrow.addEventListener) narrow.addEventListener('change', sync);
    else if (narrow.addListener) narrow.addListener(sync);
  })();
</script>
</body>
</html>`;
}
