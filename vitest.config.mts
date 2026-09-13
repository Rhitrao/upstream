import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Read the real migrations so tests run against the real schema, not a hand-copied one.
const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)));

// Cloudflare Access publishes the keys that verify its tokens at a url on the team
// domain, and the Worker fetches them. Under test that fetch is answered here, with a
// throwaway keypair the tests sign with — so the verifier runs against a real signature
// rather than a stub of itself, and a test that must fail (a forged token, a wrong
// audience) fails in the same code that lets a genuine one through.
//
// Everything else the Worker might reach for is refused, which is how a test that
// quietly depends on the network gets caught.
const accessKey = JSON.parse(await readFile(fileURLToPath(new URL('./test/fixtures/access-key.json', import.meta.url)), 'utf8'));
const outboundService = (request: Request) => {
	if (new URL(request.url).pathname === '/cdn-cgi/access/certs') {
		return Response.json({ keys: [accessKey.publicJwk] });
	}
	return new Response('refused: tests do not reach the network', { status: 403 });
};

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.toml' },
			miniflare: {
				outboundService,
				bindings: {
					TEST_MIGRATIONS: migrations,
					// The real INGEST_KEY is a secret set in Part 8; tests use their own.
					INGEST_KEY: 'test-ingest-key',
					// The notebook is off unless both of these are set, which is the
					// shipped state and has its own test. Here they are set, so the
					// tests that matter — a forged token, a wrong audience, an expired
					// one — have a configured door to be refused at.
					ACCESS_TEAM_DOMAIN: 'upstream-test.cloudflareaccess.com',
					ACCESS_AUD: 'test-audience-tag',
				},
			},
		}),
	],
	test: {
		setupFiles: ['./test/apply-migrations.ts'],
	},
});
