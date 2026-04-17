#!/usr/bin/env python3
import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Upload orders from a JSON file to RetailCRM API v5."
    )
    parser.add_argument(
        "--env-file",
        default=".env",
        help="Path to the environment file. Default: .env",
    )
    parser.add_argument(
        "--file",
        default=None,
        help="Path to the orders JSON file. Overrides ORDERS_FILE from env.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and print normalized orders without sending them to RetailCRM.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Only process the first N orders.",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=None,
        help="Delay between requests in seconds. Overrides REQUEST_DELAY_SECONDS from env.",
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


def load_json(path: Path) -> Any:
    for encoding in ("utf-8-sig", "utf-8"):
        try:
            return json.loads(path.read_text(encoding=encoding))
        except UnicodeDecodeError:
            continue

    raise UnicodeDecodeError("utf-8", b"", 0, 1, f"Unable to decode file: {path}")


class RetailCrmApiError(RuntimeError):
    def __init__(self, message: str, details: Dict[str, Any]) -> None:
        super().__init__(message)
        self.details = details


class RetailCrmClient:
    def __init__(self, base_url: str, api_key: str, timeout: int = 30) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def get(self, path: str) -> Dict[str, Any]:
        request = Request(
            f"{self.base_url}{path}",
            headers={
                "X-API-KEY": self.api_key,
                "Accept": "application/json",
            },
        )
        return self._read_json(request)

    def post_form(self, path: str, payload: Dict[str, str]) -> Dict[str, Any]:
        request = Request(
            f"{self.base_url}{path}",
            data=urlencode(payload).encode("utf-8"),
            headers={
                "X-API-KEY": self.api_key,
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            method="POST",
        )
        return self._read_json(request)

    def _read_json(self, request: Request) -> Dict[str, Any]:
        try:
            with urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            try:
                details = json.loads(body)
            except json.JSONDecodeError:
                details = {"errorMsg": body or str(exc)}
            raise RetailCrmApiError(
                f"RetailCRM API returned HTTP {exc.code}: {details}",
                details,
            ) from exc
        except URLError as exc:
            raise RuntimeError(f"Failed to reach RetailCRM API: {exc}") from exc


def pick_site_code(
    explicit_site: Optional[str],
    sites: Dict[str, Dict[str, Any]],
) -> str:
    if explicit_site:
        if explicit_site in sites:
            return explicit_site
        raise ValueError(
            f"Configured RETAILCRM_SITE_CODE '{explicit_site}' is not available."
        )

    if len(sites) == 1:
        return next(iter(sites))

    raise ValueError(
        "RetailCRM account has multiple sites. Set RETAILCRM_SITE_CODE in .env."
    )


def active_codes(reference: Dict[str, Dict[str, Any]]) -> set[str]:
    return {
        code
        for code, item in reference.items()
        if item.get("active", True)
    }


def pick_default_code(reference: Dict[str, Dict[str, Any]]) -> Optional[str]:
    for code, item in reference.items():
        if item.get("defaultForApi"):
            return code

    for code, item in reference.items():
        if item.get("defaultForCrm"):
            return code

    for code, item in reference.items():
        if item.get("active", True):
            return code

    return None


def ensure_number(value: Any, field_name: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"'{field_name}' must be a number, got {value!r}") from exc


def ensure_positive_quantity(value: Any) -> float:
    quantity = ensure_number(value, "quantity")
    if quantity <= 0:
        raise ValueError(f"'quantity' must be greater than 0, got {value!r}")
    return quantity


def normalize_order(
    raw_order: Dict[str, Any],
    index: int,
    external_id_prefix: str,
    default_currency: str,
    method_codes: set[str],
    default_method: Optional[str],
    type_codes: set[str],
    default_type: Optional[str],
    status_codes: set[str],
    default_status: Optional[str],
) -> Tuple[Dict[str, Any], List[str]]:
    warnings: List[str] = []
    order: Dict[str, Any] = {}

    order["externalId"] = raw_order.get("externalId") or f"{external_id_prefix}-{index:04d}"
    order["currency"] = default_currency
    raw_currency = str(raw_order.get("currency") or "").strip().upper()
    if raw_currency and raw_currency != default_currency:
        warnings.append(
            f"Currency '{raw_currency}' replaced with '{default_currency}'."
        )

    for field in ("firstName", "lastName", "phone", "email", "customerComment"):
        if raw_order.get(field):
            order[field] = raw_order[field]

    raw_method = raw_order.get("orderMethod")
    if raw_method in method_codes:
        order["orderMethod"] = raw_method
    elif default_method:
        order["orderMethod"] = default_method
        if raw_method:
            warnings.append(
                f"Unknown orderMethod '{raw_method}', fallback to '{default_method}'."
            )

    raw_type = raw_order.get("orderType")
    if raw_type in type_codes:
        order["orderType"] = raw_type
    elif default_type:
        order["orderType"] = default_type
        if raw_type:
            warnings.append(
                f"Unknown orderType '{raw_type}', fallback to '{default_type}'."
            )

    raw_status = raw_order.get("status")
    if raw_status in status_codes:
        order["status"] = raw_status
    elif default_status:
        order["status"] = default_status
        if raw_status:
            warnings.append(
                f"Unknown status '{raw_status}', fallback to '{default_status}'."
            )

    items = raw_order.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError("Order must contain a non-empty 'items' array.")

    normalized_items: List[Dict[str, Any]] = []
    for item_index, raw_item in enumerate(items, start=1):
        if not isinstance(raw_item, dict):
            raise ValueError(f"Item #{item_index} must be an object.")

        product_name = raw_item.get("productName")
        if not product_name:
            raise ValueError(f"Item #{item_index} must contain 'productName'.")

        normalized_items.append(
            {
                "productName": product_name,
                "quantity": ensure_positive_quantity(raw_item.get("quantity")),
                "initialPrice": ensure_number(
                    raw_item.get("initialPrice"), "initialPrice"
                ),
            }
        )

    order["items"] = normalized_items

    if isinstance(raw_order.get("delivery"), dict):
        order["delivery"] = raw_order["delivery"]

    if isinstance(raw_order.get("customFields"), dict):
        order["customFields"] = raw_order["customFields"]

    return order, warnings


def iter_orders(data: Any) -> Iterable[Dict[str, Any]]:
    if not isinstance(data, list):
        raise ValueError("Orders file must contain a JSON array.")

    for item in data:
        if not isinstance(item, dict):
            raise ValueError("Each order must be a JSON object.")
        yield item


def main() -> int:
    args = parse_args()
    env = load_env(Path(args.env_file))

    try:
        base_url = env["RETAILCRM_URL"]
        api_key = env["RETAILCRM_API_KEY"]
    except KeyError as exc:
        print(f"Missing required env variable: {exc.args[0]}", file=sys.stderr)
        return 1

    orders_file = Path(args.file or env.get("ORDERS_FILE", "mock_orders.json"))
    if not orders_file.exists():
        print(f"Orders file not found: {orders_file}", file=sys.stderr)
        return 1

    external_id_prefix = env.get("ORDER_EXTERNAL_ID_PREFIX", "mock-order")
    default_currency = (env.get("ORDER_CURRENCY") or "KZT").strip().upper()
    timeout_seconds = int(env.get("REQUEST_TIMEOUT_SECONDS", "30"))
    delay_seconds = (
        args.delay
        if args.delay is not None
        else float(env.get("REQUEST_DELAY_SECONDS", "0.15"))
    )

    if not default_currency:
        print("ORDER_CURRENCY must not be empty.", file=sys.stderr)
        return 1

    client = RetailCrmClient(base_url=base_url, api_key=api_key, timeout=timeout_seconds)

    try:
        sites = client.get("/reference/sites")["sites"]
        order_methods = client.get("/reference/order-methods")["orderMethods"]
        order_types = client.get("/reference/order-types")["orderTypes"]
        statuses = client.get("/reference/statuses")["statuses"]
        site_code = pick_site_code(env.get("RETAILCRM_SITE_CODE"), sites)
    except Exception as exc:
        print(f"Failed to load RetailCRM reference data: {exc}", file=sys.stderr)
        return 1

    method_codes = active_codes(order_methods)
    type_codes = active_codes(order_types)
    status_codes = active_codes(statuses)

    default_method = pick_default_code(order_methods)
    default_type = pick_default_code(order_types)
    default_status = "new" if "new" in status_codes else pick_default_code(statuses)

    try:
        raw_orders = list(iter_orders(load_json(orders_file)))
    except Exception as exc:
        print(f"Failed to read orders file: {exc}", file=sys.stderr)
        return 1

    if args.limit is not None:
        raw_orders = raw_orders[: args.limit]

    uploaded = 0
    failed = 0

    for index, raw_order in enumerate(raw_orders, start=1):
        try:
            order, warnings = normalize_order(
                raw_order=raw_order,
                index=index,
                external_id_prefix=external_id_prefix,
                default_currency=default_currency,
                method_codes=method_codes,
                default_method=default_method,
                type_codes=type_codes,
                default_type=default_type,
                status_codes=status_codes,
                default_status=default_status,
            )
        except Exception as exc:
            failed += 1
            print(f"[{index}] Validation failed: {exc}", file=sys.stderr)
            continue

        for warning in warnings:
            print(f"[{index}] Warning: {warning}", file=sys.stderr)

        if args.dry_run:
            print(json.dumps({"site": site_code, "order": order}, ensure_ascii=False))
            uploaded += 1
            continue

        try:
            payload = {
                "site": site_code,
                "order": json.dumps(order, ensure_ascii=False),
            }
            try:
                response = client.post_form("/orders/create", payload)
                if not response.get("success"):
                    raise RuntimeError(response)

                uploaded += 1
                print(
                    f"[{index}] Uploaded externalId={order['externalId']} "
                    f"id={response.get('id')}"
                )
            except RetailCrmApiError as exc:
                if exc.details.get("errorMsg") != "Order already exists.":
                    raise

                response = client.post_form(
                    f"/orders/{quote(str(order['externalId']), safe='')}/edit",
                    payload,
                )
                if not response.get("success"):
                    raise RuntimeError(response)

                uploaded += 1
                print(
                    f"[{index}] Updated externalId={order['externalId']} "
                    f"id={response.get('id')}"
                )
        except Exception as exc:
            failed += 1
            print(
                f"[{index}] Upload failed for externalId={order['externalId']}: {exc}",
                file=sys.stderr,
            )

        if delay_seconds > 0:
            time.sleep(delay_seconds)

    print(
        f"Done. Processed={len(raw_orders)} uploaded={uploaded} failed={failed}",
        file=sys.stderr if failed else sys.stdout,
    )

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
