import os
import time
from dataclasses import dataclass
from typing import Callable, Tuple, Any

from e2b import Sandbox


@dataclass
class ProbeResult:
    name: str
    ok: bool
    first_ok_s: float | None
    attempts: int
    last_error: str | None


def retry_probe(name: str, fn: Callable[[], Any], timeout_s: float = 30.0, interval_s: float = 0.5) -> ProbeResult:
    start = time.time()
    attempts = 0
    last_error = None

    while time.time() - start < timeout_s:
        attempts += 1
        try:
            fn()
            return ProbeResult(name, True, time.time() - start, attempts, None)
        except Exception as e:
            last_error = f"{type(e).__name__}: {e}"
            time.sleep(interval_s)

    return ProbeResult(name, False, None, attempts, last_error)


def print_result(r: ProbeResult):
    if r.ok:
        print(f"[PASS] {r.name:<24} first_ok={r.first_ok_s:.2f}s attempts={r.attempts}")
    else:
        print(f"[FAIL] {r.name:<24} attempts={r.attempts} last_error={r.last_error}")


def run_case(template: str | None = None):
    create_kwargs = {"timeout": 1200}
    if template:
        create_kwargs["template"] = template

    # -------- Case A: get_info readiness --------
    sbx_a = Sandbox.create(**create_kwargs)
    try:
        r = retry_probe("get_info", lambda: sbx_a.get_info())
        print_result(r)
    finally:
        sbx_a.kill()

    # -------- Case B: commands.run readiness --------
    sbx_b = Sandbox.create(**create_kwargs)
    try:
        def _cmd():
            res = sbx_b.commands.run("bash -lc 'echo ready'", timeout=10)
            if res.exit_code != 0 or "ready" not in (res.stdout or ""):
                raise RuntimeError(f"bad cmd result: exit={res.exit_code}, stderr={res.stderr}")
        r = retry_probe("commands.run", _cmd)
        print_result(r)
    finally:
        sbx_b.kill()

    # -------- Case C: files.write/read readiness --------
    sbx_c = Sandbox.create(**create_kwargs)
    try:
        def _fs():
            sbx_c.files.write("/tmp/ready_probe.txt", "ok")
            got = sbx_c.files.read("/tmp/ready_probe.txt").strip()
            if got != "ok":
                raise RuntimeError(f"fs mismatch: {got}")
        r = retry_probe("files.write+read", _fs)
        print_result(r)
    finally:
        sbx_c.kill()

    # -------- Case D: beta_pause readiness --------
    sbx_d = Sandbox.create(**create_kwargs)
    try:
        r = retry_probe("beta_pause", lambda: sbx_d.beta_pause())
        print_result(r)
    finally:
        # pause 后也可 kill
        sbx_d.kill()

    # -------- Case E: pause -> connect readiness --------
    sbx_e = Sandbox.create(**create_kwargs)
    try:
        # 先让 pause 成功（带重试）
        pause_r = retry_probe("pause_before_connect", lambda: sbx_e.beta_pause())
        print_result(pause_r)

        # 再测 connect
        def _connect():
            sbx_e.connect(timeout=600)
        conn_r = retry_probe("connect_after_pause", _connect)
        print_result(conn_r)
    finally:
        sbx_e.kill()


if __name__ == "__main__":
    if not os.getenv("E2B_API_KEY"):
        raise RuntimeError("请先 export E2B_API_KEY")
    # template 可改成 "test-chen" 做对比；先不传表示默认模板
    run_case(template=None)
