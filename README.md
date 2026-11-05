# File Vault

A private file manager built with React, TypeScript, Hono, Cloudflare Workers, R2, D1, Queues, and Drizzle. Includes folder uploads, a persistent sequential upload manager, multipart transfers up to **3,000,000,000 bytes**, user administration, and processing history.

The scanner intentionally implements the assignment's **simulation**. It checks names for `virus` and `communism`, then uses a 10% random infected outcome. It does not inspect file contents for real malware.

Simulated scans take 10 seconds for files up to 1 KB (1,000 bytes), increasing linearly to 30 seconds at 3 GB (3,000,000,000 bytes). Timing uses the verified R2 size, keeps the file in Scanning, and is recorded in the attempt history. Promotion retries reuse the verdict without another scan or delay.

## Run locally

Requirements: Node.js 24.18+ and pnpm 10.15+. The currently pinned beta Cloudflare CLI advertises a newer Node patch baseline; use Node 24.22+ for deployment environments when available.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://127.0.0.1:5173>. The development script builds both Workers, starts Miniflare with actual D1/R2/Queue bindings, applies SQL migrations, and starts Vite. Application state is persisted in the ignored `.local/` directory.

On the first run, set `ADMIN_EMAIL` and `ADMIN_INITIAL_PASSWORD` in an ignored `.env` (copy `.env.example`), or let development generate credentials. Local sign-in details are in `.local/admin.json`; they are never printed into logs. The first sign-in requires changing the initial password. Redeploys/restarts do not reset existing accounts.

Vite updates the frontend as you edit. Restart `pnpm dev` after backend or schema changes. Browser upload state intentionally does not survive a refresh.

Local development uses a signed `/__local/r2` adapter because the pinned Miniflare R2 binding has no S3 ListParts endpoint. It stores local part receipts privately in R2. Production uses direct R2 S3 presigned URLs and actual S3 ListParts; the local upload route rejects all production requests. Local promotion uses bounded 16 MiB reads; production promotion uses conditional server-side CopyObject.

## Project layout

```text
apps/web                 React, organized by feature
apps/api                 Hono routes/middleware + production static assets
apps/queue-consumer      Separate scan/promotion/cleanup Worker
packages/shared         Contracts, paths, Drizzle schema/queries, services
scripts                  Local runtime, deployment, bootstrap, live probes
tests                    Unit, Workers integration, and browser tests
```

Frontend features are `auth`, `files`, `folders`, `uploads`, and `admin`. The upload provider is mounted above routed pages. Its queue, XHR transport, directory reading, and progress calculations are plain TypeScript modules.

Exactly four application tables: `users`, `folders`, `files`, `scan_attempts`. Migration-history tables are infrastructure bookkeeping. Browser-safe shared exports do not expose the database or server services.

## Verify

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
# Keep pnpm dev running in another terminal:
pnpm test:e2e
```

The browser suite creates disposable local QA data and exercises user creation, first-login rotation, files, folders, downloads, audit history, multipart retry, and route changes during uploads. It rotates a fresh local bootstrap password when necessary and updates `.local/admin.json` with the current local password.

The full-size browser test is opt-in because it allocates a 3 GB fixture plus emulator storage. In PowerShell:

```powershell
$env:RUN_LARGE_FILE_TEST = '1'
pnpm exec playwright test tests/browser/large.spec.ts
Remove-Item Env:RUN_LARGE_FILE_TEST
```

Generated screenshots are in `artifacts/`; failed-test traces and screenshots are in ignored `test-results/`. The initial 3 GB browser test completed transfer, clean promotion, and a final-byte range download.

## Deploy to Cloudflare

Fill `.env` from `.env.example`. Never commit this file or share its contents in chat.

- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`: deployment credentials for Workers Scripts Edit, D1 Edit, Queues Edit, R2 Storage Edit, and Account Settings Read, scoped to the intended account.
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`: R2 Object Read & Write credentials scoped to the quarantine and clean buckets.
- `R2_ENDPOINT`: the account's S3 endpoint.
- `SESSION_SECRET`: at least 32 random characters.
- `ADMIN_EMAIL`, `ADMIN_INITIAL_PASSWORD`: one-time administrator bootstrap inputs. Supply the initial password specified in the assignment through this ignored configuration.
- `D1_DATABASE_ID`, `APP_ORIGIN`: the preparation script fills these when blank.
- Bucket/queue names default to `.env.example`. For independent staging, choose a separate database name, buckets, queues, and Worker names before preparing resources.

```sh
pnpm cloudflare:prepare
pnpm run deploy
pnpm bootstrap
```

Use **`pnpm run deploy`**; `pnpm deploy` is a different built-in pnpm command.

The public Worker defaults to `file-vault`, serving both the frontend and API at `https://file-vault.<your-workers-subdomain>.workers.dev`. To change the published name, update `API_WORKER_NAME` and `APP_ORIGIN` together in `.env` and GitHub Actions Variables, then deploy. Preparation updates upload CORS for the new origin. Keep the same database, bucket, queue, and session-secret settings to retain existing data and users. Users sign in again on the new hostname. A renamed deployment does not delete the old Worker; retire it separately once existing links are no longer needed.

Preparation creates/reuses the named resources, configures native R2 upload events, CORS, and one-day incomplete-multipart lifecycle rules, and determines the Workers domain. Deployment applies committed migrations, builds/deploys the consumer first, then the API and React assets. Runtime secrets are uploaded separately from tracked configuration; the deployment API token is never a Worker binding.

Preparation can be rerun for an existing deployment. It reads the processing queue's R2 notification rules and reuses matching coverage, adding only missing upload events. R2's notification PUT appends rules, so blindly submitting the same rule again causes an overlap error.

Cloudflare configuration lives in each Worker's `cloudflare.config.ts`. The Vite plugin beta matches the new `cf` configuration format. Worker bundling explicitly resolves browser/Workers AWS SDK modules; this is necessary to avoid mixing Node runtime configuration with browser SDK dependencies.

```sh
pnpm verify:r2
pnpm verify:r2 --large
pnpm verify:large-copy
pnpm verify:live
```

R2 verification checks signed create-once PUTs, replay prevention, conditional cross-bucket copy, and CORS. `--large` additionally transfers and copies exactly 3 GB, then deletes only its own verification objects. Live verification exercises deployed Hono authentication, native object events, Queues, scanning, multipart completion, downloads, and deletion using a dedicated QA account. Its generated credentials stay in `.local/live-verification.json`.

`verify:large-copy` assembles a 3 GB verification object server-side from the dedicated QA account's approved fixture, then verifies conditional cross-bucket CopyObject and cleans its own objects. This checks real R2 promotion without retransmitting 3 GB from the local machine; it does not test a full-size browser upload over the public network.

## Set up a clone and GitHub Actions

1. Clone your GitHub repository, open its root, install Node.js and pnpm, then run `pnpm install --frozen-lockfile`.
2. Copy `.env.example` to `.env`. In PowerShell use `Copy-Item .env.example .env`; on macOS/Linux use `cp .env.example .env`.
3. For local work, run `pnpm dev`. Cloudflare credentials are not needed for the emulator. Set your local initial admin inputs before the first run, or read the generated `.local/admin.json`.
4. For hosted setup, create a Cloudflare deployment API token with the account permissions listed above and an R2 Object Read & Write token for the two app buckets. Put the credentials in `.env`, then run preparation, deployment, and bootstrap as above.
5. In GitHub, open **Settings → Secrets and variables → Actions**. Add the credentials below as repository Secrets, or add them to a `production` GitHub Environment. The workflow uses that environment for deployment.
6. Add the configuration values as repository Variables. The workflow also accepts the same names as Secrets, so keeping all configuration in Secrets works too.
7. Push to `main`, or run **Actions → Verify and deploy → Run workflow** from `main`. Pull requests run verification without deployment credentials. Deployment runs only after formatting, types, integration tests, build, and browser tests pass.

Required GitHub Secrets:

- `CLOUDFLARE_API_TOKEN`: Cloudflare deployment token, scoped to the account.
- `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`: S3 credentials for the two buckets.
- `SESSION_SECRET`: the same stable random session-signing secret used by the deployed app. Changing it signs everyone out.
- `ADMIN_INITIAL_PASSWORD`: the assignment-specified initial password used only when the bootstrap account does not yet exist. Existing passwords are never reset.

Required configuration (Variables or Secrets):

- `CLOUDFLARE_ACCOUNT_ID` and `ADMIN_EMAIL`.
- `R2_ENDPOINT`: your account's S3 endpoint, e.g. `https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com`.

Optional configuration (Variables or Secrets):

- `D1_DATABASE_ID`: use the existing database ID for this deployment. When omitted, preparation finds or creates `D1_DATABASE_NAME`.
- `D1_DATABASE_NAME`: defaults to `file-vault`.
- `APP_ORIGIN`: your published HTTPS origin, without a trailing slash. When omitted, preparation derives the Workers domain.
- `QUARANTINE_BUCKET`, `CLEAN_BUCKET`, `PROCESSING_QUEUE`, `DEAD_LETTER_QUEUE`, `API_WORKER_NAME`, `CONSUMER_WORKER_NAME`: default to the values in `.env.example`.

Use your existing deployed values when connecting this project to GitHub; changing a bucket, queue, or database name creates a separate resource rather than moving existing data. No secret is needed for the DLQ itself—only its resource name. The workflow creates/reuses the queues, configures dead-letter routing, applies migrations, uploads Worker secrets, deploys both Workers and the UI, seeds the initial admin if absent, and checks `/api/health`.

GitHub does not automatically inherit your local `.env`. Add the entries above through GitHub's settings; never commit the `.env` or paste secret values into workflow YAML. The generated deployment secrets file, local accounts, emulator data, compiled output, logs, browser traces, and screenshots are ignored by Git.

Formatting is configured through `.prettierrc.json` and `.editorconfig`. Run `pnpm format` to format the project and `pnpm format:check` to check it. The committed VS Code settings enable format-on-save when the Prettier extension is installed. See `AGENTS.md` for guidance for future coding agents.

To configure GitHub from your local `.env` automatically, sign in with `gh auth login`, run `gh auth setup-git`, and use:

```sh
pnpm github:env --dry-run
pnpm github:env --repo YOUR_ACCOUNT/YOUR_REPOSITORY
```

The script prints only setting names, puts credentials in Secrets, and puts non-secret configuration in Variables. Values travel through stdin, without appearing in command arguments. It only sends an allowlist of deployment settings and skips empty entries. If the repository's `production` Environment already exists, add `--environment production` to store settings there instead. Omit `--repo` to use the current Git remote.

## Database changes

Edit `packages/shared/src/db/schema.ts`, then run `pnpm db:generate`. Review and commit generated SQL and Drizzle metadata. Apply migrations through the D1 migration runner; do not use Drizzle `push` against deployed data.

Drizzle Kit 0.31.11 incorrectly split the `COALESCE` expressions in generated unique indexes. The initial migration contains a reviewed correction; integration tests apply the migration and verify root-level uniqueness. Review expression indexes carefully in future generated migrations.

## Behavior and operational limits

- A user's root is `""`. Paths use NFC normalization and Unicode case-folded uniqueness. Invalid Windows names, traversal, trailing spaces/periods, oversized names, and excessive depth are rejected by both UI and API.
- Files upload sequentially; multipart parts upload four at a time in 16 MiB chunks. Individual parts retry up to five times after the first request. Confirmed bytes and displayed progress are separate.
- Native R2 events start processing even when the browser never calls completion for a small PUT. Explicit completion also sends a safe duplicate to repair event uncertainty.
- Claims use atomic D1 updates, a token, and a 16-minute lease. Only scanner invocations use the three-attempt budget. Promotion/cleanup retries retain their approved verdict and history.
- Infected files cannot be downloaded. Administrators cannot bypass quarantine. Downloads stream from the recorded clean object through an authenticated route, with byte-range support and no public cache.
- Approved files can be previewed by clicking their name or the eye icon: plain text (`txt`, `log`, `csv`, `json`), formatted Markdown (`md`, `markdown`), PDF, raster images (`png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `bmp`), and browser-supported video (`mp4`, `m4v`, `webm`, `ogv`, `mov`). Video codec support and the PDF viewer depend on the browser; Download is always available. Text/Markdown previews are limited to 2 MiB. Markdown renders GitHub-style tables and code while ignoring embedded HTML and external images. Other formats, including HTML and SVG, are download-only.
- Deletion revokes new access and releases the file/folder name immediately, so a replacement can be uploaded right away. Physical cleanup of the old generated object keys still waits for issued URL/processing write windows; it cannot remove a replacement with a different ID. An already-started download cannot be recalled.
- Folder deletion is recursive. Folder changes in another tab are resolved when each path-based request is made; an upload batch does not lock a permanent tree snapshot.
- Sessions use secure HttpOnly cookies. Logout invalidates all sessions for that account. Public registration, cross-refresh upload resume, WebSockets, cron reconciliation, and a separate jobs table are intentionally absent.
- Signing out clears React's user/upload state immediately, even when the server is unavailable. A non-secret browser logout marker prevents a surviving cookie from restoring the UI after refresh and synchronizes sign-out across tabs; successful sign-in clears that marker. Authenticated API 401 responses also return the UI to sign-in. The server expires the cookie and invalidates sessions; frontend JavaScript cannot delete an HttpOnly cookie itself.

See [PLAN.md](PLAN.md) for the architecture and [OPERATIONS.md](OPERATIONS.md) for recovery guidance.
