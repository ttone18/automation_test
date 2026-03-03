import os
import time

from dotenv import load_dotenv
from e2b import Sandbox

load_dotenv()


def main():
    template_id = os.getenv("TEMPLATE_ID", "test")
    max_seconds = float(os.getenv("NETWORK_MAX_SECONDS", "12"))
    web_host = os.getenv("NETWORK_WEB_HOST", "www.baidu.com")

    try:
        sbx = Sandbox.create(template_id, timeout=600, allow_internet_access=True)
    except TypeError:
        sbx = Sandbox.create(template_id, timeout=600)

    print("Created:", sbx.sandbox_id)
    try:
        dns = sbx.commands.run(
            f"bash -lc 'getent hosts {web_host} || nslookup {web_host}'"
        )
        if dns.exit_code != 0:
            raise RuntimeError(f"DNS check failed: {dns.stderr}")
        dns_out = (dns.stdout or "").strip()
        print("DNS check ok:")
        print(dns_out)

        ip_res = sbx.commands.run(
            f"bash -lc 'getent hosts {web_host} | awk \"NR==1{{print $1}}\"'"
        )
        if ip_res.exit_code != 0 or not (ip_res.stdout or "").strip():
            raise RuntimeError(f"Failed to parse web ip for {web_host}: {ip_res.stderr}")
        web_ip = (ip_res.stdout or "").strip()
        print(f"Resolved {web_host} -> {web_ip}")

        started = time.time()
        res = sbx.commands.run(
            f"bash -lc 'curl -sS -I -L -o /dev/null -w \"%{{http_code}} %{{time_total}}\" https://{web_host}'"
        )
        elapsed = time.time() - started

        if res.exit_code != 0:
            raise RuntimeError(f"curl failed: {res.stderr}")

        raw = (res.stdout or "").strip()
        print("curl result:", raw)
        parts = raw.split()
        if len(parts) != 2:
            raise RuntimeError(f"Unexpected curl output: {raw}")

        code = int(parts[0])
        total = float(parts[1])
        if code < 200 or code >= 400:
            raise RuntimeError(f"Unexpected HTTP status: {code}")
        if total > max_seconds and elapsed > max_seconds:
            raise RuntimeError(
                f"Network too slow: curl={total:.2f}s elapsed={elapsed:.2f}s threshold={max_seconds:.2f}s"
            )

        ip_head = sbx.commands.run(
            f"bash -lc 'curl -sS -I -m 15 http://{web_ip} | head -n 1'"
        )
        if ip_head.exit_code != 0:
            raise RuntimeError(f"curl to web_ip failed: {ip_head.stderr}")
        ip_head_line = (ip_head.stdout or "").strip()
        if not ip_head_line.startswith("HTTP/"):
            raise RuntimeError(f"Unexpected web_ip curl response: {ip_head_line}")
        print(f"curl web_ip ok: {ip_head_line}")

        print("Network access check passed")
    finally:
        sbx.kill()
        print("Killed:", sbx.sandbox_id)


if __name__ == "__main__":
    main()
