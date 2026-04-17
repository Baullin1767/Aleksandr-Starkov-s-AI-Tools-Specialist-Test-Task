import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface Logger {
  log(message: string): void;
  error(message: string): void;
}

export interface UploadOptions {
  envFile?: string;
  file?: string;
  dryRun?: boolean;
  limit?: number;
  delay?: number;
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

function loadJson(filePath: string): unknown {
  // turbopackIgnore: true — path is dynamic, resolved from env/options at runtime
  const buffer = fs.readFileSync(/* turbopackIgnore: true */ filePath);
  // Strip UTF-8 BOM if present
  const text =
    buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      ? buffer.slice(3).toString("utf-8")
      : buffer.toString("utf-8");
  return JSON.parse(text);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

class RetailCrmApiError extends Error {
  constructor(
    message: string,
    public details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RetailCrmApiError";
  }
}

class RetailCrmClient {
  private baseUrl: string;

  constructor(
    baseUrl: string,
    private apiKey: string,
    private timeout: number = 30,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async get(apiPath: string): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}${apiPath}`,
      { headers: { "X-API-KEY": this.apiKey, Accept: "application/json" } },
      this.timeout * 1000,
    );
    return this._parseResponse(response);
  }

  async postForm(
    apiPath: string,
    payload: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}${apiPath}`,
      {
        method: "POST",
        headers: {
          "X-API-KEY": this.apiKey,
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(payload).toString(),
      },
      this.timeout * 1000,
    );
    return this._parseResponse(response);
  }

  private async _parseResponse(
    response: Response,
  ): Promise<Record<string, unknown>> {
    const text = await response.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new RetailCrmApiError(
        `RetailCRM API returned non-JSON: ${text.slice(0, 500)}`,
        { errorMsg: text.slice(0, 500) },
      );
    }

    if (!response.ok) {
      throw new RetailCrmApiError(
        `RetailCRM API returned HTTP ${response.status}: ${JSON.stringify(data)}`,
        data,
      );
    }

    return data;
  }
}

// ----- Reference data helpers -----

function pickSiteCode(
  explicit: string | undefined,
  sites: Record<string, Record<string, unknown>>,
): string {
  if (explicit) {
    if (explicit in sites) return explicit;
    throw new Error(
      `Configured RETAILCRM_SITE_CODE '${explicit}' is not available.`,
    );
  }
  const keys = Object.keys(sites);
  if (keys.length === 1) return keys[0];
  throw new Error(
    "RetailCRM account has multiple sites. Set RETAILCRM_SITE_CODE in .env.",
  );
}

function activeCodes(
  reference: Record<string, Record<string, unknown>>,
): Set<string> {
  const result = new Set<string>();
  for (const [code, item] of Object.entries(reference)) {
    if (item.active !== false) result.add(code);
  }
  return result;
}

function pickDefaultCode(
  reference: Record<string, Record<string, unknown>>,
): string | null {
  for (const [code, item] of Object.entries(reference)) {
    if (item.defaultForApi) return code;
  }
  for (const [code, item] of Object.entries(reference)) {
    if (item.defaultForCrm) return code;
  }
  for (const [code, item] of Object.entries(reference)) {
    if (item.active !== false) return code;
  }
  return null;
}

// ----- Order normalization -----

function ensureNumber(value: unknown, fieldName: string): number {
  const n = Number(value);
  if (Number.isNaN(n)) {
    throw new Error(
      `'${fieldName}' must be a number, got ${JSON.stringify(value)}`,
    );
  }
  return n;
}

function ensurePositiveQuantity(value: unknown): number {
  const qty = ensureNumber(value, "quantity");
  if (qty <= 0) {
    throw new Error(
      `'quantity' must be greater than 0, got ${JSON.stringify(value)}`,
    );
  }
  return qty;
}

interface NormalizedItem {
  productName: string;
  quantity: number;
  initialPrice: number;
}

interface NormalizedOrder {
  externalId: string;
  currency: string;
  orderMethod?: string;
  orderType?: string;
  status?: string;
  items: NormalizedItem[];
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  customerComment?: string;
  delivery?: Record<string, unknown>;
  customFields?: Record<string, unknown>;
}

function normalizeOrder(
  rawOrder: Record<string, unknown>,
  index: number,
  externalIdPrefix: string,
  defaultCurrency: string,
  methodCodes: Set<string>,
  defaultMethod: string | null,
  typeCodes: Set<string>,
  defaultType: string | null,
  statusCodes: Set<string>,
  defaultStatus: string | null,
): [NormalizedOrder, string[]] {
  const warnings: string[] = [];
  const order: Partial<NormalizedOrder> & Record<string, unknown> = {};

  order.externalId =
    (rawOrder.externalId as string) ||
    `${externalIdPrefix}-${String(index).padStart(4, "0")}`;

  order.currency = defaultCurrency;
  const rawCurrency = String(rawOrder.currency ?? "")
    .trim()
    .toUpperCase();
  if (rawCurrency && rawCurrency !== defaultCurrency) {
    warnings.push(
      `Currency '${rawCurrency}' replaced with '${defaultCurrency}'.`,
    );
  }

  for (const field of [
    "firstName",
    "lastName",
    "phone",
    "email",
    "customerComment",
  ]) {
    if (rawOrder[field]) order[field] = rawOrder[field];
  }

  const rawMethod = rawOrder.orderMethod as string | undefined;
  if (rawMethod && methodCodes.has(rawMethod)) {
    order.orderMethod = rawMethod;
  } else if (defaultMethod) {
    order.orderMethod = defaultMethod;
    if (rawMethod) {
      warnings.push(
        `Unknown orderMethod '${rawMethod}', fallback to '${defaultMethod}'.`,
      );
    }
  }

  const rawType = rawOrder.orderType as string | undefined;
  if (rawType && typeCodes.has(rawType)) {
    order.orderType = rawType;
  } else if (defaultType) {
    order.orderType = defaultType;
    if (rawType) {
      warnings.push(
        `Unknown orderType '${rawType}', fallback to '${defaultType}'.`,
      );
    }
  }

  const rawStatus = rawOrder.status as string | undefined;
  if (rawStatus && statusCodes.has(rawStatus)) {
    order.status = rawStatus;
  } else if (defaultStatus) {
    order.status = defaultStatus;
    if (rawStatus) {
      warnings.push(
        `Unknown status '${rawStatus}', fallback to '${defaultStatus}'.`,
      );
    }
  }

  const items = rawOrder.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Order must contain a non-empty 'items' array.");
  }

  const normalizedItems: NormalizedItem[] = [];
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const rawItem = items[itemIndex];
    if (typeof rawItem !== "object" || rawItem === null) {
      throw new Error(`Item #${itemIndex + 1} must be an object.`);
    }
    const ri = rawItem as Record<string, unknown>;
    const productName = ri.productName;
    if (!productName) {
      throw new Error(`Item #${itemIndex + 1} must contain 'productName'.`);
    }
    normalizedItems.push({
      productName: String(productName),
      quantity: ensurePositiveQuantity(ri.quantity),
      initialPrice: ensureNumber(ri.initialPrice, "initialPrice"),
    });
  }

  order.items = normalizedItems;

  if (
    typeof rawOrder.delivery === "object" &&
    rawOrder.delivery !== null &&
    !Array.isArray(rawOrder.delivery)
  ) {
    order.delivery = rawOrder.delivery as Record<string, unknown>;
  }

  if (
    typeof rawOrder.customFields === "object" &&
    rawOrder.customFields !== null &&
    !Array.isArray(rawOrder.customFields)
  ) {
    order.customFields = rawOrder.customFields as Record<string, unknown>;
  }

  return [order as NormalizedOrder, warnings];
}

// ----- Main exported run function -----

export async function run(
  options: Partial<UploadOptions> = {},
  logger: Logger = { log: console.log, error: console.error },
): Promise<{ ok: boolean }> {
  const envFile = options.envFile ?? ".env";
  const env = loadEnv(envFile);

  const baseUrl = env.RETAILCRM_URL;
  const apiKey = env.RETAILCRM_API_KEY;

  if (!baseUrl) {
    logger.error("Missing required env variable: RETAILCRM_URL");
    return { ok: false };
  }
  if (!apiKey) {
    logger.error("Missing required env variable: RETAILCRM_API_KEY");
    return { ok: false };
  }

  const ordersFilePath = options.file ?? env.ORDERS_FILE ?? "mock_orders.json";
  if (!fs.existsSync(ordersFilePath)) {
    logger.error(`Orders file not found: ${ordersFilePath}`);
    return { ok: false };
  }

  const externalIdPrefix = env.ORDER_EXTERNAL_ID_PREFIX ?? "mock-order";
  const defaultCurrency = (env.ORDER_CURRENCY ?? "KZT").trim().toUpperCase();
  const timeoutSeconds = parseInt(env.REQUEST_TIMEOUT_SECONDS ?? "30", 10);
  const delaySeconds =
    options.delay !== undefined
      ? options.delay
      : parseFloat(env.REQUEST_DELAY_SECONDS ?? "0.15");
  const dryRun = options.dryRun ?? false;
  const limit = options.limit ?? null;

  if (!defaultCurrency) {
    logger.error("ORDER_CURRENCY must not be empty.");
    return { ok: false };
  }

  const client = new RetailCrmClient(baseUrl, apiKey, timeoutSeconds);

  let sites: Record<string, Record<string, unknown>>;
  let orderMethods: Record<string, Record<string, unknown>>;
  let orderTypes: Record<string, Record<string, unknown>>;
  let statuses: Record<string, Record<string, unknown>>;
  let siteCode: string;

  try {
    const sitesResp = await client.get("/reference/sites");
    sites = sitesResp.sites as Record<string, Record<string, unknown>>;

    const methodsResp = await client.get("/reference/order-methods");
    orderMethods = methodsResp.orderMethods as Record<
      string,
      Record<string, unknown>
    >;

    const typesResp = await client.get("/reference/order-types");
    orderTypes = typesResp.orderTypes as Record<
      string,
      Record<string, unknown>
    >;

    const statusesResp = await client.get("/reference/statuses");
    statuses = statusesResp.statuses as Record<string, Record<string, unknown>>;

    siteCode = pickSiteCode(env.RETAILCRM_SITE_CODE, sites);
  } catch (err) {
    logger.error(
      `Failed to load RetailCRM reference data: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false };
  }

  const methodCodes = activeCodes(orderMethods);
  const typeCodes = activeCodes(orderTypes);
  const statusCodes = activeCodes(statuses);

  const defaultMethod = pickDefaultCode(orderMethods);
  const defaultType = pickDefaultCode(orderTypes);
  const defaultStatus = statusCodes.has("new")
    ? "new"
    : pickDefaultCode(statuses);

  let rawOrders: Record<string, unknown>[];
  try {
    const data = loadJson(ordersFilePath);
    if (!Array.isArray(data)) {
      throw new Error("Orders file must contain a JSON array.");
    }
    for (const item of data) {
      if (typeof item !== "object" || item === null) {
        throw new Error("Each order must be a JSON object.");
      }
    }
    rawOrders = data as Record<string, unknown>[];
  } catch (err) {
    logger.error(
      `Failed to read orders file: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false };
  }

  if (limit !== null) {
    rawOrders = rawOrders.slice(0, limit);
  }

  let uploaded = 0;
  let failed = 0;

  for (let i = 0; i < rawOrders.length; i++) {
    const index = i + 1;
    const rawOrder = rawOrders[i];

    let order: NormalizedOrder;
    let warnings: string[];

    try {
      [order, warnings] = normalizeOrder(
        rawOrder,
        index,
        externalIdPrefix,
        defaultCurrency,
        methodCodes,
        defaultMethod,
        typeCodes,
        defaultType,
        statusCodes,
        defaultStatus,
      );
    } catch (err) {
      failed++;
      logger.error(
        `[${index}] Validation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    for (const warning of warnings) {
      logger.error(`[${index}] Warning: ${warning}`);
    }

    if (dryRun) {
      logger.log(JSON.stringify({ site: siteCode, order }));
      uploaded++;
      continue;
    }

    try {
      const payload = {
        site: siteCode,
        order: JSON.stringify(order),
      };

      try {
        const response = await client.postForm("/orders/create", payload);
        if (!response.success) throw new Error(JSON.stringify(response));

        uploaded++;
        logger.log(
          `[${index}] Uploaded externalId=${order.externalId} id=${response.id}`,
        );
      } catch (err) {
        if (
          err instanceof RetailCrmApiError &&
          err.details.errorMsg === "Order already exists."
        ) {
          const editPath = `/orders/${encodeURIComponent(String(order.externalId))}/edit`;
          const response = await client.postForm(editPath, payload);
          if (!response.success) throw new Error(JSON.stringify(response));

          uploaded++;
          logger.log(
            `[${index}] Updated externalId=${order.externalId} id=${response.id}`,
          );
        } else {
          throw err;
        }
      }
    } catch (err) {
      failed++;
      logger.error(
        `[${index}] Upload failed for externalId=${order.externalId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (delaySeconds > 0) await sleep(delaySeconds * 1000);
  }

  const summary = `Done. Processed=${rawOrders.length} uploaded=${uploaded} failed=${failed}`;
  if (failed > 0) {
    logger.error(summary);
  } else {
    logger.log(summary);
  }

  return { ok: failed === 0 };
}

// ----- CLI entry point -----

function parseArgs(): Partial<UploadOptions> {
  const args = process.argv.slice(2);
  const opts: Partial<UploadOptions> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--env-file":
        opts.envFile = args[++i];
        break;
      case "--file":
        opts.file = args[++i];
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--limit":
        opts.limit = parseInt(args[++i], 10);
        break;
      case "--delay":
        opts.delay = parseFloat(args[++i]);
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
