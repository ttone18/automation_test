import os
import time

from dotenv import load_dotenv
from e2b import Sandbox

load_dotenv()


def get_fs(sbx: Sandbox):
    return getattr(sbx, "filesystem", getattr(sbx, "_filesystem"))


def main():
    template_id = os.getenv("TEMPLATE_ID", "test")
    p = "/tmp/isolation-check.txt"
    v1 = f"sbx1-{int(time.time())}"
    v2 = f"sbx2-{int(time.time())}"

    sbx1 = Sandbox.create(template_id, timeout=600)
    sbx2 = Sandbox.create(template_id, timeout=600)
    print("Created:", sbx1.sandbox_id, sbx2.sandbox_id)

    try:
        fs1 = get_fs(sbx1)
        fs2 = get_fs(sbx2)
        fs1.write(p, v1)
        fs2.write(p, v2)

        r1 = fs1.read(p).strip()
        r2 = fs2.read(p).strip()
        if r1 != v1:
            raise RuntimeError(f"Sandbox 1 isolation failed: expected={v1}, got={r1}")
        if r2 != v2:
            raise RuntimeError(f"Sandbox 2 isolation failed: expected={v2}, got={r2}")
        if r1 == r2:
            raise RuntimeError("Isolation failed: both sandboxes returned same content")

        print("Sandbox isolation check passed")
    finally:
        sbx1.kill()
        sbx2.kill()
        print("Killed:", sbx1.sandbox_id, sbx2.sandbox_id)


if __name__ == "__main__":
    main()
