import os

from dotenv import load_dotenv
from e2b import Sandbox

load_dotenv()


def get_fs(sbx: Sandbox):
    return getattr(sbx, "filesystem", getattr(sbx, "_filesystem"))


def main():
    template_id = os.getenv("TEMPLATE_ID", "test")

    sbx = Sandbox.create(template_id, timeout=600)
    print("Created:", sbx.sandbox_id)
    try:
        fs = get_fs(sbx)

        missing_path = "/tmp/this-path-should-not-exist-123456"
        got_missing_error = False
        try:
            fs.read(missing_path)
        except Exception as exc:
            got_missing_error = True
            print("Read missing path failed as expected:", type(exc).__name__)

        if not got_missing_error:
            raise RuntimeError("Expected read on invalid path to fail")

        got_cmd_error = False
        try:
            cmd = sbx.commands.run("bash -lc 'ls /definitely/not/exist'")
            if cmd.exit_code == 0:
                raise RuntimeError("Expected invalid command path check to fail")
            if not (cmd.stderr or "").strip():
                raise RuntimeError("Expected stderr for invalid command path")
            got_cmd_error = True
        except Exception as exc:
            # Newer SDK versions raise CommandExitException directly on non-zero exit.
            text = str(exc).lower()
            if "no such file or directory" in text or "exited with code" in text:
                got_cmd_error = True
                print("Invalid command path failed as expected:", type(exc).__name__)
            else:
                raise

        if not got_cmd_error:
            raise RuntimeError("Expected invalid command path check to fail")

        print("Negative error handling check passed")
    finally:
        sbx.kill()
        print("Killed:", sbx.sandbox_id)


if __name__ == "__main__":
    main()
