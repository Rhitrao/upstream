/**
 * The page. Server-rendered from a template string — no React, no build step, no
 * framework. This is a list of text and it has to load instantly on a phone, which is
 * where a shared link gets opened.
 *
 * The only JavaScript on the page submits the filter form on change. Everything works
 * without it: the filters are a GET form and every coverage cell is a link.
 */
import { INDIA_MAP_HEIGHT, INDIA_MAP_WIDTH, INDIA_STATES } from './india-map';
import { SECTOR_GROUPS, SUBSECTOR_BY_ID, SUNRISE_SECTORS } from './taxonomy';
import { daysSince, earliestEvent, MAX_AGE_YEARS, type Tier } from './rank';
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
	type SourceHealth,
	type Widgets,
	type TraceBucket,
	type DescribedState,
	labelKind,
	TRACE_BUCKETS,
	DESCRIBED_STATES,
	DPIIT_STATUS_PHRASES,
	papersOf,
	registerText,
	type DescribedChoice,
	type KindChoice,
	type Substance,
	type Findings,
	OUTSIDE_TAXONOMY,
	BUILD_TAGS,
	DOMAIN_TAGS,
	tagsOf,
	siteSignalsOf,
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
	/** Of `tracked`, the records nothing on record shows to be a company. */
	notCompanies: number;
	/** Each source's last attempt and last good run. Empty until a run has reported. */
	sourceHealth: SourceHealth[];
	/** The widget row's counts under the current filters. null for the sample data. */
	widgets: Widgets | null;
	/** The question box: answering, resting on examples, or not drawn at all. */
	ask?: 'on' | 'rest' | null;
	/** The state the list is filtered to, 'unknown', or null. */
	state: string | null;
	traces: TraceBucket | null;
	/** 'said' by default: the list shows what a sentence describes. null is every record. */
	described: DescribedChoice | null;
	/** 'company' by default; 'other' for projects and unverified names; null for both. */
	kind: KindChoice | null;
	/** A register status the list is filtered to, or null. */
	dpiit: string | null;
	/** Keyword tags the list is filtered to: what it builds, where it is used. */
	build: string | null;
	domain: string | null;
	/** '1' when the list is narrowed to companies exactly one outside source has noticed. */
	noticed?: string | null;
	/** '2' or '3' when narrowed to companies in at least that many public programmes; alone '1' for no other trace. */
	programmes?: string | null;
	alone?: string | null;
	/** The page's two halves, counted over every record. */
	substance: Substance;
	/** The numbers behind the findings under the masthead. null for the sample data. */
	findings: Findings | null;
	/** This site's origin, for the absolute links a copied brief carries. */
	origin: string;
	/** Records in the chosen half (described, kind, register status) before any other filter. */
	category: number;
	/** When the list is empty: how many records match the same search and filters in every half, tier and year. */
	wider?: number | null;
	/** When a search finds nothing anywhere: the names closest to what was typed. */
	suggestions?: { id: string; name: string }[];
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

/** What each kind of evidence is called when its date is the one on the row. */
const EVENT_NAMES: Record<string, string> = {
	dpiit: 'DPIIT register record',
	award: 'award',
	incubator: 'incubator listing',
	grant: 'grant award',
	press: 'press mention',
	patent: 'patent filing',
	incorporation: 'incorporated',
	website: 'website seen',
};

/** A source date a reader can place: a full ISO date, or a year when that is all a source gave. */
function isDated(date: string | null | undefined): boolean {
	return Boolean(date && (date.length >= 10 || /^\d{4}$/.test(date)));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "25 Aug 2023" — a date a reader can place without arithmetic. */
function shortDate(iso: string): string {
	const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
	return d && m ? `${d} ${MONTHS[m - 1]} ${y}` : String(y);
}

/**
 * The oldest dated thing a source says about the company, named: "DPIIT register record
 * 25 Aug 2023". Null when no source dates anything.
 */
function sourceEvent(company: Company): { label: string; date: string } | null {
	const dated = company.signals.filter((s) => isDated(s.date)).sort((a, b) => (a.date! < b.date! ? -1 : 1));
	if (dated.length) return { label: EVENT_NAMES[dated[0].type] ?? dated[0].type, date: dated[0].date!.slice(0, 10) };
	if (company.first_seen_basis === 'cohort' && company.first_seen !== null) {
		return { label: 'on public record from', date: String(company.origin_year ?? company.first_seen.slice(0, 4)) };
	}
	return null;
}

function addedAgo(iso: string, now: Date): string {
	const days = Math.floor(daysSince(iso, now));
	if (!Number.isFinite(days)) return 'on a date not recorded';
	if (days <= 0) return 'today';
	if (days === 1) return 'yesterday';
	if (days < 60) return `${days} days ago`;
	return `on ${shortDate(iso)}`;
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
/**
 * The headline counts substance, not coverage: companies a published sentence says the
 * work of. It used to count every row, 761 of them on 13 September, most of which were a
 * name and a dropdown industry. A smaller number that is all leads says more than a
 * larger one that is mostly names; the rest are counted beside it, not dropped.
 */
function proposition(companies: number): string {
	return `${companies} Indian deep-tech ${companies === 1 ? 'company that says' : 'companies that say'} what they build, sorted by obscurity.`;
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
	return `${argument} Of those ${tracked}, ${oneTrace} have left one public trace or none.`;
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
		parts.push(`<a href="#off-map">${gaps.taxonomy.total}</a> were not mapped to any sub-sector under the current taxonomy and classifier`);
	}
	if (gaps.undescribed.total > 0) {
		parts.push(`<a href="#undescribed">${gaps.undescribed.total}</a> we could not describe well enough to place`);
	}
	return `<p class="funnel-note">${found} companies have reached this pipeline and ${tracked} are on the map above.
    Of the ${gaps.total} that are not, ${parts.join(', and ')}.</p>`;
}

/**
 * How current each source is, one line, per source.
 *
 * A single "updated today" would let one healthy scraper vouch for four. DPIIT is the
 * largest source here and the reviewer found its site answering 403; if that happens
 * the page must say the DPIIT rows are as old as the last run that worked, not let the
 * other three sources' fresh dates stand in for it.
 */
function freshness(view: PageView): string {
	if (view.sourceHealth.length === 0) return '';
	const day = (iso: string | null) => (iso ? shortDate(iso.slice(0, 10)) : 'never');
	const parts = view.sourceHealth.map((h) => {
		const name = esc(SOURCE_LABELS[h.source] ?? h.source);
		// The data's own date or none. The day a run succeeded is not it: the grants list
		// was read from a file this morning and its newest award is from 2025, and falling
		// back to the run date printed "Government grants 14 Sep 2026".
		const asOf = h.data_as_of ? day(h.data_as_of) : 'date unknown';
		if (h.last_status === 'ok') return `${name} ${asOf}`;
		const what = h.last_status === 'failed' ? 'failed' : 'returned too little and was set aside';
		return `${name} <strong>${what} on ${day(h.last_attempt)}</strong>${h.last_success ? `, showing ${asOf}` : ', nothing shown from it yet'}`;
	});
	return `<p class="freshness">Data as of: ${parts.join(' &middot; ')}.</p>`;
}

/**
 * India by state, each state shaded by how many of the records in view it holds and
 * linked to the view filtered to it.
 *
 * Ink, thinned, not a colour: a stronger shade holds more (lighter, in the dark theme),
 * and the yellow stays spent on what nobody has noticed. The shade goes by the square
 * root of the count, so Karnataka's 37 does not wash every state with one or two
 * companies out to the paper.
 *
 * A picture of the tiles beside it, not a second control: hidden from screen readers and
 * out of the tab order, since each state is already a tile with its count written on it.
 * The records with no location are not on it anywhere, which is why the unknown tile
 * stays first beside the map and the header says how many there are.
 */
function indiaMap(states: { state: string; n: number }[], chosen: string | null, href: (state: string, on: boolean) => string): string {
	const counts = new Map(states.map((s) => [s.state, s.n]));
	const max = Math.max(0, ...states.map((s) => s.n));
	const shapes = Object.entries(INDIA_STATES).map(([name, d]) => {
		const n = counts.get(name) ?? 0;
		if (n === 0 || max === 0) return `<path class="state none" d="${d}"><title>${esc(name)}: none in view</title></path>`;
		const ink = Math.round(14 + 66 * Math.sqrt(n / max));
		const on = chosen === name;
		return `<a href="${esc(href(name, on))}" tabindex="-1" class="state-link${on ? ' active' : ''}"><path class="state" style="--ink-share:${ink}%" d="${d}"><title>${esc(name)}: ${n}</title></path></a>`;
	});
	// The chosen state is drawn again on top, so its outline is not hidden under a neighbour's edge.
	const outline =
		chosen && INDIA_STATES[chosen] ? `<path class="state-halo" d="${INDIA_STATES[chosen]}"/><path class="state-outline" d="${INDIA_STATES[chosen]}"/>` : '';
	return `<figure class="india-map">
      <svg viewBox="0 0 ${INDIA_MAP_WIDTH} ${INDIA_MAP_HEIGHT}" aria-hidden="true" focusable="false">${shapes.join('')}${outline}</svg>
      <figcaption>The stronger the shade, the more companies${max ? `, up to ${max}` : ''}. Boundaries: <a href="https://github.com/datameet/maps">DataMeet</a>, CC BY 4.0.</figcaption>
    </figure>`;
}

/**
 * The widget row: the records in view, five ways, each segment a filter.
 *
 * Under the masthead and above the controls, so the page reads as one instrument: every
 * count here is taken under the filters already chosen (leaving out the widget's own),
 * every segment is a link to the view it names, and the list under it is that view.
 *
 * The cell is the coverage map's cell. What a widget does not know goes in its header,
 * in the sentence a reader sees first, not under it: 373 of 607 records have no
 * location, and a row of state tiles that said so only in a footnote would draw the
 * page's knowledge as geography.
 *
 * No deltas, anywhere. The data has days of history.
 */
function widgets(view: PageView): string {
	const w = view.widgets;
	if (!w || w.total === 0) return '<section class="widgets" id="widgets" hidden></section>';
	// Each widget's share and "of N" are over its own population: the view without that
	// widget's filter. Over the filtered total, Karnataka chosen, the places header read
	// "192 of 26 have a location".
	const share = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 : 0);
	const link = (key: string, value: string, on: boolean) => `${BASE_PATH}${query(viewParams(view, { [key]: on ? null : value }))}#widgets`;
	const cell = (opts: { key: string; value: string; n: number; of: number; name: string; id?: string; title?: string; extra?: string; classes?: string[] }) => {
		const on = (view as unknown as Record<string, unknown>)[opts.key] === opts.value;
		const classes = ['cell', 'seg', opts.n > 0 ? 'filled' : 'empty', on ? 'active' : '', ...(opts.classes ?? [])].filter(Boolean).join(' ');
		return `<a class="${classes}" href="${esc(link(opts.key, opts.value, on))}" title="${esc(opts.title ?? `${opts.name}: ${opts.n}`)}"${on ? ' aria-current="true"' : ''}>
        <span class="cell-head"><span class="cell-id">${opts.id ?? ''}</span><span class="cell-n">${opts.n}</span></span>
        <span class="cell-name">${esc(opts.name)}</span>${opts.extra ?? ''}
        <span class="share" style="width:${share(opts.n, opts.of)}%" aria-hidden="true"></span>
      </a>`;
	};
	const t = w.totals;
	const head = (id: string, title: string, meta: string) =>
		`<div class="widget-head"><h2 id="${id}">${title}</h2><p class="widget-meta">${meta}</p></div>`;

	// Where they are.
	const p = w.places;
	const shownStates = 11;
	const districts = (s: { districts: { name: string; n: number }[] }) => s.districts.map((d) => `${d.name} ${d.n}`).join(', ');
	const stateCell = (s: Widgets['places']['states'][number]) =>
		cell({ key: 'state', value: s.state, n: s.n, of: t.places, name: s.state, title: `${s.state}: ${s.n}${s.districts.length ? ` — ${districts(s)}` : ''}` });
	const first = p.states.slice(0, shownStates);
	const rest = p.states.slice(shownStates);
	const restHoldsChoice = rest.some((s) => s.state === view.state);
	const under = p.located * 2 < t.places;
	const datedUnder = p.datedLocated * 2 < p.dated;
	const placesMeta = p.located
		? `<strong>${p.located} of ${t.places}</strong> publish a location; the map shows those ${p.located}, not where the other ${p.unknown} are.`
		: `None of these ${t.places} publishes a location.`;
	const chosen = view.state && view.state !== 'unknown' ? p.states.find((s) => s.state === view.state) : undefined;
	const places = `
  <div class="widget widget-places" aria-labelledby="w-places">
    ${head('w-places', 'Where they are', placesMeta)}
    <div class="places-body">
    ${indiaMap(p.states, view.state ?? null, (state, on) => link('state', state, on))}
    <div class="places-tiles">
    <div class="grid seg-grid place-grid">
      ${cell({ key: 'state', value: 'unknown', n: p.unknown, of: t.places, name: 'location unknown', id: '?', classes: ['unknown-place'] })}
      ${first.map(stateCell).join('\n      ')}
    </div>
    ${
			rest.length
				? `<details class="more-places"${restHoldsChoice ? ' open' : ''}><summary>${rest.length} more ${rest.length === 1 ? 'state' : 'states'}</summary>
      <div class="grid seg-grid place-grid">${rest.map(stateCell).join('\n      ')}</div></details>`
				: ''
		}
    ${
			chosen && chosen.districts.length
				? `<p class="districts">In ${esc(chosen.state)}, by city or district: ${chosen.districts.map((d) => `${esc(d.name)} <span class="n">${d.n}</span>`).join(' &middot; ')}</p>`
				: ''
		}
    </div>
    </div>
  </div>`;

	const plural = (k: number, one: string, many: string) => (k === 1 ? one : many);

	// 0. The quality signal no commercial database models: public programmes that selected a company,
	// and how many of those have no other public trace. Counted, never ranked.
	const pg = w.programmes;
	const progWidget = `
  <div class="widget widget-lead" aria-labelledby="w-programmes">
    ${head(
			'w-programmes',
			'Selected by public programmes',
			pg.twoPlus
				? `<strong>${pg.twoPlus}</strong> ${plural(pg.twoPlus, 'company here has', 'companies here have')} been selected into two or more public support programmes &mdash; incubation, DPIIT recognition, BIRAC, DST, MeitY, TDB or iDEX. <a href="${esc(`${BASE_PATH}${query(viewParams(view, { programmes: '2', alone: '1' }))}#list`)}"><strong>${pg.twoPlusAlone}</strong> of them</a> have no other public trace: no website of their own and no press.`
				: 'No company in this view has been selected into two or more public programmes.',
		)}
    <div class="grid seg-grid">
      ${cell({ key: 'programmes', value: '2', n: pg.twoPlus, of: pg.total, name: 'two or more' })}
      ${cell({ key: 'programmes', value: '3', n: pg.three, of: pg.total, name: 'three or more' })}
      ${(() => {
				// Two filters at once: in two or more programmes, and nothing else public.
				const on = view.alone === '1' && view.programmes === '2';
				const href = `${BASE_PATH}${query(viewParams(view, on ? { programmes: null, alone: null } : { programmes: '2', alone: '1' }))}#widgets`;
				return `<a class="cell seg ${pg.twoPlusAlone > 0 ? 'filled' : 'empty'}${on ? ' active' : ''}" href="${esc(href)}"${on ? ' aria-current="true"' : ''} title="Two or more public programmes, and no website or press: ${pg.twoPlusAlone}">
        <span class="cell-head"><span class="cell-id"></span><span class="cell-n">${pg.twoPlusAlone}</span></span>
        <span class="cell-name">nothing else public</span>
        <span class="share" style="width:${share(pg.twoPlusAlone, pg.total)}%" aria-hidden="true"></span>
      </a>`;
			})()}
    </div>
  </div>`;

	// 1. Can I form a view on these? The same count as "what they build", in the reader's terms.
	const d = w.described;
	const said = d.own + d.source;
	const view1 = `
  <div class="widget" aria-labelledby="w-view">
    ${head(
			'w-view',
			'Enough to form a view',
			said
				? `<strong>${said}</strong> ${plural(said, 'company here has', 'companies here have')} published enough for you to form a view${
						d.own ? `, <strong>${d.own}</strong> of them in their own words on their own site` : ''
					}.${d.label + d.none ? ` ${d.label + d.none} more have only a list&rsquo;s label or nothing.` : ''}`
				: 'Nothing in this view says what it builds.',
		)}
    <div class="grid seg-grid">
      ${DESCRIBED_STATES.filter((k) => k !== 'none' || d.none > 0 || view.described === 'none')
				.map((k) => cell({ key: 'described', value: k, n: d[k], of: t.described, name: DESCRIBED_LABELS[k].toLowerCase(), classes: k === 'label' || k === 'none' ? ['weak-seg'] : [] }))
				.join('\n      ')}
    </div>
  </div>`;

	// 2. Has anyone noticed them? The thesis as a claim, checked by clicking.
	const low = w.traces['1'];
	const two = low + w.traces['2'];
	const pctTwo = t.traces ? Math.round((two / t.traces) * 100) : 0;
	const traces = `
  <div class="widget" aria-labelledby="w-traces">
    ${head(
			'w-traces',
			'How little they have been noticed',
			t.traces
				? `<strong>${pctTwo}%</strong> have left two public traces or fewer; <strong>${low}</strong> ${plural(low, 'has', 'have')} left one or none. The list puts the fewest first.`
				: 'No company in this view to count.',
		)}
    <div class="grid seg-grid">
      ${TRACE_BUCKETS.map((b) => cell({ key: 'traces', value: b, n: w.traces[b], of: t.traces, name: TRACE_LABELS[b].toLowerCase(), id: b === '3+' ? '3+' : b === '1' ? '≤1' : '2' })).join('\n      ')}
    </div>
  </div>`;

	// 3. What do they build, and for what? A thesis filter within the map's choice.
	const topDomain = DOMAIN_TAGS.map((tag) => [tag, w.domain[tag] ?? 0] as const).sort((a, b) => b[1] - a[1])[0];
	const tags = `
  <div class="widget" aria-labelledby="w-tags">
    ${head(
			'w-tags',
			'What they build, by keyword',
			t.tags
				? `<strong>${w.build.hardware ?? 0}</strong> build hardware, <strong>${w.build.software ?? 0}</strong> software, <strong>${w.build['biological or chemical'] ?? 0}</strong> work in biology or chemistry${
						topDomain && topDomain[1] ? `; ${esc(topDomain[0])} is the most common use, with ${topDomain[1]}` : ''
					}.${w.untagged ? ` ${w.untagged} matched no keyword.` : ''}`
				: 'No company in this view to tag.',
		)}
    <div class="grid seg-grid">
      ${BUILD_TAGS.map((tag) => cell({ key: 'build', value: tag, n: w.build[tag] ?? 0, of: t.tags, name: tag })).join('\n      ')}
    </div>
    <div class="grid seg-grid tag-grid">
      ${DOMAIN_TAGS.filter((tag) => (w.domain[tag] ?? 0) > 0 || view.domain === tag)
				.map((tag) => cell({ key: 'domain', value: tag, n: w.domain[tag] ?? 0, of: t.tags, name: tag }))
				.join('\n      ')}
    </div>
  </div>`;

	// 4. Where does this come from, and is it current? Question 1, without a paragraph.
	const health = new Map(view.sourceHealth.map((h) => [h.source, h]));
	const failing = view.sourceHealth.filter((h) => h.last_status !== 'ok').length;
	const latest = view.sourceHealth.map((h) => h.last_success ?? '').sort().pop();
	const sources = `
  <div class="widget" aria-labelledby="w-sources">
    ${head(
			'w-sources',
			'Where the records come from',
			`Read from <strong>${w.sources.filter((src) => src.n > 0).length}</strong> portfolios and lists${
				latest ? `, last checked ${shortDate(latest.slice(0, 10))}` : ''
			}${failing ? `; ${failing} did not answer on the last run, and their rows stand from the run before` : ''}. A company two sources list counts under both.`,
		)}
    <div class="grid seg-grid source-grid">
      ${w.sources
				.map((src) => {
					const h = health.get(src.source);
					const checked = h?.last_success ? `checked ${shortDate(h.last_success.slice(0, 10))}` : 'no successful check yet';
					const bad = h && h.last_status !== 'ok' ? ` <strong class="failing">no answer ${shortDate(h.last_attempt.slice(0, 10))}</strong>` : '';
					const name = SOURCE_LABELS[src.source] ?? src.source;
					return cell({ key: 'source', value: src.source, n: src.n, of: t.sources, name, title: `${name}: ${src.n} records, ${checked}`, extra: `<span class="cell-when">${esc(checked)}${bad}</span>` });
				})
				.join('\n      ')}
    </div>
  </div>`;

	return `
<section class="widgets" id="widgets" aria-label="The companies in view, stated and filterable">
  ${progWidget}
  <div class="widget-row">
  ${view1}
  ${traces}
  ${tags}
  ${sources}
  </div>
  ${places}
</section>`;
}

/**
 * The question box. Drawn only once someone has turned it on (ASK_ENABLED), so a page
 * without it has no dead control; the endpoint is a 404 in the same state.
 */
function askBox(view: PageView): string {
	if (!view.ask) return '';
	return `
<section class="ask" id="ask" aria-labelledby="ask-h">
  <form class="ask-form" id="ask-form" action="${esc(`${BASE_PATH}/api/ask`)}" method="post">
    <label id="ask-h" for="ask-q">Ask the records</label>
    <div class="ask-bar">
      <input type="text" id="ask-q" name="question" maxlength="300" required autocomplete="off"
        placeholder="e.g. Which Energy Storage companies have one public trace?">
      <button type="submit">Ask</button>
    </div>
    <p class="ask-note">Answered from this list&rsquo;s records through a filtered query, never from a model&rsquo;s own
      knowledge, and every answer shows what it rests on. Questions are logged; no address is stored.</p>
    <div class="ask-out" id="ask-out" aria-live="polite"></div>
  </form>
</section>`;
}

/**
 * Placements of register companies by their DPIIT industry, from one classifier run.
 * Dated, and kept here once, because the run is not repeated nightly: the label rule
 * written the same day stopped label-only guesses, so these counts can only be read
 * off that run's log, not recounted from today's rows.
 */
const CROSSWALK = { run: '14 September 2026', robotics: [79, 80], ai: [7, 83], vision: [3, 87] } as const;

/**
 * Recognition across every register record read, which the database does not keep for
 * the records that never reached a row. Counted from the cached register pages.
 */
const REGISTER_READ = { through: '14 September', profile: 345, read: 966 } as const;

/** Where a finding sends a reader: every tier and age, so the rows behind the number are on screen. */
function everyRow(params: Record<string, string | null>): string {
	return `${BASE_PATH}${query({ tier: 'all', age: 'all', ...params })}#list`;
}

const PREFERRED_EMPTY = ['1.7', '1.15', '2.4'];

function pct(n: number, of: number): number {
	return of ? Math.round((n / of) * 100) : 0;
}

/** A gap group's name as a reader would write it: "enterprise ai" is "enterprise AI". */
function holeName(missing: string): string {
	return missing.replace(/\bai\b/g, 'AI').replace(/\biot\b/g, 'IoT').replace(/\bev\b/g, 'EV');
}

/**
 * What the records show about Indian deep-tech sourcing, with the number and the link
 * that proves each one. Written as findings about the sources, not caveats about this
 * page: that the register describes almost no one is true of the register, and it is
 * the reason a list like this one has to be built at all.
 *
 * Every number but the crosswalk is counted live from the same tables as the sections it
 * links to. A finding whose count has fallen to nothing is left out rather than printed
 * as "0 of 0".
 */
function findingsSection(view: PageView): string {
	const f = view.findings;
	if (!f) return '';
	const items: string[] = [];

	// The finding this project exists for: a quality signal read from public records alone.
	if (f.programmes.twoPlus > 0) {
		const programmeLink = `${BASE_PATH}${query({ programmes: '2', age: 'all' })}#list`;
		const aloneLink = `${BASE_PATH}${query({ programmes: '2', alone: '1', age: 'all' })}#list`;
		items.push(`<li class="finding-lead"><strong><a href="${esc(programmeLink)}">${f.programmes.twoPlus} companies</a> here have been selected into two or more public support programmes. <a href="${esc(aloneLink)}">${f.programmes.alone} of them</a> have no other public trace: no website of their own, and no press.</strong>
      The programmes are incubation, DPIIT recognition, BIRAC, DST, MeitY, TDB and iDEX; ${f.programmes.three} companies are in three or more. They are counted, not ranked, and they are not all independent: an incubator often runs a scheme&rsquo;s selection. Counting only organisations that each published their own decision, ${f.programmes.orgs} companies have two or more.</li>`);
	}

	// What the scatter would have shown, said instead: its trace axis had one value for most rows.
	if (f.noticed.companies > 0 && f.noticed.once > 0) {
		const share = pct(f.noticed.once, f.noticed.companies);
		items.push(`<li><strong>Most companies here have been noticed by exactly one outside source.</strong>
      <a href="${esc(`${BASE_PATH}${query({ noticed: '1', age: 'all' })}#list`)}">${f.noticed.once} of the ${f.noticed.companies} (${share}%)</a> that say what they
      build appear in one list other than their own website &mdash; usually the listing that brought them here.</li>`);
	}

	const silent = f.register.total - f.register.described;
	if (f.register.total > 0) {
		items.push(`<li><strong>The register that sees Indian startups first describes almost none of them.</strong> Of the
      ${f.register.total} newest deep-tech entries we read from DPIIT&rsquo;s Startup India register,
      <a href="#register">${silent} (${pct(silent, f.register.total)}%)</a> have no sentence anywhere public about what the
      company builds &mdash; a name, a city and a dropdown industry is the whole record.</li>`);
	}

	const [rn, rd] = CROSSWALK.robotics;
	items.push(`<li><strong>India&rsquo;s two official deep-tech vocabularies barely meet.</strong> Of the startups DPIIT files
      under &ldquo;Robotics&rdquo;, <a href="#crosswalk">${rn} of ${rd} (${pct(rn, rd)}%)</a> found a matching RDI sub-sector
      &mdash; but only ${CROSSWALK.ai[0]} of ${CROSSWALK.ai[1]} under &ldquo;AI&rdquo; (${pct(CROSSWALK.ai[0], CROSSWALK.ai[1])}%) and
      ${CROSSWALK.vision[0]} of ${CROSSWALK.vision[1]} under &ldquo;Computer Vision&rdquo; (${pct(CROSSWALK.vision[0], CROSSWALK.vision[1])}%), as one classifier maps the labels.</li>`);

	const emptyCells = view.coverage.sectors.flatMap((g) => g.subsectors).filter((c) => c.n === 0);
	const named = [
		...PREFERRED_EMPTY.map((id) => emptyCells.find((c) => c.subsector_id === id)).filter((c): c is (typeof emptyCells)[number] => Boolean(c)),
		...emptyCells.filter((c) => !PREFERRED_EMPTY.includes(c.subsector_id)),
	].slice(0, 3);
	if (f.described.unmapped > 0) {
		const holes = f.described.holes.map((h) => `&ldquo;${esc(holeName(h.missing))}&rdquo;`);
		const lead = holes.length > 1 ? `${holes.slice(0, -1).join(', ')} and ${holes[holes.length - 1]} lead` : holes.length ? `${holes[0]} leads` : '';
		const cells = named.map((c) => esc(c.subsector.toLowerCase()).replace(/ r&amp;d$/, ' R&amp;D'));
		items.push(`<li><strong>Where startups do describe themselves, the RDI scheme often has no place for them.</strong>
      <a href="#off-map">${f.described.unmapped} of ${f.described.total} described records (${pct(f.described.unmapped, f.described.total)}%)</a>
      fit none of its ${view.coverage.subsector_count} sub-sectors${lead ? ` &mdash; ${lead} &mdash;` : ''}${
				emptyCells.length
					? ` while <a href="#coverage">${emptyCells.length} sub-sectors</a>${cells.length ? `, including ${cells.length > 1 ? `${cells.slice(0, -1).join(', ')} and ${cells[cells.length - 1]}` : cells[0]},` : ''} have no company at all`
					: ''
			}.</li>`);
	}

	if (f.recognition.withStatus > 0) {
		items.push(`<li><strong>Being on the register is not being recognised.</strong>
      <a href="${esc(everyRow({ dpiit: 'profile', described: 'all', kind: 'all' }))}">${f.recognition.profile} of the ${f.recognition.withStatus} register entries on this list (${pct(f.recognition.profile, f.recognition.withStatus)}%)</a>
      have a Startup India profile but no DPIIT recognition number &mdash; and ${REGISTER_READ.profile} of the ${REGISTER_READ.read}
      entries read by ${REGISTER_READ.through} (${pct(REGISTER_READ.profile, REGISTER_READ.read)}%).</li>`);
	}

	return `
<section class="findings" aria-labelledby="findings-h">
  <h2 id="findings-h">What the records show</h2>
  <ol class="finding-list">
    ${items.join('\n    ')}
  </ol>
</section>`;
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
	// The discovery sources, not every health record: award lists attach evidence and add no company.
	const count = SOURCES.length;
	const n = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'][count] ?? String(count);
	// Two sentences: what this is, and the one way it differs. Every number that used to sit
	// here is now a widget that states it and filters by it.
	return `
<header class="masthead">
  <p class="eyebrow">Upstream</p>
  <h1>Indian deep-tech companies, least-noticed first.</h1>
  <p class="hook">Read from ${n} incubator portfolios, grant lists and the DPIIT register. Every other list ranks by how
    impressive a company looks; this one ranks by how little anyone has written about it.</p>
  ${scopeLine(view)}
  <p class="since" id="since" hidden></p>
</header>
${topPicks(view)}`;
}

/**
 * What the list is out of, said under the masthead where a first-time reader looks, so the
 * default view cannot pass for everything: the described companies of every record held.
 */
function scopeLine(view: PageView): string {
	if (view.tracked === 0 || view.demo) return '';
	const latest = view.sourceHealth.map((h) => h.last_success ?? '').sort().pop();
	const b = view.buckets;
	const shown = view.dates === 'undated' ? b.undated : view.dates === 'dated' ? b.ranked : b.ranked + b.undated;
	// The same number the list shows, and what it is out of: the scope, not a second count to reconcile.
	const narrowed = activeFilters(view).length > 0;
	const what = narrowed
		? 'companies in this view'
		: `companies that say what they build${view.age === 'recent' && b.older ? ` and started in the last ${MAX_AGE_YEARS} years` : ''}`;
	return `<p class="scope" id="scope">Showing <strong>${shown}</strong> ${what}, least noticed first, out of ${view.tracked} records${
		latest ? ` &middot; sources checked ${shortDate(latest.slice(0, 10))}` : ''
	} &middot; <a href="#result-line">what the list leaves out</a></p>`;
}

/**
 * Three companies before anything else, so the claim arrives with proof: the top of the list
 * as it stands, under whatever filters are set, each a jump to its row.
 */
function topPicks(view: PageView): string {
	const rows = [...view.companies, ...view.undated].slice(0, 3);
	if (!rows.length) return '<section class="top-picks" id="top-picks" hidden></section>';
	const filtered = activeFilters(view).length > 0;
	const shown = view.dates === 'undated' ? view.buckets.undated : view.dates === 'dated' ? view.buckets.ranked : view.buckets.ranked + view.buckets.undated;
	const pick = (c: Company) => {
		const said = c.product && c.website_identity === 'verified' ? c.product : describedBySource(c) ? c.description : null;
		const n = c.trace_count;
		const trail = traceTrail(c).replace(/<[^>]+>/g, '');
		return `<li><a href="${esc(`${BASE_PATH}/c/${c.id}`)}">${esc(c.name)}</a>${said ? `<span class="pick-builds">${esc(said)}</span>` : ''}<span class="pick-traces">${trail || (n === 0 ? 'no public trace' : `${n} public ${n === 1 ? 'trace' : 'traces'}`)}</span></li>`;
	};
	return `
<section class="top-picks" id="top-picks" aria-labelledby="top-picks-h">
  <h2 id="top-picks-h">${filtered ? 'Least noticed in this view' : 'Least noticed right now'}</h2>
  <ol>${rows.map(pick).join('')}</ol>
  <a class="see-all" href="#controls">See all ${shown} &darr;</a>
</section>`;
}

function coverageMap(view: PageView): string {
	const { coverage, subsector, sector } = view;
	// Cells count the companies in the current view (every other filter applied); a dashed
	// cell is one no record anywhere falls in, which is the finding the sentence states.
	const inView = view.widgets?.subsectors ?? null;
	const allCells = coverage.sectors.flatMap((g) => g.subsectors);
	const empty = allCells.filter((c) => c.n === 0);
	const named = empty.slice(0, 3).map((c) => esc(c.subsector));
	const claim = empty.length
		? `<strong>${empty.length} of the ${coverage.subsector_count}</strong> sunrise sub-sectors have no company in them yet${
				named.length ? `: ${named.join(', ')}${empty.length > named.length ? ` and ${empty.length - named.length} more` : ''}` : ''
			}.`
		: `Every one of the ${coverage.subsector_count} sunrise sub-sectors has at least one company.`;

	const sectors = coverage.sectors
		.map((group) => {
			const cells = group.subsectors
				.map((cell) => {
					const active = subsector === cell.subsector_id;
					const n = inView ? (inView[cell.subsector_id] ?? 0) : cell.n;
					// Clicking the active cell clears the filter, so the map is a toggle.
					const href = `${query(viewParams(view, { subsector: active ? null : cell.subsector_id, sector: null }))}#list`;
					const classes = ['cell', cell.n === 0 ? 'empty' : n > 0 ? 'filled' : 'zero', active ? 'active' : ''].filter(Boolean).join(' ');
					return `<a class="${classes}" href="${esc(href)}" title="${esc(cell.subsector_id)} &mdash; ${esc(cell.subsector)}: ${n}${cell.n === 0 ? ', none in any record' : ''}"${
						active ? ' aria-current="true"' : ''
					}>
        <span class="cell-head"><span class="cell-id">${esc(cell.subsector_id)}</span><span class="cell-n">${n}</span></span>
        <span class="cell-name">${esc(cell.subsector)}</span>
      </a>`;
				})
				.join('\n');
			const on = sector === group.sector_id && !subsector;
			const href = `${query(viewParams(view, { sector: on ? null : group.sector_id, subsector: null }))}#list`;
			const inSector = group.subsectors.reduce((k, c) => k + (inView ? (inView[c.subsector_id] ?? 0) : c.n), 0);
			// A details element, open, so a phone can fold the 44 cells to five lines (the script
			// folds them there) while a desktop and a script-less browser see the whole map.
			return `<details class="sector" open${group.subsectors.some((c) => c.subsector_id === subsector) || on ? ' data-chosen' : ''}>
      <summary><h3><a class="sector-link${on ? ' active' : ''}" href="${esc(href)}"${on ? ' aria-current="true"' : ''}>${sectorIcon(group.sector_id)}<span class="sector-id">${esc(group.sector_id)}</span> ${esc(group.sector)}</a> <span class="sector-n">${inSector}</span></h3></summary>
      <div class="grid">
${cells}
      </div>
    </details>`;
		})
		.join('\n');

	return `
<section class="coverage" id="coverage" aria-labelledby="coverage-h">
  <div class="widget-head">
    <h2 id="coverage-h">Where in the RDI scheme</h2>
    <p class="widget-meta">${claim} Pick a cell to narrow the list to it, or a sector&rsquo;s name for all of it. A dashed cell has nothing in any record.</p>
  </div>
  <div class="sectors">
${sectors}
  </div>
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
		state: view.state,
		traces: view.traces,
		// Written only when they leave the default, so the default view has one spelling.
		described: view.described === 'said' ? null : (view.described ?? 'all'),
		kind: view.kind === 'company' ? null : (view.kind ?? 'all'),
		dpiit: view.dpiit,
		build: view.build,
		domain: view.domain,
		noticed: view.noticed ?? null,
		programmes: view.programmes ?? null,
		alone: view.alone ?? null,
		sort: view.sort === 'quietest' || view.sort === 'obscurity' ? null : view.sort,
		dates: view.dates === 'both' ? null : view.dates,
		tier: view.tier === view.defaultTier ? null : view.tier,
		age: view.age === 'recent' ? null : view.age,
		...overrides,
	};
}

/** The labels for the sources, since the ids are not written for reading. */
const SOURCE_LABELS: Record<string, string> = {
	'sine-iitb': 'SINE IIT Bombay',
	// The page this source reads is on rtbi.in but is the IIT Madras Incubation Cell's
	// portfolio (its own title says so); the id stays, the name is corrected.
	'rtbi-iitm': 'IIT Madras Incubation Cell',
	'grants-csv': 'Government grants',
	'dpiit-startup-india': 'DPIIT register',
	'venture-center': 'Venture Center',
	'nmicps-tih': 'NM-ICPS innovation hubs',
	'fsid-iisc': 'FSID, IISc',
	'tides-iitr': 'TIDES, IIT Roorkee',
	'nsa-dpiit': 'National Startup Awards',
	'birac-big': 'BIRAC BIG',
	'tdb-agreements': 'Technology Development Board',
	'idex': 'iDEX',
};

const SORT_LABELS: Record<SortChoice, string> = {
	quietest: 'Least traced',
	described: 'Most described',
	programmes: 'Most public programmes',
	newest: 'Newest on record',
	name: 'Name',
	obscurity: 'Least traced',
};

const TIER_LABELS: Record<TierChoice, string> = { a: 'A only', ab: 'A + B', all: 'Everything' };
const DATES_LABELS: Record<PageView['dates'], string> = { both: 'Dated and undated', dated: 'Dated only', undated: 'Undated only' };
const SITE_LABELS: Record<SiteState, string> = { has: 'Has a website', none: 'No website' };
const AGE_LABELS: Record<AgeChoice, string> = { recent: `Last ${MAX_AGE_YEARS} years`, all: 'Every year' };
const TRACE_LABELS: Record<TraceBucket, string> = { '1': 'One or none', '2': 'Two', '3+': 'Three or more' };
const DESCRIBED_LABELS: Record<DescribedChoice, string> = {
	said: 'Says what it builds',
	unsaid: 'Says nothing about what it builds',
	own: 'Their own homepage says',
	source: 'A source describes it',
	label: 'A list’s label only',
	none: 'Nothing at all',
};
const KIND_LABELS: Record<KindChoice, string> = { company: 'Companies', other: 'Research projects and unverified names' };

/**
 * Every filter that is not at its default, as the chip that names it and the link that
 * removes it and nothing else.
 *
 * "Clear 3 filters" makes a reader work out which three. A chip per filter says it, and
 * its own x means taking one away never takes the others with it.
 */
function activeFilters(view: PageView): Array<{ key: string; label: string; href: string }> {
	const sector = view.sector ? SECTOR_GROUPS.find((g) => g.sector_id === view.sector) : undefined;
	const sub = view.subsector ? SUBSECTOR_BY_ID.get(view.subsector) : undefined;
	const named: Array<[string, string | null]> = [
		['q', view.search ? `Search: “${view.search}”` : null],
		['sector', view.sector ? `Sector: ${view.sector} ${sector?.sector ?? ''}`.trim() : null],
		['subsector', view.subsector ? `Sub-sector: ${view.subsector} ${sub?.subsector ?? ''}`.trim() : null],
		['tier', view.tier !== view.defaultTier ? `Tier: ${TIER_LABELS[view.tier]}` : null],
		['source', view.source ? `Found by: ${SOURCE_LABELS[view.source] ?? view.source}` : null],
		['dates', view.dates !== 'both' ? `Dates: ${DATES_LABELS[view.dates].toLowerCase()}` : null],
		['site', view.site ? `Website: ${SITE_LABELS[view.site].toLowerCase()}` : null],
		['state', view.state ? `Location: ${view.state === 'unknown' ? 'unknown' : view.state}` : null],
		['traces', view.traces ? `Public traces: ${TRACE_LABELS[view.traces].toLowerCase()}` : null],
		[
			'described',
			view.described === 'said' ? null : `What it builds: ${view.described ? DESCRIBED_LABELS[view.described].toLowerCase() : 'described or not'}`,
		],
		['kind', view.kind === 'company' ? null : `Showing: ${view.kind ? KIND_LABELS[view.kind].toLowerCase() : 'companies, projects and unverified names'}`],
		['dpiit', view.dpiit ? `DPIIT: ${DPIIT_STATUS_PHRASES[view.dpiit] ?? view.dpiit}` : null],
		['programmes', view.programmes ? `Public programmes: ${view.programmes} or more` : null],
		['alone', view.alone ? 'No website or press' : null],
		['noticed', view.noticed ? 'Noticed by: one outside source' : null],
		['build', view.build ? `Builds: ${view.build}` : null],
		['domain', view.domain ? `Used in: ${view.domain}` : null],
		['age', view.age !== 'recent' ? `Started: ${AGE_LABELS[view.age].toLowerCase()}` : null],
	];
	return named
		.filter((entry): entry is [string, string] => entry[1] !== null)
		.map(([key, label]) => ({ key, label, href: `${BASE_PATH}${query(viewParams(view, { [key]: null }))}#list` }));
}

function chips(view: PageView): string {
	const active = activeFilters(view);
	const items = active
		.map(
			(f) =>
				`<li><a class="chip filter-chip" href="${esc(f.href)}" aria-label="Remove ${esc(f.label)}">${esc(f.label)} <span aria-hidden="true">&times;</span></a></li>`,
		)
		.join('');
	// Clearing everything is still offered, but only beside the chips that say what it clears.
	const all = active.length > 1 ? `<li><a class="clear" href="${esc(`${BASE_PATH}#list`)}">Remove all ${active.length}</a></li>` : '';
	return `<ul class="chips active-chips" id="chips">${items}${all}</ul>`;
}

/**
 * The result line: what is on screen, out of everything held, and where every other
 * record went, each part a link to the view that shows it.
 *
 * Built from the same buckets as the list, so the parts always add up to the whole:
 * shown + hidden by filters + held back by tier or age + undated = every record.
 * Energy Storage's cell once said 14 over an empty list; nothing is allowed to vanish
 * between the number and the rows again.
 */
function resultLine(view: PageView): string {
	const b = view.buckets;
	// The demo rows are not the database, so they account for themselves.
	// Out of the half being shown — by default the companies a sentence describes — not
	// out of every row: the rest are counted in the masthead and linked at the end here,
	// not "hidden by filters" the reader never chose.
	const universe = view.demo ? b.total : Math.max(view.category, b.total);
	const outside = view.demo ? 0 : view.tracked - universe;
	// The undated rows continue the same list, so they count in what it shows.
	const shown = view.dates === 'undated' ? b.undated : view.dates === 'dated' ? b.ranked : b.ranked + b.undated;
	const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
	const parts: string[] = [];

	const byFilters = universe - b.total;
	if (byFilters > 0) {
		const keep = viewParams(view);
		const cleared = `${BASE_PATH}${query({ sort: keep.sort, tier: keep.tier, age: keep.age, described: keep.described, kind: keep.kind, dpiit: keep.dpiit })}#list`;
		parts.push(
			`<a href="${esc(cleared)}" title="Records the search, sector, sub-sector, source, website or location filters leave out. Follow to remove those filters.">${byFilters} hidden by filters</a>`,
		);
	}

	const held = view.dates === 'undated' ? 0 : b.older + b.tierHidden;
	if (held > 0) {
		const why: string[] = [];
		if (b.older > 0) why.push(`${b.older} started more than ${MAX_AGE_YEARS} years ago and ${plural(b.older, 'is', 'are')} held back by the age filter`);
		if (b.tierHidden > 0) {
			const outside = view.tier === 'a' ? 'Tier B or C' : 'Tier C';
			const showing = view.tier === 'a' ? 'Tier A' : 'Tier A and B';
			why.push(`${b.tierHidden} ${plural(b.tierHidden, 'is', 'are')} ${outside}, and the list is showing ${showing}`);
		}
		const everything = `${BASE_PATH}${query(viewParams(view, { tier: 'all', age: 'all', dates: null }))}#list`;
		// Named for what actually holds them back: since the list opens on every tier, usually only the age filter.
		const label = b.tierHidden === 0 ? `${b.older} started over ${MAX_AGE_YEARS} years ago` : b.older === 0 ? `${b.tierHidden} outside the tier shown` : `${held} held back by age or tier`;
		parts.push(`<a href="${esc(everything)}" title="${esc(why.join('; '))}. Follow to show them.">${label}</a>`);
	}

	if (view.dates === 'dated' && b.undated > 0) {
		parts.push(`<a href="${esc(`${BASE_PATH}${query(viewParams(view, { dates: null }))}#undated`)}" title="Records no source dates. Follow to list them below the map.">${b.undated} undated, hidden</a>`);
	} else if (view.dates !== 'undated' && b.undated > 0) {
		parts.push(`<a href="#undated" title="Records no source dates, so no tier can be claimed for them. Listed after the dated ones.">${b.undated} of them undated</a>`);
	}

	if (outside > 0) {
		const everything = `${BASE_PATH}${query(viewParams(view, { described: 'all', kind: 'all', dpiit: null }))}#list`;
		parts.push(
			`<a href="${esc(everything)}" title="Records outside this view: by default, those nothing describes and the research projects and unverified names. Follow to include them.">${outside} outside this view</a>`,
		);
	}

	const what = view.dates === 'undated' ? 'undated' : 'in the list';
	return `<p class="result-line" id="result-line"><strong>${shown}</strong> ${what} of ${universe}${parts.length ? ` &middot; ${parts.join(' &middot; ')}` : ''}<span class="marks-line" hidden></span></p>`;
}

function controls(view: PageView): string {
	const { sector, subsector, search, source, site, sort, dates, tier, age } = view;
	const option = (value: string, label: string, current: string) =>
		`<option value="${esc(value)}"${current === value ? ' selected' : ''}>${esc(label)}</option>`;

	const sectorOptions = [option('', 'All sectors', sector ?? '')]
		.concat(SECTOR_GROUPS.map((g) => option(g.sector_id, `${g.sector_id} — ${g.sector}`, sector ?? '')))
		.join('');
	// Grouped by sector, and the sector in the data attribute so the script can drop a
	// sub-sector that the newly chosen sector does not contain.
	const subsectorOptions = [option('', 'All sub-sectors', subsector ?? '')]
		.concat(
			SECTOR_GROUPS.map(
				(g) =>
					`<optgroup label="${esc(`${g.sector_id} ${g.sector}`)}">${g.subsectors
						.map((sub) => `<option value="${esc(sub.subsector_id)}" data-sector="${esc(g.sector_id)}"${subsector === sub.subsector_id ? ' selected' : ''}>${esc(`${sub.subsector_id} ${sub.subsector}`)}</option>`)
						.join('')}</optgroup>`,
			),
		)
		.join('');
	const tierOptions = (Object.keys(TIER_LABELS) as TierChoice[]).map((v) => option(v, TIER_LABELS[v], tier)).join('');
	const sourceOptions = [option('', 'Any source', source ?? '')].concat(SOURCES.map((id) => option(id, SOURCE_LABELS[id] ?? id, source ?? ''))).join('');
	const datesOptions = (Object.keys(DATES_LABELS) as Array<PageView['dates']>).map((v) => option(v, DATES_LABELS[v], dates)).join('');
	// "No website" is its own option: on this list the absence is the signal.
	const siteOptions = [option('', 'Website or not', site ?? ''), option('has', SITE_LABELS.has, site ?? ''), option('none', SITE_LABELS.none, site ?? '')].join('');
	const ageOptions = (Object.keys(AGE_LABELS) as AgeChoice[]).map((v) => option(v, AGE_LABELS[v], age)).join('');
	// In the reader's words, and no tier letters: the order a reader chooses, not our rule's name.
	const sortOptions = (['quietest', 'programmes', 'described', 'newest', 'name'] as SortChoice[]).map((v) => option(v, SORT_LABELS[v], sort)).join('');
	const traceOptions = [option('', 'Any number', view.traces ?? '')].concat(TRACE_BUCKETS.map((v) => option(v, TRACE_LABELS[v], view.traces ?? ''))).join('');
	const describedNow = view.described === 'said' ? '' : (view.described ?? 'all');
	const describedOptions = [option('', DESCRIBED_LABELS.said, describedNow)]
		.concat(DESCRIBED_STATES.map((v) => option(v, DESCRIBED_LABELS[v], describedNow)))
		.concat([option('unsaid', DESCRIBED_LABELS.unsaid, describedNow), option('all', 'Described or not', describedNow)])
		.join('');
	// Keyword tags, and said to be keywords in the label: a filter a reader cannot tell was
	// read off the words would pass for someone's judgement.
	const buildOptions = [option('', 'Anything', view.build ?? '')].concat(BUILD_TAGS.map((t) => option(t, t[0].toUpperCase() + t.slice(1), view.build ?? ''))).join('');
	const domainOptions = [option('', 'Anywhere', view.domain ?? '')].concat(DOMAIN_TAGS.map((t) => option(t, t[0].toUpperCase() + t.slice(1), view.domain ?? ''))).join('');
	const count = activeFilters(view).filter((f) => f.key !== 'q').length;

	const field = (id: string, label: string, options: string) =>
		`<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${id}">${options}</select></div>`;

	return `
<form class="controls" id="controls" method="get" action="${esc(BASE_PATH)}#list" role="search">
  <div class="bar">
    <div class="field field-search">
      <label for="q" class="visually-hidden">Search</label>
      <input type="search" id="q" name="q" value="${esc(search ?? '')}" placeholder="Search names and what they build"
        autocomplete="off" spellcheck="false">
    </div>
    <details class="filter-menu">
      <summary>Filters<span class="filter-count" id="filter-count">${count ? `&nbsp;&middot;&nbsp;${count}` : ''}</span></summary>
      <div class="filter-panel">
        <input type="hidden" id="sector" name="sector" value="${esc(sector ?? '')}">
        <input type="hidden" id="subsector" name="subsector" value="${esc(subsector ?? '')}">
        ${field('tier', 'Tier', tierOptions)}
        ${field('source', 'Found by', sourceOptions)}
        ${field('dates', 'Dates', datesOptions)}
        ${field('site', 'Website', siteOptions)}
        ${field('age', 'Started', ageOptions)}
        ${field('traces', 'Public traces', traceOptions)}
        ${field('described', 'What it builds', describedOptions)}
        ${field('build', 'Builds (by keyword)', buildOptions)}
        ${field('domain', 'Used in (by keyword)', domainOptions)}
        <input type="hidden" id="state" name="state" value="${esc(view.state ?? '')}">
        <input type="hidden" name="kind" value="${esc(viewParams(view).kind ?? '')}">
        <input type="hidden" name="dpiit" value="${esc(view.dpiit ?? '')}">
        <input type="hidden" name="noticed" value="${esc(view.noticed ?? '')}">
        <input type="hidden" name="programmes" value="${esc(view.programmes ?? '')}">
        <input type="hidden" name="alone" value="${esc(view.alone ?? '')}">
        <button type="submit" class="apply">Apply</button>
      </div>
    </details>
    <div class="field field-sort"><label for="sort" class="visually-hidden">Sort by</label><select id="sort" name="sort">${sortOptions}</select></div>
  </div>
  ${chips(view)}
  <div class="bar-foot">
    ${resultLine(view)}
    <span class="bar-links">
      <button type="button" class="linkish seen-toggle" hidden aria-pressed="false">Hide seen</button>
      <button type="button" class="linkish shortlist-toggle" hidden aria-pressed="false">Shortlisted only</button>
      <a class="linkish shortlist-export" hidden href="#">CSV of your shortlist</a>
      <a class="export" id="export" href="${esc(`${BASE_PATH}/export.csv${query(viewParams(view))}`)}">CSV of this view</a>
    </span>
  </div>
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
	const shape = traceShape(company);
	// Emphasised only where it is the finding. At five traces it is just a number.
	// The count is the sort key and keeps the mono; what the traces are is read, not scanned,
	// so it sits under the count in the body face and wraps inside the side column.
	return `<span class="traces${n <= 1 ? ' quiet' : ''}"><span class="trace-n">${said}</span>${shape ? `<span class="trace-shape">${esc(shape)}</span>` : ''}</span>`;
}

/** Each kind of trace in words, one and many, in the order a reader weighs them. */
const TRACE_WORDS: [type: string, one: string, many: string][] = [
	['incubator', 'an incubator listing', 'incubator listings'],
	['grant', 'a grant', 'grants'],
	['award', 'an award', 'awards'],
	['dpiit', 'a DPIIT register record', 'DPIIT register records'],
	['press', 'a press mention', 'press mentions'],
	['website', 'a live website', 'live websites'],
];

/**
 * What the traces are, not only how many. Two incubator listings are two programmes that
 * took the company in; an incubator listing and a grant are a programme and a funder,
 * which is a different story at the same count. Built from the signals the row already
 * carries, so it says nothing the evidence list does not.
 */
export function traceShape(company: Pick<Company, 'signals'>): string {
	const counts = new Map<string, number>();
	for (const signal of company.signals ?? []) counts.set(signal.type, (counts.get(signal.type) ?? 0) + 1);
	const parts = TRACE_WORDS.filter(([type]) => counts.has(type)).map(([type, one, many]) => {
		const n = counts.get(type)!;
		return n === 1 ? one : `${n} ${many}`;
	});
	if (parts.length <= 1) return parts.join('');
	return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Said beside the name of anything that is not, on the record, a company. */
const ENTITY_LABELS: Record<string, string> = {
	'researcher-project': 'a researcher&rsquo;s project, not a company',
	lab: 'a lab, not a company',
	unverified: 'no company on record',
};

function entityTag(company: Company): string {
	const label = company.entity_type ? ENTITY_LABELS[company.entity_type] : undefined;
	return label ? ` <span class="entity-tag">${label}</span>` : '';
}

/**
 * The keyword tags, each a link to the list filtered by it, and said to be keywords. Where a
 * description exists and no word matched, it says so; where none exists, nothing is claimed.
 */
function tagLine(company: Company): string {
	const builds = tagsOf(company.build_tags);
	const domains = tagsOf(company.domain_tags);
	// Nothing to read, nothing to say: tags are only ever read from a real description.
	if ((company.build_tags === null && company.domain_tags === null) || !(describedBySource(company) || (company.product && company.website_identity === 'verified'))) return '';
	const link = (key: 'build' | 'domain', tag: string) => `<a href="${esc(`${BASE_PATH}${query({ [key]: tag })}`)}#list">${esc(tag)}</a>`;
	if (!builds.length && !domains.length) {
		return '<p class="provenance tags">By keyword: no tag. Nothing in its description matched the words the tags are read from.</p>';
	}
	const parts = [
		builds.length ? `builds ${builds.map((t) => link('build', t)).join(', ')}` : null,
		domains.length ? `used in ${domains.map((t) => link('domain', t)).join(', ')}` : null,
	].filter(Boolean);
	return `<p class="provenance tags">By keyword: ${parts.join('; ')}. Matched from the words of its description, not checked.</p>`;
}

/**
 * Why this company is on the list, in one plain sentence for someone who arrived from a link:
 * who lists it, and how little else anyone has written.
 */
function whyOnList(company: Company): string {
	const names = [...new Set(company.signals.map((s) => s.source).filter((s): s is string => Boolean(s)).map((s) => SOURCE_LABELS[s] ?? s))];
	const who = names.length ? `${names.slice(0, 2).join(' and ')}${names.length > 2 ? ` and ${names.length - 2} more` : ''} ${names.length === 1 ? 'lists' : 'list'} it` : 'a source lists it';
	const n = company.trace_count;
	const shape = traceShape(company);
	const traces = n === 0 ? 'it has left no public trace' : `it has left ${n} public ${n === 1 ? 'trace' : 'traces'}${shape ? ` (${shape})` : ''}`;
	return `It is here because ${who}, and ${traces}; the list puts those with the fewest first.`;
}

/** What a sub-sector placement rests on, in three words, for beside the placement. */
function basisTag(company: Company): string {
	return company.classify_basis === 'register-label'
		? ` <span class="basis-tag weak">${labelWords(company).tag}</span>`
		: ' <span class="basis-tag">from its description</span>';
}

/**
 * How to name the label a placement or a row rests on. The register's dropdown and a grant
 * list's award category are both labels picked from a fixed list, and are judged the same;
 * the page says which one it is, since only one of them comes from a register.
 */
const LABEL_WORDS = {
	register: {
		tag: 'register label only',
		one: "a register's dropdown label",
		excerpt: 'A register&rsquo;s dropdown choices, not a description.',
		placed: "a register's industry label, picked by the founder from a fixed list",
	},
	grant: {
		tag: 'grant category only',
		one: 'the category a grant list filed its award under',
		excerpt: 'The category a grant list filed the award under, one of six, not a description.',
		placed: 'the category a grant list filed its award under, one of six',
	},
} as const;

function labelWords(company: Pick<Company, 'description'>) {
	return LABEL_WORDS[labelKind(company.description) ?? 'register'];
}

/** Short names for evidence on a row, where there is room for one word each. */
const EVIDENCE_NAMES: Record<string, string> = {
	dpiit: 'DPIIT',
	award: 'award',
	incubator: 'incubator',
	grant: 'grant',
	press: 'press',
	patent: 'patent',
	incorporation: 'incorporation',
	website: 'website live',
};

/** What the source's own date says happened, in the words a row has room for. */
const EVENT_VERBS: Record<string, string> = {
	dpiit: 'on DPIIT register',
	award: 'award',
	incubator: 'incubator listing',
	grant: 'grant awarded',
	press: 'press mention',
	patent: 'patent filed',
	incorporation: 'incorporated',
	website: 'website seen',
};

/** "Aug 2023", or the year alone when that is all a source gave. */
function monthYear(iso: string): string {
	const [y, m] = iso.slice(0, 10).split('-').map(Number);
	return m ? `${MONTHS[m - 1]} ${y}` : String(y);
}

/**
 * Whether a source says what the company does, as opposed to a register's dropdown.
 *
 * classify_basis is not enough by itself. A company the register shares with an incubator
 * whose listing has no sentence is classified as the incubator's row, so its basis reads
 * 'description', while the only text stored is the register's "DPIIT-recognised startup.
 * Industry: Nanotechnology. Stage: Prototype." — RELSYM, AGNIKUL and three more on 14
 * September 2026. The shape is the one ingest/sources/dpiit.py writes.
 */
function describedBySource(company: Company): boolean {
	return Boolean(company.description && !labelKind(company.description));
}

/**
 * What a row can say the company builds, and on whose word.
 *
 * Three states, and a reader has to tell them apart without reading: the company's own
 * homepage (checked to be theirs), a source's description of them, or nothing. A
 * register's dropdown label is not a description, and a row that printed "Industry:
 * Robotics. Stage: Prototype." where a sentence should be was padding an absence.
 */
function buildsLine(company: Company): { html: string; described: boolean } {
	if (company.product && company.website_identity === 'verified') {
		return { html: `<p class="builds">${esc(company.product)} <span class="says">in their own words</span></p>`, described: true };
	}
	if (describedBySource(company)) {
		return { html: `<p class="builds from-source">${esc(company.description)}</p>`, described: true };
	}
	return { html: '<p class="builds none">No description published</p>', described: false };
}

/**
 * The source's date for a row, named for what happened: "on DPIIT register Aug 2023".
 * Null when no source dates anything.
 */
function eventPhrase(company: Company): string | null {
	const dated = company.signals.filter((s) => isDated(s.date)).sort((a, b) => (a.date! < b.date! ? -1 : 1));
	if (dated.length) return `${EVENT_VERBS[dated[0].type] ?? dated[0].type} ${monthYear(dated[0].date!)}`;
	const event = sourceEvent(company);
	return event ? `${event.label} ${event.date}` : null;
}

/**
 * One row: what it builds, how old it is, what evidence exists, and why it is in this
 * view. Everything else is on the company's own page.
 *
 * Scanned, not read. So the three distinctions that decide whether a row is worth a
 * click are carried by how the row looks as well as by what it says: described or not,
 * dated or not, a website confirmed as theirs or not.
 */
function companyRow(company: Company, now: Date, origin: string): string {
	const builds = buildsLine(company);
	const dated = company.first_seen !== null;
	const site = company.website_identity === 'discovered' ? null : safeUrl(company.website);
	const siteState = site ? (company.website_identity === 'verified' ? 'verified' : 'unconfirmed') : company.website_checked ? 'none' : 'unknown';

	// Six things an analyst reads in two seconds, in the order they decide on: what they build,
	// hardware or software, how far along, how old and on whose word, who has noticed them, where.
	// How we placed or ranked it is meta about the process, and lives on the company's page.
	const kinds = tagsOf(company.build_tags);
	const facts = [
		kinds.length ? `<span class="f-kind">${esc(kinds.join(' + '))}</span>` : '',
		company.dpiit_stage ? `<span class="f-stage" title="The stage the company chose on its DPIIT profile">${esc(stageWords(company.dpiit_stage))}</span>` : '',
		// Selected into two or more public programmes: counted, never ranked, named on its page.
		company.programme_count >= 2 ? `<span class="f-prog" title="${esc(tagsOf(company.programmes).join(', '))}">${company.programme_count} public programmes</span>` : '',
		`<span class="f-age${dated ? '' : ' undated'}">${esc(eventPhrase(company) ?? 'no source dates it')}</span>`,
	].filter(Boolean);
	const trail = traceTrail(company);
	const city = company.city || company.state;

	const state = [builds.described ? 'described' : 'undescribed', dated ? 'dated' : 'undated', `site-${siteState}`].join(' ');

	// Anchored by slug so one row can be linked to, and so "back to results" lands on it.
	return `
  <li class="company ${state}" id="c-${esc(company.id)}" data-id="${esc(company.id)}" data-added="${esc((company.discovered ?? '').slice(0, 10))}">
    <div class="row-main">
      <h3><a href="${esc(`${BASE_PATH}/c/${company.id}`)}">${esc(company.name)}</a>${entityTag(company)}</h3>
      ${builds.html}
      <p class="facts-row">${facts.join('')}</p>
      <p class="trail">${trail || '<span class="none">no public trace</span>'}${city ? `<span class="f-city">${esc(city)}</span>` : ''}</p>
    </div>
    <div class="row-side">
      <span class="row-actions" hidden>
        <button type="button" class="mark" data-mark="shortlist" aria-pressed="false">Shortlist</button>
        <button type="button" class="mark" data-mark="seen" aria-pressed="false">Seen</button>
      </span>
      <button type="button" class="copy-row" hidden>Copy brief</button>
      <template class="brief">${esc(briefMarkdown(company, `${origin}${BASE_PATH}/c/${company.id}`, now))}</template>
    </div>
  </li>`;
}

/** DPIIT's stage values, in words: "EarlyTraction" is how the register writes it. */
function stageWords(stage: string): string {
	return stage.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Who has noticed the company, named: "SINE IIT Bombay portfolio + BIRAC BIG + own website".
 * Each part links to where it was published. The composition is the signal, not the count.
 */
export function traceTrail(company: Pick<Company, 'signals' | 'dpiit_status' | 'website' | 'website_identity'>): string {
	const parts = new Map<string, string | null>();
	for (const signal of company.signals ?? []) {
		const name = traceName(signal, company.dpiit_status);
		if (name && !parts.has(name)) parts.set(name, safeUrl(signal.url));
	}
	return [...parts.entries()]
		.map(([name, href]) => (href ? `<a class="t" href="${esc(href)}" rel="noopener nofollow">${esc(name)}</a>` : `<span class="t">${esc(name)}</span>`))
		.join('<span class="plus"> + </span>');
}

function traceName(signal: Signal, dpiitStatus: string | null): string | null {
	const label = (signal.label ?? '').trim();
	switch (signal.type) {
		case 'incubator':
			return `${SOURCE_LABELS[signal.source ?? ''] ?? label.replace(/,.*$/, '').replace(/\s+(incubatee|startup|portfolio company)s?$/i, '')} portfolio`;
		case 'grant': {
			// "SINE IIT Bombay DST NIDHI PRAYAS, Cohort 5" and "BIRAC BIG 21" both name a scheme.
			const scheme = label
				.replace(/^SINE IIT Bombay\s+/i, '')
				.replace(/^seed investment,\s*/i, '')
				.replace(/,\s*Cohort.*$/i, '')
				.replace(/\s+\d+(\.\d+)?$/, '')
				.replace(/\bNIDHI-PRAYAS\b/, 'NIDHI PRAYAS')
				.trim();
			return scheme || 'a grant';
		}
		case 'dpiit':
			return dpiitStatus === 'recognised' || dpiitStatus === 'expired' || dpiitStatus === 'cancelled' ? 'DPIIT recognition' : 'Startup India profile';
		case 'award':
			return label.replace(/,.*$/, '') || 'an award';
		case 'press':
			return 'press mention';
		case 'website':
			return 'own website';
		default:
			return null;
	}
}

/**
 * How many companies the ranked list is actually offering. The buckets always split at
 * the age gate, because the held-back line needs that number even when the gate is off
 * — so with the gate lifted, the older ones are part of what is listed.
 */
function listed(view: PageView): number {
	return view.buckets.ranked;
}

/**
 * Why the tiers are empty, said once, above the list. A page that opened on an empty
 * A+B would look broken; a page that widened the view without explaining it would be
 * quietly changing its own promise.
 */
function backfillNote(view: PageView): string {
	// On an empty database it is vacuously true and reads as an excuse. Nothing to
	// explain until there is something to explain.
	// Retired 15 Sep 2026: the list now opens on every tier by default, so there is no widening to explain.
	if (!view.backfillOnly || view.tracked === 0 || view.defaultTier === 'all') return '';
	return `<p class="note">Too few companies here qualify for Tier A or B today, so the list is showing every tier. Those tiers take a
    company we watched arrive, recently, in a source we were already reading, with few public traces &mdash; and with
    more than a register&rsquo;s dropdown label to say what it does. A new source&rsquo;s first read never qualifies.</p>`;
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
    founding year &mdash; the DPIIT register dates its own record of a company, not when the company started. The
    ${MAX_AGE_YEARS}-year filter cannot be applied to ${n === 1 ? 'it' : 'them'}, and ${n === 1 ? 'its row says' : 'their rows say'} so.</p>`;
}

/** Said only when the limit actually bit, so the count above stays trustworthy. */
function truncated(shown: number, total: number): string {
	return shown < total ? `<p class="note">Showing the first ${shown}.</p>` : '';
}

/**
 * An empty result says what was asked, and offers the nearest thing that is not empty:
 * the same question over every record, then each filter taken away one at a time.
 */
function emptyResult(view: PageView): string {
	// A sub-sector nobody is in is a fact about the records, not about the reader's filters.
	const cell = view.subsector ? view.coverage.sectors.flatMap((g) => g.subsectors).find((c) => c.subsector_id === view.subsector) : undefined;
	if (cell && cell.n === 0) {
		const group = view.coverage.sectors.find((g) => g.subsectors.includes(cell));
		const near = (group?.subsectors ?? []).filter((c) => c.n > 0).sort((a, b) => b.n - a.n).slice(0, 3);
		return `<div class="empty">
    <p>No record anywhere is in ${esc(cell.subsector_id)} ${esc(cell.subsector)} yet &mdash; a gap in what the sources list, not in your filters.</p>
    ${near.length ? `<ul class="ways">${near.map((c) => `<li><a href="${esc(`${BASE_PATH}${query(viewParams(view, { subsector: c.subsector_id }))}#list`)}">${esc(c.subsector_id)} ${esc(c.subsector)} (${c.n})</a></li>`).join('')}</ul>` : ''}
  </div>`;
	}
	const asked = view.search
		? `No company in this view has &ldquo;${esc(view.search)}&rdquo; in its name or in what it builds.`
		: 'No company in this view matches every filter you have set.';
	const ways: string[] = [];
	if (view.wider) {
		const everywhere = `${BASE_PATH}${query(viewParams(view, { described: 'all', kind: 'all', tier: 'all', age: 'all', dates: null, dpiit: null }))}#list`;
		ways.push(`<a href="${esc(everywhere)}">${view.wider} ${view.wider === 1 ? 'record matches' : 'records match'} outside this view &mdash; show ${view.wider === 1 ? 'it' : 'them'}</a>`);
	}
	for (const s of view.suggestions ?? []) ways.push(`Did you mean <a href="${esc(`${BASE_PATH}${query(viewParams(view, { q: s.name, described: 'all', kind: 'all', tier: 'all', age: 'all' }))}#list`)}">${esc(s.name)}</a>?`);
	for (const f of activeFilters(view)) ways.push(`<a href="${esc(f.href)}">Without &ldquo;${esc(f.label)}&rdquo;</a>`);
	return `<div class="empty">
    <p>${asked}</p>
    ${ways.length ? `<ul class="ways">${ways.map((w) => `<li>${w}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function list(view: PageView): string {
	const { companies, now, demo } = view;

	if (companies.length === 0) {
		// "Nothing matches" only when nothing does. A search whose one hit is undated
		// has a result, and saying otherwise above it is the page contradicting itself —
		// as is an empty list that does not say where its matches went.
		const undatedHere = view.dates !== 'dated' ? view.buckets.undated : 0;
		const empty =
			view.buckets.total > 0
				? undatedHere > 0
					? `<p class="empty">No dated match. <a href="#undated">${undatedHere} ${undatedHere === 1 ? 'match no source dates is' : 'matches no source dates are'} listed just below</a>.</p>`
					: ''
				: view.tracked === 0
					? '<p class="empty">Nothing matches yet. The ingest has not put anything here.</p>'
					: emptyResult(view);
		return `
<section class="list" id="list">
  <h2>Companies</h2>
  ${backfillNote(view)}
  ${empty}
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
  ${unknownAge(view)}
  ${truncated(companies.length, listed(view))}
  <ol class="companies">
${companies.map((company) => companyRow(company, now, view.origin)).join('\n')}
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
  <h2 id="undated-h">No source dates these <span class="count">${n}</span></h2>
  <p class="note">The same order, continued: no source gives a date for anything about these, so none can be called an early find.</p>
  ${truncated(undated.length, n)}
  <ol class="companies">
${undated.map((company) => companyRow(company, now, view.origin)).join('\n')}
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
  <h2 id="off-map-h">Unmapped under the current taxonomy and classifier <span class="count">${gaps.taxonomy.total}</span></h2>
  <p class="note">The classifier put these in a sector and then found no sub-sector in it that covers what they
    describe. Rather than stretch each one into the nearest cell &mdash; which would put a wrong tag on the map above
    &mdash; they are kept here under the name of what it said was missing. That can mean the RDI taxonomy has no cell
    for the work. It can also mean a company spans two cells and a classifier allowed one label could not choose, or
    that the classifier was wrong. None of these has been reviewed by hand, so read the groups as places to look for
    gaps in the taxonomy, not as proof of them.</p>
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
  <p class="note">Nothing here says anything about the taxonomy, and nothing is known to be wrong with these companies.
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
  <p><strong>${register.taxonomyGap}</strong> are unplaced because the classifier found
    <a href="#off-map">no sub-sector under the current taxonomy</a> for what they build. Some of that will be the
    scheme's boundary &mdash; a vocabulary written for five sunrise sectors &mdash; and some a classifier allowed one
    label per company, or simply wrong. Nobody has reviewed them by hand to say which.</p>`;

	const undescribed =
		register.undescribed === 0
			? ''
			: `
  <p><strong>${register.undescribed}</strong> are unplaced because
    <a href="#undescribed">the register never said what they do</a>. The DPIIT register publishes a company name and
    an industry the founder picked from a dropdown, and for these ${register.undescribed} that is the entire public
    record. Enough to know they exist; nothing like enough to say what they build. They are left unplaced rather than
    guessed at.</p>
  <p>This is the more interesting half. Of the ${register.total} records we took from the register, ${share}&nbsp;per&nbsp;cent
    are described too thinly for anyone to tell what they are &mdash; not too thinly for us in particular, too thinly
    for anyone reading them. That is a finding about those records, and only those: they are the newest few pages of
    each deep-tech industry filter, not a sample of the 473,000 companies the register holds, and nothing here says
    how the rest are described.</p>`;

	return `
  <p id="register">Of the ${register.total} companies read from the register, ${register.placed} reached a sub-sector and
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
    A startup on the DPIIT register whose domain has stopped resolving is a finding, not a missing cell.`
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
  <p>Public sources only, nothing behind a login. Five are read today: three incubator portfolios
    (<a href="https://www.sineiitb.org/portfolio/" rel="noopener">SINE IIT Bombay</a>,
    <a href="https://rtbi.in/incubationiitm/portfolio.html" rel="noopener">IIT Madras Incubation Cell</a> and
    <a href="https://www.venturecenter.co.in/startups-and-success-stories/startups" rel="noopener">Venture Center, Pune</a>), the published award lists
    of two grant programmes (<a href="https://birac.nic.in/" rel="noopener">BIRAC BIG</a> rounds 21&ndash;24 and
    DST NIDHI-PRAYAS, typed up by hand from the lists themselves), and the
    <a href="https://www.startupindia.gov.in/content/sih/en/search.html?roles=Startup" rel="noopener">DPIIT Startup India
    recognition register</a>. Patent filings, new incorporations at the MCA and every other incubator would all
    belong here and none of them is read yet, so nothing they would show is on this page. Every row carries the evidence that put it there.</p>

  ${productNote(view)}

  <h3>How the tiers are decided</h3>
  <p>There is no score. A number between 0 and 100 would pretend to a precision we do not have. Two facts decide the tier:
    how recently we first saw the company, and how many public traces it already has &mdash; today that means an
    incubator listing, a grant award, a DPIIT register record and a website that answered when we fetched it. A domain that
    no longer resolves is not a trace, and stops being one the night it stops answering. A press mention ought to count
    as well; nothing collects it yet, so for now it does not, and the trace counts on this page are lower than they
    would be.</p>
  <ul class="rules">
    <li><span class="tier ta">Tier A</span> Added to Upstream by a run under 90 days ago, with no source dating anything about it earlier than 90 days ago, and at most 2 traces. New and quiet. Read these first.</li>
    <li><span class="tier tb">Tier B</span> First seen under 180 days ago, at most 5 traces. Early, some visibility.</li>
    <li><span class="tier tc">Tier C</span> Everything else. Known territory &mdash; listed, not promoted.</li>
  </ul>
  <p>Neither A nor B is open to a company whose only description is a list's label &mdash; the DPIIT register's dropdown, or the category a BIRAC grant list filed its award under. That is enough to
    list a company and to place it where the label names a sub-sector outright; it is not enough to call it a find.</p>
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

  <h3 id="crosswalk">Two official classifications that do not meet</h3>
  <p>DPIIT's recognition register files every startup under its own industry vocabulary &mdash; 56 industries, chosen
    by the founder from a list when they applied. The RDI scheme has 44 sub-sectors, written by a different department
    for a different purpose. Neither was drawn up with the other in mind, and putting the same companies through both
    shows how little they overlap.</p>
  <p>Where the two vocabularies happen to have a near-twin, a company places almost automatically: left to the
    classifier on the run of ${CROSSWALK.run}, DPIIT's &ldquo;Robotics&rdquo; against the scheme's &ldquo;Intelligent
    Systems &amp; Robotics&rdquo; placed ${CROSSWALK.robotics[0]} of ${CROSSWALK.robotics[1]}. Where they have none, almost nothing placed: ${CROSSWALK.vision[0]} of ${CROSSWALK.vision[1]} for &ldquo;Computer
    Vision&rdquo;, ${CROSSWALK.ai[0]} of ${CROSSWALK.ai[1]} for &ldquo;AI&rdquo;. Same companies, same government, two filing systems that, as this
    classifier maps them, do not meet. That is a finding about the two vocabularies as read by one model from one-line
    labels, not a fault in either, and not a reviewed crosswalk.</p>
  <p>Those few placements were also where the classifier guessed: five &ldquo;AI / NLP&rdquo; records had gone into AI in
    Healthcare. So a register label now keeps a company on the map only where the label names the sub-sector outright
    &mdash; &ldquo;Space Technology&rdquo;, &ldquo;Robotics&rdquo;, &ldquo;Electronics&rdquo; &mdash; and a company whose
    label names none is counted with the ones we could not describe well enough to place.</p>
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

/**
 * Everything not known about a company, read off its empty fields. No model and no
 * judgement: each line is there because a column is NULL, so the list cannot flatter a
 * company by forgetting to mention something, and cannot invent a gap either.
 *
 * Shared by the page and the brief, so the two cannot disagree about what is unknown.
 */
export function unknowns(company: Company): string[] {
	const out: string[] = [];
	const sub = company.subsector_id ? SUBSECTOR_BY_ID.get(company.subsector_id) : undefined;
	const site = safeUrl(company.website);
	const host = site ? new URL(site).hostname : null;
	const productKnown = Boolean(company.product && company.website_identity === 'verified');
	const described = productKnown || describedBySource(company);

	if (company.entity_type === 'unverified') out.push('Whether a company exists behind this name: nothing on record shows one');
	if (company.entity_type === 'researcher-project') out.push('Whether a company has been formed: the record is a researcher’s project');
	if (!described) out.push(`What it builds: no source describes it, and ${labelWords(company).one} is not a description`);
	else if (!productKnown) out.push('What it says about itself: no homepage of theirs has been read');
	if (sub && !company.project_type) out.push(`What kind of product it is, within ${sub.subsector_id} ${sub.subsector}`);
	if (!ageKnown(company)) out.push('When it was founded: no source gives a founding or incubation year');
	if (!company.signals.some((s) => isDated(s.date)) && company.first_seen_basis !== 'cohort') {
		out.push('When any source first recorded it: no source dates anything about it');
	}
	if (!company.city && !company.state) out.push('Where it is based');
	if (site && company.website_identity === 'discovered') out.push(`Its website: ${host} was given for it, and is not treated as theirs`);
	else if (site && company.website_identity !== 'verified') out.push(`Whether ${host} is its website: not confirmed as theirs`);
	else if (!site && !company.website_checked) out.push('Whether it has a website: no source that publishes websites lists it');
	if (!company.cin) out.push('Its company registration: no CIN on record, so no MCA filing is joined');
	if (!company.founders) out.push('Founders: no source this page reads names them');
	out.push('Funding and revenue: Upstream collects neither');
	return out;
}

/** Where a brief says the website came from, in plain words. */
/**
 * What to print for a claim no source dated. "SINE IIT Bombay incubatee, 2024-2025 —
 * undated" read as a contradiction: the claim names its years, but no day on which
 * anything happened is on record, and that is the thing this column is about.
 */
function undatedWord(label: string): string {
	return /\b(19|20)\d\d\b/.test(label) ? 'no exact date' : 'not dated';
}

/** Where each source's founder line comes from, for the attribution beside it. */
function sourceName(source: string | null): string {
	return (source && SOURCE_LABELS[source]) || 'a source';
}

/**
 * Who they are and how to reach them, as lines with their provenance. Shared by the page
 * and the brief. A line is only here when the column behind it holds something: what is
 * missing is said once, under What is not known.
 */
function whoLines(company: Company): { label: string; text: string; note: string | null; href?: string }[] {
	const out: { label: string; text: string; note: string | null; href?: string }[] = [];
	if (company.founders) out.push({ label: 'Founders', text: company.founders, note: `as ${sourceName(company.founders_source)} lists them` });
	if (company.dpiit_status) {
		out.push({
			label: 'DPIIT',
			text: `${DPIIT_STATUS_PHRASES[company.dpiit_status] ?? company.dpiit_status}${company.dpiit_stage ? `; stage on its profile: ${company.dpiit_stage}` : ''}`,
			note: company.dpiit_status === 'profile' ? 'anyone can make a Startup India profile; recognition is DPIIT assessing it and issuing a number' : 'as the register’s record says',
		});
	}
	const verified = company.website_identity === 'verified';
	if (verified && company.contact_email) out.push({ label: 'Email', text: company.contact_email, note: 'on their own domain, from their homepage', href: `mailto:${company.contact_email}` });
	const page = verified ? safeUrl(company.contact_page) : null;
	if (page) out.push({ label: 'Contact page', text: page, note: 'linked from their homepage', href: page });
	if (verified && company.domain_registered) {
		out.push({
			label: 'Domain registered',
			text: shortDate(company.domain_registered),
			note: 'from the domain registry (RDAP); the domain’s age, not the company’s — a domain can be bought years earlier, or second-hand',
		});
	}
	const site = verified ? safeUrl(company.website) : null;
	if (site && company.web_first_capture) {
		out.push({
			label: 'First archived',
			text: shortDate(company.web_first_capture),
			note: 'the Wayback Machine’s oldest copy of their homepage: when the public web first noticed the page, not when the company began',
			href: `https://web.archive.org/web/*/${new URL(site).hostname}`,
		});
	}
	const named = tagsOf(company.programmes);
	if (named.length) {
		out.push({
			label: 'Public programmes',
			text: named.join(' · '),
			note: `${named.length} ${named.length === 1 ? 'programme' : 'programmes'} that selected them, counted and not ranked; an incubator often runs a scheme's selection, so they are not all independent`,
		});
	}
	// Signs of activity, read off their own site and the web archive. Facts about the site, not
	// the company: a careers page is not headcount, and a still homepage is not a still company.
	const signals = verified ? siteSignalsOf(company.site_signals) : null;
	if (signals) {
		if (signals.parked) out.push({ label: 'Homepage', text: 'reads as parked, for sale or not built yet', note: 'what the page says about itself; the company may simply be elsewhere' });
		if (signals.careers_hosted && signals.careers) out.push({ label: 'Careers', text: `on ${signals.careers_hosted}`, note: 'linked from their homepage; roles there were not counted', href: signals.careers });
		else if (signals.careers) {
			const roles = signals.roles ?? 0;
			out.push({
				label: 'Careers',
				text: roles > 0 ? `${roles} ${roles === 1 ? 'role' : 'roles'} listed` : signals.says_no_openings ? 'page says no openings' : 'page, no roles named',
				note: 'role titles counted on their careers page; roughly, and not headcount',
				href: signals.careers,
			});
		}
		if (signals.team) out.push({ label: 'Team page', text: 'yes', note: 'linked from their homepage', href: signals.team });
		if (signals.repo) out.push({ label: 'Code', text: signals.repo.replace(/^https:\/\//, ''), note: 'a code account named like their site, linked from it', href: signals.repo });
		if (signals.versions !== null && signals.versions !== undefined) {
			const v = signals.versions;
			out.push({
				label: 'Site changes',
				text: v === 0 ? 'no archived copy in two years' : v === 1 ? 'one version in two years' : `${v} versions in two years${signals.last_change ? `, latest ${shortDate(signals.last_change)}` : ''}`,
				note: 'distinct copies of their homepage the Wayback Machine kept; how often the site changes, not the company',
			});
		}
	}
	return out;
}

function whoSection(company: Company): string {
	const lines = whoLines(company);
	if (!lines.length) return '';
	return `<section>
    <h2>Who they are</h2>
    <dl class="who">${lines
			.map(
				(l) =>
					`<div><dt>${esc(l.label)}</dt><dd>${l.href ? `<a href="${esc(l.href)}" rel="noopener nofollow">${esc(l.text)}</a>` : esc(l.text)}</dd>${
						l.note ? `<dd class="why">${esc(l.note)}</dd>` : ''
					}</div>`,
			)
			.join('')}</dl>
  </section>`;
}

/**
 * Works whose author affiliation names the company. Under the evidence and not in it: a
 * paper is somebody writing about their science, not somebody noticing the company, so
 * it does not count as a trace or move the row.
 */
function papersBlock(company: Company): string {
	const papers = papersOf(company.papers);
	if (!papers || papers.count === 0) return '';
	const query = safeUrl(papers.query_url);
	return `<div class="papers">
      <h3 class="mini">Research papers</h3>
      <p class="provenance">${papers.count} ${papers.count === 1 ? 'work lists' : 'works list'} this company as an author affiliation, in OpenAlex${
				query ? ` (<a href="${esc(query)}" rel="noopener nofollow">see them</a>)` : ''
			}. Not counted as a public trace.</p>
      <ul class="paper-list">${papers.works
				.map((w) => {
					const href = safeUrl(w.url);
					const title = esc(w.title);
					return `<li>${href ? `<a href="${esc(href)}" rel="noopener nofollow">${title}</a>` : title}${w.year ? ` <span class="mono">${esc(w.year)}</span>` : ''}</li>`;
				})
				.join('')}</ul>
    </div>`;
}

function siteLine(company: Company): string | null {
	const site = safeUrl(company.website);
	if (!site) return null;
	if (company.website_identity === 'verified') return `${site} (checked as theirs: ${company.website_identity_note ?? 'name matched'})`;
	if (company.website_identity === 'discovered') return `${site} was given for it and is NOT treated as theirs (${company.website_identity_note ?? 'nothing ties it to them'})`;
	return `${site} (not confirmed as theirs${company.website_identity_note ? `: ${company.website_identity_note}` : ''})`;
}

/** Why the company is on this list and where the ranking puts it, in one line. */
function whyHere(company: Company): string {
	const shape = traceShape(company);
	const traces = `${company.trace_count} public ${company.trace_count === 1 ? 'trace' : 'traces'}${shape ? ` (${shape})` : ''}`;
	let reason: string;
	if (company.tier === 'A') reason = 'found by a run under 90 days ago, with at most two public traces and nothing older on record';
	else if (company.tier === 'B') reason = 'on record under 180 days, with at most five public traces';
	else if (company.first_seen === null) reason = 'no source dates it, so it cannot be called an early find';
	else if (company.classify_basis === 'register-label') reason = `only ${labelWords(company).one} says what it does, so it is listed, not promoted`;
	else if (company.first_seen_basis === 'cohort') reason = 'dated from a year its source published, not found by a run of ours';
	else reason = 'on record for more than 180 days, or with more than five public traces';
	return `${traces}, which is what the list sorts by. Tier ${company.tier}: ${reason}.`;
}

/**
 * What a reader should not lean on, said before they forward it. Each line comes from a
 * column, like the unknowns: nothing here is a judgement about the company.
 */
function evidenceLimits(company: Company): string[] {
	const out: string[] = [];
	const site = safeUrl(company.website);
	const productKnown = Boolean(company.product && company.website_identity === 'verified');
	if (productKnown) out.push('What it builds is quoted from its own homepage; the name on the site was checked, the claims on it were not');
	else if (describedBySource(company)) out.push('What it builds is a source’s description of it, not checked against the company');
	else out.push(`Nothing published says what it builds; only ${labelWords(company).one} exists`);
	if (company.classify_basis === 'register-label') out.push(`Its sub-sector rests on ${labelWords(company).one} alone, which supports nothing narrower`);
	if (site && company.website_identity !== 'verified') out.push('Its website is not confirmed as theirs, so nothing on it is used');
	if (company.entity_type && company.entity_type !== 'company') out.push(`Not shown to be a company: ${company.entity_note ?? 'nothing on record shows one'}`);
	if (company.dpiit_status === 'profile' || company.dpiit_status === 'pending') out.push('On Startup India with a profile DPIIT has not recognised');
	if (company.dpiit_status === 'expired' || company.dpiit_status === 'cancelled') out.push(`Its DPIIT recognition is ${company.dpiit_status}`);
	if (!company.signals.some((s) => isDated(s.date))) out.push('No source gives a date for anything it lists');
	out.push('The placement is automated and nobody has reviewed it');
	return out;
}

/** Where to go next, from the most direct public route on record to the least. */
function nextStep(company: Company): string {
	const verified = company.website_identity === 'verified';
	const page = verified ? safeUrl(company.contact_page) : null;
	if (verified && company.contact_email) return `Write to ${company.contact_email} (on their own domain, from their homepage)${page ? `, or use ${page}` : ''}. A public route, not an introduction.`;
	if (page) return `Their contact page: ${page}. A public route, not an introduction.`;
	const site = verified ? safeUrl(company.website) : null;
	if (site) return `Their website, ${site}, which gives no contact route on its homepage.`;
	const listing = company.signals.find((s) => (s.type === 'incubator' || s.type === 'grant') && safeUrl(s.url));
	if (listing) return `Ask ${SOURCE_LABELS[listing.source ?? ''] ?? 'the source'}, whose page lists them: ${safeUrl(listing.url)}.`;
	return 'No public contact route is on record; start from the evidence above.';
}

/**
 * The brief a reader can forward, as markdown, from a template.
 *
 * The order is the one a partner reads in: what it is, what nobody knows, then the
 * evidence. "Unknown" is a heading at the same level as "Evidence" and comes before it,
 * because a forwarded lead that buries its gaps is how a guess becomes a fact two
 * emails later.
 */
export function briefMarkdown(company: Company, pageUrl: string, now: Date): string {
	const sub = company.subsector_id ? SUBSECTOR_BY_ID.get(company.subsector_id) : undefined;
	const site = company.website_identity === 'verified' ? safeUrl(company.website) : null;
	const lines: string[] = [`# ${company.name}`, ''];

	if (company.entity_type && company.entity_type !== 'company') {
		lines.push(`_${(ENTITY_LABELS[company.entity_type] ?? '').replace(/&rsquo;/g, '’')}${company.entity_note ? `: ${company.entity_note}` : ''}._`, '');
	}

	if (company.product && site) {
		lines.push(`**What it builds:** ${company.product} _(in their own words, from ${new URL(site).hostname})_`);
	} else if (describedBySource(company)) {
		lines.push(`**What it builds:** ${company.description} _(as ${SOURCE_LABELS[company.description_source ?? ''] ?? 'a source'} described it)_`);
	} else {
		lines.push('**What it builds:** Unknown. No source describes it.');
		if (company.description) lines.push(`The only published line is ${labelWords(company).one}: ${registerText(company.description, company.dpiit_status)}`);
	}
	if (company.product && site && describedBySource(company)) {
		lines.push(`**As a source described it:** ${company.description}`);
	}

	const located = [company.city, company.state].filter(Boolean).join(', ');
	lines.push(
		`**Why it is here:** ${whyHere(company)}`,
		`**Started:** ${ageKnown(company) ? String(company.origin_year ?? company.founded_year) : 'unknown'} · **Based:** ${located || 'unknown'} · **Public traces:** ${company.trace_count}`,
	);
	for (const line of whoLines(company)) lines.push(`**${line.label}:** ${line.text}${line.note ? ` _(${line.note})_` : ''}`);
	lines.push(
		'',
		'## Open questions',
		...unknowns(company).map((u) => `- ${u}`),
		'',
		'## Evidence',
	);
	for (const signal of company.signals) {
		const where = SOURCE_LABELS[signal.source ?? ''] ?? signal.type;
		lines.push(`- ${signal.label} — ${where}, ${signal.date ?? undatedWord(signal.label)}: ${safeUrl(signal.url) ?? 'no link published'}`);
	}
	const siteSaid = siteLine(company);
	if (siteSaid) lines.push(`- Website: ${siteSaid}`);
	const papers = papersOf(company.papers);
	if (papers && papers.count > 0) {
		lines.push(`- Papers: ${papers.count} ${papers.count === 1 ? 'work lists' : 'works list'} it as an author affiliation (OpenAlex, not counted as a trace): ${papers.query_url}`);
		for (const work of papers.works) lines.push(`  - ${work.title}${work.year ? ` (${work.year})` : ''}: ${work.url}`);
	}

	lines.push('', '## Limits of the evidence', ...evidenceLimits(company).map((l) => `- ${l}`));
	lines.push('', '## Next step', `- ${nextStep(company)}`);
	lines.push('', '## Placement');
	if (sub) {
		lines.push(
			`- RDI ${sub.subsector_id} ${sub.subsector}, placed ${
				company.classify_basis === 'register-label' ? `from ${labelWords(company).one} only, which supports nothing narrower` : 'from its description'
			}${company.project_type ? `; project type: ${company.project_type}` : ''}`,
		);
	} else {
		lines.push('- Not placed in any RDI sub-sector');
	}
	lines.push(
		`- Tier ${company.tier}`,
		'',
		`Upstream record: ${pageUrl}`,
		`Last checked: ${shortDate(company.updated_at)}, the last run that read a source listing it`,
		`_Assembled from public records on ${shortDate(now.toISOString())} by a template. No person has checked it, and the placement is automated._`,
	);
	return lines.join('\n');
}

export interface CompanyView {
	company: Company;
	now: Date;
	/** The company page's own absolute URL, for the brief. */
	pageUrl: string;
}

/** Why this company is in the tier it is in, in the words of the rule that decided. */
function whyTier(company: Company): string {
	if (company.first_seen === null) {
		return `No source will say when this company became visible, so it cannot be called an early find
      however new it looks. A row with no date is Tier C by the rule, not by judgement.`;
	}
	if (company.classify_basis === 'register-label') {
		return `The only thing any source says about what this company does is ${labelWords(company).one}. That is
      enough to list it, not to call it an early find, so it is Tier C until a source describes what it builds.`;
	}
	if (company.first_seen_basis === 'cohort') {
		return `The date here was read off a published cohort or award year during a backfill. That is the
      incubator's news rather than ours, and only a company we watched arrive can reach Tier A.`;
	}
	const traces = company.trace_count;
	const event = earliestEvent(
		company.signals.map((s) => s.date),
		company.origin_year,
	);
	const old = event !== null && daysSince(event, new Date()) >= 90;
	return `Found in a run of a source that was already running, with ${traces === 1 ? '1 public trace' : `${traces} public traces`}
    at the time. Tier A is a discovery under 90 days old with at most 2 traces, where no source dates anything about the
    company earlier than that; Tier B under 180 days with at most 5.${
			old
				? ` A source dates this company to ${esc(shortDate(event))}, so however recently we found it, it was not
    new when we did.`
				: ''
		}`;
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
		case 'source-described':
			return `<p class="provenance">${link || 'Their site'} is theirs, and was not read: their incubator&rsquo;s
        listing already says what they build, below, in a sentence written about them rather than by them.</p>`;
		case 'unverified':
			return `<p class="provenance">${link || 'Their site'} answered, but nothing on it confirmed the address is
        theirs, so it was not read. A sentence from someone else's homepage is worse than none.</p>`;
		case 'unreachable':
			return `<p class="provenance">They publish${link}, and it does not answer. A listed startup whose
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
 * One company, as a brief rather than a record dump.
 *
 * In the order a sourcing decision needs it: what it builds and on whose word, what is
 * not known, the evidence with a link for every claim, the three dates kept apart, and
 * the classification with the model's note labelled as reasoning. The classifier's note
 * is printed as written; every signal links back to the page it came from.
 */
export function renderCompanyPage(view: CompanyView): string {
	const { company, now, pageUrl } = view;
	const sub = company.subsector_id ? SUBSECTOR_BY_ID.get(company.subsector_id) : undefined;
	// Not a discovered address: the header link reads as "their site", and for Grinntech
	// it was HyperVerge's. productDetail still names the address, with the reason.
	const site = company.website_identity === 'discovered' ? null : safeUrl(company.website);
	const productKnown = Boolean(company.product && company.website_identity === 'verified');
	const located = [company.city, company.state].filter(Boolean).join(', ');

	// What they build, first and in words: their own sentence, else a source's, else the plain
	// absence. How their site was read, which was once the first thing here, folds beneath it.
	const sourceWords = describedBySource(company)
		? `<p class="desc">${esc(company.description)}<span class="says">as ${esc(SOURCE_LABELS[company.description_source ?? ''] ?? 'the source')} described it</span></p>`
		: '';
	const buildsLead = productKnown
		? `<p class="builds builds-lead">${esc(company.product)} <span class="says">in their own words</span></p>${sourceWords}`
		: sourceWords ||
			(company.description
				? `<p class="unknown-value">No source says what it builds.</p><p class="desc">${esc(registerText(company.description, company.dpiit_status))}</p><p class="provenance">${labelWords(company).excerpt} Nothing here says what the company makes.</p>`
				: '<p class="unknown-value">No source says what it builds.</p>');
	const excerpt = company.description
		? !describedBySource(company)
			? `<p class="desc">${esc(registerText(company.description, company.dpiit_status))}</p><p class="provenance">${labelWords(company).excerpt} Nothing here says what the company makes.</p>`
			: `<p class="desc">${esc(company.description)}<span class="says">as ${esc(SOURCE_LABELS[company.description_source ?? ''] ?? 'the source')} described it</span></p>`
		: '<p class="unknown-value">Unknown</p><p class="provenance">No source published a description.</p>';

	const evidenceRows = company.signals
		.map((signal) => {
			const href = safeUrl(signal.url);
			const where = href
				? `<a href="${esc(href)}" rel="noopener nofollow">${esc(new URL(href).hostname)}</a>`
				: '<span class="no-link">no link published</span>';
			return `<tr>
          <td>${esc(signal.label)} <span class="ev-type">${esc(signal.type)}</span></td>
          <td>${esc(SOURCE_LABELS[signal.source ?? ''] ?? signal.source ?? '')}</td>
          <td class="mono">${
				signal.date
					? esc(signal.date)
					: `<span class="no-link">${undatedWord(signal.label)}${signal.published ? `; list published ${esc(signal.published)}` : ''}</span>`
			}</td>
          <td>${where}</td>
        </tr>`;
		})
		.join('');
	const evidence = company.signals.length
		? `<div class="table-scroll"><table class="evidence-table">
      <thead><tr><th scope="col">Claim</th><th scope="col">Source</th><th scope="col">Date</th><th scope="col">Link</th></tr></thead>
      <tbody>${evidenceRows}</tbody>
    </table></div>`
		: '<p class="provenance">No signals recorded, which should not be possible &mdash; every company here arrived with at least one.</p>';

	const event = sourceEvent(company);
	const dates: Array<[string, string, string]> = [
		[
			'Source event',
			event ? `${event.label} ${event.date}` : 'none',
			event ? 'The oldest dated thing any source says about the company. Their timeline, not ours.' : 'No source dates anything about this company.',
		],
		['Added to Upstream', company.discovered.slice(0, 10), 'The day the row was written. Never a claim about the company.'],
		['Last checked', company.updated_at.slice(0, 10), 'The last run that read a source listing this company and wrote the row again.'],
	];

	const unknownItems = unknowns(company)
		.map((u) => {
			const [head, ...rest] = u.split(': ');
			return `<li><strong>${esc(head)}</strong>${rest.length ? ` &mdash; ${esc(rest.join(': '))}` : ''}</li>`;
		})
		.join('');

	const brief = briefMarkdown(company, pageUrl, now);

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(company.name)} &mdash; Upstream</title>
<meta name="description" content="${esc(company.product ?? registerText(company.description, company.dpiit_status) ?? company.name)}">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/upstream/favicon.svg" type="image/svg+xml">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fbfaf8">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#141310">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Upstream">
<meta property="og:title" content="${esc(company.name)} — Upstream">
<meta property="og:description" content="${esc(company.product ?? registerText(company.description, company.dpiit_status) ?? company.name)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:image" content="${esc(`${new URL(pageUrl).origin}${BASE_PATH}/og.png`)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="${esc(`${BASE_PATH}/c/${company.id}`)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600&display=optional">
<style>${STYLES}</style>
</head>
<body data-company="${esc(company.id)}">
<div class="wrap detail">
  <p class="eyebrow"><a class="back" href="${esc(`${BASE_PATH}#c-${company.id}`)}">&larr; Upstream</a></p>

  <header class="masthead">
    <p class="about-upstream">One company on <a href="${esc(BASE_PATH)}">Upstream</a>, a list of Indian deep-tech companies that puts the least-noticed first.</p>
    <h1>${esc(company.name)}</h1>
    <p class="why-here">${esc(whyOnList(company))}</p>
    ${
			company.entity_type && company.entity_type !== 'company'
				? `<p class="provenance entity">${ENTITY_LABELS[company.entity_type] ?? ''}: ${esc(company.entity_note ?? '')}.</p>`
				: ''
		}
    <p class="facts">
      ${traceLine(company)}
      ${site && company.website_identity === 'verified' ? `<a class="fact-site" href="${esc(site)}" rel="noopener nofollow">${esc(new URL(site).hostname)}</a>` : ''}
      <span class="${located ? '' : 'unknown-inline'}">${located ? esc(located) : 'location unknown'}</span>
      <span class="${ageKnown(company) ? '' : 'unknown-inline'}">${ageKnown(company) ? `started ${esc(company.origin_year ?? company.founded_year)}` : 'founding year unknown'}</span>
    </p>
  </header>

  <section>
    <h2>What they build</h2>
    ${buildsLead}
    <details class="reading"><summary>How this was read</summary>${productDetail(company)}</details>
  </section>

  <section class="keep">
    <div class="actions">
      <button type="button" class="action copy-brief" hidden>Copy brief</button>
      <button type="button" class="action mark" data-mark="shortlist" aria-pressed="false" hidden>Shortlist</button>
      <button type="button" class="action mark" data-mark="pass" aria-pressed="false" hidden>Pass</button>
    </div>
    <p class="device-note" id="device-note" hidden>Shortlist and pass are stored in this browser on this device only &mdash;
      not synced, and not visible to anyone else, including whoever runs this site.</p>
    <details class="brief-fold"><summary>The brief, as markdown</summary><textarea id="brief-text" readonly rows="16" spellcheck="false">${esc(brief)}</textarea></details>
  </section>

  ${whoSection(company)}

  <section class="unknowns">
    <h2>What is not known</h2>
    <ul class="unknown-list">${unknownItems}</ul>
  </section>

  <section>
    <h2>Evidence</h2>
    <p class="provenance">Everything that put this company on the list, with the page it came from.</p>
    ${evidence}
    ${papersBlock(company)}
  </section>

  <section>
    <h2>Dates</h2>
    <dl class="dates">
      ${dates.map(([label, value, why]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd><dd class="why">${why}</dd></div>`).join('')}
    </dl>
    ${
			company.source_year
				? `<p class="provenance">The source listing prints ${esc(company.source_year)} beside the name, with no word on what it counts &mdash; founding, incubation or admission. Nothing here dates or ranks the company by it.</p>`
				: ''
		}
  </section>

  <section>
    <h2>Where in the RDI scheme</h2>
    ${
			sub
				? `<p class="rdi-full"><a href="${esc(`${BASE_PATH}${query({ subsector: sub.subsector_id })}`)}">${esc(sub.subsector_id)} &mdash; ${esc(sub.subsector)}</a></p>
      <p class="provenance basis">${
				company.classify_basis === 'register-label'
					? `<span class="basis-tag weak">${labelWords(company).tag}</span> The only thing placing it here is ${labelWords(company).placed}. That supports this sub-sector and nothing narrower.`
					: '<span class="basis-tag">from its description</span> Placed from the description above.'
			}</p>
      <p class="provenance">Project type: ${
				company.project_type
					? esc(company.project_type)
					: company.classify_basis === 'register-label'
						? 'unknown &mdash; nothing published about the company says what kind of product it is'
						: 'none matched'
			}</p>
      ${
				// Kept for inspection, and said to be what it is. The classifier restating
				// the label in a full sentence ("a robotics company developing robotic
				// platforms") is not a second source agreeing with the first.
				company.classify_note
					? `<details class="reasoning"><summary>How the classifier decided &mdash; its reasoning, not evidence</summary>
        <blockquote class="note-verbatim">${esc(company.classify_note)}</blockquote>${
							company.entity_type && company.entity_type !== 'company' && /\bcompany\b/i.test(company.classify_note)
								? '<p class="provenance">It says &ldquo;company&rdquo;. Nothing on record shows one exists.</p>'
								: ''
						}</details>`
					: ''
			}`
				: '<p class="provenance">Not placed in any sub-sector.</p>'
		}
    ${tagLine(company)}
  </section>

  <section>
    <h2>Where it ranks</h2>
    <p class="rank-line">${company.tier === 'A' ? 'New and quiet (Tier A)' : company.tier === 'B' ? 'Recent (Tier B)' : 'Listed, not promoted (Tier C)'}</p>
    <p class="provenance">${whyTier(company)}</p>
  </section>
</div>
<script>${MARKS_SCRIPT}</script>
<script>${DETAIL_SCRIPT}</script>
</body>
</html>`;
}

/**
 * A company address that holds nothing. Said plainly, with the two ordinary reasons a real
 * link stops working here, the nearest names, and a way back — not a bare "Not found".
 */
export function renderNotFound(slug: string, nearest: Pick<Company, 'id' | 'name'>[]): string {
	const words = slug.replace(/[-_]+/g, ' ').trim();
	const search = `${BASE_PATH}${query({ q: words, described: 'all', kind: 'all', tier: 'all', age: 'all' })}#list`;
	const list = nearest.length
		? `<h2>Names close to it</h2>
  <ul class="nearest">${nearest.map((c) => `<li><a href="${esc(`${BASE_PATH}/c/${c.id}`)}">${esc(c.name)}</a></li>`).join('')}</ul>`
		: '';
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>No company at this address &mdash; Upstream</title>
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/upstream/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600&display=optional">
<style>${STYLES}</style>
</head>
<body>
<div class="wrap detail not-found">
  <p class="eyebrow"><a class="back" href="${esc(BASE_PATH)}">&larr; Upstream</a></p>
  <header class="masthead">
    <h1>No company at this address</h1>
    <p class="lede">Nothing on Upstream is filed under &ldquo;${esc(slug)}&rdquo;. A link stops working here for two ordinary
      reasons: a company listed twice under two spellings is folded into one row and keeps the other address, or a source
      stopped listing it.</p>
  </header>
  ${list}
  <p><a href="${esc(search)}">Search every record for &ldquo;${esc(words)}&rdquo;</a> &middot; <a href="${esc(BASE_PATH)}">Back to the list</a></p>
</div>
</body>
</html>`;
}

// --- styles -----------------------------------------------------------------

export const STYLES = `
/* Metric-matched stand-ins, so the page does not reflow when the web fonts arrive: the
   swap was the whole of a 0.22 layout shift on a phone (15 Sep 2026). Arial and Courier New
   are scaled to Inter's and DM Mono's widths and heights. */
@font-face { font-family: "Inter Fallback"; src: local("Arial"), local("Helvetica"), local("Liberation Sans"); ascent-override: 90.44%; descent-override: 22.52%; line-gap-override: 0%; size-adjust: 107.12%; }
@font-face { font-family: "DM Mono Fallback"; src: local("Courier New"), local("Liberation Mono"); ascent-override: 78%; descent-override: 21%; line-gap-override: 0%; size-adjust: 106%; }
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

  --sans: Inter, "Inter Fallback", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "DM Mono", "DM Mono Fallback", ui-monospace, SFMono-Regular, Menlo, monospace;

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

  --measure: 70ch;
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
/* One measure for running text, about 70 characters, wherever a paragraph sits. */
p { margin: 0 0 var(--s3); max-width: var(--measure); }
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
/* A stat that is also a way in: the number is the link, and looks like the number. */
.stats dd a { color: inherit; text-decoration: underline; text-decoration-color: var(--rule-strong); text-decoration-thickness: 2px; text-underline-offset: 5px; }
.stats dd a:hover { text-decoration-color: currentColor; }
/* What the headline leaves out, said directly under it rather than in a footnote. */
.set-aside { font-size: var(--t-sm); color: var(--muted); max-width: var(--measure); margin: var(--s4) 0 0; }
.set-aside a { color: var(--ink); text-decoration: underline; text-decoration-color: var(--rule-strong); text-underline-offset: 3px; }
.set-aside strong { font-family: var(--mono); font-weight: 500; }
/* The findings: the page's argument, numbered, each number a link to its proof. */
.findings { margin: 0 0 var(--s6); }
.finding-list { margin: 0; padding: 0; list-style: none; counter-reset: finding; display: grid; gap: var(--s4); max-width: var(--measure); }
.finding-list li { counter-increment: finding; position: relative; padding-left: var(--s6); line-height: 1.55; }
.finding-list li::before { content: counter(finding); position: absolute; left: 0; top: 0.1em; font-family: var(--mono); font-size: var(--t-xs); color: var(--muted); }
.finding-list strong { font-weight: 600; }
.finding-list a { color: var(--ink); font-weight: 500; text-decoration: underline; text-decoration-color: var(--rule-strong); text-underline-offset: 3px; }
.finding-list a:hover { text-decoration-color: currentColor; }
/* Only rendered when it is not zero, so this is always news. */
.fresh { font-size: var(--t-xs); color: var(--muted); margin: var(--s4) 0 0; }
.funnel-note { color: var(--muted); font-size: var(--t-xs); max-width: var(--measure); margin: var(--s5) 0 0; }

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
.note { color: var(--muted); font-size: var(--t-xs); max-width: var(--measure); margin-bottom: var(--s4); }

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
.list.loading { opacity: 0.55; transition: opacity 120ms ease-out; }
.resume { color: var(--ink); text-underline-offset: 3px; display: inline-flex; min-height: 44px; align-items: center; }
.since { font-size: var(--t-sm); margin: var(--s3) 0 0; padding: var(--s2) var(--s3); border-left: 2px solid var(--ink); background: var(--raise); }
.hide-seen .company.is-seen { display: none; }
.only-new .company:not(.is-new) { display: none; }
.company.is-new .row-main h3::after { content: 'new'; font-family: var(--mono); font-size: var(--t-micro); font-weight: 500; margin-left: var(--s2); padding: 0 var(--s0h); border: 1px solid var(--rule-strong); border-radius: 999px; vertical-align: middle; }
/* The map leads the page and is the control: sector names are links, cells filter. */
.coverage { margin: var(--s6) 0 var(--s5); }
.coverage .widget-head { margin-bottom: var(--s3); }
.sector > summary { list-style: none; cursor: pointer; }
.sector > summary::-webkit-details-marker { display: none; }
.sector > summary h3 { display: flex; align-items: baseline; gap: var(--s2); }
.sector-n { font-family: var(--mono); font-size: var(--t-micro); color: var(--muted); font-variant-numeric: tabular-nums; }
@media (max-width: 34rem) {
  .sector { margin-bottom: 0; border-bottom: 1px solid var(--rule); }
  .sector > summary { min-height: 44px; display: flex; align-items: center; }
  .sector > summary h3 { margin: 0; width: 100%; }
  .sector > summary h3::after { content: '+'; margin-left: auto; color: var(--muted); }
  .sector.unfolded > summary h3::after, .sector[data-chosen] > summary h3::after { content: '–'; }
  .sector:not(.unfolded):not([data-chosen]) > .grid { display: none; }
  .sector > .grid { padding-bottom: var(--s3); }
}
.sector-link { color: inherit; text-decoration: none; display: inline-flex; align-items: center; gap: var(--s1); }
.sector-link:hover, .sector-link.active { text-decoration: underline; text-underline-offset: 3px; }
.cell.zero { color: var(--muted); }
.cell.zero .cell-n { opacity: 0.55; }
.tag-grid { margin-top: var(--s2); }
.meta-stage { color: var(--ink); }
/* The reference half: collapsed, labelled, and set apart from the tool above. */
.reference { margin-top: var(--s7); padding-top: var(--s5); border-top: 2px solid var(--rule-strong); }
.reference > h2 { font-size: var(--t-h); margin: 0 0 var(--s1); }
.ref { border-bottom: 1px solid var(--rule); }
.ref > summary { cursor: pointer; padding: var(--s3) 0; font-weight: 500; min-height: 44px; display: flex; align-items: center; }
.ref[open] > summary { color: var(--muted); }
.ref > section, .ref > p { margin-bottom: var(--s4); }
/* Selected text inverts, in both themes, rather than borrowing the browser's blue. */
::selection { background: var(--ink); color: var(--paper); }
/* The smallest step is for labels a desktop reader glances at; on a phone it grows a step. */
@media (max-width: 34rem) { :root { --t-nano: var(--t-micro); } }
/* On paper: the rows and what they rest on, in black on white, without the controls. */
@media print {
  :root { --paper: #fff; --raise: #fff; --ink: #000; --muted: #444; --rule: #bbb; --rule-strong: #888; }
  .controls, .filter-menu, .row-actions, .copy-row, .mark, .ask, .bar-links, script, .device-note { display: none !important; }
  .company { break-inside: avoid; }
  details { display: block; }
  details > summary { list-style: none; }
  a { text-decoration: none; }
  .row-main h3 a::after { content: ' — ' attr(href); font-weight: 400; font-size: var(--t-micro); color: var(--muted); }
}
/* Figures that sit in columns or beside each other keep one width, so counts line up. */
.cell-n, .stats dd, .result-line strong, .count, .districts .n, .trace-n, .finding-list strong, .widget-meta strong { font-variant-numeric: tabular-nums; }
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


/* the control bar: controls before explanation, and still there after a scroll */
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.controls {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--paper);
  padding: var(--s3) 0 var(--s2);
  margin: 0 0 var(--s4);
  border-bottom: 1px solid var(--rule-strong);
}
.bar { position: relative; display: flex; flex-wrap: wrap; align-items: stretch; gap: var(--s2); }
.bar .field { display: flex; }
.bar .field-search { flex: 1 1 14rem; min-width: 0; }
.field-sort select { height: 100%; }
select {
  font: inherit;
  font-size: var(--t-sm);
  color: inherit;
  background: var(--raise);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  padding: var(--s2) var(--s3);
  max-width: 100%;
  min-width: 0;
}
select:hover { border-color: var(--rule-strong); }
.filter-menu > summary {
  list-style: none;
  cursor: pointer;
  height: 100%;
  display: flex;
  align-items: center;
  font-size: var(--t-sm);
  padding: var(--s2) var(--s3);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--raise);
  white-space: nowrap;
}
.filter-menu > summary::-webkit-details-marker { display: none; }
.filter-menu > summary:hover { border-color: var(--rule-strong); }
.filter-menu[open] > summary { border-color: var(--ink); }
.filter-count { font-family: var(--mono); }
/* Positioned against the bar rather than the button, so on a phone it spans the width
   instead of hanging off whichever line the button wrapped onto. */
.filter-panel {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + var(--s1));
  z-index: 11;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
  gap: var(--s3);
  padding: var(--s4);
  background: var(--raise);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  box-shadow: 0 10px 30px color-mix(in srgb, var(--ink) 12%, transparent);
}
.filter-panel .field { display: flex; flex-direction: column; gap: var(--s1); }
.filter-panel label {
  font-size: var(--t-micro);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.filter-panel select { width: 100%; }
.apply {
  font: inherit;
  font-size: var(--t-sm);
  padding: var(--s2) var(--s4);
  border: 1px solid var(--ink);
  border-radius: var(--radius);
  background: var(--ink);
  color: var(--paper);
  cursor: pointer;
  align-self: end;
}
.active-chips { margin: var(--s2) 0 0; align-items: center; }
.active-chips:empty { display: none; }
.filter-chip { color: var(--ink); }
.filter-chip span { color: var(--muted); margin-left: var(--s0); }
.filter-chip:hover span { color: var(--ink); }
.clear { font-size: var(--t-xs); color: var(--muted); }
.bar-foot {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--s1) var(--s3);
  margin-top: var(--s2);
  font-size: var(--t-xs);
  color: var(--muted);
}
.result-line { margin: 0; }
.result-line strong { font-family: var(--mono); color: var(--ink); font-weight: 500; }
.result-line a, .linkish { color: var(--ink); text-decoration: underline; text-decoration-color: var(--rule-strong); text-underline-offset: 3px; }
.result-line a:hover, .linkish:hover { text-decoration-color: currentColor; }
.bar-links { display: flex; flex-wrap: wrap; gap: var(--s3); }
@media (max-width: 34rem) {
  /* A thumb, not a cursor: controls reach 44px, and pills keep their look while an invisible
     margin around them takes the tap. */
  .mark, .copy-row, .chip, select, input[type='search'], .filter-menu > summary, .apply, .linkish { min-height: 44px; }
  .row-side .mark, .row-side .copy-row { padding-inline: var(--s3); border-radius: var(--radius); }
  .ev, a.rdi, .result-line a, .bar-links a { position: relative; }
  .ev::after, a.rdi::after, .result-line a::after, .bar-links a::after { content: ''; position: absolute; inset: -14px -4px; }
  /* Pinned, only the search, the filter button and the sort stay: about 110px, not 183. */
  .controls.stuck .bar-foot, .controls.stuck .active-chips { display: none; }
  .controls { padding-block: var(--s2); }
  /* The panel scrolls inside itself and keeps Apply in reach instead of below the fold. */
  .filter-panel { max-height: calc(100dvh - 9rem); overflow-y: auto; grid-template-columns: 1fr 1fr; gap: var(--s2) var(--s3); padding: var(--s3); }
  .filter-panel .field-search, .filter-panel .field-wide { grid-column: 1 / -1; }
  .apply { position: sticky; bottom: 0; grid-column: 1 / -1; width: 100%; min-height: 44px; }
}
.linkish { font: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.linkish[aria-pressed='true'] { font-weight: 600; text-decoration-color: currentColor; }
.export { color: var(--muted); text-decoration-color: var(--rule-strong); text-underline-offset: 3px; }
.export:hover { color: var(--ink); text-decoration-color: currentColor; }
.device-note { font-size: var(--t-xs); color: var(--muted); margin: 0 0 var(--s4); }
.device-note strong { color: var(--ink); font-weight: 500; }

/* rows: dense, and different at a glance by what is known */
.company {
  display: flex;
  gap: var(--s3);
  padding: var(--s3);
  margin-inline: calc(var(--s3) * -1);
  border-bottom: 1px solid var(--rule);
}
/* The notebook's rows are the older shape, stacked rather than main-and-side. */
.company:not(:has(> .row-main)) { display: block; padding-block: var(--s4); }
/* Clear of the sticky bar when a link or "back to results" lands on a row. */
li.company { scroll-margin-top: 10rem; }
.row-main { flex: 1 1 auto; min-width: 0; }
.row-main h3 { font-size: var(--t-body); font-weight: 600; margin: 0 0 var(--s0); line-height: 1.3; }
.row-main h3 a { text-decoration-color: var(--rule-strong); text-underline-offset: 3px; }
.row-main h3 a:hover { text-decoration-color: currentColor; }
.company .builds {
  font-size: var(--t-sm);
  margin: 0 0 var(--s1);
  max-width: var(--measure);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* Nothing published: said in words, and quieter than a row that has a sentence. */
.company .builds.none { color: var(--muted); font-style: italic; }
.company.undescribed h3 a { font-weight: 500; }
.meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s1) var(--s3); margin: 0; font-size: var(--t-xs); color: var(--muted); }
.meta > span { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: var(--s0h); }
.ev {
  font-family: var(--mono);
  font-size: var(--t-micro);
  line-height: 1.5;
  padding: 0 var(--s0h);
  border: 1px solid var(--rule-strong);
  border-radius: 999px;
  background: var(--raise);
  color: var(--ink);
  text-decoration: none;
  white-space: nowrap;
}
a.ev:hover { border-color: var(--ink); }
.ev.unconfirmed { border-style: dashed; color: var(--muted); }
.ev.none { border-style: dashed; color: var(--muted); }
/* Undated and unlocated are said, and said in the voice of an absence. */
.meta-when.undated, .meta-where.unknown { font-style: italic; }
.row-side {
  /* A fixed width, so every row's name and description start and end on the same lines. */
  flex: 0 0 13.5rem;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--s1);
  font-size: var(--t-xs);
  color: var(--muted);
  text-align: right;
}
.row-actions { display: flex; gap: var(--s1); }
.row-actions[hidden] { display: none; }
.mark {
  font: inherit;
  font-size: var(--t-micro);
  padding: var(--s0) var(--s2);
  border: 1px solid var(--rule);
  border-radius: 999px;
  background: var(--raise);
  color: var(--muted);
  cursor: pointer;
}
.mark:hover { border-color: var(--rule-strong); color: var(--ink); }
.mark[aria-pressed='true'] { background: var(--ink); border-color: var(--ink); color: var(--paper); }
/* Seen dims and stays where it was, so the list does not shift under a reader. */
.company.is-seen .row-main { opacity: 0.5; }
.company.is-passed { display: none; }
.show-passed .company.is-passed { display: flex; opacity: 0.45; }
@media (max-width: 34rem) {
  .bar .field-search { flex-basis: 100%; }
  .bar .field-sort { flex: 1 1 auto; }
  .bar .field-sort select { width: 100%; }
}
.only-shortlisted .company:not(.is-shortlisted) { display: none; }
@media (max-width: 34rem) {
  .company { flex-direction: column; gap: var(--s1); }
  .row-side { flex: 0 0 auto; flex-direction: row; align-items: center; flex-wrap: wrap; text-align: left; }
  .row-side .traces { flex-basis: 100%; align-items: flex-start; }
}

/* coverage map, folded after the list */
.map-fold > summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--s2) var(--s3);
  cursor: pointer;
  list-style: none;
  padding: var(--s3) 0;
  border-bottom: 1px solid var(--rule);
  margin-bottom: var(--s4);
}
.map-fold > summary::-webkit-details-marker { display: none; }
.map-fold > summary h2 {
  font-size: var(--t-micro);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--muted);
  font-weight: 500;
  margin: 0;
}
.map-fold-meta { color: var(--muted); font-size: var(--t-xs); }
.map-fold > summary::after { content: "show"; margin-left: auto; color: var(--muted); font-size: var(--t-xs); }
.map-fold[open] > summary::after { content: "hide"; }

/* list */
.list h2 .count { font-family: var(--mono); }
.companies { list-style: none; margin: 0; padding: 0; }
/* Padded past the text column and pulled back by the same amount, so a row can take
   a background on hover without the text appearing to shift. */
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
.builds { margin: 0 0 var(--s0h); max-width: var(--measure); color: var(--ink); }
/* The attribution is not decoration. This line is the company's own account of
   itself and the row must never let it read as something we checked. */
.says {
  margin-left: 0.35em;
  font-size: var(--t-micro);
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.07em;
  white-space: nowrap;
}
.desc { margin: 0 0 var(--s0h); max-width: var(--measure); color: var(--muted); font-size: var(--t-sm); }
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
/* The longest sub-sector names are wider than a phone. A pill that cannot wrap pushed the
   whole page sideways at 390px. */
.meta > .meta-rdi { max-width: 100%; }
.meta .rdi { white-space: normal; border-radius: 0.9em; }
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
.traces { display: flex; flex-direction: column; align-items: flex-end; gap: var(--s0); }
.trace-n { font-family: var(--mono); white-space: nowrap; }
.trace-shape { font-size: var(--t-micro); line-height: 1.35; }
/* On a company's page the count and what it is read as one fact in the line. */
.facts .traces { display: inline; }
.f-prog { font-weight: 600; }
.widget-lead { border: 1px solid var(--rule-strong); border-radius: var(--radius); padding: var(--s4); background: var(--raise); margin-bottom: var(--s5); }
.widget-lead .widget-meta { font-size: var(--t-body); color: var(--ink); max-width: var(--measure); }
.widget-lead .widget-meta a { color: inherit; text-underline-offset: 3px; }
.finding-lead { font-size: var(--t-body); }
.finding-lead a { color: inherit; }
.facts-row { display: flex; flex-wrap: wrap; gap: 0 var(--s2); margin: 0 0 var(--s0h); font-size: var(--t-xs); color: var(--ink); }
.facts-row > span + span::before { content: '·'; margin-right: var(--s2); color: var(--muted); }
.f-kind { font-weight: 500; }
.f-stage { font-weight: 500; }
.f-age.undated { color: var(--muted); font-style: italic; }
.trail { margin: 0; font-size: var(--t-xs); color: var(--muted); display: flex; flex-wrap: wrap; align-items: baseline; gap: 0; }
.trail .t { color: var(--muted); text-decoration-color: var(--rule-strong); text-underline-offset: 3px; }
.trail a.t:hover { color: var(--ink); }
.trail .f-city::before { content: '·'; margin: 0 var(--s2); }
.trail .none { font-style: italic; }
.row-side { flex: 0 0 auto; }
.scope { font-size: var(--t-xs); color: var(--muted); margin: var(--s3) 0 0; }
.scope strong { color: var(--ink); font-weight: 500; font-variant-numeric: tabular-nums; }
.scope a { color: var(--ink); text-underline-offset: 3px; }
.top-picks { margin: var(--s5) 0 0; padding: var(--s4); border: 1px solid var(--rule-strong); border-radius: var(--radius); background: var(--raise); }
.top-picks h2 { font-size: var(--t-xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 500; margin: 0 0 var(--s2); }
.top-picks ol { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s3); }
.top-picks li { display: grid; grid-template-columns: 1fr; column-gap: var(--s3); align-items: baseline; }
.top-picks li > a { font-weight: 600; text-underline-offset: 3px; }
.pick-builds { grid-column: 1; font-size: var(--t-sm); color: var(--muted); display: -webkit-box; -webkit-line-clamp: 1; line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; }
.pick-traces { grid-column: 1; font-size: var(--t-xs); color: var(--muted); }
@media (max-width: 34rem) {
  .top-picks li { grid-template-columns: 1fr; }
  .pick-traces { grid-column: 1; grid-row: auto; }
  .pick-builds { -webkit-line-clamp: 2; line-clamp: 2; }
}
.see-all { display: inline-flex; align-items: center; min-height: 44px; margin-top: var(--s1); font-size: var(--t-sm); color: var(--ink); text-underline-offset: 3px; }
.about-upstream { font-size: var(--t-sm); color: var(--muted); margin: 0 0 var(--s3); }
.about-upstream a { color: var(--ink); }
.why-here { font-size: var(--t-body); margin: var(--s2) 0 var(--s3); }
.builds-lead { font-size: var(--t-lede); max-width: var(--measure); }
.reading > summary { cursor: pointer; font-size: var(--t-xs); color: var(--muted); margin-top: var(--s2); min-height: 44px; display: flex; align-items: center; }
.keep { border-top: 1px solid var(--rule); padding-top: var(--s4); }
.rank-line { font-weight: 500; margin-bottom: var(--s1); }
.empty .ways { list-style: none; padding: 0; margin: var(--s2) 0 0; display: grid; gap: var(--s2); }
.not-found .nearest { list-style: none; padding: 0; margin: 0 0 var(--s5); display: grid; gap: var(--s2); }
.not-found h2 { font-size: var(--t-h); margin: var(--s5) 0 var(--s2); }
.facts .trace-shape { font-size: inherit; }
.facts .trace-shape::before { content: ': '; }
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
.result-summary { color: var(--muted); }
/* the widget row: the population in view, five ways, in the coverage map's cells */
.widgets { margin: calc(-1 * var(--s5)) 0 var(--s5); display: grid; gap: var(--s5); }
.widget { min-width: 0; border-top: 1px solid var(--rule); padding-top: var(--s3); }
.widget-head { margin: 0 0 var(--s2); }
.widget-head h2 { font-size: var(--t-micro); text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); font-weight: 500; margin: 0 0 var(--s1); }
.widget-meta { margin: 0; font-size: var(--t-xs); color: var(--muted); max-width: var(--measure); }
.widget-meta strong { color: var(--ink); font-weight: 500; }
.widget-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s5); }
@media (min-width: 46rem) { .widget-row { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.seg-grid { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); }
.cell.seg { overflow: hidden; padding-bottom: var(--s1); }
.cell.seg .cell-id { display: inline-flex; align-items: center; gap: 0.3em; }
.cell.seg .sector-icon { width: 1.1em; height: 1.1em; }
/* The share of the records in view, as a hairline along the cell's foot. A proportion
   drawn in ink, not a colour: the yellow stays spent on what nobody has noticed. */
.cell .share { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--ink); opacity: 0.5; }
.cell.weak-seg { border-style: dashed; }
.cell-when { font-size: var(--t-nano); color: var(--muted); line-height: 1.2; margin-top: var(--s0); }
.cell-when .failing { color: var(--ink); font-weight: 500; }
/* The map beside the tiles on a wide screen, above them on a phone. Capped, so a state is
   big enough to hit and the list is not pushed a screen down to make room for Kashmir. */
.places-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s3) var(--s5); align-items: start; }
@media (min-width: 46rem) { .places-body { grid-template-columns: minmax(0, 20rem) minmax(0, 1fr); } }
.places-tiles { min-width: 0; }
.india-map { margin: 0 auto; width: 100%; max-width: 20rem; }
.india-map svg { display: block; width: 100%; height: auto; }
.india-map .state { fill: color-mix(in srgb, var(--ink) var(--ink-share), var(--paper)); stroke: var(--paper); stroke-width: 1; stroke-linejoin: round; }
.india-map .state.none { fill: var(--raise); stroke: var(--rule-strong); }
.india-map .state-link:hover .state { stroke: var(--ink); stroke-width: 1.5; }
.india-map .state-halo { fill: none; stroke: var(--paper); stroke-width: 5; stroke-linejoin: round; pointer-events: none; }
.india-map .state-outline { fill: none; stroke: var(--ink); stroke-width: 2.5; stroke-linejoin: round; pointer-events: none; }
.india-map figcaption { font-size: var(--t-nano); color: var(--muted); margin-top: var(--s1); }
.india-map figcaption a { color: inherit; }
.more-places { margin-top: var(--s1); }
.more-places > summary { cursor: pointer; font-size: var(--t-xs); color: var(--muted); }
.more-places > .grid { margin-top: var(--s1); }
.districts { font-size: var(--t-xs); color: var(--muted); margin: var(--s2) 0 0; }
.who { margin: 0; display: grid; gap: var(--s3); }
.who > div { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0 var(--s4); }
@media (min-width: 46rem) { .who > div { grid-template-columns: 11rem minmax(0, 1fr); } .who .why { grid-column: 2; } }
.who dt { font-size: var(--t-xs); color: var(--muted); }
.who dd { margin: 0; overflow-wrap: anywhere; }
.who dd.why { font-size: var(--t-xs); color: var(--muted); }
.papers { margin-top: var(--s4); }
.paper-list { margin: var(--s2) 0 0; padding-left: var(--s4); font-size: var(--t-sm); }
.paper-list li { margin-bottom: var(--s1); }
.districts .n { font-family: var(--mono); color: var(--ink); }
/* the question box */
.ask { margin: 0 0 var(--s5); }
.ask-form label { display: block; font-size: var(--t-micro); text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); font-weight: 500; margin-bottom: var(--s1); }
.ask-bar { display: flex; gap: var(--s1); }
.ask-bar input { flex: 1 1 auto; min-width: 0; font: inherit; font-size: var(--t-sm); padding: var(--s2) var(--s3); border: 1px solid var(--rule-strong); border-radius: var(--radius); background: var(--raise); color: var(--ink); }
.ask-bar button { font: inherit; font-size: var(--t-sm); padding: var(--s2) var(--s4); border: 1px solid var(--ink); border-radius: var(--radius); background: var(--ink); color: var(--paper); cursor: pointer; }
.ask-bar button:disabled { opacity: 0.5; cursor: wait; }
.ask-note { font-size: var(--t-xs); color: var(--muted); margin: var(--s1) 0 0; max-width: var(--measure); }
.ask-out:empty { display: none; }
.ask-out { margin-top: var(--s3); border-left: 2px solid var(--rule-strong); padding-left: var(--s3); }
.ask-answer { margin: 0 0 var(--s1); }
.ask-evidence { font-size: var(--t-xs); color: var(--muted); margin: 0 0 var(--s2); }
.ask-view { color: var(--ink); white-space: nowrap; }
.ask-resting, .ask-wait { font-size: var(--t-sm); color: var(--muted); }
.ask-examples { list-style: none; padding: 0; margin: 0; }
.ask-examples li { padding: var(--s2) 0; border-top: 1px solid var(--rule); }
.ask-q { font-weight: 500; margin: 0 0 var(--s0); }
.place-tiles { display: flex; flex-wrap: wrap; gap: var(--s1); margin: var(--s2) 0 0; }
.place-grid { margin-top: var(--s3); grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); }
.place-grid .cell-name { overflow-wrap: normal; word-break: normal; hyphens: auto; }
.place-grid .cell-name { -webkit-line-clamp: 2; line-clamp: 2; }
.cell.unknown-place { border-width: 1.5px; }
.cell.unknown-place .cell-n { opacity: 1; font-weight: 500; color: var(--ink); }
.note strong { color: var(--ink); font-weight: 500; }
.place { border: 1px solid var(--rule); padding: 2px var(--s1); color: var(--ink); text-decoration: none; font-size: var(--t-xs); white-space: nowrap; }
.place:hover { border-color: var(--rule-strong); }
.place.on { border-color: var(--ink); background: var(--raise); }
.place.unknown { border-style: dashed; color: var(--muted); }
.place-n { font-family: "DM Mono", ui-monospace, monospace; }
.freshness { font-size: var(--t-xs); color: var(--muted); margin: var(--s2) 0 0; }
.freshness strong { color: var(--ink); }
.entity-tag { color: var(--muted); font-size: 0.8em; font-weight: normal; white-space: nowrap; }
.result-summary strong { color: var(--ink); }
.basis-tag { color: var(--muted); font-size: 0.85em; white-space: nowrap; }
/* A warning, not a find, so it does not get the yellow: that means "nobody has noticed
   this company yet", and a register label is a fact about the evidence instead. */
.basis-tag.weak {
  color: var(--ink);
  font-size: var(--t-micro);
  border: 1px dashed var(--rule-strong);
  border-radius: 999px;
  padding: 0 var(--s0h);
}
.reasoning summary { cursor: pointer; color: var(--muted); }
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
.provenance { font-size: var(--t-sm); color: var(--muted); max-width: var(--measure); }
/* The classifier's reasoning, printed as written. Set apart so it cannot be mistaken
   for the page speaking in its own voice. */
.note-verbatim {
  margin: var(--s3) 0;
  padding: var(--s3) var(--s4);
  border-left: 2px solid var(--rule-strong);
  background: var(--raise);
  font-size: var(--t-sm);
  max-width: var(--measure);
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


/* the brief */
.actions { display: flex; flex-wrap: wrap; gap: var(--s2); margin: var(--s4) 0 var(--s2); }
.action {
  font: inherit;
  font-size: var(--t-sm);
  padding: var(--s2) var(--s4);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  background: var(--raise);
  color: var(--ink);
  cursor: pointer;
}
.action:hover { border-color: var(--ink); }
.action.copy-brief { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.copy-row { font: inherit; font-size: var(--t-xs); color: var(--ink); background: none; border: 1px solid var(--rule-strong); border-radius: 999px; padding: var(--s0) var(--s2); cursor: pointer; white-space: nowrap; }
.copy-row:hover { border-color: var(--ink); }
.action[aria-pressed='true'] { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.brief-fold { margin-top: var(--s2); font-size: var(--t-xs); color: var(--muted); }
.brief-fold summary { cursor: pointer; }
.brief-fold textarea { margin-top: var(--s2); font-family: var(--mono); font-size: var(--t-xs); }
.builds-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: var(--s4) var(--s6); }
.mini { font-size: var(--t-micro); text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 500; margin: 0 0 var(--s2); }
/* Unknown is a value, and gets the weight of one. */
.unknown-value { font-weight: 600; margin: 0 0 var(--s2); }
.unknown-inline { font-style: italic; }
.unknown-list { list-style: none; margin: 0; padding: 0; }
.unknown-list li { padding: var(--s2) 0; border-bottom: 1px solid var(--rule); font-size: var(--t-sm); color: var(--muted); }
.unknown-list li strong { color: var(--ink); font-weight: 600; }
.table-scroll { overflow-x: auto; }
.evidence-table { width: 100%; border-collapse: collapse; font-size: var(--t-sm); }
.evidence-table th { text-align: left; font-size: var(--t-micro); text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 500; padding: var(--s2) var(--s3) var(--s2) 0; border-bottom: 1px solid var(--rule-strong); }
.evidence-table td { padding: var(--s2) var(--s3) var(--s2) 0; border-bottom: 1px solid var(--rule); vertical-align: baseline; }
.evidence-table .ev-type { margin-left: var(--s1); }
.mono { font-family: var(--mono); font-size: var(--t-xs); white-space: nowrap; }

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
.method p, .method li { font-size: var(--t-sm); color: var(--muted); max-width: var(--measure); }
.method a { color: var(--ink); }
.rules { list-style: none; margin: 0 0 var(--s4); padding: 0; }
.rules li { margin-bottom: var(--s0h); display: flex; gap: var(--s2); align-items: baseline; }
.rules .tier { flex: 0 0 auto; }

/* wider screens */
@media (min-width: 46rem) {
  .wrap { padding: var(--s7) var(--s6) calc(var(--s7) * 1.5); }
  .grid { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); }
  .place-grid { grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); }
  .company { padding-inline: var(--s4); margin-inline: calc(var(--s4) * -1); }
}

/* The radio inputs behind the segmented control are visually hidden but still
   focusable, so the focus ring has to be drawn on the label. */
.seg:has(input:focus-visible) { outline: 2px solid var(--ink); outline-offset: -2px; }
a:focus-visible, select:focus-visible, .apply:focus-visible, .mark:focus-visible, .linkish:focus-visible, summary:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

@media (prefers-reduced-motion: no-preference) {
  .cell, .chip, .apply, .company, select, .seg, .mark, .copy-row, .ev { transition: border-color 160ms ease-out, background 160ms ease-out, color 160ms ease-out; }
}
`;

// --- scripts ------------------------------------------------------------------

/**
 * Shortlist, seen and pass, kept in this browser and nowhere else.
 *
 * localStorage, because the alternative is an account, and an account is a promise to
 * keep somebody's working list safe that a single-person project cannot make. The cost
 * is that nothing follows a reader to another device, and the page says so wherever the
 * marks appear. Everything is wrapped: a private window or blocked storage turns the
 * buttons off rather than breaking the page.
 */
export const MARKS_SCRIPT = `
(function () {
  var KEY = 'upstream.marks.v1';
  var store = null;
  try { localStorage.setItem(KEY + '.probe', '1'); localStorage.removeItem(KEY + '.probe'); store = localStorage; } catch (e) {}
  function empty() { return { shortlist: {}, seen: {}, pass: {} }; }
  function read() {
    if (!store) return empty();
    try {
      var v = JSON.parse(store.getItem(KEY) || '{}');
      return { shortlist: v.shortlist || {}, seen: v.seen || {}, pass: v.pass || {} };
    } catch (e) { return empty(); }
  }
  function write(m) { if (store) { try { store.setItem(KEY, JSON.stringify(m)); } catch (e) {} } }
  window.upstreamMarks = {
    available: !!store,
    read: read,
    toggle: function (kind, id) {
      var m = read();
      if (m[kind][id]) { delete m[kind][id]; }
      else {
        m[kind][id] = Date.now();
        // Shortlisting and passing contradict each other; the newer one wins.
        if (kind === 'pass') delete m.shortlist[id];
        if (kind === 'shortlist') delete m.pass[id];
      }
      write(m);
      return !!m[kind][id];
    },
    set: function (kind, id) { var m = read(); if (!m[kind][id]) { m[kind][id] = Date.now(); write(m); } },
    clear: function () { if (store) { try { store.removeItem(KEY); } catch (e) {} } },
    size: function (m) { return Object.keys(m.shortlist).length + Object.keys(m.seen).length + Object.keys(m.pass).length; }
  };
})();
`;

/**
 * The list page. Everything here is an enhancement: without it the form is a GET form,
 * every chip and count is a link, and the rows simply have no mark buttons.
 */
export const LIST_SCRIPT = `
(function () {
  // --- one thing that leaves the page: a row's brief, copied ---
  // Before anything that can bail out, so a browser without fetch still gets it.
  if (navigator.clipboard && navigator.clipboard.writeText) {
    var reveal = function () {
      var buttons = document.querySelectorAll('button.copy-row[hidden]');
      for (var i = 0; i < buttons.length; i++) buttons[i].hidden = false;
    };
    reveal();
    new MutationObserver(reveal).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('button.copy-row') : null;
      if (!button) return;
      var tpl = button.parentNode.querySelector('template.brief');
      if (!tpl) return;
      navigator.clipboard.writeText(tpl.content.textContent).then(function () {
        button.textContent = 'Copied';
        setTimeout(function () { button.textContent = 'Copy brief'; }, 1600);
      }, function () { button.textContent = 'Copy failed'; });
    });
  }

  var form = document.getElementById('controls');
  if (!form || !window.fetch || !window.DOMParser || !window.URLSearchParams) return;
  var marks = window.upstreamMarks;
  var apply = form.querySelector('.apply');
  if (apply) apply.hidden = true;

  // Where "back to results" should go: the view as it is now, canonical spelling.
  function remember() {
    try { sessionStorage.setItem('upstream.results', location.pathname + location.search); } catch (e) {}
    // Across days, the last narrowed view, named as its chips name it, so a return visit can resume it.
    try {
      if (location.search) {
        var chipLabels = Array.prototype.map.call(document.querySelectorAll('#chips a.filter-chip'), function (a) { return a.firstChild ? a.firstChild.textContent.trim() : ''; }).filter(Boolean);
        var count = document.querySelector('#result-line strong');
        if (chipLabels.length) localStorage.setItem('upstream.lastView', JSON.stringify({ url: location.pathname + location.search, label: chipLabels.join(' · '), n: count ? count.textContent : '' }));
      }
    } catch (e) {}
  }
  remember();

  // --- marks on rows ---
  var showPassed = false;
  var onlyShortlisted = false;
  var onlyNew = false;
  var prefs = null;
  try { prefs = localStorage; } catch (e) {}
  var hideSeen = false;
  try { hideSeen = prefs && prefs.getItem('upstream.hideSeen') === '1'; } catch (e) {}
  // When this reader was last here, read before today's visit is written over it.
  var lastVisit = null;
  try {
    lastVisit = prefs && prefs.getItem('upstream.lastVisit');
    var today = new Date().toISOString().slice(0, 10);
    if (prefs && lastVisit !== today) prefs.setItem('upstream.lastVisit', today);
    if (lastVisit === today) lastVisit = prefs.getItem('upstream.previousVisit');
    else if (prefs && lastVisit) prefs.setItem('upstream.previousVisit', lastVisit);
  } catch (e) {}
  function paint() {
    var m = marks.read();
    var rows = document.querySelectorAll('li.company[data-id]');
    var passedHere = 0, shortlistedHere = 0;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i], id = row.getAttribute('data-id');
      row.classList.toggle('is-shortlisted', !!m.shortlist[id]);
      row.classList.toggle('is-seen', !!m.seen[id]);
      row.classList.toggle('is-passed', !!m.pass[id]);
      if (m.pass[id]) passedHere++;
      if (m.shortlist[id]) shortlistedHere++;
      var actions = row.querySelector('.row-actions');
      if (actions && marks.available) actions.hidden = false;
      var buttons = row.querySelectorAll('button.mark');
      for (var j = 0; j < buttons.length; j++) {
        var kind = buttons[j].getAttribute('data-mark');
        buttons[j].setAttribute('aria-pressed', m[kind][id] ? 'true' : 'false');
      }
    }
    document.body.classList.toggle('show-passed', showPassed);
    document.body.classList.toggle('only-shortlisted', onlyShortlisted);
    document.body.classList.toggle('hide-seen', hideSeen);
    document.body.classList.toggle('only-new', onlyNew);

    // Since the last visit: quiet on a first visit and when nothing below is newer.
    var since = document.getElementById('since');
    var resume = null;
    try { resume = !location.search && JSON.parse(localStorage.getItem('upstream.lastView') || 'null'); } catch (e) {}
    if (since && lastVisit) {
      var fresh = 0;
      for (var r = 0; r < rows.length; r++) {
        var added = rows[r].getAttribute('data-added') || '';
        var isNew = added > lastVisit;
        rows[r].classList.toggle('is-new', isNew);
        if (isNew) fresh++;
      }
      since.hidden = fresh === 0 && !resume;
      if (!fresh && resume) since.innerHTML = '';
      if (fresh) {
        var parts = lastVisit.split('-');
        var day = Number(parts[2]) + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(parts[1]) - 1];
        since.innerHTML = 'Since your last visit on ' + day + ': <strong>' + fresh + '</strong> of the companies below ' + (fresh === 1 ? 'is' : 'are') + ' new. '
          + '<button type="button" class="linkish" data-act="only-new" aria-pressed="' + (onlyNew ? 'true' : 'false') + '">' + (onlyNew ? 'Show everything' : 'Show only those') + '</button>';
      }
    }
    if (since && resume && resume.url) {
      since.hidden = false;
      var link = document.createElement('a');
      link.href = resume.url + '#controls';
      link.className = 'resume';
      link.textContent = 'Resume where you left off: ' + resume.label + (resume.n ? ' (' + resume.n + ')' : '');
      if (!since.querySelector('a.resume')) { if (since.innerHTML) since.appendChild(document.createElement('br')); since.appendChild(link); }
    }
    var seenCount = Object.keys(m.seen).length;
    var seenToggle = form.querySelector('.seen-toggle');
    if (seenToggle) {
      seenToggle.hidden = !marks.available || seenCount === 0;
      seenToggle.setAttribute('aria-pressed', hideSeen ? 'true' : 'false');
      seenToggle.textContent = hideSeen ? 'Show the ' + seenCount + ' seen' : 'Hide the ' + seenCount + ' seen';
    }
    var exportLink = form.querySelector('.shortlist-export');
    var ids = Object.keys(m.shortlist);
    if (exportLink) {
      exportLink.hidden = !marks.available || ids.length === 0;
      exportLink.textContent = 'CSV of your shortlist (' + ids.length + ')';
      exportLink.setAttribute('href', form.getAttribute('action').split('#')[0] + '/export.csv?described=all&kind=all&tier=all&age=all&ids=' + encodeURIComponent(ids.slice(0, 500).join(',')));
    }

    var line = document.querySelector('.marks-line');
    if (line) {
      line.hidden = passedHere === 0;
      line.innerHTML = passedHere ? ' &middot; <button type="button" class="linkish" data-act="show-passed">' + passedHere + ' passed, ' + (showPassed ? 'shown dimmed' : 'hidden') + '</button>' : '';
    }
    var toggle = form.querySelector('.shortlist-toggle');
    var total = Object.keys(m.shortlist).length;
    if (toggle) {
      toggle.hidden = !marks.available || total === 0;
      toggle.setAttribute('aria-pressed', onlyShortlisted ? 'true' : 'false');
      toggle.textContent = onlyShortlisted ? 'Showing ' + shortlistedHere + ' shortlisted · show all' : 'Show shortlisted only (' + shortlistedHere + ' here, ' + total + ' in all)';
    }
    var note = document.getElementById('device-note');
    if (note) {
      var size = marks.size(m);
      note.hidden = !marks.available && false;
      note.innerHTML = marks.available
        ? (size
            ? '<strong>' + Object.keys(m.shortlist).length + '</strong> shortlisted, <strong>' + Object.keys(m.seen).length + '</strong> seen, <strong>' + Object.keys(m.pass).length + '</strong> passed. '
            : 'Shortlist, seen and pass are kept as you work. ')
          + 'Stored in this browser on this device only &mdash; not synced, and not visible to anyone else, including whoever runs this site.'
          + (size ? ' <button type="button" class="linkish" data-act="clear-marks">Clear all ' + size + '</button>' : '')
        : 'This browser is not letting the page store anything, so shortlist, seen and pass are off.';
    }
  }
  document.addEventListener('click', function (event) {
    var target = event.target.closest ? event.target.closest('button') : null;
    if (!target) return;
    if (target.classList.contains('mark')) {
      var row = target.closest('li.company');
      if (row) { marks.toggle(target.getAttribute('data-mark'), row.getAttribute('data-id')); paint(); }
    } else if (target.getAttribute('data-act') === 'show-passed') {
      showPassed = !showPassed; paint();
    } else if (target.getAttribute('data-act') === 'clear-marks') {
      if (window.confirm('Clear every shortlist, seen and pass mark stored on this device?')) { marks.clear(); paint(); }
    } else if (target.classList.contains('shortlist-toggle')) {
      onlyShortlisted = !onlyShortlisted; paint();
    } else if (target.classList.contains('seen-toggle')) {
      hideSeen = !hideSeen;
      try { if (prefs) prefs.setItem('upstream.hideSeen', hideSeen ? '1' : '0'); } catch (e) {}
      paint();
    } else if (target.getAttribute('data-act') === 'only-new') {
      onlyNew = !onlyNew; paint();
    }
  });
  // Where a reader was, for the company page's way back.
  document.addEventListener('click', function (event) {
    var link = event.target.closest ? event.target.closest('li.company h3 a, #top-picks li a') : null;
    if (link) { remember(); }
  });

  // --- filters that apply as they change ---
  var timer = null;
  var sector = form.querySelector('#sector');
  var subsector = form.querySelector('#subsector');
  var slots = ['scope', 'top-picks', 'widgets', 'chips', 'result-line', 'filter-count', 'export', 'list', 'coverage', 'undated-slot'];
  var seq = 0;
  function refresh(opts) {
    var params = new URLSearchParams(new FormData(form));
    // Empty fields are defaults; the canonical url leaves them out and so does this.
    Array.from(params.keys()).forEach(function (k) { if (!params.get(k)) params.delete(k); });
    load(form.getAttribute('action').split('#')[0] + '?' + params.toString(), opts);
  }
  // One way to change the view, whether a control changed or a widget segment was picked:
  // fetch the page for that url, put its pieces in place, and make the controls say what
  // the server says the view is.
  // opts.history: 'push' (a filter the reader chose, so Back undoes it), 'replace' (typing in
  // search, one entry per pause would bury Back), 'none' (arriving from Back itself).
  // opts.reveal: bring the result line into view when the change happened out of sight.
  function load(url, opts) {
    opts = opts || {};
    var mine = ++seq;
    var listEl = document.getElementById('list');
    if (listEl) { listEl.classList.add('loading'); listEl.setAttribute('aria-busy', 'true'); }
    fetch(url.split('#')[0], { headers: { accept: 'text/html' } })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        if (mine !== seq) return;
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var mapOpen = document.querySelector('.map-fold') && document.querySelector('.map-fold').open;
        var moreOpen = document.querySelector('.more-places') && document.querySelector('.more-places').open;
        slots.forEach(function (id) {
          var now = document.getElementById(id), next = doc.getElementById(id);
          if (now && next) now.replaceWith(next);
        });
        var more = document.querySelector('.more-places');
        if (more && moreOpen) more.open = true;
        var fields = form.querySelectorAll('select[name], input[name]');
        for (var i = 0; i < fields.length; i++) {
          var mine2 = fields[i], theirs = doc.querySelector('#controls [name="' + mine2.name + '"]');
          if (theirs && !(mine2 === document.activeElement && mine2.id === 'q')) mine2.value = theirs.value;
        }
        var fold = document.querySelector('.map-fold');
        if (fold && mapOpen) fold.open = true;
        var canonical = doc.querySelector('link[rel=canonical]');
        if (canonical) {
          var target = canonical.getAttribute('href');
          if (opts.history === 'push' && target !== location.pathname + location.search) history.pushState({ upstream: true }, '', target);
          else if (opts.history !== 'none') history.replaceState({ upstream: true }, '', target);
          var own = document.querySelector('link[rel=canonical]');
          if (own) own.setAttribute('href', canonical.getAttribute('href'));
        }
        remember();
        paint();
        if (opts.reveal) {
          var line = document.getElementById('result-line');
          var top = line ? line.getBoundingClientRect().top : 0;
          if (line && (top < 0 || top > window.innerHeight * 0.6)) {
            var smooth = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
            form.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
          }
        }
      })
      .catch(function (error) { if (window.console) console.error(error); location.href = url; })
      .then(function () {
        var l = document.getElementById('list');
        if (l) { l.classList.remove('loading'); l.removeAttribute('aria-busy'); }
      });
  }
  // Back and Forward step through the filters the reader chose.
  window.addEventListener('popstate', function () { clearTimeout(timer); load(location.pathname + location.search, { history: 'none' }); });
  document.addEventListener('click', function (event) {
    var link = event.target.closest ? event.target.closest('#widgets a.seg, #coverage a.cell, #coverage a.sector-link') : null;
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    clearTimeout(timer);
    load(link.getAttribute('href'), { history: 'push', reveal: true });
  });
  form.addEventListener('input', function (event) {
    if (event.target.id !== 'q') return;
    clearTimeout(timer);
    // Each pause in typing is a full page render on the server: wait for a word, not a letter.
    var typed = event.target.value.trim();
    if (typed.length > 0 && typed.length < 3) return;
    timer = setTimeout(function () { refresh({ history: 'replace' }); }, 450);
  });
  form.addEventListener('change', function (event) {
    // A sub-sector belongs to one sector; choosing a different sector drops it, and
    // choosing a sub-sector brings its sector along.
    if (event.target === sector && subsector && subsector.value) {
      var chosen = subsector.options[subsector.selectedIndex];
      if (sector.value && chosen.getAttribute('data-sector') !== sector.value) subsector.value = '';
    }
    if (event.target === subsector && sector && subsector.value) {
      sector.value = subsector.options[subsector.selectedIndex].getAttribute('data-sector') || sector.value;
    }
    if (event.target.id === 'q') return;
    refresh({ history: 'push' });
  });
  form.addEventListener('submit', function (event) { event.preventDefault(); clearTimeout(timer); refresh({ history: 'push', reveal: true }); });
  // A chip removed, or a link inside the list's own counts, changes the view in place too.
  document.addEventListener('click', function (event) {
    var link = event.target.closest ? event.target.closest('#chips a, #result-line a[href^="/"], .empty .ways a, #top-picks a.see-all-none') : null;
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    clearTimeout(timer);
    load(link.getAttribute('href'), { history: 'push' });
  });

  // --- the keyboard: / to search, j and k (or the arrows) through rows, Enter opens ---
  document.addEventListener('keydown', function (event) {
    var el = document.activeElement;
    var typing = el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === '/' && !typing) {
      var q = document.getElementById('q');
      if (q) { event.preventDefault(); q.focus(); q.select(); }
      return;
    }
    if (typing) return;
    var down = event.key === 'j' || event.key === 'ArrowDown';
    var up = event.key === 'k' || event.key === 'ArrowUp';
    if (!down && !up) return;
    var links = Array.prototype.filter.call(document.querySelectorAll('li.company h3 a'), function (a) { return a.offsetParent !== null; });
    if (!links.length) return;
    var current = el && el.closest ? el.closest('li.company') : null;
    var index = current ? links.indexOf(current.querySelector('h3 a')) : -1;
    // Arrows scroll the page as usual until a row has focus; j and k always move.
    if (index === -1 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) return;
    event.preventDefault();
    var next = links[Math.max(0, Math.min(links.length - 1, index + (down ? 1 : -1)))];
    next.focus();
    next.closest('li.company').scrollIntoView({ block: 'nearest' });
  });
  var menu = form.querySelector('.filter-menu');
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && menu) menu.open = false; });
  document.addEventListener('click', function (event) { if (menu && menu.open && !menu.contains(event.target)) menu.open = false; });

  // Once the bar is pinned, the counts and chips under it stop riding along: on a phone they
  // took a quarter of the screen. They are back the moment the reader returns to the top.
  if ('IntersectionObserver' in window) {
    var sentinel = document.createElement('div');
    sentinel.setAttribute('aria-hidden', 'true');
    form.parentNode.insertBefore(sentinel, form);
    new IntersectionObserver(function (entries) {
      // Stuck only once the bar has scrolled past its place, not while it is still below the screen.
      form.classList.toggle('stuck', !entries[0].isIntersecting && entries[0].boundingClientRect.top < 0);
    }).observe(sentinel);
  }

  // On a phone the map folds to its five sectors, keeping open the one a filter is in.
  // The fold itself is CSS, so nothing moves after the first paint; a tap on a sector's
  // summary (not its link) unfolds it.
  document.addEventListener('click', function (event) {
    var summary = event.target.closest ? event.target.closest('#coverage details.sector > summary') : null;
    if (!summary || event.target.closest('a') || !window.matchMedia || !window.matchMedia('(max-width: 34rem)').matches) return;
    event.preventDefault();
    summary.parentNode.classList.toggle('unfolded');
  });

  // A link into the reference half opens the section that holds its target.
  function openFor(hash) {
    if (!hash || hash.length < 2) return;
    var el = document.getElementById(hash.slice(1));
    var box = el && el.closest ? el.closest('details') : null;
    if (box && !box.open) { box.open = true; el.scrollIntoView(); }
  }
  window.addEventListener('hashchange', function () { openFor(location.hash); });
  openFor(location.hash);

  paint();
})();
`;

/**
 * The question box. Everything the server sends is put on the page as text, never as
 * markup: the answer is model output about scraped names, and either could carry tags.
 * A link is followed only if it points back into this site.
 */
export const ASK_SCRIPT = `
(function () {
  var form = document.getElementById('ask-form');
  var out = document.getElementById('ask-out');
  if (!form || !out || !window.fetch) return;
  var input = form.querySelector('input');
  var button = form.querySelector('button');
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function evidence(ev) {
    var box = el('p', 'ask-evidence');
    box.appendChild(el('span', 'ask-basis', ev.summary));
    if (ev.view_url && ev.view_url.indexOf('/upstream?') === 0) {
      box.appendChild(document.createTextNode(' '));
      var a = el('a', 'ask-view', ev.count === 1 ? 'Show this record' : 'Show these ' + ev.count + ' records');
      a.href = ev.view_url + '#list';
      box.appendChild(a);
    }
    return box;
  }
  function render(data) {
    out.textContent = '';
    if (data.status === 'answered') {
      out.appendChild(el('p', 'ask-answer', data.answer));
      out.appendChild(evidence(data.evidence));
    } else if (data.status === 'resting') {
      out.appendChild(el('p', 'ask-resting', data.message));
      var list = el('ul', 'ask-examples');
      (data.examples || []).forEach(function (ex) {
        var li = el('li');
        li.appendChild(el('p', 'ask-q', ex.question));
        li.appendChild(el('p', 'ask-answer', ex.answer));
        li.appendChild(evidence(ex.evidence));
        list.appendChild(li);
      });
      out.appendChild(list);
    } else {
      out.appendChild(el('p', 'ask-resting', data.message || 'Type a question about the companies on this page.'));
    }
  }
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var question = input.value.trim();
    if (!question) return;
    button.disabled = true;
    out.textContent = '';
    out.appendChild(el('p', 'ask-wait', 'Looking it up…'));
    fetch(form.getAttribute('action'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: question }) })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () { render({ status: 'invalid', message: 'The question could not be sent. Try again in a moment.' }); })
      .then(function () { button.disabled = false; });
  });
})();
`;

/**
 * The company page: copy the brief, mark it, and go back to the results it came from.
 */
export const DETAIL_SCRIPT = `
(function () {
  var marks = window.upstreamMarks;
  var id = document.body.getAttribute('data-company');

  var back = document.querySelector('a.back');
  try {
    var from = sessionStorage.getItem('upstream.results');
    if (back && from) { back.setAttribute('href', from + '#c-' + id); back.textContent = '← Back to results'; }
  } catch (e) {}

  var copy = document.querySelector('button.copy-brief');
  var brief = document.getElementById('brief-text');
  if (copy && brief) {
    copy.hidden = false;
    copy.addEventListener('click', function () {
      var text = brief.value;
      var done = function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy brief'; }, 1600); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { brief.parentNode.open = true; brief.select(); });
      } else { brief.parentNode.open = true; brief.select(); }
    });
  }

  if (!marks || !marks.available) return;
  // Opening a company is looking at it: the list dims it, and "Hide seen" can take it away.
  marks.set('seen', id);
  var buttons = document.querySelectorAll('button.mark');
  function paint() {
    var m = marks.read();
    for (var i = 0; i < buttons.length; i++) {
      var kind = buttons[i].getAttribute('data-mark');
      buttons[i].hidden = false;
      buttons[i].setAttribute('aria-pressed', m[kind][id] ? 'true' : 'false');
    }
    var note = document.getElementById('device-note');
    if (note) note.hidden = false;
  }
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function (event) { marks.toggle(event.currentTarget.getAttribute('data-mark'), id); paint(); });
  }
  paint();
})();
`;

// --- the page ---------------------------------------------------------------

/**
 * The second half: how the list is built and what it leaves out. For the reader judging the
 * system rather than using it, so it is collapsed, labelled, and kept apart from the tool.
 */
function reference(view: PageView): string {
	const fresh =
		view.discoveredThisWeek > 0
			? `<p class="note">${view.discoveredThisWeek} ${view.discoveredThisWeek === 1 ? 'company' : 'companies'} turned up in the last seven days in a source we were already watching. A new source&rsquo;s first read is not counted here.</p>`
			: '';
	return `
<section class="reference" id="reference" aria-labelledby="reference-h">
  <h2 id="reference-h">Reference</h2>
  <p class="note">How this list is built and what it leaves out &mdash; for judging the system rather than using it.</p>
  <details class="ref"><summary>What the records show</summary>${findingsSection(view)}</details>
  <details class="ref"><summary>Freshness, and how many records reach the list</summary>${freshness(view)}${fresh}${funnelNote(view)}</details>
  <details class="ref"${view.subsector ? '' : ''}><summary>Records outside the map</summary>${offMap(view)}</details>
  <details class="ref"><summary>How the list is ranked, and its limits</summary>${methodology(view)}</details>
</section>`;
}

export function renderPage(view: PageView): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upstream &mdash; Indian deep tech, ranked by obscurity</title>
<meta name="description" content="Every other list ranks by how impressive a company looks, which is why every fund keeps finding the same twenty names. ${view.tracked} early-stage Indian deep-tech companies, sorted by obscurity, with the evidence on every row.">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/upstream/favicon.svg" type="image/svg+xml">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fbfaf8">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#141310">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Upstream">
<meta property="og:title" content="Upstream — Indian deep tech, ranked by obscurity">
<meta property="og:description" content="Indian deep-tech companies that say what they build, sorted so the least-noticed come first, with the evidence on every row.">
<meta property="og:url" content="${esc(`${view.origin}${BASE_PATH}`)}">
<meta property="og:image" content="${esc(`${view.origin}${BASE_PATH}/og.png`)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<!-- The same list is reachable by several orderings of the same parameters, and by
     parameters sitting at their defaults. This is the one spelling of it. -->
<link rel="canonical" href="${esc(`${BASE_PATH}${query(viewParams(view))}`)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600&display=optional">
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
${header(view)}
${coverageMap(view)}
${widgets(view)}
${askBox(view)}
<main class="tool">
${controls(view)}
<p class="device-note" id="device-note" hidden></p>
${list(view)}
<div id="undated-slot">${undatedList(view)}</div>
</main>
${reference(view)}
</div>
<script>${MARKS_SCRIPT}</script>
<script>${LIST_SCRIPT}</script>
${view.ask ? `<script>${ASK_SCRIPT}</script>` : ''}
</body>
</html>`;
}
