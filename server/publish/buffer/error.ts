import { redactSecrets } from '../../integration-log.ts';

export class BufferProviderError extends Error {
  readonly rateLimited: boolean;
  readonly retryAfterSeconds?: number;
  constructor(
    message: string,
    rateLimit: { rateLimited?: boolean; retryAfterSeconds?: number } = {},
  ) {
    super(redactSecrets(message));
    this.name = 'BufferProviderError';
    this.rateLimited = rateLimit.rateLimited ?? false;
    if (rateLimit.retryAfterSeconds !== undefined)
      this.retryAfterSeconds = rateLimit.retryAfterSeconds;
  }
}
