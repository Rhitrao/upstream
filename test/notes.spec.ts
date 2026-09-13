import { SELF, env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { forgetKeys } from '../src/access';
import fixture from './fixtures/access-key.json';

const ORIGIN = 'https://rohitrao.in';
const AUD = 'test-audience-tag';
const EMAIL = 'owner@example.com';

/**
 * Real RS256 tokens, signed with the throwaway key in test/fixtures and verified
 * against the same key, which vitest.config.mts serves from the stubbed certs
 * endpoint. Nothing here fakes the verification: a test that must fail has to fail in
 * the same code that lets a genuine token through, or it proves nothing.
 */
let signingKey: CryptoKey;

function b64url(input: Uint8Array | string): string {
	const raw = typeof input === 'string' ? input : String.fromCharCode(...input);
	return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function mint(overrides: Record<string, unknown> = {}, key: CryptoKey = signingKey, kid = fixture.kid): Promise<string> {
	const header = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
	const now = Math.floor(Date.now() / 1000);
	const payload = b64url(JSON.stringify({ aud: AUD, email: EMAIL, exp: now + 600, iat: now, ...overrides }));
	const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${payload}`)));
	return `${header}.${payload}.${b64url(signature)}`;
}

beforeAll(async () => {
	signingKey = await crypto.subtle.importKey(
		'jwk',
		fixture.privateJwk as JsonWebKey,
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['sign'],
	);
});

beforeEach(async () => {
	// The verifier caches the team's keys for an hour, which is right in production and
	// would leak one test's state into the next here.
	forgetKeys();
	await env.DB.prepare('DELETE FROM notes').run();
	await env.DB.prepare('DELETE FROM companies').run();
});

async function asOwner(path: string, init: RequestInit = {}, token?: string) {
	return SELF.fetch(`${ORIGIN}${path}`, {
		...init,
		headers: { ...(init.headers ?? {}), 'Cf-Access-Jwt-Assertion': token ?? (await mint()) },
	});
}

describe('the private notebook', () => {
	it('lets a verified owner write, read back and delete a note', async () => {
		const saved = await asOwner('/upstream/notes/verve', {
			method: 'POST',
			body: new URLSearchParams({ body: 'Founder was at IISc. Ask Priya for an intro.' }),
			// Manual, or fetch follows the redirect and reports the page it landed on.
			redirect: 'manual',
		});
		// Redirect after a write, so a refresh does not save again.
		expect(saved.status).toBe(303);
		expect(saved.headers.get('location')).toBe('/upstream/notes/verve');

		expect(await (await asOwner('/upstream/notes/verve')).text()).toContain('Founder was at IISc. Ask Priya for an intro.');
		expect(await (await asOwner('/upstream/notes')).text()).toContain('Ask Priya for an intro');

		await asOwner('/upstream/notes/verve', { method: 'POST', body: new URLSearchParams({ delete: '1' }) });
		expect(await (await asOwner('/upstream/notes')).text()).toContain('Nothing written down yet');
	});

	it('treats an emptied note as a deleted one', async () => {
		await asOwner('/upstream/notes/verve', { method: 'POST', body: new URLSearchParams({ body: 'something' }) });
		await asOwner('/upstream/notes/verve', { method: 'POST', body: new URLSearchParams({ body: '   ' }) });
		// A row with nothing in it would sit in the notebook looking like a bug.
		expect(await (await asOwner('/upstream/notes')).text()).toContain('Nothing written down yet');
	});

	it('refuses a request carrying only the email header Access would have set', async () => {
		// The whole reason src/access.ts verifies a signature. If the header were
		// trusted, this request would be the owner — and anybody could type it.
		const res = await SELF.fetch(`${ORIGIN}/upstream/notes`, {
			headers: { 'Cf-Access-Authenticated-User-Email': EMAIL },
		});
		expect(res.status).toBe(403);
		expect(await res.text()).not.toContain('Notebook');
	});

	it('refuses a token signed by somebody else', async () => {
		const other = (await crypto.subtle.generateKey(
			{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
			true,
			['sign', 'verify'],
		)) as CryptoKeyPair;
		expect((await asOwner('/upstream/notes', {}, await mint({}, other.privateKey))).status).toBe(403);
	});

	it('refuses a token minted for another application on the same team', async () => {
		// Without the audience check, a token from any other Access application on this
		// team would open this one — including an application that lets everybody in.
		expect((await asOwner('/upstream/notes', {}, await mint({ aud: 'some-other-application' }))).status).toBe(403);
	});

	it('refuses an expired token', async () => {
		expect((await asOwner('/upstream/notes', {}, await mint({ exp: Math.floor(Date.now() / 1000) - 5 }))).status).toBe(403);
	});

	it('refuses an unsigned token claiming alg none', async () => {
		const header = b64url(JSON.stringify({ alg: 'none', kid: fixture.kid, typ: 'JWT' }));
		const payload = b64url(JSON.stringify({ aud: AUD, email: EMAIL, exp: Math.floor(Date.now() / 1000) + 600 }));
		expect((await asOwner('/upstream/notes', {}, `${header}.${payload}.`)).status).toBe(403);
	});

	it('refuses a token whose signature does not cover the payload it carries', async () => {
		// The classic: take a valid token and swap the claims, keeping the signature.
		const valid = await mint();
		const [head, , sig] = valid.split('.');
		const swapped = b64url(JSON.stringify({ aud: AUD, email: 'someone-else@example.com', exp: Math.floor(Date.now() / 1000) + 600 }));
		expect((await asOwner('/upstream/notes', {}, `${head}.${swapped}.${sig}`)).status).toBe(403);
	});

	it('never lets a note response be cached by anything in front of it', async () => {
		await asOwner('/upstream/notes/verve', { method: 'POST', body: new URLSearchParams({ body: 'private thought' }) });
		const res = await asOwner('/upstream/notes/verve');
		// The public pages are served with a public cache-control. A note-bearing
		// response that inherited that could be stored at an edge and handed out.
		expect(res.headers.get('cache-control')).toBe('private, no-store');
		expect(res.headers.get('x-robots-tag')).toContain('noindex');
	});

	it('keeps notes off every public surface', async () => {
		await SELF.fetch(`${ORIGIN}/upstream/api/ingest`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'X-Ingest-Key': 'test-ingest-key' },
			body: JSON.stringify({
				source: 'test',
				mode: 'live',
				companies: [{ id: 'verve', name: 'Verve', sector_id: '2', subsector_id: '2.5' }],
			}),
		});
		await asOwner('/upstream/notes/verve', { method: 'POST', body: new URLSearchParams({ body: 'SECRET-THOUGHT' }) });

		for (const path of [
			'/upstream?tier=all&age=all',
			'/upstream/c/verve',
			'/upstream/api/companies?tier=all&age=all',
			'/upstream/export.csv?tier=all&age=all',
		]) {
			expect(await (await SELF.fetch(`${ORIGIN}${path}`)).text()).not.toContain('SECRET-THOUGHT');
		}
	});

	it('does not exist at all until Access is configured', async () => {
		// The shipped state. Before ACCESS_AUD is set there is no Access application in
		// front of this, so a 403 would be advertising an unprotected door — and the
		// deploy that adds this feature must not open one. 404 until configured.
		const aud = env.ACCESS_AUD;
		const team = env.ACCESS_TEAM_DOMAIN;
		try {
			delete (env as Record<string, unknown>).ACCESS_AUD;
			delete (env as Record<string, unknown>).ACCESS_TEAM_DOMAIN;

			for (const path of ['/upstream/notes', '/upstream/notes/verve']) {
				// Even holding a token that would otherwise be perfectly good.
				expect((await asOwner(path)).status).toBe(404);
			}
			const write = await asOwner('/upstream/notes/verve', {
				method: 'POST',
				body: new URLSearchParams({ body: 'should never land' }),
				redirect: 'manual',
			});
			expect(write.status).toBe(404);
		} finally {
			(env as Record<string, unknown>).ACCESS_AUD = aud;
			(env as Record<string, unknown>).ACCESS_TEAM_DOMAIN = team;
		}

		// And nothing was written on the way past.
		expect(await (await asOwner('/upstream/notes')).text()).toContain('Nothing written down yet');
	});

	it('keeps a note whose company has left the list, and says so', async () => {
		await asOwner('/upstream/notes/vanished', { method: 'POST', body: new URLSearchParams({ body: 'worth revisiting' }) });
		const book = await (await asOwner('/upstream/notes')).text();
		expect(book).toContain('worth revisiting');
		expect(book).toContain('no longer on the list');
	});
});
