import type {
  ProviderPostRecord,
  PublishProvider,
  PublishMediaSource,
  PublishRequest,
  PublishSubmission,
  PublishTarget,
} from './provider.ts';
import { PublishMediaUploadError, PublishProviderError } from './provider.ts';
import type {
  AnalyticsProvider,
  ProviderAnalyticsDay,
  ProviderAnalyticsRecord,
} from './analytics-provider.ts';
import type { ProviderInventoryPage, ProviderInventoryProvider } from './inventory-provider.ts';
import type {
  AnalyticsWindowProvider,
  ProviderAnalyticsWindowPage,
} from './analytics-window-provider.ts';
import type { AnalyticsWindow, AnalyticsWindowRow } from '../../shared/publish-analytics-window.ts';
import { ANALYTICS_PLATFORMS, type AnalyticsPlatform } from '../../shared/publish-analytics.ts';
import type { ProviderInventoryPost } from '../../shared/provider-inventory.ts';
import type { BufferChannel, BufferReadProvider } from './buffer/read-provider.ts';

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
  readonly uploads: { name: string; mimeType: string; sizeBytes: number; bytesRead: number }[] = [];
  /** Fail this one-based upload call, optionally after consuming the source body. */
  uploadFailureAt?: number;
  uploadFailure?: Error;
  targets: PublishTarget[];
  result: PublishSubmission = { providerPostId: 'mock-publication', state: 'SUBMITTED' };
  /**
   * What `check` answers, where that differs from what `submit` did.
   *
   * Two fields because they are two questions: `submit` is *did you take this*, and `check` is *what
   * became of it*, and only the second one can carry per-account rows at all — `post-results` does
   * not exist until the provider has tried to deliver. A case that needs a delivered submission to
   * report its result identities sets this and leaves the submission alone. Unset falls back to
   * `result`, so every case written before this existed behaves exactly as it did.
   */
  checkResult?: PublishSubmission;
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
  async uploadMedia(source: PublishMediaSource) {
    const call = this.uploads.length + 1;
    let bytesRead = 0;
    for await (const chunk of source.body) bytesRead += chunk.byteLength;
    this.uploads.push({
      name: source.name,
      mimeType: source.mimeType,
      sizeBytes: source.sizeBytes,
      bytesRead,
    });
    if (this.uploadFailureAt === call)
      throw (
        this.uploadFailure ??
        new PublishMediaUploadError(`Mock upload ${call} failed.`, `mock-media-${call}`)
      );
    return { mediaId: `mock-media-${call}` };
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
      mediaUrls: request.mediaUrls !== undefined ? [...request.mediaUrls] : [],
      ...(request.mediaIds !== undefined ? { mediaIds: [...request.mediaIds] } : {}),
      accountIds: request.targets.map((target) => target.accountId),
    };
    return this.result;
  }
  async check(providerPostId: string) {
    this.checks.push(providerPostId);
    return this.checkResult ?? this.result;
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
      mediaUrls: request.mediaUrls !== undefined ? [...request.mediaUrls] : [],
      ...(request.mediaIds !== undefined
        ? { mediaIds: [...request.mediaIds] }
        : { mediaIds: undefined }),
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

/**
 * The analytics provider every automated test runs against. Nothing here contacts Post Bridge.
 *
 * Stateful for the same reason `MockPublishProvider` is: the behaviours worth proving are about a
 * refresh meeting a provider that remembers — a sync that gets through, a `429` that does not, a
 * second refusal that has to wait longer than the first, and a failure that must leave yesterday's
 * figures exactly where they were. `records` and `daysByRecord` are that memory; the call logs are
 * what a test asserts against when it needs to prove a call did *not* happen.
 */
export class MockAnalyticsProvider implements AnalyticsProvider {
  readonly available = true;
  /** One entry per `sync`, carrying the platforms that call covered. */
  readonly syncs: (readonly AnalyticsPlatform[])[] = [];
  /** Every result-id set `list` was asked about, so a test can prove which deliveries were asked. */
  readonly lists: string[][] = [];
  /** Every analytics id `days` was asked about. */
  readonly dayReads: string[] = [];
  /** What the provider is holding, keyed by the result id it measures. */
  records: ProviderAnalyticsRecord[] = [];
  /** Daily snapshots per analytics id. A record with no entry here supplies no days at all. */
  daysByRecord: Record<string, ProviderAnalyticsDay[]> = {};
  /** Raised by `sync` alone — the rate-limit and outage paths. */
  syncFailure?: Error;
  /** Raised by `list` alone, so a sync that got through can still fail to answer. */
  listFailure?: Error;
  /**
   * What the parser would not store, as a real provider read would hand it back.
   *
   * Set by a test that needs to prove a refused provenance value reaches the integration log; the
   * refusal rule itself is `post-bridge-analytics-wire.ts` and is covered against fixtures there.
   */
  listWarnings: string[] = [];
  /** Raised by `days` alone, so a total can arrive while its history does not. */
  daysFailure?: Error;
  async sync() {
    this.syncs.push(ANALYTICS_PLATFORMS);
    if (this.syncFailure) throw this.syncFailure;
    return { platforms: ANALYTICS_PLATFORMS };
  }
  async list(postResultIds: readonly string[]) {
    this.lists.push([...postResultIds]);
    if (this.listFailure) throw this.listFailure;
    return {
      records: this.records.filter((record) => postResultIds.includes(record.postResultId)),
      warnings: [...this.listWarnings],
    };
  }
  async days(analyticsId: string) {
    this.dayReads.push(analyticsId);
    if (this.daysFailure) throw this.daysFailure;
    return this.daysByRecord[analyticsId] ?? [];
  }
}

/**
 * The inventory provider every automated test runs against. Nothing here contacts Post Bridge.
 *
 * Pages are answered in the order they are asked for rather than looked up by offset, which is what
 * lets one fixture be a provider that pages properly and another be a provider that keeps handing
 * back the offset it was already on. `reads` is the proof a test needs most often: every offset the
 * walk asked for, in order, so "every page was read before anything was written" is an assertion
 * about a list rather than a hope.
 */
export class MockProviderInventoryProvider implements ProviderInventoryProvider {
  readonly available = true;
  /** Every offset `page` was asked for, in order. */
  readonly reads: number[] = [];
  /** What to answer, one entry per call. A walk that asks for more than there are fails. */
  pages: ProviderInventoryPage[] = [];
  /** Raise instead of answering this one-based call — the page-failure fixture. */
  failureAt?: number;
  failure?: Error;
  async page(offset: number): Promise<ProviderInventoryPage> {
    const call = this.reads.length + 1;
    this.reads.push(offset);
    if (this.failureAt === call)
      throw this.failure ?? new PublishProviderError(`Post Bridge refused page ${call}.`, false);
    const page = this.pages[call - 1];
    if (!page) throw new PublishProviderError(`The mock provider has no page ${call}.`, false);
    return page;
  }
  /** One complete page: what the provider holds, and no next page. */
  hold(posts: ProviderInventoryPost[]): void {
    this.pages = [{ posts, next: { done: true } }];
  }
}

/**
 * The window provider every automated test runs against. Nothing here contacts Post Bridge.
 *
 * Pages are answered in the order they are asked for rather than looked up by token, which is what
 * lets one fixture be a provider that pages properly and another be a provider that keeps handing back
 * the token it was already on. `reads` is the proof a test needs most often: every request the walk
 * made, in order, so "every page was read before anything was written" and "no window was asked for
 * without a verified meaning" are both assertions about a list rather than hopes.
 */
export class MockAnalyticsWindowProvider implements AnalyticsWindowProvider {
  readonly available = true;
  /** Every request `listWindow` was asked for, in order. */
  readonly reads: {
    platform: AnalyticsPlatform;
    timeframe: AnalyticsWindow;
    pageToken?: number;
  }[] = [];
  /** What to answer, one entry per call. A walk that asks for more than there are fails. */
  pages: ProviderAnalyticsWindowPage[] = [];
  /** Raise instead of answering this one-based call — the page-failure fixture. */
  failureAt?: number;
  failure?: Error;
  async listWindow(request: {
    platform: AnalyticsPlatform;
    timeframe: AnalyticsWindow;
    pageToken?: number;
  }): Promise<ProviderAnalyticsWindowPage> {
    const call = this.reads.length + 1;
    this.reads.push({ ...request });
    if (this.failureAt === call)
      throw this.failure ?? new PublishProviderError(`Post Bridge refused page ${call}.`, false);
    const page = this.pages[call - 1];
    if (!page) throw new PublishProviderError(`The mock provider has no page ${call}.`, false);
    return page;
  }
  /** One complete page: the rows the provider names for this window, and no next page. */
  hold(rows: AnalyticsWindowRow[], warnings: string[] = []): void {
    this.pages = [{ rows, next: { done: true }, warnings }];
  }
}

/** Buffer read provider for automated tests. Nothing here contacts Buffer. */
export class MockBufferReadProvider implements BufferReadProvider {
  readonly available = true;
  async account() {
    return {
      id: 'e2e-buffer-account',
      organizations: [{ id: 'e2e-buffer-org', name: 'E2E Studio' }],
    };
  }
  async channels(): Promise<BufferChannel[]> {
    return [
      {
        id: 'e2e-buffer-tiktok',
        name: '@e2e-tiktok',
        service: 'tiktok',
        isDisconnected: false,
        isLocked: false,
        isQueuePaused: false,
      },
      {
        id: 'e2e-buffer-youtube',
        name: '@e2e-youtube',
        service: 'youtube',
        isDisconnected: false,
        isLocked: false,
        isQueuePaused: false,
      },
    ];
  }
  async listPosts() {
    return { posts: [], hasNextPage: false, endCursor: null };
  }
}
