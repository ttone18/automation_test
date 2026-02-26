import asyncio
import os
import sys
import time
from e2b import Sandbox
from dotenv import load_dotenv

load_dotenv()

def get_filesystem(sbx: Sandbox):
    # Prefer public API when available, but keep compatibility with older SDK shapes.
    return getattr(sbx, "filesystem", getattr(sbx, "_filesystem"))


def is_retryable_error(exc: Exception) -> bool:
    text = str(exc).lower()
    name = type(exc).__name__.lower()
    return (
        "readtimeout" in name
        or "timeoutexception" in name
        or "timed out" in text
        or "not found" in text
        or "can't be resumed" in text
        or "sandbox was not found" in text
        or "connection" in text
    )


async def read_with_retry(sbx: Sandbox, path: str, retries: int = 10, base_delay: float = 1.0) -> str:
    """Read a file from sandbox with retry to handle resume warm-up delays and transient reconnect errors."""
    fs = get_filesystem(sbx)
    for attempt in range(1, retries + 1):
        try:
            return fs.read(path)
        except Exception as exc:
            if attempt == retries or not is_retryable_error(exc):
                raise
            delay = min(base_delay * (2 ** (attempt - 1)), 10.0)
            print(
                f"Read failed ({type(exc).__name__}) on attempt {attempt}/{retries}, retrying in {delay:.1f}s..."
            )
            await asyncio.sleep(delay)


def connect_with_timeout(
    sandbox_id: str, timeout_sec: int = 600, retries: int = 6, base_delay: float = 1.0
) -> Sandbox:
    for attempt in range(1, retries + 1):
        try:
            try:
                sbx = Sandbox.connect(sandbox_id, timeout=timeout_sec)
            except TypeError:
                # Backward compatibility if installed SDK doesn't accept timeout on connect.
                sbx = Sandbox.connect(sandbox_id)

            if hasattr(sbx, "set_timeout"):
                sbx.set_timeout(timeout_sec)
            return sbx
        except Exception as exc:
            if attempt == retries or not is_retryable_error(exc):
                raise
            delay = min(base_delay * (2 ** (attempt - 1)), 10.0)
            print(
                f"Connect failed ({type(exc).__name__}) on attempt {attempt}/{retries}, retrying in {delay:.1f}s..."
            )
            time.sleep(delay)

    raise RuntimeError("Unexpected retry loop termination")


async def main():
    sandbox_id = os.getenv("E2B_SANDBOX_ID")
    if len(sys.argv) >= 2 and not sys.argv[1].startswith("--"):
        sandbox_id = sys.argv[1]

    if not sandbox_id:
        raise ValueError("Please provide sandbox id via arg or E2B_SANDBOX_ID env")

    pause_first = "--pause-first" in sys.argv

    if pause_first:
        sbx_for_pause = connect_with_timeout(sandbox_id, timeout_sec=600)
        print("Connected for pause:", sbx_for_pause.sandbox_id)
        sbx_for_pause.beta_pause()
        print("Paused:", sbx_for_pause.sandbox_id)
        await asyncio.sleep(2)

    # Connect to running or paused sandbox (paused will be resumed automatically).
    sbx = connect_with_timeout(sandbox_id, timeout_sec=600)
    print("Resumed/Connected:", sbx.sandbox_id)
    await asyncio.sleep(2)

    fs = get_filesystem(sbx)
    test_path = "/tmp/resume_rw_test.txt"
    expected = f"hello-resume-{int(time.time())}"
    fs.write(test_path, expected)
    print("Wrote:", test_path)

    read_back = await read_with_retry(sbx, test_path)
    print("Read:", read_back.strip())

    if read_back.strip() != expected:
        raise RuntimeError(
            f"Read/write mismatch for {test_path}, expected={expected}, got={read_back.strip()}"
        )

    print("Resume + read/write check passed for:", sbx.sandbox_id)

if __name__ == "__main__":
    asyncio.run(main())
