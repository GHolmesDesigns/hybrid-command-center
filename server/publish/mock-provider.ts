import type {
  PublishProvider,
  PublishRequest,
  PublishSubmission,
  PublishTarget,
} from './provider.ts';

export class MockPublishProvider implements PublishProvider {
  readonly available = true;
  readonly submissions: PublishRequest[] = [];
  /** Every provider id `check` was asked about, so a test can prove a check did not happen. */
  readonly checks: string[] = [];
  targets: PublishTarget[];
  result: PublishSubmission = { providerPostId: 'mock-publication', state: 'SUBMITTED' };
  failure?: Error;
  constructor(targets: PublishTarget[] = []) {
    this.targets = targets;
  }
  async listTargets() {
    return this.targets;
  }
  async submit(request: PublishRequest) {
    this.submissions.push(request);
    if (this.failure) throw this.failure;
    return this.result;
  }
  async check(providerPostId: string) {
    this.checks.push(providerPostId);
    return this.result;
  }
  async cancel(_providerPostId: string) {
    void _providerPostId;
    return;
  }
}
