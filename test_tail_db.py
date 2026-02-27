import os
import time
import psutil  # 需要安装：pip install psutil
from dotenv import load_dotenv
from e2b import Sandbox

# 兼容E2B不同版本的异常类
try:
    from e2b import CommandExitException as CommandException
except ImportError:
    from e2b import CommandException

load_dotenv()

def monitor_sandbox_resources(sbx: Sandbox, interval: int = 2):
    """监控沙箱的关键资源（文件描述符、进程数、网络连接）"""
    try:
        # 获取沙箱内的系统资源信息
        fd_count = sbx.commands.run("ls /proc/self/fd | wc -l", timeout=5).stdout.strip()
        process_count = sbx.commands.run("ps aux | wc -l", timeout=5).stdout.strip()
        net_connections = sbx.commands.run("ss -tuln | wc -l", timeout=5).stdout.strip()
        
        print(f"[资源监控] 文件描述符数: {fd_count} | 进程数: {process_count} | 网络连接数: {net_connections}")
    except CommandException as e:
        print(f"[资源监控失败] {e}")

def simulate_tail_f_scenario():
    """模拟真实的tail -f操作+多命令并发，复现连接卡住问题"""
    template_id = os.getenv("TEMPLATE_ID", "test")
    sandbox_id = None
    retry_count = 3  # 模拟多次操作
    
    for attempt in range(retry_count):
        print(f"\n=== 第 {attempt+1} 次尝试 ===")
        sbx = None
        try:
            # 创建沙箱（兼容不同E2B版本的参数）
            try:
                sbx = Sandbox.create(
                    template_id,
                    timeout=1200,  # 延长超时时间，模拟长时间运行
                    allow_internet_access=True
                )
            except TypeError:
                sbx = Sandbox.create(template_id, timeout=1200)
            sandbox_id = sbx.sandbox_id
            print(f"创建沙箱成功: {sandbox_id}")

            # 1. 先创建一个日志文件，模拟真实的日志场景
            sbx.commands.run("touch /tmp/test.log && chmod 777 /tmp/test.log", timeout=5)
            print("创建测试日志文件: /tmp/test.log")

            # 2. 后台运行真实的tail -f命令（而非echo循环）
            tail_cmd = "bash -lc 'tail -f /tmp/test.log'"
            tail_handle = sbx.commands.run(tail_cmd, background=True)
            tail_pid = tail_handle.pid
            print(f"启动tail -f进程，PID: {tail_pid}")

            # 3. 模拟持续往日志文件写内容（贴近真实日志输出）
            write_handle = sbx.commands.run(
                "bash -lc 'while true; do echo \"$(date) - log line\" >> /tmp/test.log; sleep 0.5; done'",
                background=True
            )
            write_pid = write_handle.pid
            print(f"启动日志写入进程，PID: {write_pid}")

            # 4. 模拟多次常规操作（比如执行ls、ps、cat等命令）
            for i in range(10):
                try:
                    # 执行随机的常规命令
                    test_cmds = [
                        "ls -l /tmp",
                        "ps aux | grep tail",
                        "cat /proc/meminfo | head -5",
                        "df -h"
                    ]
                    cmd = test_cmds[i % len(test_cmds)]
                    result = sbx.commands.run(cmd, timeout=3)
                    print(f"执行常规命令[{i+1}]: {cmd} → 退出码: {result.exit_code}")
                    
                    # 每2次操作监控一次资源
                    if i % 2 == 0:
                        monitor_sandbox_resources(sbx)
                    
                    time.sleep(1)  # 模拟操作间隔
                except CommandException as e:
                    print(f"执行命令失败: {e}")
                    # 检测到命令执行失败，说明shell可能已卡住
                    raise RuntimeError(f"沙箱shell卡住，操作{i+1}失败")

            # 5. 模拟断开连接后重连（核心校验点）
            print("\n=== 模拟断开后重连 ===")
            tail_handle.disconnect()
            print("断开tail -f连接")
            
            # 等待几秒，模拟真实的“操作后卡住”场景
            time.sleep(5)
            
            # 重新连接沙箱
            re_sbx = Sandbox.connect(sandbox_id, timeout=1200)
            # 校验重连后是否能执行命令（关键：判断shell是否可用）
            check_result = re_sbx.commands.run("echo 'shell is alive'", timeout=5)
            if check_result.exit_code != 0 or "shell is alive" not in check_result.stdout:
                raise RuntimeError("重连后shell无响应，验证失败")
            print("重连后shell正常，验证通过")

            # 清理进程
            re_sbx.commands.kill(tail_pid)
            re_sbx.commands.kill(write_pid)
            print("清理测试进程完成")

        except RuntimeError as e:
            print(f"测试失败（复现问题）: {e}")
            # 保留沙箱用于排查（如需手动检查）
            # sbx.keep_alive()
            # print(f"沙箱已保留，ID: {sandbox_id}")
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
