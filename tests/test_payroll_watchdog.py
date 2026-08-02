import json
import os
import subprocess
import tempfile
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
        "ECA_HERMES_SERVICE_TOKEN=test-token\n"
    )
    marker = tmp_path / "agent-launched"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_curl = fake_bin / "curl"
    fake_curl.write_text(
        "#!/bin/sh\n"
        "case \"$*\" in\n"
        "  */api/v4/agent/status*) printf '%s' \"$ECA_WATCHDOG_TEST_STATUS\" ;;\n"
        "  *) printf 'launched\\n' >> \"$ECA_WATCHDOG_TEST_MARKER\" ;;\n"
        "esac\n"
    )
    fake_curl.chmod(0o755)
    fake_flock = fake_bin / "flock"
    fake_flock.write_text(
        "#!/bin/sh\n"
        "[ \"${ECA_WATCHDOG_TEST_LOCKED:-0}\" = 1 ] && exit 1\n"
        "exit 0\n"
    )
    fake_flock.chmod(0o755)

    pt_worker = tmp_path / "pt-worker"
    pt_worker.write_text(
        "#!/bin/sh\n"
        "[ -z \"${ECA_PT_TEST_OUTPUT:-}\" ] || printf '%s\\n' \"$ECA_PT_TEST_OUTPUT\"\n"
        "exit \"${ECA_PT_TEST_RC:-0}\"\n"
    )
    pt_worker.chmod(0o755)
    wake_dir = tmp_path / "wakes"
    wake_dir.mkdir()
    run_lock = tmp_path / "watchdog.running"
    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{fake_bin}:{env['PATH']}",
            "ECA_WATCHDOG_ENV_FILE": str(env_file),
            "ECA_WATCHDOG_WAKE_DIR": str(wake_dir),
            "ECA_WATCHDOG_RUN_LOCK": str(run_lock),
            "ECA_PT_WORKER_PATH": str(pt_worker),
            "ECA_WATCHDOG_TEST_MARKER": str(marker),
            "ECA_WATCHDOG_TEST_STATUS": (
                '{"queue":{"agent_queued":0,"agent_claimed":0}}'
            ),
        }
    )
    return env, marker, run_lock


class PayrollWatchdogTests(unittest.TestCase):
    def test_agent_skill_excludes_pt_agreement_jobs(self) -> None:
        skill = (ROOT / "skills" / "eca-payroll-parse-plan" / "SKILL.md").read_text()
        claim_block = skill.split("### Step 1.1 — Claim a job", 1)[1].split(
            "Response shapes:", 1
        )[0]
        self.assertNotIn('"parse_pt_agreement_v1"', claim_block)
        self.assertIn("direct PT reader exclusively owns", skill)

    def test_direct_reader_result_is_logged_with_no_general_queue(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env, marker, _ = _watchdog_env(Path(tmp))
            env.update(ECA_PT_TEST_RC="10", ECA_PT_TEST_OUTPUT='{"event":"job_completed"}')
            result = subprocess.run(
                ["bash", str(WATCHDOG)], env=env, capture_output=True, text=True, check=True
            )
            self.assertIn("job_completed", result.stdout)
            self.assertFalse(marker.exists())

    def test_pt_and_general_work_run_sequentially_in_one_tick(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env, marker, _ = _watchdog_env(Path(tmp))
            env.update(
                ECA_PT_TEST_RC="10",
                ECA_PT_TEST_OUTPUT='{"event":"job_completed"}',
                ECA_WATCHDOG_TEST_STATUS=(
                    '{"queue":{"agent_queued":1,"agent_claimed":0}}'
                ),
            )
            result = subprocess.run(
                ["bash", str(WATCHDOG)], env=env, capture_output=True, text=True, check=True
            )
            self.assertIn("job_completed", result.stdout)
            self.assertIn("1 general job(s) queued", result.stdout)
            self.assertEqual(marker.read_text(), "launched\n")

    def test_empty_pt_queue_runs_one_general_job(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            env, marker, _ = _watchdog_env(tmp_path)
            env["ECA_WATCHDOG_TEST_STATUS"] = (
                '{"queue":{"queued":8,"claimed":2,"agent_queued":3,"agent_claimed":0}}'
            )
            result = subprocess.run(
                ["bash", str(WATCHDOG)], env=env, capture_output=True, text=True, check=True
            )
            self.assertIn("3 general job(s) queued", result.stdout)
            self.assertEqual(marker.read_text(), "launched\n")
            wake_files = list((tmp_path / "wakes").glob("payroll_wake_*.json"))
            self.assertEqual(len(wake_files), 1)
            prompt = json.loads(wake_files[0].read_text())["messages"][0]["content"]
            self.assertIn("Never request or process parse_pt_agreement_v1", prompt)
            self.assertIn("Never claim a second job", prompt)

    def test_existing_general_claim_blocks_launch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env, marker, _ = _watchdog_env(Path(tmp))
            env["ECA_WATCHDOG_TEST_STATUS"] = (
                '{"queue":{"agent_queued":3,"agent_claimed":1}}'
            )
            subprocess.run(
                ["bash", str(WATCHDOG)], env=env, capture_output=True, text=True, check=True
            )
            self.assertFalse(marker.exists())

    def test_atomic_run_lock_blocks_overlap(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env, marker, run_lock = _watchdog_env(Path(tmp))
            env["ECA_WATCHDOG_TEST_LOCKED"] = "1"
            result = subprocess.run(
                ["bash", str(WATCHDOG)],
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
            self.assertEqual(result.stdout, "")
            self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
