#!/usr/bin/env python3
"""
长稳 + 波测场景：长稳 3 个 sandbox 持续压测 7*24h，波测 30 个 sandbox 并发 10 分钟。
支持飞书机器人报警（日志出现错误时推送）。
"""
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

try:
    import requests
except ImportError:
    requests = None

# 默认配置
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_CONFIG = {
    "LONG_STABILITY_COUNT": 3,
    "LONG_STABILITY_DURATION": "168h",  # 7*24
    "BURST_CONCURRENT": 30,
    "BURST_DURATION": "10m",
    "FEISHU_WEBHOOK_URL": "",
    "E2B_API_URL": os.getenv("E2B_API_URL", ""),
    "E2B_API_KEY": os.getenv("E2B_API_KEY", ""),
    "TEMPLATE_ID": os.getenv("TEMPLATE_ID", "test"),
}


def _load_yaml_config(path: Path) -> dict:
    """简单解析 YAML 顶层 key: value"""
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = re.sub(r"\s+#.*$", "", line).rstrip()
            if not line or line.startswith("#"):
                continue
            m = re.match(r"^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$", line)
            if m:
                k, v = m.group(1), m.group(2).strip().strip("'\"")
                if v.lower() in ("true", "yes"):
                    v = "1"
                elif v.lower() in ("false", "no"):
                    v = "0"
                out[k] = v
    return out


def load_config(config_path: str = "") -> dict:
    """从环境变量和可选 YAML 加载配置"""
    cfg = DEFAULT_CONFIG.copy()
    if config_path:
        p = Path(config_path)
        if not p.is_absolute():
            p = SCRIPT_DIR / config_path
        if p.exists():
            for k, v in _load_yaml_config(p).items():
                if v and k in cfg:
                    cfg[k] = v
    for k, v in os.environ.items():
        if k in cfg and v:
            if k in ("LONG_STABILITY_COUNT", "BURST_CONCURRENT"):
                try:
                    cfg[k] = int(v)
                except ValueError:
                    pass
            else:
                cfg[k] = v
    return cfg


def send_feishu_alert(webhook_url: str, title: str, content: str, error_snippet: str = "") -> bool:
    """发送飞书告警"""
    if not webhook_url or not webhook_url.strip():
        return False
    if not requests:
        print("[告警] 未安装 requests，跳过飞书推送。pip install requests", file=sys.stderr)
        return False
    try:
        text = f"【E2B 压测告警】\n{title}\n\n{content}"
        if error_snippet:
            text += f"\n\n错误片段:\n```\n{error_snippet[:500]}\n```"
        payload = {"msg_type": "text", "content": {"text": text}}
        r = requests.post(webhook_url, json=payload, timeout=10)
        if r.status_code != 200:
            print(f"[告警] 飞书推送失败: {r.status_code} {r.text[:200]}", file=sys.stderr)
            return False
        return True
    except Exception as e:
        print(f"[告警] 飞书推送异常: {e}", file=sys.stderr)
        return False


# 错误模式（用于触发告警）
ERROR_PATTERNS = [
    re.compile(r"error|exception|failed|traceback|timeout|超时", re.I),
    re.compile(r"exit(?:ed)?\s+(?:with\s+)?code\s+[1-9]\d*", re.I),
    re.compile(r"curl:\s*\(\d+\)", re.I),
    re.compile(r"gnutls|ssl|tls.*fail", re.I),
    re.compile(r"thresholds?.*crossed|has been crossed", re.I),
]


def is_error_line(line: str) -> bool:
    """判断日志行是否包含需告警的错误"""
    if not line or len(line.strip()) < 5:
        return False
    for pat in ERROR_PATTERNS:
        if pat.search(line):
            return True
    return False


class LogMonitor:
    """后台监控日志文件，发现错误时发送飞书告警"""

    def __init__(self, log_paths: list, webhook_url: str, cooldown_sec: int = 60):
        self.log_paths = [Path(p) for p in log_paths]
        self.webhook_url = webhook_url
        self.cooldown_sec = cooldown_sec
        self._last_alert_time = 0
        self._stop = threading.Event()
        self._thread = None
        self._seen_lines = set()
        self._file_positions: dict = {}

    def _do_alert(self, log_name: str, line: str, context: list):
        now = time.time()
        if now - self._last_alert_time < self.cooldown_sec:
            return
        self._last_alert_time = now
        ctx = "\n".join(context[-5:]) if context else line
        send_feishu_alert(
            self.webhook_url,
            f"日志异常: {log_name}",
            f"检测到错误或异常，请检查压测日志。",
            ctx,
        )

    def _check_file(self, path: Path) -> None:
        if not path.exists():
            return
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                pos = self._file_positions.get(str(path), 0)
                f.seek(pos)
                for line in f:
                    line = line.rstrip()
                    if not line:
                        continue
                    key = (str(path), line[:100])
                    if key in self._seen_lines:
                        continue
                    self._seen_lines.add(key)
                    if is_error_line(line) and self.webhook_url:
                        self._do_alert(path.name, line, [line])
                self._file_positions[str(path)] = f.tell()
        except Exception as e:
            print(f"[LogMonitor] {path}: {e}", file=sys.stderr)

    def _run(self):
        while not self._stop.is_set():
            for p in self.log_paths:
                self._check_file(p)
            time.sleep(5)

    def start(self):
        if not self.webhook_url or not self.log_paths:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        print("[LogMonitor] 飞书告警监控已启动")

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)


def run_k6_stress(
    script_dir: Path,
    sandbox_count: int,
    traffic_duration: str,
    traffic_vus: int,
    base_env: dict,
    log_file: Path,
    sandbox_timeout_sec: int = 3600,
) -> int:
    """运行 k6-stress-100-sandboxes 场景"""
    script = script_dir / "k6-stress-100-sandboxes.js"
    if not script.exists():
        print(f"未找到 k6 脚本: {script}", file=sys.stderr)
        return 1
    env = os.environ.copy()
    env.update(base_env)
    env.update({
        "SANDBOX_COUNT": str(sandbox_count),
        "CREATE_COUNT": str(sandbox_count),
        "TRAFFIC_VUS": str(traffic_vus),
        "TRAFFIC_DURATION": traffic_duration,
        "SANDBOX_TIMEOUT": str(sandbox_timeout_sec),
    })
    cmd = ["k6", "run", str(script)]
    print(f"[运行] k6 长稳/波测: {sandbox_count} sandboxes, 流量持续 {traffic_duration}, VUS={traffic_vus}")
    with open(log_file, "w", encoding="utf-8") as f:
        p = subprocess.run(cmd, env=env, cwd=str(script_dir), stdout=f, stderr=subprocess.STDOUT)
    return p.returncode


def main():
    import argparse
    parser = argparse.ArgumentParser(description="长稳+波测压测，支持飞书告警")
    parser.add_argument("-c", "--config", default="", help="YAML 配置文件路径")
    parser.add_argument("--burst-only", action="store_true", help="仅运行波测（10 分钟）")
    parser.add_argument("--long-only", action="store_true", help="仅运行长稳（7*24h）")
    args = parser.parse_args()
    cfg = load_config(args.config)
    api_url = cfg["E2B_API_URL"]
    api_key = cfg["E2B_API_KEY"]
    if not api_key:
        print("错误: 请设置 E2B_API_KEY", file=sys.stderr)
        sys.exit(1)

    long_count = cfg["LONG_STABILITY_COUNT"]
    long_dur = cfg["LONG_STABILITY_DURATION"]
    burst_count = cfg["BURST_CONCURRENT"]
    burst_dur = cfg["BURST_DURATION"]
    webhook = (cfg.get("FEISHU_WEBHOOK_URL") or os.getenv("FEISHU_WEBHOOK_URL", "")).strip()
    # 7*24h = 604800 秒，长稳需足够 sandbox 存活时间
    long_sandbox_timeout = 7 * 24 * 3600

    results_dir = SCRIPT_DIR / "results"
    results_dir.mkdir(exist_ok=True)
    ts = time.strftime("%Y%m%d_%H%M%S")
    burst_log = results_dir / f"burst_test_{ts}.log"
    long_log = results_dir / f"long_stability_{ts}.log"

    env = {
        "E2B_API_URL": api_url,
        "API_BASE_URL": api_url,
        "E2B_API_KEY": api_key,
        "API_KEY": api_key,
        "TEMPLATE_ID": cfg["TEMPLATE_ID"],
    }
    for k, v in env.items():
        if v:
            os.environ[k] = v

    monitor = LogMonitor([str(burst_log), str(long_log)], webhook)
    monitor.start()

    rc_burst = 0
    rc_long = 0
    try:
        if not args.long_only:
            print("\n========== 波测：30 sandbox 并发 10 分钟 ==========")
            rc_burst = run_k6_stress(
                SCRIPT_DIR, burst_count, burst_dur,
                traffic_vus=min(burst_count, 30),
                base_env=env,
                log_file=burst_log,
                sandbox_timeout_sec=3600,
            )
            if rc_burst != 0:
                print(f"[波测] 退出码 {rc_burst}")
                if webhook:
                    send_feishu_alert(webhook, "波测失败", f"波测退出码: {rc_burst}")

        if not args.burst_only:
            print("\n========== 长稳：3 sandbox 持续压测 7*24 小时 ==========")
            rc_long = run_k6_stress(
                SCRIPT_DIR, long_count, long_dur,
                traffic_vus=min(long_count, 3),
                base_env=env,
                log_file=long_log,
                sandbox_timeout_sec=long_sandbox_timeout,
            )
            if rc_long != 0:
                print(f"[长稳] 退出码 {rc_long}")
                if webhook:
                    send_feishu_alert(webhook, "长稳测试失败", f"长稳退出码: {rc_long}")
    finally:
        monitor.stop()

    sys.exit(0 if (rc_burst == 0 and rc_long == 0) else 1)


if __name__ == "__main__":
    main()
