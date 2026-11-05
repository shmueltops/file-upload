# File Management System — Implementation Plan

Status: implemented and deployed. Type checks, unit/runtime tests, browser flows, and live Cloudflare integration have been exercised; the local browser transferred and promoted a full 3 GB file, and a real R2 conditional cross-bucket 3 GB copy passed.

Based on the supplied assignment and subsequent user decisions. The implementation keeps the required React / TypeScript / Hono / Workers / R2 / D1 / Queues stack, four workspace projects, and exactly four application tables. See README.md for clone/deployment/GitHub Actions setup and AGENTS.md for contributor guidance.

## 1. Scope and working decisions

- Build one React application with user and admin routes, one Hono API Worker, one shared library, and one background Queue Worker.
- Serve the production React build through the API Worker's static assets on the same origin. Keep frontend and API as separate workspace projects.
- Use D1 with Drizzle ORM for metadata and processing state; R2 for file bytes and multipart state; Queues for delivery and retries.
- Keep quarantine and clean buckets private. Browser uploads go directly to quarantine; only backend code can write clean objects.
- Interpret the maximum as **3 GB = 3,000,000,000 bytes**. Use binary units for the specified 20 MiB threshold and 16 MiB chunks. Show units consistently in the UI.
- Root is the empty folder path, `""`, represented by a nullable folder reference in D1.
- Use explicit conflicts rather than silently overwriting or automatically renaming duplicate files. Existing matching folders are reused during folder uploads.
- Folder deletion is recursive, requires a UI confirmation showing its contents, and preserves historical database records.
- Implement the specified fake scanner behind a small replaceable interface. Clearly identify it as a simulation in documentation and the admin UI; passing it is not a real malware guarantee.
- No public registration, sessions table, jobs table, Cron Trigger, WebSockets, persistent browser upload state, or additional orchestration service.

## 2. Repository and service boundaries

Use pnpm workspaces, strict TypeScript, and straightforward modules. Use Cloudflare's `cf` CLI and `cloudflare.config.ts` for this new project; pin tool and package versions when scaffolding.

```text
apps/
  web/
    src/
      app/                 # App entry, router, layouts, provider composition
      features/
        auth/              # Login, password change, auth provider/hooks
        files/             # File manager page, listing, status, download/delete
        folders/           # Tree, breadcrumbs, folder dialogs and mutations
        uploads/           # Upload provider/panel, queue, XHR, multipart,
                           # progress, retries, browser directory adapters
        admin/             # User management, jobs overview and attempt detail
      components/          # UI reused across features: buttons, dialogs, layout
      lib/                 # Shared HTTP client and general formatting helpers
      main.tsx
  api/
    src/
      index.ts
      routes/              # auth, uploads, files, folders, admin
      middleware/          # authentication, admin role, CSRF, errors
    cloudflare.config.ts
  queue-consumer/
    src/index.ts           # R2 event/internal message adapters, ack/retry
    cloudflare.config.ts
packages/
  shared/
    src/
      contracts/           # Browser-safe DTOs, schemas, limits, statuses
      paths/               # Browser-safe normalization and validation
      db/
        client.ts          # Drizzle D1 client factory and database type
        schema.ts          # Four SQLite tables, constraints and indexes
        queries/           # Domain queries and atomic processing operations
      services/            # r2, files/folders, users/auth, scanner, processing
    migrations/            # Committed SQL migrations and Drizzle metadata
    drizzle.config.ts      # SQLite schema path and migration output directory
scripts/                   # Resource setup, admin bootstrap, smoke checks
tests/                     # Cross-project integration and browser tests
```

- Export browser-safe modules separately from server services. Never import credentials or server modules into the React bundle.
- Hono owns HTTP validation, authentication, authorization, and response mapping. Both Workers call the same shared services and database operations.
- Use Drizzle's D1 driver for typed database queries and SQLite schema definitions. Use a small schema-validation dependency shared by the HTTP boundary and frontend; API contracts remain separate from database row types.
- Start with React Router, native browser APIs, Drizzle ORM and Drizzle Kit, the AWS S3 client/presigner for S3-only operations, a proven password-hashing implementation, and focused test tooling. Avoid a general job framework or a large state-management dependency.
- Generate Worker binding types from configuration. Use compatibility date `2026-11-05`, with required flags verified during setup.

### Frontend organization

Keep the feature-based approach. Each feature owns its pages, components, hooks, API functions, and feature-specific logic. Start with plainly named files in the feature directory; add `components/` or `hooks/` subdirectories only when the feature needs them.

- `app/` wires routes and providers. Implement `AuthProvider` in `features/auth` and `UploadProvider` in `features/uploads`; mount them above the route outlet so route changes preserve upload state.
- `features/files` composes the file manager using folder controls and upload actions exposed by their respective features. Admin pages compose monitoring and user-management views.
- Keep transfer logic in plain TypeScript modules inside `features/uploads` (for example, `upload-queue.ts`, `multipart.ts`, `xhr.ts`, `progress.ts`, and `read-directory.ts`). React components render state and invoke actions rather than owning network retry loops.
- Put UI used by multiple features in `components/`, and general browser helpers in `lib/`. Keep feature-specific hooks and helpers with their feature.
- Features expose a small public API when other features need it; avoid importing another feature's internal files or introducing circular dependencies. Shared validation, limits, and DTOs come from browser-safe `packages/shared` exports.
- Colocate focused tests with the modules they exercise; keep cross-feature browser scenarios in root `tests/`. Do not create empty directory scaffolding just to match a template.

### Drizzle and migrations

- Define the four application tables with `drizzle-orm/sqlite-core` in `packages/shared/src/db/schema.ts`. Infer server-side row/insert types from that schema.
- Create the runtime client with `drizzle-orm/d1` using each Worker's D1 binding. Both Workers reuse the client factory and domain queries; runtime traffic uses the binding, without database HTTP credentials. See [Drizzle's D1 integration](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1).
- Use typed query builders for normal reads and writes, with bound `sql` expressions or narrowly scoped native D1 prepared statements for recursive CTEs and atomic operations that require them. Keep these inside `db/queries`; Hono routes and React never issue database queries directly.
- Use Drizzle Kit to generate migrations from the schema, review the SQL, and commit the migrations plus generated metadata. Represent partial/expression indexes and composite foreign keys in the schema; verify that generated SQL preserves their exact semantics. Use a reviewed custom migration where needed.
- Apply committed SQL through the project's D1 migration tooling, with the migration directory and file pattern matching the pinned Drizzle Kit output. Use one migration runner/history for local, staging, and production; do not mix D1 and Drizzle migration runners or use schema `push` in deployed environments. See [D1 migration configuration](https://developers.cloudflare.com/d1/reference/migrations/).
- Migration bookkeeping is infrastructure metadata; the application still has only `users`, `folders`, `files`, and `scan_attempts`. Do not add session or job tables.

## 3. Data model: four application tables

Store UUIDs as text, sizes as integer bytes, and timestamps consistently as UTC epoch milliseconds. Add database `CHECK` constraints for roles, statuses, nonnegative sizes, and attempt limits.

### `users`

- `id`, `email`, `email_key`, `password_hash`, `role`.
- `must_change_password`, `session_version`.
- `created_at`, `updated_at`, `password_changed_at`, `last_login_at`.
- Unique `email_key`; document the email normalization policy, with no provider-specific dot or plus-address rewriting.

### `folders`

- `id`, `user_id`, `parent_id`, `name`, `name_key`.
- `created_at`, `updated_at`, `delete_requested_at`, `deleted_at`.
- Foreign key to user and a same-owner composite reference for the parent. Add `UNIQUE(user_id, id)` for composite references.
- Keep tombstoned folders so historical file references remain valid.

### `files`

- Identity: `id`, `user_id`, nullable `folder_id`, `filename`, `filename_key`, declared `mime_type`.
- Upload: `expected_size`, `actual_size`, `upload_generation`, `upload_kind`, `quarantine_key`, `multipart_upload_id`, `upload_expires_at`, `latest_signed_url_expires_at`.
- Verified source: `source_etag`, optional provider checksum, and verified object metadata. Treat an ETag as an object identity validator, not a universal content hash.
- Processing: `status`, `stage`, `scan_attempt_count`, `scan_verdict`, `approved_source_etag`, `claim_token`, `lease_expires_at`.
- Promotion: `clean_key`, `clean_etag`; destination keys include the upload generation and processing claim so stale Workers cannot overwrite a newer destination.
- Diagnostics: `block_reason`, `last_error_code`, bounded `last_error`, `cleanup_attempt_count`.
- Dates: `created_at`, `updated_at`, `upload_completed_at`, `processing_started_at`, `last_processed_at`, `completed_at`, `delete_requested_at`, `deleted_at`.
- Add `UNIQUE(user_id, id)` and a same-owner composite folder foreign key.
- The file row is the durable processing record; do not introduce a second job model.

### `scan_attempts`

- `id`, `file_id`, `upload_generation`, `attempt_number`, `claim_token`, `provider`.
- `result`: `started`, `clean`, `infected`, `error`, or `interrupted`.
- `duration_ms`, bounded/redacted `provider_response`, `error_code`, bounded `error_details`.
- `started_at`, `finished_at`, `created_at`, `updated_at`.
- Unique `(file_id, attempt_number)`. Attempts are numbered across the file record's lifetime and never exceed three.
- Reserve the attempt before invoking the scanner so a crash leaves an auditable record. Recovery closes unfinished attempts as interrupted.

### Constraints and indexes

Use normalized application-generated keys; SQLite's default `NOCASE` is insufficient for full Unicode matching. Use separate namespaces for file names and folder names, as required by the brief.

```sql
CREATE UNIQUE INDEX folders_active_name
ON folders(user_id, COALESCE(parent_id, ''), name_key)
WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX files_active_name
ON files(user_id, COALESCE(folder_id, ''), filename_key)
WHERE deleted_at IS NULL;
```

The empty-string sentinel cannot be a valid UUID. It makes uniqueness work at root, where ordinary nullable composite indexes would allow duplicates. Failed, infected, and deleting files keep their names reserved until physical deletion succeeds.

Additional indexes: folders by `(user_id, parent_id)`, files by `(user_id, folder_id, created_at, id)`, files by `(status, updated_at, id)`, files by lease/deletion state, and attempts by `(file_id, attempt_number)`. Add indexes only for actual listing and monitoring queries.

Use Drizzle conditional writes with `RETURNING`. Execute related mutations through D1's transactional batch semantics; use the pinned Drizzle D1 adapter's batch support where available, or a shared native `D1.batch()` operation for SQL requiring it. Do not assume an ORM transaction callback can provide interactive SQL transactions spanning JavaScript or atomicity across D1, R2, and Queues. Recovery-sensitive reads use the primary/appropriate D1 session rather than stale replicas. See [D1 database operations](https://developers.cloudflare.com/d1/worker-api/d1-database/).

## 4. Paths, folders, and directory selection

### Shared name policy

- Normalize names to Unicode NFC and compute a pinned, locale-independent Unicode case-folded key. Preserve the normalized display spelling. Do not use a user's locale or SQLite `LOWER()` as the uniqueness rule.
- Use `/` only between segments. Browser adapters produce that form; backend requests containing backslashes are rejected rather than repaired ambiguously.
- Reject `< > : " / \\ | ? *` inside names, control characters, empty names, trailing spaces/periods, and `.` / `..` segments.
- Reject Windows device names, including extensions: CON, PRN, AUX, NUL, COM1–COM9, LPT1–LPT9, and documented equivalent reserved forms.
- Reject leading/trailing/repeated separators, absolute paths, drive prefixes, UNC paths, and root escape attempts. Do not URL-decode a JSON path again.
- Initial limits: 255 UTF-8 bytes **and** 255 UTF-16 code units per name; 1,024 UTF-8 bytes for the full logical path including filename; 32 folder levels. These are application limits, not a guarantee about every local filesystem's full extraction path.
- Apply identical validation in the frontend for feedback and the backend for enforcement. Test Unicode normalization collisions and case-fold expansions.

### Backend resolution

1. Authenticate; derive `user_id` from the session, never the payload.
2. Validate the entire path before changing the database.
3. Resolve each segment under its current parent using normalized keys.
4. Use insert-on-conflict and reread the winner, rather than read-then-unconditionally-insert.
5. Guard writes against deleting ancestors in SQL, including concurrent delete/create requests.
6. Return the canonical display path and resolved folder internally. Ordinary upload payloads never require folder IDs.

`POST /folders/ensure-paths` receives one deduplicated manifest of paths, including empty directories exposed by the browser. Validate it before writes, ensure parents before children, and bound the request (initially 10,000 paths / 2 MiB). A larger selection gets a clear limit error. Process D1 writes in bounded batches; partial hierarchy creation is harmless and retryable.

The UI fetches the user's flat folder list and builds the tree. IDs may appear in listing DTOs and mutation URLs, but navigation and upload destinations use paths. Renaming a folder updates its name; paths are derived from parent links. Moving uses `destinationParentPath`, validates ownership, rejects cycles, and verifies descendant depth/path limits before committing.

### Browser collection

- Files: collect `File` references directly.
- Folder picker: use `webkitdirectory` and `webkitRelativePath`; explain that empty folders may be unavailable through that surface.
- Directory drop: use supported directory handles/entry APIs with a fallback. Recursively read all batches of directory entries, preserving the dropped top-level folder and any exposed empty directories.
- Validate the selection, deduplicate its paths, append them to the current destination path, send the directory manifest once, then enqueue files sequentially.
- Keep `File` objects and relative paths in memory. Never read an entire large file into an ArrayBuffer.
- Show per-file conflicts and continue with other files; the user can retry or skip failures. Freeze the byte denominator for an active batch; newly selected items form a subsequent batch.
- Disable rename/move/delete controls for destinations involved in this tab's active uploads. Paths still resolve at each request, so cross-tab folder changes do not provide a frozen upload-tree snapshot; document this initial limitation.

## 5. Authentication and authorization

- Use salted Argon2id hashes with algorithm and work parameters encoded in the stored hash. Start from OWASP's 19 MiB / 2 iterations / parallelism 1 profile and benchmark a Workers-compatible implementation in the deployed runtime before committing to the library. Do not quietly substitute a weak hash if runtime support fails. See [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
- Use a signed, short-lived session cookie containing user ID, session version, issue time, and expiry. Verify it with a maintained library and a deployment secret, with a fixed algorithm and audience.
- Cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, production `__Host-` prefix. No browser localStorage token.
- Read the user on authenticated requests; compare session version and obtain the current role from D1. Use an eight-hour absolute lifetime initially.
- Logout clears the cookie and increments `session_version`, invalidating all sessions for that user. Password changes also increment it. This deliberately simple all-device logout avoids a sessions table.
- Add `POST /auth/change-password`; when `must_change_password` is set, allow only session inspection, password change, and logout.
- Bootstrap the admin with a local/deployment script: accept email and the assignment-specified initial password through ignored secret configuration, hash it, insert only if absent, and set `must_change_password`. Never copy that password into this plan, source, example configuration, command history, or logs. Never reset an existing admin during redeploys.
- Only admins can create users. Return no password hashes through any API. Enforce bounded password input lengths and generic login failures.
- Apply same-origin/CSRF checks to cookie-authenticated mutations, JSON content-type checks, and a Cloudflare rate-limit rule/binding for login. Redact credentials, cookies, and signed URLs from logs.
- User-scoped SQL operations enforce ownership even when called outside Hono. Admin monitoring is explicit; admin status does not authorize quarantine downloads or arbitrary access to another user's download endpoint.

## 6. HTTP contracts

Keep all requested routes. Use shared request/response schemas, consistent machine-readable errors, and cursor pagination for file/admin listings. Return `409` for name/state conflicts, `422` for invalid paths/metadata, and `404` for inaccessible user-owned resources. Use `202` for accepted asynchronous deletion.

Authentication and users:

- `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`.
- `POST /auth/change-password` — required addition for first-login rotation.
- `GET /admin/users`, `POST /admin/users`.

Uploads:

- `POST /uploads`: `{ filename, size, mimeType, folderPath, clientUploadId, retryFileId? }`. Use the client UUID as the idempotency identity for initial creation; repeat requests must match stored metadata. Return the file ID, generation, upload kind, expiry, and PUT information or multipart parameters.
- `POST /uploads/:id/parts`: accept bounded part numbers and the generation; sign only the expected parts of the current active upload.
- `POST /uploads/:id/complete`: accept the generation and ordered part/ETag manifest for multipart; for a single PUT, confirm completion through HEAD. The endpoint is idempotent and reconciles uncertain results.
- `GET /uploads/:id`: current state, expiry, and multipart reconciliation data. Re-signing expired URLs is allowed only for the same still-active session.
- `DELETE /uploads/:id`: cancel through the same access-revocation and cleanup flow as file deletion.
- Every request initiating or retrying a file upload supplies its full folder path. Part/completion requests use the established file ID and generation rather than resolving a new destination.

Files and folders:

- `GET /files?folderPath=...`, `GET /files/:id`, `DELETE /files/:id`.
- `GET /files/:id/download`: return an authorized same-origin content URL.
- `GET /files/:id/content`: additional streaming route; recheck session, ownership, `done`, and deletion state, then stream the recorded clean object with Range support and a safe attachment filename. Do not buffer the file or publicly cache authenticated content.
- `POST /folders/ensure-paths`, `GET /folders`, `POST /folders` with a path.
- `PATCH /folders/:id` with a new name and/or destination parent path; `DELETE /folders/:id` recursively.

Admin monitoring:

- `GET /admin/files`, `GET /admin/jobs`, `GET /admin/jobs/:fileId`, `GET /admin/jobs/:fileId/attempts`.
- Derive jobs, counts, stage, stuck indicators, and timestamps from `files` and `scan_attempts`. Filter by owner, status, stage, and lease expiry; return bounded attempt detail.

**Download decision:** a direct R2 presigned GET remains usable until expiry, which conflicts with immediate revocation. Use the same-origin authenticated streaming URL above. Deletion denies new download/range requests immediately; bytes already delivered or a stream already in flight cannot be recalled. [R2 presigned URL security](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

## 7. Upload lifecycle and object identity

Backend statuses: `pending`, `uploading`, `scanning`, `retrying`, `processing`, `done`, `infected`, `failed`, `deleting`, `deleted`. Keep a separate stage such as `verify`, `scan`, `promote`, or `cleanup`; preserve the failed stage for recovery and monitoring.

```text
pending -> uploading -> scanning -> processing -> done
                         |              |
                         +-> infected   +-> retrying -> processing
                         +-> retrying -> scanning
                         +-> failed

any accessible state -> deleting -> deleted
```

Local UI state supplies Pending/Uploading and byte progress. Backend polling supplies Scanning/Processing/Done and terminal errors. `retrying` records which backend stage should resume; browser part retries remain local transfer information.

### Upload initialization and direct transfer

1. Validate metadata and size, resolve the path, and atomically reserve the filename in D1.
2. Create a new unpredictable generation and quarantine key, e.g. `uploads/{userId}/{fileId}/{generation}`. Names and folder paths are metadata, never storage keys.
3. Below 20 MiB: issue a short-lived presigned PUT that **signs and requires `If-None-Match: *`** and server-selected session metadata. A committed object cannot be overwritten by replaying its URL. Reconcile a lost success response with HEAD before treating `412` as failure. R2 documents atomic create-once PUT conditions in its [S3 extensions](https://developers.cloudflare.com/r2/api/s3/extensions/).
4. At or above 20 MiB: create one multipart session server-side. The browser gets only part PUT URLs; it cannot initialize or complete a different session. Use 16 MiB parts, four concurrent parts, and a smaller final part.
5. Keep completed part numbers and ETags in browser memory. After uncertain responses, ask the backend to ListParts. Verify part count, sizes, ETags, generation, and expected total before server-side completion.
6. Retry failed parts up to five times after the initial request, with capped exponential backoff and jitter. Retry only affected parts. Refresh URLs only after rechecking current state and ownership.
7. `/complete` reconciles a timeout after R2 completion with HEAD. It must never regress a file already claimed by the Queue Worker. Single-PUT processing does not depend on the browser calling `/complete`.
8. Verify actual size, source ETag, key, and server-assigned session metadata using R2. Reject mismatches and files above the limit before scanning. Client MIME is advisory; use safe attachment downloads.

An upload retry reuses a failed **transfer** record through `retryFileId`, after old-session cleanup, with a new key/generation and upload ID. It does not reset audit history or the lifetime three-scan limit. Infected files are not eligible for a fresh verdict by pressing retry. A scan-exhausted file must be deleted before a new file is created; a promotion failure resumes its existing approved verdict.

R2 event notifications include PUT and multipart completion events. Configure the quarantine `uploads/` prefix only; normalize native events and internal cleanup messages into a small tagged union. Match the generation against D1 before changing state. [R2 event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/).

Configure quarantine CORS for explicit app/development origins, required PUT headers (including `If-None-Match`), and exposed `ETag`. No browser clean-bucket write permissions. [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/).

## 8. Queue processing, scanning, and promotion

### Claims and retries

- Consumer batch size: five; use bounded per-message handling and explicit acknowledgements so one failure does not replay successful siblings.
- Claim through one shared compare-and-set D1 operation: require the current generation, a resumable stage, no deletion request, and an absent/expired lease. Set a fresh cryptographic claim token.
- Start with a 16-minute lease, longer than the documented 15-minute consumer invocation ceiling. Bound individual external operations; surface crashed work as recoverable after lease expiry. Tune only after measuring deployed behavior. [Queues limits](https://developers.cloudflare.com/queues/platform/limits/).
- A duplicate with a valid lease does not scan; retry it after the lease deadline rather than acknowledging away a possible recovery path. Completed or obsolete messages are acknowledged, with stale-object cleanup when needed.
- Every state update checks both the claim token and generation. Zero affected rows means ownership was lost; stop and never publish the result.
- Atomically reserve a scan slot and create its `started` attempt record using conditional SQL in a D1 batch. Count interrupted invocations toward the three allowed attempts.
- Queue delivery attempts are independent of scan attempts. Configure ten queue retries initially, capped exponential delays, and a DLQ. Only scanner invocations increment the scan count; verification/promotion/cleanup retries do not.
- After three operational scan failures, mark the file failed and acknowledge its scan message. An infected verdict is terminal immediately and never triggers a retry.
- Unexpected exhaustion goes to the DLQ. Keep failure/stuck state visible in D1. Provide a documented inspect-and-replay command for DLQ messages; replay still respects stage, generation, deletion, and scan limits. No scheduler or extra table.
- D1 writes and queue sends cannot share a transaction. Await enqueueing before returning success for API-originated cleanup; repeated DELETE repairs an enqueue failure. Use R2 events for upload completion and show unreconciled deletion state to operators. Automated general reconciliation is deferred.

Use Cloudflare's [batching, retry, and delay controls](https://developers.cloudflare.com/queues/configuration/batching-retries/); never acknowledge an unfinished operation before its durable state is saved.

### Scanner interface and audit

The scanner accepts the original filename plus the verified object identity and a way to read that object. It returns clean/infected with a reason and bounded provider metadata, or throws an operational error. A future real scanner must support the 3 GB limit without buffering it inside the Worker.

Implement the fake checks in this order, case-insensitively:

1. Filename contains `virus`: infected, `virus in name`.
2. Otherwise contains `communism`: infected, `communism in name`.
3. Otherwise sample once for that invocation: 10% infected, `virus found`; all others clean.

Inject randomness in tests. Persist the attempt result and source identity before promotion; duplicate deliveries and promotion retries reuse that result instead of drawing again.

### Promotion

1. Save the clean verdict and its exact source ETag, then transition to `processing`.
2. Use server-side S3 `CopyObject` with `x-amz-copy-source-if-match` into a generation/claim-specific clean key. Never transfer a 3 GB buffer through JavaScript memory.
3. HEAD the destination and verify its size and server-controlled source/generation metadata; compare a suitable provider checksum when available. Do not assume a multipart ETag equals a single-copy ETag.
4. Publish the clean key/ETag and `done` using the claim/generation/deletion guard.
5. Remove the quarantine object. If removal fails after publication, retry the cleanup stage while leaving the approved file downloadable.

The small-upload conditional PUT and backend-only multipart completion keep the source immutable until cleanup. A changed source fails promotion and requires investigation; never copy newly observed content under an old verdict. R2 supports conditional CopyObject; its UploadPartCopy does **not** support the same source conditions, so do not silently substitute it. [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/).

Prove cross-bucket conditional CopyObject at 3 GB early. If the deployed operation cannot meet the requirement, choose and document a bounded streaming/multipart alternative tied to the immutable source before implementing promotion. This feasibility check is a release gate, not an assumed platform capability.

## 9. Deletion, cancellation, and cleanup

1. Atomically set `delete_requested_at`, set `deleting`, and invalidate the claim. Every access path and upload-signing/completion path rejects deletion-requested records immediately.
2. Abort active browser XHRs when cancellation originates in this tab. Server cancellation remains authoritative for other tabs.
3. Enqueue an idempotent cleanup message. Abort any multipart session and delete both bucket prefixes for that file, including superseded generations and abandoned claim-specific promotion objects.
4. Track the latest signed URL expiry and any in-flight processing lease. Do not finalize deletion while a known writer could still commit. Use delayed queue retries and a final verification pass after the write window closes.
5. Handle late quarantine object-create events for cancelled, obsolete, and deleted generations as cleanup only, including replay after the original object was removed. They must never restart scanning or restore access.
6. Set `deleted_at` only after required physical cleanup succeeds; keep the row and attempts. A cleanup failure leaves the name reserved and retries through Queues/DLQ.

Revoking a URL already issued to R2 is not immediate. Prove the cancellation/write/cleanup ordering under in-flight PUT and CopyObject races in the initial storage spike, including any required drain delay. Do not claim that deleting a D1 row revokes a signed PUT.

For recursive folder deletion, transactionally mark the subtree and its files using recursive CTEs, then clean files in bounded queue batches. SQL guards reject writes beneath a deleting ancestor. Mark folders fully deleted bottom-up only after all descendants are deleted; empty folders can finish immediately. Preserve tombstones for historical ownership and parent references.

Explicitly configure R2 lifecycle rules to abort incomplete multipart uploads, initially after one day. This does not clean abandoned D1 records or ordinary completed objects; expose those in admin monitoring and defer general orphan reconciliation as requested. Never expire arbitrary quarantine objects while they could still be needed for an approved retry.

## 10. React experience and transfer progress

User-requested refinements: unfinished transfers stay in the upload panel and admin history, with My files showing a record only after complete object verification. A single-file batch has no duplicate overall progress section. ETAs use readable seconds/minutes/hours. Confirmed bytes remain internal accounting; the visible counter reports displayed transfer progress.

Approved files now support a preview dialog for text, formatted Markdown, PDF, raster images, and browser-compatible video. The same authenticated streaming route accepts `preview=1` only for explicitly supported extensions; other formats stay attachments. Text/Markdown previews are capped at 2 MiB, Markdown skips raw HTML and remote images, and video retains Range support. Downloads remain available in the dialog.

- File manager: breadcrumbs, folder tree/list, names, sizes, statuses, upload/file/folder controls, empty/error states, and approved download links.
- Upload provider lives above the route outlet and owns one sequential file queue. Route changes do not recreate it.
- Use `XMLHttpRequest.upload.onprogress` for byte-level upload events; use `File.slice()` for parts.
- Track confirmed bytes independently from current per-request bytes. Maintain a monotonic displayed-byte high-water mark per file and batch. After failure, remove unconfirmed bytes from accounting but freeze the visible percentage until the retry exceeds its previous contribution.
- Bound displayed bytes by file/batch totals. Show 100% transferred only after transfer completion is confirmed; scanning and processing have their own labels.
- Derive smoothed speed and ETA from useful progress, excluding retries' duplicate traffic and offline time. On network loss show `Reconnecting...`, pause ETA, and resume with bounded retry/backoff after connectivity returns.
- Panel: filename, operation, retry count, confirmed/transferred and total bytes, file/batch progress, speed, ETA, cancel, and per-file failures. Handle zero-byte files without division by zero.
- Add `beforeunload` only while transfers are active; rely on the browser's native wording. Explain that a refresh loses the in-memory queue and cannot resume the upload.
- Poll active backend states every 2.5 seconds using batched file IDs through `GET /files`; bound each request and prevent overlapping polling calls. Stop terminal-file polling and back off on errors. Admin monitoring polls while active work is visible.
- Successful browser transfer immediately permits the next file to upload; scanning/promotion run independently in the background.

## 11. Infrastructure and operations

- Environments: local, staging, production; separate D1, buckets, queues, and secrets per deployed environment.
- Resources per environment: one D1 database, two private R2 buckets, one processing queue, and its DLQ. One Queue Worker handles upload events and internal cleanup messages.
- API bindings: D1, bucket bindings as needed, processing queue producer, static assets, signing/session secrets. Consumer bindings: D1, both buckets, processing queue producer for continuations, and narrowly scoped S3 credentials for server-side copy.
- Give browser signing credentials access only to the quarantine operations needed. Never return credentials to the browser; return individual signed operations.
- Commit configuration shapes and ignored-secret templates with placeholders. Store real credentials in Cloudflare secrets/local ignored files. Seed the admin separately from schema migration.
- Enable structured Workers logs and traces for both Workers. Correlate request/message/file/generation/claim/attempt IDs; redact sensitive values and bound provider payloads.
- Monitor queue backlog/DLQ depth, failed scans, expired leases, promotion failures, and pending cleanup. A stuck indicator derives from last activity and lease expiry; it is not a separate scheduler.
- Local tests emulate events explicitly if the local environment cannot reproduce R2 S3 endpoints or event delivery. Use staging to validate real presigning, CORS, conditional writes, multipart, queue retries, and large-object copy.
- Deployment order: resources and migrations, consumer, event notification rules, API/frontend, bootstrap admin, smoke checks. Document rollback compatibility for migrations; code rollback does not undo stored data.

## 12. Implementation sequence and completion criteria

### Phase 0 — Validate platform assumptions

- [x] Scaffold a throwaway/staging storage probe for direct conditional PUT, signature enforcement, CORS/ETag exposure, and zero-byte objects.
- [x] Exercise multipart upload, ListParts reconciliation, completion timeout, and object-created event payloads.
- [x] Prove conditional cross-bucket promotion for a 3 GB object and destination verification within Worker limits.
- [x] Exercise cancellation during PUT, multipart completion, and promotion; settle the writer-drain rule before finalizing cleanup.
- [x] Benchmark secure password hashing in the target Worker runtime and select its library/bundling configuration.
- [x] Validate the pinned Drizzle/D1 integration: generated expression/partial indexes, composite ownership foreign keys, conditional `RETURNING`, batch rollback, and migration application through the chosen D1 runner.

Exit: the security and large-file assumptions have evidence; any required design adjustment is recorded here before feature implementation.

### Phase 1 — Foundation and authentication

- [x] Create the four workspace projects, TypeScript/build scripts, generated bindings, environment examples, and CI checks.
- [x] Add the shared Drizzle D1 client, four-table SQLite schema, generated/reviewed migrations, constraints/indexes, domain queries, shared contracts, and path validation.
- [x] Implement bootstrap, login/logout/me/change-password, authorization middleware, and admin user creation/listing.

Exit: first-login rotation is enforced; only admins create users; ownership and normalized root/nested uniqueness work under concurrent requests.

### Phase 2 — File manager and small-file vertical slice

- [x] Implement folder resolution/ensure-paths, flat listing, breadcrumbs, create/rename/move, and file listings.
- [x] Complete one small upload through quarantine event, audited fake scan, conditional promotion, status polling, authorized download, and deletion.
- [x] Add atomic claims, duplicate delivery handling, retries, and DLQ configuration in this slice.

Exit: clean, infected, operational failure, duplicate event, and cancellation flows work end to end before multipart UI complexity.

### Phase 3 — Large files and full directory uploads

- [x] Implement multipart initiation/signing/completion/abort and uncertain-part reconciliation.
- [x] Add directory picker/drop adapters, empty-directory manifest, and sequential global upload queue.
- [x] Add monotonic file/batch progress, speed/ETA, reconnect behavior, cancellation, and native leave warning.

Exit: a nested folder with empty directories and a 3 GB file uploads correctly; retrying a failed part preserves the other completed parts; navigation does not interrupt transfer.

### Phase 4 — Recovery, deletion, and administration

- [x] Finish recursive deletion, delayed final cleanup, stale generation handling, and filename reuse rules.
- [x] Add admin files/jobs/detail/attempt views with filters, counts, polling, errors, and stuck indicators.
- [x] Add DLQ inspection/replay instructions and request-level repair for enqueue/completion uncertainty.

Exit: crashes at each external-operation boundary recover without unapproved downloads, duplicate concurrent scans, lost scan history, or stale publication.

### Phase 5 — Verification and delivery

- [x] Run type checks, build, focused runtime/integration tests, and browser acceptance tests.
- [x] Run staging tests against actual R2/Queues and the maximum-size file.
- [x] Document setup/deployment, secret names, bootstrap, scanner limitations, supported browsers, operational recovery, and intentional limits.
- [x] Capture an end-to-end demonstration and ensure no credentials or generated large test files enter source control.

## 13. Test priorities

Tests should cover behavior and failure boundaries rather than duplicate implementation details:

- Paths: traversal, separators, reserved device names/extensions, length/depth, NFC/case collisions, same names across owners, and root-level uniqueness.
- Database integration: apply Drizzle-generated migrations to a fresh D1 instance, verify constraints/indexes against real inserts, and verify transactional rollback of a failed claim/attempt batch.
- Concurrency: simultaneous ensure-paths/file creation, folder cycles, create versus recursive delete, duplicate queue deliveries, lease expiry, and stale-token updates.
- Authentication: forced rotation, wrong-role rejection, cross-user file/folder IDs, logout/session invalidation, CSRF, and no quarantine download even for admins.
- Uploads: 0 bytes, just below/at 20 MiB, uneven final part, 3 GB boundary and above-limit rejection, URL expiry, falsified size, lost responses, part reconciliation, retry exhaustion, and no overwrite through signed URL replay.
- Processing: every fake-scanner branch, deterministic randomness, maximum three invocations, interrupted attempt audit, promotion retries without rescanning, source mismatch, and crash after copy/before publication.
- Deletion: before completion, during scan/copy, cleanup failure, delayed event after deletion, name reuse only after cleanup, and nested-folder cancellation.
- UI: files remain sequential, parts stay at concurrency four, progress never decreases, ETA pauses offline, routes preserve uploads, refresh has no resume, folder collection reads all entries, and terminal polling stops.

Definition of done: all assignment flows work in staging, including the full-size path; exactly four application tables remain; clean downloads require current authorization and a recorded approved source; operational failures are visible and recoverable; the initial admin password and all other credentials stay out of source control.
