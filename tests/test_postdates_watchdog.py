import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WATCHDOG = ROOT / "scripts" / "postdates_watchdog.sh"


def _environment(tmp_path: Path) -> tuple[dict[str, str], Path]:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_flock = fake_bin / "flock"
    fake_flock.write_text(
        "#!/bin/sh\n"
        "[ \"${ECA_WATCHDOG_TEST_LOCKED:-0}\" = 1 ] && exit 1\n"
        "exit 0\n"
    )
    fake_flock.chmod(0o755)

    marker = tmp_path / "worker-ran"
    worker = tmp_path / "pt-worker"
    worker.write_text(
        "#!/bin/sh\n"
        "printf 'ran\\n' >> \"$ECA_POSTDATES_TEST_MARKER\"\n"
        "[ -z \"${ECA_PT_TEST_OUTPUT:-}\" ] || printf '%s\\n' \"$ECA_PT_TEST_OUTPUT\"\n"
        "exit \"${ECA_PT_TEST_RC:-0}\"\n"
    )
    worker.chmod(0o755)

    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{fake_bin}:{env['PATH']}",
            "ECA_PT_WORKER_PATH": str(worker),
            "ECA_WATCHDOG_RUN_LOCK": str(tmp_path / "watchdog.lock"),
            "ECA_POSTDATES_TEST_MARKER": str(marker),
        }
    )
    return env, marker


class PostdatesWatchdogTests(unittest.TestCase):
    def test_processed_job_is_logged_and_cron_tick_succeeds(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env, marker = _environment(Path(tmp))
            env.update(ECA_PT_TEST_RC="10", ECA_PT_TEST_OUTPUT='{"event":"job_completed"}')
            result = subprocess.run(
                ["bash", str(WATCHDOG)], env=env, capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0)
            self.assertIn("job_completed", result.stdout)
            self.assertEqual(marker.read_text(), "ran\n")

    def test_empty_queue_is_quiet(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env, marker = _environment(Path(tmp))
            result = subprocess.run(
                ["bash", str(WATCHDOG)], env=env, capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertEqual(marker.read_text(), "ran\n")

    def test_shared_lock_prevents_overlap(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env, marker = _environment(Path(tmp))
            env["ECA_WATCHDOG_TEST_LOCKED"] = "1"
            result = subprocess.run(
                ["bash", str(WATCHDOG)], env=env, capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 0)
            self.assertFalse(marker.exists())

    def test_unexpected_worker_failure_is_visible(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            env, _ = _environment(Path(tmp))
            env.update(ECA_PT_TEST_RC="1", ECA_PT_TEST_OUTPUT="unexpected failure")
            result = subprocess.run(
                ["bash", str(WATCHDOG)], env=env, capture_output=True, text=True
            )
            self.assertEqual(result.returncode, 1)
            self.assertIn("unexpected failure", result.stderr)


if __name__ == "__main__":
    unittest.main()
