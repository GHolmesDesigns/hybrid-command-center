export const TASK_STATUSES = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'REVIEW', 'COMPLETE'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
/**
 * What kind of studio work a task is, following the weekly workflow: content
 * production, then scheduling and publish, then QA and wrap. Optional — a task
 * without a type is normal, and every task predating the field has none.
 */
export const TASK_TYPES = [
  'BLOG_POST',
  'VIDEO',
  'SOCIAL_POST',
  'GRAPHICS',
  'SCHEDULING',
  'QA_BRAND_PASS',
  'ADMIN',
  'OTHER',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/**
 * Default checklist items for newly created typed tasks. Templates are applied once,
 * at creation time; changing this map never mutates existing tasks.
 */
export const TASK_CHECKLIST_TEMPLATES: Partial<Record<TaskType, readonly string[]>> = {
  BLOG_POST: [
    'Draft the post',
    'Edit for clarity and the week’s theme',
    'Deliver final Markdown',
    'Schedule on gholmesdesigns.com',
    'Verify blog-to-video and social-to-blog links',
  ],
  VIDEO: [
    'Draft the script',
    'Build the storyboard',
    'Create InstaDoodle illustrations',
    'Animate the segment',
    'Verify publish links',
  ],
  SOCIAL_POST: [
    'Draft platform-specific captions',
    'Check brand voice',
    'Add #ThinkVisually where appropriate',
    'Confirm no emoji',
    'Schedule the week’s posts',
    'Verify links to the blog or video',
  ],
  GRAPHICS: [
    'Create thumbnails',
    'Create quote cards',
    'Create carousel assets',
    'Verify brand CMYK palette',
    'Apply the registration-mark motif',
    'Run a brand QA pass',
  ],
  SCHEDULING: [
    'Schedule the blog post',
    'Schedule social posts',
    'Verify cross-links between social, blog, and video',
  ],
  QA_BRAND_PASS: [
    'Verify approved typefaces',
    'Verify approved palette',
    'Confirm no gradients',
    'Confirm no mascots',
    'Confirm no visual clichés',
  ],
  ADMIN: [
    'Capture the prior week’s platform-native performance',
    'Record the topic, hook, and format carrying into the next brief',
  ],
};

export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type DriveStatus = 'DISCONNECTED' | 'PENDING' | 'CONNECTED' | 'FAILED';

export interface Client {
  id: string;
  name: string;
  slug: string;
  contactName?: string;
  email?: string;
  phone?: string;
  website?: string;
  notes?: string;
  status: 'ACTIVE' | 'ARCHIVED';
  driveFolderId?: string;
  driveFolderUrl?: string;
  driveStatus: DriveStatus;
  driveError?: string;
  createdAt: string;
  updatedAt: string;
}
export interface Project {
  id: string;
  clientId: string;
  clientName?: string;
  name: string;
  description?: string;
  status: 'PLANNING' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETE' | 'ARCHIVED';
  startDate?: string;
  targetDeadline?: string;
  priority: Priority;
  notes?: string;
  /** Manual tile order on the Projects view, honoured by the Custom sort mode. */
  position: number;
  driveFolderId?: string;
  driveFolderUrl?: string;
  driveStatus: DriveStatus;
  driveError?: string;
  createdAt: string;
  /** When the project record itself was last edited. Tile drags and Drive retries do not move it. */
  updatedAt: string;
  /**
   * When work last happened on this project: its own edits plus every write to its
   * children — tasks, checklists, task tags, dependencies. This is what the dashboard's
   * Momentum panel orders by and displays; `updatedAt` deliberately stays narrower.
   */
  lastActivityAt: string;
}
export interface ChecklistItem {
  id: string;
  taskId: string;
  text: string;
  completed: boolean;
  position: number;
}
export interface Tag {
  id: string;
  name: string;
  color?: string;
}
/**
 * One spelling rule for tag names, shared by the API boundary and the chip input so a name
 * typed in the browser resolves to the same stored tag the server would have matched.
 * Trims the ends and collapses runs of inner whitespace; case is preserved for display and
 * ignored when comparing, matching the `COLLATE NOCASE` lookup in `server/app.ts`.
 */
export const normalizeTagName = (value: string) => value.trim().replace(/\s+/g, ' ');
/** True when two names refer to the same global tag, ignoring case and extra whitespace. */
export const sameTagName = (a: string, b: string) =>
  normalizeTagName(a).toLowerCase() === normalizeTagName(b).toLowerCase();
export interface Task {
  id: string;
  projectId: string;
  projectName?: string;
  clientId?: string;
  clientName?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: Priority;
  taskType?: TaskType;
  dueDate?: string;
  startDate?: string;
  notes?: string;
  position: number;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
  tags: Tag[];
  checklist: ChecklistItem[];
  dependencyIds: string[];
  blockingDependencies: { id: string; title: string }[];
  blocked: boolean;
  overdue: boolean;
  checklistCompleted: number;
  checklistTotal: number;
}
export interface DashboardData {
  counts: {
    activeClients: number;
    activeProjects: number;
    dueToday: number;
    dueNextSevenDays: number;
    overdue: number;
    projectsOverdue: number;
  };
  overdueTasks: Task[];
  upcomingTasks: Task[];
  recentProjects: Project[];
}
