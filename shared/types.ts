export const TASK_STATUSES = ['BACKLOG', 'TODO', 'IN_PROGRESS', 'REVIEW', 'COMPLETE'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
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
  updatedAt: string;
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
