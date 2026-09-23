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

/*
 * Behind the Cache API, a page store in D1 shared by every server and region. The Cache API is
 * local to the machine that answers, and on 15 September 2026 the same url missed two or three
 * times in one Cloudflare region before a server that held it answered. A stored page costs its
 * parts in rows read (one or two: gzipped, in parts under D1's size limits) wherever it is asked
 * for, so a page is rendered once per data version, not once per server.
 */
const PART_BYTES = 90_000;
const STORE_SQL = `CREATE TABLE IF NOT EXISTS page_store (
  key TEXT NOT NULL, part INTEGER NOT NULL, meta TEXT, body BLOB NOT NULL, PRIMARY KEY (key, part)
)`;

async function gzip(bytes: ArrayBuffer): Promise<Uint8Array> {
	const stream = new Response(bytes).body!.pipeThrough(new CompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<ArrayBuffer> {
	const stream = new Response(bytes).body!.pipeThrough(new DecompressionStream('gzip'));
	return new Response(stream).arrayBuffer();
}

async function storeGet(db: D1Database, key: string): Promise<{ meta: { status: number; headers: Record<string, string> }; body: ArrayBuffer } | null> {
	try {
		const { results } = await db.prepare('SELECT part, meta, body FROM page_store WHERE key = ?1 ORDER BY part').bind(key).all<{ part: number; meta: string | null; body: ArrayBuffer | number[] }>();
		if (!results.length || !results[0].meta) return null;
		const chunks = results.map((r) => (r.body instanceof ArrayBuffer ? new Uint8Array(r.body) : new Uint8Array(r.body as number[])));
		const joined = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
		let at = 0;
		for (const c of chunks) {
			joined.set(c, at);
			at += c.length;
		}
		const meta = JSON.parse(results[0].meta) as { status: number; headers: Record<string, string>; parts: number };
		if (meta.parts !== results.length) return null; // a write still in progress
		return { meta, body: await gunzip(joined) };
	} catch {
		return null;
	}
}

async function storePut(db: D1Database, key: string, status: number, headers: Headers, body: ArrayBuffer): Promise<void> {
	const packed = await gzip(body);
	const parts: Uint8Array[] = [];
	for (let at = 0; at < packed.length; at += PART_BYTES) parts.push(packed.subarray(at, at + PART_BYTES));
	const meta = JSON.stringify({
		status,
		parts: parts.length,
		headers: Object.fromEntries(['content-type', 'content-disposition'].flatMap((h) => (headers.get(h) ? [[h, headers.get(h)!]] : []))),
	});
	const write = () =>
		db.batch(parts.map((part, i) => db.prepare('INSERT OR REPLACE INTO page_store (key, part, meta, body) VALUES (?1, ?2, ?3, ?4)').bind(key, i, i === 0 ? meta : null, part)));
	try {
		await write();
	} catch {
		// The table is made on first use, so a deploy needs no migration before it can store.
		await db.prepare(STORE_SQL).run();
		await write();
	}
}

export interface EdgeCache {
	enabled: boolean;
	/** The data version could not be read: D1 is refusing, so serve the last good copy if there is one. */
	failed?: boolean;
	key: string; // data version and build, joined
	origin: string;
	ctx: ExecutionContext;
	/** The database, for the shared page store behind the machine-local Cache API. */
	db?: D1Database;
}

/**
 * Bumped when the page's layout changes, so a cached page from before the change is never
 * served after it, even for a request the new build's id somehow misses.
 */
export const LAYOUT_VERSION = 'layout-2026-09-23b';

export async function edgeCache(env: Env, ctx: ExecutionContext, origin: string): Promise<EdgeCache> {
	if (env.EDGE_CACHE === 'off' || typeof caches === 'undefined') return { enabled: false, key: '', origin, ctx };
	try {
		const row = await env.DB.prepare("SELECT value FROM site_state WHERE key = 'data'").first<{ value: string }>();
		const build = env.CF_VERSION_METADATA?.id ?? 'dev';
		return { enabled: Boolean(row?.value), key: `${row?.value ?? ''}.${build}.${LAYOUT_VERSION}`, origin, ctx, db: env.DB };
	} catch {
		return { enabled: false, failed: true, key: '', origin, ctx };
	}
}

/** Mark the public data as changed: every cached page and aggregate is left behind. */
export async function bumpDataVersion(env: Env, when: string): Promise<void> {
	await env.DB.prepare("INSERT INTO site_state (key, value) VALUES ('data', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
		.bind(when)
		.run();
	// Pages stored for an older version can never be asked for again.
	try {
		await env.DB.prepare('DELETE FROM page_store').run();
	} catch {
		/* no store yet */
	}
}

/**
 * The url a cached answer is filed under. Not the visitor's url: the canonical spelling of the
 * view it asked for, with unknown parameters dropped and the known ones in a fixed order
 * (canonicalUrl in src/index.ts).
 *
 * Every distinct spelling used to be its own entry, and a cold render of the list costs about ten
 * thousand rows read. `?sub=drones`, `?sub=drones&utm_source=x` and `?ref=y&sub=drones` are one
 * page and were three renders, so a crawler walking the filter links — or any link with a
 * tracking parameter stapled to it — could mint new ten-thousand-row renders without limit. That
 * is what spent 96% of the daily row limit on 15 September 2026. Filing by the canonical url
 * bounds the cache to the views that actually exist.
 */
export async function cachedResponse(request: Request, cache: EdgeCache, build: () => Promise<Response>, keyUrl?: string): Promise<Response> {
	if (request.method !== 'GET' && request.method !== 'HEAD') return build();
	const filed = keyUrl ?? request.url;
	// The last good answer for this url, kept outside any version: what a visitor gets if D1
	// refuses (a spent daily limit, an outage) rather than an error page.
	const lastUrl = new URL(filed);
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
	const url = new URL(filed);
	url.searchParams.set('__v', cache.key);
	const key = new Request(url.toString(), { method: 'GET' });
	const hit = await caches.default.match(key);
	if (hit) {
		const out = new Response(hit.body, hit);
		out.headers.set('x-edge-cache', 'hit');
		return out;
	}
	const storeKey = `page:${new URL(filed).pathname}${new URL(filed).search}|${cache.key}`;
	const fromD1 = cache.db ? await storeGet(cache.db, storeKey) : null;
	if (fromD1) {
		const headers = new Headers(fromD1.meta.headers);
		headers.set('cache-control', `public, max-age=60, s-maxage=${DAY}`);
		const fromStore = new Response(fromD1.body, { status: fromD1.meta.status, headers });
		cache.ctx.waitUntil(caches.default.put(key, fromStore.clone()));
		const out = new Response(fromStore.body, fromStore);
		out.headers.set('x-edge-cache', 'store');
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
		const forStore = stored.clone();
		cache.ctx.waitUntil(
			Promise.all([
				caches.default.put(key, stored),
				response.status === 200 ? caches.default.put(lastKey, last) : Promise.resolve(),
				cache.db ? forStore.arrayBuffer().then((body) => storePut(cache.db!, storeKey, response.status, forStore.headers, body)).catch(() => undefined) : Promise.resolve(),
			]),
		);
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
	const storeKey = `memo:${name}|${cache.key}`;
	const fromD1 = cache.db ? await storeGet(cache.db, storeKey) : null;
	if (fromD1) {
		const text = new TextDecoder().decode(fromD1.body);
		cache.ctx.waitUntil(caches.default.put(key, new Response(text, { headers: { 'content-type': 'application/json', 'cache-control': `public, s-maxage=${DAY}` } })));
		return JSON.parse(text) as T;
	}
	const value = await compute();
	if (cache.db) {
		const bytes = new TextEncoder().encode(JSON.stringify(value));
		cache.ctx.waitUntil(storePut(cache.db, storeKey, 200, new Headers({ 'content-type': 'application/json' }), bytes.buffer as ArrayBuffer).catch(() => undefined));
	}
	cache.ctx.waitUntil(
		caches.default.put(key, new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'cache-control': `public, s-maxage=${DAY}` } })),
	);
	return value;
}
