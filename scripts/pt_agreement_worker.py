#!/opt/hermes/.venv/bin/python
"""Bounded PT-agreement reader for the new Portal Postdates tracker.

One invocation claims at most one ``parse_pt_agreement_v1`` job. Each PDF is
rendered once, read by one primary multimodal call, and checked by one fresh
verification call. Arithmetic, status, source comparison, API writes, leases,
and retries are deterministic Python -- never an agent tool loop.
"""

from __future__ import annotations

import base64
from contextlib import contextmanager
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import fcntl
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Iterator, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


JOB_TYPE = "parse_pt_agreement_v1"
CONTRACT_VERSION = "pdn-v1"
PROMPT_VERSION = "pt-agreement-v8-identity-crosscheck"
DEFAULT_MODEL = "gpt-5.6-sol"
DEFAULT_PROVIDER = "openai-codex"
DEFAULT_REASONING_EFFORT = "high"
VALID_REASONING_EFFORTS = {"none", "low", "medium", "high", "xhigh", "max"}
DEFAULT_API_BASE = "https://ecacombined-1.onrender.com"
DEFAULT_ENV_FILE = "/opt/data/.env"
DEFAULT_LOCK_FILE = "/tmp/eca_pt_agreement_worker.lock"
DEFAULT_LEASE_SECONDS = 180

EXIT_NO_JOB = 0
EXIT_PROCESSED = 10
EXIT_RETRYABLE_FAILURE = 20
EXIT_TERMINAL_FAILURE = 21
EXIT_LOCKED = 75

CRITICAL_UNCERTAINTY_TERMS = (
    "agreement date",
    "form type",
    "pt agreement",
    "member number",
    "pd row",
    "pd slot",
    "postdate",
    "post date",
    "schedule",
    "slot",
    "payment schedule",
    "installment",
    "overflow",
)

TEXT_FIELDS = (
    "agreement_date",
    "start_date",
    "expiration_date",
    "member_last_name",
    "member_first_name",
    "member_number",
    "trainer",
    "sold_by",
)
INTEGER_FIELDS = (
    "number_of_sessions",
    "duration_of_sessions",
    "number_of_months",
    "sessions_per_week",
)
MONEY_FIELDS = (
    "amount_per_session",
    "sub_total",
    "tax",
    "total",
    "total_paid_today",
    "remaining_balance",
)


PRIMARY_SYSTEM_PROMPT = f"""You are the primary reader for one scanned ECA Personal Training agreement.
Return ONLY one JSON object, with no markdown or commentary.

Read visible paper truth. Never change a value to make arithmetic work. Printed
values control unless a visibly linked handwritten correction (strike-through,
arrow, caret, replacement, or initials) changes that same field; then emit only
the controlling corrected value and explain the replacement in a note/warning.

The PD slip has five printed rows, but handwritten funded rows below it are real
installments. Continue ordinals 6, 7, and onward. A linked correction to a prior
row is not a new installment. Inspect the entire area below row 5.

Transcribe the member number from the page independently, digit by digit. You
are not being given source metadata. Do not infer illegible digits.

Required JSON keys:
is_pt_agreement, legible, form_type, agreement_date, start_date,
expiration_date, member_last_name, member_first_name, member_number, trainer,
sold_by, number_of_sessions, amount_per_session, sub_total, tax, total,
total_paid_today, remaining_balance, duration_of_sessions, number_of_months,
sessions_per_week, signature_present, pd_slots, uncertain_fields, confidence,
warnings.

form_type is exactly "New PT", "Renew PT", or "unknown". Dates are ISO
YYYY-MM-DD or null. Money and counts are JSON numbers or null. pd_slots contains
every printed row 1-5 plus any real overflow row, in page order, using:
{{"ordinal":1,"state":"filled|zero|blank","amount_text":"visible text or null",
"amount_value":221.0,"date_text":"visible text or null",
"date_iso":"2026-04-10 or null","note":"correction/handwriting note or null"}}.
Use state filled only for a positive amount with a date, zero for a visible zero,
and blank when both cells are blank. Maximum ordinal is 20.

If the document is not a PT agreement, set is_pt_agreement false, form_type
unknown, and explain what it is in warnings. List every genuinely uncertain
critical field in uncertain_fields. Signature presence is informational only.
Contract: {CONTRACT_VERSION}; reader rules: {PROMPT_VERSION}.
"""


VERIFY_SYSTEM_PROMPT = """Independently verify only the critical facts on one scanned ECA PT agreement.
Return ONLY one JSON object. Do not infer missing values and do not assume a
five-row maximum. Inspect below the printed slip and distinguish a new overflow
installment from a linked correction to an earlier row.

Return these keys only: member_number, agreement_date, form_type,
is_pt_agreement, pd_slots, overflow_rows_seen, corrections_seen,
uncertain_fields, warnings. Transcribe independently from the images. pd_slots
uses ordinal, state, amount_value, date_iso, and note. Include rows 1-5 plus any
real overflow rows. form_type is New PT, Renew PT, or unknown. Dates are ISO or
null. Do not provide prose outside the JSON object.
"""


class WorkerError(RuntimeError):
    def __init__(self, message: str, *, code: str, retryable: bool) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class ApiError(WorkerError):
    def __init__(self, status: int, message: str) -> None:
        retryable = status >= 500 or status in {408, 425, 429}
        code = "TRANSIENT_NETWORK" if retryable else "INTERNAL_ERROR"
        super().__init__(
            f"backend returned HTTP {status}: {message[:300]}",
            code=code,
            retryable=retryable,
        )
        self.status = status


def _load_env_file(path: str) -> None:
    env_path = Path(path)
    if not env_path.is_file():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


def _json_log(event: str, **fields: Any) -> None:
    safe = {"event": event, **fields}
    print(json.dumps(safe, sort_keys=True, default=str), flush=True)


@contextmanager
def _single_instance(path: str) -> Iterator[bool]:
    lock_path = Path(path)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    handle = lock_path.open("a+")
    acquired = False
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except BlockingIOError:
            pass
        yield acquired
    finally:
        if acquired:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


class BackendClient:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[dict] = None,
        timeout: int = 30,
        expect_json: bool = True,
    ) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {
            "Authorization": f"Bearer {self.token}",
            "Accept": "application/json" if expect_json else "application/pdf",
        }
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = Request(
            f"{self.base_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                payload = response.read()
        except HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise ApiError(exc.code, detail) from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise WorkerError(
                f"backend request failed: {type(exc).__name__}",
                code="TRANSIENT_NETWORK",
                retryable=True,
            ) from exc
        if not expect_json:
            return payload
        try:
            return json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise WorkerError(
                "backend returned malformed JSON",
                code="TRANSIENT_NETWORK",
                retryable=True,
            ) from exc

    def claim(self, lease_seconds: int) -> Optional[dict]:
        label = f"pt-direct-{datetime.utcnow():%m%d%H%M%S}"
        result = self.request(
            "POST",
            "/api/hermes/jobs/claim",
            body={
                "job_types": [JOB_TYPE],
                "lease_seconds": lease_seconds,
                "worker_label": label,
            },
        )
        return result if result.get("job_id") else None

    def heartbeat(self, job_id: int, lease_token: str, lease_seconds: int) -> None:
        self.request(
            "POST",
            f"/api/hermes/jobs/{job_id}/heartbeat",
            body={"lease_token": lease_token, "extend_seconds": lease_seconds},
        )

    def download_pdf(self, job_id: int, asset_id: int, lease_token: str) -> bytes:
        token = quote(lease_token, safe="")
        return self.request(
            "GET",
            f"/api/hermes/jobs/{job_id}/pt-asset/{asset_id}/pdf?lease_token={token}",
            timeout=30,
            expect_json=False,
        )

    def context(self, job_id: int, asset_id: int, lease_token: str) -> dict:
        token = quote(lease_token, safe="")
        return self.request(
            "GET",
            f"/api/hermes/jobs/{job_id}/pt-asset/{asset_id}/context?lease_token={token}",
        )

    def submit_parse(
        self,
        job_id: int,
        asset_id: int,
        lease_token: str,
        extraction: dict,
        *,
        provider: str,
        model: str,
        reasoning_effort: str,
    ) -> dict:
        return self.request(
            "POST",
            f"/api/hermes/jobs/{job_id}/pt-asset/{asset_id}/parse",
            body={
                "lease_token": lease_token,
                "extraction": extraction,
                "provider": provider,
                "model": model,
                "reasoning_effort": reasoning_effort,
            },
            timeout=45,
        )

    def complete(self, job_id: int, lease_token: str, result: dict) -> dict:
        return self.request(
            "POST",
            f"/api/hermes/jobs/{job_id}/complete",
            body={"lease_token": lease_token, "schema_version": None, "result": result},
        )

    def fail(
        self,
        job_id: int,
        lease_token: str,
        error_code: str,
        error_message: str,
        retryable: bool,
    ) -> None:
        self.request(
            "POST",
            f"/api/hermes/jobs/{job_id}/fail",
            body={
                "lease_token": lease_token,
                "error_code": error_code,
                "error_message": error_message[:500],
                "retryable": retryable,
            },
        )


class LeaseHeartbeat:
    def __init__(
        self,
        client: BackendClient,
        job_id: int,
        lease_token: str,
        lease_seconds: int,
    ) -> None:
        self.client = client
        self.job_id = job_id
        self.lease_token = lease_token
        self.lease_seconds = lease_seconds
        self.interval = max(30, min(60, lease_seconds // 3))
        self.stop_event = threading.Event()
        self.lost = threading.Event()
        self.thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self.stop_event.wait(self.interval):
            try:
                self.client.heartbeat(
                    self.job_id, self.lease_token, self.lease_seconds
                )
            except ApiError as exc:
                if exc.status in {403, 409}:
                    self.lost.set()
                    return
                _json_log("heartbeat_warning", job_id=self.job_id, status=exc.status)
            except WorkerError as exc:
                _json_log("heartbeat_warning", job_id=self.job_id, code=exc.code)

    def __enter__(self) -> "LeaseHeartbeat":
        self.thread.start()
        return self

    def __exit__(self, *_args: Any) -> None:
        self.stop_event.set()
        self.thread.join(timeout=2)


def _render_views(pdf_bytes: bytes, directory: Path) -> list[tuple[str, Path]]:
    if not pdf_bytes.startswith(b"%PDF"):
        raise WorkerError("download was not a PDF", code="PDF_INVALID", retryable=False)
    pdf_path = directory / "agreement.pdf"
    pdf_path.write_bytes(pdf_bytes)
    full_prefix = directory / "agreement_full"
    try:
        subprocess.run(
            [
                "pdftoppm",
                "-f",
                "1",
                "-l",
                "1",
                "-singlefile",
                "-jpeg",
                "-jpegopt",
                "quality=92",
                "-scale-to",
                "2400",
                str(pdf_path),
                str(full_prefix),
            ],
            check=True,
            capture_output=True,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.SubprocessError) as exc:
        raise WorkerError(
            "could not render the first PDF page", code="PDF_INVALID", retryable=False
        ) from exc
    full_path = directory / "agreement_full.jpg"
    try:
        from PIL import Image

        with Image.open(full_path) as image:
            image = image.convert("RGB")
            width, height = image.size
            left_path = directory / "agreement_left.jpg"
            right_path = directory / "agreement_right.jpg"
            image.crop((0, 0, int(width * 0.58), height)).save(
                left_path, "JPEG", quality=92, optimize=True
            )
            image.crop((int(width * 0.42), 0, width, height)).save(
                right_path, "JPEG", quality=92, optimize=True
            )
    except Exception as exc:
        raise WorkerError(
            "could not prepare agreement image views",
            code="PDF_INVALID",
            retryable=False,
        ) from exc
    return [
        ("complete page", full_path),
        ("left side including identity fields", left_path),
        ("right side including totals, PD slip, and area below row 5", right_path),
    ]


def _data_url(path: Path) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def _model_messages(prompt: str, views: list[tuple[str, Path]]) -> list[dict]:
    content: list[dict] = [
        {
            "type": "text",
            "text": "Read the same agreement from the complete view and overlapping detail views.",
        }
    ]
    for label, path in views:
        content.append({"type": "text", "text": f"View: {label}"})
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": _data_url(path), "detail": "high"},
            }
        )
    return [
        {"role": "system", "content": prompt},
        {"role": "user", "content": content},
    ]


def _parse_json_object(content: Any) -> dict:
    if not isinstance(content, str) or not content.strip():
        raise WorkerError(
            "model returned empty content", code="MODEL_FAILED", retryable=True
        )
    text = content.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise WorkerError(
            "model response did not contain a JSON object",
            code="MODEL_FAILED",
            retryable=True,
        )
    try:
        value = json.loads(text[start : end + 1])
    except json.JSONDecodeError as exc:
        raise WorkerError(
            "model returned malformed JSON", code="MODEL_FAILED", retryable=True
        ) from exc
    if not isinstance(value, dict):
        raise WorkerError(
            "model JSON was not an object", code="MODEL_FAILED", retryable=True
        )
    return value


def _invoke_model(
    prompt: str,
    views: list[tuple[str, Path]],
    *,
    provider: str,
    model: str,
    reasoning_effort: str,
    timeout: int,
) -> tuple[dict, float]:
    hermes_root = os.environ.get("HERMES_APP_ROOT", "/opt/hermes")
    if hermes_root not in sys.path:
        sys.path.insert(0, hermes_root)
    try:
        from agent.auxiliary_client import call_llm
    except ImportError as exc:
        raise WorkerError(
            "Hermes auxiliary model runtime is unavailable",
            code="INTERNAL_ERROR",
            retryable=True,
        ) from exc
    started = time.monotonic()
    try:
        response = call_llm(
            task="vision",
            provider=provider,
            model=model,
            messages=_model_messages(prompt, views),
            max_tokens=5000,
            timeout=timeout,
            extra_body={"reasoning": {"effort": reasoning_effort}},
        )
        content = response.choices[0].message.content
    except WorkerError:
        raise
    except Exception as exc:
        message = str(exc).lower()
        rate_limited = "429" in message or "rate limit" in message
        raise WorkerError(
            "model request failed",
            code="MODEL_RATE_LIMITED" if rate_limited else "MODEL_FAILED",
            retryable=True,
        ) from exc
    return _parse_json_object(content), time.monotonic() - started


def _text(value: Any) -> Optional[str]:
    if value is None:
        return None
    result = str(value).strip()
    return result or None


def _digits(value: Any) -> Optional[str]:
    result = "".join(character for character in str(value or "") if character.isdigit())
    return result or None


def _normalized_member(value: Any) -> Optional[str]:
    digits = _digits(value)
    if not digits:
        return None
    normalized = digits.lstrip("0")
    return normalized or "0"


def _integer(value: Any) -> Optional[int]:
    if value in (None, "") or isinstance(value, bool):
        return None
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _decimal(value: Any) -> Optional[Decimal]:
    if value in (None, "") or isinstance(value, bool):
        return None
    try:
        cleaned = str(value).strip().replace("$", "").replace(",", "")
        result = Decimal(cleaned)
    except (InvalidOperation, TypeError, ValueError):
        return None
    return result if result.is_finite() else None


def _money(value: Any) -> Optional[float]:
    result = _decimal(value)
    return None if result is None else float(result.quantize(Decimal("0.01")))


def _confidence(value: Any) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return 0.0
    if result != result or result in {float("inf"), float("-inf")}:
        return 0.0
    return max(0.0, min(1.0, result))


def _iso_date(value: Any) -> Optional[str]:
    text = _text(value)
    if not text:
        return None
    for pattern in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(text, pattern).date().isoformat()
        except ValueError:
            pass
    return None


def _bool(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "yes", "checked", "present"}:
            return True
        if lowered in {"false", "no", "unchecked", "absent"}:
            return False
    return None


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item).strip()[:500] for item in value if str(item).strip()]


def _normalize_slots(value: Any, warnings: list[str]) -> list[dict]:
    raw_slots = value if isinstance(value, list) else []
    by_ordinal: dict[int, dict] = {}
    for raw in raw_slots:
        if not isinstance(raw, dict):
            warnings.append("Reader emitted a non-object postdate row; it was ignored.")
            continue
        ordinal = _integer(raw.get("ordinal"))
        if ordinal is None or not 1 <= ordinal <= 20 or ordinal in by_ordinal:
            warnings.append("Reader emitted an invalid or duplicate postdate ordinal.")
            continue
        amount = _money(raw.get("amount_value"))
        date_iso = _iso_date(raw.get("date_iso"))
        requested_state = _text(raw.get("state"))
        if amount is not None and amount > 0 and date_iso:
            state = "filled"
        elif amount == 0 and not date_iso:
            state = "zero"
        elif amount is None and not date_iso:
            state = "blank"
        else:
            state = requested_state if requested_state in {"filled", "zero", "blank"} else "blank"
            warnings.append(f"Postdate ordinal {ordinal} has an incomplete amount/date pair.")
        by_ordinal[ordinal] = {
            "ordinal": ordinal,
            "state": state,
            "amount_text": _text(raw.get("amount_text")),
            "amount_value": amount,
            "date_text": _text(raw.get("date_text")),
            "date_iso": date_iso,
            "note": _text(raw.get("note")),
        }
    for ordinal in range(1, 6):
        if ordinal not in by_ordinal:
            warnings.append(
                f"Reader omitted printed postdate row {ordinal}; stored as blank and held for review."
            )
            by_ordinal[ordinal] = {
                "ordinal": ordinal,
                "state": "blank",
                "amount_text": None,
                "amount_value": None,
                "date_text": None,
                "date_iso": None,
                "note": "reader omitted printed row; normalized to blank",
            }
    return [by_ordinal[key] for key in sorted(by_ordinal)]


def _money_equal(left: Decimal, right: Decimal) -> bool:
    cent = Decimal("0.01")
    return left.quantize(cent, rounding=ROUND_HALF_UP) == right.quantize(
        cent, rounding=ROUND_HALF_UP
    )


def _compute_checks(extraction: dict, warnings: list[str]) -> None:
    sessions = _integer(extraction.get("number_of_sessions"))
    amount = _decimal(extraction.get("amount_per_session"))
    subtotal = _decimal(extraction.get("sub_total"))
    tax = _decimal(extraction.get("tax"))
    total = _decimal(extraction.get("total"))
    paid = _decimal(extraction.get("total_paid_today"))
    remaining = _decimal(extraction.get("remaining_balance"))
    funded = [
        _decimal(slot.get("amount_value"))
        for slot in extraction["pd_slots"]
        if slot.get("state") == "filled"
    ]

    checks: dict[str, Optional[bool]] = {
        "check_sessions_math": None,
        "check_subtotal_plus_tax_equals_total": None,
        "check_paid_plus_remaining_eq_total": None,
        "check_pd_sum_equals_remaining": None,
        "check_tax_rate_sane": None,
    }
    if sessions is not None and amount is not None and subtotal is not None:
        checks["check_sessions_math"] = _money_equal(Decimal(sessions) * amount, subtotal)
    if subtotal is not None and tax is not None and total is not None:
        checks["check_subtotal_plus_tax_equals_total"] = _money_equal(subtotal + tax, total)
    if paid is not None and remaining is not None and total is not None:
        checks["check_paid_plus_remaining_eq_total"] = _money_equal(paid + remaining, total)
    if remaining is not None and all(value is not None for value in funded):
        checks["check_pd_sum_equals_remaining"] = _money_equal(
            sum((value for value in funded if value is not None), Decimal("0")),
            remaining,
        )
    if subtotal is not None and subtotal > 0 and tax is not None and tax >= 0:
        rate = tax / subtotal
        checks["check_tax_rate_sane"] = Decimal("0.08") <= rate <= Decimal("0.11")

    labels = {
        "check_sessions_math": "sessions × amount per session does not equal subtotal",
        "check_subtotal_plus_tax_equals_total": "subtotal + tax does not equal total",
        "check_paid_plus_remaining_eq_total": "paid today + remaining balance does not equal total",
        "check_pd_sum_equals_remaining": "funded postdates do not equal remaining balance",
        "check_tax_rate_sane": "printed tax rate is outside the expected 8–11% range",
    }
    for field, result in checks.items():
        extraction[field] = result
        if result is False:
            warnings.append(labels[field] + "; visible values were preserved.")


def _normalize_primary(raw: dict) -> tuple[dict, list[str]]:
    warnings = _string_list(raw.get("warnings"))
    result: dict[str, Any] = {
        "is_pt_agreement": _bool(raw.get("is_pt_agreement")),
        "legible": _bool(raw.get("legible")),
        "form_type": _text(raw.get("form_type")) or "unknown",
        "signature_present": _bool(raw.get("signature_present")),
    }
    if result["form_type"] not in {"New PT", "Renew PT", "unknown"}:
        result["form_type"] = "unknown"
        warnings.append("Reader returned an unsupported PT form label.")
    for field in TEXT_FIELDS:
        result[field] = _iso_date(raw.get(field)) if field.endswith("date") else _text(raw.get(field))
    for field in INTEGER_FIELDS:
        result[field] = _integer(raw.get(field))
    for field in MONEY_FIELDS:
        result[field] = _money(raw.get(field))
    result["pd_slots"] = _normalize_slots(raw.get("pd_slots"), warnings)
    result["confidence"] = _confidence(raw.get("confidence"))
    result["contract_version"] = CONTRACT_VERSION
    result["warnings"] = warnings
    uncertainty = _string_list(raw.get("uncertain_fields"))
    return result, uncertainty


def _operational_slot_fingerprint(slots: Any) -> list[tuple[int, str, str]]:
    fingerprint: list[tuple[int, str, str]] = []
    if not isinstance(slots, list):
        return fingerprint
    for slot in slots:
        if not isinstance(slot, dict):
            continue
        ordinal = _integer(slot.get("ordinal"))
        amount = _money(slot.get("amount_value"))
        date_iso = _iso_date(slot.get("date_iso"))
        if ordinal is None or (amount is None or amount <= 0) and not date_iso:
            continue
        amount_text = "" if amount is None else f"{amount:.2f}"
        fingerprint.append((ordinal, amount_text, date_iso or ""))
    return sorted(fingerprint)


def _has_critical_uncertainty(items: Any) -> bool:
    for item in _string_list(items):
        normalized = " ".join(
            item.lower().replace("_", " ").replace("[", " ").replace("]", " ").split()
        )
        if any(term in normalized for term in CRITICAL_UNCERTAINTY_TERMS):
            return True
    return False


def _verifier_schedule_errors(verifier: dict) -> list[str]:
    """Require explicit negative evidence before accepting an empty schedule."""
    slots = verifier.get("pd_slots")
    if not isinstance(slots, list):
        return ["independent verifier omitted the postdate schedule"]

    errors: list[str] = []
    ordinals: list[int] = []
    for raw in slots:
        if not isinstance(raw, dict):
            errors.append("independent verifier returned a malformed postdate row")
            continue
        ordinal = _integer(raw.get("ordinal"))
        state = _text(raw.get("state"))
        amount = _money(raw.get("amount_value"))
        date_iso = _iso_date(raw.get("date_iso"))
        if ordinal is None or not 1 <= ordinal <= 20:
            errors.append("independent verifier returned an invalid postdate ordinal")
            continue
        ordinals.append(ordinal)
        if raw.get("amount_value") not in (None, "") and amount is None:
            errors.append("independent verifier returned a malformed postdate amount")
        if raw.get("date_iso") not in (None, "") and date_iso is None:
            errors.append("independent verifier returned a malformed postdate date")
        if state not in {"filled", "zero", "blank"}:
            errors.append("independent verifier omitted a valid postdate row state")
        elif state == "filled" and not (amount is not None and amount > 0 and date_iso):
            errors.append("independent verifier returned an incomplete funded postdate")
        elif state == "zero" and not (amount == 0 and not date_iso):
            errors.append("independent verifier returned an inconsistent zero postdate")
        elif state == "blank" and (amount is not None or date_iso):
            errors.append("independent verifier returned values in a blank postdate row")

    ordinal_set = set(ordinals)
    if len(ordinals) != len(ordinal_set):
        errors.append("independent verifier returned duplicate postdate ordinals")
    if not set(range(1, 6)).issubset(ordinal_set):
        errors.append("independent verifier did not explicitly cover printed rows 1-5")
    if ordinal_set and ordinal_set != set(range(1, max(ordinal_set) + 1)):
        errors.append("independent verifier returned a non-contiguous postdate schedule")

    overflow_seen = _bool(verifier.get("overflow_rows_seen"))
    has_overflow_slots = any(ordinal > 5 for ordinal in ordinal_set)
    has_funded_overflow = any(
        isinstance(raw, dict)
        and (_integer(raw.get("ordinal")) or 0) > 5
        and _text(raw.get("state")) == "filled"
        and (_money(raw.get("amount_value")) or 0) > 0
        and _iso_date(raw.get("date_iso")) is not None
        for raw in slots
    )
    if overflow_seen is None:
        errors.append("independent verifier omitted the overflow-row decision")
    elif overflow_seen and not has_funded_overflow:
        errors.append("independent verifier saw overflow rows but did not transcribe them")
    elif not overflow_seen and has_overflow_slots:
        errors.append("independent verifier contradicted its overflow-row decision")
    return list(dict.fromkeys(errors))


def _verification_disagreements(primary: dict, verifier: dict) -> list[str]:
    disagreements = _verifier_schedule_errors(verifier)
    if _normalized_member(primary.get("member_number")) != _normalized_member(
        verifier.get("member_number")
    ):
        disagreements.append("independent verifier disagreed on member number")
    if primary.get("agreement_date") != _iso_date(verifier.get("agreement_date")):
        disagreements.append("independent verifier disagreed on agreement date")
    verifier_form = _text(verifier.get("form_type")) or "unknown"
    if primary.get("form_type") != verifier_form:
        disagreements.append("independent verifier disagreed on form type")
    if primary.get("is_pt_agreement") != _bool(verifier.get("is_pt_agreement")):
        disagreements.append("independent verifier disagreed on document type")
    if _operational_slot_fingerprint(primary.get("pd_slots")) != _operational_slot_fingerprint(
        verifier.get("pd_slots")
    ):
        disagreements.append("independent verifier disagreed on funded postdate schedule")
    if _has_critical_uncertainty(verifier.get("uncertain_fields")):
        disagreements.append("independent verifier reported critical uncertainty")
    if _has_critical_uncertainty(verifier.get("warnings")):
        disagreements.append("independent verifier warned about a critical field")
    return list(dict.fromkeys(disagreements))


def _finalize_extraction(
    primary_raw: dict,
    verifier_raw: dict,
    expected_member_number: Any,
) -> dict:
    extraction, primary_uncertainty = _normalize_primary(primary_raw)
    warnings = extraction["warnings"]
    disagreements = _verification_disagreements(extraction, verifier_raw)
    warnings.extend(f"{message}; candidate held for review." for message in disagreements)

    visual_member = _normalized_member(extraction.get("member_number"))
    source_member = _normalized_member(expected_member_number)
    source_mismatch = bool(visual_member and source_member and visual_member != source_member)
    if source_mismatch:
        warnings.append(
            "Visually read member number differs from source metadata; visible read was preserved and held for review."
        )
    elif not visual_member:
        warnings.append("Member number was not confidently readable from the agreement.")

    _compute_checks(extraction, warnings)
    funded = _operational_slot_fingerprint(extraction["pd_slots"])
    if extraction.get("is_pt_agreement") is not True:
        extraction["plan_type"] = "unclear"
    elif funded:
        extraction["plan_type"] = "payment_plan"
    else:
        paid = _decimal(extraction.get("total_paid_today"))
        total = _decimal(extraction.get("total"))
        remaining = _decimal(extraction.get("remaining_balance"))
        fully_paid_on_page = (
            paid is not None
            and total is not None
            and paid > 0
            and _money_equal(paid, total)
            and (remaining is None or _money_equal(remaining, Decimal("0")))
        )
        # A signing payment by itself never proves paid-in-full. It is only
        # classified that way when the page's total and remaining fields also
        # agree and both readers found no funded postdate schedule.
        extraction["plan_type"] = "paid_in_full" if fully_paid_on_page else "unclear"

    primary_critical_uncertainty = _has_critical_uncertainty(primary_uncertainty)
    missing_critical = (
        not extraction.get("agreement_date")
        or not extraction.get("member_number")
        or len(extraction.get("pd_slots") or []) < 5
    )
    normalized_schedule_uncertainty = any(
        warning.startswith("Reader omitted printed postdate row")
        or "has an incomplete amount/date pair" in warning
        for warning in warnings
    )
    if extraction.get("legible") is False:
        extraction["status"] = "unreadable"
    elif (
        disagreements
        or source_mismatch
        or primary_critical_uncertainty
        or missing_critical
        or normalized_schedule_uncertainty
    ):
        extraction["status"] = "partial"
    else:
        extraction["status"] = "ok"
    if extraction.get("legible") is None:
        extraction["legible"] = False
        extraction["status"] = "partial"
    extraction["warnings"] = list(dict.fromkeys(warnings))
    return extraction


def _process_asset(
    client: BackendClient,
    job_id: int,
    lease_token: str,
    asset_id: int,
    *,
    provider: str,
    model: str,
    reasoning_effort: str,
    model_timeout: int,
) -> dict:
    started = time.monotonic()
    pdf_bytes = client.download_pdf(job_id, asset_id, lease_token)
    with tempfile.TemporaryDirectory(prefix=f"eca-pt-{job_id}-{asset_id}-") as temp:
        views = _render_views(pdf_bytes, Path(temp))
        primary, primary_seconds = _invoke_model(
            PRIMARY_SYSTEM_PROMPT,
            views,
            provider=provider,
            model=model,
            reasoning_effort=reasoning_effort,
            timeout=model_timeout,
        )
        # Source context is intentionally fetched only after the primary visual read.
        context = client.context(job_id, asset_id, lease_token)
        verifier, verify_seconds = _invoke_model(
            VERIFY_SYSTEM_PROMPT,
            views,
            provider=provider,
            model=model,
            reasoning_effort=reasoning_effort,
            timeout=model_timeout,
        )
    extraction = _finalize_extraction(
        primary, verifier, context.get("expected_member_number")
    )
    response = client.submit_parse(
        job_id,
        asset_id,
        lease_token,
        extraction,
        provider=provider,
        model=model,
        reasoning_effort=reasoning_effort,
    )
    _json_log(
        "asset_processed",
        job_id=job_id,
        asset_id=asset_id,
        primary_seconds=round(primary_seconds, 2),
        verifier_seconds=round(verify_seconds, 2),
        total_seconds=round(time.monotonic() - started, 2),
        status=extraction["status"],
        plan_type=extraction["plan_type"],
        postdate_rows=len(extraction["pd_slots"]),
        provider=provider,
        model=model,
        reasoning_effort=reasoning_effort,
        promotion_status=response.get("promotion_status") or response.get("result"),
    )
    return {
        "asset_id": asset_id,
        "status": "parsed",
        "parse_attempt_id": response.get("parse_attempt_id"),
        "promotion_status": response.get("promotion_status") or response.get("result"),
        "promotion_reasons": response.get("promotion_reasons") or [],
    }


def _memory_mb() -> float:
    raw = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return round(raw / 1024.0, 1)


def run() -> int:
    _load_env_file(os.environ.get("ECA_WATCHDOG_ENV_FILE", DEFAULT_ENV_FILE))
    base_url = os.environ.get("ECA_API_BASE_URL", DEFAULT_API_BASE).rstrip("/")
    token = os.environ.get("ECA_HERMES_SERVICE_TOKEN", "").strip()
    provider = os.environ.get("ECA_PT_READER_PROVIDER", DEFAULT_PROVIDER).strip()
    model = os.environ.get("ECA_PT_READER_MODEL", DEFAULT_MODEL).strip()
    reasoning_effort = os.environ.get(
        "ECA_PT_REASONING_EFFORT", DEFAULT_REASONING_EFFORT
    ).strip().lower()
    lease_seconds = int(os.environ.get("ECA_PT_LEASE_SECONDS", DEFAULT_LEASE_SECONDS))
    model_timeout = int(os.environ.get("ECA_PT_MODEL_TIMEOUT", "90"))
    lease_seconds = max(90, min(600, lease_seconds))
    if reasoning_effort not in VALID_REASONING_EFFORTS:
        _json_log(
            "configuration_error",
            invalid="ECA_PT_REASONING_EFFORT",
            value=reasoning_effort,
        )
        return EXIT_TERMINAL_FAILURE
    if not token:
        _json_log("configuration_error", missing="ECA_HERMES_SERVICE_TOKEN")
        return EXIT_TERMINAL_FAILURE

    with _single_instance(os.environ.get("ECA_PT_LOCK_FILE", DEFAULT_LOCK_FILE)) as acquired:
        if not acquired:
            _json_log("worker_busy")
            return EXIT_LOCKED
        client = BackendClient(base_url, token)
        started = time.monotonic()
        claim: Optional[dict] = None
        try:
            claim = client.claim(lease_seconds)
            if not claim:
                return EXIT_NO_JOB
            job_id = int(claim["job_id"])
            lease_token = str(claim["lease_token"])
            job = claim.get("job") or {}
            asset_ids = (job.get("payload") or {}).get("asset_ids") or []
            if job.get("job_type") != JOB_TYPE or len(asset_ids) != 1:
                raise WorkerError(
                    "claimed PT job must contain exactly one asset",
                    code="SCHEMA_IMPOSSIBLE",
                    retryable=False,
                )
            _json_log(
                "job_claimed",
                job_id=job_id,
                assets=len(asset_ids),
                provider=provider,
                model=model,
                reasoning_effort=reasoning_effort,
            )
            results: list[dict] = []
            with LeaseHeartbeat(
                client, job_id, lease_token, lease_seconds
            ) as heartbeat:
                for asset_id in asset_ids:
                    if heartbeat.lost.is_set():
                        raise WorkerError(
                            "lease was lost during processing",
                            code="TRANSIENT_NETWORK",
                            retryable=True,
                        )
                    results.append(
                        _process_asset(
                            client,
                            job_id,
                            lease_token,
                            int(asset_id),
                            provider=provider,
                            model=model,
                            reasoning_effort=reasoning_effort,
                            model_timeout=model_timeout,
                        )
                    )
                if heartbeat.lost.is_set():
                    raise WorkerError(
                        "lease was lost before completion",
                        code="TRANSIENT_NETWORK",
                        retryable=True,
                    )
                client.complete(
                    job_id,
                    lease_token,
                    {
                        "ok": True,
                        "job_type": JOB_TYPE,
                        "contract_version": CONTRACT_VERSION,
                        "reader": "direct_verified_v1",
                        "provider": provider,
                        "model": model,
                        "reasoning_effort": reasoning_effort,
                        "assets_total": len(results),
                        "asset_results": results,
                    },
                )
            _json_log(
                "job_completed",
                job_id=job_id,
                assets=len(results),
                total_seconds=round(time.monotonic() - started, 2),
                max_rss_mb=_memory_mb(),
            )
            return EXIT_PROCESSED
        except WorkerError as exc:
            job_id = int(claim["job_id"]) if claim and claim.get("job_id") else None
            if job_id is not None:
                try:
                    client.fail(
                        job_id,
                        str(claim["lease_token"]),
                        exc.code,
                        str(exc),
                        exc.retryable,
                    )
                except WorkerError as fail_exc:
                    _json_log("job_fail_report_error", job_id=job_id, code=fail_exc.code)
            _json_log(
                "job_failed",
                job_id=job_id,
                code=exc.code,
                retryable=exc.retryable,
                total_seconds=round(time.monotonic() - started, 2),
                max_rss_mb=_memory_mb(),
            )
            return EXIT_RETRYABLE_FAILURE if exc.retryable else EXIT_TERMINAL_FAILURE
        except Exception as exc:
            job_id = int(claim["job_id"]) if claim and claim.get("job_id") else None
            if job_id is not None:
                try:
                    client.fail(
                        job_id,
                        str(claim["lease_token"]),
                        "INTERNAL_ERROR",
                        f"unhandled {type(exc).__name__}",
                        True,
                    )
                except WorkerError:
                    pass
            _json_log(
                "job_failed",
                job_id=job_id,
                code="INTERNAL_ERROR",
                retryable=True,
                total_seconds=round(time.monotonic() - started, 2),
                max_rss_mb=_memory_mb(),
            )
            return EXIT_RETRYABLE_FAILURE


if __name__ == "__main__":
    raise SystemExit(run())
