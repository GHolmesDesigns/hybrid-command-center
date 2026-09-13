# Merge protocol footer (paste into wave card issues)

Append to Wave 40 (#629–#638) and Wave 39 (#640–#645) issue bodies or comments:

---

### Merge protocol

- One PR at a time. Do not open the next branch until the previous card is merged.
- Draft only until CI green. Run `npm run finalize:card -- <issue>` immediately before `gh pr ready`.
- Do not guess the version; run `npm run version:next -- --milestone "<milestone name>"`.
