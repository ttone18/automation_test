import os
import tempfile

from dotenv import load_dotenv
from e2b import Sandbox

load_dotenv()


def main():
    template_id = os.getenv("TEMPLATE_ID", "test")
    repo = os.getenv("GIT_TEST_REPO", "https://github.com/octocat/Hello-World.git")

    try:
        sbx = Sandbox.create(template_id, timeout=600, allow_internet_access=True)
    except TypeError:
        sbx = Sandbox.create(template_id, timeout=600)

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
        clone = sbx.commands.run(cmd)
        if clone.exit_code != 0:
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
