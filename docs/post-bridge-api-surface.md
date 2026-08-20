# Post Bridge — Tool Surface and Untapped Integrations

**Findings, 19 August 2026.** What Post Bridge actually offers, what
[`server/publish/post-bridge.ts`](../server/publish/post-bridge.ts) currently uses, and what is left
on the table.

This is a research note, not a decision record. The decisions this app has already made about
publishing live in [Publishing Integration](publishing-integration.md); where a finding here
contradicts one of them, it says so and names the section, but it does not overturn it. Nothing in
this document has been built.

**§3–§12 are read out of the OpenAPI document, which proves vocabulary rather than behaviour.**
§14 is the other kind of evidence: a dated matrix of what a live probe against real connected
accounts actually observed, written by
[`scripts/probe-post-bridge.ts`](../scripts/probe-post-bridge.ts) rather than by hand. A field
appearing above and standing at **still unverified** below has not been established, and the cards
that depend on it stay blocked.

## 1. How this was established

The support site at <https://support.post-bridge.com/> carries **one** API article — access, the
`$5/month` add-on, a Discord link, and a pointer to the reference. It documents no endpoints, no
authentication detail, no rate limits, and it does not mention the MCP server at all.

The real contract is the OpenAPI document behind <https://api.post-bridge.com/reference>. That page
is a Scalar single-page app, so fetching it returns a shell; the spec (`openapi: 3.0.0`,
NestJS-generated) is inlined in the page as an HTML-escaped script body and was extracted from there.
Every endpoint, parameter, enum, and field description in this document comes from that spec.
Anything sourced elsewhere is marked **unverified**.

## 2. Three surfaces, one platform

| Surface | Endpoint / install | Auth |
| --- | --- | --- |
| REST v1 | `https://api.post-bridge.com/v1` | `Authorization: Bearer pb_live_…` (`http`/`bearer`, `JWT` format) |
| Hosted MCP server | `https://www.post-bridge.com/api/mcp/mcp` — 13 tools | OAuth 2.0, or the same `pb_live_` bearer |
| `agent-mode` skill + CLI | `npx skills add post-bridge-hq/agent-mode`, `npx postbridge-cli` | `POST_BRIDGE_API_KEY` |

All three reach the same platform and all three require the `$5/month` API add-on. The MCP endpoint,
its tool count, and the CLI are **unverified** — they come from the vendor's marketing page and the
`agent-mode` README; `https://www.post-bridge.com/mcp` answered `429` when fetched, so the per-tool
list has not been read.

**The spec declares no `webhooks`.** Polling is the only mechanism the API offers. The
refresh-when-pressed design in §9 and §16 of the decision record is therefore the correct shape, and
there is no push upgrade to migrate to later.

## 3. Every endpoint, and whether this app calls it

Seventeen operations across seven tags (`Auth`, `Getting Started`, `Media`, `Posts`,
`Social Accounts`, `Post Results`, `Analytics`). Nine are used.

| | Operation | Used | Where, or why not |
| --- | --- | --- | --- |
| **Posts** | `POST /v1/posts` | yes | `submit` |
| | `GET /v1/posts/{id}` | yes | `check`, `describe` |
| | `PATCH /v1/posts/{id}` | yes | `update` — always sends `scheduled_at` (§7.2) |
| | `DELETE /v1/posts/{id}` | yes | `cancel` — the vendor `400`s a published post |
| | `GET /v1/posts` | **no** | **§6 below.** `?offset`, `?limit`, `?platform[]`, `?status[]` |
| **Post Results** | `GET /v1/post-results?post_id=` | yes | `check` |
| | `GET /v1/post-results/{id}` | no | Marginal — the list already carries the row |
| **Social Accounts** | `GET /v1/social-accounts` | yes | `listTargets`, `limit=100` |
| | `GET /v1/social-accounts/{id}` | no | Marginal. Note `?platform[]` and `?username[]` on the list |
| **Analytics** | `POST /v1/analytics/sync` | yes | No `platform` filter, deliberately (§16) |
| | `GET /v1/analytics?post_result_id=` | yes | `list` |
| | `GET /v1/analytics/{id}/daily` | yes | `days` — keeps `snapshots`, drops `deltas` |
| | `GET /v1/analytics/{id}` | no | Marginal — the filtered list covers it |
| **Media** | `POST /v1/media/create-upload-url` | **no** | **§5 below** |
| | `GET /v1/media` | no | `?post_id[]`, `?type[]` (`image`/`video`) |
| | `GET /v1/media/{id}` | no | |
| | `DELETE /v1/media/{id}` | no | |

`limit` defaults to **10** on every paginated endpoint. Every list returns
`meta: { total, offset, limit, next }`.

The endpoints matter less than the request fields. What follows is ordered by what it would unlock,
not by how much work it is.

## 4. `account_configurations` — the per-account limit is gone

**This contradicts a stated decision, and is the first thing to verify.**

[`provider.ts`](../server/publish/provider.ts) says, of `PublishPlatformConfiguration`:

> Per platform and not per account, which is the provider's own shape: `platform_configurations` is
> keyed by platform, so an account override arrives as its platform's configuration and the plan
> refuses rather than guessing when two accounts on one platform disagree.

The spec no longer bears that out. `CreatePostDto` and `UpdatePostDto` both accept
`account_configurations` alongside `platform_configurations`, and `AccountConfigurationDto` is:

| Field | Type | Note |
| --- | --- | --- |
| `account_id` | `number` | **required** — the social account to override |
| `caption` | `string` | caption for that account alone |
| `media` | `string[]` | media ids for that account alone |

The `Posts` tag describes three resolution levels explicitly: post default, platform override,
account override — most specific winning per platform and account.

So `plan.ts`'s refusal when two accounts on one platform disagree is working around a constraint the
vendor does not impose. Closing this would make the README's "tailor a post per platform and per
account" true at the wire rather than only in the planner, and it is the only item here that removes
a refusal rather than adding a capability.

Two things it does **not** give: no `title`, `first_comment`, or `placement` at account level — those
stay per platform; and `media` is ids only, so a per-account *image* also depends on §5.

## 5. The media upload pipeline

The adapter sends `media_urls` only, so every asset must be publicly reachable — which is why Signal
records "ordered public media references". The upload flow is three steps:

1. `POST /v1/media/create-upload-url` with `{ name, mime_type, size_bytes }` — all three required.
   `mime_type` is a closed enum: `image/png`, `image/jpeg`, `video/mp4`, `video/quicktime`,
   `application/pdf`.
2. `PUT` the bytes to the returned `upload_url`.
3. Pass the returned `media_id` in the post's `media` array.

`media_urls` **is ignored when `media` is provided** — they are alternatives, not a merge.

This one change unlocks four things at once:

- **Publishing straight from Drive**, with no public-URL requirement on the asset.
- **YouTube `thumbnail`** and **Instagram `cover_image`** — both take a `media_id` and nothing else.
  This is precisely why [`plan.ts:221`](../server/publish/plan.ts:221) has to warn that a reel
  "chooses its own thumbnail; this provider sends none" about the `thumbnailUrl` the variant editor
  already collects and `db.ts` already stores. The field is not missing from the provider; it is
  unreachable without an upload.
- **LinkedIn PDF documents** — `application/pdf` is in the enum, and `document_title` (already sent)
  is the field that titles one.
- **TikTok photo posts and Pinterest pins** where the source is a local file.

**The lifecycle is the design constraint.** Per the `Media` tag, an asset is deleted when its post
publishes, after 24 hours if attached to nothing, and when a scheduled post is deleted. A `media_id`
is therefore not a durable reference: upload has to happen at submit time, and a stored id cannot be
assumed to still resolve. A re-submit after a failure re-uploads.

## 6. `GET /v1/posts` — drift and orphan detection

`describe` answers *what does the provider say about this id*. Nothing answers *what else is in
there*. A post created in the Post Bridge UI, by a VA (the support site documents VA access), or by
an agent over MCP is invisible to this app.

`GET /v1/posts?status=…&platform=…`, paged by `meta.next`, closes that. It fits the existing
`describe`/diff machinery in §7.2 — same four actions, same staleness rules — and it is the
prerequisite for §9 below rather than an independent feature.

## 7. Analytics filters and fields already being discarded

**Filters not used.** `GET /v1/analytics` takes `?platform` and `?timeframe` (`7d`, `30d`, `90d`,
`all`; defaults to `all`) in addition to the repeatable `?post_result_id`. Account-level performance
over a window is therefore one request, with no per-post refresh — a cheaper feed for Campaign
figures than walking every delivery.

`POST /v1/analytics/sync` takes `?platform` as `tiktok | youtube | instagram`, which also confirms
those three are the whole measured set — and that §16.3's "Not available from this provider" is
correct for every other channel.

**Fields on `AnalyticsDto` currently dropped.** `match_confidence` (documented as `exact` or `high`)
is provenance for a figure, and a natural fit for a §16.3 state that already refuses to show a number
it cannot stand behind. Also unread: `duration`, `platform_created_at`, `cover_image_url`,
`video_description`, `platform_post_id`.

## 8. Platform configuration fields never sent

The adapter emits four: `caption`, `first_comment`, `title`/`document_title`, and
`placement: "story"`. The spec defines ten platform configuration objects. Everything below exists
and is unused.

| Platform | Unused fields |
| --- | --- |
| **TikTok** | `privacy_status` (`public`/`private`), `allow_comment`, `allow_duet`, `allow_stitch`, `disclose_branded_content`, `disclose_your_brand`, `is_aigc`, `draft`, `auto_add_music` (photo posts only), `video_cover_timestamp_ms` |
| **Instagram** | `collaborators` (co-authors — the post appears on their profile and shares its likes), `user_tags` (people tagging), `is_trial_reel` + `trial_graduation` (`MANUAL`/`SS_PERFORMANCE`), `cover_image`, `video_cover_timestamp_ms` |
| **Google Business** | `cta_action_type` (`BOOK`, `ORDER`, `SHOP`, `LEARN_MORE`, `SIGN_UP`, `CALL`), `cta_url`, `language_code` |
| **Pinterest** | `board_ids`, `link`, `title`, `video_cover_timestamp_ms` |
| **YouTube** | `contains_synthetic_media`, `thumbnail` |
| **Threads** | `location` (`reels`/`timeline`) |
| **Facebook** | `placement: "story"` — sent already for Instagram, and applies here too |
| Every platform | `media` — a per-platform media override, ids only |

Three are worth naming individually:

- **Google Business `cta_action_type` + `cta_url`.** Signal already carries a CTA per post. Google
  Business is the one platform where the provider takes it as a real button rather than as text in
  the caption.
- **YouTube `contains_synthetic_media`.** `db.ts:165` has a `disclose_synthetic_media` column that
  never reaches the wire. The provider field it corresponds to exists.
- **TikTok's disclosure toggles.** `disclose_branded_content` and `disclose_your_brand` are platform
  compliance settings for paid partnerships, not styling. If client work is ever published through
  this app, they are the difference between a compliant post and a non-compliant one.

## 9. MCP — the risk is the write path, not the read

Consuming their MCP server from inside HCC buys little; the REST client already exists. The
consequential fact is the opposite direction: **an agent on their MCP server writes to Post Bridge
directly**, bypassing `plan.ts`, the capability matrix, the preview, and the confirmation — and
produces exactly the orphan posts §6 detects. If agent-driven posting is ever wanted, §6 stops being
optional.

The alternative that preserves this app's architecture is to expose *Signal* over MCP, so an agent
plans into SQLite and the existing submit path stays the only road to the provider. That keeps the
source of truth where the README puts it, and gives an agent the same refusals a person gets.

## 10. Two more post-level fields, and one to leave alone

- **`is_draft`** — creates a post the provider holds and does not process until it is updated. The
  adapter already *reads* it (`recordState`, where it correctly wins over `status`) but never sends
  it. It is a plausible backing for the "manual finish waiting on you" alert queue health already
  derives, since the post would exist provider-side without being scheduled.
- **`processing_enabled`** (default `true`) — set `false` to skip video processing entirely.
- **`use_queue`** — declined on purpose in §5.4, and nothing found here changes that. Recorded only
  so the next reader does not re-litigate it: it cannot be combined with `scheduled_at`, and this app
  always has an explicit instant.

## 11. Suggested order

1. **§4 `account_configurations`** — verify against the live API first. It corrects a documented
   assumption, and it is the only item that removes a refusal.
2. **§5 media upload** — the widest unlock, and a prerequisite for thumbnails, cover images, PDFs,
   and per-account media. Design around the 24-hour/on-publish deletion.
3. **§6 `GET /v1/posts`** — cheap, fits §7.2 as it stands, and the safety net for §9.
4. **§7 analytics filters** — new panels from endpoints already wired.
5. **§8 platform fields** — incremental. Google Business CTA and the TikTok disclosures first.

## 12. Constraints to carry into any of it

- **No webhooks.** Polling only. Nothing here changes §9.
- **`$5/month` API add-on**, separate from the subscription; API keys come from the dashboard.
- **`429` is documented on `POST /v1/analytics/sync`** specifically ("please wait between syncs"),
  which is the endpoint §9's authoritative-rate-limit rule was written for.
- **No idempotency key on any endpoint**, as §8 already records. Nothing found here changes that:
  `PATCH` remains idempotent by end state and `POST` remains unsafe to repeat.
- **`DELETE /v1/posts/{id}` `400`s** on anything that is not scheduled or draft.
- **Media `mime_type` is a closed enum** of five values. No GIF, no WebP, no AVI.
- **`scheduled_at: null` posts instantly** — on create as well as on update.

## 13. Sources

- [Post Bridge API — Overview, Access, and Pricing](https://support.post-bridge.com/api/post-bridge-api-overview-access-and-pricing)
- [API reference](https://api.post-bridge.com/reference) — the OpenAPI document behind §3–§8, §10, and §12
- [MCP — Use Post Bridge from AI](https://www.post-bridge.com/mcp) — unverified, `429` on fetch
- [`post-bridge-hq/agent-mode`](https://github.com/post-bridge-hq/agent-mode) — unverified
- [`xSAVIKx/post-bridge-mcp`](https://github.com/xSAVIKx/post-bridge-mcp) — unofficial, unverified

## 14. Live probe result matrix — 20 August 2026

Session ran with 29 of 50 allowed requests (12 of them reserved for teardown).

Four states, and no fifth: **verified**, **verified with policy constraint**, **negative**, and
**still unverified**. Its reviewed registry disposition remains authoritative: it
blocks dependent work unless that work has an explicit path that cannot rely on it.

### Fixtures

| Fixture | Type | Bytes | sha256 |
| --- | --- | --- | --- |
| `probe-image.png` | `image/png` | 136 | `808300be67e20c6559af29ba909bd89b4017e0501a08da7cc3f4140c4a8f2e8c` |
| `probe-cover.png` | `image/png` | 136 | `d68645118cc3dfc978f39d48c6069ffd4d2322fb96a73ba95d72d45735563fad` |
| `probe-document.pdf` | `application/pdf` | 622 | `8e93985f3ad7832828d8fc84e733372ec58ef43243c0faa92cbb42a70df437c9` |

### Teardown

- Posts created: 3; deleted: 3.
- Provider assets created: 3; deleted: 3.
- Independent inventory proof: **verified-absent**. A complete 1-page inventory read afterwards listed none of the 3 posts this run created.
- Leftovers: none.

### Question 1 — `account_configurations` and same-platform policy

| Claim | State | Evidence | Effect on the dependent cards |
| --- | --- | --- | --- |
| `POST /v1/posts` accepts `account_configurations` and stores a different caption for each of two explicitly approved accounts on one platform. | **still unverified** | No platform had two named accounts, so there was no same-platform pair to ask about. | C77 stays blocked. Today's fail-closed value is unchanged. |
| Which encoding `account_configurations` takes — a list of objects each carrying `account_id`, or a map keyed by account id. | **still unverified** | No platform had two named accounts, so there was no same-platform pair to ask about. | C77 stays blocked. Today's fail-closed value is unchanged. |
| The per-account `caption` and `media` read back unchanged through `GET /v1/posts/{id}`, after create and again after `PATCH`. | **still unverified** | No platform had two named accounts, so there was no same-platform pair to ask about. | C77 stays blocked. Today's fail-closed value is unchanged. |
| What the provider does about two accounts on one platform when the captions are materially different, and in what terms it states any restriction. | **still unverified** | No platform had two named accounts, so there was no same-platform pair to ask about. | C77 stays blocked. Today's fail-closed value is unchanged. |

### Question 2 — Upload flow and media lifecycle

| Claim | State | Evidence | Effect on the dependent cards |
| --- | --- | --- | --- |
| The `create-upload-url` request and response field names, and the signed `PUT`’s required headers and content-length behaviour. | **verified** | `POST /v1/media/create-upload-url` with `{ name, mime_type, size_bytes }` answered `{ media_id: string, name: string, upload_url: string }`. The signed `PUT` carried `Content-Type: image/png`, `Content-Length: 136`, and no `Authorization` header; it answered HTTP 200. The follow-up run repeated the successful PUT with redirects disabled. The transcript intentionally redacts the signed URL, so it does not establish a fixed upload hostname. Fixture sha256 `808300be67e20c6559af29ba909bd89b4017e0501a08da7cc3f4140c4a8f2e8c`. | C75 validates each provider-supplied HTTPS URL, refuses credentials, fragments, and redirects, sets explicit timeouts, and builds the three-step upload against the verified names and headers. |
| That the five documented `mime_type` values are the whole accepted set, and what the provider answers for a value outside it. | **verified** | `image/webp` was refused with HTTP 400: `mime_type` must be one of `image/png`, `image/jpeg`, `video/mp4`, `video/quicktime`, or `application/pdf`. | C74's type validation and C75's preflight use the verified set. |
| What `GET /v1/media/{id}` returns for an uploaded asset, and what `describe` says about media a post carries by id rather than by URL. | **verified** | `GET /v1/media/{id}` answered `{ id: string, mime_type: string, object: { isDeleted: boolean, name: string, size_bytes: number, url: string } }`. | C75 reconciles provider media ids where `describe` returns them. |
| That `media` wins and `media_urls` is ignored when one create request carries both. | **verified** | A create carrying `media` (one uploaded id) and `media_urls` (one unreachable URL) answered HTTP 201. The read-back's `media` was an array of one string, and the post was scheduled. | C75's discriminated `PublishRequest` matches the wire as well as the document, and a URL-only post serializes as it does today. |
| Whether `DELETE /v1/media/{id}` removes an uploaded asset that is attached to nothing. | **verified** | `DELETE /v1/media/{id}` removed all 3 provider assets this run created. | A probe run leaves no asset behind and C75 may state deletion as available. |
| The 24-hour unattached expiry and the deletion-on-publish the vendor documents. **A single session cannot answer this**: it needs a dated follow-up read of the inventoried asset ids. | **still unverified** | Every provider asset was deleted explicitly, so the documented 24-hour unattached expiry was never exercised. A deletion is not an expiry. | C75 may build without depending on this timing only by labelling it documented but unverified and recording every landed asset; the timing itself remains unavailable as a correctness guarantee. |
| The current per-file size, item-count, and video-duration limits that apply to the connected plan through the API. | **verified with policy constraint** | The live API refused an 8 GiB reservation with HTTP 400 and stated a 500 MB upload maximum. Current provider support material separately documents images at 8 MB each, 35 images, 500 MB total, and video duration from 3 to 300 seconds; the live probe did not independently exercise those other boundaries. | C74 validates against the verified bounds and C75 enforces them before a byte is read. The constraint recorded beside it is a preflight refusal, not a warning. |

### Question 3 — Media roles

| Claim | State | Evidence | Effect on the dependent cards |
| --- | --- | --- | --- |
| Whether a scheduled post accepts YouTube `thumbnail` as a provider media id and reads it back — against current support guidance saying custom external thumbnails are unavailable. | **still unverified** | No video asset was uploaded, and the role needs a video as the post's own media. | C76, C82 stay blocked. Today's fail-closed value is unchanged. |
| Whether a scheduled post accepts Instagram `cover_image` as a provider media id and reads it back. | **still unverified** | No video asset was uploaded, and the role needs a video as the post's own media. | C76 stays blocked. Today's fail-closed value is unchanged. |
| That an `application/pdf` asset plus the already-sent `document_title` reads back as a LinkedIn document post. | **verified** | `POST` accepted an `application/pdf` asset by id with `linkedin.document_title` (HTTP 201). The read-back's `platform_configurations` contained `linkedin.document_title`. Fixture sha256 `8e93985f3ad7832828d8fc84e733372ec58ef43243c0faa92cbb42a70df437c9`. | C76 verifies the existing path end to end rather than adding a role row. |

### Question 4 — `GET /v1/posts`

| Claim | State | Evidence | Effect on the dependent cards |
| --- | --- | --- | --- |
| The complete pagination contract of `GET /v1/posts` — what `meta.next` holds, and how the last page is recognised. | **verified** | Walked one page of `GET /v1/posts` at limit 100 to a null `meta.next`. The meta shape was `{ limit: number, next: null, offset: number, total: number }`. | C78 reads every page before one snapshot write, using the verified token. |
| Which repeatable encoding of `status` and `platform` the endpoint actually filters on, `name[]` or a bare repeated `name`. | **verified** | Both `status[]=scheduled` and `status=scheduled` returned five scheduled rows and no non-scheduled rows; `status[]` is the encoding C78 sends. | C78's request builder emits the encoding that filtered, asserted by a unit test. |
| The fields that identify a listed post stably across pages and across reads. | **verified** | Every listed row carried an `id`. Rows also carried account configurations, caption, created/updated times, draft state, media, platform configurations, schedule, social accounts, and status. | C78 keys `signal_provider_posts` on the verified identity field. |
| That a deleted post is absent from a complete inventory afterwards, rather than present in some other state. | **verified** | A complete one-page inventory read afterwards listed none of the 3 posts this run created. | C78's generation replacement may treat absence as deletion, and this probe's teardown proof is sound. |
| The shape of a post created in the provider’s own UI rather than by this app. **A named human precondition**: the owner creates one and passes its id; the probe never pretends to have made it. | **still unverified** | No `--provider-ui-post` was supplied. | C78 stays blocked. Today's fail-closed value is unchanged. |

### Question 5 — Analytics

| Claim | State | Evidence | Effect on the dependent cards |
| --- | --- | --- | --- |
| The pagination contract of `GET /v1/analytics`, and whether it matches the posts list. | **verified** | `GET /v1/analytics?limit=5&offset=0` answered with meta `{ limit: number, next: null, offset: number, total: number }`. | C80 reads every page before one atomic snapshot replacement. |
| Whether `timeframe` selects which posts are included or which measurement days are counted, and which window values the endpoint accepts. | **still unverified** | `platform=instagram&timeframe=7d` and `timeframe=all` both returned no rows, so the parameter's meaning was not observable. | C80 stays blocked. Today's fail-closed value is unchanged. |
| That a filtered response is one row per measured delivery rather than an account aggregate, and that every row still carries `post_result_id`. | **still unverified** | No analytics rows existed on this account, so the grain was not observed. | C80 stays blocked. Today's fail-closed value is unchanged. |
| How a row maps to a social account — through `post_result_id` and the local publication targets, or through some field of its own. | **still unverified** | No analytics rows existed, so no mapping was observed. | C80 stays blocked. Today's fail-closed value is unchanged. |
| The actual values `match_confidence` takes, and whether a record can arrive without one. | **still unverified** | No analytics rows existed, so no values were observed. | C79 stays blocked. Today's fail-closed value is unchanged. |

### Question 6 — Platform fields

| Claim | State | Evidence | Effect on the dependent cards |
| --- | --- | --- | --- |
| That YouTube `contains_synthetic_media` is accepted on a scheduled post and reads back with the value that was sent. | **still unverified** | No video asset was uploaded, and the role needs a video as the post's own media. | C81 stays blocked. Today's fail-closed value is unchanged. |
| That TikTok `disclose_branded_content` and `disclose_your_brand` are accepted and read back, with `false` distinguishable from unset. | **still unverified** | No TikTok account was named. | C81 stays blocked. Today's fail-closed value is unchanged. |
| That the already-shipped generic `placement: "story"` path is still accepted for Facebook. | **verified** | The generic story path's `placement: "story"` was accepted for Facebook (HTTP 201), and the read-back's `platform_configurations` retained it. | C81 adds the Facebook fixture as regression coverage and changes no production code. |

### Question 7 — Rate-limit evidence

| Claim | State | Evidence | Effect on the dependent cards |
| --- | --- | --- | --- |
| The headers a `429` carries, **if one arrives without being provoked**. The probe has a fixed request budget and never creates load to discover a limit. | **still unverified** | No 429 arrived. The probe never creates load to discover a limit, so this stays unverified by design. | C75 keeps the existing conservative fallback and never retries an ambiguous signed transfer; C80 stays blocked on its own rate-limit contract. |
