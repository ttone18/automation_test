import os
import tempfile
import time

from dotenv import load_dotenv
from e2b import Sandbox

from e2b_test_utils import create_sandbox_with_retry

load_dotenv()


def _is_retryable_git_error(stderr: str) -> bool:
    """TLS/网络相关错误多为瞬时，可重试"""
    if not stderr:
        return False
    s = stderr.lower()
    return (
        "gnutls" in s
        or "tls" in s
        or "ssl" in s
        or "handshake" in s
        or "connection was non-properly terminated" in s
        or "connection timed out" in s
        or "connection refused" in s
        or "failed to connect" in s
    )


def main():
    template_id = os.getenv("TEMPLATE_ID", "test")
    repo = os.getenv("GIT_TEST_REPO", "https://github.com/octocat/Hello-World.git")
    retries = int(os.getenv("GIT_CLONE_RETRIES", "3"))
    sbx = create_sandbox_with_retry(template_id, timeout=600)
    print("Created:", sbx.sandbox_id)
    try:
        check = sbx.commands.run("bash -lc 'git --version'")
        if check.exit_code != 0:
            raise RuntimeError(f"git not available: {check.stderr}")
        print((check.stdout or "").strip())

        target = f"/tmp/git-test-{next(tempfile._get_candidate_names())}"
        cmd = (
            "bash -lc "
            f"'rm -rf \"{target}\" && git clone --depth=1 \"{repo}\" \"{target}\" "
            f"&& git -C \"{target}\" rev-parse --short HEAD'"
        )
        clone = None
        for attempt in range(1, retries + 1):
            clone = sbx.commands.run(cmd)
            if clone.exit_code == 0:
                break
            if attempt < retries and _is_retryable_git_error(clone.stderr or ""):
                delay = min(2**attempt, 8)
                print(f"git clone TLS/network error (attempt {attempt}/{retries}), retry in {delay}s")
                time.sleep(delay)
            else:
                raise RuntimeError(f"git clone/fetch failed: {clone.stderr}")

        sha = (clone.stdout or "").strip().splitlines()[-1]
        if len(sha) < 7:
            raise RuntimeError(f"Unexpected git rev output: {clone.stdout}")
        print("Git operation check passed, sha:", sha)
    finally:
        sbx.kill()
        print("Killed:", sbx.sandbox_id)


if __name__ == "__main__":
    main()
