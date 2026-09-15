/**
 * Answers served from Cloudflare's cache, so a page nobody changed reads no D1 rows.
 *
 * Everything public here changes only when an ingest writes, so the cache key carries the data
 * version (one row, bumped by every ingest and data migration) and the deployed build: a new run
 * or a new deploy is a new key, and nothing stale outlives the data it shows. Two layers:
 *
 *   whole responses   a GET for the list, a company page, the CSV or the JSON API, by its url
 *   aggregates        the parts of the list page no filter changes (coverage, findings, register
 *                     outcomes, freshness), so a newly filtered url recomputes only what it filters
 *
 * The Cache API is per data centre, so the first visitor in a region pays once. Tests switch it
 * off (EDGE_CACHE=off), since they write to the database directly between requests.
 */

const DAY = 86_400;

export interface EdgeCache {
	enabled: boolean;
	/** The data version could not be read: D1 is refusing, so serve the last good copy if there is one. */
	failed?: boolean;
	key: string; // data version and build, joined
	origin: string;
	ctx: ExecutionContext;
}

export async function edgeCache(env: Env, ctx: ExecutionContext, origin: string): Promise<EdgeCache> {
	if (env.EDGE_CACHE === 'off' || typeof caches === 'undefined') return { enabled: false, key: '', origin, ctx };
	try {
		const row = await env.DB.prepare("SELECT value FROM site_state WHERE key = 'data'").first<{ value: string }>();
		const build = env.CF_VERSION_METADATA?.id ?? 'dev';
		return { enabled: Boolean(row?.value), key: `${row?.value ?? ''}.${build}`, origin, ctx };
	} catch {
		return { enabled: false, failed: true, key: '', origin, ctx };
	}
}

/** Mark the public data as changed: every cached page and aggregate is left behind. */
export async function bumpDataVersion(env: Env, when: string): Promise<void> {
	await env.DB.prepare("INSERT INTO site_state (key, value) VALUES ('data', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
		.bind(when)
		.run();
}

export async function cachedResponse(request: Request, cache: EdgeCache, build: () => Promise<Response>): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD') return build();
	// The last good answer for this url, kept outside any version: what a visitor gets if D1
	// refuses (a spent daily limit, an outage) rather than an error page.
	const lastUrl = new URL(request.url);
	lastUrl.searchParams.set('__v', 'last-good');
	const lastKey = new Request(lastUrl.toString(), { method: 'GET' });
	const stale = async () => {
		if (typeof caches === 'undefined') return null;
		let old = await caches.default.match(lastKey);
		let fallback = false;
		if (!old && lastUrl.search.replace(/[?&]__v=last-good/, '') !== '') {
			// A url never served before: the last good copy of the unfiltered page beats an error.
			const plain = new URL(lastUrl.origin + lastUrl.pathname);
			plain.searchParams.set('__v', 'last-good');
			old = await caches.default.match(new Request(plain.toString(), { method: 'GET' }));
			fallback = Boolean(old);
		}
		if (!old) return null;
		const out = new Response(old.body, old);
		out.headers.set('x-edge-cache', fallback ? 'stale-unfiltered' : 'stale');
		return out;
	};
	if (!cache.enabled) {
		if (cache.failed) {
			const old = await stale();
			if (old) return old;
		}
		return build();
	}
	const url = new URL(request.url);
	url.searchParams.set('__v', cache.key);
	const key = new Request(url.toString(), { method: 'GET' });
	const hit = await caches.default.match(key);
	if (hit) {
		const out = new Response(hit.body, hit);
		out.headers.set('x-edge-cache', 'hit');
		return out;
	}
	let response: Response;
	try {
		response = await build();
	} catch (error) {
		const old = await stale();
		if (old) return old;
		throw error;
	}
	if (response.status === 200 || response.status === 404) {
		const stored = new Response(response.clone().body, response);
		// Browsers keep their own short max-age; the edge keeps it until the data version moves.
		stored.headers.set('cache-control', `public, max-age=60, s-maxage=${response.status === 200 ? DAY : 600}`);
		stored.headers.delete('set-cookie');
		const last = new Response(stored.clone().body, stored);
		last.headers.set('cache-control', `public, s-maxage=${DAY * 30}`);
		cache.ctx.waitUntil(Promise.all([caches.default.put(key, stored), response.status === 200 ? caches.default.put(lastKey, last) : Promise.resolve()]));
	}
	const out = new Response(response.body, response);
	out.headers.set('x-edge-cache', 'miss');
	return out;
}

/** A JSON-serialisable aggregate, computed once per data version and build. */
export async function memo<T>(cache: EdgeCache, name: string, compute: () => Promise<T>): Promise<T> {
	if (!cache.enabled) return compute();
	const key = new Request(`${cache.origin}/upstream/__memo/${encodeURIComponent(name)}?__v=${encodeURIComponent(cache.key)}`);
	const hit = await caches.default.match(key);
	if (hit) return (await hit.json()) as T;
	const value = await compute();
	cache.ctx.waitUntil(
		caches.default.put(key, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': `public, s-maxage=${DAY}` } })),
	);
	return value;
}
