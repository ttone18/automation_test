import os
import time

from dotenv import load_dotenv
from e2b import Sandbox

# 兼容E2B不同版本的异常类
try:
    from e2b import CommandExitException as CommandException
except ImportError:
    try:
        from e2b import CommandException
    except ImportError:
        CommandException = Exception

load_dotenv()


def monitor_sandbox_resources(sbx: Sandbox, interval: int = 2):
    """监控沙箱的关键资源（文件描述符、进程数、网络连接）"""
    try:
        fd_count = sbx.commands.run("ls /proc/self/fd | wc -l", timeout=5).stdout.strip()
        process_count = sbx.commands.run("ps aux | wc -l", timeout=5).stdout.strip()
        net_connections = sbx.commands.run("ss -tuln | wc -l", timeout=5).stdout.strip()
        print(f"[资源监控] 文件描述符数: {fd_count} | 进程数: {process_count} | 网络连接数: {net_connections}")
    except Exception as e:
        print(f"[资源监控失败] {e}")


def simulate_tail_f_scenario():
    """模拟真实的tail -f操作+多命令并发，复现连接卡住问题"""
    template_id = os.getenv("TEMPLATE_ID", "test")
    sandbox_id = None
    retry_count = 3

    for attempt in range(retry_count):
        print(f"\n=== 第 {attempt+1} 次尝试 ===")
        sbx = None
        try:
            try:
                sbx = Sandbox.create(
                    template_id,
                    timeout=1200,
                    allow_internet_access=True
                )
            except TypeError:
                sbx = Sandbox.create(template_id, timeout=1200)
            sandbox_id = sbx.sandbox_id
            print(f"创建沙箱成功: {sandbox_id}")

            sbx.commands.run("touch /tmp/test.log && chmod 777 /tmp/test.log", timeout=5)
            print("创建测试日志文件: /tmp/test.log")

            tail_cmd = "bash -lc 'tail -f /tmp/test.log'"
            tail_handle = sbx.commands.run(tail_cmd, background=True)
            tail_pid = tail_handle.pid
            print(f"启动tail -f进程，PID: {tail_pid}")

            write_handle = sbx.commands.run(
                "bash -lc 'while true; do echo \"$(date) - log line\" >> /tmp/test.log; sleep 0.5; done'",
                background=True
            )
            write_pid = write_handle.pid
            print(f"启动日志写入进程，PID: {write_pid}")

            for i in range(10):
                try:
                    test_cmds = [
                        "ls -l /tmp",
                        "ps aux | grep tail",
                        "cat /proc/meminfo | head -5",
                        "df -h"
                    ]
                    cmd = test_cmds[i % len(test_cmds)]
                    result = sbx.commands.run(cmd, timeout=3)
                    print(f"执行常规命令[{i+1}]: {cmd} → 退出码: {result.exit_code}")

                    if i % 2 == 0:
                        monitor_sandbox_resources(sbx)

                    time.sleep(1)
                except Exception as e:
                    print(f"执行命令失败: {e}")
                    raise RuntimeError(f"沙箱shell卡住，操作{i+1}失败")

            print("\n=== 模拟断开后重连 ===")
            tail_handle.disconnect()
            print("断开tail -f连接")

            time.sleep(5)

            re_sbx = Sandbox.connect(sandbox_id, timeout=1200)
            check_result = re_sbx.commands.run("echo 'shell is alive'", timeout=5)
            if check_result.exit_code != 0 or "shell is alive" not in (check_result.stdout or ""):
                raise RuntimeError("重连后shell无响应，验证失败")
            print("重连后shell正常，验证通过")

            re_sbx.commands.kill(tail_pid)
            re_sbx.commands.kill(write_pid)
            print("清理测试进程完成")

        except RuntimeError as e:
            print(f"测试失败（复现问题）: {e}")
            return False
        except Exception as e:
            print(f"未知错误: {e}")
            return False
        finally:
            if sbx:
                sbx.kill()
                print(f"销毁沙箱: {sandbox_id}")

    print("\n=== 所有测试完成，未复现连接卡住问题 ===")
    return True


if __name__ == "__main__":
    success = simulate_tail_f_scenario()
    if not success:
        print("❌ 复现了tail -f导致的沙箱连接卡住问题")
    else:
        print("✅ 未复现问题，需调整测试参数继续验证")
