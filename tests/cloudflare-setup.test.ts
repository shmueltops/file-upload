import { expect, it, vi } from 'vitest';
import { CloudflareApiError, cloudflare } from '../scripts/cloudflare-api';
import { ensureUploadNotifications } from '../scripts/ensure-upload-notifications';

const path = '/notification-configuration';
it('does not append overlapping rules when preparation runs again', async () => {
  const request = vi.fn().mockResolvedValue({
    rules: [
      {
        prefix: 'uploads/',
        actions: ['CompleteMultipartUpload', 'PutObject'],
        ruleId: 'existing',
      },
    ],
  });
  await ensureUploadNotifications(path, request as typeof cloudflare);
  await ensureUploadNotifications(path, request as typeof cloudflare);
  expect(request.mock.calls).toEqual([[path], [path]]);
});
it('reuses broader notification coverage and adds only missing actions', async () => {
  const request = vi.fn().mockResolvedValue({ rules: [{ actions: ['PutObject'] }] });
  await ensureUploadNotifications(path, request as typeof cloudflare);
  expect(request).toHaveBeenLastCalledWith(path, 'PUT', {
    rules: [
      {
        prefix: 'uploads/',
        actions: ['CompleteMultipartUpload'],
        description: 'Scan completed file uploads',
      },
    ],
  });
});
it('creates rules when R2 reports no configuration', async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce(new CloudflareApiError('No configuration', 404, [11015]))
    .mockResolvedValueOnce({});
  await ensureUploadNotifications(path, request as typeof cloudflare);
  expect(request.mock.calls[1]?.[2].rules[0].actions).toEqual([
    'PutObject',
    'CompleteMultipartUpload',
  ]);
});
it('does not hide authentication or unexpected configuration errors', async () => {
  const error = new CloudflareApiError('Forbidden', 403, [10000]);
  const request = vi.fn().mockRejectedValue(error);
  await expect(ensureUploadNotifications(path, request as typeof cloudflare)).rejects.toBe(error);
  expect(request).toHaveBeenCalledTimes(1);
});
