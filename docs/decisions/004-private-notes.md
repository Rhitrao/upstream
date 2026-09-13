# 004 — A private notebook on a public page

## What we decided

One note per company, readable and writable only by the person who runs this list,
living at `/upstream/notes` on the same Worker as the public page. Identity comes from
Cloudflare Access; the Worker verifies the signature on the token Access issues, and
the feature does not exist until Access is configured.

## What else we considered

**A shared secret in the url** — `/upstream/notes?key=…`. It works, costs nothing, and
takes ten minutes. It also puts a bearer token in browser history, in every link ever
pasted, and in the referer header of every outbound click. "Private" would have been a
claim the implementation could not support.

**A password and a session cookie.** Now there is a password hash to store, a session
table to expire, a login form to rate-limit, and a reset flow for the day it is
forgotten. That is a login system, written to protect one person's notes about
pre-seed companies.

**A second, private Worker.** Clean separation, but two deploys, two databases, and no
way to open a note from the company it is about without copying ids between tabs.

**Reading `Cf-Access-Authenticated-User-Email` and trusting it.** This is the one that
looks fine and is not. Access sets that header after authenticating, and it is right
there in the request. But a header is typed, not proved. Anything that reaches the
Worker by a path the Access policy does not cover — a route added later, a policy
edited in a hurry, a request arriving at the origin some other way — carries whatever
headers its sender chose. Trusting it means the door is only ever as good as the
configuration in front of it, and configuration is the thing that drifts.

## Why

Access is free for the first fifty users, stores no password anywhere in this project,
and authenticates by sending a one-time PIN to a named email address. The token it
issues is signed, and a signature cannot be typed into curl.

Two properties are doing the real work, and both are in the code rather than in the
dashboard:

1. **Off until configured.** With `ACCESS_AUD` unset, every notes route returns 404 —
   not 403, which would announce that there is something there. So deploying this
   cannot open a door before the door has a lock.
2. **Verified, not asserted.** `src/access.ts` checks the RS256 signature against the
   team's published keys, checks the audience is this application, and checks the
   expiry. The email header is never read. Tests forge a token, reuse a signature over
   swapped claims, claim `alg: none`, and mint a valid token for a different Access
   application; all four get 403.

And notes are a separate table, never a column on `companies`. Every column there is
public and is read by a `SELECT c.*` the public list already runs. A private field in
the middle of that is one careless query away from being served to the world.

## What would change our mind

If a second person ever needs to write notes, `notes.author` already records who wrote
each one from the verified token, so per-author views are a query and not a migration.

If Access ever stops being free at this size, the fallback is not a password — it is
dropping the feature and keeping notes in a text file.

## Setting it up

The code ships off. To turn it on, once:

1. Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → **Add an
   application** → **Self-hosted**.
2. Application domain: `rohitrao.in`, path `upstream/notes`.
3. Policy: **Allow**, include **Emails** → your address. The login method **One-time
   PIN** needs no identity provider.
4. Copy the **Application Audience (AUD) Tag** from the application's overview.
5. Then, in this repo:

   ```bash
   npx wrangler secret put ACCESS_AUD           # paste the AUD tag
   npx wrangler secret put ACCESS_TEAM_DOMAIN   # e.g. yourteam.cloudflareaccess.com
   npx wrangler deploy
   ```

`/upstream/notes` 404s until both are set, and asks for a PIN once they are.
