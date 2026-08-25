# Publishing Integration — Decision Record

Status: **implemented by #150 after reconciliation with the working artifact.** This document settles the
questions an implementation would otherwise settle by accident, and it is the thing an
implementation card is written against — not a survey, and not a plan to build both providers and
choose later.

Card: C19b (#76). Depends on C19 (#75, shipped) and C29 (#111, shipped). Resolves the XL half of
FR7. Reconciled by C46 (#148) before the Version 5 implementation cards.

Sources read for this decision, on 2026-08-12:
[post bridge API reference](https://api.post-bridge.com/reference) (OpenAPI 3.0.0, `post bridge
API` 1.0) and the [Buffer GraphQL API guides](https://developers.buffer.com/guides/introduction.html)
— specifically [authentication](https://developers.buffer.com/guides/authentication.html),
[posts and scheduling](https://developers.buffer.com/guides/posts-and-scheduling.html),
[API standards](https://developers.buffer.com/guides/api-standards.html), and
[rate limits](https://developers.buffer.com/guides/api-limits.html). The decisions below were
re-checked on 2026-08-13 against the working integration extracted in
[`social-media-publisher-artifact.md`](social-media-publisher-artifact.md). Where the artifact and
the vendor-documentation record disagreed, this record now states which answer governs this app.

Two later documents sit beside this one and neither replaces it. The provider surface was
re-established from the OpenAPI document on 2026-08-19 and recorded as a dated research note in
[`post-bridge-api-surface.md`](post-bridge-api-surface.md); the sequencing that spends it, together
with the media-boundary decision in its §0, is
[`post-bridge-integrations-plan.md`](post-bridge-integrations-plan.md). The note decides nothing and
the plan is sequencing rather than a second runtime contract — **this record remains the runtime
contract**, and where the note contradicts a decision here, the plan names the card that would
change it. Nothing in either document is built.

---

## 1. The decision

**Post Bridge ships first in this app, behind one interface, `PublishProvider`.** One provider, one
implementation, one mock. There is no adapter layer, no provider registry, no dual-write, and no
runtime switch between vendors. If Post Bridge is ever replaced, the replacement implements the
same interface and the old implementation is deleted in the same branch.

The working artifact reaches Post Bridge through a claude.ai MCP connector. That transport is a
constraint of an artifact running inside claude.ai, not a reusable application boundary. This
local Node server can and will use `POST_BRIDGE_API_KEY` against `api.post-bridge.com/v1` directly,
so the original transport decision stands. Buffer is now the explicit route for this studio's
TikTok and YouTube channels because Post Bridge's account cap cannot hold those two beside the five
accounts used by the active campaign. That is an account-cap constraint, not a platform-capability
gap: Post Bridge supports both services. Section 2 records the non-overlapping route before any
second adapter is built.

Four things follow, and the rest of this document is those four things in detail:

1. A publisher **reads** the schedule through `SignalProvider` and **never writes** `signal_posts`.
   Delivery state lives in its own table.
2. `SignalStatus.PUBLISHED` keeps meaning exactly what it means today — the user's own claim — and
   the publisher never sets it. Delivery gets its own vocabulary.
3. The `YYYY-MM-DD` + `HH:MM` pair becomes an instant **once, at the outbound edge, in a
   configured zone**, and the instant is never stored on the post or read back into any view.
4. Nothing leaves the machine without a preview the user confirmed, and an ambiguous submit is
   never retried automatically.

---

## 2. Why Post Bridge, and what would change the answer

Both providers can schedule a post. They disagree about what a post *is*, and that disagreement is
the whole decision.

| | Post Bridge | Buffer |
| --- | --- | --- |
| Shape | REST, `https://api.post-bridge.com/v1` | GraphQL, one endpoint at `https://api.buffer.com` |
| Auth this app would hold | one bearer token (`bearerFormat: JWT`) | a personal access token, **or** OAuth 2.0 authorization code + PKCE |
| One post, many channels | `social_accounts: number[]` on one `POST /v1/posts` | `channelId`, singular, one `createPost` per channel |
| Scheduling field | `scheduled_at`, ISO 8601 date-time, nullable | `dueAt`, ISO 8601 UTC, under `mode: customScheduled` |
| Provider-side queue | `use_queue`, with an IANA `timezone` | `mode: addToQueue` |
| Per-channel outcome | `GET /v1/post-results` — one row per account, with `success`, `error`, `platform_data.url` | post status is `Scheduled` / `Sent` / `Error`, per post, and a post is one channel |
| Documented rate limits | none, except a 429 on `POST /v1/analytics/sync` | 100 / 15 min, 250–500 / 24 h, 3,000–15,000 / 30 days, with `RateLimit` headers and `Retry-After` |
| Idempotency keys | none | none |
| Webhooks | none | none |
| Media | `POST /v1/media/create-upload-url` → signed `upload_url`, or `media_urls` the API downloads | must already be hosted online; asset upload is on the roadmap |

**The deciding reason is the third row.** `SignalPost.channels` is a `SignalChannel[]`: one piece
of content, several places it goes. Post Bridge's `POST /v1/posts` takes `social_accounts` as an
array and answers with one post id, and `GET /v1/post-results` then returns one row per account
carrying `success` and `error` separately. That is the same shape the content already has, and it
is also — exactly — the shape `IntegrationOutcome.PARTIAL` was added for: *some of it landed and
some of it did not, and here is which.*

Buffer's `createPost` takes one `channelId`. A four-channel Signal post becomes four mutations,
four post ids to store, four independent failures to reconcile, and four requests against a budget
of 100 per fifteen minutes. Every one of those fours is a place for the app to end up believing
something the world does not agree with. The app would spend its first release building the
fan-out and partial-failure machinery that Post Bridge hands it in one response.

Three smaller reasons point the same way:

- **No second OAuth callback.** With Post Bridge, the user connects their own social accounts
  inside Post Bridge's dashboard, and this app holds one revocable API key and no social
  credentials at all. Buffer's app path would add an authorization-code + PKCE flow, a
  single-use refresh token, and a second callback route — and `server/drive/oauth.ts` records at
  length what that callback costs to get right. Buffer's personal access token would avoid that,
  but then the app holds a key that reaches every organization on the account, which is a wider
  grant than the one Post Bridge issues.
- **Media has somewhere to go.** Signal posts carry no attachments today (§9), but when they do,
  `create-upload-url` is a path that exists. Buffer's guides state an image must already be hosted
  online, and this app deliberately stores no user files.
- **Cost decides nothing, but check it before the first card.** Post Bridge's API is understood to
  be a paid add-on on top of the plan rather than part of it. That is second-hand — it is not in
  the OpenAPI document — so confirm it against the account rather than against this sentence. It is
  named here only so it is not discovered halfway through an implementation.

**What Buffer is better at, honestly.** Buffer publishes real rate-limit numbers, real headers, and
a `Retry-After`; Post Bridge documents a 429 on exactly one endpoint and leaves the rest to be
discovered in production. Buffer separates recoverable errors (typed, in the payload) from
unrecoverable ones (in the GraphQL `errors` array), which is a better error contract than
`400 | 500`. If publishing ever needs to be dependable at volume rather than deliberate at low
volume, that gap matters.

The provider account read on **22 August 2026** changed the answer for this app. Post Bridge listed
seven accounts before TikTok and YouTube were connected — Facebook ×3, Instagram, LinkedIn,
Threads, and Bluesky — and only four afterwards, with five active-campaign accounts displaced. It
cannot hold TikTok and YouTube beside the five accounts this studio publishes on. Buffer is
therefore the only available route for those two channels while the cap holds. The cost of avoiding
a second provider would be evicting five active routes to gain two, which is not an available trade.

The count is **two, not three**: TikTok and YouTube. Buffer's own `Service` enum, read 23 August
2026, includes `tiktok`, `youtube`, `bluesky`, and `threads`; Post Bridge also supports all four.
The old claim that a Buffer Bridge covered TikTok, Bluesky, and Threads because Post Bridge could
not reach them confused a past account arrangement with provider capability and omitted YouTube.
[`social-media-publisher-artifact.md`](social-media-publisher-artifact.md) §10 is corrected in the
same card.

### 2.1 The Buffer route and dated GraphQL contract

**Contract read 23 August 2026 from Buffer's official [GraphQL guides](https://developers.buffer.com/guides/graphql-intro.html),
[generated reference](https://developers.buffer.com/reference.html),
[service enum](https://developers.buffer.com/types/Service.html), and
[rate-limit guide](https://developers.buffer.com/guides/api-limits.html).** All operations use
`POST https://api.buffer.com` with a bearer credential. These are documentation claims until the
owner-run probe below records a live result; absence or ambiguity stays fail-closed.

| Concern | Published Buffer shape | Decision here |
| --- | --- | --- |
| Account and organizations | `account { id organizations { id name } }` | Resolve the approved organization explicitly; never use the first one |
| Channels | `channels(input: { organizationId }) { id name service }` | A target stores an explicit provider and provider channel id; the service must match |
| One post | Every `Post` belongs to one `channelId` | One Signal post targeting TikTok and YouTube becomes two remote posts and two remote ids |
| Create | `createPost(input: CreatePostInput!)`; custom time is `mode: customScheduled`, `dueAt` UTC, `schedulingType: automatic` | One mutation per explicitly selected Buffer channel |
| Read | `post(input: { id })`; `posts(first, after, input)` returns `edges.node` plus `pageInfo.hasNextPage` and opaque `endCursor` | Read every page and refuse repeated, absent, or over-bound cursors |
| Status | `draft`, `error`, `needs_approval`, `scheduled`, `sending`, `sent` | Preserve the provider value; no guessed equivalence to Post Bridge states |
| Edit | `editPost(input: EditPostInput!)`; omitted scheduling fields preserve the schedule | A Buffer post stays Buffer-owned through its lifecycle |
| Delete | `deletePost(input: { id })`; success returns the deleted id | A delete response is not cleanup proof; require absence from a complete paginated read |
| Recoverable mutation errors | Mutation unions include `PostActionSuccess` and types implementing `MutationError { message }` | Always request `__typename` and the catch-all mutation message; unknown types refuse |
| System errors | GraphQL `errors[]`, with `extensions.code` such as `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `UNEXPECTED`, and `RATE_LIMIT_EXCEEDED` | A system error is not a partial success and is never retried as another provider |
| Limits | Every response carries three structured `RateLimit` / `RateLimit-Policy` windows; 429 carries `Retry-After` and `RATE_LIMIT_EXCEEDED` | Record headers already received; never provoke a limit. Respect the named window and retry delay in the later adapter |

**The routing rule is explicit and durable.** Signal remains the only authoritative schedule. Each
delivery target names exactly one provider and provider account/channel id. TikTok and YouTube use
Buffer while the account-cap decision above holds; existing Facebook, Instagram, LinkedIn,
Threads, and Bluesky targets use Post Bridge. There is no automatic failover, retry-through to the
other provider, dual submission, first-matching account, or credential-presence routing. A Post
Bridge publication remains Post Bridge for create, read, update, reconcile, and delete; a Buffer
publication does the same on Buffer. Changing a route requires a new confirmed delivery, never an
in-place provider swap.

**Media does not cross the provider boundary.** Buffer exposes no upload endpoint. `AssetInput`
accepts image, video, document, or link objects whose media already has a stable, direct, public
HTTPS URL. A Google Drive viewer/share URL is a page rather than media. Drive bytes cannot borrow
Post Bridge's signed upload path, and this app will not proxy or host them. A Buffer target whose
media is not already public therefore refuses before any mutation.

**Recorded media decision (C86, option 2).** Buffer targets take **no media from this app** under
notification scheduling — the default until Buffer's channels API returns scheduling type per
channel. TikTok and YouTube carry text into Buffer; Buffer reminds you in the platform app to attach
media and finish the post there. Automatic TikTok may carry a **direct public HTTPS address** already
stored on the post where C83 verified create; automatic YouTube stays **fail-closed** until a live
create is recorded. **Rejected:** a second public address beside Drive (option 1 — two addresses that
can drift); Drive-side public sharing (option 3 — changes file audience under every existing rule).
Option 4 (text-only `createIdea` / channel draft without scheduling) was evaluated and rejected for
this wave: C86 implements notification scheduling with empty `assets`, which is the same manual-finish
cost with a scheduled reminder rather than an Ideas-library handoff. **Reopen when** Buffer's roadmap
items *Image assets for API*, *Copy media to Buffer storage after post creation*, or *TikTok binary
file upload (`FILE_UPLOAD`) support* ship — last updated 22 August 2026. A post mixing Post Bridge and
Buffer targets in one submission **refuses** rather than splitting implicitly.

**Credential contract.** `BUFFER_API_KEY` is the canonical server-only setting. For one release,
`BUFFER_KEY` is accepted only when the canonical setting is absent; when both exist,
`BUFFER_API_KEY` wins. Neither name nor value reaches the browser or an integration log. Presence
configures a possible provider client; it is never permission to publish and never selects a route.

**Owner-run probe.** `npm run probe:buffer` plans by default and contacts nothing. Live mode also
requires `--live`, `--yes`, `--channels-approved`, the exact account and organization and every
connected routed channel as `--channel tiktok:<id>` / `--channel youtube:<id>`. An optional
`--target <service>:<id>` narrows the write subset but must exactly match one of those approved
connected channels; without it every approved channel is a target. The run also needs an unused
label, a zoned instant at least 48 hours away, and the label typed back. An optional owner-approved
public fixture is explicit too:
`--media <service>:<image|video>:<https-url>` accepts one credential-free, query-free HTTPS file URL
per approved service and binds it only to that service's create. The probe verifies the account and
channel set before a write, creates one disposable scheduled post per named target, reads each by
id, resends the same approved fixture on edit, reads it again, and deletes only ids it created in
`finally`. The explicit edit asset is required by observed TikTok behavior even though the published
`EditPostInput` contract says omission preserves the existing asset list. Cleanup is independently
proved by a complete
cursor-paginated read. A hard 50-request budget includes cleanup, with 12 calls reserved for it;
there is no retry and no deliberate 429. The transcript and credential are never committed.

Every dated live matrix uses only **verified**, **negative**, and **still unverified**. A natural
typed error or rate-limit response may add evidence, but the probe never manufactures one. The
account owner must approve the exact channel ids and disposable fixtures before a run; a different
account/channel set, ambiguous write, or unproved cleanup stops the run and leaves later cards
fail-closed.

The C87 runtime write path now exists behind `BufferWriteProvider`, but production remains closed by
`BUFFER_WRITE_EVIDENCE`: TikTok's approved image-backed create/edit/delete round trip is verified,
while the exact connected YouTube channel is still unverified. Automated tests inject
`MockBufferWriteProvider`; CI never contacts Buffer.

**C87 write and lifecycle rules.** A confirmed plan emits one `createPost` per selected channel,
pins `mode: customScheduled` and `needsApproval: false`, and never exposes queue, immediate-share,
approval, recurrence, queue movement, or template controls. Each answered mutation is committed to
its own target row immediately, including its opaque Buffer post id. A definite quota or rate-limit
refusal is distinct from ambiguity; a transport failure without an answer stops the sequence and is
never retried. Reads, edits, reschedules, and cancels address that exact id, require a fresh hash over
Signal plus the remote record, and are offered only from `Post.allowedActions`. `Post.error.rawError`
is discarded by the wire parser; only its safe message and support URL can move farther.
Reconciliation updates publication and target rows only and never writes `signal_posts`, campaigns,
media, or planning status.

### 2.2 Buffer result matrix — 23 August 2026

The account owner authorized the exact account, organization, connected TikTok and YouTube channel
set, disposable targets, scheduled instant, labels, and later the exact public TikTok image fixture
on 23 August 2026. The first guarded run spent four of its 50-request budget and stopped on
TikTok's text-only create with no post created. A TikTok-only preflight then spent two reads and
stopped before writes when the first guard version could not distinguish the connected set from the
write subset. After that distinction was made explicit, the first image-backed run spent eight
requests: one TikTok post was created and read back, edit without an asset refused, and cleanup
deleted it and proved complete absence. A fresh corrected run spent nine requests, created one
TikTok post with the same approved image, resubmitted that image on edit, independently read the
edited caption back, deleted the post, and proved complete absence. Created: 1; deleted: 1;
leftovers: 0 in each write run. “Verified” below names the evidence source; it does not silently turn
a published schema into observed live behavior.

| Claim | Result | Evidence and disposition |
| --- | --- | --- |
| The credential can read the exact approved account, organization, and routed channels | **verified** | The owner-approved live probe on 23 August 2026 matched one connected, unlocked TikTok channel and one connected, unlocked YouTube channel before any write. Exact ids remain owner-held and uncommitted. |
| Buffer's service vocabulary includes TikTok, YouTube, Bluesky, and Threads | **verified** | Official `Service` enum read 23 August 2026. The current two-channel split is therefore an account-cap decision, not a support gap. |
| Account → organizations → channels → posts is the identity hierarchy | **verified** | Official data-model and generated GraphQL reference read 23 August 2026. Later code must still validate every live response. |
| One `createPost` mutation creates one post for one `channelId` | **verified** | Official `CreatePostInput` and data-model contract. Live per-channel id/readback remains a separate row below. |
| The approved TikTok channel accepts a text-only disposable custom-scheduled post | **negative** | The owner-approved live probe reached `createPost`, which returned `InvalidInputError`: `Invalid post: TikTok posts require at least one image or video.` Buffer created no post. |
| The approved TikTok channel accepts the owner-approved direct public PNG and returns a per-channel post id | **verified** | The image-backed live create succeeded for the exact TikTok target and the returned identity matched the target and caption. Acceptance proves create-time validation only, not publish-time media fetch or delivery. |
| The approved YouTube channel accepts a disposable custom-scheduled post and returns a per-channel id | **still unverified** | The fail-closed run stopped at TikTok's first create, before reaching YouTube. It did not infer YouTube behavior or retry past the refusal. |
| By-id read preserves channel, text, due time, and status after TikTok image create | **verified** | The image-backed live run reached edit only after an independent by-id read matched the created post's target and caption. |
| `editPost` applies text while an omitted asset list preserves TikTok media | **negative** | The image-backed post's text-only edit returned `InvalidInputError`: `Invalid post: TikTok posts require at least one image or video.` For this channel the documented omission rule did not make the edit valid; the guarded probe must resend the same approved asset explicitly. |
| `editPost` applies text when the approved TikTok asset is resubmitted | **verified** | A fresh owner-approved run resubmitted the exact public PNG from create, and an independent by-id read matched the edited caption and TikTok target before cleanup. |
| `deletePost` returns the deleted id and a complete paginated read proves absence | **verified** | Cleanup returned the one created TikTok id, and a complete cursor-paginated read found no created id. No remote leftover remains. |
| Typed mutation errors and system `errors[]` carry the documented shapes | **verified** | Official error guide and union reference read 23 August 2026; injected fixtures cover both parsers. Live TikTok create and edit refusals also returned the documented `InvalidInputError` typed mutation shape. System-error behavior remains contract-and-fixture evidence rather than a provoked live refusal. |
| A natural 429 carries usable `RateLimit` / `RateLimit-Policy` and `Retry-After` values | **still unverified** | The headers are documented. The probe never provokes load; it records them only if they arrive naturally. |
| Buffer has no media upload path and accepts hosted asset URLs | **verified** | Official asset/create contract and roadmap read 23 August 2026. A Drive viewer URL remains invalid by architecture even before a provider call. |
| Direct public HTTPS TikTok/YouTube media is fetched and delivered as documented | **still unverified** | Buffer accepted the owner-approved TikTok PNG URL on create, but the probe deleted the scheduled post before publish. Create-time acceptance is not evidence of Buffer's later fetch or TikTok delivery; YouTube media was not attempted. |

**Negative results:** this account's approved TikTok channel refused a text-only create because a
TikTok post requires an image or video. It accepted the exact public PNG on create and readback, but
then refused an edit that omitted `assets` for the same reason. A fresh run verified that edit
succeeds when the exact approved asset is explicitly resubmitted. Cleanup is positively proved;
YouTube and publish-time delivery remain **still unverified**, never negative and never permission
to build.

**Revisit this app's decision when any of these becomes true**, and not before:

- Post Bridge starts refusing requests in a way the app cannot predict, and no published limit
  exists to plan against.
- Signal grows a channel Post Bridge does not reach and Buffer does.
- The app needs to publish without a human confirming — at which point idempotency stops being a
  workaround (§8) and becomes a requirement neither provider currently meets.

---

## 3. What can actually be published in the first release

The original four-channel ceiling was a consequence of `SignalPost` not modelling media, not a
provider limitation. C47 (#149) is therefore a prerequisite to the publisher: it adds ordered
public `https:` media references without uploading or storing files. With that prerequisite in
place, the first publisher can plan all **eight** Signal social channels:

| Signal channel | Post Bridge platform | First release |
| --- | --- | --- |
| `blog` | *(none)* | never published; see §10 |
| `bsky` | `bluesky` | publishes when its text and media pass preflight |
| `fb` | `facebook` | publishes only to the `G.Holmes Designs` page (section 3.1) |
| `ig` | `instagram` | publishes with required supported media |
| `li` | `linkedin` | publishes when its text and media pass preflight |
| `th` | `threads` | publishes when its text and media pass preflight |
| `tt` | `tiktok` | publishes with required supported media |
| `x` | `twitter` | publishes when its text and media pass preflight |
| `yt` | `youtube` | publishes with exactly one video |

The planner carries the artifact's complete platform capability table and preflight rules rather
than treating media as present-or-absent. That table is `shared/publish-capabilities.ts` and §3.2
below is its contract. An over-limit caption blocks `twitter` and `bluesky` and warns elsewhere.
**Post Bridge requires a caption on every submission, including media-only platform formats**, so
an empty effective caption is always a refusal even when the target platform visually emphasizes
only the media — a provider-wide rule, which is why it is a plan-level refusal in `plan.ts` rather
than a field on a platform.

Post Bridge also reaches `pinterest` and `google_business`. Signal has no channel for them and the
mapping is not extended to invent one — a channel exists because content is planned for it, not
because a provider supports it. The capability table still answers for all ten, because the contract
is about what the provider can do and a channel is about what is planned.

### 3.2 The supported contract

**One definition, in `shared/publish-capabilities.ts`, and no second copy.** The table used to live
in `server/publish/plan.ts` where the UI could not see it, so anything the composer needed to know
about a platform was a server round-trip or a re-implementation of the rules in React. It is now in
`shared/`, which is what lets a limit the server refuses on be a limit the form can show.

What the contract answers for each platform:

| Dimension | Shape | Notes |
| --- | --- | --- |
| Caption limit | `captionMax`, `captionOverLimitRefuses` | Over-limit refuses on X and Bluesky, warns elsewhere |
| Media bounds | `kinds[kind].media.min` / `.max` | `max: null` where the source records no ceiling |
| Media combinations | `.media.video`, `.media.pdf` | `WITH_OTHERS`, `ALONE_ONLY`, `REQUIRED_ALONE`, `FORBIDDEN`; `DOCUMENT_POST`, `DROPPED`, `FORBIDDEN` |
| Post shapes | `kinds.POST` / `.CAROUSEL` / `.REEL` / `.STORY` | Every platform answers for all four |
| Automatic vs manual finish | `automatic`, `manualFinish` | Both false is the shape refusing; TikTok is the one platform reachable both ways |
| Platform content override | `platformContentOverride` | `platform_configurations`, per platform |
| Account content override | `accountContentOverride` | False everywhere: tailoring is per platform, so two accounts on one platform get identical text |
| First comments | `firstComment` | X only |
| Titles and descriptions | `title`, `description` | YouTube's title is separate and capped at 100; LinkedIn's is a document title and applies only to a PDF |
| Cover images and thumbnails | `coverImage`, `thumbnail` | Whether the provider will **carry** one. False everywhere: OpenAPI names Instagram's `cover_image` and YouTube's `thumbnail`, the live probe verified neither, and current support material says custom external YouTube thumbnails are unavailable. A role can still be *stored* where the provider names the field — §3.4 |
| Synthetic-media disclosure | `syntheticMediaDisclosure` | `IN_CAPTION` everywhere: no provider control has positive live evidence here, so a disclosure is written into the caption. That sentence does not by itself guarantee platform, advertising, or legal compliance |
| Provider drafts | `providerDraft` | False everywhere; submitting an existing Post Bridge draft is broken upstream (§4) |

A submission's **shape** comes from the post's format, not from its media: `CAROUSEL`, `REEL`, and
`STORY` map to their own shapes and every other `SignalFormat` submits as a standard post. This is
what makes "Instagram accepts this" answerable — a carousel, a reel, and a story have different
media bounds, and a story shows no caption at all, which preflight warns about rather than
discovering after the text is gone.

**Unknown fails closed.** Every field on `PublishPlatformCapability` is required, so a platform
cannot be added while leaving a question unanswered. Where the source records no answer the entry
refuses: a shape with neither delivery route, a media kind marked `FORBIDDEN`, a field marked
unsupported. A channel whose platform the table does not carry is refused by name and cannot be
sent, and a channel mapped to no platform at all is a different answer — see §10.

**Preflight reports per target account.** `PublishPreview.channels` carries one
`PublishChannelReport` per channel on the post: the platform, the shape, the resolved account, and
that account's own refusals and warnings. Only reasons true of the whole submission — no caption, no
publishing instant, an instant in the past, a post already marked published — stay on the preview
itself. A refusal names what has to change, with the number to remove or the media to add, because a
preview that says a post is wrong without saying how is a preview the user has to guess at.
`publishPreviewRefusals` is the gate on sending, so a reason shown in the preview cannot be stepped
over at commit.

**No provider call happens during preflight.** The whole preview is answered from this table and the
post, which is what lets it be honest without touching Post Bridge. What it cannot know is named
rather than pretended away: whether a video is corrupt, whether a URL will 404 when the provider
fetches it, and whether an extensionless URL is an image or a video — the last of these is reported
as a warning rather than assumed either way.

### 3.3 Content variants, and the preview that shows them

One caption used to go to every channel. C62 (#189) gives a post three layers, resolved in one
order, in `shared/publish-variants.ts`:

```text
base content
  -> platform override
    -> account override
```

`resolvePublishContent` is that order and contains nothing else — no database, no network, no
capability table, no React. It answers, per field, what the effective value is and which layer it
came from, and `PublishChannelReport.content` carries both to the preview. The order is unit-tested
in `shared/publish-variants.test.ts` rather than through a form or an HTTP round trip, either of
which can pass while the order is wrong.

**A layer says only what it changes.** Every field is optional and absent means inherit. Two cases
are worth stating because they look alike and are not:

- An empty string is **not** an override. It is trimmed and dropped, so clearing a caption field
  restores the post's caption. Post Bridge requires a caption on every submission, so an empty one
  could only ever have been a refusal.
- An empty media array **is** an override: a platform that deliberately receives no media, which is
  a real thing to want when the PDF goes to LinkedIn and X takes the text alone. `undefined`
  inherits the post's media; `[]` sends none.

**A field exists where the contract says it does, and nowhere else.**
`publishVariantFieldSupported` is asked three times from one definition: the composer renders a
control, `PUT /api/signal/posts/:id/variants` refuses a value, and preflight refuses a value already
stored against a platform the table has since stopped answering yes for. A form offering what the
API rejects teaches the user something untrue about the provider, and a limit enforced on one side
only is a limit met after pressing send. `coverImage` and `thumbnail` are the one pair where *offered* and
*delivered* come apart, which §3.4 is about: the control exists where the provider names the field
and the flag decides whether anything is sent.

**What the provider carries, and what it does not.** `platform_configurations` is keyed by platform
and carries text: a caption, a first comment, a title (`document_title` on LinkedIn), and a
placement. That vocabulary lives in `post-bridge.ts` and nowhere else. Two consequences are
refusals rather than guesses:

- **One media array per submission.** The provider takes `media_urls` once for the whole post, so a
  per-platform media selection is delivered through that array and only while every target agrees on
  it. Targets given different media refuse, naming each group and its count. Splitting one post into
  several submissions to honour two selections is not this card; picking a winner silently is not
  anything.
- **One set of content per platform.** `accountContentOverride` is false everywhere, so an account
  override arrives as its platform's configuration. That is unambiguous exactly while the platform
  resolves to one account — which §3.1's rule already guarantees by refusing zero or several — and
  the preview says so on the target it applies to rather than leaving the user to infer it.

**C77 built the rest of it, and `accountContentOverride` is true for Facebook alone.** C73's live
probe verified `account_configurations` on 21 August (`docs/post-bridge-api-surface.md` §14,
question 1): the field is accepted, its encoding is a list of objects each carrying `account_id`,
and a per-account caption reads back after create and again after `PATCH`. Every other platform
keeps the single-account rule, because no other platform had two connected accounts for the probe to
ask the question with — unverified is not unsupported, and `shared/publish-capabilities.test.ts`
pins the whole matrix rather than a blanket false, so a flip without a dated §14 result fails.

**A channel publishes to the accounts a person chose, and to one account otherwise.**
`signal_post_publish_targets` stores that choice — the ids and nothing the provider owns, because a
cached handle would go stale the moment a page is renamed. **No rows is not a choice to send
nowhere**: it means nobody chose, so §3.1's rule still decides and the post plans and submits byte
for byte as it did before the table existed. Where a selection exists it *replaces* that rule rather
than filtering it, so a page §3.1 would never have matched is reachable by naming it, and an id
disconnected since refuses by name.

**Every chosen account answers for itself.** `PublishChannelReport.targets` carries one report per
account — its own resolved content, refusals, warnings, and status — and two account refusals are
never merged into a sentence about the platform, because "Facebook is blocked" cannot say which page
a person has to fix. The list is **absent, not empty**, where nobody selected. A channel is blocked
when any of its accounts is: sending to some of the accounts somebody chose and dropping the rest is
the one outcome nobody asked for.

**Carrying accounts is not the same as carrying every field per account.** C73 verified a per-account
caption and per-account media and nothing else, so `PUBLISH_ACCOUNT_DELIVERABLE_FIELDS` is those two.
A title, a first comment, a post shape, a placement, and a media role stay platform-level, and an
account layer that sets one warns that its value reaches every account on the platform.

**Per-account media is Drive-only.** It exists solely as provider ids, and a Drive file becomes one
only by being uploaded immediately before the request (C75). An account given a public address of
its own **refuses**, named, and is never dropped or replaced with the platform's media; a post whose
own media is public refuses to give any account files at all, because the request carries `media` or
`media_urls` and never both. Each account's files are uploaded fresh even where the same file is
also in the submission's own media — sharing one ephemeral id across two levels would make the
evidence lie about what was sent where.

**Identical content to two accounts on one platform refuses before it is sent, and this app owns
that rule.** The probe recorded question 1 as *verified*: the API accepts materially different
captions to two same-platform accounts and states no restriction whatever. Nothing downstream will
refuse a duplicate, so this app does — because two of one platform's audiences reading the same post
is what those platforms suppress, and the accounts it reflects on are the user's. It is argued as a
judgement in `shared/publish-same-platform.ts` and **not attributed to the provider**: earlier
wording here and in §14 cited a vendor support-page restriction that was never recorded anywhere,
and the correction note at the end of §14 says what happened. The refusal names the accounts that
collided and offers the two honest fixes — write each its own content, or send to one of them — and
recommends no filename or metadata trick.

**Only *identical* refuses; near-identical warns and the person decides.** Where two accounts get
captions that match once capitalization, spacing, punctuation, and emoji are set aside, and the same
media, the channel carries a warning that names them and asks whether it was deliberate — the
confirm button stays live. The test is categorical rather than a similarity ratio, which this app has
no honest threshold for: "different enough" is a judgement about who reads both pages. Media is
compared exactly in both halves, so two accounts given the same words with different pictures are a
real difference and neither refuse nor warn.

**A synthetic-media disclosure is written into the caption**, because
`syntheticMediaDisclosure` is `IN_CAPTION` on every platform the contract answers for. The
disclosure sentence is appended once, the preview shows the caption with it already in it, and the
caption limit is measured against that text — a disclosure that pushes X past 280 has to refuse
before the send rather than after. The 21 August 2026 live matrix did not positively verify
YouTube's `contains_synthetic_media` or TikTok's `disclose_branded_content` and
`disclose_your_brand`, and the provider account cap makes those controls unaskable from this
workspace while it keeps the five accounts the studio publishes on. They therefore remain absent
from the API and composer rather than being inferred from OpenAPI. A future platform recording
`PROVIDER_FIELD` would carry its verified control instead and nothing would be appended; sending a
provider control would still not, by itself, guarantee platform, advertising, or legal compliance.

**A placement is a shape, not a decoration.** An override sets the `PublishPostKind` the platform
submits as, so a story meets a story's media bounds and warns that its caption reaches no reader.
Only a story is sent as a provider `placement`: a reel is one video in the platform's ordinary post
(§3.2), so choosing it changes what preflight accepts and sends no placement field, which is what
the source records and all it records. C73 positively verified that the existing generic path sends
Facebook stories as `placement: "story"`; the Facebook regression fixture proves that path without
adding a Facebook-only feature.

**The plan hash covers the overrides.** The tailored configurations and the media that would be sent
are part of the hashed plan, so a layer edited between preview and confirm refuses the commit
exactly as an edited caption does.

#### The preview

**Nothing remote loads until Show preview is pressed.** The composer renders media as addresses and
text; no thumbnail, no video, no provider call. That press is the only trigger, and it is also when
`listTargets` is first called — which is why the account layer is edited inside the preview tab for
the account it belongs to, since that is the first moment an account id exists to key it by.

One tab per target, each self-contained: the effective text, which layer each value came from, the
title and first comment, the media in the order that target receives it, the post's local wall clock
beside the provider instant, the delivery mode, and that target's own warnings and refusals. A
merged list would make the reader work out which target each line was about, which is the same
reason §3.2 reports per channel rather than as one flat list.

Media rendering, and the rules it keeps:

- **Show preview** still shows media as labelled text. Public image and video bytes are a second,
  optional choice — **Show public media previews** — because loading one is a browser request to
  that host and shares the viewer's IP with it. **Show text only** returns to addresses alone.
- When remote previews are on, images load at a constrained size — a preview is for checking the
  order and the crop, not for downloading a campaign asset at full resolution. At most eight public
  items load in one panel; the rest stay as text with their open link.
- **A video never autoplays.** It is not fetched by the opt-in at all: it takes its own press, and
  even then it arrives with controls rather than playing. There is no `autoplay` attribute anywhere
  in the module to be flipped later.
- Drive viewer pages, PDFs, unknown kinds, and signed or expiring addresses (query or fragment)
  stay labelled text and are never embedded.
- Broken media gets a usable fallback — what happened, the address, and a link — rather than a gap
  that blocks the rest of the payload preview.
- `referrerPolicy="no-referrer"` is set on the elements HTML defines it for. A `<video>` cannot
  carry it, so the app's `Referrer-Policy: no-referrer` response header is what covers that request;
  `server/app.test.ts` asserts the header rather than trusting an attribute that would be ignored.
- **`media-src` gains `https:` in the production CSP.** This is the one browser-visible change the
  publisher makes, and it corrects §12's "nothing changes in the browser": rendering a video the
  post already references needs the directive to permit the host, which is not known in advance —
  the same reason `img-src` already permits one. No other directive widens.

**The server still fetches nothing.** It does not fetch a media URL, a cover, a thumbnail, or
anything else a preview names, and `server/publish/publish.test.ts` proves it by replacing `fetch`
with a spy for the duration of a preview and asserting it was never called. **A preview never
becomes a byte path**, and that holds whatever else changes: the rule below is narrowed, this
sentence is not.

**The media rule, as it now stands.** The claim recorded on `signal_post_media` used to read *this
app never uploads, downloads, or proxies media*. What survives is narrower and is the version every
comment in the repository now states: **this app stores no media files, serves no media bytes, and
holds no media bytes at rest.** Referencing, storing, and serving are still refused. The one
exception the repository has decided is a single server-side stream from a user-selected Drive file
to the provider's upload URL, immediately behind a confirmed submit, update, or
restore-and-resubmit — through `server/drive/media.ts`, persisting nothing and writing nothing back
to Drive. The implementation re-resolves metadata and refuses a changed fingerprint before opening
content, then streams the exact declared length through a freshly reserved provider media id.

**What C74 did build is the reference, not the bytes.** `server/drive/media.ts` now resolves one
user-supplied Drive **link** — parsed as a URL and checked against Drive's own hosts before anything
is looked up — to the file's canonical metadata and a version fingerprint, and reads no content
whatsoever. A `signal_post_media` row is therefore discriminated: `source` is `URL` or `DRIVE`, and
a Drive row carries Drive's name, MIME type, size, and at least one of `version`, `modifiedTime`,
and a checksum. The fingerprint exists because a file id is not evidence of the bytes anybody
previewed — Drive may replace a file's content under the same id — and the plan hash covers the
whole descriptor, so a file that moves invalidates a plan taken before it did. The stored `url` is
Drive's `webViewLink`: a page for a person to open, never provider-fetchable media, and never
embedded by the preview.

The paragraph above still holds without qualification: a preview makes no Drive call and no provider
call. Preflight classifies a Drive reference from the MIME type recorded when it was resolved, and
the only thing that replaces a stored fingerprint is an explicit **Recheck Drive file**, which goes
through the ordinary Signal edit transaction. The Files boundary is untouched by any of it
(`AGENTS.md`, `shared/drive.ts`, `server/drive/browse.ts` keep their rule exactly): the metadata read
is a second provider interface, `DriveMediaProvider`, and `DriveProvider` — the vocabulary Files is
handed — still has no way to reach a file by id.

**A provider media id is ephemeral.** It is never a durable Signal media reference: it is recreated
on every submit, update, and restore-and-resubmit. The publication evidence records both the
versioned source descriptors and the ids used for that particular provider request. Reconciliation
compares ids where the provider returns them and reports the comparison unavailable where it does
not; it never substitutes a Drive viewer URL. The vendor's
24-hour and on-publish deletion behavior is **documented but unverified** — read off the OpenAPI
document, and not exercised by C73 either, which deleted every asset it made explicitly and so never
let one expire (§14, question 2). Nothing may depend on its timing until a dated follow-up read of
inventoried asset ids records it.

**Everything the surface note did not positively establish stays fail-closed.** The dated live
matrix in `docs/post-bridge-api-surface.md` §14 settled the upload contract, the MIME enum, the
deletion half of the media lifecycle, the posts list and its pagination, account configurations for
Facebook, and the Facebook story path. It did not establish the YouTube or TikTok platform
disclosure controls, the remaining unverified media roles, the analytics filters, or the actual
`match_confidence` vocabulary. **The fail-closed values in `shared/publish-capabilities.ts` remain
authoritative** until a dated §14 result verifies a field or a card records an explicit path that
does not rely on it. A field appearing in a spec is not permission to flip a capability, and neither
is a probe run that never reached the question (§3.3, §3.4).

### 3.4 Media roles: a cover image and a thumbnail

**A role is a reference, not a URL string.** C76 moved the cover image and the thumbnail out of the
`signal_post_variants.cover_image_url` and `.thumbnail_url` columns and into
`signal_post_variant_media`, keyed `(post_id, platform, account_id, role)` where the role is
`COVER_IMAGE` or `THUMBNAIL`. The row is `signal_post_media`'s contract column for column — `source`
discriminates a public `https:` URL from a version-bound Drive file, the same eleven columns carry
the identity and the version fingerprint, and the same two SQLite triggers enforce the same
cross-field rule, built once and spent on both tables. A Drive-backed role needs exactly the evidence
post media has needed since C74, and a file id in a column whose contract is "URL string" is the
overloading this table exists to avoid.

**One writable source of truth.** The two legacy columns are kept — this app's schema module is
additive by design and a drop is a table rebuild — and they are frozen in the strict sense:
`backfillSignalVariantRoleMedia` moves each value into a `URL` role row and clears the column in the
same transaction, on every boot, and nothing writes either column again. That is what makes the
migration idempotent in the way that matters: a role a person deliberately removes afterwards is not
resurrected on the next start, because the column it would come back from is empty.

**Storing a role and delivering one are two questions.** They are answered by two functions in
`shared/publish-variant-media.ts`:

| Question | Function | Answer today |
| --- | --- | --- |
| Can this platform hold this role? | `publishRoleComposable` | Instagram's cover and YouTube's thumbnail — the two the provider names |
| Will the provider carry it? | `publishRoleDelivers` | Nowhere. Both capability flags are false |

The live probe (`docs/post-bridge-api-surface.md` §14, question 3) left both roles **still
unverified**: no video asset was uploaded and each role needs a video as the post's own media. For
YouTube there is a second reason to stay closed — current provider support material states that
custom external thumbnails are not available, so the conflict with OpenAPI is unresolved rather than
resolved positively. **C76 records that as will-not-build and leaves `thumbnail: false`.** No
`cover_image` and no `thumbnail` key is emitted by `postBridgePlatformConfigurations`, and a unit
test asserts their absence: inventing a wire field from a document is precisely what the card put out
of scope. Flipping either flag takes a dated §14 result, and one function-level test pins the flags
to the recorded states so a flip without evidence fails.

**So a stored role warns, everywhere.** The composer names the state under the control, and preflight
says it again per target: a role the provider defines no field for, and a role it defines that nobody
has watched work, are two different sentences because they are two different facts and only one of
them might change. A reel on a platform with no role still gets the older *the platform chooses its
own* warning — but only where no role is set, so one fact never arrives as two sentences. A role
whose contents the provider would reject outright — a video or a PDF in the role, an image past the
8 MB ceiling C73 measured — **refuses** rather than warning, at the write boundary and again at
preflight.

**A role is version-bound and hashed.** The plan hash covers every resolved role's whole fingerprint
beside the post's own media, so a role edited between preview and confirm refuses the commit, and so
does a Drive file whose content was replaced under the same id. A role's fingerprint is replaced only
by an explicit recheck — `POST /api/signal/posts/:id/variants/media/recheck` — which goes through the
ordinary variant replacement and moves the post's `updated_at` **exactly when the version actually
moved**: rechecking a file nobody has touched must leave an open confirmation valid. A failed recheck
writes nothing and leaves the last metadata visible beside the reason. No Drive call happens in a
preview, roles included.

**Nothing is uploaded for a role.** Until a role is verified there is no request field to put a
provider media id in, so no role asset is created — which is also why there is no role snapshot on a
publication to reconcile: uploading bytes to fill a field nobody will read would be the worst of both
answers. The verified media role is a different shape entirely: **a LinkedIn PDF document post**,
which is the ordinary C75 media path plus the `document_title` this app has always collected. §14
verified that pairing live, and `e2e/signal-variant-media.spec.ts` plus
`post-bridge-wire.test.ts` walk it from the Drive link to the vendor's own field name.

### 3.1 The Facebook account rule

Three Facebook pages are connected in the broader publishing setup: `AdDrive Media`,
`G.Holmes Designs`, and `Wild Eye Photography`. **Only `G.Holmes Designs` may receive this
campaign's work** unless a person says otherwise. Target resolution matches that account by stable
provider identity and verified handle, refuses zero or multiple matches, and never silently falls
back to either of the other pages.

**An explicit selection is that "otherwise", and it is the only one** (C77, §3.3). A post with rows
in `signal_post_publish_targets` publishes to exactly the pages named there, which is a deliberate
act with the account list on screen — not a fallback, not a guess, and not something a rename can
cause. A post with no rows resolves exactly as this section has always described. The business rule
above is a default for content nobody has thought about; it was never a claim that the other two
pages are unreachable by someone who means it.

---

## 4. The interface, and where the code lives

`server/publish/`, split the way `server/drive/` and `server/signal/` are split:

- `provider.ts` — the `PublishProvider` interface and `UnavailablePublishProvider`, the same
  named-failure fallback `UnavailableSignalProvider` gives the calendar.
- `post-bridge.ts` — the only module that knows a URL, a header, or a field name belonging to Post
  Bridge. Nothing outside it imports the vendor's vocabulary.
- `mock-provider.ts` — what every automated test runs against. No test reaches the real API, for
  the same reason no test reaches real Drive.
- `plan.ts` — database-free rules: the instant conversion (§5), the preflight that turns the
  capability contract into refusal reasons, target resolution, and the preview. The same function
  builds the preview and the commit, which is the importer's rule and the reason an import cannot
  promise one thing and do another.
- `shared/publish-capabilities.ts` — outside `server/publish/` on purpose. The channel-to-platform
  map and the platform capability table are the one definition of what a provider will accept, and
  the composer reads it rather than keeping a second copy of the rules in React (§3.2).
- `shared/publish-variants.ts` — outside `server/publish/` for the same reason and beside it. The
  base → platform → account order, and which fields a platform will carry an override for (§3.3).
  The layers themselves are Signal's data: they are read through `SignalProvider.listVariants`,
  written by `replacePostVariants` in `server/signal/service.ts`, and stored in
  `signal_post_variants`. Reading them added a *read* to the provider interface and no write, which
  is the line that keeps the publisher unable to change a post it is planning from.
- `service.ts` — the only code that calls `submit`, the only code that writes the publication
  tables, and the only code that writes `integration_events` for a publish.

```ts
export interface PublishProvider {
  /** False leaves the caller a state to render rather than an exception to swallow. */
  readonly available: boolean;
  /** The accounts the provider has connected, so a channel can be resolved to a real target. */
  listTargets(): Promise<PublishTarget[]>;
  /** The first write. `update` is the second, and §7.2 says why there are only two. */
  submit(request: PublishRequest): Promise<PublishSubmission>;
  /** Reconciliation: what the provider currently believes about a submission we made. */
  check(providerPostId: string): Promise<PublishSubmission>;
  /** What the provider is currently holding, as against what became of it (§7.2). */
  describe(providerPostId: string): Promise<ProviderPostRecord>;
  /** Rewrite a post the provider still holds — in full, and always with `scheduled_at` (§7.2). */
  update(providerPostId: string, request: PublishRequest): Promise<PublishSubmission>;
  /** Withdraw a submission that has not gone out yet. Required before a post is deleted (§7). */
  cancel(providerPostId: string): Promise<void>;
}
```

`PublishRequest` carries the resolved target ids, the caption, the computed instant, and the zone
it was computed in — never a `SignalPost`. The provider is handed a submission, not the schedule.
Provider drafts are not a staging boundary: the working integration confirms that submitting an
existing Post Bridge draft is broken upstream and returns a server error, with no supported API
route around it. Preview remains local and commit submits the confirmed request directly.

Two boundaries are deliberate and worth stating so they are not eroded later:

- **`SignalProvider` gains nothing.** It has no write method by construction and this card does not
  add one. The publisher reads posts through it exactly as the calendar does.
- **The publisher never imports `server/signal/service.ts`.** It has no reason to change a post,
  and the only way to make that true in a year is for it to be true now.

---

## 5. The date and time conversion

This is the part `shared/signal.ts` deliberately left to this card.

A Signal post carries `date` (`YYYY-MM-DD`, local) and `time` (`HH:MM`, a label) and **never an
instant**. That is not an oversight, it is the rule that keeps a post scheduled for the 14th on the
14th in every view and every zone. Post Bridge's `scheduled_at` is an ISO 8601 date-time — an
instant. Something has to convert, and the only question is where, in which zone, and what happens
to the result.

### 5.1 The rule

**One function, at the outbound edge, and the answer is never stored on the post.**

`publishInstantFor(date, time, zone)` lives in `server/publish/plan.ts` — server-side, in the
publishing module, and deliberately *not* in `shared/signal.ts`. Signal's claim is that no code
derives a moment from the pair. That claim stands, and its scope is now exact: **nothing that
displays, sorts, filters, or stores a post derives a moment from it.** One function does, at the
moment of handing an argument to a provider, and its output is an argument — not a property of the
post, not a column on `signal_posts`, not a value any view reads. Put the function in `shared/` and
the next reader will use it for a calendar cell, and the day-shift bug the cell rule exists to
prevent comes back.

### 5.2 The zone

The zone is **configured, explicit, and shown to the user before anything is sent**:
`PUBLISH_TIMEZONE`, an IANA name such as `America/New_York`, in `server/config.ts` beside the other
environment settings.

Not the server's local zone, because that is an accident of where the process runs and moving the
app must not move the schedule. Not the browser's, because the person previewing at an airport is
not scheduling for the airport. A post is planned by a person, for an audience, in one place; that
place is configuration, it is stated on the confirmation, and if it is unset publishing refuses to
run rather than guessing.

The working artifact uses the browser's implicit zone and converts a `datetime-local` value with
`Date.toISOString()`, with no DST-gap handling. That behavior is intentionally not ported. The
configured-zone rule is stricter and is the clearest reason to re-implement the integration inside
this app rather than transplant its transport and time model.

### 5.3 The conversion, and its two hard days

Compute the offset `zone` had at that wall-clock time — `Intl.DateTimeFormat` with `timeZone` set
and `timeZoneName: 'longOffset'`, resolved against a candidate instant and checked by rendering it
back — then apply it. The check is the point: the conversion is correct only if formatting the
resulting instant *in that zone* reproduces the same `YYYY-MM-DD` and `HH:MM` that went in. Two days
a year it cannot, and both get a stated rule rather than whatever the arithmetic happens to do:

- **The spring-forward gap.** `2026-03-08 02:30` does not exist in `America/New_York`. The
  submission is **refused**, at preview, naming the hour that does not exist and asking for a
  different time. It is not silently moved to 03:30 — an app that quietly reschedules content is
  worse than one that says it cannot.
- **The fall-back repeat.** `2026-11-01 01:30` happens twice in `America/New_York`. The **first**
  occurrence is taken — the earlier offset, daylight time still in effect. Deterministic, written
  down, and wrong by at most an hour in the one direction that never lands on a different day.

Two more refusals, for the same reason:

- **An instant in the past** is refused, and the refusal says by how much. Post Bridge treats a
  null `scheduled_at` as *post immediately*; the app never sends null. Publishing now is a separate,
  explicitly-confirmed action, not what a stale date silently degrades into.
- **A post with `date === null`** is not publishable at all. It is in the unscheduled queue, it
  belongs to no cell, and there is no instant to compute. The planner offers no publish control on
  it.

### 5.4 `use_queue` is not used

Post Bridge can place a post in the next free slot of *its* queue, in *its* configured timezone.
That would make Post Bridge's queue settings the thing that decides when content goes out, which is
precisely the authority §5.7 gives Signal. The app always sends an explicit `scheduled_at`, computed
here, from the pair the user set. The working artifact does expose and use `use_queue`; the
capability is real, but keeping Signal authoritative is more important than porting every mode, so
the original decision stands.

---

## 6. What `PUBLISHED` means

**Two meanings, two fields.** `SignalStatus` keeps its three values and keeps meaning what it means
today. Delivery gets a separate record with its own vocabulary. Nothing about existing rows changes
and there is no backfill.

`signal_posts.status` — `DRAFT` / `SCHEDULED` / `PUBLISHED` — is the user's claim about the post's
own progress, written only by Signal's own service, in response to a person. `PUBLISHED` means *I
consider this out.*

`signal_publications.state` is what this app did with a provider, written only by
`server/publish/service.ts`:

| State | Meaning |
| --- | --- |
| `SUBMITTING` | a row exists, the request has not been answered |
| `SUBMITTED` | the provider accepted it and gave us an id; it has not gone out yet |
| `CONFIRMED` | every target reported success |
| `PARTIAL` | some targets succeeded and some failed, and the rows say which |
| `FAILED` | nothing went out |
| `UNCONFIRMED` | we do not know, and a human has to look (§8) |
| `CANCELLED` | withdrawn before it went out |

Three reasons the one field could not hold both:

- **It would have two writers.** A person editing a post and a reconciler polling a provider would
  race on one column, and the loser silently wins. Every other column in `signal_posts` has one
  writer; this keeps that true.
- **One word cannot say "two of four".** Post Bridge answers per account. Collapsing that into a
  single status throws away the exact information `PARTIAL` exists to preserve.
- **The two are genuinely independent.** A blog post can be `PUBLISHED` and never submitted
  anywhere. A post can be submitted, accepted, and still fail on one of three accounts. Neither is
  a corner case; both are Tuesday.

### 6.1 A manually-marked post, and a publisher

- **`PUBLISHED` is never an instruction.** The publisher does not read `status` to decide anything.
  It does not refuse a `PUBLISHED` post and it does not queue a `SCHEDULED` one.
- **It is a warning.** When a post already claims `PUBLISHED` and has no publication record,
  preview says so in plain words — *you marked this published yourself; sending it will post it
  again* — and the user confirms or does not. That is the one place a person's claim and a
  machine's action collide, and it is answered by asking.
- **The publisher never sets `PUBLISHED`.** On `CONFIRMED` the planner shows the delivery state
  beside the status and offers a **Mark published** control, which is the user's own write through
  Signal's existing service. Auto-writing it would overwrite a person's field with a machine's
  opinion and give the column a second writer — the thing §6 just avoided. The one-click control
  costs a click and keeps the invariant.

### 6.2 Delivery is two axes, and neither one is the planning status

Delivery could not be one word either, so it is two fields kept apart in the schema
(C65, #192). The planner labels `signal_posts.status` **Planning status** and shows everything
below it under **Delivery**, one row per publication target.

**Mode** — the route a delivery takes — is new, and it is decided before anything is sent, from the
capability contract in `shared/publish-capabilities.ts`. It is stored on
`signal_publication_targets.mode` at submit time rather than derived on read: the contract can
change, and what a delivery needed from a person when it went out is a fact about that submission.

| Mode | Meaning | What is left for a person |
| --- | --- | --- |
| `AUTOMATIC` | the provider publishes it without anyone | nothing |
| `PROVIDER_DRAFT` | the provider holds it as a draft | submit it in Post Bridge |
| `MANUAL_FINISH` | the provider hands it to the platform's own application | finish it there |
| `UNSUPPORTED` | no route exists for this channel at this shape | publish it yourself |

The order above is also the precedence `deliveryModeFor` applies: automatic where a platform can
publish on its own, then a provider draft, then a person, and `UNSUPPORTED` for anything the
contract has no answer for — the same fail-closed rule preflight uses. Nothing in the app *chooses*
between two available routes today, which is why TikTok, reachable both ways, records `AUTOMATIC`;
per-target provider options would make it a choice and C62 (#189) did not add one.

`DeliveryMode` is the app's only answer to "how does this reach the platform". The preview tab of
§3.4 names the route the same four ways this table does, from the same `deliveryModeForCapability`,
because the tailoring panel and the delivery row are describing one channel and must never call its
route two different things. It is read against the **resolved** kind, so a placement override that
changes the shape can change the route with it.

**State** stays `PUBLICATION_STATES` exactly as §6 defines it. No value is added. What this card
adds is the grouping the planner reads them by, and the words each one is shown in — the stored
word is never displayed:

| Group | States | Why they are together |
| --- | --- | --- |
| `IN_FLIGHT` | `SUBMITTING`, `SUBMITTED` | nothing is required but time |
| `DELIVERED` | `CONFIRMED` | every target reported success |
| `ATTENTION` | `PARTIAL`, `FAILED`, `UNCONFIRMED` | three different facts, one response: someone looks |
| `STOPPED` | `CANCELLED` | withdrawn before it went out |

A **target** reports its own answer where it differs from its publication's, which is the case
`PARTIAL` exists for: one account delivered and another not, each with its own permalink and its
own error. A manual-finish target the provider accepted is `SUBMITTED` and still not out, so it
reads *waiting for you to finish* until a person records that they finished it — a write to
`signal_publication_targets.manual_completed_at` and to nothing else. That control refuses an
automatic target: there is nothing there for a person to finish, and allowing it would let a
person overwrite the provider's own answer by hand.

`blog` keeps the arrangement §10 already describes. It is shown as an `UNSUPPORTED` delivery rather
than left out — a missing row reads as *nothing to say* rather than *nothing can be sent* — and it
carries no completion control of its own, because its completion is `SignalStatus.PUBLISHED`. One
fact, one writer.

---

## 7. Signal's authority when a publish fails

`signal_posts` is the single source of truth for what is scheduled, and a publisher is a consumer
of it. Concretely:

- **The publisher writes nothing on `signal_posts`.** Not the date, not the time, not the status,
  not `updated_at`. It writes `signal_publications` and `signal_publication_targets` and nothing
  else. A failure downstream is a fact about a delivery, not about a plan.
- **A failed publish leaves the schedule intact.** The post stays scheduled for the day it was
  scheduled for. It gains a `FAILED` publication row, an `integration_events` row, and a visible
  state in the planner. Nothing moves.
- **Reconciliation is one-directional.** Reading the provider updates the publication row. It never
  updates the post. If Post Bridge reports a `scheduled_at` that disagrees with what
  `signal_posts` holds, **the provider is wrong by definition** and the disagreement is *reported*
  on the publication row, not resolved by copying it back. This is the whole difference between
  "Signal is authoritative" and "Signal is one of two systems".
- **What was sent is snapshotted.** The publication row keeps the caption, the media, the
  per-platform tailoring, the channel set, the instant, and the zone as they were at submit time —
  the same reason `IntegrationEntity` keeps a `label`, so a record stays readable after the thing it
  names has changed. Editing a post after submission is allowed and changes nothing about what is
  already with the provider: the planner shows **Provider update required** and stops there. Putting
  the two back in step is a separate act a person confirms — §7.2.
- **Deleting a post with a live submission cancels first.** `cancel()` runs, and if it fails the
  delete is refused with the reason. The alternative is an app that has forgotten about a post the
  world is still going to see.

### 7.1 Schema sketch

Additive, in the style of the existing tables — an existing database gains the tables and indexes
below, while later publishing cards add only nullable snapshot columns to the publication table.

```sql
CREATE TABLE IF NOT EXISTS signal_publications (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES signal_posts(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  provider TEXT NOT NULL,              -- 'post-bridge'
  provider_post_id TEXT,               -- null until the provider answers
  idempotency_key TEXT NOT NULL UNIQUE,-- ours, minted before the request (§8)
  scheduled_instant TEXT NOT NULL,     -- the UTC ISO instant that was sent
  timezone TEXT NOT NULL,              -- the IANA zone it was computed in
  sent_caption TEXT NOT NULL,          -- snapshot, so "what went out" survives an edit
  sent_channels TEXT NOT NULL,         -- snapshot, JSON array of SignalChannel
  sent_media TEXT,                     -- snapshot, JSON array of media URLs; NULL is not '[]' (§7.2)
  sent_configurations TEXT,            -- snapshot, JSON platform_configurations (§7.2)
  sent_media_sources TEXT,             -- nullable versioned URL/Drive source descriptors
  sent_provider_media_ids TEXT,        -- nullable ids used for this provider request only
  error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
-- One live submission per post. A double-submit is a constraint violation, not a race.
CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_publications_live
  ON signal_publications(post_id) WHERE state IN ('SUBMITTING', 'SUBMITTED', 'UNCONFIRMED');

CREATE TABLE IF NOT EXISTS signal_publication_targets (
  publication_id TEXT NOT NULL REFERENCES signal_publications(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  provider_account_id INTEGER NOT NULL,
  outcome TEXT,                        -- null while pending, then SUCCESS or FAILURE
  permalink TEXT,                      -- post_results.platform_data.url
  error TEXT,
  PRIMARY KEY (publication_id, provider_account_id)
);
CREATE INDEX IF NOT EXISTS idx_signal_publications_post ON signal_publications(post_id);
```

`ON DELETE RESTRICT` on `post_id` is the delete rule above, expressed where it cannot be forgotten.

---

### 7.2 The provider update path, and the four actions

**The question this section exists to settle:** the interface was `listTargets`, `submit`, `check`,
and `cancel`. Nothing in the earlier sources established that Post Bridge had an update path at all,
and the alternative — every content or schedule change becoming a cancel-and-resubmit, losing the
`provider_post_id` and any permalink with it — would have changed the rules below rather than the
wording of them.

**It has one.** From Post Bridge's own OpenAPI document (`GET https://api.post-bridge.com/reference`,
served inline in the Scalar page's configuration):

| Route | What it takes | What it refuses |
| --- | --- | --- |
| `PATCH /v1/posts/{id}` | `caption`, `scheduled_at`, `media` / `media_urls`, `social_accounts`, `platform_configurations`, `account_configurations`, `is_draft` | `400` invalid, `404` unknown post |
| `DELETE /v1/posts/{id}` | — | `400` — "Can only delete scheduled or draft posts." |
| `GET /v1/posts/{id}` | — | `404` |

`status` is `posted | scheduled | processing | failed` beside an `is_draft` flag, and there is **no
idempotency key anywhere in the document** — which is the same finding §8 already recorded for
`POST /v1/posts`, now confirmed for the update path too.

Three consequences, each of which is a rule in the code rather than a note here.

**1. `scheduled_at` is on the wire for every update, without exception.** The vendor's own words on
`PATCH`: *"If updating a 'scheduled' post make sure to always pass 'scheduled_at' otherwise the post
will process immediately."* The field that reads as optional is the one that publishes a post early,
and `null` means *post now*. So the adapter sends the whole request every time and never a partial
patch — a diff-shaped adapter that forwarded only the changed fields would put a post out the first
time somebody fixed a typo. `PostBridgeProvider.update` carries that rule and
`server/publish/publish.test.ts` asserts the field is present.

**2. Full-state sending is also the only idempotency available.** There is no key to send, so the
guarantee is by end state: the same `PATCH` twice leaves the same post. `POST /v1/posts` has no such
property, which is why *update* is an update and *restore* is the only action that resubmits.

**3. A published post is out of reach, and it is refused twice.** The vendor refuses `DELETE` on
anything that is not scheduled or draft; the app refuses it first, from the record it read, so the
user gets a sentence instead of a `400`. `PROCESSING` is refused as well — a post being sent as the
request is made would land on either side of the send, and that is the ambiguity §8 exists to decline
rather than gamble on.

#### The four actions

Read first, act second, always. `describe` returns the provider's record; `buildProviderReconcile`
in `server/publish/reconcile.ts` puts it beside the plan and produces the difference, the offers, and
the refusals; nothing writes until a person confirms one offer. The same function builds the panel
and gates the commit — the importer's rule, for the importer's reason.

| Action | What goes out | Refused when |
| --- | --- | --- |
| **Update provider content** | Signal's caption, media, accounts, and tailoring, on the instant the provider already has | not scheduled or draft; nothing about the content differs; the plan itself refuses |
| **Update provider schedule** | Signal's instant, on the content the provider already holds | as above; the instant already matches; **the provider holds content this app did not send** |
| **Cancel provider post** | `DELETE` | not scheduled or draft — a published post explicitly |
| **Restore from Signal and resubmit** | withdraw, then a fresh `submit` | published or processing; the plan itself refuses |

Drive media changes what goes on the wire, not the four actions. Immediately before every submit,
content update, schedule update, or restore-and-resubmit, the service revalidates each stored Drive
fingerprint and opens a bounded stream only if it still matches. The adapter reserves a new provider
media id for each source, streams directly to that signed URL, and sends `media`; it never sends the
Drive viewer address as `media_urls` and never reuses an earlier id. Public-URL submissions retain
the original `media_urls` wire shape exactly.

The three evidence columns deliberately answer different historical questions. `sent_media` remains
the nullable string-array snapshot older rows and URL reconciliation understand; NULL still means
unknown, not an empty array. `sent_media_sources` is a versioned snapshot of the discriminated
references and their confirmed Drive fingerprints. `sent_provider_media_ids` records the ephemeral
ids used for that one request. Where `describe` still returns comparable ids they are compared;
where it does not, the panel says **media comparison unavailable** and refuses the schedule-only
action rather than inventing equality from a source snapshot.

Two of those refusals are worth their own sentence.

**Rescheduling fails closed against an outside edit.** *Update provider schedule* sends the content
this app believes is out there, taken from the publication snapshot. If somebody edited the post in
Post Bridge directly, that snapshot is no longer what the provider holds and sending it would quietly
overwrite their edit — so the disagreement is reported and rescheduling is refused until the user
chooses a side. *Update provider content* stays available, because replacing their copy with Signal's
is a legitimate choice; it just has to be the one that was made on purpose.

**Restore withdraws only what is there to withdraw.** A post the provider has already failed has
nothing out and cannot be `DELETE`d, so restore skips the call, releases the publication locally, and
resubmits. That is two external operations, two `integration_events` rows, and the first is kept
whatever the second does: a resend that fails leaves a cancelled publication and a recorded
cancellation — the state a person retries from, not a half-written one they cannot read.

#### Staleness, over both sides

The commit token is `reconcileHash`, over the plan hash **and** the provider record. One side alone
would not do: a plan hash misses a provider that moved under an open panel, and a record hash misses
a Signal edit. The service rebuilds the whole comparison at commit and refuses a token that no longer
matches, so anything that moved between looking and pressing sends the user back to look again.

#### What each account was handed

`sent_account_configurations` is a column of its own rather than a new meaning for
`sent_configurations`, which stays the JSON `platform_configurations` it has always been —
overloading it would make every row written before C77 ambiguous rather than merely silent about
accounts. It is versioned, and it has three states rather than two:

| Value | Means | Compared |
| --- | --- | --- |
| `NULL` | a row migrated from before the column | **never** — unknown is not a difference |
| `{ version: 1, items: [] }` | nothing was tailored per account | yes |
| `{ version: 1, items: [...] }` | what each account was handed | yes |

The empty case is written deliberately: *nobody recorded* and *nothing was tailored* are different
facts, and only one of them can honestly be compared with a plan. Local drift compares the two
sorted by account id over caption and media ids together, and reports `accountContent` where they
disagree. Provider reconciliation compares the same thing against what the provider reports per
account — and where the provider reports nothing, it says so rather than reading silence as every
account having been reset.

#### The snapshot that may not be there

`sent_media` and `sent_configurations` are **nullable, and NULL is not `'[]'`** — the same
distinction `signal_post_variants.media_urls` already makes. `'[]'` is a submission that carried no
media on purpose; NULL is a publication written before the columns existed, whose media nobody
recorded. Defaulting the second to the first was the tempting migration and the wrong one: every
migrated publication carrying media would have reported a media difference on the strength of a
backfill rather than of evidence.

So the unknown stays unknown. Drift says nothing about media it cannot evidence, the comparison says
plainly that the submission predates the snapshot, and exactly one action stops — **Update provider
schedule**, which is the only one that has to prove it is leaving the provider's content alone.
Updating the content records a snapshot and clears it for good.

#### What a Signal edit does, and does not do

It raises **Provider update required** and stops. That flag is `publicationDriftFields` in
`shared/publish.ts`, computed from the publication's snapshot against the post as it stands — local
rows on both sides, no provider call, and therefore no possibility of a remote mutation following a
local edit. The account set is deliberately *not* answered there: resolving it needs the provider's
target list, so it belongs to the comparison, which is allowed to read.

---

## 8. Idempotency, and the ambiguous submit

**Neither provider offers an idempotency key.** Post Bridge's OpenAPI document contains no such
header or field on any route — re-checked against the whole document when the update path was
settled in §7.2, not only against `POST /v1/posts` — and Buffer's standards guide does not mention
one. So the app builds what it can and is honest about what it cannot.

One thing did improve with §7.2: `PATCH /v1/posts/{id}` is sent in full, so it is idempotent by end
state even without a key. That property belongs to the update path alone. `POST /v1/posts` has no
equivalent, which is why the table below still governs every submission.

**What the app can guarantee — one submission per post.** The publication row is written *before*
the HTTP call, in its own transaction, in state `SUBMITTING`, carrying a locally minted
`idempotency_key`. The partial unique index in §7.1 means a second submit for the same post fails
at the database, not at the provider. Two browser tabs, a double-click, and a retry that overlaps
its own first attempt are all the same constraint violation.

**What the app cannot guarantee — that a request it never got an answer to did not arrive.** These
outcomes are distinguished, because they need different behavior:

| Outcome | Did the request reach the provider? | What happens |
| --- | --- | --- |
| DNS failure, connection refused, TLS failure | no bytes sent | safe: retry (§9) |
| `400` with `InvalidPostDto` | yes, and it was rejected | `FAILED`, errors shown, no retry |
| `429` | yes, and it was refused | safe: back off and retry (§9) |
| `500` after a complete response | yes, and it failed | safe: retry once, then `FAILED` |
| **timeout, socket reset, no response** | **unknown** | **`UNCONFIRMED`. No automatic retry, ever.** |

The working integration independently classifies `server_unavailable`, `upstream_error`,
`cancelled`, and `rate_limited` submissions as ambiguous. The provider adapter maps those failures
to `UNCONFIRMED` unless it has a complete response proving that no post was accepted; it never
turns vendor wording alone into permission to resubmit.

`UNCONFIRMED` is a state a person resolves, not a state the app retries out of. The failure mode of
a blind retry here is that the world sees the same post twice, from an app whose entire job is to
be deliberate about what goes out. Fifteen seconds of a human's attention is cheaper than a
duplicate post.

**The reconciliation match rule**, offered to that human rather than acted on alone: list
`GET /v1/posts?status=scheduled` and look for a post whose `caption` equals the snapshot, whose
`scheduled_at` equals the computed instant, and whose `social_accounts` set equals the target set.
That triple is what makes two posts the same post, and it is what a person would check by hand.
Exactly one match, and the UI offers to adopt its id and move to `SUBMITTED`. Zero matches, or more
than one, and it says so and offers nothing — a guess here is the duplicate it was avoiding.

---

## 9. Rate limits, backoff, and retry

Post Bridge documents a 429 on one endpoint (`POST /v1/analytics/sync`, "please wait between
syncs") and nothing else. Absence of a documented limit is not absence of a limit, so:

- **Any 429 from any endpoint is authoritative.** Honour `Retry-After` when the response carries
  one; otherwise exponential backoff with full jitter — base 1 s, cap 60 s, at most 5 attempts.
- **A rate limit is a fact about the connection, not about one post**, so it is recorded as one.
  `server/publish/sync-health.ts` keeps two values — when the provider was last reached, and the
  moment a limit it named runs until — and the queue-health summary reports them
  (`shared/queue-health.ts`, `SYNC_BEHIND`). Reaching the provider again clears the limit, because
  getting an answer is proof it has passed. `lastSyncedAt` is written by the reconciliation check
  alone: a preview reading the account list reaches the provider without refreshing a single delivery
  answer, and stamping that as a synchronisation would keep the record permanently fresh. **The
  analytics sync (§16) honours that rule rather than the earlier note that it would stamp the same
  record.** It refreshes no delivery answer either, so it writes the *rate limit* here — a limit is a
  fact about every call this app would make — and keeps its own last-synchronised time for the figures
  it did read. No new alert kind either way: the rate-limit line already says that any figures read
  from the connection are as old as the limit.
- **Only safe requests are retried.** Every `GET`, and `POST /v1/posts` only in the rows marked
  safe in §8. The ambiguous row is never retried by machine.
- **One submit in flight at a time**, plus a fixed ceiling of 60 submits per rolling hour. A loop
  that gets loose should hit the app's own ceiling long before it hits a provider's.
- **Platform limits are the provider's to enforce and ours to report.** Instagram's cap on
  API-published posts per day, and its equivalents elsewhere, arrive as a failed row in
  `post-results` with the platform's own words. The app surfaces that error verbatim (scrubbed) on
  the target row. It does not model per-platform quotas; that would be a second, always-stale copy
  of somebody else's rules.
- **Reconciliation polls on a schedule, not a spin.** A `SUBMITTED` publication is checked when its
  instant has passed, then at widening intervals, and gives up into `UNCONFIRMED` after a bounded
  number of attempts. There are no webhooks from either provider, so polling is the only mechanism
  available and it should be as quiet as that allows. The schedule is
  `RECONCILE_INTERVALS_MINUTES` in `shared/publish.ts` — 2, 5, 15, 45, then 120 minutes after the
  check at the publishing instant, so six attempts in all — and it is shared rather than duplicated:
  the open planner is the only thing that can drive a check, since this app runs no background job,
  and `reconcileSchedule` is the rule its timer reads *and* the rule the server enforces on arrival.
  An automatic check that is not due is answered from storage with no provider call, which is what
  keeps a loose timer from turning widening intervals back into a spin.
- **Manual refresh sits outside that budget.** A person asking always runs and never spends an
  attempt, so it cannot exhaust the automatic schedule and cannot force a publication into
  `UNCONFIRMED` by being clicked. Both kinds of check record `checked_at`, because *when was this
  last checked* is one question however it was asked, and the planner shows that time beside the
  delivery along with when the next automatic check is due.

---

## 10. Channels the provider cannot reach

`blog` is a Signal channel and neither provider publishes to a blog. It is not dropped, hidden, or
mapped to something approximate:

- A post targeting `blog` **and** publishable channels publishes to the others and reports `blog`
  as not sent, by name, in the preview and in the summary afterwards. The contract says this
  explicitly rather than by omission: `blog` maps to `null`, its channel report reads **Not
  available from this provider**, and it carries no refusal — a channel the table has no answer for
  is a different state, `BLOCKED`, and it refuses (§3.2).
- A post targeting **only** `blog` has no publish control at all — there is nothing to send it to.
- `blog` is where `SignalStatus.PUBLISHED` keeps doing its original job unassisted: the user posts
  it themselves and marks it published. The two meanings in §6 are not a transitional awkwardness;
  for `blog` they are permanent, which is the clearest argument that they were always two things.

The same applies to `ig`, `tt`, and `yt` until media is modelled (§3), with a different reason
given: *needs media*, not *has nowhere to go*.

---

## 11. Preview and confirmation

Publishing follows the importer's discipline, because it is the same problem — an irreversible
write built from data that can change underneath it:

1. `POST /api/signal/posts/:id/publish/preview` builds the plan from `plan.ts` and returns exactly
   what would be sent: each target account with its channel, platform, and handle; the caption
   verbatim; the computed `scheduled_at` **with the zone named and the local wall clock printed
   beside it** (`2026-09-14 09:00 America/New_York — 2026-09-14T13:00:00.000Z`); every channel that
   will not be sent, with its reason; and every warning (§6.1 already-published, §5.3 DST gap,
   past instant, format that implies media).
2. The user confirms. The preview's hash goes with the confirmation.
3. `POST /api/signal/posts/:id/publish` re-plans from the same code against the post **as it stands
   at commit**. If the plan no longer matches the hash, the commit is refused and the user previews
   again. A post edited in another tab between preview and confirm does not go out as the thing
   that was previewed.

Nothing publishes without step 3. There is no auto-publish, no publish-on-save, and no scheduled
job that submits without a person having confirmed that specific submission.

Step 1 is also the only thing that loads anything remote, and the plan it returns now carries each
target's resolved content rather than one caption for all of them (§3.3). The content overrides
themselves are a separate pair of routes — `GET` and `PUT /api/signal/posts/:id/variants` — and the
`PUT` replaces the whole set for a post in one transaction, the way branding does: the composer holds
every layer while it is being edited, and a patch would let a half-applied set leave a platform
tailored by a request reported as having failed. A preview is refused while a layer is unsaved, for
the same reason it is refused while the post is: a preview of unsaved content is a preview of
something that is not going out.

---

## 12. Credentials and secrets

- **`POST_BRIDGE_API_KEY`, in the environment.** In `.env.example`, read through `server/config.ts`
  beside the Google settings, never in SQLite, never returned to the browser, never in a log line.
  Unlike Drive's OAuth tokens — minted at runtime, per user, so they must be stored and encrypted —
  this is one static key pasted once. It does not need `settings`, a new encryption key, or a new
  callback route, and it should not invent them.
- **Both new variables join the boot schema, and both are optional-but-usable.** `server/config.ts`
  now parses the environment with Zod at startup and `config.test.ts` reads `.env.example` to stop
  the two drifting, so `POST_BRIDGE_API_KEY` and `PUBLISH_TIMEZONE` are added in three places at
  once: the schema, `.env.example`, and `ENVIRONMENT_VARIABLES`. They follow the Google trio's
  rule rather than the port's — publishing is optional, so unset is fine and a `publishConfigured()`
  predicate reports it the way `driveConfigured()` does; what is refused is a value that is present
  and unusable.
- **`PUBLISH_TIMEZONE` is checked against the platform's own zone list at boot**, not at 09:00 on
  the morning a post was due. `Intl.supportedValuesOf('timeZone')` knows whether
  `America/New_York` is real and `America/New_York_City` is not, and the difference between
  finding that out at startup and finding it out at submit time is the difference between a
  failed boot and a post that did not go out. It has no default: a guessed zone is the failure
  §5.2 exists to prevent, so an unset value disables publishing rather than falling back.
- **The app holds no social credentials at all.** Instagram, X, LinkedIn and the rest are connected
  inside Post Bridge, through Post Bridge's OAuth. This app's blast radius is one key it can
  revoke. That is a real security property of the choice in §2 and worth not giving up casually.
- **Every provider call is server-side.** No provider origin reaches the browser, and a
  `platform_data.url` permalink is rendered as a link, never fetched. The production CSP gains
  exactly one thing, and it is not a provider: `media-src` permits `https:` so the publishing
  preview can render the video a post already references (§3.3). It is the user's own media host,
  it is not known in advance, and the browser is what fetches it — the server never does.
- **The log never sees the key.** `integration_events` gets structured fields, not a request dump
  or a raw provider response, and `redactSecrets` scrubs the one free-text field a provider error
  reaches — the rule already in `AGENTS.md`, restated because this is the first integration whose
  errors are somebody else's prose.

---

## 13. The integration log

This card claims the `signal-campaign` source that has been in `INTEGRATION_SOURCES` unused since
C17, and it is the reason the value was reserved. Signal's ordinary writes still record nothing —
editing a post is local data, like editing a task. **A publish is an integration acting on local
data, and it records.**

Three additions to `shared/integration-log.ts`, each a value rather than a column, which is how
that module is meant to grow:

- `INTEGRATION_OPERATIONS` gains `signal.publish` and `signal.reconcile`.
- `INTEGRATION_ENTITY_TYPES` gains `signalPost`, with `INTEGRATION_ENTITY_LABEL` gaining
  `Signal post`. Each entity type maps to one local table and `signal_posts` is one.

Outcome mapping is the existing rule, applied:

- every target succeeded → `SUCCESS`
- some succeeded, some failed → `PARTIAL`, and the summary **names which channels went and which
  did not**
- nothing went out, or the request was rejected → `FAILURE`, with the provider's reason
- `UNCONFIRMED` → `PARTIAL`, because "we submitted something and do not know what happened" is
  precisely a half-finished operation, and a log that called it a clean failure would be lying

`correlation_id` is the `signal_publications.id`, so the planner can put an operation's audit record
beside the publication it explains — the same relationship import receipts already have. The row is
written in the same transaction as the publication-state change it describes.

---

## 14. What this does not decide

Named so an implementation card does not assume otherwise: media **storage**; the planner
UI beyond the confirmed submit flow and publication state; multi-workspace or per-client API keys;
and publishing anything that is not a Signal post. Section 2.1 now settles Buffer's explicit route,
contract, credential names, owner-run probe, provider-neutral schema, and the evidence-gated C87
adapter. Production enablement remains a dated owner action rather than a credential-presence side
effect.

**Media upload has moved off that list, in one direction only.** §3.3 now records the boundary: the
confirmed publishing path may stream user-selected Drive files to the provider through
`server/drive/media.ts`, and nothing is stored. C74 and C75 in
[`post-bridge-integrations-plan.md`](post-bridge-integrations-plan.md) implement that narrow path.
What stays undecided is the provider behavior still marked unverified in §14 of the API surface
note; this implementation does not depend on the vendor's documented cleanup timing.

**Analytics is no longer on that list.** It said "`/v1/analytics` exists and this app has no use for
it yet"; C68 (#195) gave it one, and §16 is the record. What stays undecided there is named in §16
rather than here.

**One narrow piece of planner UI has moved off it too.** "The planner UI beyond the confirmed submit
flow and publication state" now admits one read-only panel: **what the provider is holding**,
including posts this app did not send. C78 (#221) built it, and
[`post-bridge-api-surface.md`](post-bridge-api-surface.md) §6 and §14 are the record — the design is
one provider interface that can only list (`ProviderInventoryProvider`), a walk that reads every page
before a single row is written, one snapshot generation replaced in one transaction or not at all, and
a `WATCH` alert derived from the stored rows. What stays undecided is everything that would *act* on
one of those posts: adoption, linking, import, cancelling, and updating are declined in §0.3 of
[`post-bridge-integrations-plan.md`](post-bridge-integrations-plan.md), and no automatic refresh
exists on that path.

## 15. Acceptance

- [x] One provider and one interface shape, not a menu — §1, §2, §4.
- [x] The date/time conversion into the provider's scheduling API is specified, including the two
      days a year it cannot be done — §5.
- [x] The meaning of `PUBLISHED` under a real publisher is settled: two meanings, two fields, and
      the publisher writes neither of them onto the post — §6.
- [x] Reconciled with the working artifact and signed off before the Version 5 implementation cards
      are opened against FR7 publishing — C46 (#148).
- [x] One shared capability contract, outside React, answering every dimension for every platform,
      failing closed on anything it does not record, and reporting refusals and warnings per target
      account without a provider call — §3.2, C61 (#188).
- [x] Platform and account content variants resolving base → platform → account outside React,
      delivered only where the provider carries them and refused where it does not, with an
      on-demand preview per target account that the server fetches nothing for — §3.3, C62 (#189).
- [x] Provider result identity captured per delivery, and figures read through a service that has no
      way to publish, reschedule, or cancel anything — §16, C68 (#195).
- [x] What the provider is holding read on request through an interface that can only list, stored as
      one snapshot generation replaced whole or not at all, and surfaced as a derived alert that no
      page load can spend a provider request on — §14, C78 (#221).

---

## 16. Analytics: result identity, and the figures read against it

Added by C68 (#195). §14 previously said analytics was undecided; this section is the decision.

### 16.1 What the provider actually offers

From the same OpenAPI document as §7.2 (`GET https://api.post-bridge.com/reference`), read
2026-08-19:

| Route | What it takes | What it gives |
| --- | --- | --- |
| `POST /v1/analytics/sync` | optional `platform`, enumerated `tiktok`, `youtube`, `instagram`; *"Omit to sync all"* | nothing but a status. Documented `429`: *"Rate limited - please wait between syncs."* |
| `GET /v1/analytics` | `post_result_id` (repeatable, OR), `platform`, `timeframe`, `offset`, `limit` | `AnalyticsDto`: `view_count`, `like_count`, `comment_count`, `share_count`, `last_synced_at`, `share_url`, `platform_post_id`, `match_confidence` |
| `GET /v1/analytics/{id}/daily` | the analytics record id | `snapshots` — cumulative totals per `YYYY-MM-DD` — and `deltas`, the per-day gains |

**The document contradicts itself about coverage, and the contradiction is recorded rather than
resolved by preference.** Its `Analytics` tag reads "Currently supports TikTok"; the sync route
enumerates three platforms and names all three in its own summary. `shared/publish-analytics.ts`
takes the enum, because that is the half the API validates against and because the two mistakes are
not symmetrical: treating a platform as covered costs an empty answer, which the availability rule
below already has a state for, while treating a covered platform as uncovered hides figures that
exist.

### 16.2 The identity everything hangs on

`GET /v1/analytics` answers about a **post result**, not about a post and not about an account. So
`signal_publication_targets` gains `post_result_id`, captured by the reconciliation check — the only
call that reads `post-results` at all — and coalesced rather than assigned on write, because a later
response that omits it has said nothing about it. Two new tables carry the figures, keyed the way
the delivery they describe is keyed:

```sql
ALTER TABLE signal_publication_targets ADD COLUMN post_result_id TEXT;  -- post-results.id

CREATE TABLE IF NOT EXISTS signal_post_metrics (           -- current totals, one row per delivery
  publication_id TEXT NOT NULL REFERENCES signal_publications(id) ON DELETE CASCADE,
  provider_account_id INTEGER NOT NULL,
  post_result_id TEXT NOT NULL, analytics_id TEXT NOT NULL, platform TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0, shares INTEGER NOT NULL DEFAULT 0,
  share_url TEXT, provider_synced_at TEXT, synced_at TEXT NOT NULL,
  match_confidence TEXT, platform_post_id TEXT,        -- provenance, added by C79; never defaulted
  PRIMARY KEY(publication_id, provider_account_id)
);
CREATE TABLE IF NOT EXISTS signal_post_metric_days (       -- normalized cumulative snapshots
  publication_id TEXT NOT NULL REFERENCES signal_publications(id) ON DELETE CASCADE,
  provider_account_id INTEGER NOT NULL, date TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0, likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0, shares INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(publication_id, provider_account_id, date)
);
```

Additive, so an existing database gains one nullable column and two empty tables. Only the
snapshots are stored; the provider's `deltas` are a subtraction between consecutive snapshots, and
`postMetricDayDeltas` does it on read rather than keeping an answer beside its own derivation.

### 16.3 Four states, and never a zero

`postMetricAvailability` answers per delivery, in this order, because the order is the difference
between an honest sentence and a wrong one:

1. `NOT_AVAILABLE` — the platform is not one of the three. It reuses the publishing contract's own
   sentence, **Not available from this provider**, because it is the same claim about the same
   provider. No `totals` field at all, so nothing downstream can render it as `0`.
2. `AWAITING_RESULT` — no `post_result_id` yet, so there is nothing to ask about. Refreshing the
   delivery is what fixes it, and the panel says so.
3. `AWAITING_SYNC` — measured, asked about, and the provider has nothing yet.
4. `AVAILABLE` — the provider's four numbers, with its own `last_synced_at` beside them.

**And never a default, which is the same rule applied to provenance.** C79 (#222) stores the two
fields `AnalyticsDto` carries beside the counts — `match_confidence` and `platform_post_id` — as
nullable columns on `signal_post_metrics`. Both are the provider's claim about *which content a
record is about*, and neither is a claim about the counts:

- **The name is the trap.** `match_confidence` reads like a margin of error on the four numbers. It
  is the provider's confidence that this analytics row matches this piece of platform content. The
  panel therefore says **Provider match: Exact**, never *Confidence: Exact*, and prints one sentence
  beside it saying that match quality does not qualify or discount the counts.
- **The values are documented and unverified.** §7 of `post-bridge-api-surface.md` reads `exact` and
  `high` out of OpenAPI, and §14's analytics table records the live values as *still unverified* —
  the probe found no analytics rows to observe. So the parser enforces a **shape**, not an enum:
  `[a-z0-9_-]{1,40}` is stored as the provider's own token, a value this build has words for gets
  them, and anything else is rendered as **Provider value: …** with its own icon. Nothing is trimmed,
  lower-cased, or coerced on the way in, because normalising an unrecognised value is exactly how one
  would end up wearing `Exact`'s label.
- **Absent is absent.** A record arriving without either field stores NULL and the panel shows no
  provenance line at all, which is the `totals` rule one field over: an absent claim is left absent
  rather than filled in. A row written before C79 is NULL for the same reason and reads identically.
- **A refused field is not a failed refresh.** A value in a shape this app will not store is dropped,
  the four counts are still written, and the parser's bounded warning is recorded on the
  `signal.analytics-sync` log row. The parser is `server/publish/post-bridge-analytics-wire.ts`, pure
  and covered, beside the inventory's for the same reason.
- **The identifier is text, never a link.** `share_url` is the address the provider gave and stays
  the only link on the row; assembling a URL per platform out of an id would be this app inventing an
  address nobody supplied.

### 16.4 The boundaries

- **A separate interface.** `AnalyticsProvider` (`server/publish/analytics-provider.ts`) has
  `sync`, `list`, and `days` and nothing that could publish, reschedule, or withdraw a post.
  `SignalProvider` gains nothing: it still has no write method, and the analytics service does not
  import it. `PostBridgeProvider` and `PostBridgeAnalyticsProvider` share one HTTP helper — one
  bearer token, one reading of a `429` — and nothing else.
- **On-demand only.** `PublishAnalyticsService.read` makes no provider call, so the planner shows
  stored figures the moment a post is opened; `refresh` is the only method that reaches Post Bridge
  and only a button press calls it. There is no timer and no background job on this path.
- **A failed refresh cannot overwrite a good value.** Every provider read happens before any write,
  the writes land in one transaction, and only the results the provider actually named are written.
  A refusal, a network failure, or a daily-snapshot read that fails leaves the last known good
  values exactly where they were, and the panel keeps showing them beside the reason.
- **Backoff is bounded and grows.** A `429` records a wait equal to the longer of the provider's
  `Retry-After` and §9's own backoff for this attempt — base 1 s doubling per consecutive refusal,
  capped at 60 s, full jitter, bounded at five. Waiting longer than asked never breaks a limit;
  waiting less does. Nothing is retried before the wait passes, and at the bound the app reports the
  refusals rather than refusing a person their next attempt.
- **One log row per refresh**, `signal.analytics-sync`, `PARTIAL` when the provider had figures for
  some deliveries and not others.

### 16.5 What this section does not decide

Automatic analytics refresh of any kind; anything derived from a figure — engagement rates,
per-follower ratios, campaign roll-ups, comparisons between posts; `video_description` and
`duration`, which are read past rather than stored — `platform_post_id` and `match_confidence` were
too, until C79 stored them as provenance in §16.3; and any write to `signal_posts` from this path,
which stays impossible rather than merely unimplemented.

The `timeframe` and `platform` filters were on that list until C80, which is §16.6.

### 16.6 The provider-filtered window, and the gate it ships behind

A second question, asked of the same endpoint: **what does the provider report for one platform over
one of its own windows.** One request rather than a walk over every delivery, which is the whole
reason it exists.

**It is not a replacement for §16.3 and cannot become one.** `AnalyticsProvider.list(postResultIds)`
and `signal_post_metrics` are untouched. A window read writes only
`signal_analytics_window_metrics`, keyed `(platform, timeframe, post_result_id)`, and the two stores
may legitimately disagree — the provider chose which deliveries a window names, and this app chose
which deliveries a per-post refresh asked about. A fifth provider interface,
`AnalyticsWindowProvider`, has one method and that method lists, so nothing on this path can reach
`analytics/sync`, a post, a publication, a target, or a per-delivery figure.

**A snapshot is replaced whole or not at all.** Every page is read before the first statement runs,
under the pagination rule `shared/provider-inventory.ts` already holds — §14's question 4 recorded
that this endpoint answers the same `meta` envelope as `GET /v1/posts`, so it is one rule and not a
second copy. A refusal, an unreadable page, a token that does not advance, or a safety bound leaves
the whole prior generation in place. The outcome is `SUCCESS` or `FAILURE` and never `PARTIAL`.

**The one derivation is addition**, over a delivery set the panel names, and every group reports
`measuredDeliveries` beside `deliveries`. A group with nothing measured carries no `totals` field
rather than a row of zeros — §16.3's distinction carried up to an account. No rate, average,
normalisation, or follower comparison; those still belong to a card that decides what they mean.

**A row the provider named that no local delivery claims is unmapped**: stored, counted, shown, and
never attributed to an account. It is information rather than a fault, which is why a snapshot
carrying one is still a `SUCCESS`. A row arriving with *no* `post_result_id` is a different matter
and fails the whole read — §14 records the response grain as unverified, so a row that cannot be
attributed might be an account aggregate, and storing it would present one as a window.

**No window is offered, and that is the shipped behaviour.** §14 records the `timeframe` semantics,
the response grain, how a row maps to an account, and the rate-limit contract as *still unverified*,
each concluding *"C80 stays blocked."* `ANALYTICS_WINDOW_EVIDENCE` in
`shared/publish-analytics-window.ts` is the gate: it verifies nothing today, so the panel offers no
window, explains why in place of the control, and the service refuses an unverified window before any
request is built. Turning one on is one entry in that table plus the dated §14 row it cites — the same
construction `ANALYTICS_MATCH_CONFIDENCE_LABEL` uses for match values and `publishRoleDelivers` for
media roles.

**What would settle it.** A single read-only `GET /v1/analytics?platform=&timeframe=` against an
already-sent post, needing no live write. The precondition did not exist when the probe last ran —
§14's own note is that these claims wait on *"a post published from the connected Instagram account
that the provider has counted"* — and as of 2026-08-23 it does: a delivery published 2026-08-21 is
counted, carries a `platform_post_id`, and reports a `match_confidence`. So these rows moved from
*unaskable* to *askable and unanswered*. The read stays owner-run and out of CI, because no automated
test may contact the real provider, and nothing here changes until a dated §14 row records what came
back.

---

## 17. What stays unbuilt, why, and what would reopen it

The research note lists more than this plan builds. Without a record of what was declined and on what
grounds, the next reader re-litigates all of it — which is what §10 of the note already says about
`use_queue`, and the reason that paragraph exists. This section is that record for everything else.

**Every entry has three parts: what it is, why it is not built, and the concrete thing that would
reopen it.** The third part is not decoration. An entry with a reason and no trigger is a preference
rather than a decision, and a preference is exactly what gets re-argued. Where the trigger is *new
provider evidence*, it names the read that would produce it.

**This is a register of declines, and nothing in it describes a shipped capability.** Where a card
shipped a narrower thing than the note imagined — a fail-closed flag, a caption-written disclosure, a
role that is composable but not delivered — the entry says which half shipped, because a register
that quietly reclassified working behaviour as unbuilt would be worse than no register.

### 17.1 The contract snapshot these entries are dated against

- **Post Bridge**, OpenAPI 3.0.0, read 2026-08-19 and recorded as §§1–13 of
  [`post-bridge-api-surface.md`](post-bridge-api-surface.md). Documentation rather than observed
  behaviour.
- **Two live probe sessions**, 20 and 22 August 2026, recorded as §14 of the same note. That matrix
  is generated by `scripts/probe-post-bridge/report.ts` and a dated run replaces it wholesale, so
  nothing here hand-edits it; entries below cite it and do not amend it.
- **The provider account cap**, observed 22 August 2026: Post Bridge will not hold TikTok and YouTube
  at the same time as the five accounts this studio publishes on. A standing constraint rather than a
  current arrangement.
- **Buffer**, published GraphQL contract read 23 August 2026 (`developers.buffer.com`), including the
  public roadmap as it stood 22 August 2026. Documentation rather than observed behaviour, and no
  Buffer code exists here — Wave 15 is where that would start.

**What "as of" means in every entry below.** A provider fact is a dated observation, not a permanent
property of the world. *Absent from the contract read on this date* is a claim about that document on
that date and about nothing else; it is not a claim about every future version, and an entry that
reads as though it were should be treated as a defect in this section rather than as a decision.

### 17.2 Agent-driven posting through a provider's own MCP server

**Consuming a provider's MCP server buys nothing here.** The REST client already exists, and an MCP
transport in front of it would be a second way to make the same calls. The consequential direction is
the opposite one: **an agent writing to a provider directly bypasses `plan.ts`, the capability
matrix, the preview, and the confirmation**, and produces exactly the orphan posts C78 (#221) exists
to detect.

This is not a fact about one vendor. Post Bridge's server is §9 of the note; Buffer carries the same
surface — `ConnectedAppCategory.mcp` (28 July 2026) and `ConnectedApp.scopes` on `Account`
(4 August 2026), with expanded analytics capabilities within MCP listed under *Exploring* on the
roadmap read 22 August 2026. The risk belongs to the write path on **any** provider, so the entry is
written once rather than per vendor.

**The architecture-preserving shape, if agent-driven posting is ever wanted, is the inverse: expose
_Signal_ over MCP.** An agent then plans into SQLite, and the existing submit path stays the only road
out to any provider — which keeps the source of truth where the README puts it and gives an agent the
same refusals a person gets, including the capability refusals and the confirmation step.

**C78 is the prerequisite either way**, and it shipped. Whether an agent writes through a provider or
through Signal, a post this app did not make has to be visible before anything acts on one.

**Revisit when** agent-driven posting is actually wanted. The card that follows exposes Signal; it is
not a card that consumes a provider's MCP server.

### 17.3 Post-level fields the adapter reads, or the contract documents, and never sends

- **`is_draft`.** Read already — `recordState` treats it as winning over `status`, which is correct —
  and never sent. It is a plausible backing for the _manual finish waiting on you_ alert queue health
  already derives, because the post would exist provider-side without being scheduled. **Nobody has
  made that decision**, and this entry exists to say so rather than to imply it was rejected.
  **Revisit when** a card decides what a provider-held draft means for planning status, which is the
  hard half: §6's two meanings do not currently have a third state between them.
- **`processing_enabled`.** Real, documented, defaults to `true`, and setting it `false` skips video
  processing entirely. There is no reason here to send it. **Revisit when** a delivery is found that
  is worse for having been processed, which nobody has observed.
- **`use_queue`.** Declined in §5.4 and re-examined in §10 of the note, which found nothing that
  changes it: it cannot be combined with `scheduled_at`, and this app always has an explicit instant
  computed from the pair a person set. Recorded a third time so it is not re-litigated a fourth.
  **Revisit when** Signal stops being authoritative for _when_ — which is a change to §5.7, not to
  this field.

### 17.4 Platform configuration fields that exist and are unused

The adapter emits four: `caption`, `first_comment`, `title`/`document_title`, and
`placement: "story"`. §8 of the note enumerates ten platform configuration objects. Everything in the
table below is real in the contract and unsent by this app as of the snapshot in §17.1.

| Platform | Real, and not sent |
| --- | --- |
| **TikTok** | `privacy_status`, `allow_comment`, `allow_duet`, `allow_stitch`, `is_aigc`, `draft`, `auto_add_music` (photo posts only), `video_cover_timestamp_ms` — and the two disclosure toggles, which are §17.6 |
| **Instagram** | `collaborators`, `user_tags`, `is_trial_reel` + `trial_graduation`, `video_cover_timestamp_ms` — and `cover_image`, which is §17.6 |
| **Google Business** | `cta_action_type`, `cta_url`, `language_code` |
| **Pinterest** | `board_ids`, `link`, `title`, `video_cover_timestamp_ms` |
| **YouTube** | `contains_synthetic_media` and `thumbnail`, both §17.6 |
| **Threads** | `location` (`reels`/`timeline`) |
| Every platform | `media` — a per-platform media override, ids only |

**`placement: "story"` is not in that table**, and the note's §8 row for Facebook is stale on this
point: `post-bridge-wire.ts` sends the placement wherever the capability table records a story, and
C81 (#224) locked the verified Facebook case behind regression coverage. It shipped.

Three of the unused fields are worth naming rather than leaving in a row:

- **Google Business `cta_action_type` + `cta_url`.** Signal already carries a CTA per post, and
  Google Business is the one platform where the provider takes it as a real button rather than as
  text in the caption. It is unreachable for a different reason than the others — there is no Signal
  channel for it at all (§17.5) — so the field is the second problem, not the first.
- **Instagram `collaborators`.** A co-author sees the post on their own profile and shares its likes,
  which makes it the one unused field that changes who a post belongs to rather than how it looks.
  **Revisit when** collaborator posting is planned content rather than a field somebody noticed.
- **Per-platform `media`.** An override taking ids only, which means it depends on the upload
  boundary C75 drew and on media ids this app deliberately does not persist (§17.8).

**Revisit any row** when content is planned that needs it. A field is not built because it exists;
that is the rule this whole section is downstream of.

### 17.5 Provider platforms with no Signal channel — two of them, not three

**Google Business and Pinterest.** Both are in `PUBLISH_PLATFORMS`, both are reachable by the
provider, and neither has a Signal channel that could target them.

**Threads is not in this entry, and the plan's C82 card is wrong to list it.** `th` is a Signal
channel in `SIGNAL_CHANNELS` and maps to `threads` in `SIGNAL_CHANNEL_PLATFORM`; Threads is one of
the accounts the 22 August 2026 read found connected. Its unused `location` field is an §8 row
(§17.4), which is an ordinary unused field rather than a missing channel. Recording the card's three
verbatim would have contradicted the capability table, so this register records two.

**A channel exists because content is planned for it**, not because a provider can reach it. Adding
one is a card of its own — schema, presets, treatments, composer, and every fixture that enumerates
channels — and not a field. **Revisit when** content is actually planned for Google Business or
Pinterest, at which point the CTA fields above become part of that card rather than a separate one.

### 17.6 Media roles and disclosure fields the probe did not settle

**YouTube `thumbnail` — will-not-build, and now for a firmer reason than when C76 decided it.**
OpenAPI names the field; current Post Bridge support material says custom external YouTube thumbnails
are not available. That contradiction was never resolved positively, so C76 (#219) left
`thumbnail: false` in the capability table and the role composable but never delivered. Buffer's
contract, read 23 August 2026, has **no thumbnail field at all** — only
`VideoAssetInput.metadata.thumbnailOffset`, which selects a frame from the video rather than
uploading an image. Absent from one contract and contradicted in the other is a firmer disposition
than either alone. **Revisit only on new provider evidence**: a dated §14 row observing the field
accepted and read back, or a Buffer contract that adds an image thumbnail.

**Instagram `cover_image` — unverified, not declined.** §14 records it as askable: it needs the
connected Instagram account and a probe run with `--video`. `coverImage: false` today is fail-closed,
not a decision. **Revisit when** a probe run with a video settles it, which is scheduling rather than
a blocked precondition.

**YouTube `contains_synthetic_media` and TikTok `disclose_branded_content` / `disclose_your_brand` —
unreachable through Post Bridge while the account cap holds, and that is a fact about which accounts
one provider will hold at once rather than about the capability.** Settling them through Post Bridge
would mean evicting the five accounts this studio publishes on, which is not a trade available to
anyone, so §14 records them as unanswered by construction rather than by scheduling.

The capability is not the problem. Buffer's `YoutubePostMetadataInput` and `TikTokPostMetadataInput`
both carry **`isAiGenerated`** (added 30 June 2026) — on the exact two channels the cap pushed to
Buffer — and Buffer's roadmap, last updated 22 August 2026, lists **TikTok Content Disclosure
Settings** as _In Progress_, covering AI-generated content, promotional content, and paid
partnership. **Revisit with Wave 15**: if Buffer becomes the delivery path for those channels, the
disclosure control is a C86 metadata field rather than a declined item. Nothing is sent on either
Post Bridge field until a dated §14 row says otherwise.

**What ships today, so this entry is not misread as an absence of disclosure.** C81 (#224) kept the
unverified controls fail-closed and clarified that a disclosure control alone cannot guarantee
compliance. `syntheticMediaDisclosure` is `IN_CAPTION` for all ten platforms in the capability table,
which means a disclosure a person sets is written into the caption where a provider flag would
otherwise carry it. The declined thing is the provider field, not the disclosure.

### 17.7 Mixed media sources in one post

**Refused at preview, by construction.** `PublishRequest` is a discriminated union carrying either
`mediaUrls` or `mediaIds` and never both, and a mixed-source post names the offending items and
offers the two valid resolutions rather than reconciling them. C75 (#218) drew that line.

**The reason is what resolving it would cost**: the only way to accept both in one request is for the
server to fetch an arbitrary public URL and upload the bytes, and a server that fetches arbitrary
URLs on a user's say-so is a different security posture than this app has. **Revisit when** somebody
wants server-side fetching of arbitrary URLs and is deciding that on its own merits — host policy,
redirect policy, timeouts, size bounds — rather than acquiring it as a side effect of a media card.

### 17.8 Endpoints in the contract this app does not call

- **`GET /v1/analytics/{id}`, `GET /v1/post-results/{id}`, `GET /v1/social-accounts/{id}`.**
  Marginal. The filtered list in each case already carries the row, so a by-id read would be a second
  way to fetch something the app has. **Revisit when** a caller needs a field the list omits, which
  no card has needed yet.
- **`GET /v1/media`, `GET /v1/media/{id}`, `DELETE /v1/media/{id}`.** Not marginal in the same way —
  they are unreachable by design. C75 uploads immediately before create, update, or resubmit and
  **never persists a media id as a reusable Signal reference**, re-uploading every time instead. With
  no stored id there is nothing to fetch by id and nothing to delete by id, and provider-created
  leftovers are reported as ephemeral assets rather than managed. **Revisit when** a card decides a
  media id is a durable reference — which is the decision C75 declined, and reopening it reopens the
  24-hour expiry question with it.

### 17.9 No webhooks in either reviewed contract

**Post Bridge**: §12 of the note records no webhooks in the OpenAPI document read 2026-08-19.
**Buffer**: no webhooks and no third-party OAuth in the contract or on the roadmap as of 22 August
2026. So the polling and person-pressed refresh design holds across both providers rather than by
coincidence on one, which is worth stating because a second provider is the obvious place someone
would expect push to arrive from.

**Revisit when** a dated official API specification or a support announcement adds a webhook
contract, on either provider. Absence today is not a claim about every future version — see §17.1.

### 17.10 What adding a second provider would not fix

**Buffer does not close the TikTok and YouTube figures hole the account cap opens.** The natural
assumption is that it does, and this is where that should be read before a wave is spent discovering
it:

- Buffer's post-metrics guide lists Instagram, Twitter, Mastodon, Threads, Facebook, LinkedIn, and
  Pinterest. **TikTok and YouTube are not listed.**
- Buffer measures only posts Buffer sent, so it cannot measure the five accounts publishing through
  Post Bridge either.

The two measured sets miss each other exactly across the gap. Post Bridge measures `tiktok`,
`youtube`, and `instagram` and will only ever see Instagram from here while the cap holds; Buffer
measures seven services but only for its own posts, which are TikTok and YouTube — the two it does
not measure.

**One qualification, which is why this is written as a probe result rather than a flat statement.**
Buffer's `PostMetricType` enum restructured on 9 June 2026 and includes `views`, `watch time`, and
`viewers`, which are video-native, and neither the reference nor the metrics example enumerates which
services each type applies to. **A single read-only query against an already-sent post settles it**,
needs no live write, and is proposed as a branch of C83's read-only probe (#257). **Record the dated
result here either way** — a confirmed absence is as much a result as a surprise.

**If it turns out Buffer does carry figures for those channels**, `aggregatedPostMetrics` takes
`organizationId`, a date range capped at 365 days, `channelIds`, and **`tags`** — which is the shape
`shared/signal-campaign-analytics.ts` already has, because Signal campaigns are Buffer's tags. That
is a card of its own and not a widening of any card here.

### 17.11 Buffer's legacy REST API

**Retires 1 February 2027.** Relevant here only as the reason nothing should be built against it: the
GraphQL API is the contract, and any Buffer work starts there. A dated fact recorded once so that a
tutorial or an answer written against the old API does not quietly become somebody's starting point.
**Revisit** never — this entry expires on its own date.

### 17.12 Analytics fields read past and stored by nothing

`duration`, `platform_created_at`, `cover_image_url`, and `video_description` arrive on `AnalyticsDto`
and are read past. They are recorded as real and unused rather than as missing.

C79 (#222) took the other two — `match_confidence` and `platform_post_id` are stored as nullable
provenance and shown beside the counts, so they are **not** in this entry. **Revisit when** a card
decides what one of the four would say on screen; §16.3's rule that a figure is never shown without
being able to stand behind it is the constraint such a card inherits, and `video_description` in
particular is provider-side text this app did not write.
