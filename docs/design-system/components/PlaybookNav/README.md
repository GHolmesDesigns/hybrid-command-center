# PlaybookNav

The fixed sidebar for HTML playbooks, with scroll-spy on the current section.

**You provide:** `items`: `{ id, label }`, where each `id` matches a section on the page, plus `title`. Set `fixed` to pin it to the viewport, and offset page content by 260px. Below 760px, stack it above the content without `fixed`.

Leave `activeId` unset and it tracks scrolling. It always renders in the dark treatment, with `RegistrationMark` as its header mark.
