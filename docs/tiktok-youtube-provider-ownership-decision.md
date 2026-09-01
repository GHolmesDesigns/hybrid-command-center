# TikTok and YouTube Provider Ownership Decision

Status: **decided (C155 / #447), 1 September 2026.** This record settles the provider
ownership policy that C156 (#448) must implement. It changes no routing code, revokes no
credential, and authorizes no provider write.

## 1. Decision

**TikTok and YouTube are Post Bridge-owned channels.** The account owner confirmed on
1 September 2026 that both channels are currently connected through Post Bridge. The Buffer
integration remains configured, but its connection and API key do not give it routing ownership.

The current ownership table is:

| Signal channel | Owning provider | Account rule |
| --- | --- | --- |
| TikTok (`tt`) | Post Bridge | The explicitly connected Post Bridge TikTok target |
| YouTube (`yt`) | Post Bridge | The explicitly connected Post Bridge YouTube target |
| Facebook, Instagram, LinkedIn, Threads, Bluesky | Post Bridge | Existing explicit Post Bridge target rules remain unchanged |

Ownership is fixed for this workspace and does not vary by client, post, credential, or account.
A configured Buffer credential, a historical Buffer target, or a provider returning first never
selects the current route. If a requested TikTok or YouTube account is not present in the approved
Post Bridge target set, the app refuses it as unowned rather than falling through to Buffer.

Account-specific ownership would require new dated account evidence, an amendment to this record,
and a separately reviewed migration. It must never emerge implicitly from whichever provider has a
credential or matching channel.

## 2. Dated account evidence

### Current configuration — 1 September 2026

The account owner confirmed the current configuration directly during C155:

- TikTok is connected through Post Bridge.
- YouTube is connected through Post Bridge.
- The Buffer connection remains present, but it is not the owning route for either channel.

This current owner evidence supersedes the older account-cap routing conclusion below. Revoking the
Buffer API key is neither necessary nor useful for choosing the route: credentials configure access;
they do not decide ownership. C155 made no provider write or live publish.

### Historical Post Bridge evidence — 22 August 2026

The earlier `GET /v1/social-accounts` record found that connecting TikTok and YouTube displaced
other Post Bridge accounts under the configuration and cap observed that day. That evidence explains
why the application originally routed the two channels through Buffer, but it is **historical**, not
a statement of the current account configuration.

Historical source:
[`post-bridge-api-surface.md`](post-bridge-api-surface.md#not-askable-from-this-workspace-as-of-22-august-2026)
and
[`publishing-integration.md`](publishing-integration.md#2-why-post-bridge-and-what-would-change-the-answer).

### Historical Buffer evidence — 23 August 2026

The earlier Buffer probe matched connected TikTok and YouTube channels before any write and verified
a guarded TikTok create/read/edit/delete round trip. That proves the Buffer integration and historical
targets existed; it does not make Buffer the current owner after the account configuration changed.
YouTube create and publish-time delivery remained unverified in that run.

Historical source:
[`publishing-integration.md`](publishing-integration.md#22-buffer-result-matrix--23-august-2026).

## 3. Routing and mixed-provider rule

Every delivery target names exactly one provider and one provider account or channel id. The
following are prohibited:

- automatic failover or retry through the other provider;
- dual submission of one target;
- first-matching-account or credential-presence routing;
- silently splitting one confirmation across providers.

A Signal plan may contain targets owned by different providers, but **one confirmed submission
may contain targets from only one provider**. A mixed-provider selection refuses before any
provider call and names the conflicting targets and their owners. The operator must preview and
confirm each provider-owned target set separately. Each resulting publication records its own
per-target outcome and remote id; failure on one provider never triggers the other.

For a post targeting TikTok and YouTube together, both targets are Post Bridge-owned and belong in
the Post Bridge confirmation. The app resolves their explicit Post Bridge target ids; it does not
consult Buffer as a fallback. Existing media and capability gates still apply independently to each
target. Ownership alone is not permission to publish.

## 4. Migration and historical rows

Provider identity is historical evidence and is never reinterpreted in place.

| Existing state | Rule |
| --- | --- |
| Historical or terminal Buffer publication | Keep its Buffer provider, target id, remote id, state, and integration history unchanged. Reads, reconciliation, and permitted lifecycle actions continue through Buffer. |
| Scheduled or draft Buffer submission | Keep it on Buffer. Do not rewrite the row or address its remote id through Post Bridge. |
| Historical or scheduled Post Bridge submission | Keep it on Post Bridge under the same immutable-provider rule. |
| Unsubmitted Signal plan | Apply the current Post Bridge ownership table when a fresh preview is built. The confirmation hash must cover the selected provider and target ids. |
| Operator chooses to move a still-withdrawable Buffer submission | First perform the existing confirmed Buffer withdrawal and prove its outcome. Then build and separately confirm a new Post Bridge delivery. Never combine those operations or reuse the Buffer remote id. |
| Existing Buffer submission cannot be withdrawn safely | Leave it on Buffer and report the refusal. Do not create a Post Bridge replacement that could duplicate delivery. |

C156 changes the route for new previews; it does not bulk-rewrite publication data. A historical
Buffer row is retained as valid history, not treated as corrupt data and not silently migrated.

## 5. C156 implementation contract

C156 may change routing behavior only within these boundaries:

1. Remove TikTok and YouTube from the Buffer-owned route and assign them to Post Bridge.
2. Resolve only explicitly connected Post Bridge target ids whose platform matches the Signal
   channel.
3. Treat Buffer configuration and credential presence as irrelevant to route selection.
4. Refuse unowned accounts and mixed-provider confirmations before any provider call.
5. Preserve provider-qualified publication history and remote ids; never reinterpret a Buffer row
   as Post Bridge.
6. Preserve preview, explicit confirmation, stale-plan rejection, ambiguous-write refusal, media
   and capability gates, and per-target outcome reporting.

## 6. Revisit conditions

Revisit this decision only when dated current account evidence shows that TikTok or YouTube is no
longer connected through Post Bridge or the owner deliberately assigns a channel elsewhere. An
amendment must name the new owning provider per channel, state whether ownership can vary by account,
and define migration before routing code changes.

Until an amendment lands, a missing Post Bridge target is a refusal, not permission to route through
Buffer.

## 7. Verification

- [x] Current owner-confirmed account evidence and superseded historical evidence are distinguished.
- [x] The owner and account-variation rule are explicit for each channel.
- [x] Historical and scheduled rows keep their recorded provider.
- [x] Mixed-provider confirmation refuses before any provider call.
- [x] Buffer credential presence is explicitly not a routing rule.
- [x] No application behavior or provider write is introduced by this card.
