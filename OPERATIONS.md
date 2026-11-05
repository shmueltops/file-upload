# Operating File Vault

## Processing and cleanup

The admin Activity screen lists owner, status, stage, attempt count, processing start/last activity, and the last error. Open a row for detailed attempt history. Filters include status, owner, stage, and expired processing leases. Counts come from the files table.

Both Workers emit structured logs with file/message identifiers. Cloudflare logs and traces are enabled; query strings are redacted so signed URL parameters are not persisted in invocation logs. Never disable that redaction when investigating uploads.

The processing queue has batches of at most five messages, ten delivery retries, and a dead-letter queue. A duplicate under a valid lease is delayed until the lease deadline. A recovered interrupted scan consumes its reserved attempt; a persisted clean verdict resumes promotion without scanning again.

Files waiting for storage cleanup may remain `deleting` for several minutes. During an interrupted processing invocation, the conservative lease can extend this to 16 minutes. Their filenames remain reserved. Repeat DELETE if an API response indicated that queue enqueueing failed; deletion is idempotent.

Incomplete multipart sessions are aborted by R2 lifecycle after one day. Ordinary objects and D1 upload records are not expired by that rule. General orphan reconciliation is intentionally manual.

## Dead-letter recovery

1. Inspect the failed file's admin detail and Cloudflare logs. Fix credentials, permissions, provider availability, or the underlying storage error first.
2. In the Cloudflare Queues dashboard, inspect `file-vault-dead-letter` (or the configured environment-specific queue).
3. Replay the original message into the processing queue with Cloudflare's message tools. Preserve the file ID, generation, and message type; native R2 messages can be replayed unchanged.
4. Verify that the file advances or cleanup completes. Replays still enforce ownership of the processing claim, generation matching, deletion state, and the lifetime three-scan ceiling.

Do not clear a clean verdict or reset attempt counters to make a retry succeed. A scan-exhausted or infected record must be deleted before its name can be used for a newly uploaded file. Promotion retries reuse the exact approved source. A failed transfer can start a fresh upload session against the same file record using `retryFileId`.

## Rollback and credentials

Code can be rolled back through Workers versions. Database migrations and object mutations are not reversed by a code rollback; keep deployed code compatible with the schema during rollout. Take a D1 backup before any destructive future migration.

Rotate Worker runtime secrets by updating the ignored `.env` and running deployment. Changing `SESSION_SECRET` signs every user out. Changing S3 credentials requires updating both Workers. Revoke old tokens through Cloudflare after verifying the replacement.

The initial admin bootstrap inserts only if absent. Re-running it never resets an existing admin's password. Test identities use `@test.invalid` and generated credentials; they are distinct from the deployment bootstrap account.
