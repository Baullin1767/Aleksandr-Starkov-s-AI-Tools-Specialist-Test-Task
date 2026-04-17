# Orders Schedule Dashboard

This project combines a private `Next.js` dashboard with two TypeScript scripts for moving order data between `RetailCRM` and `Supabase`.

The main use case is:

1. Upload test or seed orders into RetailCRM from JSON.
2. Sync RetailCRM orders into Supabase.
3. View those orders in a private calendar-style dashboard.
4. Optionally send Telegram alerts for large `KZT` orders during sync.

## Project parts

### 1. Next.js dashboard

The web app lives in [`app`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\app>) and reads orders from Supabase on the server side.

Main behavior:

- Shows orders in a calendar grouped by day.
- Supports `from`, `to`, and `status` URL filters.
- Uses `shipment_date` when present.
- Falls back to `created_at` when `shipment_date` is empty.
- Protects the app with HTTP Basic Auth when credentials are configured.

Important files:

- [`app/page.tsx`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\app\page.tsx>): page entry, filters, and data loading.
- [`app/orders-calendar.tsx`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\app\orders-calendar.tsx>): interactive calendar UI and modal with daily order details.
- [`app/script-controls.tsx`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\app\script-controls.tsx>): top-of-screen action bar for running backend scripts from the UI.
- [`app/api/run-script/route.ts`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\app\api\run-script\route.ts>): API route that whitelists and runs the TypeScript integration scripts.
- [`lib/orders.ts`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\lib\orders.ts>): Supabase queries, date-range logic, and calendar week building.
- [`lib/env.ts`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\lib\env.ts>): environment variable resolution for the app.
- [`proxy.ts`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\proxy.ts>): Basic Auth guard for the deployed site.

Dashboard operations panel:

- The top of the dashboard includes `Run upload script` and `Run sync script` buttons.
- Those buttons call a server-side API route instead of executing scripts in the browser.
- The UI shows live status text plus captured `stdout` and `stderr` after each run.
- Only the two known project scripts are allowed to run through this route.

### 2. RetailCRM -> Supabase sync

[`sync_retailcrm_to_supabase.ts`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\sync_retailcrm_to_supabase.ts>) fetches orders from RetailCRM API v5, normalizes them, and upserts them into Supabase.

Key features:

- Reads pages of orders from RetailCRM.
- Upserts into Supabase by `retailcrm_id`.
- Supports dry runs.
- Can create the target Supabase table through the Supabase Management API.
- Sends Telegram alerts once per qualifying large order.

### 3. JSON -> RetailCRM uploader

[`upload_orders_to_retailcrm.ts`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\upload_orders_to_retailcrm.ts>) uploads mock or external orders from a JSON file to RetailCRM.

Key features:

- Validates incoming JSON structure.
- Normalizes items and required RetailCRM fields.
- Creates new orders or edits existing ones when `externalId` already exists.
- Forces a configured order currency, defaulting to `KZT`.

### 4. Supabase schema

[`supabase_orders_schema.sql`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\supabase_orders_schema.sql>) contains the SQL schema for the `retailcrm_orders` table used by the dashboard and sync process.

Stored data includes:

- RetailCRM identifiers and metadata
- customer and contact fields
- pricing and currency
- status and shipment timestamps
- raw order JSON
- Telegram alert tracking columns

## Tech stack

- `Next.js 16`
- `React 19`
- `TypeScript`
- `@supabase/supabase-js`
- `tsx` for running TypeScript CLI scripts

## Local setup

### Requirements

- Node.js 20+
- npm
- A Supabase project
- A RetailCRM account with API access

### Install frontend dependencies

```bash
npm install
```

### Configure environment variables

Start from [`.env.example`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\.env.example>) and add the missing values you need for your workflow.

Dashboard variables:

```env
NEXT_PUBLIC_SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
ORDERS_TABLE=retailcrm_orders
DISPLAY_TIMEZONE=Europe/Moscow
DISPLAY_LOCALE=en-GB
BASIC_AUTH_USERNAME=
BASIC_AUTH_PASSWORD=
```

RetailCRM sync and upload variables:

```env
RETAILCRM_URL=
RETAILCRM_API_KEY=
RETAILCRM_SITE_CODE=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
SUPABASE_SCHEMA=public
SUPABASE_ORDERS_TABLE=retailcrm_orders
SUPABASE_UPSERT_CONFLICT_COLUMN=retailcrm_id
SUPABASE_ACCESS_TOKEN=
SUPABASE_PROJECT_REF=
REQUEST_TIMEOUT_SECONDS=30
REQUEST_DELAY_SECONDS=0.15
RETAILCRM_PAGE_LIMIT=50
SUPABASE_BATCH_SIZE=200
ORDERS_FILE=mock_orders.json
ORDER_EXTERNAL_ID_PREFIX=mock-order
ORDER_CURRENCY=KZT
```

Optional Telegram alert variables:

```env
TELEGRAM_ALERTS_ENABLED=false
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_ALERT_MIN_TOTAL_KZT=50000
```

## Running the dashboard

Start the app:

```bash
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

Notes:

- The page is rendered dynamically on the server.
- Supabase is queried with a privileged server-side key.
- If `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD` are set, every route except static assets is protected by Basic Auth.
- The top action bar can run the TypeScript integration scripts directly from the web UI.

## Preparing Supabase

You can set up the table in either of these ways:

### Option 1. Run the SQL manually

Execute [`supabase_orders_schema.sql`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\supabase_orders_schema.sql>) in your Supabase SQL editor.

### Option 2. Let the sync script create it

Run:

```bash
npm run sync -- --create-table
```

For this mode you need `SUPABASE_ACCESS_TOKEN`, and optionally `SUPABASE_PROJECT_REF` if it cannot be inferred from `SUPABASE_URL`.

## Syncing orders from RetailCRM to Supabase

Basic run:

```bash
npm run sync
```

Useful options:

```bash
npm run sync -- --dry-run
npm run sync -- --max-pages 2
npm run sync -- --max-orders 100
npm run sync -- --batch-size 100
npm run sync -- --delay 0.5
```

What the script does:

- fetches paginated orders from RetailCRM
- maps them into the Supabase row structure
- upserts by `retailcrm_id`
- records `synced_at`
- optionally sends Telegram alerts for large `KZT` orders

Telegram alerts are sent only when:

- `TELEGRAM_ALERTS_ENABLED=true`
- order currency is `KZT`
- `total_summ >= TELEGRAM_ALERT_MIN_TOTAL_KZT`
- `telegram_alert_sent_at` is still empty in Supabase

You can also launch this script from the top button inside the dashboard.

## Uploading orders to RetailCRM from JSON

Basic run:

```bash
npm run upload
```

Useful options:

```bash
npm run upload -- --dry-run
npm run upload -- --file mock_orders.json
npm run upload -- --limit 10
npm run upload -- --delay 0.5
```

Expected JSON shape:

```json
[
  {
    "externalId": "demo-0001",
    "firstName": "Alex",
    "lastName": "Smith",
    "phone": "+70000000000",
    "email": "alex@example.com",
    "status": "new",
    "items": [
      {
        "productName": "Sample item",
        "quantity": 1,
        "initialPrice": 15000
      }
    ]
  }
]
```

Behavior details:

- If the source order already has `currency`, the uploader still normalizes it to `ORDER_CURRENCY`.
- If an order with the same `externalId` already exists, the script updates it instead of failing.
- The uploader requests reference data from RetailCRM before processing orders.
- You can also launch this script from the top button inside the dashboard.

## Deployment notes

This repo is ready for a standard `Next.js` deployment, including Vercel.

Set these environment variables in production:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ORDERS_TABLE`
- `DISPLAY_TIMEZONE`
- `DISPLAY_LOCALE`
- `BASIC_AUTH_USERNAME`
- `BASIC_AUTH_PASSWORD`

If you also run the TypeScript scripts in production or CI, add the RetailCRM, Supabase management, and Telegram variables described above.

## Typical workflow

1. Create the Supabase table.
2. Upload sample orders to RetailCRM with `npm run upload`.
3. Sync RetailCRM into Supabase with `npm run sync`.
4. Open the Next.js dashboard and filter the schedule by date or status.

## Current project structure

```text
app/
  api/run-script/route.ts
  globals.css
  layout.tsx
  orders-calendar.tsx
  page.tsx
  script-controls.tsx
lib/
  env.ts
  orders-shared.ts
  orders.ts
mock_orders.json
proxy.ts
supabase_orders_schema.sql
sync_retailcrm_to_supabase.ts
sync_retailcrm_to_supabase.py  (legacy)
upload_orders_to_retailcrm.ts
upload_orders_to_retailcrm.py  (legacy)
```

##Prompts what I use:

Write script what upload orders to RetailCRM api from mock_orders.json. 
Use docs: https://docs.retailcrm.ru/Developers/API. 
Make example.env with vars what you need for this.
Add to example.env vars what we need for this.

Write script to take orders from RetailCRM API to Supabase. 
Use RetailCRM docs: https://docs.retailcrm.ru/Developers/API and Supabase docs: https://supabase.com/docs/guides/api.

Use API supabase and add creation table for my db. Add check exist or not the table. And create table into Supabase if it needs.

*plan-mode*
Now I need make web page with the schedule of orders from Supabase.

# Generated plan: Orders Schedule Web Page on Supabase + Vercel

## Summary
Build a new `Next.js` app in this repo as a small private dashboard that reads `public.retailcrm_orders` from Supabase server-side and renders a calendar-style orders schedule. The first version will schedule orders by `shipment_date`, support date-range and status filtering, and be prepared for deployment on Vercel with environment-based configuration and simple HTTP basic auth protection.

## Key Changes
- Add a new `Next.js` App Router frontend in TypeScript, optimized for Vercel deployment.
- Implement a server-only Supabase data layer that queries `retailcrm_orders` with:
    - primary schedule field: `shipment_date`
    - filters: date range and `status`
    - ordering: ascending by `shipment_date`, then `created_at`
    - fields shown in UI: order number, status, customer name, phone/email if present, total amount, shipment date, and a compact items summary
- Render a schedule UI as:
    - month or week-oriented calendar/date-grouped schedule page
    - each date cell/group lists that day’s orders
    - empty-state handling for days/ranges with no orders
- Protect the app with simple credentials via middleware/basic auth style env vars so the deployed page is not public.
- Add Vercel-ready config and docs:
    - required env vars for Supabase URL and server-side key
    - auth credentials env vars
    - local run instructions
    - Vercel project setup steps and env var mapping

## Public Interfaces / Config
- New app env vars:
    - `NEXT_PUBLIC_SUPABASE_URL`
    - `SUPABASE_SERVICE_ROLE_KEY` or equivalent server-only secret
    - `ORDERS_TABLE=retailcrm_orders` default
    - `BASIC_AUTH_USERNAME`
    - `BASIC_AUTH_PASSWORD`
    - optional timezone/display locale if we want Moscow formatting explicitly
- New server query contract:
    - inputs: `from`, `to`, `status`
    - output per order: normalized schedule card shape derived from the Supabase row, with safe formatting for missing optional fields
- New route shape:
    - main page at `/`
    - filters reflected in query params so the page is shareable/bookmarkable

## Test Plan
- Verify server-side query returns only orders with `shipment_date` in the selected range.
- Verify status filter narrows results correctly and empty filter shows all statuses.
- Verify orders with missing optional display fields still render without crashing.
- Verify page handles no-results states cleanly.
- Verify authentication blocks anonymous access and allows valid credentials.
- Verify production build succeeds for Vercel and local dev instructions work end-to-end.

## Assumptions
- We will create a fresh frontend app in this repo because no existing web app is present.
- “Schedule of orders” means a date-driven operations view, not a CRM board.
- `shipment_date` is the only scheduling source for v1; orders without it will be excluded unless you later want a fallback to `created_at`.
- The deployed page should be private but lightweight, so basic auth is preferred over full Supabase login for v1.
- Deployment in this phase means the codebase and configuration will be ready for Vercel immediately; actual live deployment can follow as the next execution step.

*plan-mode*
Make for each date just count of orders and when user tap to data open popup window with more information

# Generated plan: Date Count Calendar With Order Details Popup

## Summary
Change the calendar so each date cell shows only the date header and the count of orders for that day, instead of rendering inline order cards inside the grid. When the user taps or clicks a date that has orders, open a popup modal with the full list of orders for that date using the existing order detail fields.

## Key Changes
- Split the current page into:
    - a server-rendered container that fetches filters, orders, status options, and calendar weeks
    - a small client-side calendar interaction component that manages the open popup state
- Keep the existing Supabase query and order normalization in `lib/orders.ts`, since it already returns the fields needed for the popup list.
- Change each calendar day tile to:
    - show weekday, day number, full date label, and a single clickable count badge or button
    - remove inline order cards from the calendar grid
    - keep empty days visually quiet and non-interactive
- Add a popup modal that opens for one selected date and renders:
    - the selected date title
    - the count of orders for that day
    - the list of orders for that day with the current detail set: order number, customer, status, created/shipment label, total, contact, and items summary
- Add modal behavior details so the implementation is decision-complete:
    - open on click/tap of the day count button
    - close on backdrop click, close button click, and `Escape`
    - lock background scroll while open
    - keep keyboard focus inside the modal for accessibility
- Preserve existing filter behavior:
    - `from`, `to`, and `status` stay in the URL
    - changing filters re-renders the calendar and popup data source from the server
    - popup state is local UI state only and does not need to be reflected in the URL

## Public Interfaces / Behavior
- Keep the route at `/` with the same query params: `from`, `to`, `status`.
- Keep the current `OrderScheduleItem` shape unless a small helper field is added purely for client rendering convenience.
- Introduce a client calendar/popup component that receives pre-fetched week data from the server page as props.
- Date cells with `0` orders should not open a popup; only dates with orders should be interactive.

## Test Plan
- Verify the calendar no longer renders inline order cards inside day cells.
- Verify a date with orders opens a popup showing all orders for that date.
- Verify empty dates are not clickable and do not open a popup.
- Verify popup close behavior works via close button, backdrop click, and `Escape`.
- Verify keyboard users can open the popup and navigate it without focus escaping behind the overlay.
- Verify filters still change the visible counts and the popup contents correctly for the selected range/status.
- Verify the layout works on narrow screens where the original inline cards were overflowing.

## Assumptions
- “Tap to data” means tapping/clicking the date’s order count area in the calendar.
- “More information” means the full per-order list for that selected date, not an aggregated report.
- The popup should reuse the existing order details already shown in the old inline cards rather than introducing new backend fields.
- The modal is an in-page overlay, not a separate route or browser popup window.


Fix this bugs
[browser] Uncaught Error: Missing required environment variable. Expected one of: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_URL
at requireEnv (file://D:/Other/Tests/Aleksandr Starkov's AI Tools Specialist Test Task/.next/dev/static/chunks/_0uyfs6w._.js:17:11)
at <unknown> (file://D:/Other/Tests/Aleksandr Starkov's AI Tools Specialist Test Task/.next/dev/static/chunks/_0uyfs6w._.js:20:18)
at <unknown> (file://D:/Other/Tests/Aleksandr Starkov's AI Tools Specialist Test Task/.next/dev/static/chunks/_0uyfs6w._.js:48:139)
at <unknown> (file://D:/Other/Tests/Aleksandr Starkov's AI Tools Specialist Test Task/.next/dev/static/chunks/_0uyfs6w._.js:249:142)
at requireModule (file://D:/Other/Tests/Aleksandr Starkov's AI Tools Specialist Test Task/.next/dev/static/chunks/node_modules_next_dist_compiled_react-server-dom-turbopack_0p3wegg._.js:95:84)
at initializeModuleChunk (file://D:/Other/Tests/Aleksandr Starkov's AI Tools Specialist Test Task/.next/dev/static/chunks/node_modules_next_dist_compiled_react-server-dom-turbopack_0p3wegg._.js:1110:38)
at readChunk (file://D:/Other/Tests/Aleksandr Starkov's AI Tools Specialist Test Task/.next/dev/static/chunks/node_modules_next_dist_compiled_react-server-dom-turbopack_0p3wegg._.js:846:38)
at react_stack_bottom_frame (file://D:/Other/Tests/Aleksandr Starkov's AI Tools Specialist Test Task/.next/dev/static/chunks/node_modules_next_dist_compiled_react-dom_058-ah~._.js:15101:20)
at resolveLazy (file://D:/Other/Tests/Aleksandr Starkov's AI Tools Specialist Test Task/.next/dev/static/chunks/node_modules_next_dist_compiled_react-dom_058-ah~._.js:3866:20)
at beginWork (file://D:/Other/Tests/Aleksandr Starkov's AI Tools Specialist Test Task/.next/dev/static/chunks/node_modules_next_dist_compiled_react-dom_058-ah~._.js:6665:77)
at runWithFiberInDEV (file://D:/Other/Tests/Aleksandr Starkov's AI Tools Specialist Test Task/.next/dev/static/chunks/node_modules_next_dist_compiled_react-dom_058-ah~._.js:965:131)
at performUnitOfWork (file://D:/Other/Tests/Aleksandr Starkov's AI Tools Specialist Test Task/.next/dev/static/chunks/node_modules_next_dist_compiled_react-dom_058-ah~._.js:9555:97)
at workLoopConcurrentByScheduler (file://D:/Other/Tests/Aleksandr Starkov's AI Tools Specialist Test Task/.next/dev/static/chunks/node_modules_next_dist_compiled_react-dom_058-ah~._.js:9551:75)
at renderRootConcurrent (file://D:/Other/Tests/Aleksandr Starkov's AI Tools Specialist Test Task/.next/dev/static/chunks/node_modules_next_dist_compiled_react-dom_058-ah~._.js:9534:71)
at performWorkOnRoot (file://D:/Other/Tests/Aleksandr Starkov's AI Tools Specialist Test Task/.next/dev/static/chunks/node_modules_next_dist_compiled_react-dom_058-ah~._.js:9061:150)
at performWorkOnRootViaSchedulerTask (file://D:/Other/Tests/Aleksandr Starkov's AI Tools Specialist Test Task/.next/dev/static/chunks/node_modules_next_dist_compiled_react-dom_058-ah~._.js:10255:26)
at performWorkUntilDeadline (file://D:/Other/Tests/Aleksandr Starkov's AI Tools Specialist Test Task/.next/dev/static/chunks/node_modules_next_dist_compiled_0rpq4pf._.js:2647:72)
at Home (app\page.tsx:126:11)
124 |           </div>
125 |         ) : (
> 126 |           <OrdersCalendar weeks={weeks} />
|           ^
127 |         )}
128 |       </section>
129 |     </main>

*plan-mode*
Now add telegram integration i need get allert about orders more then 50,000 ₸ by telegram bot

# Generated plan: Telegram Alerts For Orders Above 50,000 ₸

## Summary
Add Telegram bot notifications to the existing `sync_retailcrm_to_supabase.py` pipeline so alerts are sent server-side during sync, not from the Next.js page. The alert should fire **once per order** when an order’s `total_summ` is at least `50,000` and the order has not already been alerted.

## Implementation Changes
- Extend the Supabase table with alert-tracking fields:
    - `telegram_alert_sent_at timestamptz null`
    - `telegram_alert_message_id bigint null`
- Keep the trigger source in the Python sync script, immediately after successful upsert of each batch, because that is the only existing backend process that already sees fresh RetailCRM data.
- Add Telegram config to `.env.example`, README, and runtime env handling:
    - `TELEGRAM_BOT_TOKEN`
    - `TELEGRAM_CHAT_ID`
    - `TELEGRAM_ALERT_MIN_TOTAL_KZT=50000`
    - Optional `TELEGRAM_ALERTS_ENABLED=true`
- In `sync_retailcrm_to_supabase.py`:
    - add a small Telegram client using the Bot API `sendMessage` endpoint
    - select existing rows for the current batch by `retailcrm_id` before or after upsert to read `telegram_alert_sent_at`
    - identify rows where `currency == "KZT"` and `total_summ >= threshold`
    - send an alert only when `telegram_alert_sent_at` is null
    - after a successful Telegram send, update that order row with `telegram_alert_sent_at=now()` and `telegram_alert_message_id`
    - if Telegram send fails, log the error and continue sync without marking the alert as sent
- Alert message format should be fixed and human-readable, including:
    - order number / RetailCRM ID
    - customer name
    - total in KZT
    - status
    - shipment date if present, otherwise created date
    - contact label if available
- Keep the Next.js dashboard unchanged unless you want a later follow-up to show “alert sent” state in the UI.

## Public Interfaces / Behavior
- Database contract change:
    - `public.retailcrm_orders` gains two nullable fields for Telegram delivery state
- Environment contract change:
    - Telegram env vars become required only when `TELEGRAM_ALERTS_ENABLED=true`
- Runtime behavior:
    - qualifying order = `currency === "KZT"` and `total_summ >= 50000`
    - alert is sent once per order lifetime in this v1
    - existing already-synced qualifying orders with null alert flag will alert on the first sync after rollout

## Test Plan
- Unit-level script tests or targeted dry-run-style checks for:
    - KZT order at `49999.99` does not alert
    - KZT order at `50000` does alert
    - non-KZT order above `50000` does not alert
    - qualifying order with existing `telegram_alert_sent_at` does not re-alert
    - Telegram API failure does not mark the row as alerted
- Integration check against Supabase:
    - sync a qualifying order, confirm Telegram message sent and alert fields persisted
    - rerun sync for the same order, confirm no second message
- Documentation check:
    - README setup includes bot creation, obtaining chat ID, and required env vars

## Assumptions
- Telegram delivery should be tied to the sync job, not to page loads or client-side actions.
- “More than 50,000 ₸” will be implemented as `>= 50000` to match the threshold boundary cleanly; if you want strict `> 50000`, that is a one-line rule change.
- Currency comparison will use the stored `currency` field and only alert for explicit `KZT` rows.
- No backfill suppression is needed; once deployed, the next sync will alert for any existing qualifying orders that have never been marked as alerted.

Can you convert sync_retailcrm_to_supabase and upload_orders_to_retailcrm to TypeScript?
And match it with WebApp?