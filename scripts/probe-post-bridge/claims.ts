/**
 * The questions the probe exists to answer, written down before it runs.
 *
 * Every claim starts at **still unverified**, and a step can only move one by recording what it
 * saw. That ordering is the point: a run that dies halfway, or never happens at all, produces a
 * matrix that says so for everything it did not reach, and there is no code path that turns silence
 * into permission. Each claim also carries the two sentences that say what a positive and a
 * negative result *mean* for the dependent cards, so the disposition column is decided here in
 * review rather than written by whoever reads the transcript afterwards.
 */

export type ClaimState =
  'verified' | 'verified-with-policy-constraint' | 'negative' | 'still-unverified';

export const CLAIM_STATE_LABEL: Record<ClaimState, string> = {
  verified: 'verified',
  'verified-with-policy-constraint': 'verified with policy constraint',
  negative: 'negative',
  'still-unverified': 'still unverified',
};

export interface ProbeClaimDefinition {
  id: string;
  /** 1–7, in the order the card asks them. */
  question: number;
  claim: string;
  dependents: readonly string[];
  whenVerified: string;
  whenNegative: string;
  /** Reviewed fail-closed disposition where a card can proceed without treating the claim as fact. */
  whenUnverified?: string;
}

export interface ProbeClaimResult extends ProbeClaimDefinition {
  state: ClaimState;
  evidence: readonly string[];
}

export const PROBE_QUESTIONS: readonly { question: number; title: string }[] = [
  { question: 1, title: '`account_configurations` and same-platform policy' },
  { question: 2, title: 'Upload flow and media lifecycle' },
  { question: 3, title: 'Media roles' },
  { question: 4, title: '`GET /v1/posts`' },
  { question: 5, title: 'Analytics' },
  { question: 6, title: 'Platform fields' },
  { question: 7, title: 'Rate-limit evidence' },
];

export const PROBE_CLAIMS: readonly ProbeClaimDefinition[] = [
  {
    id: 'account-configurations-accepted',
    question: 1,
    claim:
      '`POST /v1/posts` accepts `account_configurations` and stores a different caption for each of two explicitly approved accounts on one platform.',
    dependents: ['C77'],
    whenVerified:
      'C77 may build explicit same-platform targets and per-account captions for the verified platform.',
    whenNegative:
      'C77 is will-not-build: `plan.ts` keeps its one-account-per-channel refusal and `accountContentOverride` stays false. C82 records it.',
  },
  {
    id: 'account-configuration-encoding',
    question: 1,
    claim:
      'Which encoding `account_configurations` takes — a list of objects each carrying `account_id`, or a map keyed by account id.',
    dependents: ['C77'],
    whenVerified: "C77's request builder emits the accepted encoding and its unit tests assert it.",
    whenNegative:
      'Neither encoding is accepted, so C77 has no wire shape to build and is will-not-build.',
  },
  {
    id: 'account-configuration-fields-persist',
    question: 1,
    claim:
      'The per-account `caption` and `media` read back unchanged through `GET /v1/posts/{id}`, after create and again after `PATCH`.',
    dependents: ['C77'],
    whenVerified:
      'C77 may reconcile per-account content against the provider record and hash it into the confirmation.',
    whenNegative:
      'C77 cannot prove what the provider holds per account, so the capability stays false even where create is accepted.',
  },
  {
    id: 'same-platform-duplicate-policy',
    question: 1,
    claim:
      'What the provider does about two accounts on one platform when the captions are materially different, and in what terms it states any restriction.',
    dependents: ['C77'],
    whenVerified:
      "C77 carries the verified rule into preflight as a refusal in the provider's own terms.",
    whenNegative:
      'Same-platform posting is refused outright, so C77 is will-not-build and the existing single-account refusal is already correct.',
  },
  {
    id: 'media-upload-contract',
    question: 2,
    claim:
      'The `create-upload-url` request and response field names, and the signed `PUT`’s required headers and content-length behaviour.',
    dependents: ['C75'],
    whenVerified: 'C75 builds the three-step upload against the verified names and headers.',
    whenNegative:
      'There is no working upload contract, so media stays `media_urls` only and Drive-sourced publishing is will-not-build.',
  },
  {
    id: 'media-mime-enum',
    question: 2,
    claim:
      'That the five documented `mime_type` values are the whole accepted set, and what the provider answers for a value outside it.',
    dependents: ['C74', 'C75'],
    whenVerified: "C74's type validation and C75's preflight use the verified set.",
    whenNegative:
      'The accepted set is not the documented one; C74 and C75 must validate against what the API answered, not the enum.',
  },
  {
    id: 'media-attach-and-describe',
    question: 2,
    claim:
      'What `GET /v1/media/{id}` returns for an uploaded asset, and what `describe` says about media a post carries by id rather than by URL.',
    dependents: ['C75'],
    whenVerified: 'C75 reconciles provider media ids where `describe` returns them.',
    whenNegative:
      'C75 shows **media comparison unavailable** and refuses the schedule-only action that needs proof the content is unchanged.',
  },
  {
    id: 'media-ids-override-media-urls',
    question: 2,
    claim: 'That `media` wins and `media_urls` is ignored when one create request carries both.',
    dependents: ['C75'],
    whenVerified:
      "C75's discriminated `PublishRequest` matches the wire as well as the document, and a URL-only post serializes as it does today.",
    whenNegative:
      "The two merge or conflict, so C75's mixed-source refusal is load-bearing rather than a simplification and needs its own fixture.",
  },
  {
    id: 'media-delete-endpoint',
    question: 2,
    claim: 'Whether `DELETE /v1/media/{id}` removes an uploaded asset that is attached to nothing.',
    dependents: ['C75'],
    whenVerified: 'A probe run leaves no asset behind and C75 may state deletion as available.',
    whenNegative:
      'An uploaded asset cannot be deleted, so every run inventories what it left and C75 reports leftovers as ephemeral assets instead of claiming cleanup.',
  },
  {
    id: 'media-expiry-lifecycle',
    question: 2,
    claim:
      'The 24-hour unattached expiry and the deletion-on-publish the vendor documents. **A single session cannot answer this**: it needs a dated follow-up read of the inventoried asset ids.',
    dependents: ['C75'],
    whenVerified: 'C75 may state the expiry as fact rather than as vendor prose.',
    whenNegative:
      'The documented expiry did not happen; C75 states the observed behaviour and treats a leftover asset as durable until something deletes it.',
    whenUnverified:
      'C75 may build without depending on this timing only by labelling it documented but unverified and recording every landed asset; the timing itself remains unavailable as a correctness guarantee.',
  },
  {
    id: 'media-limits',
    question: 2,
    claim:
      'The current per-file size, item-count, and video-duration limits that apply to the connected plan through the API.',
    dependents: ['C74', 'C75'],
    whenVerified:
      'C74 validates against the verified bounds and C75 enforces them before a byte is read.',
    whenNegative:
      "The published bounds are not the API's; C74 and C75 use what the API answered and record the difference.",
  },
  {
    id: 'youtube-thumbnail-role',
    question: 3,
    claim:
      'Whether a scheduled post accepts YouTube `thumbnail` as a provider media id and reads it back — against current support guidance saying custom external thumbnails are unavailable.',
    dependents: ['C76', 'C82'],
    whenVerified:
      "C76 may build the YouTube thumbnail role; actual platform delivery stays C76's manual QA.",
    whenNegative:
      'C76 leaves `thumbnail: false`, keeps the reel warning, and C82 records the will-not-build with the support page as its reason.',
  },
  {
    id: 'instagram-cover-image-role',
    question: 3,
    claim:
      'Whether a scheduled post accepts Instagram `cover_image` as a provider media id and reads it back.',
    dependents: ['C76'],
    whenVerified: "C76 may build the cover-image role; delivery stays C76's manual QA.",
    whenNegative: 'C76 leaves `coverImage: false` and keeps its warning.',
  },
  {
    id: 'linkedin-document-title-role',
    question: 3,
    claim:
      'That an `application/pdf` asset plus the already-sent `document_title` reads back as a LinkedIn document post.',
    dependents: ['C76'],
    whenVerified: 'C76 verifies the existing path end to end rather than adding a role row.',
    whenNegative: 'A PDF is not a document post on this contract and C76 drops the LinkedIn item.',
  },
  {
    id: 'posts-list-pagination',
    question: 4,
    claim:
      'The complete pagination contract of `GET /v1/posts` — what `meta.next` holds, and how the last page is recognised.',
    dependents: ['C78'],
    whenVerified: 'C78 reads every page before one snapshot write, using the verified token.',
    whenNegative:
      'A complete inventory cannot be read, so C78 is will-not-build: a partial inventory would raise orphan alerts about posts it simply never saw.',
  },
  {
    id: 'posts-list-filter-encoding',
    question: 4,
    claim:
      'Which repeatable encoding of `status` and `platform` the endpoint actually filters on, `name[]` or a bare repeated `name`.',
    dependents: ['C78'],
    whenVerified:
      "C78's request builder emits the encoding that filtered, asserted by a unit test.",
    whenNegative:
      'Neither encoding filters; C78 reads unfiltered pages and does the selection locally, or narrows its scope.',
  },
  {
    id: 'posts-list-identity-fields',
    question: 4,
    claim: 'The fields that identify a listed post stably across pages and across reads.',
    dependents: ['C78'],
    whenVerified: 'C78 keys `signal_provider_posts` on the verified identity field.',
    whenNegative:
      'There is no stable key, so C78 cannot hold a snapshot generation and is will-not-build.',
  },
  {
    id: 'posts-list-disappearance',
    question: 4,
    claim:
      'That a deleted post is absent from a complete inventory afterwards, rather than present in some other state.',
    dependents: ['C78'],
    whenVerified:
      "C78's generation replacement may treat absence as deletion, and this probe's own teardown proof is sound.",
    whenNegative:
      'Absence and deletion are different things here; C78 must read state rather than infer it from a missing row, and the teardown proof needs a second check.',
  },
  {
    id: 'posts-list-provider-ui-shape',
    question: 4,
    claim:
      'The shape of a post created in the provider’s own UI rather than by this app. **A named human precondition**: the owner creates one and passes its id; the probe never pretends to have made it.',
    dependents: ['C78'],
    whenVerified: "C78's normaliser is written against a real provider-UI row.",
    whenNegative:
      'A provider-UI row does not normalise into the snapshot shape; C78 widens the shape before it stores anything.',
  },
  {
    id: 'analytics-pagination',
    question: 5,
    claim: 'The pagination contract of `GET /v1/analytics`, and whether it matches the posts list.',
    dependents: ['C80'],
    whenVerified: 'C80 reads every page before one atomic snapshot replacement.',
    whenNegative: 'A complete window read is not possible, so C80 is not built.',
  },
  {
    id: 'analytics-timeframe-meaning',
    question: 5,
    claim:
      'Whether `timeframe` selects which posts are included or which measurement days are counted, and which window values the endpoint accepts.',
    dependents: ['C80'],
    whenVerified: "C80 labels its panel with the verified meaning, in the provider's own language.",
    whenNegative:
      'The parameter has no observable effect or no discoverable meaning; C80 is not built, which is what its own scope says to do.',
  },
  {
    id: 'analytics-response-grain',
    question: 5,
    claim:
      'That a filtered response is one row per measured delivery rather than an account aggregate, and that every row still carries `post_result_id`.',
    dependents: ['C80'],
    whenVerified:
      'C80 may add the provider’s four counts over a named delivery set and call the result a local addition.',
    whenNegative:
      'The grain is not per delivery; C80 cannot describe its totals honestly as sums over named rows and is not built.',
  },
  {
    id: 'analytics-account-mapping',
    question: 5,
    claim:
      'How a row maps to a social account — through `post_result_id` and the local publication targets, or through some field of its own.',
    dependents: ['C80'],
    whenVerified: 'C80 groups by the verified mapping and counts anything else as **unmapped**.',
    whenNegative:
      'No mapping is available, so every row is unmapped and there is nothing for C80 to attribute.',
  },
  {
    id: 'analytics-match-confidence',
    question: 5,
    claim:
      'The actual values `match_confidence` takes, and whether a record can arrive without one.',
    dependents: ['C79'],
    whenVerified:
      'C79 stores the verified values as provenance and shows an unrecognised one as **Provider value: …**.',
    whenNegative:
      'The field is absent or unusable; C79 has nothing to surface and is will-not-build.',
  },
  {
    id: 'youtube-contains-synthetic-media',
    question: 6,
    claim:
      'That YouTube `contains_synthetic_media` is accepted on a scheduled post and reads back with the value that was sent.',
    dependents: ['C81'],
    whenVerified:
      "C81 sends the flag from the existing variant value and YouTube's `syntheticMediaDisclosure` moves from `IN_CAPTION` to `PROVIDER_FIELD`.",
    whenNegative:
      'The appended caption sentence and its character cost stay exactly as they are, and C82 records the field as real and unused.',
  },
  {
    id: 'tiktok-disclosure-toggles',
    question: 6,
    claim:
      'That TikTok `disclose_branded_content` and `disclose_your_brand` are accepted and read back, with `false` distinguishable from unset.',
    dependents: ['C81'],
    whenVerified: 'C81 offers both toggles for TikTok alone and preserves unset against false.',
    whenNegative: 'Neither toggle is built; the compliance settings stay outside this app.',
  },
  {
    id: 'facebook-story-placement',
    question: 6,
    claim:
      'That the already-shipped generic `placement: "story"` path is still accepted for Facebook.',
    dependents: ['C81'],
    whenVerified:
      'C81 adds the Facebook fixture as regression coverage and changes no production code.',
    whenNegative:
      'The generic path is refused for Facebook; C81 fixes it as a defect within scope and the capability table is corrected.',
  },
  {
    id: 'rate-limit-headers',
    question: 7,
    claim:
      'The headers a `429` carries, **if one arrives without being provoked**. The probe has a fixed request budget and never creates load to discover a limit.',
    dependents: ['C75', 'C80'],
    whenVerified:
      '`PUBLISH_RATE_LIMIT_FALLBACK_SECONDS` and the §9 rule are checked against the observed headers.',
    whenNegative:
      'A `429` arrived carrying nothing usable, so the fallback stays the authority and §9 is unchanged.',
    whenUnverified:
      'C75 keeps the existing conservative fallback and never retries an ambiguous signed transfer; C80 stays blocked on its own rate-limit contract.',
  },
];

/** The starting matrix: every claim unanswered, and honest about it. */
export function initialClaims(): ProbeClaimResult[] {
  return PROBE_CLAIMS.map((definition) => ({
    ...definition,
    state: 'still-unverified' as ClaimState,
    evidence: ['Not attempted in this run.'],
  }));
}

/**
 * The disposition column, computed rather than typed.
 *
 * `still-unverified` has one sentence and no way to say anything else, which is the mechanical
 * version of "never silently convert still unverified into permission to build".
 */
export function claimDisposition(claim: ProbeClaimResult): string {
  const dependents = claim.dependents.join(', ');
  switch (claim.state) {
    case 'verified':
      return claim.whenVerified;
    case 'verified-with-policy-constraint':
      return `${claim.whenVerified} The constraint recorded beside it is a preflight refusal, not a warning.`;
    case 'negative':
      return claim.whenNegative;
    case 'still-unverified':
      if (claim.whenUnverified) return claim.whenUnverified;
      return `${dependents} ${claim.dependents.length > 1 ? 'stay' : 'stays'} blocked. Today's fail-closed value is unchanged.`;
  }
}

/**
 * A writable matrix keyed by claim id.
 *
 * `record` refuses an id that is not in the registry, so a step cannot invent a claim that the
 * review never saw, and it refuses to move a claim twice — two steps disagreeing about one claim is
 * a bug in the probe, not a result.
 */
export class ClaimLedger {
  private readonly claims: Map<string, ProbeClaimResult>;

  constructor(claims: readonly ProbeClaimResult[] = initialClaims()) {
    this.claims = new Map(claims.map((claim) => [claim.id, { ...claim }]));
  }

  record(id: string, state: ClaimState, evidence: readonly string[]): void {
    const claim = this.claims.get(id);
    if (!claim) throw new Error(`No such probe claim: ${id}`);
    if (claim.state !== 'still-unverified')
      throw new Error(`Probe claim ${id} has already been recorded as ${claim.state}.`);
    if (!evidence.length) throw new Error(`Probe claim ${id} needs at least one line of evidence.`);
    this.claims.set(id, { ...claim, state, evidence: [...evidence] });
  }

  /** Adds a reason to a claim the run never reached, leaving it unverified. */
  explainUnverified(id: string, reason: string): void {
    const claim = this.claims.get(id);
    if (!claim) throw new Error(`No such probe claim: ${id}`);
    if (claim.state !== 'still-unverified') return;
    this.claims.set(id, { ...claim, evidence: [reason] });
  }

  /** In registry order, so the report reads in the order the card asks the questions. */
  results(): ProbeClaimResult[] {
    return PROBE_CLAIMS.map((definition) => this.claims.get(definition.id)!);
  }
}
