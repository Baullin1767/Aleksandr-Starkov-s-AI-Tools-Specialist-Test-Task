import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/135.0.0.0 Safari/537.36";

export interface Logger {
  log(message: string): void;
  error(message: string): void;
}

export interface SyncOptions {
  envFile?: string;
  pageLimit?: number;
  maxPages?: number;
  maxOrders?: number;
  batchSize?: number;
  delay?: number;
  dryRun?: boolean;
  createTable?: boolean;
}

// ----- Utilities -----

function loadEnv(envFile = ".env"): Record<string, string> {
  const result: Record<string, string> = {};
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, "utf-8").split("\n");
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || !line.includes("=")) continue;
      const eqIdx = line.indexOf("=");
      const key = line.slice(0, eqIdx).trim();
      let value = line.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value) result[key] = value;
  }
  return result;
}

function toFloat(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function utcNowIso(): string {
  return new Date().toISOString();
}

function parseBoolEnv(value: string | undefined, defaultVal = false): boolean {
  if (value === undefined) return defaultVal;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function classifySupabaseKey(key: string): string {
  if (key.startsWith("sb_publishable_")) return "publishable";
  if (key.startsWith("sb_secret_")) return "secret";
  if (key.split(".").length === 3) {
    try {
      const payloadPart = key.split(".")[1];
      const padded = payloadPart + "=".repeat((4 - (payloadPart.length % 4)) % 4);
      const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(
        Buffer.from(base64, "base64").toString("utf-8"),
      ) as Record<string, unknown>;
      if (payload.role === "service_role") return "legacy_service_role";
      if (payload.role === "anon") return "legacy_anon";
    } catch {
      // ignore decode errors
    }
    return "jwt";
  }
  return "unknown";
}

function inferProjectRef(supabaseUrl: string): string | null {
  try {
    const host = new URL(supabaseUrl).hostname;
    const suffix = ".supabase.co";
    if (!host.endsWith(suffix)) return null;
    const ref = host.slice(0, -suffix.length);
    return ref || null;
  } catch {
    return null;
  }
}

function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----- Order transformation -----

function orderToRow(
  order: Record<string, unknown>,
  syncedAt: string,
): Record<string, unknown> {
  const customer =
    typeof order.customer === "object" && order.customer !== null
      ? (order.customer as Record<string, unknown>)
      : {};
  const delivery =
    typeof order.delivery === "object" && order.delivery !== null
      ? (order.delivery as Record<string, unknown>)
      : {};

  return {
    retailcrm_id: order.id,
    retailcrm_external_id: order.externalId,
    number: order.number,
    site: order.site,
    status: order.status,
    status_group: order.statusGroup,
    order_type: order.orderType,
    order_method: order.orderMethod,
    first_name: order.firstName,
    last_name: order.lastName,
    phone: order.phone,
    email: order.email,
    customer_id: customer.id,
    customer_external_id: customer.externalId,
    customer_comment: order.customerComment,
    manager_comment: order.managerComment,
    currency: order.currency,
    total_summ: toFloat(order.totalSumm),
    prepay_sum: toFloat(order.prepaySum),
    purchase_summ: toFloat(order.purchaseSumm),
    mark: toFloat(order.mark),
    created_at: order.createdAt,
    updated_at: order.updatedAt,
    status_updated_at: order.statusUpdatedAt,
    shipment_date: order.shipmentDate,
    is_deleted: Boolean(order.deleted ?? false),
    delivery_code: delivery.code,
    delivery_service_name: delivery.serviceName,
    items: Array.isArray(order.items) ? order.items : [],
    delivery,
    custom_fields:
      typeof order.customFields === "object" &&
      order.customFields !== null &&
      !Array.isArray(order.customFields)
        ? order.customFields
        : {},
    raw_order: order,
    synced_at: syncedAt,
  };
}

// ----- Telegram alert helpers -----

function buildCustomerName(row: Record<string, unknown>): string {
  const parts = [
    String(row.first_name ?? "").trim(),
    String(row.last_name ?? "").trim(),
  ].filter(Boolean);
  return parts.join(" ") || "Unknown customer";
}

function buildContactLabel(row: Record<string, unknown>): string {
  return String(row.phone ?? row.email ?? "No contact data");
}

function buildScheduleLabel(row: Record<string, unknown>): string {
  const scheduleValue = row.shipment_date ?? row.created_at;
  if (!scheduleValue) return "Not specified";
  const name = row.shipment_date ? "Shipment date" : "Created at";
  return `${name}: ${scheduleValue}`;
}

function formatTelegramTotal(
  total: number | null,
  currency: string | null,
): string {
  if (total === null) return "Not specified";
  const formatted = total.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (currency === "KZT") return `${formatted} KZT`;
  if (currency) return `${formatted} ${currency}`;
  return formatted;
}

function isTelegramAlertCandidate(
  row: Record<string, unknown>,
  minTotal: number,
): boolean {
  const currency = String(row.currency ?? "").toUpperCase();
  const total = row.total_summ;
  return currency === "KZT" && typeof total === "number" && total >= minTotal;
}

function buildTelegramAlertMessage(row: Record<string, unknown>): string {
  const orderNumber = row.number ?? `#${row.retailcrm_id}`;
  const retailcrmId = row.retailcrm_id;
  const customerName = buildCustomerName(row);
  const totalLabel = formatTelegramTotal(
    row.total_summ as number | null,
    row.currency as string | null,
  );
  const status = row.status ?? "unknown";
  const contactLabel = buildContactLabel(row);
  const scheduleLabel = buildScheduleLabel(row);

  return [
    "<b>Large order alert</b>",
    `Order: <b>${htmlEscape(String(orderNumber))}</b> (RetailCRM ID: ${htmlEscape(String(retailcrmId))})`,
    `Customer: ${htmlEscape(customerName)}`,
    `Total: <b>${htmlEscape(totalLabel)}</b>`,
    `Status: ${htmlEscape(String(status))}`,
    htmlEscape(scheduleLabel),
    `Contact: ${htmlEscape(contactLabel)}`,
  ].join("\n");
}

// ----- HTTP helper -----

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ----- RetailCRM client -----

class RetailCrmClient {
  private baseUrl: string;

  constructor(
    baseUrl: string,
    private apiKey: string,
    private timeout: number = 30,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async listOrders(
    page: number,
    limit: number,
    site?: string,
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(limit),
    });
    if (site) params.set("site", site);

    const url = `${this.baseUrl}/orders?${params.toString()}`;
    const response = await fetchWithTimeout(
      url,
      { headers: { "X-API-KEY": this.apiKey, Accept: "application/json" } },
      this.timeout * 1000,
    );

    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(
        `Expected JSON from RetailCRM /orders, got: ${text.slice(0, 500)}`,
      );
    }

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} from RetailCRM /orders: ${text.slice(0, 500)}`,
      );
    }

    const record = data as Record<string, unknown>;
    if (!record.success) {
      throw new Error(
        `Unexpected RetailCRM response: ${JSON.stringify(record)}`,
      );
    }
    return record;
  }
}

// ----- Supabase Management API client -----

class SupabaseManagementClient {
  constructor(
    private accessToken: string,
    private projectRef: string,
    private timeout: number = 30,
  ) {}

  async createOrdersTable(schema: string, table: string): Promise<void> {
    const tableQualified = `${schema}.${table}`;
    const query = `
create table if not exists ${tableQualified} (
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

alter table ${tableQualified}
    add column if not exists telegram_alert_sent_at timestamptz;

alter table ${tableQualified}
    add column if not exists telegram_alert_message_id bigint;

create index if not exists ${table}_number_idx on ${tableQualified} (number);
create index if not exists ${table}_status_idx on ${tableQualified} (status);
create index if not exists ${table}_created_at_idx on ${tableQualified} (created_at);

alter table ${tableQualified} enable row level security;

grant all privileges on table ${tableQualified} to service_role;

do $$
begin
    if not exists (
        select 1 from pg_policies
        where schemaname = '${schema}'
          and tablename = '${table}'
          and policyname = '${table}_service_role_all'
    ) then
        execute 'create policy ${table}_service_role_all on ${tableQualified} for all to service_role using (true) with check (true)';
    end if;
end
$$;`.trim();

    const url = `https://api.supabase.com/v1/projects/${encodeURIComponent(this.projectRef)}/database/migrations`;
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": BROWSER_USER_AGENT,
        },
        body: JSON.stringify({ name: `create_${table}_table`, query }),
      },
      this.timeout * 1000,
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `Supabase Management API error ${response.status}: ${body.slice(0, 500)}`,
      );
    }
  }
}

// ----- Telegram client -----

class TelegramClient {
  constructor(
    private botToken: string,
    private chatId: string,
    private timeout: number = 30,
  ) {}

  async sendMessage(text: string): Promise<number | null> {
    const url = `https://api.telegram.org/bot${encodeURIComponent(this.botToken)}/sendMessage`;
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      },
      this.timeout * 1000,
    );

    const data = (await response.json()) as {
      ok: boolean;
      result?: { message_id?: number };
    };
    if (!data.ok) {
      throw new Error(`Unexpected Telegram response: ${JSON.stringify(data)}`);
    }
    return data.result?.message_id ?? null;
  }
}

// ----- Supabase helpers -----

function isRlsError(error: {
  message?: string;
  details?: string;
  hint?: string;
} | null): boolean {
  if (!error) return false;
  const text =
    `${error.message ?? ""} ${error.details ?? ""} ${error.hint ?? ""}`.toLowerCase();
  return text.includes("row-level security") || text.includes("row level security");
}

// ----- Telegram batch processing -----

async function sendTelegramAlertsForBatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  table: string,
  telegram: TelegramClient,
  rows: Record<string, unknown>[],
  minTotalKzt: number,
  logger: Logger,
): Promise<number> {
  const ids = rows
    .map((r) => r.retailcrm_id)
    .filter((id) => id !== null && id !== undefined)
    .map((id) => Number(id));

  const { data: alertStateRows, error: fetchError } = await supabase
    .from(table)
    .select("retailcrm_id,telegram_alert_sent_at,telegram_alert_message_id")
    .in("retailcrm_id", ids);

  if (fetchError) {
    throw new Error(`Failed to fetch alert states: ${fetchError.message}`);
  }

  const alertStateMap = new Map<number, Record<string, unknown>>();
  for (const row of (alertStateRows ?? []) as Record<string, unknown>[]) {
    const id = Number(row.retailcrm_id);
    if (!Number.isNaN(id)) alertStateMap.set(id, row);
  }

  let alertsSent = 0;

  for (const row of rows) {
    const retailcrmId = row.retailcrm_id;
    if (retailcrmId === null || retailcrmId === undefined) continue;
    if (!isTelegramAlertCandidate(row, minTotalKzt)) continue;

    const existingState = alertStateMap.get(Number(retailcrmId)) ?? {};
    if (existingState.telegram_alert_sent_at) continue;

    try {
      const messageId = await telegram.sendMessage(
        buildTelegramAlertMessage(row),
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: updateError } = await (supabase as any)
        .from(table)
        .update({
          telegram_alert_sent_at: utcNowIso(),
          telegram_alert_message_id: messageId,
        })
        .eq("retailcrm_id", Number(retailcrmId));

      if (updateError) throw new Error(updateError.message);
      alertsSent++;
    } catch (err) {
      logger.error(
        `Telegram alert failed for order ${retailcrmId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return alertsSent;
}

// ----- Main exported run function -----

export async function run(
  options: Partial<SyncOptions> = {},
  logger: Logger = { log: console.log, error: console.error },
): Promise<{ ok: boolean }> {
  const envFile = options.envFile ?? ".env";
  const env = loadEnv(envFile);

  const retailcrmUrl = env.RETAILCRM_URL;
  const retailcrmApiKey = env.RETAILCRM_API_KEY;
  const supabaseUrl = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseKey =
    env.SUPABASE_SERVICE_KEY ??
    env.SUPABASE_SECRET_KEY ??
    env.SUPABASE_SERVICE_ROLE_KEY ??
    "";

  if (!retailcrmUrl) {
    logger.error("Configuration error: RETAILCRM_URL is required");
    return { ok: false };
  }
  if (!retailcrmApiKey) {
    logger.error("Configuration error: RETAILCRM_API_KEY is required");
    return { ok: false };
  }
  if (!supabaseUrl) {
    logger.error("Configuration error: SUPABASE_URL is required");
    return { ok: false };
  }
  if (!supabaseKey) {
    logger.error(
      "Configuration error: SUPABASE_SERVICE_KEY or SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is required",
    );
    return { ok: false };
  }

  const keyType = classifySupabaseKey(supabaseKey);
  if (keyType === "publishable" || keyType === "legacy_anon") {
    logger.error(
      "SUPABASE_SERVICE_KEY is not a privileged key. Use a Supabase secret key (sb_secret_...) or legacy service_role key, not a publishable/anon key.",
    );
    return { ok: false };
  }

  const requestTimeout = parseInt(env.REQUEST_TIMEOUT_SECONDS ?? "30", 10);
  const requestDelay =
    options.delay !== undefined
      ? options.delay
      : parseFloat(env.REQUEST_DELAY_SECONDS ?? "0.15");
  const retailcrmPageLimit =
    options.pageLimit !== undefined
      ? options.pageLimit
      : parseInt(env.RETAILCRM_PAGE_LIMIT ?? "50", 10);
  const supabaseBatchSize =
    options.batchSize !== undefined
      ? options.batchSize
      : parseInt(env.SUPABASE_BATCH_SIZE ?? "200", 10);
  const retailcrmSite = env.RETAILCRM_SITE_CODE || undefined;
  const supabaseSchema = env.SUPABASE_SCHEMA ?? "public";
  const supabaseTable = env.SUPABASE_ORDERS_TABLE ?? "retailcrm_orders";
  const supabaseConflictColumn =
    env.SUPABASE_UPSERT_CONFLICT_COLUMN ?? "retailcrm_id";
  const supabaseAccessToken = env.SUPABASE_ACCESS_TOKEN;
  const supabaseProjectRef =
    env.SUPABASE_PROJECT_REF || inferProjectRef(supabaseUrl) || undefined;
  const telegramAlertsEnabled = parseBoolEnv(env.TELEGRAM_ALERTS_ENABLED, false);
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = env.TELEGRAM_CHAT_ID;
  const telegramMinTotalKzt = parseFloat(
    env.TELEGRAM_ALERT_MIN_TOTAL_KZT ?? "50000",
  );
  const dryRun = options.dryRun ?? false;
  const createTable = options.createTable ?? false;
  const maxPages = options.maxPages ?? null;
  const maxOrders = options.maxOrders ?? null;

  if (retailcrmPageLimit <= 0 || supabaseBatchSize <= 0) {
    logger.error(
      "RETAILCRM_PAGE_LIMIT and SUPABASE_BATCH_SIZE must be greater than 0.",
    );
    return { ok: false };
  }
  if (telegramMinTotalKzt < 0) {
    logger.error(
      "TELEGRAM_ALERT_MIN_TOTAL_KZT must be greater than or equal to 0.",
    );
    return { ok: false };
  }
  if (telegramAlertsEnabled && (!telegramBotToken || !telegramChatId)) {
    logger.error(
      "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when TELEGRAM_ALERTS_ENABLED=true.",
    );
    return { ok: false };
  }

  const retailcrm = new RetailCrmClient(
    retailcrmUrl,
    retailcrmApiKey,
    requestTimeout,
  );
  // Cast schema to satisfy the SupabaseClient generic — runtime value is supabaseSchema
  const supabase = createClient(supabaseUrl, supabaseKey, {
    db: { schema: supabaseSchema as "public" },
    auth: { persistSession: false },
  });
  const telegram =
    telegramAlertsEnabled && telegramBotToken && telegramChatId
      ? new TelegramClient(telegramBotToken, telegramChatId, requestTimeout)
      : null;

  // Optionally create table via Management API
  if (createTable) {
    if (!supabaseAccessToken || !supabaseProjectRef) {
      logger.error(
        "To create the table via Supabase Management API, set SUPABASE_ACCESS_TOKEN. SUPABASE_PROJECT_REF can be omitted if it can be inferred from SUPABASE_URL.",
      );
      return { ok: false };
    }

    try {
      const { error: existsError } = await supabase
        .from(supabaseTable)
        .select(supabaseConflictColumn)
        .limit(1);

      if (!existsError) {
        logger.log(
          `Table ${supabaseSchema}.${supabaseTable} already exists in Supabase.`,
        );
      } else {
        const errText = `${existsError.message ?? ""} ${existsError.details ?? ""}`.toLowerCase();
        const notFound =
          errText.includes("could not find") ||
          errText.includes("relation") ||
          errText.includes("does not exist") ||
          existsError.code === "42P01";

        if (!notFound) {
          logger.error(
            `Failed to check if Supabase table exists: ${existsError.message}`,
          );
          return { ok: false };
        }

        try {
          const management = new SupabaseManagementClient(
            supabaseAccessToken,
            supabaseProjectRef,
            requestTimeout,
          );
          await management.createOrdersTable(supabaseSchema, supabaseTable);
          logger.log(
            `Ensured table ${supabaseSchema}.${supabaseTable} exists via Supabase Management API.`,
          );
        } catch (err) {
          logger.error(
            `Failed to create Supabase table via API: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { ok: false };
        }
      }
    } catch (err) {
      logger.error(
        `Failed to check if Supabase table exists: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: false };
    }
  }

  // Main sync loop
  let page = 1;
  let seenOrders = 0;
  let uploadedRows = 0;
  let telegramAlertsSent = 0;
  const syncedAt = utcNowIso();

  while (true) {
    if (maxPages !== null && page > maxPages) break;

    let response: Record<string, unknown>;
    try {
      response = await retailcrm.listOrders(
        page,
        retailcrmPageLimit,
        retailcrmSite,
      );
    } catch (err) {
      logger.error(
        `Failed to fetch RetailCRM page ${page}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: false };
    }

    const orders = response.orders;
    const pagination =
      typeof response.pagination === "object" && response.pagination !== null
        ? (response.pagination as Record<string, unknown>)
        : {};

    if (!Array.isArray(orders)) {
      logger.error(
        `RetailCRM page ${page} did not return an orders list: ${JSON.stringify(response)}`,
      );
      return { ok: false };
    }

    if (orders.length === 0) break;

    let rows = (orders as Record<string, unknown>[])
      .filter((o) => typeof o === "object" && o !== null)
      .map((o) => orderToRow(o, syncedAt));

    if (maxOrders !== null) {
      const remaining = maxOrders - seenOrders;
      if (remaining <= 0) break;
      rows = rows.slice(0, remaining);
    }

    if (dryRun) {
      for (const row of rows) {
        logger.log(JSON.stringify(row));
      }
      uploadedRows += rows.length;
    } else {
      try {
        for (const batch of chunked(rows, supabaseBatchSize)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { error: upsertError } = await supabase
            .from(supabaseTable)
            .upsert(batch as never[], { onConflict: supabaseConflictColumn });

          if (upsertError) {
            if (isRlsError(upsertError)) {
              logger.error(
                "Supabase rejected the write because of RLS. Run with --create-table again so the script can ensure the table and service_role policy exist, or verify that .env contains the real service role key in SUPABASE_SERVICE_KEY.",
              );
            }
            logger.error(
              `Failed to upsert Supabase batch from page ${page}: ${upsertError.message}`,
            );
            return { ok: false };
          }

          uploadedRows += batch.length;

          if (telegram !== null) {
            telegramAlertsSent += await sendTelegramAlertsForBatch(
              supabase,
              supabaseTable,
              telegram,
              batch,
              telegramMinTotalKzt,
              logger,
            );
          }
        }
      } catch (err) {
        logger.error(
          `Failed to upsert Supabase batch from page ${page}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { ok: false };
      }
    }

    seenOrders += rows.length;
    const currentPage = Number(pagination.currentPage ?? page);
    const totalPages = Number(pagination.totalPageCount ?? currentPage);
    logger.log(
      `Processed RetailCRM page ${currentPage}/${totalPages}. Orders this page=${rows.length} total_synced=${uploadedRows} telegram_alerts_sent=${telegramAlertsSent}`,
    );

    if (rows.length < orders.length) break;
    if (currentPage >= totalPages) break;

    page++;
    if (requestDelay > 0) await sleep(requestDelay * 1000);
  }

  logger.log(
    `Done. pages_processed=${seenOrders > 0 ? page : 0} orders_seen=${seenOrders} orders_synced=${uploadedRows} telegram_alerts_sent=${telegramAlertsSent}`,
  );
  return { ok: true };
}

// ----- CLI entry point -----

function parseArgs(): Partial<SyncOptions> {
  const args = process.argv.slice(2);
  const opts: Partial<SyncOptions> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--env-file":
        opts.envFile = args[++i];
        break;
      case "--page-limit":
        opts.pageLimit = parseInt(args[++i], 10);
        break;
      case "--max-pages":
        opts.maxPages = parseInt(args[++i], 10);
        break;
      case "--max-orders":
        opts.maxOrders = parseInt(args[++i], 10);
        break;
      case "--batch-size":
        opts.batchSize = parseInt(args[++i], 10);
        break;
      case "--delay":
        opts.delay = parseFloat(args[++i]);
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--create-table":
        opts.createTable = true;
        break;
    }
  }
  return opts;
}

async function main(): Promise<void> {
  const { ok } = await run(parseArgs(), {
    log: console.log,
    error: console.error,
  });
  process.exit(ok ? 0 : 1);
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
