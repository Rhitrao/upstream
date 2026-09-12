/**
 * INGEST_KEY is a Worker secret (`wrangler secret put INGEST_KEY`, Part 8 Step 2), so
 * `wrangler types` cannot see it and it is absent from worker-configuration.d.ts.
 * Declared optional on purpose: the ingest endpoint must refuse to run when it is unset
 * rather than authenticate against undefined.
 */
interface Env {
	INGEST_KEY?: string;
}
