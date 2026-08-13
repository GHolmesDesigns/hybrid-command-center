# Social Media Publisher — Source Extraction

Status: **source material, not a decision.** This records what the existing Social Media Publisher
artifact actually does, in its own identifiers, so a Version 5 card can be written against fact
rather than recollection. Nothing here is agreed; §12 lists where it contradicts
`publishing-integration.md`, and those contradictions are the point of the document.

Extracted 2026-08-13 from two artifacts owned by this account:

| Artifact | URL | Updated |
| --- | --- | --- |
| Social Media Publisher | `https://claude.ai/code/artifact/3fb03e35-9ecd-4bf5-b0b9-642588bb32f5` | 2026-08-02 |
| Social Media Publisher — User's Manual | `https://claude.ai/code/artifact/68eac5c3-e5b5-428c-a38f-de0ed750ae32` | 2026-08-03 |

A third, `Signal — Campaign Planner`
(`https://claude.ai/code/artifact/508c9936-c8d9-465c-b7d7-10f30da8c687`, updated 2026-08-03), was
not extracted — Signal is already re-hosted in this app and `server/signal/` is authoritative.

The manual dates its own verification: Post Bridge account names, platform limits, and connector
behaviour on 2 August 2026; Buffer channels, limits, and key handling on 3 August 2026. It says
account lists change and to re-check rather than trust its examples. Treat every account name and
count below as of that date.

---

## 1. The integration path is a connector, not an API key

This is the single most important fact in the document, and it is not what
`publishing-integration.md` assumes.

The artifact **never contacts `api.post-bridge.com`**. It holds no API key, no bearer token, and no
URL. It calls the **Post Bridge MCP connector on claude.ai** through the artifact runtime's
`window.claude.mcp` bridge. The manual states it plainly: it "does not hold an API key, and it
cannot publish anything if that connector is missing."

A connector is addressed by its **display name**, and the artifact resolves that name at boot rather
than pinning one, because this account's connector is named differently from the vendor:

```js
var SERVER_NAMES = [
  "post bridge - social media scheduler",   // what this account's connector is actually called
  "Post Bridge"
];
var SERVER = null; // bound in connect() from listTools(); null until resolved
```

Resolution order, from `connect()`: call `window.claude.mcp.listTools()`, match a server against
`SERVER_NAMES` ignoring case and punctuation, and fall back to any connector offering the Post
Bridge tools. Every later call addresses the connector by the exact string the viewer's connector
carries. Renaming the connector to something unrecognisable makes the page read as disconnected.

### 1.1 Tools called

Five, and deliberately no more — the published manifest is a grant the viewer consents to:

| Constant | Tool | Use |
| --- | --- | --- |
| `T_ACCOUNTS` | `list_social_accounts` | the account list, via `watchTool` with `{ cache: { staleTime: 60000 } }` |
| `T_CREATE` | `create_post` | the only write |
| `T_LIST` | `list_posts` | outbox sync |
| `T_GET` | `get_post` | resolve one row's real state |
| `T_DELETE` | `delete_post` | withdraw a draft or scheduled post |

### 1.2 Account shape

`list_social_accounts` returns rows under `payload.data`, narrowed to three fields:

```js
{ id: r.id, platform: r.platform, username: r.username }
```

`id` is what goes into `social_accounts` on a submission. The manual reports **7 accounts across 5
platforms** reachable this way at extraction time.

---

## 2. Connection states

`connect()` and `watchAccounts()` classify every failure into one of these, each with its own user
copy. Reproduced because it is a complete, already-worded error taxonomy for exactly this provider:

| Kind | Reads as | Meaning |
| --- | --- | --- |
| `boot` | Connecting to Post Bridge… | in flight |
| `ok` | Connected to Post Bridge | working |
| `no_mcp` | Publishing isn't available in this view | no runtime bridge at all |
| `not_granted` | Publishing isn't available in this view | session granted no connector access |
| `capability_disabled` | Publishing isn't available in this view | older viewer |
| `server_not_connected` | Post Bridge isn't connected | nothing recognisable is connected |
| `needs_reauth` | Post Bridge needs reconnecting | sign-in lapsed |
| `selection_required` | Choose which Post Bridge to use | duplicate connectors; lists with no tools |
| `server_not_found` | Post Bridge no longer exists | connector removed |
| `server_unavailable` | Post Bridge didn't respond | unreachable; nothing was sent |
| `not_in_manifest` | This page can't call that tool | outside the published grant |
| `blocked_by_policy` | Your organization blocks this tool | policy |
| `approval_required` | This tool needs per-call approval | policy requires per-call consent |
| `rate_limited` | Too many requests | connector budget hit |
| `bad_request` | The page sent a malformed request | a bug in the page |
| `upstream_error` | Post Bridge returned an error | upstream |

Two behaviours worth carrying forward:

- **A denial retracts data.** On `needs_reauth`, `server_not_connected`, `blocked_by_policy`,
  `approval_required`, or `selection_required` the account list is emptied rather than left on
  screen — the page refuses to let anyone compose against accounts it cannot reach.
- **Send is gated on the connection, not just on validity.** `reachable()` requires `mcp` present,
  `conn.kind === "ok"`, and a bound `SERVER`; the send button is additionally disabled while any
  preflight blocker stands.

---

## 3. Platform capability table

Verbatim from `PLATFORMS`. This is materially more detailed than anything currently in this
repository, and it is the table `publishing-integration.md` §3 approximates.

| Platform key | Label | Media required | Min | Max | Caption max | Other flags | Extras |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| `instagram` | Instagram | yes | 1 | 10 | 2200 | — | `placement` |
| `twitter` | X | no | — | 4 | 280 | `stripsLinks`, `videoAloneOnly` | `first_comment` |
| `linkedin` | LinkedIn | no | — | 20 | 3000 | `videoAloneOnly` | `document_title` |
| `facebook` | Facebook | no | — | — | 63206 | — | `placement` |
| `youtube` | YouTube | yes | 1 | 1 | 5000 | `videoOnly` | `title` |
| `tiktok` | TikTok | yes | 1 | — | 2200 | — | `title`, `draft` |
| `pinterest` | Pinterest | yes | 1 | 1 | 800 | — | `title` |
| `bluesky` | Bluesky | no | — | 4 | 300 | `videoAloneOnly` | — |
| `threads` | Threads | no | — | 4 | 500 | — | — |
| `google_business` | Google Business | no | — | 1 | 1500 | `noVideo` | — |

Per-platform notes as written: Instagram "1–10 images or videos. A story is exactly one and carries
no caption." X "Up to 4 images, or a single video. Links are removed from the tweet itself."
LinkedIn "Up to 20 images, or one video, or one PDF as a document post." Facebook "Text alone is
fine. A Page Story is exactly one image or video, with no caption." YouTube "Exactly one video. The
title is separate from the description." TikTok "One video, or one or more images." Pinterest
"Exactly one image or video." Bluesky "Up to 4 images, or one video." Threads "Up to 4 images or
videos." Google Business "Text, or a single image. Video is rejected."

### 3.1 Signal channel mapping

Identical to the mapping in `publishing-integration.md` §3, extended with `yt` and `tt`:

```js
var SIGNAL_CHANNEL = {
  ig: "instagram", x: "twitter", li: "linkedin", fb: "facebook",
  yt: "youtube", tt: "tiktok", bsky: "bluesky"
};
// "blog" has no platform and is intentionally absent.
```

---

## 4. The submission payload

`buildPayload()`, in full:

```js
{
  caption: string,                    // always present; Post Bridge requires one on every post
  social_accounts: number[],          // account ids, one array, one request
  media_urls?: string[],              // optional; Post Bridge downloads these server-side
  platform_configurations?: {         // per-platform overrides, only where non-empty
    [platform]: {
      caption?, first_comment?, title?, document_title?, placement?
    }
  },
  is_draft?: true,                    // mode "draft"
  scheduled_at?: string,              // mode "schedule" — new Date(state.when).toISOString()
  use_queue?: true                    // mode "queue"
}
```

Mode `now` sends neither `scheduled_at` nor `use_queue`.

**One post, many channels, one request** — the shape `publishing-integration.md` §2 chose Post
Bridge for is confirmed by working code.

### 4.1 Media is by public URL only

`media_urls` are references, never uploads. The manual is explicit that a Google Drive or Dropbox
*share page* is a web page rather than a file, and that Post Bridge needs a direct link ending in
the file. Media kind is inferred from the extension alone:

```js
var VIDEO_EXT = /\.(mp4|mov|m4v|webm|avi|mkv)(\?|#|$)/i;
var PDF_EXT   = /\.pdf(\?|#|$)/i;
var IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?)(\?|#|$)/i;
```

Anything else reads as `unknown`, which the manual names as a real trap: a video served from an
extensionless URL reads as `unknown` and YouTube is then flagged as missing a video that is in fact
there.

---

## 5. The four send modes

| Mode | What happens | Reaches public | Cancellable |
| --- | --- | --- | --- |
| `draft` | saved inside Post Bridge; sends nowhere | no | yes — Remove deletes it |
| `schedule` | publishes at the set date and time | yes | until it fires |
| `queue` | publishes at the next Post Bridge queue slot | yes | until it fires |
| `now` | goes out immediately to every selected account | yes | **no** |

In `draft` the button reads *Save draft* and acts at once. The three live modes read *Review →* and
open a confirmation listing every account by name with the exact caption each will receive —
including the X version with links already stripped, so the real tweet is shown rather than what was
typed.

The manual's recommended test procedure is to **schedule a short way out rather than publish now**,
because a scheduled post is real, inspectable, and still removable.

---

## 6. Preflight

`preflight()` returns entries at three levels: `block` (send disabled until zero), `warn` (will
publish, but not as assumed), and `info`. The rules, exactly:

**Not platform-specific**

- No caption and no per-platform caption on every selected platform → block. *"Post Bridge requires
  one on every post, even when the platform shows only media."*
- No account selected → block.
- Mode `schedule` with no time → block; with a time at or before now → block.

**Per platform**

- `mediaRequired` and no media → block.
- `videoOnly` with media present but no video → block.
- media count over `mediaMax`, when not a story → block.
- story placement with a media count other than exactly 1 → block.
- story placement with any caption → warn (*"stories carry no caption"*).
- `videoAloneOnly` with a video and more than one item → block.
- `noVideo` with a video → block.
- Instagram with a PDF → warn (*"Instagram drops PDFs"*).
- caption over `captionMax` → **block on `twitter` and `bluesky`, warn everywhere else**.
- YouTube with no `title` → warn (caption used instead); title over 100 characters → block.
- `stripsLinks` with links found → warn if the X reply is empty, downgrading to info once the reply
  carries the link.

The manual states the limit of all this: preflight "checks what can be known before sending" and
cannot know a video is corrupt, that a URL will 404 when Post Bridge fetches it, or that a platform
is having a bad morning.

---

## 7. The X link rule, and a bug it reports against Signal

X deletes links from the tweet body — **full URLs and bare domains alike**. The artifact detects
them with a TLD-anchored matcher and offers a *Move the link here* control that lifts the link into
`first_comment`:

```js
var TLD = "com|net|org|io|co|ai|app|dev|me|us|uk|ca|au|de|fr|nl|es|it|design|studio|video|agency|xyz|info|biz|tv|fm|link|page|site|online|store|shop|blog|news|media|digital|email|live|life|world|tech|space|cloud|club|art|photo|pics|gallery|film|productions|production|works|group|team|company|solutions|services|consulting|marketing|social";
var LINK_RE = new RegExp(
  "(?:https?:\\/\\/|www\\.)[^\\s<>()]+" +
  "|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:" + TLD + ")\\b(?:\\/[^\\s<>()]*)?",
  "gi"
);
```

Both artifacts record, in their own words, that **Signal's original matcher only caught `http(s)://`
and `www.` forms**, so `gholmesdesigns.com` "slipped through and was silently deleted from the
tweet." Campaign posts routinely carry UTM-tagged links home, so this is a live content defect
rather than a footnote — and it belongs to Signal, which this repository now owns.

---

## 8. Outbox and reconciliation

Four row states:

| Status | Meaning | Prescribed action |
| --- | --- | --- |
| `sent` | accepted, id returned | none |
| `failed` | rejected with a reason; nothing created | fix and send again |
| `unknown` | the call broke before an answer | **check first; never resend** |
| `removed` | deleted from Post Bridge | none |

`unknown` is assigned by error code, not by guesswork:

```js
var ambiguous = ["server_unavailable", "upstream_error", "cancelled", "rate_limited"];
```

Anything in that list becomes `unknown`; everything else becomes `failed`. **The page never retries
a send on its own.** *Check* reads the post back and reports its live state — `draft`, `scheduled`,
or `posted` — and marks the row removed if Post Bridge no longer has it.

*Remove* asks twice (the button becomes *Confirm remove*), works only on drafts and scheduled posts,
and disappears once something has published because the API refuses to delete posted content. The
manual is emphatic that Remove "has never had the power to pull a post off Instagram or X."

This is the same discipline as `publishing-integration.md` §8, arrived at independently. It is the
strongest available evidence that the decision record's ambiguity rule is right.

---

## 9. Business rules not recorded anywhere in this repository

- **Three Facebook pages exist**: `AdDrive Media`, `G.Holmes Designs`, and `Wild Eye Photography`.
  **Only `G.Holmes Designs` may receive campaign work.** The other two are separate ventures with
  their own audiences.
- Nothing auto-selects a Facebook page in the composer, deliberately, so it stays a decision. The
  Signal importer does choose one:

  ```js
  var PREFERRED = { facebook: "G.Holmes Designs" };  // matched on username, survives an id change
  ```

- Tailoring is **per platform, not per account** — a stated limitation. Selecting both Facebook
  pages would send both the identical text.

---

## 10. There is a second publishing path already in use

Post Bridge is not the only route content leaves by, which `publishing-integration.md` does not
account for.

A separate local tool, the **Buffer Bridge**, publishes the three channels Post Bridge cannot reach
for this account. It lives at `C:\Users\garni\Documents\ClaudeCode\buffer-bridge` (confirmed present:
`bridge.mjs`, `README.md`) and runs as `node bridge.mjs <command>`.

| Channel | Account | Media | Caption max | Posts per day |
| --- | --- | --- | ---: | ---: |
| TikTok | `gholmes.designs` | required | 2,200 | 25 |
| Bluesky | `GHolmesDesigns` | optional | 300 | 100 |
| Threads | `gholmesdesigns` | optional | 500 | 250 |

Facts that matter to any card touching publishing:

- **The two tools do not overlap.** No account appears in both, so the channel decides the tool.
- **Bluesky's 300 characters is the tightest limit anywhere in this setup** — tighter than X's 280
  in practice, because an Instagram-length caption fails it. The bridge refuses rather than letting
  Buffer truncate.
- It follows the same safety rules: drafts are the default, live modes require typing `LIVE`,
  `--dry-run` shows what would be sent, and an interrupted send reports `unknown` and is never
  repeated automatically.
- A published artifact **cannot** contact Buffer directly — it may only talk to claude.ai
  connectors. That constraint is why the bridge exists as a local program, and it does **not** apply
  to this repository's server, which can call any API it is configured for.

### 10.1 Outstanding security item — not actioned here

The manual instructs, as a standing task: the Buffer key currently in
`buffer-bridge\.env` under `BUFFER_ACCESS_TOKEN` "was typed into a chat window, which means it has
been written down somewhere it should not live. Replace it." The rotation procedure is in the
manual, ends with deleting the old key in Buffer's API settings, and is a two-minute job.

**This is recorded, not performed.** Rotating it means handling a live credential, which is the
account owner's to do. Nothing in this repository reads that file, and nothing here should.

---

## 11. Storage, and what is not durable

Everything the artifact holds lives in `localStorage` on that page alone:

| Key | Holds |
| --- | --- |
| `smp-drafts-v1` | every local draft |
| `smp-outbox-v1` | the send history |
| `smp-active-v1` | which draft is open |

A draft is `{ id, caption, media[], accounts[], overrides{}, firstCommentAuto, origin, updated }`.

Clearing site data for claude.ai loses drafts and outbox history; what reached Post Bridge survives
because it lives in Post Bridge. **The artifact cannot read Signal's storage** — the two are separate
pages — so its "Import from Signal" is a paste of a JSON export, not a link. In this app that
problem disappears entirely: Signal's posts are rows in `signal_posts`.

---

## 12. Where this contradicts `publishing-integration.md`

The decision record is dated 2026-08-12 and was written from vendor documentation. The artifact is
dated 2026-08-02 and was written from a working integration. They disagree, and the disagreements
have to be resolved before an implementation card is opened — not during it.

1. **Transport.** The record specifies `POST_BRIDGE_API_KEY` against `https://api.post-bridge.com/v1`,
   server-side (§4, §12). The artifact uses the claude.ai MCP connector and holds no key. These are
   different integrations with different failure modes, different credential exposure, and different
   deployment requirements. **The record's choice still looks right for this app** — a local Express
   server can hold a key and call a REST API, and it is not subject to the artifact's
   connectors-only restriction — but the record should say so explicitly, now that a working
   alternative exists, instead of appearing unaware of it.
2. **Reach.** The record says the first release publishes to **four** channels and refuses `ig`,
   `tt`, and `yt` for want of media modelling (§3). The artifact models media as `media_urls`, a
   public-URL array with no upload and no storage — which is exactly what this app's "stores no user
   files" rule permits. **The four-channel ceiling is a consequence of not modelling media, and the
   artifact shows how cheaply that is fixed.**
3. **The queue.** The record rules `use_queue` out (§5.4), on the grounds that it would move
   scheduling authority to Post Bridge. The artifact ships it as one of four modes. The record's
   reasoning holds; note only that the capability is real and the user has been using it.
4. **Buffer.** The record chose Post Bridge over Buffer (§2). In practice **both are in use**, split
   by channel, with no overlap. The record's "revisit when Signal grows a channel Post Bridge does
   not reach" trigger has already fired — for `tt` and `bsky`, today.
5. **Timezone.** The record requires `PUBLISH_TIMEZONE`, an explicit IANA zone, refusing to publish
   if unset, and refuses the DST spring-forward gap (§5.2, §5.3). The artifact converts with
   `new Date(state.when).toISOString()` from a `datetime-local` input — the **browser's** zone,
   implicitly, with no DST handling at all. **The record is stricter and better here**, and this
   difference is the clearest argument for re-implementing rather than porting.
6. **Caption is mandatory.** The artifact blocks on an empty caption because "Post Bridge requires
   one on every post, even when the platform shows only media." The record does not mention it.
   `SignalPost.text` is required, so nothing breaks — but the constraint belongs in `plan.ts`.
7. **Draft mode is a dead end.** The manual reports that sending an existing Post Bridge draft is
   **broken upstream and returns a server error**, with no route in the API. Any design that treats
   a provider draft as a staging step is designing against a route that does not work.

---

## 13. What a Version 5 card can take from this

Directly reusable, with no vendor negotiation and no new decisions:

- The **platform capability table** (§3) becomes data in `server/publish/plan.ts` — it is precisely
  the "database-free rules" that module is specified to hold.
- The **preflight rules** (§6) become that module's refusal reasons, and the wording is already
  written as the fix rather than the fault.
- The **error taxonomy** (§2) maps onto `PublishProvider` failure states and the ambiguity rule.
- The **`SIGNAL_CHANNEL` map** (§3.1) confirms the record's mapping.
- The **`LINK_RE` matcher** (§7) is a defect fix for Signal that stands on its own, independent of
  whether anything is ever published from this app.
- The **Facebook page rule** (§9) is a business fact that has to be encoded wherever accounts are
  chosen.

Deliberately **not** reusable: the artifact's transport, its timezone handling, and its
localStorage model. All three are answered better by the decision record and by this app's existing
architecture.

---

## 14. Re-fetching the source

Both artifacts are private to this account and fetchable with the artifact URLs in the header —
`WebFetch` against a `claude.ai/code/artifact/{uuid}` URL works with the account's own login; `curl`
does not. Raw copies as extracted on 2026-08-13 were placed beside the Version 5 source document in
`GHD Deliverables/House/` rather than committed here, because they are 170 KB of page HTML that this
repository has no use for once this extraction exists.
