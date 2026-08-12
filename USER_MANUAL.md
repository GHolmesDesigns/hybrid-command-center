# Hybrid Command Center

## First-Time Setup and User Manual

This manual is for the person who will install and use Hybrid Command Center on one local computer. No server, hosting account, or paid service is required. Google Drive connection is optional during setup, but it should be completed before creating production clients if you want their folder structures created automatically.

## 1. What the application stores

Hybrid Command Center divides information between your computer and Google Drive:

- Your computer stores clients, projects, tasks, deadlines, checklist items, dependencies, notes, and settings in a local SQLite database.
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
4. Add a description, status, priority, dates, deadline, and notes as needed.
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
- Tasks due within seven days
- Overdue tasks and affected projects
- Recently updated projects
- Quick actions for common work

The overdue area is intentionally prominent. Select a listed task to open its details, or select a recent project to open the project page.

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

Archiving requires confirmation and preserves the record, its projects, and Drive files.

Clients cannot be deleted. Archiving is the only way to retire one. See [Removing records](#removing-records).

### Projects

Use Projects to:

- Search projects
- Filter by client
- Sort the tiles, or arrange them by hand
- Review task progress and overdue counts
- Edit project details
- Open the Project Status board
- Open the connected Drive folder
- Archive completed or inactive projects
- Delete a project and its tasks from the application

#### Ordering the tiles

The **Sort by** control offers recently updated, recently created, name A–Z, name Z–A, soonest deadline, highest priority, and **Custom order**.

Custom order is the only mode you can rearrange by hand, because in every other mode a moved tile would immediately jump back to its sorted place. Choose Custom order, then either drag a tile by the grip at the bottom-right of its card, or use the position selector below the card's buttons — the selector is the keyboard-accessible alternative and works the same way. In every other sort mode the grip and the position selector are visibly greyed out.

Your arrangement is saved as soon as you make it. It survives a reload, and switching to another sort mode and back brings it back unchanged. New projects are added to the end of the custom arrangement.

Archive keeps the project and its history. Delete removes the project and every task inside it. Both are available from the Projects list and from a project's detail page, and both ask for confirmation first. Neither one touches Drive.

### Status

Use the filters above the board to focus by:

- Client
- Project
- Priority
- Overdue
- Due today
- Due this week
- No due date
- Blocked
- Completed

Below the filters, the search box matches both task titles and tag names, and the **Tags** row filters the board by tag. Selecting more than one tag shows only the tasks carrying every one of them; **Clear tags** removes the whole selection. Tag and search filters combine with the client, project, priority, and focus filters above them. The client, project, focus, and tag selections are kept in the page address, so a filtered board survives a reload and can be shared as a link.

Each card shows its project, priority, type when one is set, tags, due date, checklist progress, and dependency state. The type is repeated at the top of the task detail view.

Open a task to rename it, edit its details, or delete it. **Edit details** opens the same form used to create the task, so this is where you set a type on an older task, change its project, or adjust its dates.

### Removing records

Removal works differently for each kind of record:

| Record | What you can do |
| --- | --- |
| Client | Archive only. No delete exists. |
| Project | Archive, **or** delete the project and all of its tasks. |
| Task | Delete. Its checklist items, tag links, and dependency links go with it. |
| Tag | Delete from Settings. It is removed from every task carrying it; no task is deleted. |

Every removal asks for confirmation first — except a tag no task is using, which has nothing to lose — and none of them touch Google Drive. Deleting a project or task in the application leaves its Drive folders and files exactly as they are — remove those in Google Drive yourself if you want them gone.

Deleting cannot be undone from inside the application. Recover a mistake by restoring a database backup, as described in [Safe data backup](#10-safe-data-backup).

### Settings

Settings contains:

- Google Drive connection and root-folder setup
- Sidebar branding — the mark, title, subtitle, and tagline shown in the left navigation
- **Task tags** — every tag in the workspace, with how many tasks carry it, and the only place a tag is deleted
- The current application version
- Detected local timezone
- Information about the future Calendar, Files, and Import modules

Deleting a tag that is still attached asks first and tells you how many tasks are affected; a tag no task carries is removed straight away. Tags are created from tasks, not here.

Branding edits save immediately and apply to the sidebar without a restart. The defaults also live in `shared/branding.ts` if you prefer to change them in code. The version appears both beside the Branding heading and at the bottom of the sidebar.

Calendar, the embedded file browser, and campaign playbook import are not available in this version. They appear as dimmed placeholders in the sidebar. Use **Open Drive** links to manage project files directly in Google Drive.

## 9. Deadlines and timezones

Due dates use the computer’s current local timezone. A task becomes overdue after its due-date calendar day has passed, unless its status is Complete.

If you travel or change the computer timezone, restart the application and verify deadline lists. Application timestamps are stored consistently in UTC, while date-only deadlines are interpreted locally.

## 10. Safe data backup

Your application database is normally stored at:

```text
data\command-center.db
```

That is the default. If `.env` sets `DATABASE_PATH`, the database lives at that path instead — check `.env` before backing up, and use whatever path it names in place of `data\command-center.db` below.

To make a reliable backup:

1. Stop the application with `Ctrl+C`.
2. Copy `data\command-center.db` to a private backup location.
3. Back up your `.env` file or, at minimum, `GOOGLE_TOKEN_ENCRYPTION_KEY` separately and securely.
4. Continue using Google Drive’s own retention or backup process for project files.

Do not copy only the database while the application is actively writing. SQLite may temporarily use neighboring `-wal` and `-shm` files.

To restore, stop the application, replace `data\command-center.db` with the backup, restore the matching encryption key, and restart.

## 11. Troubleshooting

### `node` or `npm` is not recognized

Install Node.js 24 or newer, then close and reopen PowerShell or Terminal.

### The local page does not open

Confirm that `npm run dev` is still running and shows no error. Use `http://localhost:5173`, not a file path. If you used `npm start`, use `http://localhost:8787`.

### A port is already in use

Close another running copy of the application. If necessary, restart the computer. Changing the API port also requires matching updates to the OAuth redirect URI and development proxy, so closing the duplicate process is usually simpler.

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
