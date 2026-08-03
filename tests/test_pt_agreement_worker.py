import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "pt_agreement_worker.py"
SPEC = importlib.util.spec_from_file_location("pt_agreement_worker", MODULE_PATH)
worker = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(worker)


def _slots(amounts=(100, 100, 100, 100, 100)):
    return [
        {
            "ordinal": ordinal,
            "state": "filled",
            "amount_value": amount,
            "date_iso": f"2026-{ordinal + 1:02d}-01",
        }
        for ordinal, amount in enumerate(amounts, 1)
    ]


def _primary(**overrides):
    result = {
        "is_pt_agreement": True,
        "legible": True,
        "form_type": "New PT",
        "agreement_date": "2026-01-15",
        "start_date": "2026-02-01",
        "expiration_date": "2026-07-01",
        "member_last_name": "Member",
        "member_first_name": "Test",
        "member_number": "0001234567",
        "trainer": "Trainer",
        "sold_by": "Seller",
        "number_of_sessions": 10,
        "amount_per_session": 55,
        "sub_total": 550,
        "tax": 49.5,
        "total": 599.5,
        "total_paid_today": 99.5,
        "remaining_balance": 500,
        "duration_of_sessions": 60,
        "number_of_months": 5,
        "sessions_per_week": 2,
        "signature_present": False,
        "pd_slots": _slots(),
        "uncertain_fields": [],
        "confidence": 0.96,
        "warnings": [],
    }
    result.update(overrides)
    return result


def _verifier(primary):
    slots = primary.get("pd_slots") or []
    return {
        "member_number": primary.get("member_number"),
        "agreement_date": primary.get("agreement_date"),
        "form_type": primary.get("form_type"),
        "is_pt_agreement": primary.get("is_pt_agreement"),
        "pd_slots": slots,
        "overflow_rows_seen": any(slot.get("ordinal", 0) > 5 for slot in slots),
        "corrections_seen": False,
        "uncertain_fields": [],
        "warnings": [],
    }


class AgreementWorkerTests(unittest.TestCase):
    def test_worker_pins_the_hermes_python_runtime(self):
        first_line = MODULE_PATH.read_text(encoding="utf-8").splitlines()[0]
        self.assertEqual(first_line, "#!/opt/hermes/.venv/bin/python")

    def test_reader_defaults_to_gpt_5_6_sol_high(self):
        self.assertEqual(worker.DEFAULT_PROVIDER, "openai-codex")
        self.assertEqual(worker.DEFAULT_MODEL, "gpt-5.6-sol")
        self.assertEqual(worker.DEFAULT_REASONING_EFFORT, "high")

    def test_model_call_sends_configured_reasoning_effort(self):
        captured = {}

        def fake_call_llm(**kwargs):
            captured.update(kwargs)
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(content='{"ok": true}')
                    )
                ]
            )

        agent_module = ModuleType("agent")
        auxiliary_module = ModuleType("agent.auxiliary_client")
        auxiliary_module.call_llm = fake_call_llm
        agent_module.auxiliary_client = auxiliary_module

        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "view.jpg"
            image_path.write_bytes(b"fake-jpeg")
            with patch.dict(
                sys.modules,
                {
                    "agent": agent_module,
                    "agent.auxiliary_client": auxiliary_module,
                },
            ):
                result, _ = worker._invoke_model(
                    "Return JSON.",
                    [("test view", image_path)],
                    provider="openai-codex",
                    model="gpt-5.6-sol",
                    reasoning_effort="high",
                    timeout=90,
                )

        self.assertEqual(result, {"ok": True})
        self.assertEqual(captured["provider"], "openai-codex")
        self.assertEqual(captured["model"], "gpt-5.6-sol")
        self.assertEqual(
            captured["extra_body"], {"reasoning": {"effort": "high"}}
        )

    def test_parse_submission_reports_actual_reader_provenance(self):
        client = worker.BackendClient("https://backend.example", "token")
        captured = {}

        def fake_request(method, path, **kwargs):
            captured.update(method=method, path=path, **kwargs)
            return {"result": "parsed"}

        client.request = fake_request
        result = client.submit_parse(
            7,
            11,
            "lease-token",
            {"status": "ok"},
            provider="openai-codex",
            model="gpt-5.6-sol",
            reasoning_effort="high",
        )

        self.assertEqual(result, {"result": "parsed"})
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(
            captured["body"],
            {
                "lease_token": "lease-token",
                "extraction": {"status": "ok"},
                "provider": "openai-codex",
                "model": "gpt-5.6-sol",
                "reasoning_effort": "high",
            },
        )

    def test_matching_reads_produce_payment_plan(self):
        primary = _primary()
        result = worker._finalize_extraction(primary, _verifier(primary), "1234567")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["plan_type"], "payment_plan")
        self.assertTrue(result["check_pd_sum_equals_remaining"])
        self.assertTrue(result["check_paid_plus_remaining_eq_total"])

    def test_verifier_schedule_disagreement_is_review_only(self):
        primary = _primary()
        verifier = _verifier(primary)
        verifier["pd_slots"] = _slots((100, 100, 100, 100, 90))
        result = worker._finalize_extraction(primary, verifier, "1234567")
        self.assertEqual(result["status"], "partial")
        self.assertTrue(any("funded postdate schedule" in w for w in result["warnings"]))

    def test_missing_verifier_schedule_is_review_only(self):
        primary = _primary()
        verifier = _verifier(primary)
        verifier.pop("pd_slots")
        result = worker._finalize_extraction(primary, verifier, "1234567")
        self.assertEqual(result["status"], "partial")
        self.assertTrue(any("omitted the postdate schedule" in w for w in result["warnings"]))

    def test_incomplete_verifier_printed_rows_are_review_only(self):
        primary = _primary()
        verifier = _verifier(primary)
        verifier["pd_slots"] = verifier["pd_slots"][:4]
        result = worker._finalize_extraction(primary, verifier, "1234567")
        self.assertEqual(result["status"], "partial")
        self.assertTrue(any("rows 1-5" in w for w in result["warnings"]))

    def test_verifier_overflow_flag_requires_transcribed_overflow_rows(self):
        primary = _primary()
        verifier = _verifier(primary)
        verifier["overflow_rows_seen"] = True
        result = worker._finalize_extraction(primary, verifier, "1234567")
        self.assertEqual(result["status"], "partial")
        self.assertTrue(any("saw overflow rows" in w for w in result["warnings"]))

    def test_blank_overflow_row_does_not_satisfy_overflow_verification(self):
        primary = _primary()
        verifier = _verifier(primary)
        verifier["pd_slots"] = verifier["pd_slots"] + [
            {"ordinal": 6, "state": "blank", "amount_value": None, "date_iso": None}
        ]
        verifier["overflow_rows_seen"] = True
        result = worker._finalize_extraction(primary, verifier, "1234567")
        self.assertEqual(result["status"], "partial")
        self.assertTrue(any("saw overflow rows" in w for w in result["warnings"]))

    def test_verifier_postdate_warning_is_review_only(self):
        primary = _primary()
        verifier = _verifier(primary)
        verifier["warnings"] = ["Postdate row 5 amount may be faint"]
        result = worker._finalize_extraction(primary, verifier, "1234567")
        self.assertEqual(result["status"], "partial")

    def test_postdate_uncertainty_worded_as_pd_row_is_review_only(self):
        primary = _primary(uncertain_fields=["PD row 6 amount is faint"])
        result = worker._finalize_extraction(primary, _verifier(primary), "1234567")
        self.assertEqual(result["status"], "partial")

    def test_source_member_mismatch_preserves_visual_read(self):
        primary = _primary()
        result = worker._finalize_extraction(primary, _verifier(primary), "7654321")
        self.assertEqual(result["member_number"], "0001234567")
        self.assertEqual(result["status"], "partial")

    def test_blank_remaining_balance_does_not_erase_schedule(self):
        primary = _primary(remaining_balance=None)
        result = worker._finalize_extraction(primary, _verifier(primary), "1234567")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(result["pd_slots"]), 5)
        self.assertIsNone(result["check_pd_sum_equals_remaining"])

    def test_signing_payment_alone_never_means_paid_in_full(self):
        blank_slots = [
            {"ordinal": ordinal, "state": "blank", "amount_value": None, "date_iso": None}
            for ordinal in range(1, 6)
        ]
        primary = _primary(
            total_paid_today=99.5,
            remaining_balance=500,
            pd_slots=blank_slots,
        )
        result = worker._finalize_extraction(primary, _verifier(primary), "1234567")
        self.assertEqual(result["plan_type"], "unclear")

    def test_page_totals_can_classify_paid_in_full_without_schedule(self):
        blank_slots = [
            {"ordinal": ordinal, "state": "blank", "amount_value": None, "date_iso": None}
            for ordinal in range(1, 6)
        ]
        primary = _primary(
            total_paid_today=599.5,
            remaining_balance=0,
            pd_slots=blank_slots,
        )
        result = worker._finalize_extraction(primary, _verifier(primary), "1234567")
        self.assertEqual(result["plan_type"], "paid_in_full")

    def test_omitted_printed_row_forces_review(self):
        primary = _primary(pd_slots=_slots()[:4])
        result = worker._finalize_extraction(primary, _verifier(primary), "1234567")
        self.assertEqual(result["status"], "partial")
        self.assertEqual(len(result["pd_slots"]), 5)

    def test_prompts_encode_handwritten_correction_and_overflow_rules(self):
        self.assertIn("controlling corrected value", worker.PRIMARY_SYSTEM_PROMPT)
        self.assertIn("Continue ordinals 6, 7", worker.PRIMARY_SYSTEM_PROMPT)
        self.assertIn("Signature presence is informational only", worker.PRIMARY_SYSTEM_PROMPT)

    def test_invalid_confidence_is_bounded(self):
        primary = _primary(confidence="not-a-number")
        result = worker._finalize_extraction(primary, _verifier(primary), "1234567")
        self.assertEqual(result["confidence"], 0.0)


if __name__ == "__main__":
    unittest.main()
