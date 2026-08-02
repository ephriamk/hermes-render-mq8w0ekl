import json
import os
import re
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WATCHDOG = ROOT / "scripts" / "payroll_watchdog.sh"


def _watchdog_env(tmp_path: Path) -> tuple[dict[str, str], Path, Path]:
    env_file = tmp_path / "watchdog.env"
    env_file.write_text(
        "ECA_API_BASE_URL=https://backend.invalid\n"
        "API_SERVER_KEY=test-key\n"
        "API_SERVER_PORT=8788\n"
        "ECA_MAX_PAYROLL_WORKERS=1\n"
        "ECA_HERMES_SERVICE_TOKEN=test-token\n"
    )
    marker = tmp_path / "agent-launched"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_curl = fake_bin / "curl"
    fake_curl.write_text(
        "#!/bin/sh\n"
        "case \"$*\" in\n"
        "  */api/v4/agent/status*) printf '{\"queue\":{\"queued\":5}}' ;;\n"
        "  *) printf 'launched\\n' >> \"$ECA_WATCHDOG_TEST_MARKER\" ;;\n"
        "esac\n"
    )
    fake_curl.chmod(0o755)

    pid_dir = tmp_path / "pids"
    wake_dir = tmp_path / "wakes"
    wake_dir.mkdir()
    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{fake_bin}:{env['PATH']}",
            "ECA_WATCHDOG_ENV_FILE": str(env_file),
            "ECA_WATCHDOG_PID_DIR": str(pid_dir),
            "ECA_WATCHDOG_WAKE_DIR": str(wake_dir),
            "ECA_WATCHDOG_LOCK_FILE": str(tmp_path / "watchdog.lock"),
            "ECA_WATCHDOG_TEST_MARKER": str(marker),
        }
    )
    return env, marker, pid_dir


class PayrollWatchdogTests(unittest.TestCase):
    def test_skill_preserves_backend_enforced_single_worker_label(self) -> None:
        skill = (ROOT / "skills" / "eca-payroll-parse-plan" / "SKILL.md").read_text()

        self.assertIn("Copy the exact label from the wake prompt", skill)
        self.assertIn("backend permits to\nclaim exactly one job", skill)
        self.assertNotIn("exact `cloud-wN` label", skill)

    def test_fallback_pt_contract_contains_correction_and_identity_semantics(self) -> None:
        contract = (
            ROOT
            / "skills"
            / "eca-payroll-parse-plan"
            / "references"
            / "parse_pt_agreement_v1.md"
        ).read_text()

        self.assertIn("pt-agreement-v8-identity-crosscheck", contract)
        self.assertIn("Corrections are edits, not extra slots", contract)
        self.assertIn("It is not ordinals 6 and 7", contract)
        self.assertIn("/pt-asset/{asset_id}/context", contract)
        self.assertIn("Never transpose, reorder, or blindly copy context", contract)

    def test_active_gateway_request_blocks_another_worker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, marker, pid_dir = _watchdog_env(tmp_path)
            pid_dir.mkdir()
            active = subprocess.Popen(
                [
                    "python3",
                    "-c",
                    "import time; time.sleep(20)",
                    "http://127.0.0.1:8788/v1/chat/completions",
                ]
            )
            try:
                (pid_dir / "active.pid").write_text(str(active.pid))
                result = subprocess.run(
                    ["bash", str(WATCHDOG)],
                    env=env,
                    capture_output=True,
                    text=True,
                    check=True,
                )
                self.assertEqual(result.stdout, "")
                self.assertFalse(marker.exists())
            finally:
                active.terminate()
                active.wait(timeout=5)

    def test_stale_pid_is_removed_and_one_worker_starts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, marker, pid_dir = _watchdog_env(tmp_path)
            pid_dir.mkdir()
            stale = pid_dir / "stale.pid"
            stale.write_text("99999999")

            result = subprocess.run(
                ["bash", str(WATCHDOG)],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            for _ in range(20):
                if marker.exists():
                    break
                time.sleep(0.05)

            self.assertIn("woke 1 agent(s)", result.stdout)
            self.assertTrue(marker.exists())
            self.assertFalse(stale.exists())
            self.assertEqual(len(list(pid_dir.glob("eca-payroll-*.pid"))), 1)

            wake_files = list((tmp_path / "wakes").glob("payroll_wake_*.json"))
            self.assertEqual(len(wake_files), 1)
            prompt = json.loads(wake_files[0].read_text())["messages"][0]["content"]
            self.assertIn("Process exactly ONE ECA worker job", prompt)
            self.assertIn("Never claim a second job", prompt)
            self.assertIn("backend-enforced", prompt)
            self.assertRegex(
                prompt,
                re.compile(r'"worker_label": "single-\d{14}-w1"'),
            )


if __name__ == "__main__":
    unittest.main()
