export interface PublishTarget {
  id: number;
  platform: string;
  handle: string;
  name: string;
}

export interface PublishRequest {
  caption: string;
  mediaUrls: string[];
  scheduledInstant: string;
  timezone: string;
  targets: { accountId: number; platform: string }[];
}

export interface PublishSubmission {
  providerPostId: string;
  state: 'SUBMITTED' | 'CONFIRMED' | 'PARTIAL' | 'FAILED';
  targets?: {
    accountId: number;
    outcome: 'SUCCESS' | 'FAILURE';
    permalink?: string;
    error?: string;
  }[];
  error?: string;
}

export class PublishProviderError extends Error {
  readonly ambiguous: boolean;
  constructor(message: string, ambiguous = false) {
    super(message);
    this.name = 'PublishProviderError';
    this.ambiguous = ambiguous;
  }
}

export interface PublishProvider {
  readonly available: boolean;
  listTargets(): Promise<PublishTarget[]>;
  submit(request: PublishRequest): Promise<PublishSubmission>;
  check(providerPostId: string): Promise<PublishSubmission>;
  cancel(providerPostId: string): Promise<void>;
}

export class UnavailablePublishProvider implements PublishProvider {
  readonly available = false;
  private readonly reason: string;
  constructor(reason = 'Publishing is not configured.') {
    this.reason = reason;
  }
  private fail(): never {
    throw new Error(this.reason);
  }
  async listTargets(): Promise<PublishTarget[]> {
    return this.fail();
  }
  async submit(_request: PublishRequest): Promise<PublishSubmission> {
    void _request;
    return this.fail();
  }
  async check(_providerPostId: string): Promise<PublishSubmission> {
    void _providerPostId;
    return this.fail();
  }
  async cancel(_providerPostId: string): Promise<void> {
    void _providerPostId;
    return this.fail();
  }
}
