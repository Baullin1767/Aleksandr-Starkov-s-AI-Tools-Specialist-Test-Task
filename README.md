# Orders Schedule Dashboard

This repository now includes a private `Next.js` dashboard for viewing the shipment schedule of orders stored in Supabase.

## What it does

- Reads orders from `public.retailcrm_orders`
- Uses `shipment_date` as the schedule date
- Filters by date range and order status
- Renders a calendar-style schedule page
- Protects the deployed page with HTTP basic auth
- Fits Vercel deployment out of the box

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` values into your local `.env` and fill in the real secrets:

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

3. Start the app:

```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000)

## Vercel deployment

1. Import this repository into Vercel.
2. Set the framework preset to `Next.js` if Vercel does not detect it automatically.
3. Add these environment variables in the Vercel project settings:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY` or `SUPABASE_SERVICE_ROLE_KEY`
   - `ORDERS_TABLE`
   - `DISPLAY_TIMEZONE`
   - `DISPLAY_LOCALE`
   - `BASIC_AUTH_USERNAME`
   - `BASIC_AUTH_PASSWORD`
4. Deploy.

## Notes

- Orders without `shipment_date` are excluded from the schedule by design in this first version.
- The page reads Supabase data on the server, so the service role key is not exposed to the browser.
- For compatibility with the existing sync scripts, the dashboard accepts both the new env names and the legacy `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` names already used in this repo.
