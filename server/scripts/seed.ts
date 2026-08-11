import crypto from 'node:crypto';
import { addDays, subDays, format } from 'date-fns';
import { getDb } from '../db.ts';
import { provisionClient, provisionProject } from '../drive/service.ts';
import { buildClientSlug } from '../domain/client-slugs.ts';

const db = getDb(),
  stamp = new Date().toISOString(),
  day = (date: Date) => format(date, 'yyyy-MM-dd'),
  uid = () => crypto.randomUUID();
if ((db.prepare('SELECT COUNT(*) count FROM clients').get() as any).count > 0) {
  console.log('Seed skipped: the database already contains clients.');
  process.exit(0);
}
const clients = [
  {
    id: uid(),
    name: 'Northstar Coffee Co.',
    contact: 'Maya Chen',
    email: 'maya@northstar.example',
    notes: 'Retail brand refresh and seasonal launch work.',
  },
  {
    id: uid(),
    name: 'Fieldwork Architecture',
    contact: 'Jon Bell',
    email: 'jon@fieldwork.example',
    notes: 'Architecture studio with editorial and digital projects.',
  },
  {
    id: uid(),
    name: 'Lumen Arts Foundation',
    contact: 'Iris Okafor',
    email: 'iris@lumen.example',
    notes: 'Nonprofit arts programming and annual campaign.',
  },
];
const clientStmt = db.prepare(
  `INSERT INTO clients(id,name,slug,contact_name,email,notes,status,drive_status,created_at,updated_at) VALUES(?,?,?,?,?,?,'ACTIVE','DISCONNECTED',?,?)`,
);
clients.forEach((c) =>
  clientStmt.run(
    c.id,
    c.name,
    buildClientSlug(c.name, c.id),
    c.contact,
    c.email,
    c.notes,
    stamp,
    stamp,
  ),
);
const projects = [
  {
    id: uid(),
    client: clients[0],
    name: 'Autumn Packaging System',
    desc: 'A flexible packaging family for the fall product line.',
    deadline: day(addDays(new Date(), 18)),
    priority: 'URGENT',
  },
  {
    id: uid(),
    client: clients[0],
    name: 'Flagship Store Launch',
    desc: 'Launch campaign and in-store creative for the new flagship.',
    deadline: day(addDays(new Date(), 42)),
    priority: 'HIGH',
  },
  {
    id: uid(),
    client: clients[1],
    name: 'Studio Website',
    desc: 'A portfolio-led website for projects and studio thinking.',
    deadline: day(addDays(new Date(), 27)),
    priority: 'HIGH',
  },
  {
    id: uid(),
    client: clients[2],
    name: 'Annual Impact Report',
    desc: 'Editorial design and digital companion for the annual report.',
    deadline: day(addDays(new Date(), 12)),
    priority: 'MEDIUM',
  },
];
const projectStmt = db.prepare(
  `INSERT INTO projects(id,client_id,name,description,status,start_date,target_deadline,priority,drive_status,created_at,updated_at) VALUES(?,?,?,?,'ACTIVE',?, ?,?,'DISCONNECTED',?,?)`,
);
projects.forEach((p) =>
  projectStmt.run(
    p.id,
    p.client.id,
    p.name,
    p.desc,
    day(subDays(new Date(), 12)),
    p.deadline,
    p.priority,
    stamp,
    stamp,
  ),
);
const tasks = [
  {
    id: uid(),
    p: projects[0],
    title: 'Confirm final dielines',
    status: 'BACKLOG',
    priority: 'MEDIUM',
    due: day(addDays(new Date(), 7)),
    desc: 'Collect printer-confirmed production dimensions.',
  },
  {
    id: uid(),
    p: projects[1],
    title: 'Draft launch story arc',
    status: 'BACKLOG',
    priority: 'HIGH',
    due: day(addDays(new Date(), 14)),
    desc: 'Shape the campaign narrative across channels.',
  },
  {
    id: uid(),
    p: projects[0],
    title: 'Finalize color specifications',
    status: 'TODO',
    priority: 'URGENT',
    due: day(subDays(new Date(), 2)),
    desc: 'Lock Pantone and production color values.',
  },
  {
    id: uid(),
    p: projects[2],
    title: 'Curate featured projects',
    status: 'TODO',
    priority: 'HIGH',
    due: day(new Date()),
    desc: 'Select twelve projects for the first portfolio release.',
  },
  {
    id: uid(),
    p: projects[0],
    title: 'Build packaging mockups',
    status: 'IN_PROGRESS',
    priority: 'HIGH',
    due: day(addDays(new Date(), 2)),
    desc: 'Produce three hero scenes for client review.',
  },
  {
    id: uid(),
    p: projects[3],
    title: 'Write executive summary',
    status: 'IN_PROGRESS',
    priority: 'MEDIUM',
    due: day(subDays(new Date(), 1)),
    desc: 'Turn program outcomes into a concise opening narrative.',
  },
  {
    id: uid(),
    p: projects[2],
    title: 'Review responsive prototypes',
    status: 'REVIEW',
    priority: 'HIGH',
    due: day(addDays(new Date(), 4)),
    desc: 'Complete tablet and mobile review with the studio.',
  },
  {
    id: uid(),
    p: projects[3],
    title: 'Approve photography selects',
    status: 'REVIEW',
    priority: 'MEDIUM',
    due: day(addDays(new Date(), 6)),
    desc: 'Confirm captions, releases, and final image set.',
  },
  {
    id: uid(),
    p: projects[1],
    title: 'Deliver location toolkit',
    status: 'COMPLETE',
    priority: 'HIGH',
    due: day(subDays(new Date(), 3)),
    desc: 'Final signage and social templates delivered.',
  },
  {
    id: uid(),
    p: projects[2],
    title: 'Complete content inventory',
    status: 'COMPLETE',
    priority: 'MEDIUM',
    due: day(subDays(new Date(), 8)),
    desc: 'Audited and categorized all existing content.',
  },
];
const taskStmt = db.prepare(
  `INSERT INTO tasks(id,project_id,title,description,status,priority,due_date,position,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
);
tasks.forEach((t, i) =>
  taskStmt.run(
    t.id,
    t.p.id,
    t.title,
    t.desc,
    t.status,
    t.priority,
    t.due,
    i,
    t.status === 'COMPLETE' ? stamp : null,
    stamp,
    stamp,
  ),
);
const check = db.prepare(
  'INSERT INTO checklist_items(id,task_id,text,completed,position) VALUES(?,?,?,?,?)',
);
[
  ['Assemble front panel', 1],
  ['Create side-view scene', 1],
  ['Export review JPEGs', 0],
].forEach(([text, done], i) => check.run(uid(), tasks[4].id, text, done, i));
[
  ['Review program metrics', 1],
  ['Draft key outcomes', 0],
  ['Confirm leadership quote', 0],
].forEach(([text, done], i) => check.run(uid(), tasks[5].id, text, done, i));
db.prepare('INSERT INTO task_dependencies(task_id,dependency_id) VALUES(?,?)').run(
  tasks[4].id,
  tasks[2].id,
);

if (process.argv.includes('--with-drive')) {
  for (const c of clients) await provisionClient(db, c.id);
  for (const p of projects) await provisionProject(db, p.id);
  console.log('Demo data and Drive folders created.');
} else
  console.log(
    'Demo data created. Drive was not contacted. Use -- --with-drive only when you intentionally want folders created.',
  );
