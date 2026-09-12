import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Read the real migrations so tests run against the real schema, not a hand-copied one.
const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)));

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.toml' },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: migrations,
					// The real INGEST_KEY is a secret set in Part 8; tests use their own.
					INGEST_KEY: 'test-ingest-key',
				},
			},
		}),
	],
	test: {
		setupFiles: ['./test/apply-migrations.ts'],
	},
});
