# Wave 40 evidence index

Operator-supplied screenshots committed before implementation cards start. Each file is named `w<issue>-<surface>-<subject>.png`.

## W40-F — Conversations spacing and composer width ([#635](https://github.com/GHolmesDesigns/hybrid-command-center/issues/635))

Captured September 2026 on production (`hcc.gholmesdesigns.com/agents/conversations`, v6.8.2).

| File | Shows | Operator annotations |
| --- | --- | --- |
| [`w635-conversations-list-detail-view.png`](w635-conversations-list-detail-view.png) | Wide viewport split layout: thread list, detail header, decision controls, message column, archive button | Red arrow on **Active** filter / thread-list header spacing |
| [`w635-conversations-detail-reply-area.png`](w635-conversations-detail-reply-area.png) | Narrow viewport: stacked threads, selected thread header, archive button, reply composer and Send | Red arrows on **Archive** placement and **composer width** |
| [`w635-conversations-thread-messages-composer.png`](w635-conversations-thread-messages-composer.png) | Selected thread with message bubbles, handoff status lines, decision textarea, reply composer | Red horizontal arrow: composer left edge narrower than messages; red vertical arrow: spacing between handoff status rows |
| [`w635-conversations-composer-width-reference.png`](w635-conversations-composer-width-reference.png) | Message column and reply composer at bottom of detail panel | Green outline on composer showing width mismatch vs message bubbles above |

### Issues visible for implementer

1. **Archive button** — sits above decision/composer controls with awkward spacing; not aligned to the detail content column width.
2. **Composer width** — `.conversation-compose` textarea and Send row are narrower than the message bubbles and decision controls above; large unused margin on the right of the detail card.
3. **Thread list spacing** — excessive vertical padding in thread list items and between the **Threads** header, **Active** filter, and first list row (visible at wide and narrow viewports).

Implementation card: `docs/iterations/WAVE_40_OPERATOR_WORKFLOW_UI.md` § W40-F. Proof at merge: focused browser test at wide and narrow viewports (Q10-A).
