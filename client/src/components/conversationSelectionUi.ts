import type { ConversationSelectionIssue } from '../../../shared/conversation-selection.ts';

export function drawerSelectionIssueMessage(issue: ConversationSelectionIssue): string {
  switch (issue) {
    case 'unsupported_scope':
      return 'This scoped thread cannot be shown in Command AI right now. Open the full Conversations view instead.';
    case 'archived_in_drawer':
      return 'This thread is archived. Command AI lists active threads only.';
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
