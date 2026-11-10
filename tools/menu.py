"""ZCode 增强提示词 · 维护菜单。

为什么把中文放在 Python 里而不是写在 .bat 内（2026-11-10 实测）：
cmd.exe 以固定大小的缓冲分块读取批处理文件，UTF-8 的多字节汉字一旦跨过缓冲边界
就会被截断，同一行 `echo 检查按钮是否已挂上` 有时正常、有时被当成命令执行并报
"'…' 不是内部或外部命令"。这是非确定性的，无法靠调整写法规避。
把界面文本交给 Python（配合 .bat 里的 chcp 65001）就完全稳定。

用法：
    python tools/menu.py            交互菜单
    python tools/menu.py apply      直接执行（用于自动化；apply|status|check|restore）
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
PATCH_TOOL = PROJECT_DIR / "tools" / "patch_zcode.py"
BEACON_TOOL = PROJECT_DIR / "tools" / "check_beacon.py"


def _force_utf8() -> None:
    """强制 UTF-8 且按行刷新。

    行刷新不是洁癖：本脚本会调起子进程（patch_zcode.py / check_beacon.py），
    子进程直接写同一个控制台句柄。若父进程的输出被块缓冲，就会出现
    「[1/2] 检测…」跑到子进程输出之后的错乱顺序（实测如此）。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", line_buffering=True)
        except (AttributeError, ValueError, OSError):
            pass


def zcode_running() -> bool:
    """用 Python 判断，避免 .bat 里 find/findstr 被 PATH 里别的同名程序顶替（实测踩过）。"""
    try:
        out = subprocess.run(
            ["tasklist", "/fi", "IMAGENAME eq ZCode.exe", "/nh"],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
        ).stdout or ""
        return "zcode.exe" in out.lower()
    except Exception:
        return False


def run(args: list[str]) -> int:
    return subprocess.call([sys.executable, *args])


def do_apply() -> int:
    print("\n[1/2] 检测 ZCode 是否在运行...")
    running = zcode_running()
    print("      ZCode 正在运行。" if running else "      ZCode 未运行。")

    print("[2/2] 写入注入（幂等，已注入会跳过）...\n")
    rc = run([str(PATCH_TOOL), "apply"])
    print()

    if rc != 0:
        print(f"[失败] 退出码 {rc}。上面输出说明了原因，常见三种：")
        print("  - 不是可识别的 asar 包：ZCode 改了打包格式；文件未被改动，需人工处理")
        print("  - JSON 区放不下：新版本头部空间不足，需人工处理")
        print("  - 权限被拒：用“以管理员身份运行”再试一次")
        return rc

    if running:
        print("[完成] 补丁已写入，但必须完全退出 ZCode 再重新打开才会生效。")
        print("       注意托盘图标也要退出，否则进程还在，等于没重启。")
    else:
        print("[完成] 现在打开 ZCode，按钮就会出现在输入框下方。")
    print("\n打开后想确认是否真的挂上了，请再运行本文件选 [3]。")
    return 0


def do_status() -> int:
    print()
    return run([str(PATCH_TOOL), "status"])


def do_check() -> int:
    print("\n读取诊断信标（最多等 30 秒，方便刚重启完就查）...\n")
    return run([str(BEACON_TOOL), "--wait", "30"])


def do_restore() -> int:
    print("\n还原会把 app.asar 恢复成注入前的原始版本，按钮随之消失。")
    answer = input("确认还原？输入 y 继续: ").strip().lower()
    if answer != "y":
        print("已取消。")
        return 0
    rc = run([str(PATCH_TOOL), "restore"])
    print("\n还原后请完全退出并重新打开 ZCode。")
    return rc


VERBS = {
    "apply": do_apply,
    "status": do_status,
    "check": do_check,
    "restore": do_restore,
}

MENU = """
============================================================
   ZCode 增强提示词 · 维护
============================================================

   1  升级后重新注入按钮      （ZCode 升级后跑这个）
   2  查看注入状态
   3  检查按钮是否已挂上      （ZCode 需正在运行）
   4  还原 / 彻底移除注入
   0  退出
"""

CHOICES = {"1": "apply", "2": "status", "3": "check", "4": "restore"}


def main() -> int:
    _force_utf8()

    if len(sys.argv) > 1:
        verb = sys.argv[1].strip().lower()
        if verb in VERBS:
            return VERBS[verb]()
        print(f"未知参数：{verb}")
        print("用法：menu.py [apply|status|check|restore]")
        return 2

    while True:
        print(MENU)
        try:
            choice = input("请选择 [1]: ").strip() or "1"
        except (EOFError, KeyboardInterrupt):
            print()
            return 0

        if choice == "0":
            return 0
        verb = CHOICES.get(choice)
        if verb is None:
            print(f"无效选择：{choice}")
            continue

        rc = VERBS[verb]()
        print("\n按回车返回菜单（或直接关闭窗口）...")
        try:
            input()
        except (EOFError, KeyboardInterrupt):
            return rc
        os.system("cls" if os.name == "nt" else "clear")


if __name__ == "__main__":
    sys.exit(main())
