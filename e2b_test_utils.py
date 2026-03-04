"""E2B 测试公共工具：沙箱创建重试等"""
import os
import time
from typing import Optional

from e2b import Sandbox


def _is_capacity_error(exc: Exception) -> bool:
    """500 Failed to place sandbox 多为集群容量不足，可重试"""
    s = str(exc).lower()
    return "500" in s or "failed to place sandbox" in s or "no nodes available" in s


def create_sandbox_with_retry(
    template_id: str,
    timeout: int = 600,
    allow_internet_access: bool = True,
    retries: Optional[int] = None,
) -> Sandbox:
    """创建 sandbox，遇 500/容量不足时自动重试"""
    if retries is None:
        retries = int(os.getenv("SANDBOX_CREATE_RETRIES", "3"))
    for attempt in range(1, retries + 1):
        try:
            try:
                return Sandbox.create(template_id, timeout=timeout, allow_internet_access=allow_internet_access)
            except TypeError:
                return Sandbox.create(template_id, timeout=timeout)
        except Exception as exc:
            if attempt < retries and _is_capacity_error(exc):
                delay = min(2**attempt, 15)
                print(f"Sandbox create failed (attempt {attempt}/{retries}), retry in {delay}s", file=__import__("sys").stderr)
                time.sleep(delay)
            else:
                raise
    raise RuntimeError("create_sandbox_with_retry: unexpected")
