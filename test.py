import os
import time
from e2b import Sandbox

try:
    from e2b.exceptions import NotFoundException
except Exception:
    NotFoundException = Exception 


def safe_get_info(sbx):
    try:
        info = sbx.get_info()
        state = getattr(info, "state", "unknown")
        print("get_info ok, state =", state)
        return True
    except Exception as e:
        print("get_info failed:", type(e).__name__, str(e))
        return False


def main():
    sbx = Sandbox.create(template="test-chen")
    print("Created:", sbx.sandbox_id)

    sbx.files.write("/tmp/persist.txt", "hello-persist")
    print("write ok")

    for i in range(6):
        if safe_get_info(sbx):
            break
        time.sleep(min(2 ** i, 8))
    else:
        raise RuntimeError("Sandbox created but get_info keeps failing")

    for i in range(6):
        try:
            sbx.beta_pause()
            print("Paused:", sbx.sandbox_id)
            return
        except NotFoundException as e:
            print(f"pause 404 {i+1}/6:", e)
            if i == 5:
                raise
            time.sleep(min(2 ** i, 8))
        except Exception as e:
            print("pause failed:", type(e).__name__, str(e))
            raise


if __name__ == "__main__":
    main()
