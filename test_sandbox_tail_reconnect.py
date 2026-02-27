import os
import time

from dotenv import load_dotenv
from e2b import Sandbox

load_dotenv()


def wait_until(check, retries=6, base_delay=1.0, name="condition"):
    for attempt in range(1, retries + 1):
        try:
            if check():
                return
        except Exception:
            if attempt == retries:
                raise
        if attempt == retries:
            break
        time.sleep(min(base_delay * (2 ** (attempt - 1)), 8.0))
    raise RuntimeError(f"{name} not met after {retries} attempts")


def main():
    template_id = os.getenv("TEMPLATE_ID", "test")

    try:
        sbx = Sandbox.create(template_id, timeout=600, allow_internet_access=True)
    except TypeError:
        sbx = Sandbox.create(template_id, timeout=600)

    print("Created:", sbx.sandbox_id)
    pid = None
    try:
        # Start a long-running output stream to mimic `tail -f`.
        handle = sbx.commands.run(
            "bash -lc 'while true; do echo tail-heartbeat; sleep 1; done'",
            background=True,
        )
        pid = handle.pid
        print("Started streaming process, pid:", pid)

        wait_until(
            lambda: pid in [p.pid for p in sbx.commands.list()],
            retries=6,
            base_delay=1.0,
            name=f"streaming process {pid} visible",
        )

        # Simulate losing command stream connection and reconnect later.
        handle.disconnect()
        print("Disconnected original stream handle")

        same = None
        last_err = None
        for attempt in range(1, 7):
            try:
                same = Sandbox.connect(sbx.sandbox_id, timeout=600)
                break
            except Exception as exc:
                last_err = exc
                if attempt == 6:
                    raise
                time.sleep(min(2 ** (attempt - 1), 8))
        if same is None:
            raise RuntimeError(f"Sandbox reconnect failed: {last_err}")

        probe = same.commands.run("bash -lc 'echo reconnect-ok'")
        if probe.exit_code != 0 or "reconnect-ok" not in (probe.stdout or ""):
            raise RuntimeError(
                f"Reconnect probe failed: exit={probe.exit_code}, stderr={probe.stderr}"
            )
        print("Sandbox reconnect check passed")

        reconnect_handle = None
        last_connect_err = None
        for attempt in range(1, 7):
            try:
                reconnect_handle = same.commands.connect(pid, timeout=10)
                break
            except Exception as exc:
                last_connect_err = exc
                if attempt == 6:
                    raise
                time.sleep(min(2 ** (attempt - 1), 8))
        if reconnect_handle is None:
            raise RuntimeError(f"Command stream reconnect failed: {last_connect_err}")

        reconnect_handle.disconnect()
        print("Command stream reconnect check passed")

        same.commands.kill(pid)
        print("Killed streaming process:", pid)
    finally:
        sbx.kill()
        print("Killed sandbox:", sbx.sandbox_id)


if __name__ == "__main__":
    main()

