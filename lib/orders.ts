import { createClient } from "@supabase/supabase-js";
import { appEnv } from "./env";
import {
  formatCurrency as formatSharedCurrency,
  formatDayLabel as formatSharedDayLabel,
  type CalendarDay,
  type OrderScheduleItem,
} from "./orders-shared";

type RawOrderRow = {
  retailcrm_id: number;
  number: string | null;
  status: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  email: string | null;
  currency: string | null;
  total_summ: number | string | null;
  shipment_date: string | null;
  created_at: string | null;
  items: Array<{
    productName?: string;
    quantity?: number | string;
  }> | null;
};

type OrderScheduleFilters = {
  from: string;
  to: string;
  status?: string;
};

const supabase = createClient(appEnv.supabaseUrl, appEnv.supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(appEnv.displayLocale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: appEnv.displayTimezone,
  }).format(new Date(value));
}

function formatMonthDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function parseDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

function addDays(value: string, days: number): string {
  const date = parseDateOnly(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatMonthDate(date);
}

function startOfWeek(date: Date): Date {
  const current = new Date(date);
  const day = current.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  current.setUTCDate(current.getUTCDate() + diff);
  return current;
}

function endOfWeek(date: Date): Date {
  const current = startOfWeek(date);
  current.setUTCDate(current.getUTCDate() + 6);
  return current;
}

function getTodayInTimeZone(): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: appEnv.displayTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error("Failed to compute today's date in configured timezone.");
  }

  return `${year}-${month}-${day}`;
}

function summarizeItems(items: RawOrderRow["items"]): string {
  if (!items || items.length === 0) {
    return "No item details";
  }

  const summary = items
    .slice(0, 2)
    .map((item) => {
      const name = item.productName || "Unnamed item";
      const quantity = item.quantity ?? 1;
      return `${name} x${quantity}`;
    })
    .join(", ");

  if (items.length <= 2) {
    return summary;
  }

  return `${summary}, +${items.length - 2} more`;
}

function normalizeOrder(row: RawOrderRow): OrderScheduleItem {
  const customerName =
    [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || "Unknown customer";
  const contactLabel = row.phone || row.email || "No contact data";
  const scheduleTimestamp = row.shipment_date || row.created_at || "";
  const scheduleSource = row.shipment_date ? "shipment" : "created";

  return {
    id: row.retailcrm_id,
    number: row.number || `#${row.retailcrm_id}`,
    status: row.status || "unknown",
    statusLabel: (row.status || "unknown").replace(/[-_]+/g, " "),
    customerName,
    contactLabel,
    totalSumm: row.total_summ === null ? null : Number(row.total_summ),
    currency: row.currency,
    scheduleDate: scheduleTimestamp,
    scheduleDateLabel: scheduleTimestamp ? formatDateTime(scheduleTimestamp) : "Not scheduled",
    scheduleSource,
    itemsSummary: summarizeItems(row.items),
  };
}

export function formatCurrency(value: number | null, currency: string | null): string {
  return formatSharedCurrency(value, currency, appEnv.displayLocale);
}

export function formatDayLabel(value: string): string {
  return formatSharedDayLabel(value, appEnv.displayLocale, appEnv.displayTimezone);
}

export function getDefaultDateRange(): { from: string; to: string } {
  const today = getTodayInTimeZone();
  const currentMonthStart = `${today.slice(0, 8)}01`;
  const nextMonthStartDate = parseDateOnly(currentMonthStart);
  nextMonthStartDate.setUTCMonth(nextMonthStartDate.getUTCMonth() + 1);
  nextMonthStartDate.setUTCDate(1);
  const nextMonthStart = formatMonthDate(nextMonthStartDate);
  const monthEnd = addDays(nextMonthStart, -1);

  return { from: currentMonthStart, to: monthEnd };
}

export async function getOrdersSchedule({
  from,
  to,
  status,
}: OrderScheduleFilters): Promise<OrderScheduleItem[]> {
  let query = supabase
    .from(appEnv.ordersTable)
    .select(
      "retailcrm_id, number, status, first_name, last_name, phone, email, currency, total_summ, shipment_date, created_at, items",
    )
    .or(
      `and(shipment_date.not.is.null,shipment_date.gte.${from}T00:00:00,shipment_date.lte.${to}T23:59:59),and(shipment_date.is.null,created_at.gte.${from}T00:00:00,created_at.lte.${to}T23:59:59)`,
    )
    .order("shipment_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to load orders from Supabase: ${error.message}`);
  }

  return (data as RawOrderRow[]).map(normalizeOrder);
}

export async function getStatusOptions(): Promise<string[]> {
  const { data, error } = await supabase
    .from(appEnv.ordersTable)
    .select("status")
    .not("status", "is", null)
    .order("status", { ascending: true });

  if (error) {
    throw new Error(`Failed to load status options from Supabase: ${error.message}`);
  }

  return Array.from(
    new Set(
      (data as Array<{ status: string | null }>)
        .map((row) => row.status?.trim() || "")
        .filter(Boolean),
    ),
  );
}

export function buildCalendarWeeks(
  from: string,
  to: string,
  orders: OrderScheduleItem[],
): CalendarDay[][] {
  const ordersByDay = new Map<string, OrderScheduleItem[]>();

  for (const order of orders) {
    const key = order.scheduleDate.slice(0, 10);
    const dayOrders = ordersByDay.get(key) || [];
    dayOrders.push(order);
    ordersByDay.set(key, dayOrders);
  }

  const rangeStart = parseDateOnly(from);
  const rangeEnd = parseDateOnly(to);
  const gridStart = startOfWeek(rangeStart);
  const gridEnd = endOfWeek(rangeEnd);
  const days: CalendarDay[] = [];

  for (
    let cursor = new Date(gridStart);
    cursor <= gridEnd;
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    const date = formatMonthDate(cursor);
    days.push({
      date,
      dayNumber: cursor.getUTCDate().toString(),
      weekdayLabel: new Intl.DateTimeFormat(appEnv.displayLocale, {
        weekday: "short",
        timeZone: "UTC",
      }).format(cursor),
      isInRange: date >= from && date <= to,
      orders: ordersByDay.get(date) || [],
    });
  }

  const weeks: CalendarDay[][] = [];
  for (let index = 0; index < days.length; index += 7) {
    weeks.push(days.slice(index, index + 7));
  }

  return weeks;
}
