import asyncio
import os
import sys

from dotenv import load_dotenv
from e2b import AsyncTemplate

load_dotenv()


def _mask_secret(value: str) -> str:
    if not value:
        return "unset"
    if len(value) <= 10:
        return "***"
    return f"{value[:6]}...{value[-4:]}"


async def main():
    image = (os.getenv("TEMPLATE_LARGE_IMAGE") or "").strip()
    if not image:
        print(
            "TEMPLATE_LARGE_IMAGE is not set, skip large image build test. "
            "Set ENABLE_LARGE_IMAGE_BUILD_TEST=1 and TEMPLATE_LARGE_IMAGE to enable."
        )
        return

    alias = os.getenv("TEMPLATE_LARGE_ALIAS", "large-image-test")
    username = os.getenv("TEMPLATE_REGISTRY_USERNAME")
    password = os.getenv("TEMPLATE_REGISTRY_PASSWORD")

    print(f"E2B_API_KEY from env: {_mask_secret(os.getenv('E2B_API_KEY', ''))}")
    print("Building large image template alias:", alias)
    print("Large image:", image)

    if username and password:
        template = AsyncTemplate().from_image(image=image, username=username, password=password)
    else:
        template = AsyncTemplate().from_image(image=image)

    await AsyncTemplate.build(
        template,
        alias=alias,
        cpu_count=int(os.getenv("TEMPLATE_LARGE_CPU", "1")),
        memory_mb=int(os.getenv("TEMPLATE_LARGE_MEMORY_MB", "1024")),
        skip_cache=True,
        on_build_logs=lambda log: print(str(log)),
    )
    print("Large image build test passed:", alias)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(f"An error occurred: {exc}", file=sys.stderr)
        sys.exit(1)
