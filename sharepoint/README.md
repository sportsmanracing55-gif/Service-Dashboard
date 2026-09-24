# Preston Mazda Customer Enquiry Log – SharePoint version

`Preston Mazda Customer Enquiry Log.xlsx` is the no-install alternative to the
Node.js tracker in `../tracker`. It is a shared Excel workbook kept in
SharePoint: everyone opens the same file, sees each other's edits live, and
signs in with their normal Microsoft 365 account. A Power Automate flow sends
the email alerts and Teams pop-ups.

Rebuild the workbook with `python3 build_workbook.py` (needs `openpyxl`).

## Sheets

| Sheet | Purpose |
|---|---|
| Setup Guide | Step-by-step: putting it in SharePoint, sharing (approval), daily use, and building the alert flow. |
| Enquiry Log | The log. One row per enquiry: Ref, Date Logged, Logged By, Customer Name, Registration, Contact Number, Email Address, Preferred Method (Call / Text / Email drop-down), Enquiry, Quote File + Quote Link, Notes + Spoke To Customer, Service Advisor + Contact Customer + Advisor Done, Parts Person + Quote Required + Parts Done, Status, and five grey alert-tracking columns the flow fills in. |
| Staff | Service advisors and parts staff with emails. Feeds the drop-downs and the flow's lookups. |
| Settings | Dealership name, approver, alert mailboxes, and the SharePoint folder URL for PDF quotes. |

## How each requirement is met

| Requirement | How |
|---|---|
| Secure, not on the internet, but live and shared | Lives in the dealership's own Microsoft 365 tenant on SharePoint, under IT's controls, with version history. Excel co-authoring makes it live. |
| Sign in with work email, approved by steves@maxkirwan.com.au | Microsoft 365 sign-in. Steve shares the file with each person ("Can edit"); nobody else can open it. |
| Secure password + recovery | Microsoft 365 handles it. |
| Preferred method drop-down | Data validation list. |
| Attachment icon for PDF quotes | PDFs go in an "Enquiry Quotes" folder; typing the file name in *Quote File* turns *Quote Link* into an "Open quote" link. |
| Sticky note + who spoke to the customer | *Notes* and *Spoke To Customer* columns (or threaded comments on the row). |
| Allocation + per-department done boxes | *Service Advisor* / *Advisor Done* and *Parts Person* / *Parts Done*. *Status* becomes Complete when done. |
| Email parts@ when a quote is required | Flow condition A on *Quote Required* = Yes. |
| Email advisors@ when an advisor must contact the customer | Flow condition B on *Contact Customer* = Yes. |
| Email + pop-up to a specific advisor | Flow condition C: email plus a Teams message from the Flow bot when *Service Advisor* changes (and E when parts finish the quote). |

The full flow recipe is on the *Setup Guide* sheet.
