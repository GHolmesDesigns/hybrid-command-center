import { redactSecrets } from '../../integration-log.ts';

export class BufferProviderError extends Error {
  readonly rateLimited: boolean;
  readonly ambiguous: boolean;
  readonly retryAfterSeconds?: number;
  constructor(
    message: string,
    rateLimit: { rateLimited?: boolean; retryAfterSeconds?: number; ambiguous?: boolean } = {},
  ) {
    super(redactSecrets(message));
    this.name = 'BufferProviderError';
    this.rateLimited = rateLimit.rateLimited ?? false;
    this.ambiguous = rateLimit.ambiguous ?? false;
    if (rateLimit.retryAfterSeconds !== undefined)
      this.retryAfterSeconds = rateLimit.retryAfterSeconds;
  }
}
