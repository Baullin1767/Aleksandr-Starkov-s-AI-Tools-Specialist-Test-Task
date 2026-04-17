import {
  buildCalendarWeeks,
  formatDayLabel,
  getDefaultDateRange,
  getOrdersSchedule,
  getStatusOptions,
} from "../lib/orders";
import { OrdersCalendar } from "./orders-calendar";

export const dynamic = "force-dynamic";

type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

function readSingleValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function normalizeDateInput(value: string | undefined, fallback: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return fallback;
  }
  return value;
}

function buildDateTitle(from: string, to: string): string {
  if (from === to) {
    return formatDayLabel(from);
  }
  return `${formatDayLabel(from)} to ${formatDayLabel(to)}`;
}

export default async function Home({
  searchParams,
}: {
  searchParams: PageSearchParams;
}) {
  const params = await searchParams;
  const defaults = getDefaultDateRange();
  const from = normalizeDateInput(readSingleValue(params.from), defaults.from);
  const to = normalizeDateInput(readSingleValue(params.to), defaults.to);
  const status = readSingleValue(params.status)?.trim() ?? "";

  const [orders, statusOptions] = await Promise.all([
    getOrdersSchedule({ from, to, status }),
    getStatusOptions(),
  ]);

  const weeks = buildCalendarWeeks(from, to, orders);
  const title = buildDateTitle(from, to);

  return (
    <main className="page-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Supabase + Vercel</p>
          <h1>Orders schedule</h1>
          <p className="hero__copy">
            Private shipment dashboard grouped by calendar day. Filters stay in the
            URL so the view can be bookmarked and shared inside the team.
          </p>
        </div>
        <div className="hero__stats">
          <div className="stat-card">
            <span className="stat-card__label">Range</span>
            <strong>{title}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Orders</span>
            <strong>{orders.length}</strong>
          </div>
          <div className="stat-card">
            <span className="stat-card__label">Status</span>
            <strong>{status || "All"}</strong>
          </div>
        </div>
      </section>

      <section className="filters-panel">
        <form className="filters-form" method="get">
          <label>
            <span>From</span>
            <input type="date" name="from" defaultValue={from} />
          </label>
          <label>
            <span>To</span>
            <input type="date" name="to" defaultValue={to} />
          </label>
          <label>
            <span>Status</span>
            <select name="status" defaultValue={status}>
              <option value="">All statuses</option>
              {statusOptions.map((statusOption) => (
                <option key={statusOption} value={statusOption}>
                  {statusOption}
                </option>
              ))}
            </select>
          </label>
          <div className="filters-form__actions">
            <button type="submit">Apply filters</button>
            <a href="/">Reset</a>
          </div>
        </form>
      </section>

      <section className="calendar-panel">
        <div className="calendar-panel__header">
          <div>
            <p className="eyebrow">Shipment calendar</p>
            <h2>{title}</h2>
          </div>
          <p className="calendar-panel__summary">
            Orders use shipment date when available and fall back to created date if shipment is empty.
          </p>
        </div>

        {orders.length === 0 ? (
          <div className="empty-state">
            <h3>No scheduled orders found</h3>
            <p>Try a wider date range or remove the status filter.</p>
          </div>
        ) : (
          <OrdersCalendar weeks={weeks} />
        )}
      </section>
    </main>
  );
}
