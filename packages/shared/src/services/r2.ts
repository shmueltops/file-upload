import {
  S3Client,
  PutObjectCommand,
  UploadPartCommand,
  ListPartsCommand,
  CopyObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { SignJWT, jwtVerify } from 'jose';
import type { StoredFile } from '../db/schema';
import { AppError, type ServiceBindings } from './types';
import { PART_SIZE } from '../contracts';
import { DOMParser, Node as XmlNode } from '@xmldom/xmldom';

export const URL_LIFETIME = 5 * 60_000;
export function s3(env: ServiceBindings) {
  // The SDK's browser XML decoder expects DOMParser; Workers expose Web APIs
  // without a DOM. This parser operates on the small trusted S3 XML responses.
  if (!('DOMParser' in globalThis))
    Object.defineProperty(globalThis, 'DOMParser', { value: DOMParser, configurable: true });
  if (!('Node' in globalThis))
    Object.defineProperty(globalThis, 'Node', { value: XmlNode, configurable: true });
  if (!env.R2_ENDPOINT || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY)
    throw new Error('R2 S3 credentials have not been configured.');
  return new S3Client({
    region: 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}
export async function uploadUrl(env: ServiceBindings, file: StoredFile, part?: number) {
  if (env.LOCAL_MODE === 'true') {
    const token = await new SignJWT({ id: file.id, generation: file.upload_generation, part })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('local-r2')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(env.SESSION_SECRET));
    return {
      url: `${env.APP_ORIGIN}/__local/r2?token=${token}`,
      headers: part ? {} : { 'If-None-Match': '*' },
    };
  }
  // R2 requires user metadata on actual PUT headers. AWS's default presigner
  // hoists these into query parameters, which R2 does not persist as metadata.
  const options = {
    expiresIn: URL_LIFETIME / 1000,
    unhoistableHeaders: new Set(['if-none-match', 'x-amz-meta-file-id', 'x-amz-meta-generation']),
  };
  const url = part
    ? await getSignedUrl(
        s3(env),
        new UploadPartCommand({
          Bucket: env.QUARANTINE_BUCKET,
          Key: file.quarantine_key,
          UploadId: file.multipart_upload_id!,
          PartNumber: part,
        }),
        options,
      )
    : await getSignedUrl(
        s3(env),
        new PutObjectCommand({
          Bucket: env.QUARANTINE_BUCKET,
          Key: file.quarantine_key,
          ContentType: file.mime_type,
          IfNoneMatch: '*',
          Metadata: { 'file-id': file.id, generation: file.upload_generation },
        }),
        options,
      );
  return {
    url,
    headers: part
      ? {}
      : {
          'If-None-Match': '*',
          'Content-Type': file.mime_type,
          'x-amz-meta-file-id': file.id,
          'x-amz-meta-generation': file.upload_generation,
        },
  };
}
export async function verifyLocalToken(env: ServiceBindings, token: string) {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(env.SESSION_SECRET), {
    audience: 'local-r2',
    algorithms: ['HS256'],
  });
  return {
    id: String(payload.id),
    generation: String(payload.generation),
    part: typeof payload.part === 'number' ? payload.part : undefined,
  };
}
export async function listParts(env: ServiceBindings, file: StoredFile) {
  if (!file.multipart_upload_id) return [];
  if (env.LOCAL_MODE === 'true') {
    // R2 bindings do not expose ListParts. The local adapter persists ETags as tiny
    // private objects; production always queries the real S3 ListParts operation.
    const prefix = `parts/${file.id}/${file.upload_generation}/`;
    const result = await env.QUARANTINE.list({ prefix });
    return Promise.all(
      result.objects.map(async (o) => {
        const value = await env.QUARANTINE.get(o.key);
        return JSON.parse(await value!.text()) as {
          partNumber: number;
          etag: string;
          size: number;
        };
      }),
    );
  }
  const result = await s3(env).send(
    new ListPartsCommand({
      Bucket: env.QUARANTINE_BUCKET,
      Key: file.quarantine_key,
      UploadId: file.multipart_upload_id,
    }),
  );
  return (result.Parts ?? []).map((p) => ({
    partNumber: p.PartNumber!,
    etag: p.ETag!,
    size: p.Size!,
  }));
}
export async function copyToClean(env: ServiceBindings, file: StoredFile, key: string) {
  if (env.LOCAL_MODE === 'true') {
    const options = {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: {
        'file-id': file.id,
        generation: file.upload_generation,
        'source-etag': file.approved_source_etag!,
      },
    };
    const read = async (offset: number, length: number) => {
      const source = await env.QUARANTINE.get(file.quarantine_key, {
        onlyIf: { etagMatches: file.approved_source_etag! },
        ...(length ? { range: { offset, length } } : {}),
      });
      if (!source || source.etag !== file.approved_source_etag || !('arrayBuffer' in source))
        throw new AppError(409, 'The approved object changed before promotion.');
      return source.arrayBuffer(); // Bounded to one 16 MiB range, including via the Node emulator proxy.
    };
    if (file.actual_size! <= PART_SIZE)
      await env.CLEAN.put(key, await read(0, file.actual_size!), options);
    else {
      const upload = await env.CLEAN.createMultipartUpload(key, options),
        parts: R2UploadedPart[] = [];
      try {
        for (let offset = 0; offset < file.actual_size!; offset += PART_SIZE)
          parts.push(
            await upload.uploadPart(
              parts.length + 1,
              await read(offset, Math.min(PART_SIZE, file.actual_size! - offset)),
            ),
          );
        await upload.complete(parts);
      } catch (error) {
        await upload.abort();
        throw error;
      }
    }
  } else {
    await s3(env).send(
      new CopyObjectCommand({
        Bucket: env.CLEAN_BUCKET,
        Key: key,
        CopySource: `${env.QUARANTINE_BUCKET}/${file.quarantine_key.split('/').map(encodeURIComponent).join('/')}`,
        CopySourceIfMatch: `"${file.approved_source_etag!.replaceAll('"', '')}"`,
        MetadataDirective: 'REPLACE',
        ContentType: 'application/octet-stream',
        Metadata: {
          'file-id': file.id,
          generation: file.upload_generation,
          'source-etag': file.approved_source_etag!,
        },
      }),
    );
  }
  const target = await env.CLEAN.head(key);
  if (
    !target ||
    target.size !== file.actual_size ||
    target.customMetadata?.['source-etag'] !== file.approved_source_etag ||
    target.customMetadata?.generation !== file.upload_generation
  )
    throw new Error('Clean object verification failed.');
  return target;
}
export async function deletePrefix(bucket: R2Bucket, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
