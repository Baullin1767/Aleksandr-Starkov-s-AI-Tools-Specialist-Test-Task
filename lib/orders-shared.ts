export type OrderScheduleItem = {
  id: number;
  number: string;
  status: string;
  statusLabel: string;
  customerName: string;
  contactLabel: string;
  totalSumm: number | null;
  currency: string | null;
  scheduleDate: string;
  scheduleDateLabel: string;
  scheduleSource: "shipment" | "created";
  itemsSummary: string;
};

export type CalendarDay = {
  date: string;
  dayNumber: string;
  weekdayLabel: string;
  isInRange: boolean;
  orders: OrderScheduleItem[];
};

export function formatCurrency(
  value: number | null,
  currency: string | null,
  locale = "en-GB",
): string {
  if (value === null || Number.isNaN(value)) {
    return "Not specified";
  }

  if (!currency) {
    return value.toFixed(2);
  }

  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

export function formatDayLabel(
  value: string,
  locale = "en-GB",
  timeZone = "Europe/Moscow",
): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "full",
    timeZone,
  }).format(new Date(`${value}T00:00:00Z`));
}
