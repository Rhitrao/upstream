/**
 * Who is asking, according to Cloudflare Access.
 *
 * Access sits in front of a route and, once somebody has proved they own the email
 * address on the policy, passes the request through carrying a signed token in
 * `Cf-Access-Jwt-Assertion` and their address in `Cf-Access-Authenticated-User-Email`.
 *
 * The header is not the check. This verifies the token's signature against the team's
 * published keys, and refuses everything it cannot verify. That distinction is the
 * whole file: trusting the email header means anybody who can reach the Worker by any
 * path Access does not cover — a mistyped policy, a route added later, a request that
 * arrives at the origin some other way — becomes the owner by typing one header into
 * curl. A signature cannot be typed.
 *
 * Nothing here is reachable until ACCESS_AUD and ACCESS_TEAM_DOMAIN are set, and the
 * routes that use it 404 until then. A private feature that is merely unlinked is not
 * private; one that does not exist until it is configured is.
 */

export interface Identity {
	email: string;
}

/** The two settings that turn the notebook on. Both, or it stays off. */
export interface AccessConfig {
	teamDomain: string;
	aud: string;
}

export function accessConfig(env: Env): AccessConfig | null {
	const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
	const aud = env.ACCESS_AUD?.trim();
	return teamDomain && aud ? { teamDomain, aud } : null;
}

interface Jwk {
	kid: string;
	kty: string;
	alg?: string;
	n: string;
	e: string;
}

/**
 * The team's public keys, kept for an hour.
 *
 * Cached because every note request would otherwise be two round trips, and bounded
 * because Cloudflare rotates these — a key cached for ever is a verifier that stops
 * working on rotation day and cannot be talked out of it.
 */
const KEY_TTL_MS = 60 * 60 * 1000;
let keyCache: { domain: string; fetchedAt: number; keys: Jwk[] } | null = null;

async function publicKeys(teamDomain: string, fetcher: typeof fetch = fetch): Promise<Jwk[]> {
	const now = Date.now();
	if (keyCache && keyCache.domain === teamDomain && now - keyCache.fetchedAt < KEY_TTL_MS) {
		return keyCache.keys;
	}

	const response = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`);
	if (!response.ok) throw new Error(`Access certs: ${response.status}`);
	const body = (await response.json()) as { keys?: Jwk[] };
	const keys = body.keys ?? [];
	keyCache = { domain: teamDomain, fetchedAt: now, keys };
	return keys;
}

/** Only for tests, which need a verifier that does not remember the last team. */
export function forgetKeys(): void {
	keyCache = null;
}

function base64UrlToBytes(value: string): Uint8Array {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function decodeSegment(segment: string): Record<string, unknown> {
	return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

/**
 * The identity a token proves, or null.
 *
 * Every failure returns null rather than throwing a reason: the caller's answer is the
 * same in every case, and a 403 that explains which check failed is a 403 that helps
 * whoever is probing it.
 */
export async function verifyAccessJwt(token: string, config: AccessConfig, fetcher: typeof fetch = fetch): Promise<Identity | null> {
	const parts = token.split('.');
	if (parts.length !== 3) return null;

	let header: Record<string, unknown>;
	let payload: Record<string, unknown>;
	try {
		header = decodeSegment(parts[0]);
		payload = decodeSegment(parts[1]);
	} catch {
		return null;
	}

	// RS256 and nothing else. "alg": "none" is the oldest trick there is, and an
	// HMAC algorithm here would have the verifier treat a public key as a shared
	// secret — which anybody can read off the certs endpoint.
	if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

	let keys: Jwk[];
	try {
		keys = await publicKeys(config.teamDomain, fetcher);
	} catch {
		return null;
	}

	const jwk = keys.find((key) => key.kid === header.kid);
	if (!jwk) return null;

	let ok = false;
	try {
		const key = await crypto.subtle.importKey(
			'jwk',
			{ kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
			{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
			false,
			['verify'],
		);
		ok = await crypto.subtle.verify(
			'RSASSA-PKCS1-v1_5',
			key,
			base64UrlToBytes(parts[2]),
			new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
		);
	} catch {
		return null;
	}
	if (!ok) return null;

	// The audience is this Access application. Without it, a valid token minted for
	// any other application on the same team — including one with a policy that lets
	// the whole internet in — would be accepted here.
	const audience = payload.aud;
	const audiences = Array.isArray(audience) ? audience : [audience];
	if (!audiences.includes(config.aud)) return null;

	const now = Math.floor(Date.now() / 1000);
	if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
	// A small allowance for clocks, and no more: nbf is the only claim here whose
	// whole job is to be in the future.
	if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null;

	const email = typeof payload.email === 'string' ? payload.email : null;
	if (!email) return null;

	return { email };
}

/**
 * The identity on a request, or null.
 *
 * Reads the token, never the email header. The header is convenient and unsigned; it
 * is here only in the sense that this function pointedly does not look at it.
 */
export async function identify(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Identity | null> {
	const config = accessConfig(env);
	if (!config) return null;
	const token = request.headers.get('Cf-Access-Jwt-Assertion');
	if (!token) return null;
	return verifyAccessJwt(token, config, fetcher);
}
