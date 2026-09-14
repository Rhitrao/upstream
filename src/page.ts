/**
 * The page. Server-rendered from a template string — no React, no build step, no
 * framework. This is a list of text and it has to load instantly on a phone, which is
 * where a shared link gets opened.
 *
 * The only JavaScript on the page submits the filter form on change. Everything works
 * without it: the filters are a GET form and every coverage cell is a link.
 */
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
	REGISTER_LABEL_PREFIX,
	TRACE_BUCKETS,
	DESCRIBED_STATES,
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
	described: DescribedState | null;
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
	dpiit: 'DPIIT recognition',
	incubator: 'incubator listing',
	grant: 'grant award',
	press: 'press mention',
	patent: 'patent filing',
	incorporation: 'incorporated',
	website: 'website seen',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "25 Aug 2023" — a date a reader can place without arithmetic. */
function shortDate(iso: string): string {
	const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
	return d && m ? `${d} ${MONTHS[m - 1]} ${y}` : String(y);
}

/**
 * The oldest dated thing a source says about the company, named: "DPIIT recognition
 * 25 Aug 2023". Null when no source dates anything.
 */
function sourceEvent(company: Company): { label: string; date: string } | null {
	const dated = company.signals.filter((s) => s.date && s.date.length >= 10).sort((a, b) => (a.date! < b.date! ? -1 : 1));
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
function proposition(tracked: number, notCompanies = 0): string {
	// Aishwarya Dasare is a researcher with a funded project, not a company, and the
	// headline counted her as one. The ones that are not companies are named as such.
	if (notCompanies === 0) return `${tracked} Indian deep-tech companies, sorted by obscurity.`;
	return `${tracked - notCompanies} Indian deep-tech companies and ${notCompanies} research projects, sorted by obscurity.`;
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
	const placesMeta = `${under ? 'Only ' : ''}<strong>${p.located} of ${t.places}</strong> have a location${
		p.dated ? `, and ${datedUnder && !under ? 'only ' : ''}<strong>${p.datedLocated} of the ${p.dated}</strong> dated ${p.dated === 1 ? 'row does' : 'rows do'}` : ''
	}.${under || datedUnder ? ' The tiles lean to wherever the DPIIT register, which gives a state, has companies.' : ''}`;
	const chosen = view.state && view.state !== 'unknown' ? p.states.find((s) => s.state === view.state) : undefined;
	const places = `
  <div class="widget widget-places" aria-labelledby="w-places">
    ${head('w-places', 'Where they are', placesMeta)}
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
				? `<p class="districts">In ${esc(chosen.state)}, as the sources write it: ${chosen.districts.map((d) => `${esc(d.name)} <span class="n">${d.n}</span>`).join(' &middot; ')}</p>`
				: ''
		}
  </div>`;

	// RDI sunrise sector.
	const inFive = w.sectors.reduce((n, s) => n + s.n, 0);
	const sectors = `
  <div class="widget" aria-labelledby="w-sectors">
    ${head('w-sectors', 'RDI sunrise sector', `<strong>${inFive} of ${t.sectors}</strong> placed in the scheme's five${w.offSectors ? `; ${w.offSectors} in none of them` : ''}.`)}
    <div class="grid seg-grid">
      ${w.sectors
				.map((s) => {
					const group = SUNRISE_SECTORS.find((g) => g.sector_id === s.sector_id);
					const on = view.sector === s.sector_id;
					// A sector chosen here replaces a sub-sector in another one.
					const href = `${BASE_PATH}${query(viewParams(view, { sector: on ? null : s.sector_id, subsector: null }))}#widgets`;
					const classes = ['cell', 'seg', s.n > 0 ? 'filled' : 'empty', on ? 'active' : ''].filter(Boolean).join(' ');
					return `<a class="${classes}" href="${esc(href)}" title="${esc(`${s.sector_id} ${group?.sector ?? ''}: ${s.n}`)}"${on ? ' aria-current="true"' : ''}>
        <span class="cell-head"><span class="cell-id">${sectorIcon(s.sector_id)}${esc(s.sector_id)}</span><span class="cell-n">${s.n}</span></span>
        <span class="cell-name">${esc(group?.sector ?? '')}</span>
        <span class="share" style="width:${share(s.n, t.sectors)}%" aria-hidden="true"></span>
      </a>`;
				})
				.join('\n      ')}
    </div>
  </div>`;

	// Public traces: the thesis, drawn.
	const traces = `
  <div class="widget" aria-labelledby="w-traces">
    ${head('w-traces', 'Public traces', `<strong>${w.traces['1']} of ${t.traces}</strong> have one or none. The list sorts the fewest first.`)}
    <div class="grid seg-grid">
      ${TRACE_BUCKETS.map((b) => cell({ key: 'traces', value: b, n: w.traces[b], of: t.traces, name: TRACE_LABELS[b].toLowerCase(), id: b === '3+' ? '3+' : b === '1' ? '≤1' : '2' })).join('\n      ')}
    </div>
  </div>`;

	// What they build, and on whose word.
	const sentence = w.described.own + w.described.source;
	const described = `
  <div class="widget" aria-labelledby="w-described">
    ${head(
			'w-described',
			'What they build',
			`<strong>${t.described - sentence} of ${t.described}</strong> have no sentence saying so${
				w.described.label === t.described - sentence && w.described.label
					? ", only the DPIIT register's dropdown label"
					: w.described.label
						? `: ${w.described.label} carry only the DPIIT register's dropdown label`
						: ''
			}.`,
		)}
    <div class="grid seg-grid">
      ${DESCRIBED_STATES.filter((k) => k !== 'none' || w.described.none > 0 || view.described === 'none')
				.map((k) => cell({ key: 'described', value: k, n: w.described[k], of: t.described, name: DESCRIBED_LABELS[k].toLowerCase(), classes: k === 'label' || k === 'none' ? ['weak-seg'] : [] }))
				.join('\n      ')}
    </div>
  </div>`;

	// Sources, and when each last worked.
	const health = new Map(view.sourceHealth.map((h) => [h.source, h]));
	const sources = `
  <div class="widget" aria-labelledby="w-sources">
    ${head('w-sources', 'Sources', 'Records each lists, and its last successful check. A company two sources list counts under both.')}
    <div class="grid seg-grid source-grid">
      ${w.sources
				.map((src) => {
					const h = health.get(src.source);
					const checked = h?.last_success ? `checked ${shortDate(h.last_success.slice(0, 10))}` : 'no successful check yet';
					const failing = h && h.last_status !== 'ok' ? ` <strong class="failing">${h.last_status === 'failed' ? 'failed' : 'set aside'} ${shortDate(h.last_attempt.slice(0, 10))}</strong>` : '';
					const name = SOURCE_LABELS[src.source] ?? src.source;
					return cell({ key: 'source', value: src.source, n: src.n, of: t.sources, name, title: `${name}: ${src.n} records, ${checked}`, extra: `<span class="cell-when">${esc(checked)}${failing}</span>` });
				})
				.join('\n      ')}
    </div>
  </div>`;

	return `
<section class="widgets" id="widgets" aria-label="The records in view, counted">
  ${places}
  <div class="widget-row">
  ${sectors}
  ${traces}
  ${described}
  ${sources}
  </div>
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
  <h1>${esc(proposition(tracked, view.notCompanies))}</h1>
  <p class="hook">${hook(tracked, oneTrace)}</p>
  <dl class="stats">
    <div><dt>Companies</dt><dd>${tracked - view.notCompanies}</dd></div>
    ${view.notCompanies > 0 ? `<div><dt>Projects, not companies</dt><dd>${view.notCompanies}</dd></div>` : ''}
    <div><dt>One public trace at most</dt><dd>${oneTrace}</dd></div>
    <div><dt>Sub-sectors still empty</dt><dd>${empty}<span class="of">/${coverage.subsector_count}</span></dd></div>
  </dl>
  ${
		// Only when there is something to report. A liveness line that reads "0
		// discovered in the last seven days" every day until the first discovery lands
		// says the machine is broken, which is not what it means.
		//
		// Not "added to Upstream": each company page uses that for the day its row was
		// written, and a new source's first read writes dozens of rows that are not finds.
		discoveredThisWeek > 0
			? `<p class="fresh">${discoveredThisWeek} ${discoveredThisWeek === 1 ? 'company' : 'companies'} turned up in the last seven days in a source we were already watching. A new source's first read is not counted here.</p>`
			: ''
	}
  ${freshness(view)}
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

	// After the list and folded: the map is the argument, not the interface, and open it
	// put forty-four cells between a reader and the first company. It opens by itself
	// when a cell is the filter in use, so the chosen cell is never hidden.
	return `
<section class="coverage" id="coverage" aria-labelledby="coverage-h">
  <details class="map-fold"${subsector ? ' open' : ''}>
    <summary>
      <h2 id="coverage-h">Coverage map</h2>
      <span class="map-fold-meta">${coverage.covered} of ${coverage.subsector_count} sub-sectors have companies</span>
    </summary>
    <p class="note">All ${coverage.subsector_count} sunrise sub-sectors of the RDI scheme. An outlined cell is one we have
      found nothing in yet &mdash; our blind spot, not proof the sector is empty. Pick a cell to filter the list; the counts
      include the companies the list sets aside as old or undated.</p>
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
		state: view.state,
		traces: view.traces,
		described: view.described,
		sort: view.sort === 'obscurity' ? null : view.sort,
		dates: view.dates === 'both' ? null : view.dates,
		tier: view.tier === view.defaultTier ? null : view.tier,
		age: view.age === 'recent' ? null : view.age,
		...overrides,
	};
}

/** The labels for the sources, since the ids are not written for reading. */
const SOURCE_LABELS: Record<string, string> = {
	'sine-iitb': 'SINE IIT Bombay',
	'rtbi-iitm': 'IIT Madras RTBI',
	'grants-csv': 'Government grants',
	'dpiit-startup-india': 'DPIIT register',
	'venture-center': 'Venture Center',
};

const SORT_LABELS: Record<SortChoice, string> = {
	obscurity: 'Obscurity',
	quietest: 'Fewest traces',
	newest: 'Newest on record',
	name: 'Name',
};

const TIER_LABELS: Record<TierChoice, string> = { a: 'A only', ab: 'A + B', all: 'Everything' };
const DATES_LABELS: Record<PageView['dates'], string> = { both: 'Dated and undated', dated: 'Dated only', undated: 'Undated only' };
const SITE_LABELS: Record<SiteState, string> = { has: 'Has a website', none: 'No website' };
const AGE_LABELS: Record<AgeChoice, string> = { recent: `Last ${MAX_AGE_YEARS} years`, all: 'Every year' };
const TRACE_LABELS: Record<TraceBucket, string> = { '1': 'One or none', '2': 'Two', '3+': 'Three or more' };
const DESCRIBED_LABELS: Record<DescribedState, string> = {
	own: 'Their own homepage says',
	source: 'A source describes it',
	label: 'Register label only',
	none: 'Nothing at all',
};

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
		['described', view.described ? `What it builds: ${DESCRIBED_LABELS[view.described].toLowerCase()}` : null],
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
	const universe = view.demo ? b.total : Math.max(view.tracked, b.total);
	const shown = view.dates === 'undated' ? b.undated : b.ranked;
	const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
	const parts: string[] = [];

	const byFilters = universe - b.total;
	if (byFilters > 0) {
		const cleared = `${BASE_PATH}${query({ sort: view.sort === 'obscurity' ? null : view.sort, tier: view.tier === view.defaultTier ? null : view.tier, age: view.age === 'recent' ? null : view.age })}#list`;
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
		parts.push(`<a href="${esc(everything)}" title="${esc(why.join('; '))}. Follow to show them.">${held} held back by tier or age</a>`);
	}

	if (view.dates === 'dated' && b.undated > 0) {
		parts.push(`<a href="${esc(`${BASE_PATH}${query(viewParams(view, { dates: null }))}#undated`)}" title="Records no source dates. Follow to list them below the map.">${b.undated} undated, hidden</a>`);
	} else if (view.dates !== 'undated' && b.undated > 0) {
		parts.push(`<a href="#undated" title="Records no source dates, so no tier can be claimed for them. Listed below the coverage map.">${b.undated} undated</a>`);
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
	const sortOptions = (Object.keys(SORTS) as SortChoice[]).map((v) => option(v, SORT_LABELS[v], sort)).join('');
	const traceOptions = [option('', 'Any number', view.traces ?? '')].concat(TRACE_BUCKETS.map((v) => option(v, TRACE_LABELS[v], view.traces ?? ''))).join('');
	const describedOptions = [option('', 'Any', view.described ?? '')].concat(DESCRIBED_STATES.map((v) => option(v, DESCRIBED_LABELS[v], view.described ?? ''))).join('');
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
        ${field('sector', 'Sector', sectorOptions)}
        ${field('subsector', 'Sub-sector', subsectorOptions)}
        ${field('tier', 'Tier', tierOptions)}
        ${field('source', 'Found by', sourceOptions)}
        ${field('dates', 'Dates', datesOptions)}
        ${field('site', 'Website', siteOptions)}
        ${field('age', 'Started', ageOptions)}
        ${field('traces', 'Public traces', traceOptions)}
        ${field('described', 'What it builds', describedOptions)}
        <input type="hidden" id="state" name="state" value="${esc(view.state ?? '')}">
        <button type="submit" class="apply">Apply</button>
      </div>
    </details>
    <div class="field field-sort"><label for="sort" class="visually-hidden">Sort by</label><select id="sort" name="sort">${sortOptions}</select></div>
  </div>
  ${chips(view)}
  <div class="bar-foot">
    ${resultLine(view)}
    <span class="bar-links">
      <button type="button" class="linkish shortlist-toggle" hidden aria-pressed="false">Shortlisted only</button>
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
	// Emphasised only where it is the finding. At five traces it is just a number.
	return `<span class="traces${n <= 1 ? ' quiet' : ''}">${said}</span>`;
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

/** What a sub-sector placement rests on, in three words, for beside the placement. */
function basisTag(company: Company): string {
	return company.classify_basis === 'register-label'
		? ' <span class="basis-tag weak">register label only</span>'
		: ' <span class="basis-tag">from its description</span>';
}

/** Short names for evidence on a row, where there is room for one word each. */
const EVIDENCE_NAMES: Record<string, string> = {
	dpiit: 'DPIIT',
	incubator: 'incubator',
	grant: 'grant',
	press: 'press',
	patent: 'patent',
	incorporation: 'incorporation',
	website: 'website live',
};

/** What the source's own date says happened, in the words a row has room for. */
const EVENT_VERBS: Record<string, string> = {
	dpiit: 'DPIIT recognised',
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
	return Boolean(company.description && !company.description.startsWith(REGISTER_LABEL_PREFIX));
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
 * The source's date for a row, named for what happened: "DPIIT recognised Aug 2023".
 * Null when no source dates anything.
 */
function eventPhrase(company: Company): string | null {
	const dated = company.signals.filter((s) => s.date && s.date.length >= 10).sort((a, b) => (a.date! < b.date! ? -1 : 1));
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
function companyRow(company: Company, now: Date): string {
	const sub = company.subsector_id ? SUBSECTOR_BY_ID.get(company.subsector_id) : undefined;
	const builds = buildsLine(company);
	const dated = company.first_seen !== null;

	// An address nothing ties to the company is not linked from its row: for Grinntech
	// it was HyperVerge's. The address and the reason stay on the company's page.
	const site = company.website_identity === 'discovered' ? null : safeUrl(company.website);
	const siteState = site ? (company.website_identity === 'verified' ? 'verified' : 'unconfirmed') : company.website_checked ? 'none' : 'unknown';

	// What the placement rests on, beside it: a sub-sector read off "Industry: Robotics"
	// is a weaker claim than one read off a paragraph about the product.
	const placement = sub
		? `<a class="rdi" href="${esc(query({ subsector: sub.subsector_id }))}">${esc(sub.subsector_id)} ${esc(sub.subsector)}</a>${
				company.classify_basis === 'register-label' ? ' <span class="basis-tag weak">register label only</span>' : ''
			}`
		: '<span class="rdi unclassified">not yet classified</span>';

	// Evidence as links to where it was published. A website counts only once it is
	// confirmed as theirs; before that the row says so rather than linking it as theirs.
	const evidence = company.signals
		.filter((signal) => signal.type !== 'website')
		.map((signal) => {
			const href = safeUrl(signal.url);
			const name = esc(EVIDENCE_NAMES[signal.type] ?? signal.type);
			const title = esc(`${signal.label}${signal.date ? `, ${signal.date}` : ''}`);
			return href
				? `<a class="ev" href="${esc(href)}" rel="noopener nofollow" title="${title}">${name}</a>`
				: `<span class="ev" title="${title}">${name}</span>`;
		});
	if (siteState === 'verified') evidence.push(`<a class="ev ev-site" href="${esc(site!)}" rel="noopener nofollow">website</a>`);
	if (siteState === 'unconfirmed') {
		evidence.push(`<a class="ev ev-site unconfirmed" href="${esc(site!)}" rel="noopener nofollow">website not confirmed as theirs</a>`);
	}
	// Only where a source that publishes websites went looking. On this list the absence
	// is the finding, which is why it keeps the page's one yellow.
	if (siteState === 'none') evidence.push('<span class="fact-none">no website</span>');

	// How old: the source's dated event, whether anyone says when it started, and when
	// this list first wrote it down. Three facts, never merged into one "first seen".
	const event = eventPhrase(company);
	const age = ageKnown(company) ? `started ${company.origin_year ?? company.founded_year}` : 'founding year unknown';
	const when = [event ?? 'no dated event', age, `added to Upstream ${addedAgo(company.discovered, now)}`].map(esc).join(' &middot; ');
	const located = Boolean(company.city || company.state);
	const place = located ? esc([company.city, company.state].filter(Boolean).join(', ')) : 'location unknown';

	// Why it is in this view. Only A and B say anything a reader can act on; a column of
	// "Tier C" beside every row reads as a bug.
	const tier =
		company.tier === 'A'
			? '<span class="tier ta" title="Found by us under 90 days ago, nothing dated earlier, at most 2 public traces">Tier A</span>'
			: company.tier === 'B'
				? '<span class="tier tb" title="First seen under 180 days ago, at most 5 public traces">Tier B</span>'
				: '';

	const state = [builds.described ? 'described' : 'undescribed', dated ? 'dated' : 'undated', `site-${siteState}`].join(' ');

	// Anchored by slug so one row can be linked to, and so "back to results" lands on it.
	return `
  <li class="company ${state}" id="c-${esc(company.id)}" data-id="${esc(company.id)}">
    <div class="row-main">
      <h3><a href="${esc(`${BASE_PATH}/c/${company.id}`)}">${esc(company.name)}</a>${entityTag(company)}</h3>
      ${builds.html}
      <p class="meta">
        <span class="meta-rdi">${placement}</span>
        <span class="meta-ev">${evidence.join(' ') || '<span class="ev none">no evidence recorded</span>'}</span>
        <span class="meta-when${dated ? '' : ' undated'}">${when}</span>
        <span class="meta-where${located ? '' : ' unknown'}">${place}</span>
      </p>
    </div>
    <div class="row-side">
      ${traceLine(company)}
      ${tier}
      <span class="row-actions" hidden>
        <button type="button" class="mark" data-mark="shortlist" aria-pressed="false">Shortlist</button>
        <button type="button" class="mark" data-mark="seen" aria-pressed="false">Seen</button>
      </span>
    </div>
  </li>`;
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
	if (!view.backfillOnly || view.tracked === 0) return '';
	return `<p class="note">Nothing qualifies for Tier A or B today, so the list is showing everything. Those tiers take a
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
		// "Nothing matches" only when nothing does. A search whose one hit is undated
		// has a result, and saying otherwise above it is the page contradicting itself —
		// as is an empty list that does not say where its matches went.
		const undatedHere = view.dates !== 'dated' ? view.buckets.undated : 0;
		const empty =
			view.buckets.total > 0
				? undatedHere > 0
					? `<p class="empty">No dated match. <a href="#undated">${undatedHere} undated ${undatedHere === 1 ? 'match is' : 'matches are'} listed below the coverage map</a>.</p>`
					: ''
				: view.tracked === 0
					? '<p class="empty">Nothing matches yet. The ingest has not put anything here.</p>'
					: '<p class="empty">Nothing matches these filters.</p>';
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
    <a href="#undescribed">the register never said what they do</a>. DPIIT recognition publishes a company name and
    an industry the founder picked from a dropdown, and for these ${register.undescribed} that is the entire public
    record. Enough to know they exist; nothing like enough to say what they build. They are left unplaced rather than
    guessed at.</p>
  <p>This is the more interesting half. Of the ${register.total} records we took from the register, ${share}&nbsp;per&nbsp;cent
    are described too thinly for anyone to tell what they are &mdash; not too thinly for us in particular, too thinly
    for anyone reading them. That is a finding about those records, and only those: they are the newest few pages of
    each deep-tech industry filter, not a sample of the 473,000 companies the register holds, and nothing here says
    how the rest are described.</p>`;

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
  <p>Public sources only, nothing behind a login. Five are read today: three incubator portfolios
    (<a href="https://www.sineiitb.org/portfolio/" rel="noopener">SINE IIT Bombay</a>,
    <a href="https://rtbi.in/incubationiitm/portfolio.html" rel="noopener">IIT Madras RTBI</a> and
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
    incubator listing, a grant award, a DPIIT recognition and a website that answered when we fetched it. A domain that
    no longer resolves is not a trace, and stops being one the night it stops answering. A press mention ought to count
    as well; nothing collects it yet, so for now it does not, and the trace counts on this page are lower than they
    would be.</p>
  <ul class="rules">
    <li><span class="tier ta">Tier A</span> Added to Upstream by a run under 90 days ago, with no source dating anything about it earlier than 90 days ago, and at most 2 traces. New and quiet. Read these first.</li>
    <li><span class="tier tb">Tier B</span> First seen under 180 days ago, at most 5 traces. Early, some visibility.</li>
    <li><span class="tier tc">Tier C</span> Everything else. Known territory &mdash; listed, not promoted.</li>
  </ul>
  <p>Neither A nor B is open to a company whose only description is a register's dropdown label. That is enough to
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

  <h3>Two official classifications that do not meet</h3>
  <p>DPIIT's recognition register files every startup under its own industry vocabulary &mdash; 56 industries, chosen
    by the founder from a list when they applied. The RDI scheme has 44 sub-sectors, written by a different department
    for a different purpose. Neither was drawn up with the other in mind, and putting the same companies through both
    shows how little they overlap.</p>
  <p>Where the two vocabularies happen to have a near-twin, a company places almost automatically: left to the
    classifier on the run of 14 September 2026, DPIIT's &ldquo;Robotics&rdquo; against the scheme's &ldquo;Intelligent
    Systems &amp; Robotics&rdquo; placed 79 of 80. Where they have none, almost nothing placed: 3 of 87 for &ldquo;Computer
    Vision&rdquo;, 7 of 83 for &ldquo;AI&rdquo;. Same companies, same government, two filing systems that, as this
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
	if (!described) out.push('What it builds: no source describes it, and a register’s dropdown label is not a description');
	else if (!productKnown) out.push('What it says about itself: no homepage of theirs has been read');
	if (sub && !company.project_type) out.push(`What kind of product it is, within ${sub.subsector_id} ${sub.subsector}`);
	if (!ageKnown(company)) out.push('When it was founded: no source gives a founding or incubation year');
	if (!company.signals.some((s) => s.date && s.date.length >= 10) && company.first_seen_basis !== 'cohort') {
		out.push('When any source first recorded it: no source dates anything about it');
	}
	if (!company.city && !company.state) out.push('Where it is based');
	if (site && company.website_identity === 'discovered') out.push(`Its website: ${host} was given for it, and is not treated as theirs`);
	else if (site && company.website_identity !== 'verified') out.push(`Whether ${host} is its website: not confirmed as theirs`);
	else if (!site && !company.website_checked) out.push('Whether it has a website: no source that publishes websites lists it');
	if (!company.cin) out.push('Its company registration: no CIN on record, so no MCA filing is joined');
	out.push('Founders, funding and revenue: Upstream collects none of these');
	return out;
}

/** Where a brief says the website came from, in plain words. */
function siteLine(company: Company): string | null {
	const site = safeUrl(company.website);
	if (!site) return null;
	if (company.website_identity === 'verified') return `${site} (checked as theirs: ${company.website_identity_note ?? 'name matched'})`;
	if (company.website_identity === 'discovered') return `${site} was given for it and is NOT treated as theirs (${company.website_identity_note ?? 'nothing ties it to them'})`;
	return `${site} (not confirmed as theirs${company.website_identity_note ? `: ${company.website_identity_note}` : ''})`;
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
		lines.push(`**What it builds:** ${company.description} _(as a source described it)_`);
	} else {
		lines.push('**What it builds:** Unknown. No source describes it.');
		if (company.description) lines.push(`The only published line is a register label: ${company.description}`);
	}
	if (company.product && site && describedBySource(company)) {
		lines.push(`**As a source described it:** ${company.description}`);
	}

	const located = [company.city, company.state].filter(Boolean).join(', ');
	lines.push(
		`**Started:** ${ageKnown(company) ? String(company.origin_year ?? company.founded_year) : 'unknown'} · **Based:** ${located || 'unknown'} · **Public traces:** ${company.trace_count}`,
		'',
		'## Unknown',
		...unknowns(company).map((u) => `- ${u}`),
		'',
		'## Evidence',
	);
	for (const signal of company.signals) {
		const where = SOURCE_LABELS[signal.source ?? ''] ?? signal.type;
		lines.push(`- ${signal.label} — ${where}, ${signal.date ?? 'undated'}: ${safeUrl(signal.url) ?? 'no link published'}`);
	}
	const siteSaid = siteLine(company);
	if (siteSaid) lines.push(`- Website: ${siteSaid}`);

	lines.push('', '## Placement');
	if (sub) {
		lines.push(
			`- RDI ${sub.subsector_id} ${sub.subsector}, placed ${
				company.classify_basis === 'register-label' ? 'from a register label only, which supports nothing narrower' : 'from its description'
			}${company.project_type ? `; project type: ${company.project_type}` : ''}`,
		);
	} else {
		lines.push('- Not placed in any RDI sub-sector');
	}
	lines.push(`- Tier ${company.tier}`, '', `Upstream: ${pageUrl}`, `_Assembled from public records on ${shortDate(now.toISOString())} by a template. No person has checked it, and the placement is automated._`);
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
		return `The only thing any source says about what this company does is a register's dropdown label. That is
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

	const summary = productKnown
		? productDetail(company)
		: `<p class="unknown-value">Unknown</p>${productDetail(company)}`;
	const excerpt = company.description
		? !describedBySource(company)
			? `<p class="desc">${esc(company.description)}</p><p class="provenance">A register&rsquo;s dropdown choices, not a description. Nothing here says what the company makes.</p>`
			: `<p class="desc">${esc(company.description)}<span class="says">as the source described it</span></p>`
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
          <td class="mono">${signal.date ? esc(signal.date) : '<span class="no-link">not dated</span>'}</td>
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
<meta name="description" content="${esc(company.product ?? company.description ?? company.name)}">
<meta name="color-scheme" content="light dark">
<link rel="canonical" href="${esc(`${BASE_PATH}/c/${company.id}`)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap">
<style>${STYLES}</style>
</head>
<body data-company="${esc(company.id)}">
<div class="wrap detail">
  <p class="eyebrow"><a class="back" href="${esc(`${BASE_PATH}#c-${company.id}`)}">&larr; Upstream</a></p>

  <header class="masthead">
    <h1>${esc(company.name)}</h1>
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
    <div class="actions">
      <button type="button" class="action copy-brief" hidden>Copy brief</button>
      <button type="button" class="action mark" data-mark="shortlist" aria-pressed="false" hidden>Shortlist</button>
      <button type="button" class="action mark" data-mark="pass" aria-pressed="false" hidden>Pass</button>
    </div>
    <p class="device-note" id="device-note" hidden>Shortlist and pass are stored in this browser on this device only &mdash;
      not synced, and not visible to anyone else, including whoever runs this site.</p>
    <details class="brief-fold"><summary>The brief, as markdown</summary><textarea id="brief-text" readonly rows="16" spellcheck="false">${esc(brief)}</textarea></details>
  </header>

  <section>
    <h2>What they build</h2>
    <div class="builds-grid">
      <div><h3 class="mini">Summary</h3>${summary}</div>
      <div><h3 class="mini">Source excerpt</h3>${excerpt}</div>
    </div>
  </section>

  <section class="unknowns">
    <h2>What is not known</h2>
    <ul class="unknown-list">${unknownItems}</ul>
  </section>

  <section>
    <h2>Evidence</h2>
    <p class="provenance">Everything that put this company on the list, with the page it came from.</p>
    ${evidence}
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
    <h2>Classification</h2>
    ${
			sub
				? `<p class="rdi-full"><a href="${esc(`${BASE_PATH}${query({ subsector: sub.subsector_id })}`)}">${esc(sub.subsector_id)} &mdash; ${esc(sub.subsector)}</a></p>
      <p class="provenance basis">${
				company.classify_basis === 'register-label'
					? `<span class="basis-tag weak">register label only</span> The only thing placing it here is a register's industry label, picked by the founder from a fixed list. That supports this sub-sector and nothing narrower.`
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
  </section>

  <section>
    <h2>Tier ${esc(company.tier)}</h2>
    <p class="provenance">${whyTier(company)}</p>
  </section>
</div>
<script>${MARKS_SCRIPT}</script>
<script>${DETAIL_SCRIPT}</script>
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
  max-width: 66ch;
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
  flex: 0 0 auto;
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
  .row-side { flex-direction: row; align-items: center; flex-wrap: wrap; }
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
.builds { margin: 0 0 var(--s0h); max-width: 56ch; color: var(--ink); }
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
.result-summary { color: var(--muted); }
/* the widget row: the population in view, five ways, in the coverage map's cells */
.widgets { margin: calc(-1 * var(--s5)) 0 var(--s5); display: grid; gap: var(--s5); }
.widget { min-width: 0; border-top: 1px solid var(--rule); padding-top: var(--s3); }
.widget-head { margin: 0 0 var(--s2); }
.widget-head h2 { font-size: var(--t-micro); text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); font-weight: 500; margin: 0 0 var(--s1); }
.widget-meta { margin: 0; font-size: var(--t-xs); color: var(--muted); max-width: 60ch; }
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
.more-places { margin-top: var(--s1); }
.more-places > summary { cursor: pointer; font-size: var(--t-xs); color: var(--muted); }
.more-places > .grid { margin-top: var(--s1); }
.districts { font-size: var(--t-xs); color: var(--muted); margin: var(--s2) 0 0; }
.districts .n { font-family: var(--mono); color: var(--ink); }
/* the question box */
.ask { margin: 0 0 var(--s5); }
.ask-form label { display: block; font-size: var(--t-micro); text-transform: uppercase; letter-spacing: 0.1em; color: var(--muted); font-weight: 500; margin-bottom: var(--s1); }
.ask-bar { display: flex; gap: var(--s1); }
.ask-bar input { flex: 1 1 auto; min-width: 0; font: inherit; font-size: var(--t-sm); padding: var(--s2) var(--s3); border: 1px solid var(--rule-strong); border-radius: var(--radius); background: var(--raise); color: var(--ink); }
.ask-bar button { font: inherit; font-size: var(--t-sm); padding: var(--s2) var(--s4); border: 1px solid var(--ink); border-radius: var(--radius); background: var(--ink); color: var(--paper); cursor: pointer; }
.ask-bar button:disabled { opacity: 0.5; cursor: wait; }
.ask-note { font-size: var(--t-xs); color: var(--muted); margin: var(--s1) 0 0; max-width: 64ch; }
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
.method p, .method li { font-size: var(--t-sm); color: var(--muted); max-width: 56ch; }
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
  .cell, .chip, .apply, .company, select, .seg { transition: border-color 120ms ease, background 120ms ease; }
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
  var form = document.getElementById('controls');
  if (!form || !window.fetch || !window.DOMParser || !window.URLSearchParams) return;
  var marks = window.upstreamMarks;
  var apply = form.querySelector('.apply');
  if (apply) apply.hidden = true;

  // Where "back to results" should go: the view as it is now, canonical spelling.
  function remember() { try { sessionStorage.setItem('upstream.results', location.pathname + location.search); } catch (e) {} }
  remember();

  // --- marks on rows ---
  var showPassed = false;
  var onlyShortlisted = false;
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
    }
  });
  // Where a reader was, for the company page's way back.
  document.addEventListener('click', function (event) {
    var link = event.target.closest ? event.target.closest('li.company h3 a') : null;
    if (link) { remember(); }
  });

  // --- filters that apply as they change ---
  var timer = null;
  var sector = form.querySelector('#sector');
  var subsector = form.querySelector('#subsector');
  var slots = ['widgets', 'chips', 'result-line', 'filter-count', 'export', 'list', 'coverage', 'undated-slot'];
  var seq = 0;
  function refresh() {
    var params = new URLSearchParams(new FormData(form));
    // Empty fields are defaults; the canonical url leaves them out and so does this.
    Array.from(params.keys()).forEach(function (k) { if (!params.get(k)) params.delete(k); });
    load(form.getAttribute('action').split('#')[0] + '?' + params.toString());
  }
  // One way to change the view, whether a control changed or a widget segment was picked:
  // fetch the page for that url, put its pieces in place, and make the controls say what
  // the server says the view is.
  function load(url) {
    var mine = ++seq;
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
          history.replaceState(null, '', canonical.getAttribute('href'));
          var own = document.querySelector('link[rel=canonical]');
          if (own) own.setAttribute('href', canonical.getAttribute('href'));
        }
        remember();
        paint();
      })
      .catch(function () { location.href = url; });
  }
  document.addEventListener('click', function (event) {
    var link = event.target.closest ? event.target.closest('#widgets a.seg') : null;
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    clearTimeout(timer);
    load(link.getAttribute('href'));
  });
  form.addEventListener('input', function (event) {
    if (event.target.id !== 'q') return;
    clearTimeout(timer);
    timer = setTimeout(refresh, 250);
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
    refresh();
  });
  form.addEventListener('submit', function (event) { event.preventDefault(); clearTimeout(timer); refresh(); });
  var menu = form.querySelector('.filter-menu');
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && menu) menu.open = false; });
  document.addEventListener('click', function (event) { if (menu && menu.open && !menu.contains(event.target)) menu.open = false; });

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
${widgets(view)}
${askBox(view)}
<main class="tool">
${controls(view)}
<p class="device-note" id="device-note" hidden></p>
${list(view)}
</main>
${coverageMap(view)}
<div id="undated-slot">${undatedList(view)}</div>
${offMap(view)}
${methodology(view)}
</div>
<script>${MARKS_SCRIPT}</script>
<script>${LIST_SCRIPT}</script>
${view.ask ? `<script>${ASK_SCRIPT}</script>` : ''}
</body>
</html>`;
}
