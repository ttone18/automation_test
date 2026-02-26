import asyncio
import os
import sys

from dotenv import load_dotenv
from e2b import AsyncTemplate

load_dotenv()

DEFAULT_IMAGE = "mp-bp-cn-shanghai.cr.volces.com/e2b/ubuntu:22.04-s3"
DEFAULT_USERNAME = "crrobot@infrawaves"
DEFAULT_PASSWORD = "Fikypjfqobu2"


def _parse_aliases():
    aliases_csv = os.getenv("TEMPLATE_ALIASES", "").strip()
    if aliases_csv:
        return [a.strip() for a in aliases_csv.split(",") if a.strip()]
    alias = os.getenv("TEMPLATE_ALIAS") or os.getenv("TEMPLATE_ID") or "test"
    return [alias]


def _build_template():
    image = os.getenv("TEMPLATE_IMAGE", DEFAULT_IMAGE)
    username = os.getenv("TEMPLATE_REGISTRY_USERNAME", DEFAULT_USERNAME)
    password = os.getenv("TEMPLATE_REGISTRY_PASSWORD", DEFAULT_PASSWORD)
    return AsyncTemplate().from_image(image=image, username=username, password=password)


async def main():
    aliases = _parse_aliases()
    print(f"E2B_API_KEY from env: {os.getenv('E2B_API_KEY')}")
    print(f"Target aliases: {', '.join(aliases)}")

    for alias in aliases:
        print(f"Building template alias: {alias}")
        template = _build_template()
        await AsyncTemplate.build(
            template,
            alias=alias,
            cpu_count=1,
            memory_mb=1024,
            skip_cache=True,
            on_build_logs=lambda log: print(str(log)),
        )
        print(f"Build finished: {alias}")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(f"An error occurred: {exc}", file=sys.stderr)
        sys.exit(1)
