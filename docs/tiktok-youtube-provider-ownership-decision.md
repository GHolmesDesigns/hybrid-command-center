# TikTok and YouTube Provider Ownership Decision

Status: **decided (C155 / #447), 1 September 2026.** This record settles the provider
ownership policy that C156 (#448) must implement. It changes no routing code and authorizes no
provider write.

## 1. Decision

**TikTok and YouTube are Buffer-owned channels while the observed Post Bridge account cap
holds.** Ownership is fixed for this workspace and does not vary by client, post, credential,
or account. A configured credential or a provider returning first never selects a route.

The current ownership table is:

| Signal channel | Owning provider | Account rule |
| --- | --- | --- |
| TikTok (`tt`) | Buffer | The explicitly approved connected Buffer TikTok channel |
| YouTube (`yt`) | Buffer | The explicitly approved connected Buffer YouTube channel |
| Facebook, Instagram, LinkedIn, Threads, Bluesky | Post Bridge | Existing explicit Post Bridge target rules remain unchanged |

This is an account-cap decision, not a claim that Post Bridge lacks TikTok or YouTube support.
Post Bridge supports both, but connecting them displaced five accounts the studio actively uses.
Giving up those five routes to gain these two is not an available trade.

No ownership variation by account is allowed in this decision. If the workspace later needs a
second TikTok or YouTube account that Buffer does not hold, the app must refuse it as an unowned
target. It must not fall through to Post Bridge. Account-specific ownership would require new
dated evidence, an amendment to this record, and a separately reviewed migration.

## 2. Dated account evidence

This decision reuses existing owner-approved, read-only account evidence. C155 made no new
provider call and performed no live publish.

### Post Bridge — 22 August 2026

The recorded `GET /v1/social-accounts` read found seven accounts before TikTok and YouTube were
connected: three Facebook accounts plus Instagram, LinkedIn, Threads, and Bluesky. After TikTok
and YouTube were connected, only four accounts remained; Facebook (G.Holmes Designs), Instagram,
LinkedIn, Threads, and Bluesky had been displaced. The record concludes that Post Bridge cannot
hold TikTok and YouTube beside the five accounts this studio publishes on.

Evidence: [`post-bridge-api-surface.md`](post-bridge-api-surface.md#not-askable-from-this-workspace-as-of-22-august-2026)
and
[`publishing-integration.md`](publishing-integration.md#2-why-post-bridge-and-what-would-change-the-answer).

### Buffer — 23 August 2026

Before any write, the owner-approved Buffer probe matched the exact account and organization to
one connected, unlocked TikTok channel and one connected, unlocked YouTube channel. Exact ids
remain owner-held and uncommitted. The same record verifies Buffer's service vocabulary for both
channels. Later write evidence is deliberately narrower: TikTok create/read/edit/delete was
verified with an approved image, while YouTube create and publish-time delivery remain
unverified and therefore fail-closed.

Evidence: [`publishing-integration.md`](publishing-integration.md#22-buffer-result-matrix--23-august-2026).

The ownership conclusion needs account presence, not a live publish. The missing YouTube write
evidence constrains what C156 may submit automatically; it does not move YouTube to another
provider.

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

For a post targeting TikTok and YouTube together, both targets are Buffer-owned, so Buffer creates
one remote post per explicit channel and records two remote ids. That is a per-channel Buffer
operation, not a cross-provider split. Existing media and evidence gates still apply independently
to each target; ownership alone is not permission to publish.

## 4. Migration and historical rows

Provider identity is historical evidence and is never reinterpreted in place.

| Existing state | Rule |
| --- | --- |
| Historical or terminal publication | Keep its recorded provider, target id, remote id, state, and integration history unchanged. Reads, reconciliation, and permitted lifecycle actions continue through that recorded provider. |
| Scheduled or draft provider submission | Keep it on its recorded provider. Do not rewrite the row or address its remote id through another provider. |
| Unsubmitted Signal plan | Apply the ownership table only when a fresh preview is built. The confirmation hash must cover the selected provider and target ids. |
| Operator chooses to move a still-withdrawable submission | First perform the existing confirmed withdrawal against the recorded provider and prove its outcome. Then build and separately confirm a new delivery on the owning provider. Never combine those operations or reuse the old remote id. |
| Existing submission cannot be withdrawn safely | Leave it on its recorded provider and report the refusal. Do not create a replacement that could duplicate delivery. |

The route already recorded in `publishing-integration.md` assigns TikTok and YouTube to Buffer, so
C156 should not require a bulk data rewrite. Any row that contradicts the current table is retained
as history, not treated as corrupt data and not silently migrated.

## 5. C156 implementation contract

C156 may change routing behavior only within these boundaries:

1. Keep TikTok and YouTube in the Buffer-owned route while this decision is current.
2. Resolve only the explicitly selected connected Buffer channel id whose service matches the
   Signal channel.
3. Refuse unowned accounts and mixed-provider confirmations before any provider call.
4. Preserve provider-qualified publication history and remote ids.
5. Keep YouTube automatic submission fail-closed until dated positive write evidence exists;
   channel ownership does not waive the existing evidence flag.
6. Preserve preview, explicit confirmation, stale-plan rejection, ambiguous-write refusal, and
   per-target outcome reporting.

## 6. Revisit conditions

Revisit this decision only when dated read-only account evidence shows that the Post Bridge cap or
the studio's connected-account requirements changed, or Buffer no longer holds an approved TikTok
or YouTube channel. An amendment must name the new owning provider per channel, state whether
ownership can vary by account, and define migration before routing code changes.

Until an amendment lands, a missing Buffer target is a refusal, not permission to route through
Post Bridge.

## 7. Verification

- [x] Dated account evidence for both providers is cited.
- [x] The owner and account-variation rule are explicit for each channel.
- [x] Historical and scheduled rows keep their recorded provider.
- [x] Mixed-provider confirmation refuses before any provider call.
- [x] No application behavior or provider write is introduced by this card.
