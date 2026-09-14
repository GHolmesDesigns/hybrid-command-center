import type { ConversationSelectionIssue } from '../../../shared/conversation-selection.ts';

export function drawerSelectionIssueMessage(issue: ConversationSelectionIssue): string {
  switch (issue) {
    case 'unsupported_scope':
      return 'Command AI shows active freeform threads only. Scoped project, client, and task discussions open in the full Conversations view.';
    case 'archived_in_drawer':
      return 'This thread is archived. Command AI lists active freeform threads only.';
    case 'missing':
      return 'This conversation could not be found, may be archived under another filter, or you may not have access.';
  }
}

export function fullViewSelectionIssueMessage(issue: ConversationSelectionIssue): string {
  switch (issue) {
    case 'missing':
      return 'This conversation could not be found or you may not have access.';
    case 'unsupported_scope':
    case 'archived_in_drawer':
      return '';
  }
}
