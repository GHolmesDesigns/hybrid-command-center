# Hybrid Command Center

## First-Time Setup and User Manual

This manual is for the person who will install and use Hybrid Command Center on one local computer. No server, hosting account, or paid service is required. Google Drive connection is optional during setup, but it should be completed before creating production clients if you want their folder structures created automatically.

## 1. What the application stores

Hybrid Command Center divides information between your computer and Google Drive:

- Your computer stores clients, projects, tasks, deadlines, checklist items, dependencies, notes, planned social content, and settings in a local SQLite database, along with a bounded record of what each import or outside system has changed.
- Google Drive stores the actual client and project files.
- The application stores Drive folder IDs and links locally. It does not copy file contents into the database.

The application is designed for one user on one computer. It does not include team accounts, client portals, billing, time tracking, or permissions.

## 2. Before you begin

You need:

- Windows 10 or 11, macOS, or Linux
- Node.js 24 or newer
- npm 10 or newer, included with Node.js
- A modern browser such as Chrome, Edge, Firefox, or Safari
- A Google account if you want automatic Drive folders
- Access to Google Cloud Console if you want to connect Drive

Download Node.js from [nodejs.org](https://nodejs.org/). After installing it, close and reopen your terminal.

To confirm the installation, run:

```powershell
node --version
npm --version
```

The Node result should begin with `v24` or a higher number.

## 3. Install the application

Throughout this manual, `<project-folder>` means the folder where you cloned or extracted this
repository. Substitute your own path wherever it appears — for example
`C:\Users\you\Documents\hybrid-command-center` on Windows, or
`~/projects/hybrid-command-center` on macOS or Linux.

### Windows setup

1. Open PowerShell or Windows Terminal.
2. Go to the application folder:

   ```powershell
   cd <project-folder>
   ```

3. Install the application packages:

   ```powershell
   npm install
   ```

4. Create your private settings file:

   ```powershell
   Copy-Item .env.example .env
   ```

5. Initialize the local database:

   ```powershell
   npm run db:migrate
   ```

You should see `Database schema is up to date.`

### macOS or Linux setup

From a terminal in the application folder, run:

```bash
npm install
cp .env.example .env
npm run db:migrate
```

## 4. Choose a clean start or demo data

You have two options.

### Option A: Start with an empty workspace

Do not run the seed command. Start the application and create your real clients normally.

### Option B: Explore with demonstration data

Run:

```powershell
npm run db:seed
```

This creates three example clients, several projects, tasks in every Status column, overdue work, checklists, and a blocked task. It does not contact Google Drive or create Drive folders.

The seed command only works when the database has no clients. Demo clients can be archived, and demo projects and tasks can be deleted outright — see [Removing records](#removing-records). Use an empty workspace if you do not want demonstration records mixed with real work.

## 5. Start and stop the application

### Normal local use

In the application folder, run:

```powershell
npm run dev
```

Keep the terminal window open while using the application. Open:

[http://localhost:5173](http://localhost:5173)

To stop the application, return to the terminal and press `Ctrl+C`. Closing the terminal also stops it.

### Production-style local use

You can create an optimized build and run it from one local address:

```powershell
npm run build
npm start
```

Then open:

[http://localhost:8787](http://localhost:8787)

Run `npm run build` again after application code is updated.

## 6. Optional Google Drive setup

Complete this section before creating real clients and projects if you want their folders created automatically.

Google’s current official instructions for web-server OAuth are available in [Using OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server).

### 6.1 Create a Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Select an existing project or create a new one, such as `Hybrid Command Center`.
3. Open **APIs & Services → Library**.
4. Search for **Google Drive API**.
5. Open it and select **Enable**.

### 6.2 Configure the Google OAuth consent screen

Google may label this area **Google Auth Platform**. The exact menu arrangement can change.

1. Open **Google Auth Platform** for your project.
2. Complete the branding or application-information page.
3. Use a name such as `Hybrid Command Center`.
4. Choose the appropriate audience:
   - Choose **Internal** only if you use Google Workspace and the application is limited to users in your organization.
   - Otherwise choose **External**.
5. If the app is External and in Testing status, add your own Google account as a test user.
6. In the data-access or scopes area, add the Google Drive scope requested by the application:

   ```text
   https://www.googleapis.com/auth/drive
   ```

An External app in Testing status can issue refresh tokens that expire after seven days when it requests Drive access. If Drive disconnects after about a week, reconnect it in Settings. This limitation does not normally apply to an Internal Workspace app, and Google’s publishing or verification requirements may apply if you move an External app beyond personal testing.

### 6.3 Create an OAuth client

1. Open **Google Auth Platform → Clients** or **APIs & Services → Credentials**.
2. Select **Create client** or **Create credentials → OAuth client ID**.
3. Choose **Web application**.
4. Give the client a recognizable name.
5. Add this exact authorized redirect URI:

   ```text
   http://localhost:8787/api/drive/oauth/callback
   ```

6. Create the client.
7. Copy the Client ID and Client Secret. Do not share them or commit them to source control.

The redirect URI must match exactly, including `http`, the port, the path, capitalization, and the absence of a trailing slash.

### 6.4 Create a local encryption key

The application encrypts Google tokens before storing them in the local database.

On Windows PowerShell, run:

```powershell
$keyBytes = New-Object byte[] 32
$keyGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
$keyGenerator.GetBytes($keyBytes)
$keyGenerator.Dispose()
[Convert]::ToBase64String($keyBytes)
```

On macOS or Linux, run:

```bash
openssl rand -base64 32
```

Copy the generated value. Keep a private backup; it is needed to read the saved Google connection.

Either command produces a key long enough to be accepted. A key shorter than 32 characters is
refused when the application starts, because a short key protects the stored connection no better
than none at all while looking exactly the same.

### 6.5 Update the `.env` file

Open `.env` in a text editor and fill in these values:

```dotenv
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_REDIRECT_URI=http://localhost:8787/api/drive/oauth/callback
GOOGLE_TOKEN_ENCRYPTION_KEY=your-generated-encryption-key
```

Leave the other default values unchanged unless you know they need to be different. Save the file, then restart the application.

Never email, publish, or commit the `.env` file. It is excluded from Git by default.

### 6.6 Connect your Google account

1. Start the application.
2. Open **Settings** from the left navigation.
3. Find **Google Drive**.
4. Select **Connect Google Drive**.
5. Choose your Google account and approve the requested Drive access.
6. Google returns you to the application’s Settings page.

If Google displays an unverified-app warning for your private Testing app, confirm that you are using the Cloud project and test account you configured. Do not continue if the displayed application or account is unexpected.

### 6.7 Choose the Command Center root folder

1. In Google Drive, create or select one folder to contain all managed clients. A name such as `Hybrid Command Center` works well.
2. Open that folder and copy its browser URL.
3. Return to **Settings → Google Drive**.
4. Paste the folder URL or folder ID into **Command Center root folder URL or ID**.
5. Select **Verify & save root**.

New folders will follow this pattern:

```text
Hybrid Command Center/
└── Client Name/
    └── Project Name/
        ├── 01_Admin/
        ├── 02_Briefs/
        ├── 03_Working_Files/
        ├── 04_Review/
        └── 05_Final_Deliverables/
```

Connect Drive and select the root before creating production clients. Records created while Drive is disconnected remain valid locally, and you can create their missing folders later with **Sync to Folder** on the Dashboard.

#### What Sync to Folder does

**Sync to Folder** provisions folder skeletons. It walks every active client and every non-archived project and creates any folder that does not exist yet — the client folder, the project folder, and the five standard subfolders.

That is the whole operation. Despite the word "sync", it does not:

- upload files to Drive
- download files from Drive
- mirror, compare, or reconcile file contents
- delete or rename anything in Drive

Existing folders are matched by a stable Command Center property rather than by name, so running it repeatedly is safe and cannot create duplicates. If Drive is disconnected, or no root folder is selected, the button reports what to fix instead of making changes.

### 6.8 Revoke Drive access after a suspected token exposure

Use this procedure if the local database, a database backup, or
`GOOGLE_TOKEN_ENCRYPTION_KEY` may have been exposed. Complete every step; disconnecting locally
and revoking the Google grant are separate actions.

1. Open **Settings → Google Drive** and select **Disconnect**. This deletes the locally stored
   OAuth tokens and Command Center root-folder references. It does **not** revoke the application's
   authorization at Google, so stopping here leaves the Google grant active.
2. Open [Google Account permissions](https://myaccount.google.com/permissions) while signed in to
   the connected account. Find the OAuth application you configured for Hybrid Command Center and
   remove its access. This revokes the grant at Google and invalidates the application's tokens.
3. Generate a new `GOOGLE_TOKEN_ENCRYPTION_KEY` using the command in
   [Create a local encryption key](#64-create-a-local-encryption-key). Stop the application, replace
   the old value in `.env`, and update the private backup of the key. Do not reuse the exposed key.
4. Start the application, return to **Settings → Google Drive**, and select **Connect Google
   Drive**. Approve access again only after confirming the expected Google account and application.
5. Paste the Command Center root folder's URL or ID again and select **Verify & save root**.

The application currently requests full Drive read and write access, even though its own Files
page browses only recorded project folders. Revoking at Google is therefore the step that ends a
stolen token's access to files anywhere in the connected account; rotating only the local
encryption key does not revoke an already-issued token.

## 7. Your first working session

Use this order for the cleanest setup.

### Step 1: Create a client

1. Select **Clients**.
2. Select **New client**.
3. Enter the client name. Contact details, website, and notes are optional.
4. Select **Create client**.

If Drive is connected, the client folder is created under the configured root. The client card shows one of these states:

- **Drive ready:** folder creation succeeded.
- **Drive pending:** setup is incomplete or still needs attention.
- **Drive issue:** Google returned an error.
- **Drive offline:** Drive is not connected.

Select the client name to open its detail page. Use **Open Drive** when a Drive folder is connected.

### Step 2: Create a project

1. Select **Projects**, or open a client and select **New project**.
2. Choose the client.
3. Enter a project name.
4. Add a description, status, priority, dates, deadline, categories, and notes as needed.
5. Select **Create project**.

With Drive connected, the application creates the project folder and five standard subfolders. A local project-name edit does not rename the Drive folder automatically.

### Step 3: Create a task

1. Select **New task** in the top bar or on the Status page.
2. Choose a project. The last project you opened is pre-selected, and you can pick a different one. The client is derived automatically from that project.
3. Enter a title.
4. Choose a status and priority.
5. Choose a **Type** if the task is a recognisable piece of studio work. The choices follow the weekly workflow — Blog Post, Video, Social Post, Graphics, Scheduling, QA / Brand Pass, Admin, and Other. Leave it on **No type** when none fits; a task without a type is perfectly normal.
6. Add a start date, due date, description, or notes if useful.
7. Select **Create task**.

The task appears in its selected Status column. Tasks created before types existed have no type, and you can set one at any time by editing the task.

### Step 4: Add a checklist

1. Open **Status**.
2. Select the task title.
3. Under **Checklist**, type an item and select **Add**.
4. Repeat for each item.
5. Select a checkbox when an item is complete.
6. Use the delete control to remove an item.

The status card displays completed items as a fraction, such as `2/4`.

### Step 5: Add tags

Tags are shared across the whole workspace, so the same label means the same thing on every task.

1. Open a task, or open the create/edit form.
2. Under **Tags**, type a name and press <kbd>Enter</kbd>, type a comma, or select **Add**.
3. Repeat for each tag. Names already in use appear as suggestions while you type.
4. Remove a tag from the task with the **×** beside its chip, or press <kbd>Backspace</kbd> in an empty tag field to remove the last one.

Capitalisation and extra spaces do not create new tags: `brand system`, `Brand System`, and `  Brand   System ` all attach the one existing tag and keep its stored spelling. Tags added from the task detail view apply immediately; tags added in the create/edit form apply when the task is saved.

Each tag has a colour, but the name is always written out beside it — on cards, in the task detail, and in the board filter.

### Step 6: Add a dependency

1. Open the task that must wait for another task.
2. Under **Dependencies**, choose the task that must be completed first.
3. Select **Add**.

The waiting task receives a **Blocked** label until all its dependencies are complete. The detail window lists the incomplete tasks causing the block.

If you try to complete a blocked task, the application explains the conflict. Complete the dependencies first or explicitly confirm the override when appropriate.

### Step 7: Move work through Status

The workflow is fixed in this version:

1. Backlog
2. To Do
3. In Progress
4. Review
5. Complete

Move a task by dragging its card to another column. You can also use the status selector at the bottom of the card, which is the keyboard-accessible alternative. Status and order are saved automatically.

## 8. Using each section

### Dashboard

Use Dashboard as the start of each working session. It shows:

- Active clients and projects
- Tasks due today
- Tasks due within seven days, today included
- Overdue tasks and affected projects
- Recently updated projects
- Quick actions for common work

The four counts at the top are links. Select **Active clients** or **Active projects** to open that list, or **Due today** or **Next 7 days** to open the Status board filtered to the tasks behind the number. They work with the keyboard as well as the mouse: Tab moves between them, Enter opens the one in focus.

The **Deadlines** panel covers all three deadline states. It opens on Overdue, which is intentionally prominent, and the buttons beside it switch to Due today or Next 7 days; each state has its own list and its own message when nothing is in it. **Open board** takes you to the Status board filtered to whichever state is on screen. Select a listed task to open its details, or select a recent project to open the project page.

Next 7 days counts today as one of the seven, so a task due today appears under both Due today and Next 7 days. The counts on the dashboard and the tasks the board shows for the same filter are calculated by one shared rule, so they always match.

Work under an archived project or an archived client is left out of every dashboard count and list. It is not deleted or hidden: the Status board and any direct link to that project still show it.

Recently updated follows the work, not the paperwork. Anything you do inside a project moves it to the top of that list: adding, editing, completing, or deleting a task, ticking a checklist item, or changing a task's tags or dependencies. The date shown beside each project is when that work last happened. Rearranging project tiles is not work, so dragging them changes nothing about the order of this list.

Completed tasks are never counted as overdue.

### Clients

Use Clients to:

- Search client names
- Open client details and projects
- Edit contact details and notes
- Open connected Drive folders
- Review Drive connection state
- Archive inactive clients
- Merge a duplicate client into the client you are keeping

Archiving requires confirmation and preserves the record, its projects, and Drive files.

Clients cannot be deleted. Archiving is the only way to retire one. See [Removing records](#removing-records).

#### Merging a duplicate client

When the same client ended up in the list twice, **Merge client** on the duplicate's page moves
all of its work to the one you are keeping. It is on both active and archived clients, because a
duplicate has usually been archived already.

1. Open the client you want to get rid of and select **Merge client**.
2. Choose the client to keep. The list offers active clients only, and never one that has itself
   been merged.
3. Read the summary. It names both clients, lists every project that will move — including
   archived and completed ones — and states what the merge will not do.
4. Select **Merge clients**. The application opens the client you kept, and its project list now
   includes the work that moved.

What a merge does:

- Moves every project, with its tasks, checklists, dependencies, categories, ordering, dates, and
  Drive links unchanged. Projects with the same name stay separate; nothing is combined.
- Archives the duplicate and records where its work went. Its own contact details and notes stay
  readable on it — they are never copied onto the client you kept, whose details win.
- Leaves Google Drive exactly as it is. No folder is moved, renamed, created, or deleted, so
  every project's files still open where they always did, and the duplicate's own client folder
  stays in Drive. A later **Sync to Folder** will create a folder for a project that never had
  one under the client you kept.
- Makes the duplicate's name an alias. A future playbook import naming it attaches to the client
  you kept instead of recreating work under the archived one.

A merged client cannot be unarchived, chosen as the destination of another merge, or given a
project back by editing one. If the summary is out of date — someone added or renamed a project
while it was on screen — the merge is refused and you are shown the current one to confirm again.

**There is no undo.** Recover from a database backup as described in
[Safe data backup](#10-safe-data-backup) if a merge was a mistake.

### Projects

Use Projects to:

- Search projects
- Filter by client
- Filter by category
- Sort the tiles, or arrange them by hand
- Review task progress and overdue counts
- Edit project details
- Open the Project Status board
- Open the connected Drive folder
- Archive completed or inactive projects
- Delete a project and its tasks from the application

#### Reading a tile's status

Every tile carries its status in the chip at its top-left, and the tile itself is tinted and
edged to match, so a mixed list separates into planning, active, on hold, complete, and archived
without reading each word in turn. The colour is never the whole signal: each status keeps its
word and has an icon of its own, and the five stay apart in a greyscale screenshot or with
colours turned off. Archived projects are the quiet ones — the one neutral tint in the list, and
the only dashed edge — while staying as readable as the rest.

#### Categories

Categories organise projects the way tags organise tasks. A project can carry as many as it needs — retainer, campaign, internal, whatever your work divides into — and every project shares one workspace list, so the same category always means the same thing.

To categorise a project:

1. Select the settings icon on a project's card, or **Edit project** on its detail page.
2. Under **Categories**, type a name and press <kbd>Enter</kbd>, type a comma, or select **Add**.
3. Repeat for each category. Names already in use appear as suggestions while you type.
4. Remove one with the **×** beside its chip, or press <kbd>Backspace</kbd> in an empty category field to remove the last one.
5. Select **Save changes**. Categories are applied when the project is saved.

Capitalisation and extra spaces do not create new categories: `retainer`, `Retainer`, and `  Retainer ` all attach the one existing category and keep its stored spelling.

The **Categories** row above the project tiles filters the list. Selecting more than one shows only the projects carrying every one of them; **Clear categories** removes the whole selection. The category filter combines with the client filter, the search box, and the sort order. Your selection is kept in the page address, so a filtered list survives a reload and can be shared as a link.

Each card names the categories it carries beneath its description, and a project's detail page names them under its summary. Every category has a colour, but the name is always written out beside it.

Categories are renamed and deleted in Settings — see [Settings](#settings).

#### Ordering the tiles

The **Sort by** control offers recently updated, recently created, name A–Z, name Z–A, soonest deadline, highest priority, and **Custom order**.

Custom order is the only mode you can rearrange by hand, because in every other mode a moved tile would immediately jump back to its sorted place. Choose Custom order, then either drag a tile by the grip at the bottom-right of its card, or use the position selector below the card's buttons — the selector is the keyboard-accessible alternative and works the same way. In every other sort mode the grip and the position selector are visibly greyed out.

Your arrangement is saved as soon as you make it. It survives a reload, and switching to another sort mode and back brings it back unchanged. New projects are added to the end of the custom arrangement.

Archive keeps the project and its history. Delete removes the project and every task inside it. Both are available from the Projects list and from a project's detail page, and both ask for confirmation first. Neither one touches Drive.

#### Ordering a project's tasks

Open a project to see **All project tasks**, grouped into the five workflow stages — Backlog, To
Do, In Progress, Review, Complete — in that order, with a count beside each. A stage with no work
in it is not shown.

Within a stage, drag a row by the grip at its right-hand end, or use the position selector beside
the grip — the selector is the keyboard-accessible alternative and makes the same move. Selecting
the row itself opens the task, so only the grip carries the drag.

There is one order per stage and both views read it. The arrangement you make here is the same
arrangement the Status board's column shows, and a move made on the board changes what this page
shows too. This page hides the tasks other projects have in the same stage, and moving one of your
rows leaves those hidden tasks exactly where they were.

Your arrangement is saved as soon as you make it, and it survives a reload. Moving a task to a
different stage is done on the Status board or from the task itself, not by dragging between the
groups here.

### Status

Use the filters above the board to focus by:

- Client
- Project
- Priority
- Task type — any single type, or **No type** for the tasks that carry none
- Overdue
- Due today
- Due this week
- No due date
- Blocked
- Completed

Below the filters, the search box matches both task titles and tag names, and the **Tags** row filters the board by tag. Selecting more than one tag shows only the tasks carrying every one of them; **Clear tags** removes the whole selection. Tag and search filters combine with the client, project, priority, type, and focus filters above them; every filter narrows the board further rather than replacing what is already chosen. Every selection except the search box is kept in the page address, so a filtered board survives a reload and can be shared as a link.

Each card shows its project, priority, type when one is set, tags, due date, checklist progress, and dependency state. The type is repeated at the top of the task detail view.

Open a task to rename it, edit its description, dates, and notes inline, or delete it. **Edit details** still opens the same form used to create the task, so this is where you set a type on an older task, change its project, or edit every field at once.

### Signal

**Signal** is the content planner. The left side is the **Unscheduled queue**: ideas that do not
yet belong to a day. Type into **Add an idea** to capture one quickly. The idea is created in the
queue and its editor opens so you can add details.

The month grid shows every dated post in its calendar cell. Use the arrows to move between months.

Every cell is the same height whatever it holds, so a long post no longer stretches its day and
the whole of that week with it. A post longer than the cell shows its opening, ending in an
ellipsis, with **Show more** underneath. **Show more** opens the rest of that post where it sits
and moves nothing else on the page; **Show less** puts the opening back. A cell holding more than
fits scrolls on its own. Queue items are never shortened — the queue is a column of its own with
no day beside it to stretch.

Select any queue item or grid post to open the editor — **Show more** only reveals the text, and
never opens the editor by accident. The editor can change:

- Content, including long-form copy
- One or more channels
- Ordered public media URLs
- Date and time
- Format and status
- Campaign and call to action

Clear the date, or use **Move to unscheduled queue**, to return a post to the queue. Giving a
queued post a date schedules it in that month's grid. Saving reloads both views from the Signal
API, so the same post cannot remain in the queue and the calendar at once.

Media is added as a public `https:` URL, not uploaded. Use the arrow controls beside a media row to
change its order, or the trash control to detach it from the post. The planner shows the media
count on the post. Command Center stores only those URL references: it never downloads, proxies,
or inspects the file, so an extensionless link remains an unknown media kind until publishing
preflight asks you to correct it.

**Delete** asks for confirmation and then removes a post that has no publication history
permanently. There is no in-app undo; restore a database backup to recover it. A status of
**Published** is your own record that the post went out. Provider delivery uses a separate
publication record and never changes that status automatically.

### Import

**Import** creates a whole campaign at once from a *campaign playbook*: a client, its projects,
their tasks, the tasks' checklists, and the order those tasks depend on each other in. It is meant
for a campaign you have already written down — a spreadsheet you filled in before the work
started — rather than for typing the same structure in by hand.

A playbook is an `.xlsx` workbook with one tab per kind of record: `Clients`, `Projects`, `Tasks`,
`ChecklistItems`, and `Dependencies`. **Download sample playbook**, beside **Import a playbook** at
the top of the page, saves a filled-in workbook with every tab already there and its columns
already named — start from that rather than building one from the column list. The same file is in
the application folder at `docs/examples/campaign-playbook-import-format.xlsx`, and the full list
of columns is in `docs/campaign-playbook-import-format.md`. You can also paste the tabs straight in
as text, each one under its name in square brackets, which is what a spreadsheet gives you when you
copy cells.

**Import a playbook** opens the modal. Choose the workbook or paste the tabs, then press **Check
this playbook**. Nothing is written yet. The check tells you three things:

- **What it will create**, counted per tab.
- **What it will skip**, because this workspace already has it — with the reason for each row.
  A client matches by name, a project by its name under that client, and a task by its title and
  due date under that project, ignoring capitalisation. Skipped records are left exactly as they
  are; an import never edits or overwrites something you already have. That is why importing the
  same playbook twice creates nothing the second time.
- **What is wrong**, one line per row and column, if anything is. Common causes are a date written
  in another format, a status spelled in lower case, a key referred to but never defined, and a
  formula left in a cell where a value belongs.

While anything is wrong, importing stays blocked and nothing is written. Once the check is clean,
the button reads **Import _n_ records**. Pressing it writes the whole playbook in one action: if
any part of it fails, none of it is kept.

Every import — successful, refused, or failed — leaves a **receipt** on the Import page. It keeps
the counts and every skipped or failed row, so you can still see what an import did after closing
the modal, reloading the page, or restarting the application. The fifty most recent are kept.

Below the receipts is **Integration activity**: one record for every operation an outside system
has run against this workspace. Today that means imports; a calendar sync will appear here too.
Each record says which integration it was, what it did, whether it succeeded, and — when you open
it — the exact clients, projects, and tasks it left behind, by name and by internal id. That is
the list to read when an import did not do what you expected: it is what actually landed, rather
than what was asked for. A failed record carries the reason in its own words.

Nothing on this list can be edited or removed from inside the application; records are only ever
added, and the two hundred most recent are kept. If a record mentions more than a hundred affected
records it lists the first hundred and tells you the real number. Credentials never appear here —
passwords, keys, and access tokens are stripped out before a record is written.

Importing never touches Google Drive. Imported clients and projects start as **Drive offline**;
use **Sync to Folder** on the dashboard to create their folders when you are ready.

### Files

**Files** shows what is actually in a project's Google Drive folder, without leaving the
application. Choose a project at the top of the page, and a folder beside it — the project's own
folder, or one of the five subfolders created with it. A project's detail page has a **Browse
files** button that opens this page already pointing at that project.

Each row gives the name, what kind of item it is, when it was last changed, and how big it is.
Folders and Google Docs, Sheets, and Slides report no size, so those rows show a dash rather
than a misleading zero. **Open** on any row opens that item in Google Drive itself, and a folder
belonging to this project can also be opened here to browse into it. Long folders load 25 items
at a time; **Show 25 more** adds the next page to the list.

This page only ever reads. There is no upload, download, move, rename, or delete anywhere on it,
and there is no hidden one: adding, renaming, and removing files is done in Google Drive, which
every row links to. Deleting a project or a task in Command Center never touches a Drive file
either — see [Removing records](#removing-records).

If files cannot be shown, the page says which of four things is wrong and what to do about it:

| What it says | What it means |
| --- | --- |
| Google Drive is not set up on this computer | The `.env` file has no Google credentials yet. See [Optional Google Drive setup](#6-optional-google-drive-setup). |
| Google Drive is not connected | Credentials are present, but no Google account is connected. Connect one in Settings. |
| *Project* has no Drive folder yet | This project was created while Drive was unavailable. Run **Sync to Folder** on the dashboard. |
| Drive could not list this folder | Drive was asked and refused — usually a rate limit or a dropped connection. **Try again** repeats the request. |

### Calendar

**Calendar** shows one month at a time: the content Signal Campaign has scheduled, beside the
tasks coming due. It opens on the current month. The arrows either side of **Today** step a month
back or forward, **Today** returns, and the month you are looking at is in the address, so a
particular month can be bookmarked or sent to someone.

Under the month heading, two counts say how much is there — how many scheduled posts, and how
many task deadlines.

The page is a list of days rather than a grid of boxes, and days with nothing on them are left
out entirely. Two reasons: a scheduled post can run to several paragraphs and will not fit in a
small square, and scrolling past three empty weeks to find the one busy day helps nobody. Today's
date is marked.

Within a day, scheduled content and task deadlines are kept in **two separate headed groups**,
each with its own icon and count. They are never mixed into one list, because they are not the
same kind of thing: one is content going out, the other is work coming due.

- A **scheduled post** shows its time, whether it is a draft, scheduled, or published, what kind
  of piece it is, the text itself, the channels it goes out on, and the campaign it belongs to if
  it has one. Each channel shows its initials as well as its colour, so the channel is readable
  without relying on being able to tell the colours apart.
- A **task deadline** shows whether it is due or complete, is marked **Overdue** when it is, names
  the project and client, and its title is a link that opens the task on the Status board.

**Nothing on this page changes anything.** There is no control that creates, moves, or reschedules
a post or a task, and there is no hidden one. The calendar is a window onto the schedule. Editing
a scheduled post in the browser is not in this version — the schedule is changed through the
application's own interface for it, which has not shipped yet.

Two things it will tell you rather than hide:

| What it says | What it means |
| --- | --- |
| Signal's schedule could not be read. Showing task deadlines only. | The scheduled content could not be fetched, but your task deadlines below are complete and correct. The reason is printed underneath, and **Retry** asks again. An empty calendar and an unreadable one are different things, and the page will not let one look like the other. |
| This month has more scheduled posts than one page shows. | A very full month; the list is not the whole of it. |

If a month genuinely holds nothing, the page says **Nothing this month** rather than showing an
empty frame.

Dates behave the same way they do everywhere else in the application: a post scheduled for the
14th appears on the 14th, whatever timezone the computer is set to. A post with no date at all is
not scheduled, and deliberately appears on no day here.

### Removing records

Removal works differently for each kind of record:

| Record | What you can do |
| --- | --- |
| Client | Archive only. No delete exists. A duplicate can also be **merged** into another client, which moves its projects and archives it — see [Merging a duplicate client](#merging-a-duplicate-client). |
| Project | Archive, **or** delete the project and all of its tasks. |
| Task | Delete. Its checklist items, tag links, and dependency links go with it. |
| Tag | Delete from Settings. It is removed from every task carrying it; no task is deleted. |
| Category | Delete from Settings. It is removed from every project carrying it; no project is deleted. |

Every removal asks for confirmation first — except a tag no task is using, or a category no project is using, which have nothing to lose — and none of them touch Google Drive. Deleting a project or task in the application leaves its Drive folders and files exactly as they are — remove those in Google Drive yourself if you want them gone. The project detail page says so beside its delete button, and the [Files](#files) page repeats it above every listing.

Deleting cannot be undone from inside the application, and neither can merging two clients.
Recover a mistake by restoring a database backup, as described in
[Safe data backup](#10-safe-data-backup).

### Settings

Settings contains, in the order it reads:

- Google Drive connection and root-folder setup
- **Project categories** — every category in the workspace, with how many projects carry it, and the only place a category is renamed or deleted
- **Task tags** — every tag in the workspace, with how many tasks carry it, and the only place a tag is deleted
- Sidebar branding — the mark, title, subtitle, tagline, colours, and logo shown in the left navigation
- The current application version
- Detected local timezone
- A short note on the Calendar, with a link to it

On a wide screen these sit in two columns: the connection and the labels on the left, the sidebar's
appearance and the rest on the right. Each column is its own stack, so a card that grows — Drive as
you connect it, a validation message appearing, a long list of categories — moves only the cards
under it in the same column and never leaves a blank strip beside it. A narrower screen shows one
column, and the cards read top to bottom in the order listed above.

Deleting a tag that is still attached asks first and tells you how many tasks are affected; a tag no task carries is removed straight away. Tags are created from tasks, not here.

Categories work the same way, with one addition: **Add** creates a category before any project uses it, and the pencil beside a category renames it. A rename reaches every project carrying that category at once, because the projects point at the category rather than storing its name. Deleting a category that is still attached asks first and tells you how many projects are affected; the projects themselves are never deleted, they simply stop carrying the label. A name another category already holds is refused, whatever its capitalisation.

Branding edits save immediately and apply to the sidebar without a restart. The defaults also live in `shared/branding.ts` if you prefer to change them in code. The version appears both beside the Branding heading and at the bottom of the sidebar.

#### Sidebar colours

Three colours are yours to choose: the **sidebar background**, the **sidebar text**, and an **accent** used for the mark, the marker beside the current page, and the version number. Pick each one from the swatch or type a hex value such as `#18201d`.

Under the colours, a reading for each pair shows its contrast ratio and says in words whether it **Passes AA** or **Fails AA**. A failing combination cannot be saved — the Save button is disabled, and the application refuses the same combination if it arrives any other way. This is deliberate: a sidebar whose own text you cannot read is not a preference, it is a lockout. Everything else the sidebar draws — quieter labels, the hover shading, the outline that shows which control the keyboard is on — is worked out from your three colours, so it stays readable whichever palette you choose.

#### Sidebar logo

The **logo address** field takes a web address beginning with `https://` — an image on your website, a content delivery network, or a shared Google Drive image link. The image is not uploaded or copied into this device's database; the application only stores the address and the browser loads the picture from there. That means an internet connection is needed to see it, and the site hosting the image can tell that the picture was requested.

**Logo alt text** is required whenever an address is set. It describes the logo for screen readers and appears if the image cannot be shown.

Leave the address empty to use the text mark instead. The text mark also returns on its own if the address ever stops working, so the sidebar never shows a broken image.

#### Resetting

**Reset to defaults** restores every branding field — wording, colours, and logo — to the values the application shipped with. The reset fills the form; press **Save branding** to apply it.

[Calendar](#calendar), [Signal](#signal), and [Files](#files) are in the sidebar and working.
Calendar and Files only read: use Signal to change the content schedule, and use the **Open** links
on Files or **Open Drive** on a project to manage files themselves in Google Drive.

## 9. Deadlines and timezones

Due dates use the computer’s current local timezone. A task becomes overdue after its due-date calendar day has passed, unless its status is Complete.

If you travel or change the computer timezone, restart the application and verify deadline lists. Application timestamps are stored consistently in UTC, while date-only deadlines are interpreted locally.

## 10. Safe data backup

Your application database is normally stored at:

```text
data\command-center.db
```

That is the default. If `.env` sets `DATABASE_PATH`, the database lives at that path instead — check `.env` before backing up.

Do **not** copy `data\command-center.db` by hand while the application is running. SQLite may be using neighboring `-wal` and `-shm` files, and copying only the main file can produce a backup that will not open cleanly.

### Back up

From the application folder, run:

```powershell
npm run db:backup
```

You can run this while the application is open. It writes a timestamped snapshot to `data\backups\`. That folder stays out of git. Copy the snapshot somewhere private as well if you want an off-machine copy.

Also back up your `.env` file or, at minimum, `GOOGLE_TOKEN_ENCRYPTION_KEY`. Encrypted Google connection data inside the database cannot be read without that key. Drive folder IDs and links in the database survive restore even without the key.

Continue using Google Drive’s own retention or backup process for project files. This application does not copy Drive files into the local backup.

### Restore

1. Stop the application with `Ctrl+C`.
2. Restore from a backup file:

   ```powershell
   npm run db:restore -- data\backups\command-center-YYYYMMDDThhmmssmmmZ.db --force
   ```

3. If the backup is from an older version, run `npm run db:migrate`.
4. Restore the matching `GOOGLE_TOKEN_ENCRYPTION_KEY` if Drive was connected.
5. Start the application again.

The restore command saves a safety copy of the database it is about to replace.

### Rehearse before a schema change

Before applying a new version that changes the database shape, run:

```powershell
npm run db:backup:rehearse
```

That backs up the live database, copies the backup, runs migrations against the copy only, and reports whether clients, projects, tasks, and Drive folder references are still intact. The live database is not modified.

## 11. Troubleshooting

### `node` or `npm` is not recognized

Install Node.js 24 or newer, then close and reopen PowerShell or Terminal.

### The local page does not open

Confirm that `npm run dev` is still running and shows no error. Use `http://localhost:5173`, not a file path. If you used `npm start`, use `http://localhost:8787`.

### A port is already in use

Close another running copy of the application. If necessary, restart the computer. Changing the API port also requires matching updates to the OAuth redirect URI and development proxy, so closing the duplicate process is usually simpler.

### The application will not start and reports an invalid configuration

The application checks `.env` before it starts and refuses to run on a value it cannot use. Each
line of the message names one variable and what was wrong with it — for example a port that is not
a number, an address without `http://` in front of it, or an encryption key shorter than 32
characters. Every problem is listed at once. Correct them in `.env`, save, and start again.

The message never prints the value it rejected, so it is safe to copy from a terminal.

### Google Drive says credentials are required

Confirm that `.env` contains non-empty values for:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_TOKEN_ENCRYPTION_KEY`

Save the file and restart the application.

### Google reports `redirect_uri_mismatch`

Confirm that both Google Cloud and `.env` use exactly:

```text
http://localhost:8787/api/drive/oauth/callback
```

Do not add a trailing slash.

### Google says access is blocked

For an External app in Testing status, confirm that your Google account is listed as a test user. A Google Workspace administrator may also restrict Drive scopes.

### Drive disconnects after several days

An External OAuth app left in Testing status commonly receives a refresh token that expires after seven days when Drive scopes are used. Reconnect from Settings, or review Google’s publishing, verification, and Workspace options for longer-term use.

### Publishing is not available

Publishing is optional. Add both `POST_BRIDGE_API_KEY` and an explicit IANA `PUBLISH_TIMEZONE`
(for example, `America/New_York`) to `.env`, then restart. The API key stays on the server and is
never returned to the browser or written to the database or activity log.

To publish, save the scheduled Signal post first, choose **Preview publishing**, and review the
caption, the local configured-zone time, and the UTC instant, then read each channel in turn. Every
channel on the post gets its own block naming the account it resolved to and its own state:
**Ready to send**, **Blocked**, or **Not available from this provider**. Blog is always the last of
these — no provider publishes to a blog, so post it yourself and mark the post published.

Warnings and refusals sit with the channel they belong to, because a limit is rarely true of a post
as a whole: a caption over 280 characters blocks X and is fine on LinkedIn. A refusal says what has
to change — how many media items to remove, what media to add, or which format the platform will not
take — and every refusal must be fixed before **Confirm and submit** becomes available. What the
preview checks is what can be known without sending: it cannot tell whether a video is corrupt,
whether a link will still resolve when Post Bridge fetches it, or what an extensionless URL points
at, and it says so rather than guessing. A result marked **UNCONFIRMED** is never retried
automatically; inspect Post Bridge before taking another action to avoid a duplicate.

Delivery state does not change the Signal status. After a delivery is confirmed, **Mark published**
is an explicit user action. Deleting a post with a live provider submission cancels it first;
publication history then protects the Signal post from deletion so the audit record stays readable.

### The root folder is rejected

Confirm that:

- You pasted a Google Drive folder URL or folder ID, not a file URL.
- The connected Google account can open the folder.
- The folder has not been deleted or moved to Trash.

### A client or project shows Drive offline or Drive issue

The local record and tasks remain usable. Confirm the Drive connection and root folder in Settings. Do not manually create duplicate folder structures with the same names while diagnosing the problem.

### A task cannot be completed

Open the task and review its Dependencies section. Complete the blocking tasks, remove an incorrect dependency, or use the explicit override only when bypassing the dependency is intentional.

### The dashboard count looks unexpected

Check that:

- The task has a due date.
- The task is not already Complete.
- The computer’s date and timezone are correct.
- The task belongs to the expected project.

## 12. Security reminders

- Keep `.env` private.
- Do not publish the SQLite database.
- Do not paste OAuth secrets into the browser interface.
- Connect only the intended Google account.
- Review the Google consent screen before approving access.
- Stop the application when using a shared computer.
- Back up the database and encryption key in separate, private locations.

## 13. First-time setup checklist

- [ ] Node.js 24 or newer installed
- [ ] `npm install` completed
- [ ] `.env` created from `.env.example`
- [ ] `npm run db:migrate` completed
- [ ] Clean start or demo data chosen
- [ ] Application opens locally
- [ ] Google Drive API enabled, if using Drive
- [ ] OAuth consent screen and test user configured
- [ ] OAuth web client created
- [ ] Exact redirect URI added
- [ ] Client ID, client secret, and encryption key saved in `.env`
- [ ] Google account connected in Settings
- [ ] Command Center root folder verified
- [ ] First client created
- [ ] First project created
- [ ] First task, checklist, and dependency tested
- [ ] Local database backup plan established

Once these steps are complete, begin each work session on the Dashboard, resolve overdue work first, and use the Status board to move active tasks through Review and Complete.
