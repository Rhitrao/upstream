import type { D1Migration } from '@cloudflare/vitest-plugin';

declare global {
	namespace Cloudflare {
		interface Env {
			/** Injected by vitest.config.mts so the setup file can apply the real migrations. */
			TEST_MIGRATIONS: D1Migration[];
		}
	}
}
