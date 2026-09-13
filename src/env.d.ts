/**
 * INGEST_KEY is a Worker secret (`wrangler secret put INGEST_KEY`, Part 8 Step 2), so
 * `wrangler types` cannot see it and it is absent from worker-configuration.d.ts.
 * Declared optional on purpose: the ingest endpoint must refuse to run when it is unset
 * rather than authenticate against undefined.
 */
interface Env {
	INGEST_KEY?: string;
	/**
	 * The two settings that turn the private notebook on, both optional and both
	 * required together. Unset is the shipped state and means the notes routes do not
	 * exist — see src/access.ts. A private feature that is merely unlinked is not
	 * private; one that 404s until it is deliberately configured is.
	 *
	 * ACCESS_TEAM_DOMAIN is the Zero Trust team hostname, e.g. "rohitrao.cloudflareaccess.com".
	 * ACCESS_AUD is the Application Audience tag of the Access application in front of
	 * /upstream/notes — it is what stops a token minted for some other application on
	 * the same team from being accepted here.
	 */
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
}
