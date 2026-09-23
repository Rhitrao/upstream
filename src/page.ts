/**
 * The page. Server-rendered from a template string — no React, no build step, no
 * framework. This is a list of text and it has to load instantly on a phone, which is
 * where a shared link gets opened.
 *
 * The only JavaScript on the page submits the filter form on change. Everything works
 * without it: the filters are a GET form and every coverage cell is a link.
 */
import { SNAPSHOT, SNAPSHOT_TERMS } from './snapshot';
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
	/** The ones that reached a cell on the coverage map. */
	tracked: number;
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
	/** The shortlist a reader asked to see, by id; null for every other view. */
	ids?: string[] | null;
	/** '2' or '3' when narrowed to companies in at least that many public programmes; alone '1' for no other trace. */
	programmes?: string | null;
	alone?: string | null;
	/** This site's origin, for the absolute links a copied brief carries. */
	origin: string;
	/** Records in the chosen half (described, kind, register status) before any other filter. */
	category: number;
	/** When the list is empty: how many records match the same search and filters in every half, tier and year. */
	wider?: number | null;
	/** When a search finds nothing anywhere: the names closest to what was typed. */
	suggestions?: { id: string; name: string }[];
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

/** What the coverage and methodology page is drawn from: the whole database, no filters. */
export interface AboutView {
	coverage: Coverage;
	/** Companies the taxonomy has no cell for, grouped by the hole they fell through. */
	gaps: Gaps;
	/** Every company the pipeline holds: placed plus off-map. The top of the funnel. */
	found: number;
	/** The ones that reached a cell on the coverage map. */
	tracked: number;
	/** Each source's last attempt and last good run. Empty until a run has reported. */
	sourceHealth: SourceHealth[];
	/** The numbers behind the findings. null for the sample data. */
	findings: Findings | null;
	/** What became of the register's companies, for the methodology's own arithmetic. */
	register: RegisterOutcomes;
	/** What came of reading company websites — including every way it failed. */
	products: ProductOutcomes;
	discoveredThisWeek: number;
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
function funnelNote(view: AboutView): string {
	const { gaps, found, tracked } = view;
	if (gaps.total === 0) return '';
	const parts: string[] = [];
	if (gaps.taxonomy.total > 0) {
		parts.push(`<a href="#off-map">${gaps.taxonomy.total}</a> were not mapped to any sub-sector under the current taxonomy and classifier`);
	}
	if (gaps.undescribed.total > 0) {
		parts.push(`<a href="#undescribed">${gaps.undescribed.total}</a> we could not describe well enough to place`);
	}
	return `<p class="funnel-note">${found} companies have reached this pipeline and ${tracked} are on the RDI coverage map.
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
function freshness(view: AboutView): string {
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
 * The three breakdowns that sit beside the RDI map: technology type, application and source.
 *
 * Each row is a count of the records in view under every other filter (leaving out the
 * panel's own), and a link to the view it names: clicking it applies that filter, clicking the
 * chosen row again takes it away. The chosen row is marked, so the panels and the filter
 * controls always say the same thing. Always open: no fold, no "show more".
 *
 * No deltas, anywhere. The data has days of history.
 */
function panels(view: PageView): string {
	const w = view.widgets;
	if (!w) return '';
	const t = w.totals;
	const share = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 : 0);
	const row = (opts: { key: 'build' | 'domain' | 'source'; value: string; n: number; of: number; name: string; title?: string; extra?: string }) => {
		const on = view[opts.key] === opts.value;
		const href = `${BASE_PATH}${query(viewParams(view, { [opts.key]: on ? null : opts.value }))}#list`;
		// A row that would lead to an empty list is said, not offered, unless it is the one chosen.
		if (opts.n === 0 && !on) {
			return `<li class="brow zero" title="${esc(`${opts.name}: none in this view`)}"><span class="brow-name">${esc(opts.name)}</span>${opts.extra ?? ''}<span class="brow-n">0</span></li>`;
		}
		return `<li><a class="brow${on ? ' active' : ''}" href="${esc(href)}" title="${esc(opts.title ?? `${opts.name}: ${opts.n}`)}"${on ? ' aria-current="true"' : ''}>
        <span class="brow-name">${esc(opts.name)}</span>${opts.extra ?? ''}<span class="brow-n">${opts.n}</span>
        <span class="share" style="width:${share(opts.n, opts.of)}%" aria-hidden="true"></span>
      </a></li>`;
	};
	const head = (id: string, title: string, meta: string) =>
		`<div class="panel-head"><h2 id="${id}">${title}</h2><p class="panel-meta">${meta}</p></div>`;
	const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

	const technology = `
  <div class="panel" aria-labelledby="p-build">
    ${head(
			'p-build',
			'Technology type',
			t.tags
				? `What they build, matched on words in the description.${w.untagged ? ` ${w.untagged} matched no keyword.` : ''}`
				: 'No company in this view to tag.',
		)}
    <ul class="brows">
      ${BUILD_TAGS.map((tag) => row({ key: 'build', value: tag, n: w.build[tag] ?? 0, of: t.tags, name: cap(tag) })).join('\n      ')}
    </ul>
  </div>`;

	const application = `
  <div class="panel" aria-labelledby="p-domain">
    ${head('p-domain', 'Application', t.tags ? 'Where it is used, matched on words in the description.' : 'No company in this view to tag.')}
    <ul class="brows">
      ${DOMAIN_TAGS.map((tag) => row({ key: 'domain', value: tag, n: w.domain[tag] ?? 0, of: t.tags, name: cap(tag) })).join('\n      ')}
    </ul>
  </div>`;

	// Where each record comes from, and whether that source answered on its last run.
	const health = new Map(view.sourceHealth.map((h) => [h.source, h]));
	const failing = view.sourceHealth.filter((h) => h.last_status !== 'ok').length;
	const sources = `
  <div class="panel" aria-labelledby="p-sources">
    ${head(
			'p-sources',
			'Sources',
			`Records in view come from <strong>${w.sources.filter((src) => src.n > 0).length}</strong> sources${
				failing ? `; ${failing} did not answer on the last run, and their rows stand from the run before` : ''
			}. A company two sources list counts under both.`,
		)}
    <ul class="brows">
      ${w.sources
				.map((src) => {
					const h = health.get(src.source);
					const checked = h?.last_success ? `checked ${shortDate(h.last_success.slice(0, 10))}` : 'no successful check yet';
					const bad = h && h.last_status !== 'ok' ? ` &middot; <strong class="failing">no answer ${shortDate(h.last_attempt.slice(0, 10))}</strong>` : '';
					const name = SOURCE_LABELS[src.source] ?? src.source;
					return row({ key: 'source', value: src.source, n: src.n, of: t.sources, name, title: `${name}: ${src.n} records, ${checked}`, extra: `<span class="brow-when">${esc(checked)}${bad}</span>` });
				})
				.join('\n      ')}
    </ul>
  </div>`;

	return `
  <div class="panel-row">
  ${technology}
  ${application}
  ${sources}
  </div>`;
}

/**
 * The breakdowns, directly under the masthead and above the search: the RDI map across the
 * full width, and technology type, application and source in a row under it. Every count is a
 * link that applies its filter, and the one a filter has chosen is marked.
 */
function breakdown(view: PageView): string {
	if (view.ids) return '<section class="breakdown" id="breakdown" hidden></section>';
	return `
<section class="breakdown" id="breakdown" aria-label="The records in view, by sector, technology, application and source">
${coverageMap(view)}
${panels(view)}
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
function findingsSection(view: AboutView): string {
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
					? ` while <a href="${esc(`${BASE_PATH}#coverage`)}">${emptyCells.length} sub-sectors</a>${cells.length ? `, including ${cells.length > 1 ? `${cells.slice(0, -1).join(', ')} and ${cells[cells.length - 1]}` : cells[0]},` : ''} have no company at all`
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
 * The bar across the top of every public page: where you are, the shortlist you are keeping,
 * and how the data is collected. Shortlist is drawn hidden and shown by the marks script, since
 * the shortlist lives in this browser and a page without storage has none to offer.
 */
export function nav(active: 'discover' | 'about' | 'company'): string {
	const current = (on: boolean) => (on ? ' aria-current="page"' : '');
	return `
<nav class="topnav" aria-label="Upstream">
  <div class="topnav-inner">
    <a class="brand" href="${esc(BASE_PATH)}">Upstream</a>
    <ul class="topnav-links">
      <li class="nav-discover"><a href="${esc(BASE_PATH)}"${current(active === 'discover')}>Discover</a></li>
      <li class="nav-shortlist-item" hidden><a class="nav-shortlist" href="${esc(BASE_PATH)}#list">Shortlist <span class="nav-count">0</span></a></li>
      <li><a href="${esc(`${BASE_PATH}/about`)}"${current(active === 'about')}><span class="nav-long">Coverage &amp; </span>methodology</a></li>
    </ul>
  </div>
  <p class="shortlist-empty" id="shortlist-empty" role="status" hidden></p>
</nav>`;
}

/**
 * The top of the discovery page: what this helps a reader do, in the words a first-time visitor
 * needs, and one quiet line on what it is read from. The ranking is explained beside the sort,
 * not here: it is a lens on the list, not the promise.
 */
function header(view: PageView): string {
	if (view.ids) {
		return `
<header class="intro">
  <p class="eyebrow">Your shortlist</p>
  <h1>Companies you shortlisted</h1>
  <p class="lede">Saved in this browser only. Open a company to check its evidence, or export the list.</p>
  <p class="since" id="since" hidden></p>
</header>`;
	}
	return `
<header class="intro">
  <p class="eyebrow">Deep-tech sourcing for investors</p>
  <h1>Find Indian deep-tech companies worth your next research call.</h1>
  <p class="lede">Upstream lists Indian deep-tech companies found in incubator, grant and startup-register records, and puts the least-documented first: one incubator listing and no website ranks above a known name with a press cycle. A list ranked by funding, press or pedigree shows every fund the same companies at the same moment; ranking by how little is public shows the ones those lists haven&rsquo;t reached, which is an argument about where to look, not a tested claim about which are good.</p>
  ${coverageLine(view)}
  <p class="since" id="since" hidden></p>
</header>`;
}

/**
 * How much is here and how current it is, in one line. Only the discovery sources are counted,
 * and a source whose last run failed is said to have failed rather than hidden behind the others'
 * fresh dates. Records, not companies: the total includes research projects and unverified names.
 */
function coverageLine(view: PageView): string {
	if (view.tracked === 0 || view.demo) return '';
	const health = view.sourceHealth.filter((h) => (SOURCES as readonly string[]).includes(h.source));
	const latest = health.map((h) => h.last_success ?? '').sort().pop();
	const failing = health.filter((h) => h.last_status !== 'ok').length;
	// "records from 8 public sources" asserts that all eight put records here, and on 17 September
	// one of them (NM-ICPS) had contributed none. How many sources are read is a fact about the
	// pipeline; how many earned a row is a different number, and it is on the methodology page
	// rather than guessed at from the filtered counts this view happens to hold.
	// The counts are the frozen set, with their date, so the number a reader quotes is the one the
	// README and the methodology page quote; the live count moves every night. "Last checked"
	// beside it is the live part, and says so by being a date.
	const s = SNAPSHOT;
	const parts = [`<strong>${s.placed}</strong> records &middot; ${s.sourcesConfigured} sources, ${s.sourcesContributing} contributing, as of ${esc(s.date)}`];
	if (latest) parts.push(`sources last checked ${shortDate(latest.slice(0, 10))}${failing ? ` (${failing} failed ${failing === 1 ? 'its' : 'their'} last check)` : ''}`);
	parts.push(`<a href="${esc(`${BASE_PATH}/about`)}">How the data is collected</a>`);
	return `<p class="coverage-line">${parts.join(' &middot; ')}</p>`;
}

/** Sub-sectors offered as a first click, in order, where the records hold any. */
const PRESETS = ['1.4', '2.2', '4.5'];
/** Searches that return useful rows on the current records (15 Sep 2026: 11, 14 and 10 described companies). */
const EXAMPLE_SEARCHES = ['drone', 'sensor', 'hydrogen'];

/**
 * A first click for someone who has not typed anything yet: three RDI sub-sectors that hold
 * companies, and three searches. Each is an ordinary link to the same view the form would make,
 * so choosing one sets the sub-sector or search box the form shows. Named with the taxonomy's own
 * words; a sector is never relabelled as a narrower technology.
 */
function quickStarts(view: PageView): string {
	const counts = view.widgets?.subsectors ?? Object.fromEntries(view.coverage.sectors.flatMap((g) => g.subsectors).map((c) => [c.subsector_id, c.n]));
	const presets = PRESETS.map((id) => SUBSECTOR_BY_ID.get(id))
		.filter((sub): sub is NonNullable<typeof sub> => Boolean(sub) && ((counts[sub!.subsector_id] ?? 0) > 0 || view.subsector === sub!.subsector_id))
		.map((sub) => {
			const on = view.subsector === sub.subsector_id;
			const href = on ? `${BASE_PATH}${query(viewParams(view, { subsector: null }))}#list` : `${BASE_PATH}${query({ subsector: sub.subsector_id })}#list`;
			return `<a class="preset${on ? ' active' : ''}" href="${esc(href)}"${on ? ' aria-current="true"' : ''}>${esc(sub.subsector)}</a>`;
		});
	const searches = EXAMPLE_SEARCHES.map((q) => `<a class="example" href="${esc(`${BASE_PATH}${query({ q })}#list`)}">${esc(q)}</a>`);
	if (view.ids || (!presets.length && view.tracked === 0)) return '<div class="quick" id="quick" hidden></div>';
	return `<div class="quick" id="quick">
      ${presets.length ? `<span class="quick-label">Start with</span> ${presets.join(' ')}` : ''}
      <span class="quick-label quick-or">or try</span> ${searches.join('<span class="sep">, </span>')}
    </div>`;
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
					return `<a class="${classes}" href="${esc(href)}" title="${esc(cell.subsector_id)} &mdash; ${esc(cell.subsector)}: ${n}${cell.n === 0 ? ', a coverage gap: none in any record' : ''}"${
						active ? ' aria-current="true"' : ''
					}>
        <span class="cell-head"><span class="cell-id">${esc(cell.subsector_id)}</span><span class="cell-n">${n}</span></span>
        <span class="cell-name">${esc(cell.subsector)}</span>${cell.n === 0 ? '<span class="visually-hidden"> (coverage gap)</span>' : ''}
      </a>`;
				})
				.join('\n');
			const on = sector === group.sector_id && !subsector;
			const href = `${query(viewParams(view, { sector: on ? null : group.sector_id, subsector: null }))}#list`;
			const inSector = group.subsectors.reduce((k, c) => k + (inView ? (inView[c.subsector_id] ?? 0) : c.n), 0);
			// Always open: the whole map, on a phone too. The sector a filter is in is marked.
			const chosen = sector === group.sector_id || group.subsectors.some((c) => c.subsector_id === subsector);
			return `<div class="sector${chosen ? ' chosen' : ''}">
      <h3><a class="sector-link${on ? ' active' : ''}" href="${esc(href)}"${on ? ' aria-current="true"' : ''}>${sectorIcon(group.sector_id)}<span class="sector-id">${esc(group.sector_id)}</span> ${esc(group.sector)}</a> <span class="sector-n">${inSector}</span></h3>
      <div class="grid">
${cells}
      </div>
    </div>`;
		})
		.join('\n');

	return `
<section class="coverage" id="coverage" aria-labelledby="coverage-h">
  <div class="panel-head">
    <h2 id="coverage-h">Explore by sector <span class="panel-kicker">RDI classification</span></h2>
    <p class="panel-meta">${claim} Pick a sub-sector to narrow the list to it, or a sector&rsquo;s name for all of it. Numbers count matching records of any start year.</p>
    <p class="panel-legend"><span class="legend-cell legend-gap" aria-hidden="true"></span> Dashed: a coverage gap, no record in any source. <span class="legend-cell legend-on" aria-hidden="true"></span> Outlined: the filter in use.</p>
    <p class="panel-meta cells-caveat"><strong>An empty cell is a gap in what these sources reach, not a finding about the market.</strong>
      It can mean nobody in India is building there, or it can mean the ${SNAPSHOT.sourcesContributing} sources feeding this page
      do not cover that work &mdash; and this tool cannot currently tell you which. Incubator portfolios and a startup register are
      not where fusion or ocean farming would surface first. Read an empty cell as somewhere to look, never as evidence of absence.</p>
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
		ids: view.ids?.length ? view.ids.join(',') : null,
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
	quietest: 'Fewest collected references',
	described: 'Most described',
	programmes: 'Most public programmes',
	newest: 'Newest source date',
	name: 'Name',
	obscurity: 'Fewest collected references',
};

/** What each order does, in one sentence beside the count. */
const SORT_NOTES: Record<SortChoice, string> = {
	quietest: 'Sorted by the fewest references collected from the sources Upstream monitors.',
	obscurity: 'Sorted by the fewest references collected from the sources Upstream monitors.',
	described: 'Sorted by how much is on record: a description, a confirmed website, founders, a contact route and a date.',
	programmes: 'Sorted by the most public programmes that selected the company.',
	newest: 'Sorted by the most recent source date.',
	name: 'Sorted by name.',
};

/* Option wording: the choice that narrows nothing is "Any" in every select. */
const TIER_LABELS: Record<TierChoice, string> = { a: 'A only', ab: 'A + B', all: 'Any' };
const DATES_LABELS: Record<PageView['dates'], string> = { both: 'Any', dated: 'With a source date', undated: 'No source date' };
const SITE_LABELS: Record<SiteState, string> = { has: 'Has a website', none: 'No website listed' };
const AGE_LABELS: Record<AgeChoice, string> = { recent: `Last ${MAX_AGE_YEARS} years`, all: 'Any' };
const TRACE_LABELS: Record<TraceBucket, string> = { '1': 'One or none', '2': 'Two', '3+': 'Three or more' };
const DESCRIBED_LABELS: Record<DescribedChoice, string> = {
	said: 'Has a product description',
	unsaid: 'No product description',
	own: 'Company website description',
	source: 'Source description',
	label: 'Category label only',
	none: 'No description',
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
	// A shortlist opens over every record, so the widened defaults it needs are not choices to list.
	const shortlist = Boolean(view.ids?.length);
	const named: Array<[string, string | null]> = [
		['ids', shortlist ? `Your shortlist (${view.ids!.length})` : null],
		['q', view.search ? `Search: “${view.search}”` : null],
		['sector', view.sector ? `Sector: ${sector?.sector ?? view.sector}` : null],
		['subsector', view.subsector ? `Sub-sector: ${sub?.subsector ?? view.subsector}` : null],
		['tier', view.tier !== view.defaultTier ? `Rank tier: ${TIER_LABELS[view.tier]}` : null],
		['source', view.source ? `Source: ${SOURCE_LABELS[view.source] ?? view.source}` : null],
		['dates', view.dates !== 'both' ? `Source date: ${DATES_LABELS[view.dates].toLowerCase()}` : null],
		['site', view.site ? `Website: ${SITE_LABELS[view.site].toLowerCase()}` : null],
		['state', view.state ? `Location: ${view.state === 'unknown' ? 'unknown' : view.state}` : null],
		['traces', view.traces ? `Collected references: ${TRACE_LABELS[view.traces].toLowerCase()}` : null],
		[
			'described',
			view.described === 'said' || (shortlist && !view.described) ? null : `Product description: ${view.described ? DESCRIBED_LABELS[view.described].toLowerCase() : 'any'}`,
		],
		['kind', view.kind === 'company' || (shortlist && !view.kind) ? null : `Showing: ${view.kind ? KIND_LABELS[view.kind].toLowerCase() : 'companies, projects and unverified names'}`],
		['dpiit', view.dpiit ? `DPIIT: ${DPIIT_STATUS_PHRASES[view.dpiit] ?? view.dpiit}` : null],
		['programmes', view.programmes ? `Public programmes: ${view.programmes} or more` : null],
		['alone', view.alone ? 'No website or press' : null],
		['noticed', view.noticed ? 'Referenced by: one outside source' : null],
		['build', view.build ? `Technology type: ${view.build}` : null],
		['domain', view.domain ? `Application: ${view.domain}` : null],
		['age', view.age === 'recent' || shortlist ? null : 'Started: any year'],
	];
	return named
		.filter((entry): entry is [string, string] => entry[1] !== null)
		.map(([key, label]) => ({
			key,
			label,
			// Leaving the shortlist returns the list to its ordinary defaults too.
			href: `${BASE_PATH}${query(viewParams(view, key === 'ids' ? { ids: null, described: null, kind: null, age: null } : { [key]: null }))}#list`,
		}));
}

function chips(view: PageView): string {
	const active = activeFilters(view);
	const items = active
		.map(
			(f) =>
				`<li><a class="chip filter-chip" href="${esc(f.href)}" aria-label="Remove ${esc(f.label)}">${esc(f.label)} <span aria-hidden="true">&times;</span></a></li>`,
		)
		.join('');
	// Back to the default view: every filter off, the default order.
	const all = active.length ? `<li><a class="clear" href="${esc(`${BASE_PATH}#list`)}">Clear all</a></li>` : '';
	return `<ul class="chips active-chips" id="chips" aria-label="Filters in use">${items}${all}</ul>`;
}

/**
 * The result count, and what it is out of behind a disclosure.
 *
 * One number leads: how many match. What the default view leaves out, and why, is one click
 * away rather than four competing totals, and every part of it is still a link to the view that
 * shows those records. Built from the same buckets as the list, so the parts add up: shown +
 * hidden by filters + held back by age or tier + outside this view = every record.
 */
/** Under the count: how much of it the page lists, and the order it is in. */
function sortNote(view: PageView): string {
	const { total, onPage } = listing(view);
	const showing = onPage < total ? `Showing 1&ndash;${onPage} of ${total}; narrow the search or filters to see the rest. ` : '';
	return `${showing}${SORT_NOTES[view.sort]}`;
}

function resultLine(view: PageView): string {
	const b = view.buckets;
	// The demo rows are not the database, so they account for themselves.
	const universe = view.demo ? b.total : Math.max(view.category, b.total);
	const outside = view.demo ? 0 : view.tracked - universe;
	// The undated rows continue the same list, so they count in what it shows.
	const { total: shown } = listing(view);
	const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
	const noun = view.kind === 'company' ? plural(shown, 'company', 'companies') : plural(shown, 'record', 'records');
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
			const outsideTier = view.tier === 'a' ? 'Tier B or C' : 'Tier C';
			const showing = view.tier === 'a' ? 'Tier A' : 'Tier A and B';
			why.push(`${b.tierHidden} ${plural(b.tierHidden, 'is', 'are')} ${outsideTier}, and the list is showing ${showing}`);
		}
		const everything = `${BASE_PATH}${query(viewParams(view, { tier: 'all', age: 'all', dates: null }))}#list`;
		const label = b.tierHidden === 0 ? `${b.older} started over ${MAX_AGE_YEARS} years ago` : b.older === 0 ? `${b.tierHidden} outside the tier shown` : `${held} held back by age or tier`;
		parts.push(`<a href="${esc(everything)}" title="${esc(why.join('; '))}. Follow to show them.">${label}</a>`);
	}

	if (view.dates === 'dated' && b.undated > 0) {
		parts.push(`<a href="${esc(`${BASE_PATH}${query(viewParams(view, { dates: null }))}#undated`)}" title="Records no source dates. Follow to list them after the dated ones.">${b.undated} undated, hidden</a>`);
	} else if (view.dates !== 'undated' && b.undated > 0) {
		parts.push(`<a href="#undated" title="Records no source dates, so no tier can be claimed for them. Listed after the dated ones.">${b.undated} of them undated</a>`);
	}

	if (outside > 0) {
		const everything = `${BASE_PATH}${query(viewParams(view, { described: 'all', kind: 'all', dpiit: null }))}#list`;
		parts.push(
			`<a href="${esc(everything)}" title="Records outside this view: by default, those with no product description, and research projects and unverified names. Follow to include them.">${outside} outside this view</a>`,
		);
	}

	const what = view.dates === 'undated' ? 'undated' : 'in the list';
	// The rules the default view applies, said as the query applies them.
	const rules: string[] = [];
	if (view.described === 'said') rules.push('a product description, from the company&rsquo;s own website or from a source');
	if (view.kind === 'company') rules.push('a company on record, not a research project or an unverified name');
	if (view.age === 'recent' && view.dates !== 'undated') {
		rules.push(`a founding or programme year in the last ${MAX_AGE_YEARS} years, or a date from a public register that cannot be checked against that rule`);
	}
	const unknownAge = view.buckets.unknownAge;
	return `<div class="result-head" id="result-line">
      <p class="result-line"><strong>${shown}</strong> ${noun} ${view.dates === 'undated' ? 'with no source date ' : ''}${plural(shown, 'matches', 'match')}<span class="marks-line" hidden></span></p>
      <details class="about-results" id="about-results">
        <summary>About these results</summary>
        <div class="about-results-body">
          <p class="result-parts"><strong>${shown}</strong> ${what} of ${universe}${parts.length ? ` &middot; ${parts.join(' &middot; ')}` : ''}</p>
          ${rules.length ? `<p>By default the list shows records with ${rules.join('; ')}.</p>` : ''}
          ${b.undated > 0 && view.dates === 'both' && b.ranked > 0 ? `<p>Records with a source date come first, in this order; the ${b.undated} with no source date follow in the same order.</p>` : ''}
          ${unknownAge > 0 ? `<p>${unknownAge} of these ${unknownAge === 1 ? 'is' : 'are'} dated by a public register rather than by a founding year &mdash; the DPIIT register dates its own record of a company, not when the company started. The ${MAX_AGE_YEARS}-year filter cannot be applied to ${unknownAge === 1 ? 'it' : 'them'}.</p>` : ''}
          <p>The date on each row is the date a source gives for its own record &mdash; a listing, a register entry, a grant &mdash; not a founding date.</p>
          <p>A collected reference is one public record of the company that Upstream reads: an incubator listing, a grant or award, a DPIIT register record, press, or a website that answered. It measures how much Upstream has collected, not the company&rsquo;s quality.</p>
          <p>Counts cover the sources Upstream reads. A sector with no results means no record in current coverage, not that no such companies exist. <a href="${esc(`${BASE_PATH}/about`)}">How the data is collected</a></p>
          <p class="device-note" id="device-note" hidden></p>
        </div>
      </details>
    </div>`;
}

function controls(view: PageView): string {
	const { subsector, search, source, site, dates, tier, age } = view;
	const option = (value: string, label: string, current: string) =>
		`<option value="${esc(value)}"${current === value ? ' selected' : ''}>${esc(label)}</option>`;
	const cap = (t: string) => t[0].toUpperCase() + t.slice(1);

	// A sub-sector belongs to one sector, so the sector box says which even when only the
	// sub-sector was chosen (a map click sets ?subsector= alone).
	const sector = view.sector ?? (subsector ? (SUBSECTOR_BY_ID.get(subsector)?.sector_id ?? null) : null);
	const sectorOptions = [option('', 'Any', sector ?? '')].concat(SUNRISE_SECTORS.map((g) => option(g.sector_id, g.sector, sector ?? ''))).join('');
	// A chosen sector narrows the sub-sectors to its own, so no pair on offer is one that can only
	// come back empty. Each keeps its sector in a data attribute for the script.
	const subOption = (g: (typeof SUNRISE_SECTORS)[number], sub: (typeof SUNRISE_SECTORS)[number]['subsectors'][number]) =>
		`<option value="${esc(sub.subsector_id)}" data-sector="${esc(g.sector_id)}"${subsector === sub.subsector_id ? ' selected' : ''}>${esc(sub.subsector)}</option>`;
	const inSector = sector ? SUNRISE_SECTORS.find((g) => g.sector_id === sector) : undefined;
	const subsectorOptions = [option('', 'Any', subsector ?? '')]
		.concat(
			inSector
				? inSector.subsectors.map((sub) => subOption(inSector, sub))
				: SUNRISE_SECTORS.map((g) => `<optgroup label="${esc(g.sector)}">${g.subsectors.map((sub) => subOption(g, sub)).join('')}</optgroup>`),
		)
		.join('');
	const buildOptions = [option('', 'Any', view.build ?? '')].concat(BUILD_TAGS.map((t) => option(t, cap(t), view.build ?? ''))).join('');
	const domainOptions = [option('', 'Any', view.domain ?? '')].concat(DOMAIN_TAGS.map((t) => option(t, cap(t), view.domain ?? ''))).join('');
	const ageOptions = (Object.keys(AGE_LABELS) as AgeChoice[]).map((v) => option(v, AGE_LABELS[v], age)).join('');

	const sourceOptions = [option('', 'Any', source ?? '')].concat(SOURCES.map((id) => option(id, SOURCE_LABELS[id] ?? id, source ?? ''))).join('');
	const siteOptions = [option('', 'Any', site ?? ''), option('has', SITE_LABELS.has, site ?? ''), option('none', SITE_LABELS.none, site ?? '')].join('');
	const describedNow = view.described === 'said' ? '' : (view.described ?? 'all');
	const describedOptions = [option('', DESCRIBED_LABELS.said, describedNow)]
		.concat(DESCRIBED_STATES.map((v) => option(v, DESCRIBED_LABELS[v], describedNow)))
		.concat([option('unsaid', DESCRIBED_LABELS.unsaid, describedNow), option('all', 'Any', describedNow)])
		.join('');
	const traceOptions = [option('', 'Any', view.traces ?? '')].concat(TRACE_BUCKETS.map((v) => option(v, TRACE_LABELS[v], view.traces ?? ''))).join('');
	const datesOptions = (Object.keys(DATES_LABELS) as Array<PageView['dates']>).map((v) => option(v, DATES_LABELS[v], dates)).join('');
	// Any first, like every other select; the tiers after it, narrowest last.
	const tierOptions = (['all', 'ab', 'a'] as TierChoice[]).map((v) => option(v, TIER_LABELS[v], tier)).join('');

	// The count on "More filters" is the filters inside it, and any of them keeps it open.
	const inside = new Set(['source', 'site', 'described', 'traces', 'dates', 'tier']);
	const count = activeFilters(view).filter((f) => inside.has(f.key)).length;

	const field = (id: string, label: string, options: string, hint?: string) =>
		`<div class="field"><label for="${id}">${label}</label><select id="${id}" name="${id}"${hint ? ` aria-describedby="${id}-hint"` : ''}>${options}</select>${
			hint ? `<p class="field-hint" id="${id}-hint">${hint}</p>` : ''
		}</div>`;
	const clearSearch = `${BASE_PATH}${query(viewParams(view, { q: null }))}#list`;

	return `
<form class="controls" id="controls" method="get" action="${esc(BASE_PATH)}#list" role="search">
  <div class="field search-field">
    <label for="q">Find companies</label>
    <div class="search-row">
      <input type="search" id="q" name="q" value="${esc(search ?? '')}" placeholder="Search companies or technologies"
        autocomplete="off" spellcheck="false" enterkeyhint="search" aria-describedby="q-hint">
      <a class="search-clear" id="q-clear" href="${esc(clearSearch)}" aria-label="Clear search"${search ? '' : ' hidden'}><span aria-hidden="true">&times;</span></a>
    </div>
    <p class="field-hint" id="q-hint">Company names and what their descriptions say they build. Press Enter to search.</p>
  </div>
  <div class="filter-grid" id="primary-filters">
    ${field('sector', 'Sector', sectorOptions)}
    ${field('subsector', 'Sub-sector', subsectorOptions)}
    ${field('build', 'Technology type', buildOptions)}
    ${field('domain', 'Application', domainOptions, 'matched on words in the description')}
    ${field('age', 'Started', ageOptions)}
  </div>
  <details class="more-filters" id="more-filters"${count ? ' open' : ''}>
    <summary>More filters<span class="filter-count" id="filter-count">${count ? ` (${count})` : ''}</span></summary>
    <div class="filter-grid">
      ${field('source', 'Source', sourceOptions)}
      ${field('site', 'Website', siteOptions)}
      ${field('described', 'Product description', describedOptions)}
      ${field('traces', 'Collected references', traceOptions)}
      ${field('dates', 'Source date', datesOptions)}
      ${field('tier', 'Rank tier', tierOptions, '<a href="' + esc(`${BASE_PATH}/about#method-h`) + '">How tiers are set</a>')}
    </div>
  </details>
  <input type="hidden" id="state" name="state" value="${esc(view.state ?? '')}">
  <input type="hidden" name="kind" value="${esc(viewParams(view).kind ?? '')}">
  <input type="hidden" name="dpiit" value="${esc(view.dpiit ?? '')}">
  <input type="hidden" name="noticed" value="${esc(view.noticed ?? '')}">
  <input type="hidden" name="programmes" value="${esc(view.programmes ?? '')}">
  <input type="hidden" name="alone" value="${esc(view.alone ?? '')}">
  <input type="hidden" name="ids" value="${esc(viewParams(view).ids ?? '')}">
  <noscript><div class="apply-row"><button type="submit" class="apply">Apply filters</button></div></noscript>
</form>
${quickStarts(view)}
${chips(view)}
<div class="results-bar">
  ${resultLine(view)}
  <div class="field field-sort">
    <label for="sort">Sort</label>
    <select id="sort" name="sort" form="controls">${(['quietest', 'programmes', 'described', 'newest', 'name'] as SortChoice[]).map((v) => option(v, SORT_LABELS[v], view.sort)).join('')}</select>
  </div>
</div>
<div class="bar-foot">
  <p class="sort-note" id="sort-note">${sortNote(view)}</p>
  <span class="bar-links">
    <button type="button" class="linkish seen-toggle" hidden aria-pressed="false">Hide seen</button>
    <a class="linkish shortlist-export" hidden href="#">Export shortlist</a>
    <a class="export" id="export" href="${esc(`${BASE_PATH}/export.csv${query(viewParams(view))}`)}">Export results</a>
  </span>
</div>`;
}

/**
 * The count of collected references, as a number rather than as an implication: it is what
 * the default order sorts by, so a row that states it is a row that can be checked.
 */
function traceLine(company: Company): string {
	const n = company.trace_count;
	const said = referenceCount(n);
	const shape = traceShape(company);
	// Emphasised only where it is the finding. At five traces it is just a number.
	// The count is the sort key and keeps the mono; what the traces are is read, not scanned,
	// so it sits under the count in the body face and wraps inside the side column.
	return `<span class="traces${n <= 1 ? ' quiet' : ''}"><span class="trace-n">${said}</span>${shape ? `<span class="trace-shape">${esc(shape)}</span>` : ''}</span>`;
}

/** "1 collected reference": the count the default order sorts by, in the words the page defines. */
function referenceCount(n: number): string {
	return n === 0 ? 'no collected reference' : n === 1 ? '1 collected reference' : `${n} collected references`;
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
	const traces = n === 0 ? 'Upstream has collected no reference to it' : `Upstream has collected ${referenceCount(n)}${shape ? ` (${shape})` : ''}`;
	return `It is here because ${who}, and ${traces}; the default order puts those with the fewest first.`;
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
function buildsLine(company: Company): { html: string; attrib: string | null; described: boolean } {
	if (company.product && company.website_identity === 'verified') {
		const host = safeUrl(company.website);
		return {
			html: `<p class="builds">${esc(company.product)} <span class="says">in their own words</span></p>`,
			attrib: `Description from their website${host ? ` (${esc(new URL(host).hostname)})` : ''}`,
			described: true,
		};
	}
	if (describedBySource(company)) {
		const by = SOURCE_LABELS[company.description_source ?? ''];
		return { html: `<p class="builds from-source">${esc(company.description)}</p>`, attrib: `Description from ${by ? esc(by) : 'a source'}`, described: true };
	}
	return { html: '<p class="builds none">No description published</p>', attrib: null, described: false };
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
 * One row, in the order a reader decides on it: the name, what it builds and on whose word,
 * where it sits, the evidence that put it here, and one consistent place to shortlist it.
 * Everything else is on the company's own page.
 *
 * Scanned, not read. So the three distinctions that decide whether a row is worth a
 * click are carried by how the row looks as well as by what it says: described or not,
 * dated or not, a website confirmed as theirs or not.
 */
function companyRow(company: Company, now: Date, origin: string, position: number): string {
	const builds = buildsLine(company);
	const dated = company.first_seen !== null;
	const site = company.website_identity === 'discovered' ? null : safeUrl(company.website);
	const siteState = site ? (company.website_identity === 'verified' ? 'verified' : 'unconfirmed') : company.website_checked ? 'none' : 'unknown';
	const href = `${BASE_PATH}/c/${company.id}`;

	// Where it sits: its RDI sub-sector, what it builds by keyword, its stage, and where it is.
	const sub = company.subsector_id ? SUBSECTOR_BY_ID.get(company.subsector_id) : undefined;
	const kinds = tagsOf(company.build_tags);
	const city = company.city || company.state;
	const context = [
		sub ? `<span class="f-sub">${esc(sub.subsector)}</span>` : '',
		kinds.length ? `<span class="f-kind">${esc(kinds.join(' + '))}</span>` : '',
		company.dpiit_stage ? `<span class="f-stage" title="The stage the company chose on its DPIIT profile">${esc(stageWords(company.dpiit_stage))}</span>` : '',
		city ? `<span class="f-city">${esc(city)}</span>` : '',
	].filter(Boolean);

	// What put it here, with a link to each source, and the date said as what it is.
	const trail = traceTrail(company);
	const when = eventPhrase(company);
	const evidence = [
		`<span class="f-listed">${trail ? `Listed by ${trail}` : '<span class="none">No collected reference</span>'}</span>`,
		builds.attrib ? `<span class="f-attrib">${builds.attrib}</span>` : '',
		// Selected into two or more public programmes: counted, never ranked, named on its page.
		company.programme_count >= 2 ? `<span class="f-prog" title="${esc(tagsOf(company.programmes).join(', '))}">${company.programme_count} public programmes</span>` : '',
		`<span class="f-age${dated ? '' : ' undated'}">${esc(when ?? 'no source dates it')}</span>`,
	].filter(Boolean);

	const state = [builds.described ? 'described' : 'undescribed', dated ? 'dated' : 'undated', `site-${siteState}`].join(' ');

	// Anchored by slug so one row can be linked to, and so "back to results" lands on it.
	return `
  <li class="company ${state}" id="c-${esc(company.id)}" data-id="${esc(company.id)}" data-added="${esc((company.discovered ?? '').slice(0, 10))}">
    <div class="row-main">
      <h3><span class="row-n" aria-hidden="true">${position}</span><a href="${esc(href)}">${esc(company.name)}</a>${entityTag(company)}</h3>
      ${builds.html}
      ${context.length ? `<p class="context-row">${context.join('')}</p>` : ''}
      <p class="trail evidence-row">${evidence.join('')}</p>
    </div>
    <div class="row-side">
      <span class="row-actions" hidden>
        <button type="button" class="mark mark-shortlist" data-mark="shortlist" aria-pressed="false" aria-label="Shortlist ${esc(company.name)}">Shortlist</button>
      </span>
      <span class="row-tools">
        <a class="view-evidence" href="${esc(href)}">View evidence</a>
        <button type="button" class="mark mark-seen" data-mark="seen" aria-pressed="false" hidden>Mark as seen</button>
        <button type="button" class="copy-row" data-brief="${esc(`${href}/brief`)}" hidden>Copy brief</button>
      </span>
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
 * What the page lists, as one numbered order: the dated rows first, then the undated ones in
 * the same order. The count, the "showing" line and the row numbers are all read from this, so
 * they cannot disagree.
 *
 * Each half is fetched up to a limit. When the dated half is cut short, the undated rows would
 * not follow on from the last one shown, so they are not listed: the page shows 1 to N of the
 * whole and says how to reach the rest, rather than two runs with a hole between them.
 */
function listing(view: PageView): { total: number; ranked: number; undated: number; onPage: number; undatedHeld: boolean } {
	const b = view.buckets;
	const total = view.dates === 'undated' ? b.undated : view.dates === 'dated' ? b.ranked : b.ranked + b.undated;
	const ranked = view.dates === 'undated' ? 0 : view.companies.length;
	const rankedCut = view.dates !== 'undated' && view.companies.length < b.ranked;
	const undatedHeld = view.dates === 'both' && rankedCut && b.undated > 0;
	const undated = view.dates === 'dated' || undatedHeld ? 0 : view.undated.length;
	return { total, ranked, undated, onPage: ranked + undated, undatedHeld };
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
<section class="list" id="list" aria-labelledby="list-h">
  <h2 id="list-h" class="visually-hidden">Results</h2>
  ${backfillNote(view)}
  ${empty}
</section>`;
	}

	const banner = demo
		? `<p class="demo-banner"><strong>Sample data.</strong> These companies are invented, so the layout can be
      checked before real data lands. The numbers above and the coverage map are the real, and currently empty, database.</p>`
		: '';

	return `
<section class="list" id="list" aria-labelledby="list-h">
  <h2 id="list-h" class="visually-hidden">Results <span class="count">${listing(view).total}</span></h2>
  ${banner}
  ${backfillNote(view)}
  <ol class="companies">
${companies.map((company, i) => companyRow(company, now, view.origin, i + 1)).join('\n')}
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
	const n = buckets.undated;
	const shown = listing(view);
	if (shown.undatedHeld) {
		// The dated half was cut short, so these would not follow on from the last row shown.
		const only = `${BASE_PATH}${query(viewParams(view, { dates: 'undated' }))}#list`;
		return `
<section class="list undated-list" id="undated" aria-labelledby="undated-h">
  <h2 id="undated-h">No source date <span class="count">${n}</span></h2>
  <p class="note">These ${n} come after the ${buckets.ranked} dated records in the same order, past the ${shown.ranked} listed above.
    <a href="${esc(only)}">List only the ${n} with no source date</a>, or narrow the search or filters.</p>
</section>`;
	}
	if (undated.length === 0) return '';
	// Numbered on from the dated rows: one list, in one order.
	const from = shown.ranked + 1;
	return `
<section class="list undated-list" id="undated" aria-labelledby="undated-h">
  <h2 id="undated-h">No source date <span class="count">${n}</span></h2>
  <p class="note">The same order, continued. No source gives a date for anything about these records, so none is dated here.</p>
  <ol class="companies" start="${from}">
${undated.map((company, i) => companyRow(company, now, view.origin, from + i)).join('\n')}
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

function offMap(view: AboutView): string {
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
function registerSplit(view: AboutView): string {
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
function productNote(view: AboutView): string {
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
			? ` A further <strong>${p.noSite}</strong> have no website listed, where a source that publishes websites went
			looking and came back with nothing. That is an absence in the record, not a sign of quality either way.`
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

/**
 * Every source, configured or evidence-only, with its last check: which answered, which failed and
 * what the page is still showing from them. Configured and successful are different claims, and a
 * run that happened is not a source that answered.
 */
function sourceStatus(view: AboutView): string {
	const health = new Map(view.sourceHealth.map((h) => [h.source, h]));
	const day = (iso: string | null) => (iso ? shortDate(iso.slice(0, 10)) : 'never');
	const row = (id: string) => {
		const h = health.get(id);
		const name = esc(SOURCE_LABELS[id] ?? id);
		if (!h) return `<tr><td>${name}</td><td>No run recorded yet</td><td class="mono">&mdash;</td></tr>`;
		const status =
			h.last_status === 'ok'
				? `Answered on ${day(h.last_attempt)}`
				: `<strong>${h.last_status === 'failed' ? 'Failed' : 'Returned too little and was set aside'} on ${day(h.last_attempt)}</strong>${h.last_success ? `; showing the run of ${day(h.last_success)}` : '; nothing shown from it yet'}`;
		return `<tr><td>${name}</td><td>${status}</td><td class="mono">${h.data_as_of ? day(h.data_as_of) : 'unknown'}</td></tr>`;
	};
	const evidenceOnly = view.sourceHealth.map((h) => h.source).filter((id) => !(SOURCES as readonly string[]).includes(id));
	return `<div class="table-scroll"><table class="evidence-table source-status">
    <caption class="visually-hidden">Each source's last check</caption>
    <thead><tr><th scope="col">Source</th><th scope="col">Last check</th><th scope="col">Newest data</th></tr></thead>
    <tbody>${[...SOURCES, ...evidenceOnly].map(row).join('')}</tbody>
  </table></div>
  <p class="provenance">A check that answered means the source was read, not that a person verified each record.</p>
  <p class="provenance">The NM-ICPS server answers in 0.2 seconds from a machine in India and times out from GitHub&rsquo;s
    runners, where the daily check runs, every time. Our best guess, unconfirmed, is that it blocks traffic from outside
    India or from cloud hosts.</p>`;
}

/**
 * The one dated figure set, rendered from src/snapshot.ts so this page and the README cannot drift
 * apart again. Live counts elsewhere on the site move every night; these do not, and they are the
 * ones any claim on the site is allowed to rest on.
 */
function snapshotSection(): string {
	const s = SNAPSHOT;
	const rows = SNAPSHOT_TERMS.map(
		(t) => `    <tr><th scope="row">${esc(t.term)}</th><td class="snap-n">${esc(t.value(s))}</td><td>${esc(t.means)}</td></tr>`,
	).join('\n');
	return `
<section class="ref-section" id="snapshot" aria-labelledby="snapshot-h">
  <h2 id="snapshot-h">The figures, as of ${esc(s.date)}</h2>
  <p class="provenance">One dated set of counts, taken from the database as the ingest run of
    ${esc(s.dataVersion)} left it. Every number below says what it counts, because several of them
    could reasonably mean two different things. The list itself shows live counts, which move each
    night; these do not, and they are the figures any argument here rests on.</p>
  <table class="snapshot">
    <thead><tr><th scope="col">Number</th><th scope="col">As of ${esc(s.date)}</th><th scope="col">What it counts</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p class="provenance">Placed and dropped account for every record seen
    (${s.placed} + ${s.dropped.toLocaleString('en-IN')} = ${s.recordsSeen.toLocaleString('en-IN')}), and companies for
    every record placed (${s.companies} + ${s.notCompanies} = ${s.placed}). The ${s.placed} placed records are committed
    to the repository as <code>${esc(s.exportFile)}</code>, so the evidence stays readable whether or not the live
    pipeline is running.</p>
</section>`;
}

function methodology(view: AboutView): string {
	return `
<section class="method" aria-labelledby="method-h">
  <h2 id="method-h">Methodology</h2>

  <h3>Where this comes from</h3>
  <p>Public sources only, nothing behind a login. Upstream is configured to read ${SOURCES.length} sources that list
    companies: ${SOURCES.map((id) => esc(SOURCE_LABELS[id] ?? id)).join(', ')}. Award and agreement lists add dated
    evidence to companies already found and add no company of their own. Patent filings, new incorporations at the MCA,
    LinkedIn and every other incubator are not read, so nothing they would show is here. Every row carries the evidence
    that put it there.</p>
  ${sourceStatus(view)}

  ${productNote(view)}

  <h3>How the tiers are decided</h3>
  <p>There is no score. A number between 0 and 100 would pretend to a precision we do not have. Two facts decide the tier:
  how recently we first saw the company, and how many collected references (public traces) it already has &mdash; today that means an
    incubator listing, a grant award, a DPIIT register record and a website that answered when we fetched it. A domain that
    no longer resolves is not a trace, and stops being one the night it stops answering. A press mention ought to count
    as well; nothing collects it yet, so for now it does not, and the trace counts on this page are lower than they
    would be.</p>
  <ul class="rules">
    <li><span class="tier ta">Tier A</span> Added to Upstream by a run under 90 days ago, with no source dating anything about it earlier than 90 days ago, and at most 2 traces. Recently on record, and carrying the fewest public traces of anything here.</li>
    <li><span class="tier tb">Tier B</span> First seen under 180 days ago, at most 5 traces. Recently on record, with some public visibility already.</li>
    <li><span class="tier tc">Tier C</span> Everything else. Longer on record, or more widely traced.</li>
  </ul>
  <p class="unvalidated"><strong>The tiers are unvalidated.</strong> They describe how recently a company reached a
    public record and how little of it is published &mdash; nothing more. No one has tested whether a Tier A company is
    a better research call than a Tier C one, because that would need outcomes this project does not have and cannot
    currently collect: which calls were taken, which led anywhere, what happened next. The ordering is an argument about
    where public information is thinnest, not a finding about where value is. Treat it as a way to see companies you
    would otherwise not see, and not as a recommendation about which to call.</p>
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

  <h3 id="rdi-caveat">What the RDI taxonomy is, and is not</h3>
  <p><strong>The RDI taxonomy is a government policy priority list, not evidence of market demand.</strong> It records
    what one department decided to prioritise for research and development funding. It is used here for navigation
    &mdash; a fixed, public, independently-authored set of cells to sort records into, so the shape of the map is not
    one of my own choosing &mdash; and for nothing else. That a sub-sector appears on it says nothing about whether
    customers want the thing, whether anyone will pay for it, or whether a market exists. Those are separate questions,
    and this page does not answer any of them.</p>

  <h3 id="crosswalk">One classifier run suggests the two official classifications may not line up</h3>
  <p>DPIIT's recognition register files every startup under its own industry vocabulary &mdash; 56 industries, chosen
    by the founder from a list when they applied. The RDI scheme has 44 sub-sectors, written by a different department
    for a different purpose. Neither was drawn up with the other in mind.</p>
  <p>Putting the same companies through both, on <strong>one run, with one model and one prompt</strong>, on
    ${CROSSWALK.run}: where the two vocabularies happen to have a near-twin a company placed almost automatically
    &mdash; DPIIT's &ldquo;Robotics&rdquo; against the scheme's &ldquo;Intelligent Systems &amp; Robotics&rdquo; placed
    ${CROSSWALK.robotics[0]} of ${CROSSWALK.robotics[1]}. Where they have none, almost nothing placed:
    ${CROSSWALK.vision[0]} of ${CROSSWALK.vision[1]} for &ldquo;Computer Vision&rdquo;, ${CROSSWALK.ai[0]} of
    ${CROSSWALK.ai[1]} for &ldquo;AI&rdquo;.</p>
  <p class="unvalidated"><strong>This is n=1 and should be read that way.</strong> It is one classifier's behaviour on
    one-line labels on a single day &mdash; not re-run, not tried against a second model or prompt, and not checked by
    hand against a reviewed crosswalk. The gap it points at may be real, or may be an artefact of how one prompt read
    short strings. It is a reason to look, and worth rechecking before anyone leans on it. It is not a fault in either
    vocabulary.</p>
  <p>Those few placements were also where the classifier guessed: five &ldquo;AI / NLP&rdquo; records had gone into AI in
    Healthcare. So a register label now keeps a company on the map only where the label names the sub-sector outright
    &mdash; &ldquo;Space Technology&rdquo;, &ldquo;Robotics&rdquo;, &ldquo;Electronics&rdquo; &mdash; and a company whose
    label names none is counted with the ones we could not describe well enough to place.</p>
  <p>It does mean a row placed this way rests on the register's label rather than on anything published about what the
    company does, and should be read as exactly that much. Each company's own page says which of the two it was, in the
    classifier's own words. It also means the fuller cells of the RDI coverage map are partly a map of where the two
    vocabularies agree.</p>
${registerSplit(view)}

  <h3>What this misses</h3>
  <p>A fair amount, and it is worth being blunt about it.</p>
  <p><strong>This tool cannot identify or verify stealth companies at all.</strong> It reads no LinkedIn, by choice:
    every claim here has to link to a page anyone can open. But that choice should not be read as a finding about
    stealth companies in either direction. A company that has left no public record does not appear here, and nothing
    on this page indicates whether such companies are few or many, or what they are working on. Their absence from the
    list is a property of the list, not of the market.</p>
  <p>The list also leans toward institutions that publish their portfolios, which means well-documented incubators are
    over-represented and quieter regional ones are under-represented. An empty cell in the RDI coverage map can mean
    nobody is building there or that these sources do not reach that work, and this tool cannot currently tell you
    which. Classification into RDI sub-sectors is automated and will sometimes be wrong.</p>
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
    <h2>Who is behind it</h2>
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
	const traces = `${referenceCount(company.trace_count)}${shape ? ` (${shape})` : ''}`;
	let reason: string;
	if (company.tier === 'A') reason = 'found by a run under 90 days ago, with at most two public traces and nothing older on record';
	else if (company.tier === 'B') reason = 'on record under 180 days, with at most five public traces';
	else if (company.first_seen === null) reason = 'no source dates it, so it cannot be called an early find';
	else if (company.classify_basis === 'register-label') reason = `only ${labelWords(company).one} says what it does, so it is listed, not promoted`;
	else if (company.first_seen_basis === 'cohort') reason = 'dated from a year its source published, not found by a run of ours';
	else reason = 'on record for more than 180 days, or with more than five public traces';
	return `${traces}, which is what the default order sorts by. Tier ${company.tier}: ${reason}.`;
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
		`**Started:** ${ageKnown(company) ? String(company.origin_year ?? company.founded_year) : 'unknown'} · **Based:** ${located || 'unknown'} · **Collected references:** ${company.trace_count}`,
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
		? `<p class="provenance">No website listed. A source that publishes websites went looking and came back with
		nothing. That says nothing about the company either way.</p>`
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

	// Two kinds of gap, kept apart: what the sources checked do not say, and what Upstream does not collect at all.
	const notCollected = (u: string) => /^(Funding and revenue|Its company registration)/.test(u);
	const unknownItem = (u: string) => {
		const [head, ...rest] = u.split(': ');
		return `<li><strong>${esc(head)}</strong>${rest.length ? ` &mdash; ${esc(rest.join(': '))}` : ''}</li>`;
	};
	const allUnknowns = unknowns(company);
	const notFound = allUnknowns.filter((u) => !notCollected(u));
	const outsideScope = allUnknowns.filter(notCollected);

	const brief = briefMarkdown(company, pageUrl, now);

	// Who lists it, in one line above the evidence table: the summary a reader checks the rows against.
	const listedBy = traceTrail(company);
	const shape = traceShape(company);
	const identityWarning =
		safeUrl(company.website) && company.website_identity !== 'verified'
			? `<p class="caution"><strong>Website not confirmed.</strong> ${
					company.website_identity === 'discovered'
						? `${esc(new URL(safeUrl(company.website)!).hostname)} was given for this company and is not treated as theirs: ${esc(company.website_identity_note ?? 'nothing ties the address to them')}.`
						: `${esc(new URL(safeUrl(company.website)!).hostname)} is listed for it, but nothing confirmed the address is theirs${company.website_identity_note ? `: ${esc(company.website_identity_note)}` : ''}. Nothing on it is used here.`
				}</p>`
			: '';
	const entityWarning =
		company.entity_type && company.entity_type !== 'company' ? `<p class="caution"><strong>${ENTITY_LABELS[company.entity_type] ?? ''}.</strong> ${esc(company.entity_note ?? '')}</p>` : '';

	const facts = [
		sub ? `<a class="fact-sub" href="${esc(`${BASE_PATH}${query({ subsector: sub.subsector_id })}#list`)}" title="RDI sub-sector, placed automatically">${esc(sub.subsector)}</a>` : '',
		located ? `<span>${esc(located)}</span>` : '<span class="unknown-inline">location unknown</span>',
		site && company.website_identity === 'verified' ? `<a class="fact-site" href="${esc(site)}" rel="noopener nofollow">${esc(new URL(site).hostname)}</a>` : '',
		company.founded_year ? `<span>founded ${esc(company.founded_year)}</span>` : '<span class="unknown-inline">founding year unknown</span>',
	].filter(Boolean);

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
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600;700&display=optional">
<style>${STYLES}</style>
<script>${CAPABILITY_SCRIPT}</script>
</head>
<body data-company="${esc(company.id)}">
${nav('company')}
<div class="wrap detail">
  <p class="crumb"><a class="back" href="${esc(`${BASE_PATH}#c-${company.id}`)}">&larr; All companies</a></p>

  <header class="company-head">
    <p class="about-upstream">A company record on <a href="${esc(BASE_PATH)}">Upstream</a>, assembled from public sources.</p>
    <h1>${esc(company.name)}</h1>
    ${entityWarning}
    <div class="lead-builds">
      <h2 class="visually-hidden">What they build</h2>
      ${buildsLead}
    </div>
    <p class="facts">${facts.join('')}</p>
    ${identityWarning}
    <div class="actions">
      <button type="button" class="action mark mark-shortlist" data-mark="shortlist" aria-pressed="false" hidden>Shortlist</button>
      <button type="button" class="action copy-brief" hidden>Copy brief</button>
      <button type="button" class="action action-quiet mark" data-mark="pass" aria-pressed="false" hidden>Pass</button>
    </div>
    <p class="device-note" id="device-note" hidden>Saved in this browser only &mdash; not synced, and not visible to anyone else, including whoever runs this site.</p>
  </header>

  <section aria-labelledby="evidence-h">
    <h2 id="evidence-h">What supports this</h2>
    <p class="evidence-summary">${listedBy ? `Listed by ${listedBy}.` : 'No source link on record.'} ${esc(referenceCount(company.trace_count))}${shape ? ` (${esc(shape)})` : ''}.</p>
    ${evidence}
    ${papersBlock(company)}
    <h3 class="mini">Dates, and what each one means</h3>
    <dl class="dates">
      ${dates.map(([label, value, why]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd><dd class="why">${why}</dd></div>`).join('')}
    </dl>
    ${
			company.source_year
				? `<p class="provenance">The source listing prints ${esc(company.source_year)} beside the name, with no word on what it counts &mdash; founding, incubation or admission. Nothing here dates or ranks the company by it.</p>`
				: ''
		}
    <details class="reading"><summary>How the website was read</summary>${productDetail(company)}</details>
  </section>

  ${whoSection(company)}

  <section class="unknowns" aria-labelledby="unknowns-h">
    <h2 id="unknowns-h">What still needs checking</h2>
    ${notFound.length ? `<h3 class="mini">Not found in the sources checked</h3><ul class="unknown-list">${notFound.map(unknownItem).join('')}</ul>` : ''}
    ${outsideScope.length ? `<h3 class="mini">Not collected by Upstream</h3><ul class="unknown-list">${outsideScope.map(unknownItem).join('')}</ul>` : ''}
  </section>

  <section aria-labelledby="next-h">
    <h2 id="next-h">Next step</h2>
    <p>${esc(nextStep(company)).replace(/https?:\/\/[^\s<>"']+[^\s<>"'.,)]/g, (u) => `<a href="${u}" rel="noopener nofollow">${u}</a>`)}</p>
    <details class="brief-fold"><summary>The brief, as markdown</summary><textarea id="brief-text" readonly rows="16" spellcheck="false" aria-label="Brief as markdown">${esc(brief)}</textarea></details>
  </section>

  <section aria-labelledby="classified-h">
    <h2 id="classified-h">How it was classified and ranked</h2>
    <details class="method-fold">
      <summary>Where in the RDI scheme</summary>
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
    </details>
    <details class="method-fold">
      <summary>Where it ranks</summary>
      <p class="rank-line">${company.tier === 'A' ? 'Recently on record, fewest traces (Tier A)' : company.tier === 'B' ? 'Recently on record, some traces (Tier B)' : 'Longer on record, or more widely traced (Tier C)'}</p>
      <p class="provenance">${esc(whyOnList(company))}</p>
      <p class="provenance">${whyTier(company)}</p>
      <p class="provenance">A tier says how recently this company reached a public record and how little of it is
        published. It is not a rating, and nothing has tested whether one tier is a better research call than another.</p>
    </details>
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
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600;700&display=optional">
<style>${STYLES}</style>
</head>
<body>
${nav('company')}
<div class="wrap detail not-found">
<p class="crumb"><a class="back" href="${esc(BASE_PATH)}">&larr; All companies</a></p>
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

  /* rohitrao.in's own palette, so a reader moving between the two sites is on one page: white
     ground with a warm yellow wash, near-black ink, a grey for running text, one hairline. */
  --paper: #ffffff;
  --raise: #ffffff;
  --sunk: #f6f6f4;
  --ink: #111111;
  --body-ink: #4a4a48;
  --muted: #6e6c69;
  --rule: #e6e4e0;
  --rule-strong: #cfccc6;

  /* The site's one colour. A yellow underline says "this is the way in" (links, the chosen nav
     item, section heads); a yellow fill says "chosen" (a shortlisted company, a picked preset).
     It never colours text, and it never marks a company as better. */
  --mark: #ffd84a;
  --mark-deep: #e7b71f;
  --mark-soft: rgba(255, 216, 74, 0.38);
  --wash: rgba(255, 216, 74, 0.16);
  /* The highlight under a phrase: full yellow on white; on the dark ground a lower yellow keeps light text readable. */
  --hl: var(--mark);

  /* Actions are ink, as on the site's buttons. */
  --accent: #111111;
  --accent-hover: #000000;
  --on-accent: #ffffff;
  --accent-soft: rgba(255, 216, 74, 0.22);
  /* Uncertainty needs its own voice, and not the yellow: a restrained clay, always with words. */
  --warn-bg: #fbf3ef;
  --warn-ink: #7a3a22;
  --warn-rule: #e8cdbf;

  --sans: Inter, "Inter Fallback", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "DM Mono", "DM Mono Fallback", ui-monospace, SFMono-Regular, Menlo, monospace;

  /* One ladder of space: 2 / 6 for the inside of a pill only, then 4 8 12 16 24 32 48. */
  --s0: 0.125rem;
  --s0h: 0.375rem;
  --s1: 0.25rem;
  --s2: 0.5rem;
  --s3: 0.75rem;
  --s4: 1rem;
  --s5: 1.5rem;
  --s6: 2rem;
  --s7: 3rem;

  /* One ladder of type. Headline 28-44px, section heads 16-17px mono, company names 17-18px,
     reading text 15-16px, labels 13-14px. Nothing a reader needs is set below 13px; the map's
     cells, folded away, are the one exception at 12px. */
  --t-hero: clamp(1.75rem, 3.6vw, 2.5rem);
  --t-lede: clamp(1rem, 1.6vw, 1.0625rem);
  --t-stat: 1.6rem;
  --t-section: 1.04rem;
  --t-name: 1.125rem;
  --t-h: 1.0625rem;
  --t-body: 1rem;
  --t-sm: 0.9375rem;
  --t-xs: 0.8125rem;
  --t-micro: 0.8125rem;
  --t-nano: 0.75rem;

  --measure: 70ch;
  --radius: 4px;
  --radius-lg: 12px;
  --page: 72rem;
  --focus: 0 0 0 3px var(--mark);
  --shadow: 0 1px 2px rgba(40, 36, 24, 0.06), 0 8px 24px rgba(40, 36, 24, 0.08);
}
/* rohitrao.in has no dark theme; this one keeps its ink, hairline and yellow, turned over. */
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #111111;
    --raise: #1a1a19;
    --sunk: #1f1f1d;
    --ink: #f4f3ef;
    --body-ink: #cfccc5;
    --muted: #a6a39c;
    --rule: #2b2a27;
    --rule-strong: #45433f;
    --mark-soft: rgba(255, 216, 74, 0.28);
    --wash: rgba(255, 216, 74, 0.05);
    --hl: rgba(255, 216, 74, 0.42);
    --accent: #f4f3ef;
    --accent-hover: #ffffff;
    --on-accent: #111111;
    --accent-soft: rgba(255, 216, 74, 0.14);
    --warn-bg: #2a1d17;
    --warn-ink: #f1b9a0;
    --warn-rule: #5a3526;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.35);
  }
}

* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  padding: 0;
  /* The site's wash: white at the top, warming to a pale yellow a screen down, then fading out. */
  background: linear-gradient(180deg, transparent 0, transparent 14rem, var(--wash) 36rem, transparent 90rem) no-repeat, var(--paper);
  color: var(--ink);
  font-family: var(--sans);
  font-size: var(--t-body);
  line-height: 1.6;
  letter-spacing: -0.003em;
  -webkit-font-smoothing: antialiased;
  /* Scraped names and labels can be long and unbroken; never let one scroll the page. */
  overflow-wrap: break-word;
}
.wrap { max-width: var(--page); margin: 0 auto; padding: var(--s5) var(--s4) var(--s7); }
a { color: inherit; }
h1, h2, h3 { line-height: 1.2; letter-spacing: -0.02em; }
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
  font-size: var(--t-xs);
  font-weight: 400;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0 0 var(--s2);
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


/* The findings: the page's argument, numbered, each number a link to its proof. */
.findings { margin: 0 0 var(--s6); }
.finding-list { margin: 0; padding: 0; list-style: none; counter-reset: finding; display: grid; gap: var(--s4); max-width: var(--measure); }
.finding-list li { counter-increment: finding; position: relative; padding-left: var(--s6); line-height: 1.55; }
.finding-list li::before { content: counter(finding); position: absolute; left: 0; top: 0.1em; font-family: var(--mono); font-size: var(--t-xs); color: var(--muted); }
.finding-list strong { font-weight: 600; }
.finding-list a { color: var(--ink); font-weight: 500; text-decoration: none; box-shadow: inset 0 -0.34em 0 var(--mark-soft); }
.finding-list a:hover { box-shadow: inset 0 -0.34em 0 var(--mark); }
/* Only rendered when it is not zero, so this is always news. */
.fresh { font-size: var(--t-xs); color: var(--muted); margin: var(--s4) 0 0; }
.funnel-note { color: var(--muted); font-size: var(--t-xs); max-width: var(--measure); margin: var(--s5) 0 0; }

/* section furniture */
section { margin: 0 0 var(--s7); }
/* Everything that is not the list gets the quiet head: a label on a rule. */
/* Section heads as the site sets them: DM Mono on a short, thick yellow rule. */
section > h2, .section-h {
  display: table;
  font-family: var(--mono);
  font-size: var(--t-section);
  font-weight: 500;
  letter-spacing: 0.01em;
  color: var(--ink);
  margin: 0 0 var(--s4);
  padding-bottom: 7px;
  border-bottom: 3px solid var(--mark);
}
/* The list is the page. Its head is the one that reads as a heading rather than as
   furniture — every section looking equally important is how a product reads as a
   report. */

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
/* Wide enough for a sub-sector's name to read on a phone too, now that the map never folds. */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: var(--s1); }
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
.since { font-size: var(--t-sm); margin: var(--s3) 0 0; padding: var(--s2) var(--s3); border-left: 3px solid var(--mark); background: var(--raise); }
.hide-seen .company.is-seen { display: none; }
.only-new .company:not(.is-new) { display: none; }
.company.is-new .row-main h3::after { content: 'added since your last visit'; font-size: var(--t-xs); font-weight: 600; letter-spacing: 0; color: #111111; margin-left: var(--s2); padding: 0 var(--s0h); background: var(--mark); border-radius: 3px; vertical-align: middle; }
/* The map leads the page and is the control: sector names are links, cells filter. */
.coverage { margin: var(--s6) 0 var(--s5); }
.coverage .widget-head { margin-bottom: var(--s3); }
.sector-n { font-family: var(--mono); font-size: var(--t-micro); color: var(--muted); font-variant-numeric: tabular-nums; }
.sector-link { color: inherit; text-decoration: none; display: inline-flex; align-items: center; gap: var(--s1); }
.sector-link:hover, .sector-link.active { text-decoration: underline; text-underline-offset: 3px; }
.cell.zero { color: var(--muted); }
.cell.zero .cell-n { opacity: 0.55; }
/* The reference half: collapsed, labelled, and set apart from the tool above. */
.reference { margin-top: var(--s7); padding-top: var(--s5); border-top: 2px solid var(--rule-strong); }
.reference > h2 { font-size: var(--t-h); margin: 0 0 var(--s1); }
/* Selected text inverts, in both themes, rather than borrowing the browser's blue. */
::selection { background: var(--mark); color: #111111; }
/* The smallest step is for labels a desktop reader glances at; on a phone it grows a step. */
@media (max-width: 34rem) { :root { --t-nano: var(--t-micro); } }
/* On paper: the rows and what they rest on, in black on white, without the controls. */
@media print {
  :root { --paper: #fff; --raise: #fff; --ink: #000; --muted: #444; --rule: #bbb; --rule-strong: #888; }
  .controls, .breakdown, .results-bar .field-sort, .row-actions, .copy-row, .mark, .ask, .bar-links, script, .device-note { display: none !important; }
  .company { break-inside: avoid; }
  details { display: block; }
  details > summary { list-style: none; }
  a { text-decoration: none; }
  .row-main h3 a::after { content: ' — ' attr(href); font-weight: 400; font-size: var(--t-micro); color: var(--muted); }
}
/* Figures that sit in columns or beside each other keep one width, so counts line up. */
.cell-n, .brow-n, .result-line strong, .count, .trace-n, .finding-list strong, .panel-meta strong { font-variant-numeric: tabular-nums; }
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
.cell.active { border-color: var(--ink); border-style: solid; background: var(--mark-soft); box-shadow: inset 0 0 0 1px var(--ink); }


.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.active-chips { margin: var(--s2) 0 0; align-items: center; }
.active-chips:empty { display: none; }
/* A chosen filter is a chosen thing, so it takes the yellow fill; its × takes it away. */
.filter-chip { color: #111111; background: var(--mark); border-color: var(--mark); border-radius: 3px; font-weight: 600; }
.filter-chip span { margin-left: var(--s1); font-weight: 400; }
a.chip.filter-chip:hover { border-color: #111111; }
.clear { font-size: var(--t-xs); color: var(--muted); }
.result-line { margin: 0; font-size: var(--t-sm); color: var(--ink); }
.result-line strong { font-size: var(--t-name); color: var(--ink); font-weight: 600; }
.result-line a, .linkish { color: var(--ink); text-decoration: none; box-shadow: inset 0 -0.3em 0 var(--mark-soft); }
.result-line a:hover, .linkish:hover { box-shadow: inset 0 -0.3em 0 var(--hl); }
.bar-links { display: flex; flex-wrap: wrap; gap: var(--s3); }
.linkish { font: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
.linkish[aria-pressed='true'] { font-weight: 600; box-shadow: inset 0 -0.3em 0 var(--hl); }
.export { color: var(--muted); text-decoration-color: var(--rule-strong); text-underline-offset: 3px; }
.export:hover { color: var(--ink); text-decoration-color: currentColor; }
.device-note { font-size: var(--t-xs); color: var(--muted); margin: 0 0 var(--s3); }
.device-note strong { color: var(--ink); font-weight: 500; }

/* rows: dense, and different at a glance by what is known */
.company {
  display: flex;
  gap: var(--s5);
  padding: var(--s3) var(--s3);
  margin-inline: calc(var(--s3) * -1);
  border-bottom: 1px solid var(--rule);
}
/* The notebook's rows are the older shape, stacked rather than main-and-side. */
.company:not(:has(> .row-main)) { display: block; padding-block: var(--s4); }
/* Clear of the sticky bar when a link or "back to results" lands on a row. */

.row-main { flex: 1 1 auto; min-width: 0; }
.row-main h3 { font-size: var(--t-name); font-weight: 700; margin: 0 0 var(--s1); line-height: 1.3; letter-spacing: -0.025em; }
/* The company name takes the site's heading highlight when its row is pointed at or focused. */
.row-main h3 a { text-decoration: none; transition: box-shadow 160ms ease-out; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.company:hover .row-main h3 a, .row-main h3 a:focus-visible { box-shadow: inset 0 -0.42em 0 var(--hl); }
.company .builds {
  font-size: var(--t-sm);
  line-height: 1.5;
  margin: 0 0 var(--s0);
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

.row-side {
  /* A fixed width, so every row's name and description start and end on the same lines, and
     the shortlist button is always in the same place. */
  flex: 0 0 9.5rem;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--s2);
  font-size: var(--t-xs);
  color: var(--muted);
}
.row-actions { display: flex; }
.row-actions[hidden] { display: none; }
.row-tools { display: flex; flex-direction: column; align-items: flex-start; gap: var(--s1); }
.mark {
  font: inherit;
  font-size: var(--t-xs);
  padding: var(--s1) var(--s2);
  border: 0;
  background: none;
  color: var(--muted);
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: var(--rule-strong);
  text-underline-offset: 3px;
}
.mark:hover { color: var(--ink); text-decoration-color: currentColor; }
.mark[aria-pressed='true'] { color: var(--ink); font-weight: 600; text-decoration: none; }
/* The row's one action: outlined until chosen, filled once it is. Same place on every row. */
.row-side .mark.mark-shortlist { width: 100%; }
/* Set like the site's buttons: ink outline, small caps-height uppercase, tracked. */
.mark.mark-shortlist {
  min-height: 38px;
  padding: var(--s1) var(--s3);
  font-family: var(--sans);
  font-size: var(--t-xs);
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  text-decoration: none;
  color: var(--ink);
  background: var(--raise);
  border: 1px solid var(--ink);
  border-radius: var(--radius);
}
.mark.mark-shortlist:hover { background: var(--mark-soft); color: var(--ink); border-color: var(--ink); }
.mark.mark-shortlist[aria-pressed='true'] { background: var(--mark); color: #111111; border-color: var(--mark-deep); }
.mark.mark-shortlist[aria-pressed='true']::before { content: '✓ '; }
/* Seen dims and stays where it was, so the list does not shift under a reader. */
.company.is-seen .row-main { opacity: 0.5; }
.company.is-passed { display: none; }
.show-passed .company.is-passed { display: flex; opacity: 0.45; }
@media (max-width: 34rem) {
  .company { flex-direction: column; gap: var(--s2); }
  .row-side { flex: 0 0 auto; flex-direction: row; align-items: center; flex-wrap: wrap; gap: var(--s2) var(--s3); }
  .row-actions { flex: 0 0 auto; }
  .mark.mark-shortlist { width: auto; min-width: 8.5rem; }
  /* The name already opens the company; on a phone the row keeps its three actions on one line. */
  .row-tools .view-evidence { display: none; }
  .row-tools { flex-direction: row; flex-wrap: wrap; align-items: center; gap: 0 var(--s3); }
}



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
.company:focus-within { background: var(--accent-soft); }
.company:target { background: var(--raise); box-shadow: inset 3px 0 0 var(--mark); }
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
  font-size: var(--t-xs);
  color: var(--muted);
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
.finding-lead { font-size: var(--t-body); }
.finding-lead a { color: inherit; }
.f-kind { font-weight: 500; }
.f-stage { font-weight: 500; }
.f-age.undated { color: var(--muted); font-style: italic; }
.trail { margin: 0; font-size: var(--t-xs); color: var(--muted); display: flex; flex-wrap: wrap; align-items: baseline; gap: 0; }
.trail .t { color: var(--muted); text-decoration-color: var(--rule-strong); text-underline-offset: 3px; }
.trail a.t:hover { color: var(--ink); }
.trail .f-city::before { content: '·'; margin: 0 var(--s2); }
.trail .none { font-style: italic; }
.row-side { flex: 0 0 auto; }

.about-upstream { font-size: var(--t-sm); color: var(--muted); margin: 0 0 var(--s3); }
.about-upstream a { color: var(--ink); }
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

.fact-site { color: var(--ink); text-decoration-color: var(--rule-strong); text-underline-offset: 3px; }
.fact-site:hover { text-decoration-color: currentColor; }
/* the widget row: the population in view, five ways, in the coverage map's cells */
/* The share of the records in view, as a hairline along the cell's foot. A proportion
   drawn in ink, not a colour: the yellow stays spent on what nobody has noticed. */
/* The map beside the tiles on a wide screen, above them on a phone. Capped, so a state is
   big enough to hit and the list is not pushed a screen down to make room for Kashmir. */
.who { margin: 0; display: grid; gap: var(--s3); }
.who > div { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0 var(--s4); }
@media (min-width: 46rem) { .who > div { grid-template-columns: 11rem minmax(0, 1fr); } .who .why { grid-column: 2; } }
.who dt { font-size: var(--t-xs); color: var(--muted); }
.who dd { margin: 0; overflow-wrap: anywhere; }
.who dd.why { font-size: var(--t-xs); color: var(--muted); }
.papers { margin-top: var(--s4); }
.paper-list { margin: var(--s2) 0 0; padding-left: var(--s4); font-size: var(--t-sm); }
.paper-list li { margin-bottom: var(--s1); }
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
.note strong { color: var(--ink); font-weight: 500; }
.place { border: 1px solid var(--rule); padding: 2px var(--s1); color: var(--ink); text-decoration: none; font-size: var(--t-xs); white-space: nowrap; }
.place:hover { border-color: var(--rule-strong); }
.place.on { border-color: var(--ink); background: var(--raise); }
.place.unknown { border-style: dashed; color: var(--muted); }
.freshness { font-size: var(--t-xs); color: var(--muted); margin: var(--s2) 0 0; }
.freshness strong { color: var(--ink); }
.entity-tag { color: var(--muted); font-size: 0.8em; font-weight: normal; white-space: nowrap; }
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


/* one company */
.detail section { margin-bottom: var(--s6); }

.detail .masthead h1 { max-width: 20ch; }
.detail .eyebrow a { text-decoration: none; }
.detail .eyebrow a:hover { color: var(--ink); }
/* Why a thing is what it is. Muted, because it is always explaining something else
   on the page rather than being the thing itself. */
.provenance { font-size: var(--t-sm); color: var(--muted); max-width: var(--measure); }
/* The dated figure set. Wide cells of prose, so it scrolls rather than crushes on a phone. */
.snapshot { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: var(--t-sm); display: block; overflow-x: auto; }
.snapshot th, .snapshot td { text-align: left; vertical-align: top; padding: 0.55rem 0.75rem 0.55rem 0; border-bottom: 1px solid var(--rule); }
.snapshot thead th { font-size: var(--t-xs); text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); white-space: nowrap; }
.snapshot tbody th { white-space: nowrap; font-weight: 600; }
.snapshot td.snap-n { font-family: var(--mono); white-space: nowrap; font-variant-numeric: tabular-nums; }
.snapshot td:last-child { color: var(--muted); min-width: 22rem; }
.cells-caveat { margin-top: 0.5rem; }
/* A limit the reader has to see, not one they have to go looking for. */
.unvalidated { font-size: var(--t-sm); color: var(--ink); max-width: var(--measure);
  border-left: 3px solid var(--rule-strong); padding: 0.1rem 0 0.1rem 0.85rem; margin: 0.9rem 0; }
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
.dates dt { flex: 0 0 9rem; font-size: var(--t-sm); font-weight: 500; color: var(--ink); }
.dates dd { margin: 0; font-family: var(--mono); font-size: var(--t-sm); }
.dates dd.why { font-family: var(--sans); font-size: var(--t-xs); color: var(--muted); flex: 1 1 18rem; }


/* the brief */
.actions { display: flex; flex-wrap: wrap; gap: var(--s2); margin: var(--s4) 0 var(--s2); }
.action {
  font: inherit;
  font-size: var(--t-xs);
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: var(--s2) var(--s4);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  background: var(--raise);
  color: var(--ink);
  cursor: pointer;
}
.action:hover { border-color: var(--ink); background: var(--mark-soft); }
.action.mark-shortlist { min-height: 44px; padding: var(--s2) var(--s5); }
.copy-row { font: inherit; font-size: var(--t-xs); color: var(--ink); background: none; border: 1px solid var(--rule-strong); border-radius: 999px; padding: var(--s0) var(--s2); cursor: pointer; white-space: nowrap; }
.copy-row:hover { border-color: var(--ink); }
.action.action-quiet[aria-pressed='true'] { background: var(--sunk); color: var(--ink); border-color: var(--ink); text-decoration: none; }
.action.action-quiet { color: var(--ink); text-decoration: none; border: 1px solid var(--rule-strong); border-radius: var(--radius); padding: var(--s2) var(--s4); font-size: var(--t-xs); }
.brief-fold { margin-top: var(--s2); font-size: var(--t-xs); color: var(--muted); }
.brief-fold summary { cursor: pointer; }
.brief-fold textarea { margin-top: var(--s2); font-family: var(--mono); font-size: var(--t-xs); }
.mini { font-size: var(--t-sm); color: var(--ink); font-weight: 600; margin: 0 0 var(--s2); }
/* Unknown is a value, and gets the weight of one. */
.unknown-value { font-weight: 600; margin: 0 0 var(--s2); }
.unknown-inline { font-style: italic; }
.unknown-list { list-style: none; margin: 0; padding: 0; }
.unknown-list li { padding: var(--s2) 0; border-bottom: 1px solid var(--rule); font-size: var(--t-sm); color: var(--muted); }
.unknown-list li strong { color: var(--ink); font-weight: 600; }
.table-scroll { overflow-x: auto; }
.evidence-table { width: 100%; border-collapse: collapse; font-size: var(--t-sm); }
.evidence-table th { text-align: left; font-family: var(--mono); font-size: var(--t-xs); letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 400; padding: var(--s2) var(--s3) var(--s2) 0; border-bottom: 1px solid var(--rule-strong); }
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
.method a { color: var(--ink); text-decoration: none; box-shadow: inset 0 -0.3em 0 var(--mark-soft); }
.rules { list-style: none; margin: 0 0 var(--s4); padding: 0; }
.rules li { margin-bottom: var(--s0h); display: flex; gap: var(--s2); align-items: baseline; }
.rules .tier { flex: 0 0 auto; }

/* --- the workspace: navigation, the start, results, and the company brief ---
   Drawn in rohitrao.in's language: Inter set tight for what you read, DM Mono for what you
   navigate by, a hairline for structure, and yellow only as an underline or a chosen fill. */
.topnav { position: relative; background: var(--paper); border-bottom: 1px solid var(--rule); }
.topnav-inner { max-width: var(--page); margin: 0 auto; padding: 0 var(--s4); display: flex; flex-wrap: wrap; align-items: center; gap: 0 var(--s5); min-height: 52px; }
.brand { font-family: var(--mono); font-weight: 700; font-size: var(--t-body); letter-spacing: 0.01em; color: var(--muted); text-decoration: none; display: inline-flex; align-items: center; min-height: 44px; }
.brand::after { content: '.'; color: var(--mark-deep); }
.brand:hover { color: var(--ink); }
.topnav-links { list-style: none; margin: 0 0 0 auto; padding: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0 var(--s5); font-family: var(--mono); font-size: 0.86rem; text-transform: uppercase; letter-spacing: 0.01em; }
.topnav-links a { display: inline-flex; align-items: center; gap: var(--s2); min-height: 44px; color: var(--muted); text-decoration: none; }
.topnav-links a { background-image: linear-gradient(var(--mark), var(--mark)); background-size: 0 2px; background-repeat: no-repeat; background-position: 0 calc(100% - 9px); }
.topnav-links a:hover { color: var(--ink); background-size: 100% 2px; }
.topnav-links a[aria-current='page'] { color: var(--ink); background-size: 100% 2px; }
/* The shortlist is the nav's one call to action, set the way the site sets "Get in touch". */
.nav-shortlist { font-family: var(--sans); font-weight: 600; letter-spacing: 0.14em; color: var(--ink) !important; }
.nav-count { display: inline-block; min-width: 1.6em; padding: 0 var(--s0h); border-radius: 3px; background: var(--mark); color: #111111; font-family: var(--sans); font-size: var(--t-xs); font-weight: 700; letter-spacing: 0; line-height: 1.5; text-align: center; font-variant-numeric: tabular-nums; }
.shortlist-empty { max-width: var(--page); margin: 0 auto; padding: var(--s2) var(--s4); font-size: var(--t-sm); background: var(--accent-soft); border-top: 1px solid var(--rule); }
.intro { margin: 0 0 var(--s2); padding: 0 0 var(--s3); border-bottom: 2px solid var(--ink); }
.intro h1 { font-size: var(--t-hero); line-height: 1.08; letter-spacing: -0.04em; font-weight: 700; color: var(--ink); margin: 0 0 var(--s2); max-width: 32ch; text-wrap: balance; }
.lede { font-size: var(--t-lede); color: var(--body-ink); margin: 0 0 var(--s2); max-width: 64ch; }
/* The three things the page lets you do, highlighted the way the site highlights its own. */
.hl { color: var(--ink); box-shadow: inset 0 -0.36em 0 var(--hl); -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.coverage-line { font-family: var(--mono); font-size: var(--t-xs); color: var(--muted); margin: 0; max-width: none; }
.coverage-line strong { color: var(--ink); font-weight: 500; font-variant-numeric: tabular-nums; }
/* Links that take you somewhere: mono, ink, on a yellow underline. */
.coverage-line a, .about-results a, .page-foot a, .crumb a, .about-upstream a, .toc a, .example, .export, .toast a, .lede a, .shortlist-empty a {
  font-family: var(--mono); color: var(--ink); text-decoration: none; box-shadow: inset 0 -0.3em 0 var(--hl); padding-inline: 1px;
  transition: box-shadow 160ms ease-out;
}
.coverage-line a:hover, .about-results a:hover, .page-foot a:hover, .crumb a:hover, .about-upstream a:hover, .toc a:hover, .example:hover, .export:hover, .toast a:hover, .lede a:hover { box-shadow: inset 0 -1.2em 0 var(--mark); color: #111111; }
.quick { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s2); margin: 0 0 var(--s2); font-size: var(--t-xs); }
.quick-label { font-family: var(--mono); color: var(--muted); }
.quick-or { margin-left: var(--s3); }
.quick .sep { margin-left: calc(-1 * var(--s2)); color: var(--muted); }
/* Presets are the site's tags: a soft yellow until chosen, full yellow once they are. */
.preset { display: inline-flex; align-items: center; min-height: 30px; padding: 0 var(--s3); border-radius: 3px; background: var(--mark-soft); color: var(--ink); font-weight: 600; text-decoration: none; }
.preset:hover { background: var(--mark); color: #111111; }
.preset.active { background: var(--mark); color: #111111; }
.preset.active::before { content: '✓'; margin-right: var(--s1); }
html, body { overflow-x: clip; }
.result-line strong { font-size: 1.125rem; font-weight: 700; letter-spacing: -0.02em; }
.sort-note { margin: 0; font-size: var(--t-xs); color: var(--muted); }
.about-results { margin: 0; }
.result-parts strong { color: var(--ink); }
.about-results > summary { cursor: pointer; display: inline-flex; align-items: center; min-height: 28px; font-family: var(--mono); color: var(--ink); font-size: var(--t-xs); list-style: none; }
.about-results > summary::-webkit-details-marker { display: none; }
.about-results-body { padding: var(--s2) 0 var(--s1) var(--s4); border-left: 3px solid var(--mark); font-size: var(--t-xs); color: var(--body-ink); }
.about-results-body p { margin: 0 0 var(--s2); }
.bar-links { align-items: center; padding-top: var(--s1); }
.export { font-size: var(--t-xs); letter-spacing: 0.12em; text-transform: uppercase; }
.toast { position: fixed; left: 0; right: 0; bottom: calc(var(--s4) + env(safe-area-inset-bottom, 0px)); width: min(40rem, calc(100vw - 2rem)); z-index: 20; margin: 0 auto; padding: var(--s2) var(--s3); border: 1px solid var(--rule); border-left: 4px solid var(--mark); border-radius: var(--radius); background: var(--raise); box-shadow: var(--shadow); font-size: var(--t-sm); }
.toast a { margin-left: var(--s1); }
.context-row, .evidence-row { display: block; max-width: none; margin: var(--s1) 0 0; font-size: var(--t-xs); line-height: 1.6; color: var(--muted); }
.context-row > span:not(:last-child)::after, .evidence-row > span:not(:last-child)::after { content: '·'; margin: 0 var(--s2); color: var(--muted); }
.context-row { margin-top: var(--s1); }
/* The sub-sector is the one tag on a row, in the site's soft yellow. */
.f-sub { display: inline-block; padding: 0 var(--s0h); border-radius: 3px; background: var(--mark-soft); color: var(--ink); font-weight: 600; line-height: 1.6; }
.context-row > .f-sub:not(:last-child)::after { content: none; }
.context-row > .f-sub { margin-right: var(--s2); }
.f-kind, .f-stage { color: var(--body-ink); }
.f-listed .t { color: var(--ink); text-decoration: none; box-shadow: inset 0 -0.3em 0 var(--mark-soft); }
.f-listed a.t:hover { box-shadow: inset 0 -0.3em 0 var(--hl); }
.company .says { display: none; }
.company .builds { color: var(--body-ink); }
.view-evidence { font-family: var(--mono); font-size: var(--t-xs); color: var(--ink); text-decoration: none; padding: var(--s1) var(--s2); }
.view-evidence:hover { box-shadow: inset 0 -0.3em 0 var(--hl); }
.row-tools .mark, .row-tools .copy-row { font-family: var(--mono); font-size: var(--t-xs); border: 0; background: none; padding: var(--s1) var(--s2); color: var(--muted); text-decoration: none; border-radius: 0; }
.row-tools .mark:hover, .row-tools .copy-row:hover { color: var(--ink); }
.row-tools .mark[aria-pressed='true'] { color: var(--ink); }
.row-tools .mark[aria-pressed='true']::before { content: '✓ '; }
.caution { font-size: var(--t-sm); margin: var(--s3) 0; padding: var(--s2) var(--s3); background: var(--warn-bg); color: var(--warn-ink); border: 1px solid var(--warn-rule); border-radius: var(--radius); max-width: var(--measure); }
.caution strong { font-weight: 700; }
.page-foot { margin-top: var(--s7); padding-top: var(--s4); border-top: 2px solid var(--ink); font-family: var(--mono); font-size: var(--t-xs); color: var(--muted); }
.crumb { font-size: var(--t-xs); margin: 0 0 var(--s4); }
.company-head { margin: 0 0 var(--s6); padding-bottom: var(--s5); border-bottom: 2px solid var(--ink); }
.company-head h1 { font-size: var(--t-hero); line-height: 1.06; letter-spacing: -0.04em; font-weight: 700; margin: 0 0 var(--s3); max-width: 28ch; }
.company-head .builds-lead { font-size: 1.125rem; line-height: 1.6; color: var(--ink); margin: 0 0 var(--s1); }
.company-head .desc { font-size: 1.0625rem; color: var(--ink); line-height: 1.6; }
.company-head .facts { display: block; margin: var(--s3) 0 0; font-size: var(--t-sm); color: var(--muted); }
.company-head .facts > * { white-space: nowrap; }
.company-head .facts > *:not(:last-child)::after { content: '·'; display: inline-block; margin: 0 var(--s2); color: var(--muted); }
.fact-sub { display: inline-block; padding: 0 var(--s2); border-radius: 3px; background: var(--mark-soft); color: var(--ink); font-weight: 600; text-decoration: none; }
.fact-sub:hover { background: var(--mark); color: #111111; }
.company-head .facts > .fact-sub::after { content: none; }
.company-head .facts > .fact-sub { margin-right: var(--s2); }
.fact-site { font-family: var(--mono); text-decoration: none; box-shadow: inset 0 -0.3em 0 var(--mark-soft); }
.about-upstream { font-size: var(--t-xs); color: var(--muted); margin: 0 0 var(--s2); }
.evidence-summary { font-size: var(--t-body); color: var(--body-ink); margin: 0 0 var(--s3); }
.evidence-summary .t { color: var(--ink); text-decoration: none; box-shadow: inset 0 -0.3em 0 var(--hl); }
.method-fold { border-top: 1px solid var(--rule); }
.method-fold:last-child { border-bottom: 1px solid var(--rule); }
.method-fold > summary, .reading > summary, .brief-fold > summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; gap: var(--s2); font-weight: 600; color: var(--ink); list-style: none; }
.method-fold > summary::-webkit-details-marker, .reading > summary::-webkit-details-marker, .brief-fold > summary::-webkit-details-marker { display: none; }
.method-fold > summary::before, .reading > summary::before, .brief-fold > summary::before, .about-results > summary::before { content: '+'; display: inline-block; width: 1em; text-align: center; font-family: var(--mono); color: var(--ink); }
.method-fold[open] > summary::before, .reading[open] > summary::before, .brief-fold[open] > summary::before, .about-results[open] > summary::before { content: '–'; }
.method-fold[open] { padding-bottom: var(--s3); }
.detail .mini { margin-top: var(--s4); }
.toc { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); font-size: var(--t-xs); margin-top: var(--s3); }
.ref-section { margin: 0 0 var(--s7); }
.about .findings { margin: 0; }
.source-status td:first-child { white-space: nowrap; color: var(--ink); font-weight: 500; }
@media (max-width: 34rem) {
  .topnav-inner { gap: 0 var(--s3); flex-wrap: nowrap; }
  .topnav-links { gap: 0 var(--s3); flex-wrap: nowrap; white-space: nowrap; font-size: var(--t-xs); }
  .nav-shortlist { letter-spacing: 0.08em; }
  .nav-discover, .nav-long { display: none; }
  .quick { flex-wrap: nowrap; overflow-x: auto; padding-bottom: var(--s1); margin-inline: calc(-1 * var(--s4)); padding-inline: var(--s4); scrollbar-width: none; }
  .quick > * { flex: 0 0 auto; }
  .preset { min-height: 36px; }
}
@media (max-width: 22rem) {
  .topnav-inner { gap: 0 var(--s2); padding-inline: var(--s3); }
  .topnav-links { gap: 0 var(--s2); letter-spacing: 0; }
  .nav-shortlist { letter-spacing: 0.02em; }
  .brand { font-size: var(--t-sm); }
}

/* Controls that need storage or the clipboard hold their place from the first paint (see CAPABILITY_SCRIPT). */
.can-mark .nav-shortlist-item[hidden] { display: list-item; }
.can-mark .row-actions[hidden] { display: flex; }
.can-mark .row-tools .mark[hidden], .can-mark .actions .mark[hidden] { display: inline-block; }
.can-mark .company-head .device-note[hidden] { display: block; }
.can-copy .row-tools .copy-row[hidden], .can-copy .actions .copy-brief[hidden] { display: inline-block; }

/* wider screens */
@media (min-width: 46rem) {
  .wrap { padding: var(--s5) var(--s6) calc(var(--s7) * 1.5); }
  .company { padding-inline: var(--s4); margin-inline: calc(var(--s4) * -1); }
}

/* The radio inputs behind the segmented control are visually hidden but still
   focusable, so the focus ring has to be drawn on the label. */
a:focus-visible, select:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

/* the breakdown: the RDI map across the width, three panels under it, every count a filter */
.breakdown { margin: var(--s5) 0 var(--s4); display: grid; gap: var(--s5); }
.breakdown[hidden] { display: none; }
.coverage, .panel { min-width: 0; margin: 0; border-top: 1px solid var(--rule-strong); padding-top: var(--s3); }
.panel-head { margin: 0 0 var(--s3); }
.panel-head h2 { font-size: var(--t-h); font-weight: 700; line-height: 1.3; margin: 0 0 var(--s1); color: var(--ink); }
.panel-kicker { font-family: var(--mono); font-size: var(--t-xs); font-weight: 500; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); margin-left: var(--s2); white-space: nowrap; }
.panel-meta { margin: 0 0 var(--s2); font-size: var(--t-xs); color: var(--muted); max-width: var(--measure); }
.panel-meta strong { color: var(--ink); font-weight: 500; }
.panel-legend { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s1) var(--s2); margin: 0 0 var(--s2); font-size: var(--t-xs); color: var(--muted); max-width: none; }
.legend-cell { display: inline-block; width: 1.25em; height: 0.9em; border-radius: 2px; border: 1px dashed var(--rule-strong); }
.legend-on { border: 2px solid var(--ink); background: var(--mark-soft); }
.sector.chosen > h3 { color: var(--ink); }
.panel-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s5); }
@media (min-width: 46rem) { .panel-row { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.brows { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s1); }
.brow { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: var(--s2); min-height: 36px; padding: var(--s1) var(--s2); border: 1px solid var(--rule); border-radius: var(--radius); color: var(--ink); text-decoration: none; font-size: var(--t-sm); line-height: 1.3; overflow: hidden; }
a.brow { background: var(--raise); border-color: color-mix(in srgb, var(--ink) 22%, transparent); }
a.brow:hover { border-color: color-mix(in srgb, var(--ink) 45%, transparent); }
.brow.active { border-color: var(--ink); background: var(--mark-soft); box-shadow: inset 0 0 0 1px var(--ink); font-weight: 600; }
.brow.zero { color: var(--muted); border-style: dashed; }
.brow-name { grid-column: 1; grid-row: 1; min-width: 0; overflow-wrap: anywhere; }
.brow-n { grid-column: 2; grid-row: 1; font-family: var(--mono); font-size: var(--t-xs); }
.brow-when { grid-column: 1 / -1; grid-row: 2; font-size: var(--t-nano); color: var(--muted); }
.brow-when .failing { color: var(--ink); font-weight: 500; }
.brow .share { position: absolute; left: 0; bottom: 0; height: 3px; background: var(--mark-deep); opacity: 0.85; }

/* the filters: one spacing scale (--s*), one control height, each label on its control's left edge */
:root { --control-h: 40px; }
@media (max-width: 34rem) { :root { --control-h: 44px; } }
.controls { display: grid; gap: var(--s4); margin: var(--s5) 0 var(--s4); }
.field { display: flex; flex-direction: column; align-items: stretch; gap: var(--s1); min-width: 0; }
.field > label { font-size: var(--t-sm); font-weight: 600; line-height: 1.3; color: var(--ink); }
.field-hint { margin: 0; font-size: var(--t-xs); line-height: 1.4; color: var(--muted); }
.field-hint a { color: inherit; text-underline-offset: 3px; }
select, input[type='search'], .search-clear, .more-filters > summary, .apply { box-sizing: border-box; height: var(--control-h); min-height: var(--control-h); font: inherit; font-size: var(--t-sm); border-radius: var(--radius); }
select { width: 100%; max-width: 100%; min-width: 0; padding: 0 var(--s3); color: inherit; background: var(--raise); border: 1px solid var(--rule-strong); text-overflow: ellipsis; }
select:hover { border-color: var(--ink); }
.search-row { display: flex; gap: var(--s2); }
input[type='search'] { flex: 1 1 auto; width: 100%; min-width: 0; padding: 0 var(--s3); color: inherit; background: var(--raise); border: 1px solid var(--ink); }
input[type='search']::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; display: none; }
input[type='search']::placeholder { color: var(--muted); opacity: 1; }
.search-clear { flex: 0 0 var(--control-h); display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--rule-strong); background: var(--raise); color: var(--ink); font-size: 1.25rem; line-height: 1; text-decoration: none; }
.search-clear[hidden] { display: none; }
.search-clear:hover { border-color: var(--ink); }
.filter-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s3) var(--s4); align-items: start; }
@media (min-width: 34rem) { .filter-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (min-width: 46rem) { .filter-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (min-width: 64rem) { .filter-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
.more-filters > summary { display: inline-flex; align-items: center; gap: var(--s2); padding: 0 var(--s3); border: 1px solid var(--rule-strong); background: var(--raise); font-weight: 600; cursor: pointer; list-style: none; }
.more-filters > summary::-webkit-details-marker { display: none; }
.more-filters > summary::after { content: ''; width: 0.4em; height: 0.4em; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: translateY(-2px) rotate(45deg); }
.more-filters[open] > summary::after { transform: translateY(1px) rotate(-135deg); }
.more-filters > summary:hover { border-color: var(--ink); }
.more-filters[open] > summary { margin-bottom: var(--s3); }
.filter-count { font-variant-numeric: tabular-nums; }
.apply-row { display: flex; }
.apply { padding: 0 var(--s4); border: 1px solid var(--accent); background: var(--accent); color: var(--on-accent); font-weight: 600; cursor: pointer; }
.active-chips { gap: var(--s2); margin: 0 0 var(--s3); }
.active-chips .chip, .active-chips .clear { display: inline-flex; align-items: center; min-height: 32px; }
.active-chips .chip { padding: 0 var(--s3); }
.clear { color: var(--ink); font-size: var(--t-xs); font-weight: 600; text-underline-offset: 3px; }
.results-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s3) var(--s4); padding-top: var(--s3); border-top: 1px solid var(--rule-strong); }
.result-head { flex: 1 1 16rem; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--s3); }
.result-head .about-results[open] { flex-basis: 100%; }
.about-results > summary { white-space: nowrap; }
.results-bar .field-sort { flex: 0 1 18rem; flex-direction: row; align-items: center; gap: var(--s2); }
.results-bar .field-sort label { white-space: nowrap; }
.bar-foot { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: var(--s1) var(--s4); margin: var(--s2) 0 var(--s4); font-size: var(--t-xs); color: var(--muted); }
.row-n { font-family: var(--mono); font-size: var(--t-xs); font-weight: 400; letter-spacing: 0; color: var(--muted); margin-right: var(--s2); font-variant-numeric: tabular-nums; }
@media (max-width: 34rem) {
  /* Still one row on a phone: the count takes what the sort leaves, and the sort box narrows. */
  .results-bar { flex-wrap: nowrap; align-items: flex-start; }
  .result-head { flex: 1 1 0; }
  .results-bar .field-sort { flex: 0 1 11.5rem; }
}

@media (prefers-reduced-motion: no-preference) {
  .cell, .brow, .chip, .apply, .company, select, .mark, .copy-row { transition: border-color 160ms ease-out, background 160ms ease-out, color 160ms ease-out; }
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
/**
 * Run in the head, before anything is drawn: says whether this browser can keep marks and copy, so
 * the controls that need them take their place in the first layout instead of pushing the page
 * down once the scripts at the foot have run.
 */
const CAPABILITY_SCRIPT = `document.documentElement.classList.add('js');try{localStorage.setItem('upstream.probe','1');localStorage.removeItem('upstream.probe');document.documentElement.classList.add('can-mark')}catch(e){}if(navigator.clipboard&&navigator.clipboard.writeText)document.documentElement.classList.add('can-copy')`;

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
  // True only when the browser kept it: a full or blocked store must not read as saved.
  function write(m) {
    if (!store) return false;
    try { store.setItem(KEY, JSON.stringify(m)); return store.getItem(KEY) === JSON.stringify(m); } catch (e) { return false; }
  }
  var base = ${JSON.stringify(BASE_PATH)};
  // The whole shortlist, wherever its companies sit in the list: a view of exactly those ids, over every record.
  function shortlistUrl(ids) { return base + '?described=all&kind=all&age=all&ids=' + encodeURIComponent(ids.slice(0, 500).join(',')) + '#list'; }
  function paintNav() {
    var item = document.querySelector('.nav-shortlist-item');
    if (!item) return;
    item.hidden = !store;
    if (!store) return;
    var ids = Object.keys(read().shortlist);
    var link = item.querySelector('a');
    var count = item.querySelector('.nav-count');
    if (count) count.textContent = String(ids.length);
    link.setAttribute('href', ids.length ? shortlistUrl(ids) : base + '#list');
    link.setAttribute('aria-label', 'Shortlist, ' + ids.length + (ids.length === 1 ? ' company' : ' companies') + ' saved in this browser');
    if (/[?&]ids=/.test(location.search)) link.setAttribute('aria-current', 'page');
  }
  document.addEventListener('click', function (event) {
    var link = event.target.closest ? event.target.closest('a.nav-shortlist') : null;
    if (!link || Object.keys(read().shortlist).length) return;
    event.preventDefault();
    var box = document.getElementById('shortlist-empty');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = 'Your shortlist is empty. Choose <strong>Shortlist</strong> on any company to keep it here &mdash; saved in this browser only. <button type="button" class="linkish" data-act="close-empty">Close</button>';
  });
  document.addEventListener('click', function (event) {
    var b = event.target.closest ? event.target.closest('[data-act="close-empty"]') : null;
    if (b) { var box = document.getElementById('shortlist-empty'); if (box) box.hidden = true; }
  });
  window.upstreamMarks = {
    available: !!store,
    read: read,
    shortlistUrl: shortlistUrl,
    paintNav: paintNav,
    // The new state, or null when the browser refused to keep it.
    toggle: function (kind, id) {
      var m = read();
      if (m[kind][id]) { delete m[kind][id]; }
      else {
        m[kind][id] = Date.now();
        // Shortlisting and passing contradict each other; the newer one wins.
        if (kind === 'pass') delete m.shortlist[id];
        if (kind === 'shortlist') delete m.pass[id];
      }
      if (!write(m)) return null;
      paintNav();
      return !!m[kind][id];
    },
    set: function (kind, id) { var m = read(); if (!m[kind][id]) { m[kind][id] = Date.now(); write(m); } },
    clear: function () { if (store) { try { store.removeItem(KEY); } catch (e) {} } paintNav(); },
    size: function (m) { return Object.keys(m.shortlist).length + Object.keys(m.seen).length + Object.keys(m.pass).length; }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintNav); else paintNav();
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
      // Fetched on the click, not carried by every row: 309 embedded briefs made the list page 1.3MB.
      // The fetch goes to the clipboard as a promise where the browser allows it, so Safari, which
      // wants the write inside the click, still copies.
      var url = button.getAttribute('data-brief');
      if (!url) return;
      var done = function () { button.textContent = 'Copied'; setTimeout(function () { button.textContent = 'Copy brief'; }, 1600); };
      var failed = function () { button.textContent = 'Copy failed'; };
      button.textContent = 'Copying…';
      var text = fetch(url).then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); });
      if (window.ClipboardItem && navigator.clipboard.write) {
        navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then(function (t) { return new Blob([t], { type: 'text/plain' }); }) })]).then(done, function () {
          text.then(function (t) { return navigator.clipboard.writeText(t); }).then(done, failed);
        });
      } else {
        text.then(function (t) { return navigator.clipboard.writeText(t); }).then(done, failed);
      }
    });
  }

  var form = document.getElementById('controls');
  if (!form || !window.fetch || !window.DOMParser || !window.URLSearchParams) return;
  var marks = window.upstreamMarks;
  // "Resume where you left off" is gone; the view it saved would only offer a stale link.
  try { localStorage.removeItem('upstream.lastView'); } catch (e) {}

  // Where "back to results" should go: the view as it is now, canonical spelling.
  function remember() {
    try { sessionStorage.setItem('upstream.results', location.pathname + location.search); } catch (e) {}
  }
  remember();

  // --- marks on rows ---
  var showPassed = false;
  // A short confirmation after a shortlist change, read out by screen readers, with a way to the whole shortlist.
  var toastTimer = null;
  function say(text, action) {
    var toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = text + ' ';
    if (action === 'view') {
      var ids = Object.keys(marks.read().shortlist);
      var a = document.createElement('a');
      a.href = marks.shortlistUrl(ids);
      a.textContent = 'View shortlist (' + ids.length + ')';
      toast.appendChild(a);
    }
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 6000);
  }
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
        var on = !!m[kind][id];
        if (marks.available) buttons[j].hidden = false;
        buttons[j].setAttribute('aria-pressed', on ? 'true' : 'false');
        if (kind === 'shortlist') buttons[j].textContent = on ? 'Shortlisted' : 'Shortlist';
        if (kind === 'seen') buttons[j].textContent = on ? 'Seen' : 'Mark as seen';
      }
    }
    document.body.classList.toggle('show-passed', showPassed);
    document.body.classList.toggle('hide-seen', hideSeen);
    document.body.classList.toggle('only-new', onlyNew);

    // Since the last visit: quiet on a first visit and when nothing below is newer.
    var since = document.getElementById('since');
    if (since && lastVisit) {
      var fresh = 0;
      for (var r = 0; r < rows.length; r++) {
        var added = rows[r].getAttribute('data-added') || '';
        var isNew = added > lastVisit;
        rows[r].classList.toggle('is-new', isNew);
        if (isNew) fresh++;
      }
      since.hidden = fresh === 0;
      if (fresh) {
        var parts = lastVisit.split('-');
        var day = Number(parts[2]) + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(parts[1]) - 1];
        since.innerHTML = 'Added to Upstream since your last visit on ' + day + ': <strong>' + fresh + '</strong> of the records below. '
          + '<button type="button" class="linkish" data-act="only-new" aria-pressed="' + (onlyNew ? 'true' : 'false') + '">' + (onlyNew ? 'Show everything' : 'Show only those') + '</button>';
      }
    }
    var seenCount = Object.keys(m.seen).length;
    var seenToggle = document.querySelector('.seen-toggle');
    if (seenToggle) {
      seenToggle.hidden = !marks.available || seenCount === 0;
      seenToggle.setAttribute('aria-pressed', hideSeen ? 'true' : 'false');
      seenToggle.textContent = hideSeen ? 'Show the ' + seenCount + ' seen' : 'Hide the ' + seenCount + ' seen';
    }
    var exportLink = document.querySelector('.shortlist-export');
    var ids = Object.keys(m.shortlist);
    if (exportLink) {
      exportLink.hidden = !marks.available || ids.length === 0;
      exportLink.textContent = 'Export shortlist (' + ids.length + ')';
      exportLink.setAttribute('href', form.getAttribute('action').split('#')[0] + '/export.csv?described=all&kind=all&tier=all&age=all&ids=' + encodeURIComponent(ids.slice(0, 500).join(',')));
    }

    var line = document.querySelector('.marks-line');
    if (line) {
      line.hidden = passedHere === 0;
      line.innerHTML = passedHere ? ' &middot; <button type="button" class="linkish" data-act="show-passed">' + passedHere + ' passed, ' + (showPassed ? 'shown dimmed' : 'hidden') + '</button>' : '';
    }
    var note = document.getElementById('device-note');
    if (note) {
      var size = marks.size(m);
      note.hidden = !marks.available && false;
      note.innerHTML = marks.available
        ? (size
            ? '<strong>' + Object.keys(m.shortlist).length + '</strong> shortlisted, <strong>' + Object.keys(m.seen).length + '</strong> seen, <strong>' + Object.keys(m.pass).length + '</strong> passed. '
            : '')
          + 'Shortlist and seen marks are saved in this browser only &mdash; not synced, and not visible to anyone else.'
          + (size ? ' <button type="button" class="linkish" data-act="clear-marks">Clear all ' + size + '</button>' : '')
        : 'This browser is not letting the page store anything, so shortlist, seen and pass are off.';
    }
  }
  document.addEventListener('click', function (event) {
    var target = event.target.closest ? event.target.closest('button') : null;
    if (!target) return;
    if (target.classList.contains('mark')) {
      var row = target.closest('li.company');
      if (row) {
        var kind = target.getAttribute('data-mark');
        var state = marks.toggle(kind, row.getAttribute('data-id'));
        paint();
        var name = row.querySelector('h3 a') ? row.querySelector('h3 a').textContent : 'This company';
        if (state === null) say('Could not save: this browser did not keep the change. Nothing was added.', null);
        else if (kind === 'shortlist') say(state ? name + ' added to your shortlist. Saved in this browser.' : name + ' removed from your shortlist.', state ? 'view' : null);
      }
    } else if (target.getAttribute('data-act') === 'show-passed') {
      showPassed = !showPassed; paint();
    } else if (target.getAttribute('data-act') === 'clear-marks') {
      if (window.confirm('Clear every shortlist, seen and pass mark stored on this device?')) { marks.clear(); paint(); }
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
    var link = event.target.closest ? event.target.closest('li.company h3 a, li.company a.view-evidence') : null;
    if (link) { remember(); }
  });

  // --- filters that apply as they change ---
  var sector = form.querySelector('#sector');
  var subsector = form.querySelector('#subsector');
  var search = form.querySelector('#q');
  var slots = ['quick', 'breakdown', 'chips', 'result-line', 'sort-note', 'filter-count', 'q-clear', 'export', 'list', 'undated-slot'];
  var seq = 0;
  function refresh(opts) {
    // form.elements, not the form's children: the sort box sits by the count and joins the form by its form attribute.
    var params = new URLSearchParams();
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.disabled || el.type === 'submit') return;
      if (el.value) params.append(el.name, el.value);
    });
    load(form.getAttribute('action').split('#')[0] + (params.toString() ? '?' + params.toString() : ''), opts);
  }
  // One way to change the view, whether a control changed or a panel count was picked:
  // fetch the page for that url, put its pieces in place, and make the controls say what
  // the server says the view is.
  // opts.history: 'push' (a filter the reader chose, so Back undoes it), 'none' (arriving from Back itself).
  // opts.reveal: bring the result line into view when the change happened out of sight.
  function load(url, opts) {
    opts = opts || {};
    var mine = ++seq;
    var listEl = document.getElementById('list');
    if (listEl) { listEl.classList.add('loading'); listEl.setAttribute('aria-busy', 'true'); }
    fetch(url.split('#')[0], { headers: { accept: 'text/html' } })
      .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.text(); })
      .then(function (html) {
        if (mine !== seq) return;
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var aboutOpen = document.getElementById('about-results') && document.getElementById('about-results').open;
        slots.forEach(function (id) {
          var now = document.getElementById(id), next = doc.getElementById(id);
          if (now && next) now.replaceWith(next);
        });
        // The sub-sector choices follow the sector, so they come from the server too.
        var theirSub = doc.getElementById('subsector');
        if (subsector && theirSub) subsector.innerHTML = theirSub.innerHTML;
        Array.prototype.forEach.call(form.elements, function (mine2) {
          if (!mine2.name) return;
          var theirs = doc.querySelector('[name="' + mine2.name + '"][id="' + mine2.id + '"]') || doc.querySelector('#controls [name="' + mine2.name + '"]');
          if (theirs && !(mine2 === document.activeElement && mine2.id === 'q')) mine2.value = theirs.value;
        });
        // A secondary filter in use keeps "More filters" open; the reader can still open it themselves.
        var more = document.getElementById('more-filters'), theirMore = doc.getElementById('more-filters');
        if (more && theirMore && theirMore.hasAttribute('open')) more.open = true;
        var about = document.getElementById('about-results');
        if (about && aboutOpen) about.open = true;
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
        var stale = document.getElementById('toast');
        if (stale && /could not be updated/.test(stale.textContent)) stale.hidden = true;
        // A view chosen from the panels above starts at its first result, not wherever the page was.
        if (opts.history !== 'none' && opts.reveal) {
          var head = document.querySelector('.results-bar');
          var top = head ? head.getBoundingClientRect().top : 0;
          if (head && (top < 0 || top > window.innerHeight * 0.6)) {
            var smooth = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
            window.scrollTo({ top: Math.max(0, window.scrollY + top - 8), behavior: smooth ? 'smooth' : 'auto' });
          }
        }
      })
      .catch(function (error) {
        if (window.console) console.error(error);
        // The rows on screen stay usable; say the update failed and offer the plain page.
        var toast = document.getElementById('toast');
        if (toast) {
          toast.textContent = 'The list could not be updated. The results shown are from before this change. ';
          var retry = document.createElement('a');
          retry.href = url;
          retry.textContent = 'Try again';
          toast.appendChild(retry);
          toast.hidden = false;
        } else { location.href = url; }
      })
      .then(function () {
        var l = document.getElementById('list');
        if (l) { l.classList.remove('loading'); l.removeAttribute('aria-busy'); }
      });
  }
  // Back and Forward step through the filters the reader chose.
  window.addEventListener('popstate', function () { load(location.pathname + location.search, { history: 'none' }); });
  document.addEventListener('click', function (event) {
    var link = event.target.closest ? event.target.closest('#breakdown a.cell, #breakdown a.sector-link, #breakdown a.brow, #quick a') : null;
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    load(link.getAttribute('href'), { history: 'push', reveal: true });
  });
  // Search runs on Enter (the form's submit). The clear button shows only while there is text.
  function paintClear() {
    var clear = document.getElementById('q-clear');
    if (clear && search) clear.hidden = search.value === '';
  }
  if (search) search.addEventListener('input', paintClear);
  document.addEventListener('click', function (event) {
    var clear = event.target.closest ? event.target.closest('#q-clear') : null;
    if (!clear || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    search.value = '';
    paintClear();
    search.focus();
    refresh({ history: 'push' });
  });
  function changed(event) {
    // A sub-sector belongs to one sector: choosing a sector drops a sub-sector outside it
    // (Any drops it too), and choosing a sub-sector brings its sector along.
    if (event.target === sector && subsector && subsector.value) {
      var chosen = subsector.options[subsector.selectedIndex];
      if (!sector.value || chosen.getAttribute('data-sector') !== sector.value) subsector.value = '';
    }
    if (event.target === subsector && sector && subsector.value) {
      sector.value = subsector.options[subsector.selectedIndex].getAttribute('data-sector') || sector.value;
    }
    if (event.target.id === 'q') return;
    refresh({ history: 'push' });
  }
  form.addEventListener('change', changed);
  var sortBox = document.getElementById('sort');
  if (sortBox && sortBox.form === form && !form.contains(sortBox)) sortBox.addEventListener('change', changed);
  form.addEventListener('submit', function (event) { event.preventDefault(); refresh({ history: 'push' }); });
  // A chip removed, or a link inside the list's own counts, changes the view in place too.
  document.addEventListener('click', function (event) {
    var link = event.target.closest ? event.target.closest('#chips a, #result-line a[href^="/"], #undated a[href^="/"], .empty .ways a, #top-picks a.see-all-none') : null;
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
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
  var note = document.getElementById('device-note');
  function paint() {
    var m = marks.read();
    for (var i = 0; i < buttons.length; i++) {
      var kind = buttons[i].getAttribute('data-mark');
      var on = !!m[kind][id];
      buttons[i].hidden = false;
      buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
      if (kind === 'shortlist') buttons[i].textContent = on ? 'Shortlisted' : 'Shortlist';
      if (kind === 'pass') buttons[i].textContent = on ? 'Passed' : 'Pass';
    }
    if (note) note.hidden = false;
  }
  if (note) note.setAttribute('role', 'status');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener('click', function (event) {
      var kind = event.currentTarget.getAttribute('data-mark');
      var state = marks.toggle(kind, id);
      paint();
      if (!note) return;
      var saved = ' Saved in this browser only &mdash; not synced, and not visible to anyone else.';
      if (state === null) note.innerHTML = '<strong>Could not save.</strong> This browser did not keep the change.';
      else if (kind === 'shortlist' && state) {
        var ids = Object.keys(marks.read().shortlist);
        note.innerHTML = '<strong>Added to your shortlist.</strong>' + saved + ' <a href="' + marks.shortlistUrl(ids) + '">View shortlist (' + ids.length + ')</a>';
      } else if (kind === 'shortlist') note.innerHTML = 'Removed from your shortlist.' + saved;
      else note.innerHTML = (state ? '<strong>Marked as passed.</strong>' : 'Pass removed.') + saved;
    });
  }
  paint();
})();
`;

// --- the page ---------------------------------------------------------------

/** Anchors that lived in the reference half of the list page and now live on /about. */
const MOVED_ANCHORS = ['reference', 'reference-h', 'findings-h', 'off-map', 'off-map-h', 'undescribed', 'undescribed-h', 'register', 'crosswalk', 'method-h'];

/**
 * How the list is built and what it leaves out, on a page of its own: for the reader judging the
 * system rather than using it. It used to ride, collapsed, under every list page (about 50 KB and
 * four aggregate queries a render) for the few readers who opened it.
 */
export function renderAboutPage(view: AboutView): string {
	const fresh =
		view.discoveredThisWeek > 0
			? `<p class="note">${view.discoveredThisWeek} ${view.discoveredThisWeek === 1 ? 'company' : 'companies'} turned up in the last seven days in a source we were already watching. A new source&rsquo;s first read is not counted here.</p>`
			: '';
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coverage &amp; methodology &mdash; Upstream</title>
<meta name="description" content="Which sources Upstream reads, when each was last checked, what the records show, and how the list is ordered and limited.">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/upstream/favicon.svg" type="image/svg+xml">
<link rel="canonical" href="${esc(`${BASE_PATH}/about`)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600;700&display=optional">
<style>${STYLES}</style>
<script>${CAPABILITY_SCRIPT}</script>
</head>
<body>
${nav('about')}
<div class="wrap about">
<header class="intro">
  <p class="eyebrow">Coverage &amp; methodology</p>
  <h1>How the data is collected</h1>
  <p class="lede">Which public sources Upstream reads, when each was last checked, what the records show, and the rules that
    order and limit the list. <a href="${esc(BASE_PATH)}">Back to Discover</a></p>
  <nav class="toc" aria-label="On this page">
    <a href="#snapshot-h">The figures</a> <a href="#sources-h">Sources</a> <a href="#findings-h">What the records show</a> <a href="#funnel-h">Records reaching the list</a> <a href="#outside-map">Outside the map</a> <a href="#method-h">Ranking and limits</a>
  </nav>
</header>
${snapshotSection()}
<section class="ref-section" id="reference" aria-labelledby="sources-h">
  <h2 id="sources-h">Sources and freshness</h2>
  ${sourceStatus(view)}
  ${freshness(view)}
</section>
<section class="ref-section" aria-labelledby="findings-h">
  ${findingsSection(view) || '<h2 id="findings-h">What the records show</h2><p class="provenance">Nothing to report on this data.</p>'}
</section>
<section class="ref-section" aria-labelledby="funnel-h">
  <h2 id="funnel-h">How many records reach the list</h2>
  ${fresh}${funnelNote(view) || '<p class="provenance">Every record held is on the map.</p>'}
</section>
<div class="ref-section" id="outside-map">
  <h2 id="off-map-h-all" class="section-h">Records outside the map</h2>
  ${offMap(view) || '<p class="provenance">None: every record reached an RDI sub-sector.</p>'}
</div>
${methodology(view)}
</div>
<script>${MARKS_SCRIPT}</script>
</body>
</html>`;
}

export function renderPage(view: PageView): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Upstream &mdash; find Indian deep-tech companies to research</title>
<meta name="description" content="Upstream lists Indian deep-tech companies found in incubator, grant and startup-register records, and puts the least-documented first: one incubator listing and no website ranks above a known name with a press cycle.">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/upstream/favicon.svg" type="image/svg+xml">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fbfaf8">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#141310">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Upstream">
<meta property="og:title" content="Upstream — find Indian deep-tech companies worth your next research call">
<meta property="og:description" content="Upstream lists Indian deep-tech companies found in incubator, grant and startup-register records, and puts the least-documented first: one incubator listing and no website ranks above a known name with a press cycle.">
<meta property="og:url" content="${esc(`${view.origin}${BASE_PATH}`)}">
<meta property="og:image" content="${esc(`${view.origin}${BASE_PATH}/og.png`)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
${view.ids || Object.values(viewParams(view)).some(Boolean) ? '<meta name="robots" content="noindex, follow">\n' : ''}<!-- A filtered view is not indexed, and neither is a shortlist. Each is one of a combinatorial
     number of spellings of the same rows, and a crawler walking them costs a cold render each
     (about ten thousand D1 rows). Crawlers still follow the links out to the company pages,
     which are the pages worth indexing. The unfiltered list stays indexable.

     The same list is reachable by several orderings of the same parameters, and by
     parameters sitting at their defaults. This is the one spelling of it. -->
<link rel="canonical" href="${esc(`${BASE_PATH}${query(viewParams(view))}`)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600;700&display=optional">
<style>${STYLES}</style>
<script>${CAPABILITY_SCRIPT}</script>
</head>
<body>
<script>(function(){var h=location.hash.slice(1);if(${JSON.stringify(MOVED_ANCHORS)}.indexOf(h)>=0)location.replace(${JSON.stringify(`${BASE_PATH}/about#`)}+h);})();</script>
${nav('discover')}
<div class="wrap">
${header(view)}
${breakdown(view)}
${askBox(view)}
<main class="tool">
${controls(view)}
<p class="toast" id="toast" role="status" aria-live="polite" hidden></p>
${list(view)}
<div id="undated-slot">${undatedList(view)}</div>
</main>
<footer class="page-foot"><a href="${esc(`${BASE_PATH}/about`)}">Coverage &amp; methodology</a> &middot; public records only &middot; shortlist and marks are saved in this browser</footer>
</div>
<script>${MARKS_SCRIPT}</script>
<script>${LIST_SCRIPT}</script>
${view.ask ? `<script>${ASK_SCRIPT}</script>` : ''}
</body>
</html>`;
}
