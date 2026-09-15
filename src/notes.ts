/**
 * The private notebook. Not part of the page anybody else sees.
 *
 * Three rules this file exists to keep.
 *
 * It is never linked from a public page. A "Notes" link on the company page would be
 * clutter for every visitor and a signpost for the one thing here that is not meant to
 * be read; the address is a bookmark, not a discovery.
 *
 * Its responses are never cacheable. The public pages are served with a public
 * cache-control, and a note-bearing response that inherited that could be stored at an
 * edge and handed to a stranger. Every response from here says private, no-store, and
 * that line is load-bearing rather than tidy.
 *
 * And it shares the stylesheet and nothing else. It is the same product, and it is the
 * one surface where the reader is known.
 */
import { STYLES, BASE_PATH, esc } from './page';
import { SUBSECTOR_BY_ID } from './taxonomy';
import type { Note, NoteWithCompany } from './db';
import type { Company } from './db';
import { registerText } from './db';

/** The only headers a notes response is allowed to go out with. */
export const PRIVATE_HEADERS = {
	'content-type': 'text/html; charset=utf-8',
	'cache-control': 'private, no-store',
	// This page is nobody's business but the owner's; it should not be framed,
	// indexed, or leak its address in a referer on the way out to a company site.
	'x-robots-tag': 'noindex, nofollow',
	'referrer-policy': 'no-referrer',
};

function shell(title: string, email: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<meta name="color-scheme" content="light dark">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Inter:wght@400;500;600&display=optional">
<style>${STYLES}</style>
</head>
<body>
<div class="wrap detail">
  <p class="eyebrow"><a href="${esc(BASE_PATH)}/notes">&larr; Notebook</a> <span class="whoami">${esc(email)}</span></p>
${body}
</div>
</body>
</html>`;
}

function when(iso: string): string {
	return esc(iso.slice(0, 10));
}

/** The notebook: everything written down, most recently touched first. */
export function renderNotebook(notes: NoteWithCompany[], email: string): string {
	const body = notes.length
		? `<ul class="companies">${notes
				.map((note) => {
					const sub = note.subsector_id ? SUBSECTOR_BY_ID.get(note.subsector_id) : undefined;
					// A note whose company has left the list keeps its note and says so,
					// rather than rendering as a row with a blank name.
					const name = note.name ?? `${note.company_id} (no longer on the list)`;
					return `<li class="company">
      <div class="row-head">
        <h3><a href="${esc(`${BASE_PATH}/notes/${note.company_id}`)}">${esc(name)}</a></h3>
        ${sub ? `<span class="rdi">${esc(sub.subsector_id)} ${esc(sub.subsector)}</span>` : ''}
      </div>
      <p class="desc">${esc(note.body)}</p>
      <p class="facts"><span class="fact-seen">written ${when(note.updated_at)}</span></p>
    </li>`;
				})
				.join('')}</ul>`
		: `<p class="provenance">Nothing written down yet. Open any company at
      <code>${esc(BASE_PATH)}/notes/&lt;slug&gt;</code> &mdash; the slug is the last part of its page address.</p>`;

	return shell(
		'Notebook — Upstream',
		email,
		`  <header class="masthead">
    <h1>Notebook</h1>
    <p class="hook">${notes.length} ${notes.length === 1 ? 'note' : 'notes'}. Private to you, never rendered on any public page.</p>
  </header>
  <section>
${body}
  </section>`,
	);
}

/** One company's note, with the company beside it so the note has something to be about. */
export function renderNoteEditor(company: Company | null, companyId: string, note: Note | null, email: string): string {
	const name = company?.name ?? companyId;
	const context = company
		? `<p class="provenance">${
				company.product
					? `${esc(company.product)} <span class="says">in their own words</span>`
					: esc(registerText(company.description, company.dpiit_status) ?? 'No description held.')
			}</p>
    <p class="provenance"><a href="${esc(`${BASE_PATH}/c/${companyId}`)}">Everything we hold about them &rarr;</a></p>`
		: `<p class="provenance">No company with this slug is on the list. A note can still be kept against it.</p>`;

	return shell(
		`${name} — Notebook`,
		email,
		`  <header class="masthead">
    <h1>${esc(name)}</h1>
  </header>
  <section>
    <h2>What we know</h2>
    ${context}
  </section>
  <section>
    <h2>Your note</h2>
    <form method="post" action="${esc(`${BASE_PATH}/notes/${companyId}`)}">
      <textarea name="body" rows="10" placeholder="What you thought, who you asked, what to do next."
        autofocus>${esc(note?.body ?? '')}</textarea>
      <div class="note-actions">
        <button type="submit" class="apply">Save</button>
        ${note ? '<button type="submit" name="delete" value="1" class="clear-button">Delete</button>' : ''}
        ${note ? `<span class="fact-seen">last written ${when(note.updated_at)}</span>` : ''}
      </div>
    </form>
  </section>`,
	);
}
