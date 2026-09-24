# Preston Mazda Customer Enquiry Log – SharePoint version

`Preston Mazda Customer Enquiry Log.xlsx` is the no-install alternative to the
Node.js tracker in `../tracker`. It is a shared Excel workbook kept in
SharePoint: everyone opens the same file, sees each other's edits live, and
signs in with their normal Microsoft 365 account. Nothing runs in the
background: quotes are PDFs saved as `<Ref>.pdf` into a SharePoint folder, and
email alerts are one-click `mailto:` links that open a ready-written email.

Rebuild the workbook with `python3 build_workbook.py` (needs `openpyxl`).

## Sheets

| Sheet | Purpose |
|---|---|
| Setup Guide | Step-by-step: putting it in SharePoint, sharing (approval), syncing the quotes folder, attaching quotes, one-click email alerts, daily use. |
| Enquiry Log | The log. One row per enquiry: Ref, Date Logged, Logged By, Customer Name, Registration, Contact Number, Email Address, Preferred Method (Call / Text / Email drop-down), Enquiry, Quote (PDF) link, Notes + Spoke To Customer, Service Advisor + Contact Customer + Advisor Done, Parts Person + Quote Required + Parts Done, Status, and four one-click email columns. |
| Staff | Service advisors and parts staff with emails. Feeds the drop-downs and the per-person email links. |
| Settings | Dealership name, approver, alert mailboxes, and the SharePoint folder URL for PDF quotes. |

## How each requirement is met

| Requirement | How |
|---|---|
| Secure, not on the internet, but live and shared | Lives in the dealership's own Microsoft 365 tenant on SharePoint, under IT's controls, with version history. Excel co-authoring makes it live. |
| Sign in with work email, approved by steves@maxkirwan.com.au | Microsoft 365 sign-in. Steve shares the file with each person ("Can edit"); nobody else can open it. |
| Secure password + recovery | Microsoft 365 handles it. |
| Preferred method drop-down | Data validation list. |
| Attachment icon for PDF quotes | The "Enquiry Quotes" SharePoint folder is synced into File Explorer; staff save the PDF as `E-0012.pdf` (the row's Ref) and the row's "Open E-0012.pdf" link works. No typing in the sheet. |
| Sticky note + who spoke to the customer | *Notes* and *Spoke To Customer* columns (or threaded comments on the row). |
| Allocation + per-department done boxes | *Service Advisor* / *Advisor Done* and *Parts Person* / *Parts Done*. *Status* becomes Complete when done. |
| Email parts@ when a quote is required | "Email parts" link appears when *Quote Required* = Yes; it opens a pre-written email to parts@. |
| Email advisors@ when an advisor must contact the customer | "Email advisors" link appears when *Contact Customer* = Yes. |
| Email + pop-up to a specific advisor | "Email <name>" link to the allocated advisor's or parts person's own address (from Staff). Outlook's arrival notification is the pop-up. Fully automatic sending would need Power Automate, which the dealership chose not to use. |

The *Setup Guide* sheet has the step-by-step for staff.
