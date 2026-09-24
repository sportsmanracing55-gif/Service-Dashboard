# Mazda Service Dashboard

A copy-and-paste leaderboard for the service department. Paste the advisor
figures straight out of Excel, Google Sheets or a DMS export and the dashboard
ranks the advisors, works out commission, and colour-codes MSI and repair order
counts against the department targets.

No build step, no server, no accounts. It is a single static page: open
`index.html` in a browser (or host the folder on GitHub Pages / the intranet)
and everything is stored in that browser's local storage.

## Customer enquiry tracker

The `tracker/` folder holds a separate, self-hosted **Preston Mazda Customer
Enquiry Log**: a live, spreadsheet-style sheet of customer enquiries with
work-email sign-in and manager approval, allocation to service advisors and
the parts department with per-department done boxes, PDF parts quotes,
interaction notes, and email + pop-up alerts. It uses this dashboard's fonts
and colours. See [`tracker/README.md`](tracker/README.md) for setup.

## What it shows

**Department**

| Tile | Source |
|---|---|
| Monthly labour gross | Sum of advisors, or the Department override. Shows the run-rate for the full month. |
| MSI score + survey returns | Survey-weighted average of advisors, or the override. Green 95+, Yellow 92–94.99, Red 91.99 and below. Surveys are measured against 1 per working day (Mon–Fri) per advisor. |
| Daily repair order count | Latest logged day from the daily paste (falls back to average per working day). Green 70+, Yellow 60–69, Red below 60. |
| Tyre sales count + % | Sum of advisors; % is tyres ÷ repair orders month to date, or the pasted Tyre %. |
| Wheel alignment sales | From the Department paste. |

**Daily repair orders** — a column per working day, coloured against the
70 / 60 thresholds, with a table view.

**Service advisor leaderboard** (ranked by labour gross, sortable by any column)

- Monthly labour gross sales
- Commission: 6% of labour gross profit, plus the MSI bonus when green or less
  the MSI deduction when red (rate and amounts are in Settings). If no GP column
  is pasted, labour gross sales is used as the base.
- MSI score (colour coded) and survey returns vs the working-day target
- Tyre sales
- BG product sales: Engine Oil & Fuel Treatment; Engine Oil Flush, Engine Oil
  Treatment & Fuel Treatment (the "flush trio"); Air Conditioning Sanitisation
- Daily repair order count (latest day, with month average)
- Red work sold % and Amber work sold %

## Pasting data

Click **Paste data** (or just press Ctrl+V / Cmd+V anywhere on the page). There
are three tabs; each has a **Copy template header** button and a **Preview** so you
can check what was recognised before applying.

### Advisors (monthly) – one row per advisor

```
Advisor      Labour Gross  Labour GP  MSI Score  Surveys  Tyres  BG Oil & Fuel  BG Flush Trio  A/C Sanitise  RO Count  Red %  Amber %
Sam Carter   £24,860       £17,150    96.4       14       38     22             9              11            196       48.2%  31.5%
```

Column headings are matched loosely, so your report's own headings will
usually work as they are. Currency symbols, commas and % signs are fine. A
`Total` row is skipped. Without a header row, columns are read in the template
order above. Every paste replaces the previous advisor table.

### Daily repair orders

Wide format (one column per advisor, optional `Total`):

```
Date        Sam Carter  Priya Shah  Jordan Lee  Chloe Evans
01/09/2026  19          18          16          15
```

or long format:

```
Date        Advisor     Count
01/09/2026  Sam Carter  19
```

Dates can be `01/09/2026`, `2026-09-01`, `1 Sep` or just `1`. Pasting replaces
existing rows for the same dates only, so you can paste one day at a time.

### Department (optional overrides)

```
Labour Gross      £84,385
MSI Score         94.3
Survey Returns    50
Tyre Sales        136
Tyre %            19.2
Wheel Alignments  54
Daily ROs         72
```

Anything you leave out is calculated from the advisor table.

Sample files to try are in `sample/`, and **Load sample data** on the empty
dashboard fills everything in one click.

## Settings

Dealership name, currency, commission rate, MSI bonus/deduction, the MSI and
daily RO thresholds and the surveys-per-day target are all editable under
**Settings**. **Export JSON** / **Import JSON** in the footer move the data
between browsers or keep a monthly backup.

The ◐ button toggles light/dark and ⛶ puts the page in full-screen display
mode with larger type for a workshop or showroom screen.

## Branding

Everything brand-related is in one place:

- **Colours** – the `:root` tokens at the top of `css/styles.css`
  (`--mz-red`, `--mz-black`, `--mz-silver`). Update the hex values to the exact
  references in the brand guide.
- **Font** – Mazda Type is loaded via `@font-face` from `assets/fonts/`. See
  `assets/fonts/README.md` for the file names to drop in. Until then the page
  falls back to Helvetica/Arial.
- **Logo** – `assets/mazda-logo.svg` is a placeholder wordmark. Replace it with
  the official logo file (white version, for the black header) and keep the file
  name.

## Files

```
index.html          page structure and dialogs
css/styles.css      brand tokens, light/dark themes, layout
js/parse.js         paste parsing (no DOM) – column matching, dates, numbers
js/app.js           state, calculations, rendering, dialogs
assets/             logo, favicon, fonts/
sample/             example pastes
```
