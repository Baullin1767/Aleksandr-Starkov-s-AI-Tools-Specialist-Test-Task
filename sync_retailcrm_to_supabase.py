#!/usr/bin/env python3
import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from html import escape as html_escape
from typing import Any, Dict, Iterable, List, Optional, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode, urlparse
from urllib.request import Request, urlopen

BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/135.0.0.0 Safari/537.36"
)
DEFAULT_USER_AGENT = "CodexRetailCrmSync/1.0"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sync orders from RetailCRM API v5 to Supabase Data API."
    )
    parser.add_argument(
        "--env-file",
        default=".env",
        help="Path to the environment file. Default: .env",
    )
    parser.add_argument(
        "--page-limit",
        type=int,
        default=None,
        help="Orders per RetailCRM page. Overrides RETAILCRM_PAGE_LIMIT from env.",
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=None,
        help="Stop after this many RetailCRM pages.",
    )
    parser.add_argument(
        "--max-orders",
        type=int,
        default=None,
        help="Stop after this many orders.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=None,
        help="Supabase upsert batch size. Overrides SUPABASE_BATCH_SIZE from env.",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=None,
        help="Delay between RetailCRM page requests in seconds.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print normalized rows instead of sending them to Supabase.",
    )
    parser.add_argument(
        "--create-table",
        action="store_true",
        help="Create the target Supabase table through the Supabase Management API before syncing.",
    )
    return parser.parse_args()


def load_env(env_path: Path) -> Dict[str, str]:
    if not env_path.exists():
        raise FileNotFoundError(f"Env file not found: {env_path}")

    result: Dict[str, str] = {}
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        result[key.strip()] = value.strip().strip('"').strip("'")

    return result


def chunked(items: Sequence[Dict[str, Any]], size: int) -> Iterable[Sequence[Dict[str, Any]]]:
    for index in range(0, len(items), size):
        yield items[index : index + size]


class JsonApiError(RuntimeError):
    def __init__(self, message: str, details: Any, status_code: Optional[int] = None) -> None:
        super().__init__(message)
        self.details = details
        self.status_code = status_code


class JsonHttpClient:
    def __init__(self, timeout: int = 30) -> None:
        self.timeout = timeout

    def request_json(
        self,
        method: str,
        url: str,
        *,
        headers: Optional[Dict[str, str]] = None,
        query: Optional[Dict[str, Any]] = None,
        json_body: Optional[Any] = None,
        form_body: Optional[Dict[str, str]] = None,
    ) -> Any:
        if query:
            encoded_query = urlencode(query, doseq=True)
            separator = "&" if "?" in url else "?"
            url = f"{url}{separator}{encoded_query}"

        request_headers = {
            "Accept": "application/json",
            "User-Agent": DEFAULT_USER_AGENT,
        }
        if headers:
            request_headers.update(headers)

        payload: Optional[bytes] = None
        if json_body is not None:
            payload = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
            request_headers["Content-Type"] = "application/json"
        elif form_body is not None:
            payload = urlencode(form_body).encode("utf-8")
            request_headers["Content-Type"] = "application/x-www-form-urlencoded"

        request = Request(
            url,
            data=payload,
            headers=request_headers,
            method=method.upper(),
        )

        try:
            with urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8")
        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            try:
                details = json.loads(body)
            except json.JSONDecodeError:
                details = {"error": body or str(exc)}
            raise JsonApiError(
                f"HTTP {exc.code} returned from {url}: {details}",
                details,
                status_code=exc.code,
            ) from exc
        except URLError as exc:
            raise RuntimeError(f"Failed to reach {url}: {exc}") from exc

        if not body:
            return None

        try:
            return json.loads(body)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Expected JSON response from {url}, got: {body[:500]}") from exc


class RetailCrmClient:
    def __init__(self, base_url: str, api_key: str, timeout: int = 30) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.http = JsonHttpClient(timeout=timeout)

    def list_orders(
        self,
        *,
        page: int,
        limit: int,
        site: Optional[str] = None,
    ) -> Dict[str, Any]:
        query: Dict[str, Any] = {"page": page, "limit": limit}
        if site:
            query["site"] = site

        response = self.http.request_json(
            "GET",
            f"{self.base_url}/orders",
            headers={"X-API-KEY": self.api_key},
            query=query,
        )

        if not isinstance(response, dict) or not response.get("success", False):
            raise RuntimeError(f"Unexpected RetailCRM response: {response}")

        return response


class SupabaseClient:
    def __init__(
        self,
        base_url: str,
        service_key: str,
        *,
        gateway_key: Optional[str],
        schema: str,
        table: str,
        conflict_column: str,
        timeout: int = 30,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.service_key = service_key
        self.gateway_key = gateway_key or service_key
        self.schema = schema
        self.table = table
        self.conflict_column = conflict_column
        self.http = JsonHttpClient(timeout=timeout)

    def _auth_headers(self, *, include_content_profile: bool = False) -> Dict[str, str]:
        headers: Dict[str, str] = {
            "apikey": self.service_key,
            "Accept-Profile": self.schema,
        }

        # Legacy service_role keys are JWTs and should be sent as Bearer tokens.
        # New secret keys (sb_secret_...) are opaque and must stay in the apikey header.
        if self.service_key.count(".") == 2:
            headers["Authorization"] = f"Bearer {self.service_key}"

        if include_content_profile:
            headers["Content-Profile"] = self.schema

        return headers

    def upsert_rows(self, rows: Sequence[Dict[str, Any]]) -> None:
        if not rows:
            return

        self.http.request_json(
            "POST",
            f"{self.base_url}/rest/v1/{quote(self.table, safe='')}",
            headers={
                **self._auth_headers(include_content_profile=True),
                "Prefer": "resolution=merge-duplicates,return=minimal",
            },
            query={"on_conflict": self.conflict_column},
            json_body=list(rows),
        )

    def fetch_alert_state_map(self, order_ids: Sequence[Any]) -> Dict[int, Dict[str, Any]]:
        normalized_ids = [int(order_id) for order_id in order_ids if order_id is not None]
        if not normalized_ids:
            return {}

        data = self.http.request_json(
            "GET",
            f"{self.base_url}/rest/v1/{quote(self.table, safe='')}",
            headers=self._auth_headers(),
            query={
                "select": "retailcrm_id,telegram_alert_sent_at,telegram_alert_message_id",
                "retailcrm_id": f"in.({','.join(str(order_id) for order_id in normalized_ids)})",
            },
        )

        if not isinstance(data, list):
            raise RuntimeError(f"Unexpected Supabase alert-state response: {data}")

        result: Dict[int, Dict[str, Any]] = {}
        for row in data:
            if not isinstance(row, dict):
                continue
            retailcrm_id = row.get("retailcrm_id")
            if retailcrm_id is None:
                continue
            result[int(retailcrm_id)] = row
        return result

    def mark_telegram_alert_sent(
        self,
        retailcrm_id: int,
        *,
        sent_at: str,
        message_id: Optional[int],
    ) -> None:
        self.http.request_json(
            "PATCH",
            f"{self.base_url}/rest/v1/{quote(self.table, safe='')}",
            headers={
                **self._auth_headers(include_content_profile=True),
                "Prefer": "return=minimal",
            },
            query={"retailcrm_id": f"eq.{retailcrm_id}"},
            json_body={
                "telegram_alert_sent_at": sent_at,
                "telegram_alert_message_id": message_id,
            },
        )

    def table_exists(self) -> bool:
        try:
            self.http.request_json(
                "GET",
                f"{self.base_url}/rest/v1/{quote(self.table, safe='')}",
                headers=self._auth_headers(),
                query={"select": self.conflict_column, "limit": 1},
            )
            return True
        except JsonApiError as exc:
            if exc.status_code == 404:
                return False

            details_text = json.dumps(exc.details, ensure_ascii=False).lower()
            if "could not find the table" in details_text or "relation" in details_text:
                return False
            raise


class SupabaseManagementClient:
    def __init__(self, access_token: str, project_ref: str, timeout: int = 30) -> None:
        self.access_token = access_token
        self.project_ref = project_ref
        self.http = JsonHttpClient(timeout=timeout)

    def create_orders_table(self, *, schema: str, table: str) -> Any:
        table_qualified_name = f"{schema}.{table}"
        query = f"""
create table if not exists {table_qualified_name} (
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
    delivery jsonb not null default '{{}}'::jsonb,
    custom_fields jsonb not null default '{{}}'::jsonb,
    raw_order jsonb not null,
    synced_at timestamptz not null default timezone('utc', now()),
    telegram_alert_sent_at timestamptz,
    telegram_alert_message_id bigint
);

alter table {table_qualified_name}
    add column if not exists telegram_alert_sent_at timestamptz;

alter table {table_qualified_name}
    add column if not exists telegram_alert_message_id bigint;

create index if not exists {table}_number_idx
    on {table_qualified_name} (number);

create index if not exists {table}_status_idx
    on {table_qualified_name} (status);

create index if not exists {table}_created_at_idx
    on {table_qualified_name} (created_at);

alter table {table_qualified_name}
    enable row level security;

grant all privileges on table {table_qualified_name} to service_role;

do $$
begin
    if not exists (
        select 1
        from pg_policies
        where schemaname = '{schema}'
          and tablename = '{table}'
          and policyname = '{table}_service_role_all'
    ) then
        execute 'create policy {table}_service_role_all on {table_qualified_name} for all to service_role using (true) with check (true)';
    end if;
end
$$;
""".strip()

        return self.http.request_json(
            "POST",
            f"https://api.supabase.com/v1/projects/{quote(self.project_ref, safe='')}/database/migrations",
            headers={
                "Authorization": f"Bearer {self.access_token}",
                "User-Agent": BROWSER_USER_AGENT,
            },
            json_body={
                "name": f"create_{table}_table",
                "query": query,
            },
        )


class TelegramClient:
    def __init__(self, bot_token: str, chat_id: str, timeout: int = 30) -> None:
        self.bot_token = bot_token
        self.chat_id = chat_id
        self.http = JsonHttpClient(timeout=timeout)

    def send_message(self, text: str) -> Optional[int]:
        response = self.http.request_json(
            "POST",
            f"https://api.telegram.org/bot{quote(self.bot_token, safe='')}/sendMessage",
            json_body={
                "chat_id": self.chat_id,
                "text": text,
                "parse_mode": "HTML",
                "disable_web_page_preview": True,
            },
        )

        if not isinstance(response, dict) or not response.get("ok"):
            raise RuntimeError(f"Unexpected Telegram response: {response}")

        result = response.get("result")
        if not isinstance(result, dict):
            return None

        message_id = result.get("message_id")
        if message_id is None:
            return None
        return int(message_id)


def to_float(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_bool_env(value: Optional[str], default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def format_telegram_total(total_summ: Optional[float], currency: Optional[str]) -> str:
    if total_summ is None:
        return "Not specified"
    if currency == "KZT":
        return f"{total_summ:,.2f} KZT"
    if currency:
        return f"{total_summ:,.2f} {currency}"
    return f"{total_summ:,.2f}"


def build_customer_name(row: Dict[str, Any]) -> str:
    return " ".join(
        part.strip()
        for part in [str(row.get("first_name") or "").strip(), str(row.get("last_name") or "").strip()]
        if part and part.strip()
    ) or "Unknown customer"


def build_contact_label(row: Dict[str, Any]) -> str:
    return str(row.get("phone") or row.get("email") or "No contact data")


def build_schedule_label(row: Dict[str, Any]) -> str:
    schedule_value = row.get("shipment_date") or row.get("created_at")
    if not schedule_value:
        return "Not specified"
    schedule_name = "Shipment date" if row.get("shipment_date") else "Created at"
    return f"{schedule_name}: {schedule_value}"


def is_telegram_alert_candidate(row: Dict[str, Any], min_total_kzt: float) -> bool:
    currency = str(row.get("currency") or "").upper()
    total_summ = row.get("total_summ")
    return currency == "KZT" and isinstance(total_summ, (int, float)) and total_summ >= min_total_kzt


def build_telegram_alert_message(row: Dict[str, Any]) -> str:
    order_number = row.get("number") or f"#{row.get('retailcrm_id')}"
    retailcrm_id = row.get("retailcrm_id")
    customer_name = build_customer_name(row)
    total_label = format_telegram_total(row.get("total_summ"), row.get("currency"))
    status = row.get("status") or "unknown"
    contact_label = build_contact_label(row)
    schedule_label = build_schedule_label(row)

    lines = [
        "<b>Large order alert</b>",
        f"Order: <b>{html_escape(str(order_number))}</b> (RetailCRM ID: {html_escape(str(retailcrm_id))})",
        f"Customer: {html_escape(customer_name)}",
        f"Total: <b>{html_escape(total_label)}</b>",
        f"Status: {html_escape(str(status))}",
        html_escape(schedule_label),
        f"Contact: {html_escape(contact_label)}",
    ]
    return "\n".join(lines)


def send_telegram_alerts_for_batch(
    *,
    supabase: SupabaseClient,
    telegram: TelegramClient,
    rows: Sequence[Dict[str, Any]],
    min_total_kzt: float,
) -> int:
    alert_state_map = supabase.fetch_alert_state_map([row.get("retailcrm_id") for row in rows])
    alerts_sent = 0

    for row in rows:
        retailcrm_id = row.get("retailcrm_id")
        if retailcrm_id is None or not is_telegram_alert_candidate(row, min_total_kzt):
            continue

        existing_state = alert_state_map.get(int(retailcrm_id), {})
        if existing_state.get("telegram_alert_sent_at"):
            continue

        try:
            message_id = telegram.send_message(build_telegram_alert_message(row))
            supabase.mark_telegram_alert_sent(
                int(retailcrm_id),
                sent_at=utc_now_iso(),
                message_id=message_id,
            )
            alerts_sent += 1
        except Exception as exc:
            print(
                f"Telegram alert failed for order {retailcrm_id}: {exc}",
                file=sys.stderr,
            )

    return alerts_sent


def order_to_row(order: Dict[str, Any], synced_at: str) -> Dict[str, Any]:
    customer = order.get("customer") if isinstance(order.get("customer"), dict) else {}
    delivery = order.get("delivery") if isinstance(order.get("delivery"), dict) else {}

    return {
        "retailcrm_id": order.get("id"),
        "retailcrm_external_id": order.get("externalId"),
        "number": order.get("number"),
        "site": order.get("site"),
        "status": order.get("status"),
        "status_group": order.get("statusGroup"),
        "order_type": order.get("orderType"),
        "order_method": order.get("orderMethod"),
        "first_name": order.get("firstName"),
        "last_name": order.get("lastName"),
        "phone": order.get("phone"),
        "email": order.get("email"),
        "customer_id": customer.get("id"),
        "customer_external_id": customer.get("externalId"),
        "customer_comment": order.get("customerComment"),
        "manager_comment": order.get("managerComment"),
        "currency": order.get("currency"),
        "total_summ": to_float(order.get("totalSumm")),
        "prepay_sum": to_float(order.get("prepaySum")),
        "purchase_summ": to_float(order.get("purchaseSumm")),
        "mark": to_float(order.get("mark")),
        "created_at": order.get("createdAt"),
        "updated_at": order.get("updatedAt"),
        "status_updated_at": order.get("statusUpdatedAt"),
        "shipment_date": order.get("shipmentDate"),
        "is_deleted": bool(order.get("deleted", False)),
        "delivery_code": delivery.get("code"),
        "delivery_service_name": delivery.get("serviceName"),
        "items": order.get("items") if isinstance(order.get("items"), list) else [],
        "delivery": delivery,
        "custom_fields": order.get("customFields")
        if isinstance(order.get("customFields"), dict)
        else {},
        "raw_order": order,
        "synced_at": synced_at,
    }


def require_env(env: Dict[str, str], name: str) -> str:
    value = env.get(name)
    if not value:
        raise KeyError(name)
    return value


def get_optional_env(env: Dict[str, str], *names: str) -> Optional[str]:
    for name in names:
        value = env.get(name)
        if value:
            return value
    return None


def classify_supabase_key(value: str) -> str:
    if value.startswith("sb_publishable_"):
        return "publishable"
    if value.startswith("sb_secret_"):
        return "secret"
    if value.count(".") == 2:
        try:
            payload_part = value.split(".")[1]
            padded = payload_part + "=" * (-len(payload_part) % 4)
            payload = json.loads(
                __import__("base64").urlsafe_b64decode(padded.encode("utf-8")).decode("utf-8")
            )
            role = payload.get("role")
            if role == "service_role":
                return "legacy_service_role"
            if role == "anon":
                return "legacy_anon"
        except Exception:
            pass
        return "jwt"
    return "unknown"


def infer_project_ref(supabase_url: str) -> Optional[str]:
    parsed = urlparse(supabase_url)
    host = parsed.netloc
    if not host:
        return None

    suffix = ".supabase.co"
    if not host.endswith(suffix):
        return None

    project_ref = host[: -len(suffix)]
    return project_ref or None


def is_rls_error(exc: Exception) -> bool:
    if not isinstance(exc, JsonApiError):
        return False
    details_text = json.dumps(exc.details, ensure_ascii=False).lower()
    return "row-level security" in details_text or "row level security" in details_text


def main() -> int:
    args = parse_args()

    try:
        env = load_env(Path(args.env_file))
        retailcrm_url = require_env(env, "RETAILCRM_URL")
        retailcrm_api_key = require_env(env, "RETAILCRM_API_KEY")
        supabase_url = require_env(env, "SUPABASE_URL")
        supabase_key = (
            get_optional_env(
                env,
                "SUPABASE_SERVICE_KEY",
                "SUPABASE_SECRET_KEY",
                "SUPABASE_SERVICE_ROLE_KEY",
            )
            or ""
        )
        if not supabase_key:
            raise KeyError(
                "SUPABASE_SERVICE_KEY or SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY"
            )
        key_type = classify_supabase_key(supabase_key)
        if key_type in {"publishable", "legacy_anon"}:
            raise ValueError(
                "SUPABASE_SERVICE_KEY is not a privileged key. "
                "Use a Supabase secret key (sb_secret_...) or legacy service_role key, not a publishable/anon key."
            )
    except Exception as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 1

    request_timeout = int(env.get("REQUEST_TIMEOUT_SECONDS", "30"))
    request_delay = (
        args.delay
        if args.delay is not None
        else float(env.get("REQUEST_DELAY_SECONDS", "0.15"))
    )
    retailcrm_page_limit = (
        args.page_limit
        if args.page_limit is not None
        else int(env.get("RETAILCRM_PAGE_LIMIT", "50"))
    )
    supabase_batch_size = (
        args.batch_size
        if args.batch_size is not None
        else int(env.get("SUPABASE_BATCH_SIZE", "200"))
    )
    retailcrm_site = env.get("RETAILCRM_SITE_CODE") or None
    supabase_schema = env.get("SUPABASE_SCHEMA", "public")
    supabase_table = env.get("SUPABASE_ORDERS_TABLE", "retailcrm_orders")
    supabase_conflict_column = env.get(
        "SUPABASE_UPSERT_CONFLICT_COLUMN",
        "retailcrm_id",
    )
    supabase_access_token = env.get("SUPABASE_ACCESS_TOKEN")
    supabase_project_ref = env.get("SUPABASE_PROJECT_REF") or infer_project_ref(supabase_url)
    supabase_anon_key = get_optional_env(
        env,
        "SUPABASE_ANON_KEY",
        "SUPABASE_PUBLISHABLE_KEY",
    )
    telegram_alerts_enabled = parse_bool_env(env.get("TELEGRAM_ALERTS_ENABLED"), default=False)
    telegram_bot_token = env.get("TELEGRAM_BOT_TOKEN")
    telegram_chat_id = env.get("TELEGRAM_CHAT_ID")
    telegram_min_total_kzt = float(env.get("TELEGRAM_ALERT_MIN_TOTAL_KZT", "50000"))

    if retailcrm_page_limit <= 0 or supabase_batch_size <= 0:
        print("RETAILCRM_PAGE_LIMIT and SUPABASE_BATCH_SIZE must be greater than 0.", file=sys.stderr)
        return 1
    if telegram_min_total_kzt < 0:
        print("TELEGRAM_ALERT_MIN_TOTAL_KZT must be greater than or equal to 0.", file=sys.stderr)
        return 1
    if telegram_alerts_enabled and (not telegram_bot_token or not telegram_chat_id):
        print(
            "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when TELEGRAM_ALERTS_ENABLED=true.",
            file=sys.stderr,
        )
        return 1

    retailcrm = RetailCrmClient(
        base_url=retailcrm_url,
        api_key=retailcrm_api_key,
        timeout=request_timeout,
    )
    supabase = SupabaseClient(
        base_url=supabase_url,
        service_key=supabase_key,
        gateway_key=supabase_anon_key,
        schema=supabase_schema,
        table=supabase_table,
        conflict_column=supabase_conflict_column,
        timeout=request_timeout,
    )
    telegram = (
        TelegramClient(
            bot_token=telegram_bot_token,
            chat_id=telegram_chat_id,
            timeout=request_timeout,
        )
        if telegram_alerts_enabled and telegram_bot_token and telegram_chat_id
        else None
    )

    if args.create_table:
        if not supabase_access_token or not supabase_project_ref:
            print(
                "To create the table via Supabase Management API, set SUPABASE_ACCESS_TOKEN. SUPABASE_PROJECT_REF can be omitted if it can be inferred from SUPABASE_URL.",
                file=sys.stderr,
            )
            return 1

        try:
            if supabase.table_exists():
                print(f"Table {supabase_schema}.{supabase_table} already exists in Supabase.")
            else:
                management = SupabaseManagementClient(
                    access_token=supabase_access_token,
                    project_ref=supabase_project_ref,
                    timeout=request_timeout,
                )
                try:
                    management.create_orders_table(
                        schema=supabase_schema,
                        table=supabase_table,
                    )
                except Exception as exc:
                    print(f"Failed to create Supabase table via API: {exc}", file=sys.stderr)
                    return 1

                print(f"Ensured table {supabase_schema}.{supabase_table} exists via Supabase Management API.")
        except Exception as exc:
            print(f"Failed to check if Supabase table exists: {exc}", file=sys.stderr)
            return 1

    page = 1
    seen_orders = 0
    uploaded_rows = 0
    telegram_alerts_sent = 0
    synced_at = utc_now_iso()

    while True:
        if args.max_pages is not None and page > args.max_pages:
            break

        try:
            response = retailcrm.list_orders(
                page=page,
                limit=retailcrm_page_limit,
                site=retailcrm_site,
            )
        except Exception as exc:
            print(f"Failed to fetch RetailCRM page {page}: {exc}", file=sys.stderr)
            return 1

        orders = response.get("orders")
        pagination = response.get("pagination") or {}
        if not isinstance(orders, list):
            print(f"RetailCRM page {page} did not return an orders list: {response}", file=sys.stderr)
            return 1

        if not orders:
            break

        rows: List[Dict[str, Any]] = []
        for order in orders:
            if not isinstance(order, dict):
                continue
            rows.append(order_to_row(order, synced_at=synced_at))

        if args.max_orders is not None:
            remaining = args.max_orders - seen_orders
            if remaining <= 0:
                break
            rows = rows[:remaining]

        if args.dry_run:
            for row in rows:
                print(json.dumps(row, ensure_ascii=False))
        else:
            try:
                for batch in chunked(rows, supabase_batch_size):
                    supabase.upsert_rows(batch)
                    uploaded_rows += len(batch)
                    if telegram is not None:
                        telegram_alerts_sent += send_telegram_alerts_for_batch(
                            supabase=supabase,
                            telegram=telegram,
                            rows=batch,
                            min_total_kzt=telegram_min_total_kzt,
                        )
            except Exception as exc:
                if is_rls_error(exc):
                    print(
                        "Supabase rejected the write because of RLS. "
                        "Run with --create-table again so the script can ensure the table and service_role policy exist, "
                        "or verify that .env contains the real service role key in SUPABASE_SERVICE_KEY.",
                        file=sys.stderr,
                    )
                print(f"Failed to upsert Supabase batch from page {page}: {exc}", file=sys.stderr)
                return 1

        seen_orders += len(rows)
        if args.dry_run:
            uploaded_rows += len(rows)

        current_page = pagination.get("currentPage", page)
        total_pages = pagination.get("totalPageCount", current_page)
        print(
            f"Processed RetailCRM page {current_page}/{total_pages}. "
            f"Orders this page={len(rows)} total_synced={uploaded_rows} "
            f"telegram_alerts_sent={telegram_alerts_sent}"
        )

        if len(rows) < len(orders):
            break

        if current_page >= total_pages:
            break

        page += 1
        if request_delay > 0:
            time.sleep(request_delay)

    print(
        f"Done. pages_processed={page if seen_orders else 0} "
        f"orders_seen={seen_orders} orders_synced={uploaded_rows} "
        f"telegram_alerts_sent={telegram_alerts_sent}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
