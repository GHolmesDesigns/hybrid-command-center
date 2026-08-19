import type {
  ProviderPostRecord,
  PublishProvider,
  PublishRequest,
  PublishSubmission,
  PublishTarget,
} from './provider.ts';

/**
 * The provider every automated test runs against. Nothing here contacts Post Bridge.
 *
 * It keeps a small amount of state rather than answering from fixed values, because the actions
 * this app takes on a post the provider already holds are only meaningful against a record that
 * remembers: an update has to be readable afterwards, and a cancel has to make the next `describe`
 * say something different. `record` is that memory, and `updates`/`cancels` are the call logs a
 * test asserts against when it needs to prove that nothing remote happened.
 */
export class MockPublishProvider implements PublishProvider {
  readonly available = true;
  readonly submissions: PublishRequest[] = [];
  /** Every provider id `check` was asked about, so a test can prove a check did not happen. */
  readonly checks: string[] = [];
  /** Every id `describe` was asked about — the read a preview makes and a commit must not skip. */
  readonly describes: string[] = [];
  /** Each `update`, so a test can prove `scheduled_at` was sent and what the body carried. */
  readonly updates: { providerPostId: string; request: PublishRequest }[] = [];
  /** Each `cancel`, so a test can prove a refused action reached no provider. */
  readonly cancels: string[] = [];
  targets: PublishTarget[];
  result: PublishSubmission = { providerPostId: 'mock-publication', state: 'SUBMITTED' };
  failure?: Error;
  /** Raised by `update` alone, so a partial outcome can be exercised without failing the read. */
  updateFailure?: Error;
  /** Raised by `cancel` alone, for the same reason. */
  cancelFailure?: Error;
  /** Raised by `describe`, so "the provider could not be read" is a testable preview. */
  describeFailure?: Error;
  /**
   * What the provider is holding. A test that never touches it gets a scheduled post matching the
   * default submission, which is the case the reconciliation panel exists to report *no difference*
   * for.
   */
  record: ProviderPostRecord = {
    providerPostId: 'mock-publication',
    state: 'SCHEDULED',
    caption: '',
    scheduledInstant: null,
    mediaUrls: [],
    accountIds: [],
  };
  constructor(targets: PublishTarget[] = []) {
    this.targets = targets;
  }
  async listTargets() {
    return this.targets;
  }
  async submit(request: PublishRequest) {
    this.submissions.push(request);
    if (this.failure) throw this.failure;
    // The submitted request becomes what the provider holds, so a describe after a submit agrees
    // with it without the test having to state the same thing twice.
    this.record = {
      providerPostId: this.result.providerPostId,
      state: 'SCHEDULED',
      caption: request.caption,
      scheduledInstant: request.scheduledInstant,
      mediaUrls: [...request.mediaUrls],
      accountIds: request.targets.map((target) => target.accountId),
    };
    return this.result;
  }
  async check(providerPostId: string) {
    this.checks.push(providerPostId);
    return this.result;
  }
  async describe(providerPostId: string) {
    this.describes.push(providerPostId);
    if (this.describeFailure) throw this.describeFailure;
    return { ...this.record, providerPostId };
  }
  async update(providerPostId: string, request: PublishRequest) {
    this.updates.push({ providerPostId, request });
    if (this.updateFailure) throw this.updateFailure;
    this.record = {
      ...this.record,
      providerPostId,
      caption: request.caption,
      scheduledInstant: request.scheduledInstant,
      mediaUrls: [...request.mediaUrls],
      accountIds: request.targets.map((target) => target.accountId),
    };
    return { providerPostId, state: 'SUBMITTED' as const };
  }
  async cancel(providerPostId: string) {
    this.cancels.push(providerPostId);
    if (this.cancelFailure) throw this.cancelFailure;
    return;
  }
}
