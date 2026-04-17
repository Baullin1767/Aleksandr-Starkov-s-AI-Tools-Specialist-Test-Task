"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatCurrency,
  formatDayLabel,
  type CalendarDay,
  type OrderScheduleItem,
} from "../lib/orders-shared";

type OrdersCalendarProps = {
  weeks: CalendarDay[][];
};

function renderOrderCard(order: OrderScheduleItem) {
  return (
    <article key={order.id} className="order-card">
      <div className="order-card__topline">
        <div>
          <p className="order-card__number">{order.number}</p>
          <p className="order-card__customer">{order.customerName}</p>
        </div>
        <span className="status-pill">{order.statusLabel}</span>
      </div>
      <dl className="order-card__meta">
        <div>
          <dt>{order.scheduleSource === "shipment" ? "Shipment" : "Created"}</dt>
          <dd>{order.scheduleDateLabel}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>{formatCurrency(order.totalSumm, order.currency)}</dd>
        </div>
        <div>
          <dt>Contact</dt>
          <dd>{order.contactLabel}</dd>
        </div>
      </dl>
      <p className="order-card__items">{order.itemsSummary}</p>
    </article>
  );
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("disabled"));
}

export function OrdersCalendar({ weeks }: OrdersCalendarProps) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const allDays = useMemo(() => weeks.flat(), [weeks]);
  const selectedDay =
    allDays.find((day) => day.date === selectedDate && day.orders.length > 0) ?? null;

  useEffect(() => {
    if (!selectedDay) {
      return;
    }

    const originalOverflow = document.body.style.overflow;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setSelectedDate(null);
        return;
      }

      if (event.key !== "Tab" || !modalRef.current) {
        return;
      }

      const focusable = getFocusableElements(modalRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = originalOverflow;
      previousFocusRef.current?.focus();
    };
  }, [selectedDay]);

  return (
    <>
      <div className="calendar-grid">
        {weeks.map((week, index) => (
          <div key={`${week[0]?.date ?? "week"}-${index}`} className="calendar-week">
            {week.map((day) => {
              const interactive = day.orders.length > 0;
              const buttonLabel =
                day.orders.length === 1 ? "1 order" : `${day.orders.length} orders`;

              return (
                <section
                  key={day.date}
                  className={`calendar-day${day.isInRange ? "" : " calendar-day--muted"}${
                    interactive ? " calendar-day--interactive" : ""
                  }`}
                >
                  <header className="calendar-day__header">
                    <div>
                      <p className="calendar-day__weekday">{day.weekdayLabel}</p>
                      <h3>{day.dayNumber}</h3>
                    </div>
                    <span>{day.orders.length}</span>
                  </header>
                  <p className="calendar-day__date">{formatDayLabel(day.date)}</p>
                  <div className="calendar-day__orders">
                    {interactive ? (
                      <button
                        type="button"
                        className="calendar-day__count-button"
                        onClick={() => setSelectedDate(day.date)}
                        aria-haspopup="dialog"
                        aria-expanded={selectedDay?.date === day.date}
                      >
                        <span className="calendar-day__count-number">{day.orders.length}</span>
                        <span className="calendar-day__count-label">{buttonLabel}</span>
                        <span className="calendar-day__count-hint">Tap for details</span>
                      </button>
                    ) : (
                      <p className="calendar-day__empty">No orders</p>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        ))}
      </div>

      {selectedDay ? (
        <div
          className="modal-backdrop"
          onClick={() => setSelectedDate(null)}
          role="presentation"
        >
          <div
            className="orders-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="orders-modal-title"
            ref={modalRef}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="orders-modal__header">
              <div>
                <p className="eyebrow">Orders for date</p>
                <h3 id="orders-modal-title">{formatDayLabel(selectedDay.date)}</h3>
                <p className="orders-modal__summary">
                  {selectedDay.orders.length === 1
                    ? "1 order scheduled for this day"
                    : `${selectedDay.orders.length} orders scheduled for this day`}
                </p>
              </div>
              <button
                type="button"
                className="orders-modal__close"
                onClick={() => setSelectedDate(null)}
                aria-label="Close order details"
                ref={closeButtonRef}
              >
                X
              </button>
            </div>

            <div className="orders-modal__body">
              {selectedDay.orders.map(renderOrderCard)}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
