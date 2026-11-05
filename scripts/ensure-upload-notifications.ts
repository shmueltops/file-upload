import { cloudflare, CloudflareApiError } from './cloudflare-api';

type NotificationRule = { prefix?: string; suffix?: string; actions: string[] };

// R2's PUT appends rules; it does not replace the queue's configuration.
// Reuse existing coverage and add only missing actions without interrupting events.
export async function ensureUploadNotifications(
  path: string,
  request: typeof cloudflare = cloudflare,
) {
  let rules: NotificationRule[];
  try {
    rules = (await request<{ rules: NotificationRule[] }>(path)).rules;
  } catch (error) {
    if (
      !(error instanceof CloudflareApiError) ||
      error.status !== 404 ||
      !error.codes.includes(11015)
    )
      throw error;
    rules = [];
  }
  const actions = ['PutObject', 'CompleteMultipartUpload'].filter(
    (action) =>
      !rules.some(
        (rule) =>
          'uploads/'.startsWith(rule.prefix || '') && !rule.suffix && rule.actions.includes(action),
      ),
  );
  if (!actions.length) return;
  await request(path, 'PUT', {
    rules: [{ prefix: 'uploads/', actions, description: 'Scan completed file uploads' }],
  });
}
