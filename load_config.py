#!/usr/bin/env python3
"""
从 YAML 配置文件加载参数，输出 shell export 语句。
用法: eval "$(python3 load_config.py config.yaml)"
"""
import re
import sys


def simple_yaml_load(path: str) -> dict:
    """解析简单的 YAML（仅支持顶层 key: value，兼容标准 YAML 语法）"""
    result = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            # 移除行尾注释
            line = re.sub(r"\s+#.*$", "", line).rstrip()
            if not line or line.startswith("#"):
                continue
            # 匹配 key: value
            m = re.match(r'^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$', line)
            if m:
                key, val = m.group(1), m.group(2).strip()
                if not val or val in ("null", "~"):
                    val = ""
                elif (val.startswith('"') and val.endswith('"')) or (
                    val.startswith("'") and val.endswith("'")
                ):
                    val = val[1:-1].replace('\\"', '"').replace("\\'", "'")
                elif val.lower() in ("true", "yes"):
                    val = "1"
                elif val.lower() in ("false", "no"):
                    val = "0"
                result[key] = str(val)
    return result


def escape_shell(val: str) -> str:
    """转义以用于 shell export"""
    if not val:
        return '""'
    return "'" + val.replace("'", "'\"'\"'") + "'"


def main():
    if len(sys.argv) < 2:
        print("Usage: load_config.py <config.yaml>", file=sys.stderr)
        sys.exit(1)
    path = sys.argv[1]
    try:
        cfg = simple_yaml_load(path)
    except FileNotFoundError:
        print(f"Config file not found: {path}", file=sys.stderr)
        sys.exit(1)

    for k, v in cfg.items():
        if k.startswith("_"):
            continue
        # 空值不导出，保留环境变量
        if not v:
            continue
        print(f"export {k}={escape_shell(v)}")


if __name__ == "__main__":
    main()
