# Orders Schedule Dashboard

This project combines a private `Next.js` dashboard with two Python utilities for moving order data between `RetailCRM` and `Supabase`.

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
- [`app/api/run-script/route.ts`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\app\api\run-script\route.ts>): API route that whitelists and runs the Python scripts.
- [`lib/orders.ts`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\lib\orders.ts>): Supabase queries, date-range logic, and calendar week building.
- [`lib/env.ts`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\lib\env.ts>): environment variable resolution for the app.
- [`proxy.ts`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\proxy.ts>): Basic Auth guard for the deployed site.

Dashboard operations panel:

- The top of the dashboard includes `Run upload script` and `Run sync script` buttons.
- Those buttons call a server-side API route instead of executing scripts in the browser.
- The UI shows live status text plus captured `stdout` and `stderr` after each run.
- Only the two known project scripts are allowed to run through this route.

### 2. RetailCRM -> Supabase sync

[`sync_retailcrm_to_supabase.py`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\sync_retailcrm_to_supabase.py>) fetches orders from RetailCRM API v5, normalizes them, and upserts them into Supabase.

Key features:

- Reads pages of orders from RetailCRM.
- Upserts into Supabase by `retailcrm_id`.
- Supports dry runs.
- Can create the target Supabase table through the Supabase Management API.
- Sends Telegram alerts once per qualifying large order.

### 3. JSON -> RetailCRM uploader

[`upload_orders_to_retailcrm.py`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\upload_orders_to_retailcrm.py>) uploads mock or external orders from a JSON file to RetailCRM.

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
- Python 3 standard library only for integration scripts

## Local setup

### Requirements

- Node.js 20+
- npm
- Python 3.10+
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
PYTHON_EXECUTABLE=python
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
- The top action bar can run the Python integration scripts directly from the web UI.
- By default the backend uses `python` to launch scripts. If needed, override that with `PYTHON_EXECUTABLE`.

## Preparing Supabase

You can set up the table in either of these ways:

### Option 1. Run the SQL manually

Execute [`supabase_orders_schema.sql`](<D:\Other\Tests\Aleksandr Starkov's AI Tools Specialist Test Task\supabase_orders_schema.sql>) in your Supabase SQL editor.

### Option 2. Let the sync script create it

Run:

```bash
python sync_retailcrm_to_supabase.py --create-table
```

For this mode you need `SUPABASE_ACCESS_TOKEN`, and optionally `SUPABASE_PROJECT_REF` if it cannot be inferred from `SUPABASE_URL`.

## Syncing orders from RetailCRM to Supabase

Basic run:

```bash
python sync_retailcrm_to_supabase.py
```

Useful options:

```bash
python sync_retailcrm_to_supabase.py --dry-run
python sync_retailcrm_to_supabase.py --max-pages 2
python sync_retailcrm_to_supabase.py --max-orders 100
python sync_retailcrm_to_supabase.py --batch-size 100
python sync_retailcrm_to_supabase.py --delay 0.5
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
python upload_orders_to_retailcrm.py
```

Useful options:

```bash
python upload_orders_to_retailcrm.py --dry-run
python upload_orders_to_retailcrm.py --file mock_orders.json
python upload_orders_to_retailcrm.py --limit 10
python upload_orders_to_retailcrm.py --delay 0.5
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

If you also run the Python scripts in production or CI, add the RetailCRM, Supabase management, and Telegram variables described above.

## Typical workflow

1. Create the Supabase table.
2. Upload sample orders to RetailCRM with `upload_orders_to_retailcrm.py`.
3. Sync RetailCRM into Supabase with `sync_retailcrm_to_supabase.py`.
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
sync_retailcrm_to_supabase.py
upload_orders_to_retailcrm.py
```
