# Preston Mazda – Customer Enquiry Tracker

A live, shared **spreadsheet-style log** of customer enquiries for the service
and parts departments. Staff sign in with their work email and type straight
into the cells: one row per enquiry, drop-downs and tick boxes in the cells,
saved as you go. Each row can be allocated to a service advisor and to the
parts department, hold PDF parts quotes, and carry notes on every conversation.

It runs as a small program on **one PC or server inside the dealership**.
Everybody on the dealership network opens it in a browser and sees the same
board update live. Nothing is stored on the internet: customer details, notes
and quotes stay in a folder on that machine, and the only outbound connection
is to your own mail server so alerts can be emailed.

It takes only its fonts and colours from the Service Dashboard in the folder
above (they share one stylesheet), with the dealership shown as **Preston Mazda**.

## What it does

| Feature | How it works |
|---|---|
| Columns | Row # / reference, Name, Registration, Contact number, Email address, Preferred method (drop-down: Call / Text / Email), Enquiry, 📎, 🗒, Service advisor (allocated to, contact customer, done), Parts department (allocated to, quote required, done), Status, Logged. Click a column header to sort. Export the sheet to CSV for Excel. |
| 📎 Attachments | Click the paperclip on a row to attach PDF parts quotes (drag-and-drop or choose file). PDF only, up to 15 MB each. Only signed-in staff can open them. |
| 🗒 Notes | Click the sticky-note icon to record what was discussed and **who spoke to the customer**. Each note also records who logged it and when. |
| Allocation | Each enquiry can be allocated to a service advisor and to a parts person. Each department has its own **"Mark done"** box, which records who ticked it and when. |
| Live sheet | Every change appears on everyone's screen within a second (Server-Sent Events), without disturbing the cell you are typing in. Rows whose tasks are all done are marked green; closed rows are greyed and kept under the *Closed* / *All* filter. |
| Email alerts | **Parts quote required** → email to `parts@maxkirwan.com.au`. **Service advisor needs to contact the customer** → email to `advisors@maxkirwan.com.au`. |
| Personal alerts | When an enquiry is allocated to a specific advisor (or parts person), or parts marks a quote as done for their enquiry, that person gets an **email and a pop-up box** in the tracker (plus a desktop notification if they allow it). Alerts also collect under the bell icon. |
| Accounts | Staff request an account with their `@maxkirwan.com.au` email and a strong password. Requests are approved by **steves@maxkirwan.com.au** (emailed a link, and shown under *Users & approvals*). Administrators can also add users directly, who then receive a set-password link. |
| Password recovery | *Forgot your password?* on the sign-in page emails a one-hour reset link. Administrators can also send one from the Users page. |
| Security | Passwords are hashed with scrypt. Sessions are HttpOnly cookies that expire after 12 hours of inactivity. Sign-in is rate-limited. Optional encryption of the data folder at rest (`DATA_KEY`) and HTTPS (`TLS_CERT`/`TLS_KEY`). A strict Content-Security-Policy is sent with every page. |

## Setting it up (once)

1. **Pick the machine** that will run the tracker – a PC or small server that is
   on all day and on the dealership network (e.g. the service office PC).
2. **Install Node.js** (LTS version, 18 or newer) from https://nodejs.org on
   that machine. Nothing else is needed – the tracker has no other
   dependencies and needs no `npm install`.
3. **Copy this folder** (`tracker`) and the dashboard folders next to it
   (`assets`, `css`) onto the machine – simplest is to copy the whole
   `Service-Dashboard` folder.
4. **Create the config file**: copy `tracker/config.example.json` to
   `tracker/config.json` and edit it:
   - `APP_URL` – the address staff will use, e.g. `http://SERVICE-PC:8080`.
     This is what goes in the emailed links.
   - `SMTP_*` and `MAIL_FROM` – your mail server details so alerts can be
     sent (see *Email* below). Until this is filled in, alerts are written to
     `tracker/data/outbox.log` instead of being sent.
   - `DATA_KEY` – a long passphrase to encrypt the data folder at rest
     (recommended). Keep a copy somewhere safe: without it the data cannot
     be read. Set it before the first run; changing it later requires
     re-encrypting the folder.
   - The approver, parts and advisor addresses are already set to
     `steves@`, `parts@` and `advisors@maxkirwan.com.au`. Change them here if
     they ever change.
5. **Start it**: double-click `tracker/start-tracker.cmd` (Windows) or run
   `node tracker/server.js`. The window shows the address it is listening on.
6. **Create the first administrator**: open the tracker in a browser and
   *Request an account* using **steves@maxkirwan.com.au**. That address is
   approved automatically and becomes the administrator. Everyone else who
   registers waits for approval under *Users & approvals* (top-right menu).
7. **Open the firewall** on that machine for the port (8080 by default) so
   other PCs on the network can reach it, and give staff the `APP_URL` link.

### Keeping it running

Make the tracker start automatically with Windows so the board is always up:

- **Task Scheduler** (built in): create a task that runs
  `node.exe C:\path\to\Service-Dashboard\tracker\server.js`
  *At startup*, with *Start in* set to the `tracker` folder and
  *Run whether user is logged on or not*.
- or **NSSM** (https://nssm.cc) to install it as a Windows service:
  `nssm install PrestonMazdaTracker "C:\Program Files\nodejs\node.exe" server.js`
  with the *Startup directory* set to the `tracker` folder.

On Linux use a `systemd` service with `ExecStart=/usr/bin/node /opt/Service-Dashboard/tracker/server.js`.

### Email

Any mail server that accepts SMTP with a username and password works
(Microsoft 365, Google Workspace, or the dealership's own server):

| Setting | Microsoft 365 | Google Workspace |
|---|---|---|
| `SMTP_HOST` | `smtp.office365.com` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` | `587` |
| `SMTP_SECURE` | `false` (STARTTLS is used) | `false` |
| `SMTP_USER` / `SMTP_PASS` | the sending mailbox and its password / app password | same |
| `MAIL_FROM` | `Preston Mazda Enquiry Tracker <tracker@maxkirwan.com.au>` | same |

The tracker always upgrades the connection to TLS; it refuses to send in the
clear unless `SMTP_REQUIRE_TLS` is set to `false`. Recent sends and failures
are shown at the bottom of the *Users & approvals* page, and every message is
also copied to `tracker/data/outbox.log` (turn that off with
`LOG_MAIL_TO_OUTBOX: false` once you are happy it works).

### HTTPS (optional but recommended)

If the dealership has an internal certificate, set `TLS_CERT` and `TLS_KEY`
to the PEM files and use an `https://` `APP_URL`. Session cookies are then
marked *Secure* automatically. Alternatively put the tracker behind an
existing reverse proxy (IIS, nginx, Caddy) that terminates HTTPS.

### Backups

Everything lives in `tracker/data`:

- `db.json` – users, enquiries, notes (encrypted when `DATA_KEY` is set)
- `uploads/` – the PDF quotes (also encrypted when `DATA_KEY` is set)
- `outbox.log` – copies of alert emails

Back that folder up like any other dealership data. Keep `config.json`
(which holds the mail password and `DATA_KEY`) somewhere safe and never
commit it or `data/` to git – both are ignored by `.gitignore`.

## Day-to-day use

- **+ New row** (or press Enter on the last row) – a yellow draft row appears.
  Type the customer's name and Tab across the cells; the row is saved as soon
  as it has a name, and every later edit saves on the spot. Tab moves across,
  Enter and the arrow keys move up and down a column.
- **Preferred method** is a drop-down in the cell. Tick *Contact customer*
  or *Quote required* to send the matching email alert.
- **Allocate** from the drop-downs in the *Service advisor* and *Parts
  department* columns. The person allocated gets an email and a pop-up.
- **Done** – each department ticks its own box (the cell shows who ticked
  it). When every allocated task is done the row is marked green; set
  *Status* to Closed to archive it. Closed rows stay searchable under the
  *Closed* / *All* filter.
- **📎** attach quotes, **🗒** add notes. Counts on the icons show how many
  are on the enquiry.
- **Bell** – your alerts. Click one to jump to that enquiry.
- **Users & approvals** (administrators) – approve or decline requests, add
  users, change departments, disable accounts, send password links.

Who can do what: any signed-in staff member can log, edit, allocate and
tick enquiries (the tracker records who did it). Deleting an enquiry, a note
or an attachment is limited to the person who created it or an administrator.

## Configuration reference

All settings can be given in `tracker/config.json` or as environment
variables with the same name (environment variables win).

| Setting | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Where to listen. |
| `APP_URL` | `http://localhost:8080` | Public address used in emailed links. |
| `DEALER_NAME` | `Preston Mazda` | Shown in the header and emails. |
| `APPROVER_EMAIL` | `steves@maxkirwan.com.au` | Receives account requests; auto-approved as administrator. |
| `ADMIN_EMAILS` | | Extra addresses that are administrators when they register (comma-separated). |
| `PARTS_EMAIL` | `parts@maxkirwan.com.au` | Alerted when a parts quote is required. |
| `ADVISORS_EMAIL` | `advisors@maxkirwan.com.au` | Alerted when an advisor must contact the customer. |
| `ALLOWED_EMAIL_DOMAINS` | `maxkirwan.com.au` | Only these domains can register (comma-separated; blank allows any). |
| `DATA_DIR` | `data` | Where the database and uploads live (relative to `tracker/`). |
| `DATA_KEY` | | Passphrase for encryption at rest. |
| `SESSION_HOURS` | `12` | Idle time before a sign-in expires. |
| `MAX_UPLOAD_MB` | `15` | Largest PDF accepted. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_REQUIRE_TLS`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | | Mail server. `SMTP_SECURE: true` for implicit TLS on port 465. |
| `LOG_MAIL_TO_OUTBOX` | `true` | Also write every email to `data/outbox.log`. |
| `TLS_CERT`, `TLS_KEY` | | Serve HTTPS directly from these PEM files. |

## Developing and testing

```
cd tracker
npm test          # runs the API smoke test and the SMTP client test (no network needed)
node server.js    # http://localhost:8080
```

Files:

```
tracker/
  server.js            routes, alerts, sessions, approvals
  lib/store.js         atomic JSON store + optional AES-256-GCM encryption
  lib/auth.js          scrypt passwords, tokens, rate limiting
  lib/mail.js          SMTP client (STARTTLS / TLS / AUTH) with retry queue
  lib/http.js          router, bodies, cookies, static files, security headers
  public/              the browser app (index.html, css/tracker.css, js/tracker.js)
  test/                node --test suites
  config.example.json  copy to config.json
```

The page loads `../css/styles.css` from the dashboard so the brand tokens
(Mazda Type, Mazda red, greys, tiles, pills, dialogs) are defined in one
place. Drop the licensed Mazda Type font files into `assets/fonts/` as
described in `assets/fonts/README.md` and both the dashboard and the tracker
pick them up.
