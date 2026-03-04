import argparse
import os

from dotenv import load_dotenv

from e2b_test_utils import create_sandbox_with_retry

load_dotenv()


def main():
    parser = argparse.ArgumentParser(description="Create sandbox for functional testing")
    parser.add_argument("--id-only", action="store_true", help="Print only sandbox id")
    args = parser.parse_args()

    template_id = os.getenv("TEMPLATE_ID", "test")
    sbx = create_sandbox_with_retry(template_id, timeout=3600)

    if args.id_only:
        print(sbx.sandbox_id)
        return

    print(f"Created sandbox: {sbx.sandbox_id}")
    print(f"Template: {template_id}")
    print(f"Sandbox Domain: {sbx.sandbox_domain}")

    res = sbx.commands.run("ls -l /home/user")
    print(res.stdout)


if __name__ == "__main__":
    main()
