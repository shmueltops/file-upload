import type { WorkMessage } from '../contracts';
// Shared service requirements. The entrypoint binding type is generated from cf configuration.
export interface ServiceBindings {
  DB: D1Database;
  QUARANTINE: R2Bucket;
  CLEAN: R2Bucket;
  JOBS: Queue<WorkMessage>;
  SESSION_SECRET: string;
  LOCAL_MODE?: string;
  APP_ORIGIN: string;
  R2_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  QUARANTINE_BUCKET: string;
  CLEAN_BUCKET: string;
}
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'invalid_request',
  ) {
    super(message);
  }
}
export class RetryWork extends Error {
  constructor(
    public delay = 10,
    message = 'Retry processing',
  ) {
    super(message);
  }
}
