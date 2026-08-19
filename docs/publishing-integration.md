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

---

## 1. The decision

**Post Bridge ships first in this app, behind one interface, `PublishProvider`.** One provider, one
implementation, one mock. There is no adapter layer, no provider registry, no dual-write, and no
runtime switch between vendors. If Post Bridge is ever replaced, the replacement implements the
same interface and the old implementation is deleted in the same branch.

The working artifact reaches Post Bridge through a claude.ai MCP connector. That transport is a
constraint of an artifact running inside claude.ai, not a reusable application boundary. This
local Node server can and will use `POST_BRIDGE_API_KEY` against `api.post-bridge.com/v1` directly,
so the original transport decision stands. A separate local Buffer Bridge is also in use for three
channels Post Bridge cannot reach for this account; it remains a separate tool, with no overlapping
accounts, and
does not turn this app into a multi-provider publisher (section 2).

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

The 2026-08-13 artifact review confirmed that the second trigger below has already fired for the
broader publishing setup: a separate local **Buffer Bridge** publishes three channels Post Bridge
cannot reach for this account, and no account overlaps Post Bridge. That fact does **not** reopen
this app's provider
choice. The bridge stays one local tool and its transport and credentials stay outside this
implementation. It does mean this record no longer claims Post Bridge is the only publishing path
in use.

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
place, the first publisher can plan all **seven** Signal social channels:

| Signal channel | Post Bridge platform | First release |
| --- | --- | --- |
| `x` | `twitter` | publishes when its text and media pass preflight |
| `fb` | `facebook` | publishes only to the `G.Holmes Designs` page (section 3.1) |
| `li` | `linkedin` | publishes when its text and media pass preflight |
| `bsky` | `bluesky` | publishes when its text and media pass preflight |
| `ig` | `instagram` | publishes with required supported media |
| `tt` | `tiktok` | publishes with required supported media |
| `yt` | `youtube` | publishes with exactly one video |
| `blog` | *(none)* | never published; see §10 |

The planner carries the artifact's complete platform capability table and preflight rules rather
than treating media as present-or-absent. That table is `shared/publish-capabilities.ts` and §3.2
below is its contract. An over-limit caption blocks `twitter` and `bluesky` and warns elsewhere.
**Post Bridge requires a caption on every submission, including media-only platform formats**, so
an empty effective caption is always a refusal even when the target platform visually emphasizes
only the media — a provider-wide rule, which is why it is a plan-level refusal in `plan.ts` rather
than a field on a platform.

Post Bridge also reaches `pinterest`, `threads`, and `google_business`. Signal has no channel for
them and the mapping is not extended to invent one — a channel exists because content is planned
for it, not because a provider supports it. The capability table still answers for all ten, because
the contract is about what the provider can do and a channel is about what is planned.

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
| Cover images and thumbnails | `coverImage`, `thumbnail` | False everywhere; the platform picks its own, and a reel says so in the preview |
| Synthetic-media disclosure | `syntheticMediaDisclosure` | `IN_CAPTION` everywhere: no provider flag exists, so a disclosure is written into the caption |
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
only is a limit met after pressing send. `coverImage` and `thumbnail` are false on every platform,
so a cover and a thumbnail are offered nowhere — the field is in the model and refused at the
boundary, and a contract entry that recorded one would be offered it without another edit here.

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

**A synthetic-media disclosure is written into the caption**, because
`syntheticMediaDisclosure` is `IN_CAPTION` on every platform the contract answers for. The
disclosure sentence is appended once, the preview shows the caption with it already in it, and the
caption limit is measured against that text — a disclosure that pushes X past 280 has to refuse
before the send rather than after. A platform recording `PROVIDER_FIELD` would carry the flag
instead and nothing would be appended.

**A placement is a shape, not a decoration.** An override sets the `PublishPostKind` the platform
submits as, so a story meets a story's media bounds and warns that its caption reaches no reader.
Only a story is sent as a provider `placement`: a reel is one video in the platform's ordinary post
(§3.2), so choosing it changes what preflight accepts and sends no placement field, which is what
the source records and all it records.

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

- Images load with the preview, at a constrained size — a preview is for checking the order and the
  crop, not for downloading a campaign asset at full resolution.
- **A video never autoplays.** It is not fetched by the preview at all: it takes its own press, and
  even then it arrives with controls rather than playing. There is no `autoplay` attribute anywhere
  in the module to be flipped later.
- Broken media gets a usable fallback — what happened, the address, and a link — rather than a gap.
- A PDF and an extensionless URL are named as what they are and never embedded.
- `referrerPolicy="no-referrer"` is set on the elements HTML defines it for. A `<video>` cannot
  carry it, so the app's `Referrer-Policy: no-referrer` response header is what covers that request;
  `server/app.test.ts` asserts the header rather than trusting an attribute that would be ignored.
- **`media-src` gains `https:` in the production CSP.** This is the one browser-visible change the
  publisher makes, and it corrects §12's "nothing changes in the browser": rendering a video the
  post already references needs the directive to permit the host, which is not known in advance —
  the same reason `img-src` already permits one. No other directive widens.

**The server still fetches nothing.** It does not fetch a media URL, a cover, a thumbnail, or
anything else a preview names, and `server/publish/publish.test.ts` proves it by replacing `fetch`
with a spy for the duration of a preview and asserting it was never called. The rule recorded on
`signal_post_media` — this app never uploads, downloads, or proxies media — is not relaxed by this
card, and a preview is the last place it should be.

### 3.1 The Facebook account rule

Three Facebook pages are connected in the broader publishing setup: `AdDrive Media`,
`G.Holmes Designs`, and `Wild Eye Photography`. **Only `G.Holmes Designs` may receive this
campaign's work.** Target resolution matches that account by stable provider identity and verified
handle, refuses zero or multiple matches, and never silently falls back to either of the other
pages.

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

Additive, in the style of the existing tables — an existing database gains two empty tables and two
indexes.

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

Named so an implementation card does not assume otherwise: media uploading or storage; the planner
UI beyond the confirmed submit flow and publication state; analytics — Post Bridge's
`/v1/analytics` exists and this app has no use for it yet; multi-workspace or per-client API keys;
publishing anything that is not a Signal post; Buffer Bridge transport or credentials; and any
second provider inside this app.

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
