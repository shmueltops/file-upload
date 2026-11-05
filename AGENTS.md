# Working on File Vault

## Start here

Read `README.md`, `PLAN.md`, and `OPERATIONS.md`. Preserve the agreed stack and feature-based frontend layout. This is a pnpm TypeScript monorepo with four projects:

- `apps/web`: React Router application. `src/features` contains auth, files, folders, uploads, and admin. Keep feature-specific components/hooks/helpers together.
- `apps/api`: Hono API Worker. Routes and middleware handle HTTP and authorization; shared services own business operations.
- `apps/queue-consumer`: separate Worker for processing and cleanup.
- `packages/shared`: browser-safe contracts/paths plus server-only Drizzle schema, queries, and services. Never import server modules into frontend code.

## Commands

- `pnpm dev`: local Vite + two Miniflare Workers; restart after backend changes.
- `pnpm typecheck`, `pnpm test`, `pnpm build`: required checks after behavior changes.
- `pnpm format`, `pnpm format:check`: Prettier.
- `pnpm test:e2e`: browser acceptance tests; requires a running dev server.
- `pnpm db:generate`: generate Drizzle SQL migrations; review the output.
- `pnpm cloudflare:prepare`, `pnpm run deploy`, `pnpm bootstrap`: hosted setup. Deployment uses the `cf` CLI, not Wrangler configuration.
- `pnpm verify:live`, `pnpm verify:r2`: actual Cloudflare integration checks. `verify:r2 --large` uses significant transfer/storage; use intentionally.

## Invariants

- Exactly four application tables: users, folders, files, scan_attempts. No jobs or sessions table.
- Authentication stays in HttpOnly cookies. Logout must use Secure when deleting production __Host- cookies, accept expired/absent sessions, and clear React state immediately even if the request fails. Preserve the non-secret signed-out marker and authenticated-401 handling; never store credentials in localStorage or treat a bad login/current password as an expired session.
- Both Workers reuse the shared services. D1 claim/state updates require generation and claim-token guards; no read-then-write claims.
- A clean verdict belongs to an immutable source ETag. Promotion retries must not re-run the scanner or replace the approved source.
- File previews use the authenticated clean-content route with `preview=1` and an extension allowlist shared with the UI. Keep HTML/SVG download-only, text/Markdown bounded at 2 MiB, Markdown raw HTML/remote images disabled, and media streamed with Range support. The PDF response permits same-origin object embedding for the browser's native viewer.
- At most three scanner invocations per file lifetime; delivery/promotion/cleanup retries use separate budgets.
- All object keys are generated IDs, never filenames or folder paths. Both buckets stay private. Admin does not bypass quarantine or user ownership.
- Small presigned PUTs sign `If-None-Match` AND actual `x-amz-meta-*` headers; return those headers to the browser. R2 does not persist query-hoisted AWS metadata as object metadata.
- Worker S3 bundling must resolve the browser SDK consistently and provide its XML DOMParser dependency. Keep production bundle/live tests for changes to that integration.
- File transfer queue is global above route changes, files sequential, parts concurrent at four with 16 MiB parts. Never buffer a whole large file.
- Pending/unfinished uploads are visible only in the upload panel and admin history, not My files. The list requires confirmed upload completion. A refresh does not resume transfers.
- Deletion blocks access and releases file/folder names immediately. Active-name indexes exclude delete_requested_at as well as deleted_at. Preserve historical records and scan history; cleanup and late events must operate only on old file IDs/generations, never a replacement's name or path.
- Unicode validation/case-folding is shared by browser and backend; enforce duplicate names through database indexes, including root.

## Database and configuration

Schema: `packages/shared/src/db/schema.ts`. Migrations: `packages/shared/migrations`. Drizzle Kit 0.31.11 misgenerated COALESCE expression indexes; the initial SQL was corrected manually. Verify generated migrations against D1, especially indexes, foreign keys, and transactional batches. Do not use schema push on deployed databases.

`cloudflare.config.ts` is the source of deployment bindings. Generate binding declarations with `cf workers types` when changing configuration. Keep local emulation behavior documented and production adapter tests separate.

## Secrets and verification

Never print, stage, commit, or put real credentials in source, docs, fixtures, commands, or workflow YAML. `.env`, `.dev.vars*`, `.local/`, `.cloudflare/`, runtime state, test artifacts and logs are ignored. `.env.example` contains placeholders only. Use GitHub Secrets for credentials; Variables or Secrets for deployment configuration.

Keep the bootstrap admin distinct from disposable `@test.invalid` verification identities. Never reset an existing user's password during testing or deployment. Do not delete user uploads to clean test data. Scope cleanup to the exact verification IDs/prefixes created by the test.

The scanner is deliberately fake per assignment. Do not describe it as real malware protection. Do not claim hosted verification passed based solely on local emulation. Capture successful browser evidence, document material limitations, and keep README/setup instructions consistent with actual commands.
