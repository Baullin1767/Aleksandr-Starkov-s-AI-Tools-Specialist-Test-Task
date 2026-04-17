create table if not exists public.retailcrm_orders (
    retailcrm_id bigint primary key,
    retailcrm_external_id text,
    number text,
    site text,
    status text,
    status_group text,
    order_type text,
    order_method text,
    first_name text,
    last_name text,
    phone text,
    email text,
    customer_id bigint,
    customer_external_id text,
    customer_comment text,
    manager_comment text,
    currency text,
    total_summ numeric,
    prepay_sum numeric,
    purchase_summ numeric,
    mark numeric,
    created_at timestamptz,
    updated_at timestamptz,
    status_updated_at timestamptz,
    shipment_date timestamptz,
    is_deleted boolean not null default false,
    delivery_code text,
    delivery_service_name text,
    items jsonb not null default '[]'::jsonb,
    delivery jsonb not null default '{}'::jsonb,
    custom_fields jsonb not null default '{}'::jsonb,
    raw_order jsonb not null,
    synced_at timestamptz not null default timezone('utc', now()),
    telegram_alert_sent_at timestamptz,
    telegram_alert_message_id bigint
);

alter table public.retailcrm_orders
    add column if not exists telegram_alert_sent_at timestamptz;

alter table public.retailcrm_orders
    add column if not exists telegram_alert_message_id bigint;

create index if not exists retailcrm_orders_number_idx
    on public.retailcrm_orders (number);

create index if not exists retailcrm_orders_status_idx
    on public.retailcrm_orders (status);

create index if not exists retailcrm_orders_created_at_idx
    on public.retailcrm_orders (created_at);
