"""ZCode 增强提示词 · 维护菜单。

为什么把中文放在 Python 里而不是写在 .bat 内（2026-11-10 实测）：
cmd.exe 以固定大小的缓冲分块读取批处理文件，UTF-8 的多字节汉字一旦跨过缓冲边界
就会被截断，同一行 `echo 检查按钮是否已挂上` 有时正常、有时被当成命令执行并报
"'…' 不是内部或外部命令"。这是非确定性的，无法靠调整写法规避。
把界面文本交给 Python（配合 .bat 里的 chcp 65001）就完全稳定。

用法：
    python tools/menu.py                        交互菜单
    python tools/menu.py apply                  直接执行（apply|status|check|restore）
    python tools/menu.py -h                     显示用法
    python tools/menu.py --asar E:\\ZCode\\resources\\app.asar apply
                                                带路径参数（动作与选项前后都行）

参数写错一律以退出码 2 结束（与 README 的退出码表一致）：`.bat` 原样转发参数，
若这里把“写错的选项”当成“没看见”，就会出现「参数写了没生效、却看不出异常」。
"""

from __future__ import annotations

import os
import subprocess
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from zce_common import force_utf8  # noqa: E402

PROJECT_DIR = Path(__file__).resolve().parent.parent
PATCH_TOOL = PROJECT_DIR / "tools" / "patch_zcode.py"
BEACON_TOOL = PROJECT_DIR / "tools" / "check_beacon.py"

# 透传给 patch_zcode 的选项。patch_zcode 的全局选项必须写在子命令之前，
# 所以 menu 只负责搬运 + 校验，不自己解释这些值。
PATCH_VALUE_OPTS = ("--asar", "--backup", "--endpoint", "--out")
PATCH_FLAG_OPTS = ("--force", "--full-verify", "--dry-run")
FORWARD: list[str] = []

# 菜单项与键位映射的唯一来源：文案和 CHOICES 都从这里生成，
# 免得改了一个忘了另一个（早先 MENU 字符串和 CHOICES 字典是两份手抄）。
ITEMS = [
    ("1", "apply", "升级后重新注入按钮", "（ZCode 升级后跑这个）"),
    ("2", "status", "查看注入状态", ""),
    ("3", "check", "检查按钮是否已挂上", "（ZCode 需正在运行）"),
    ("4", "restore", "还原 / 彻底移除注入", ""),
]
CHOICES = {key: verb for key, verb, _label, _hint in ITEMS}
MENU_WIDTH = 24  # 标签的显示宽度（按东亚宽字符算 2 列）


def _pad(text: str, width: int) -> str:
    """按显示宽度补空格：中文占 2 列，用 ljust 会错位。"""
    shown = sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)
    return text + " " * max(1, width - shown)


MENU = (
    "\n"
    + "=" * 60 + "\n"
    + "   ZCode 增强提示词 · 维护\n"
    + "=" * 60 + "\n"
    + "\n"
    + "".join(f"   {key}  {_pad(label, MENU_WIDTH)}{hint}".rstrip() + "\n"
             for key, _verb, label, hint in ITEMS)
    + "   0  退出\n"
)


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


def run_patch(*cmd: str) -> int:
    """调用 patch_zcode：全局选项在前，子命令在后。"""
    return run([str(PATCH_TOOL), *FORWARD, *cmd])


def do_apply() -> int:
    print("\n[1/2] 检测 ZCode 是否在运行...")
    running = zcode_running()
    print("      ZCode 正在运行。" if running else "      ZCode 未运行。")

    print("[2/2] 写入注入（幂等：脚本没变会跳过，变了只刷新脚本）...\n")
    rc = run_patch("apply")
    print()

    if rc != 0:
        print(f"[失败] 退出码 {rc}。上面输出说明了原因，常见三种：")
        print("  - 不是可识别的 asar 包：ZCode 改了打包格式；文件未被改动，需人工处理")
        print("  - JSON 区放不下：新版本头部空间不足，需人工处理")
        print("  - 权限被拒：用“以管理员身份运行”再试一次")
        return rc

    # 演练/输出模式不改原 app.asar，所以不能说“补丁已写入、请重启 ZCode”——
    # 那会把人引到“已经生效了怎么没按钮”的错误结论上去。产物路径由上面那段输出给出。
    if "--dry-run" in FORWARD or "--out" in FORWARD:
        print("[完成] 演练/输出模式：原 app.asar 没有被改动，不需要重启 ZCode；")
        print("       请检查上面输出的产物路径，确认无误后再去掉 --dry-run / --out 正式执行。")
        return 0

    if running:
        print("[完成] 补丁已写入，但必须完全退出 ZCode 再重新打开才会生效。")
        print("       注意托盘图标也要退出，否则进程还在，等于没重启。")
    else:
        print("[完成] 现在打开 ZCode，按钮就会出现在输入框下方。")
    print("\n打开后想确认是否真的挂上了，请再运行本文件选 [3]。")
    return 0


def do_status() -> int:
    print()
    return run_patch("status")


def do_check() -> int:
    if FORWARD:
        print(f"（check 只读信标，忽略参数：{' '.join(FORWARD)}）")
    print("\n读取诊断信标（最多等 30 秒，方便刚重启完就查）...\n")
    return run([str(BEACON_TOOL), "--wait", "30"])


def do_restore() -> int:
    print("\n还原会把 app.asar 恢复成注入前的原始版本，按钮随之消失。")
    try:
        answer = input("确认还原？输入 y 继续: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print("\n已取消。")
        return 0
    if answer != "y":
        print("已取消。")
        return 0
    rc = run_patch("restore")
    print("\n还原后请完全退出并重新打开 ZCode。")
    return rc


VERBS = {
    "apply": do_apply,
    "status": do_status,
    "check": do_check,
    "restore": do_restore,
}


class UsageError(Exception):
    """命令行用法错误。

    统一走退出码 2：早先这些分支用的是 `raise SystemExit(文案)`，退出码是 1，
    而“未知动作”返回 2——同一个“参数写错了”却有两个码，`.bat` 的自动化无法区分
    「参数不对」和「执行失败」（README 的退出码表也写着 2 = 参数不认识）。
    """


USAGE = (
    "用法：menu.py [apply|status|check|restore] [--asar 路径] [--backup 路径]\n"
    "             [--endpoint URL] [--out 路径] [--force] [--full-verify] [--dry-run]\n"
    "      menu.py -h | --help | /?          显示本帮助\n"
    "\n"
    "只认 patch_zcode.py 真正支持的选项（写错立刻报错，不悄悄忽略）；\n"
    "动作与选项的先后顺序都接受：`apply --asar X` 与 `--asar X apply` 等价。"
)

HELP_ARGS = {"-h", "--help", "/?", "?", "help"}


def parse_argv(argv: list[str]) -> tuple[str | None, list[str]]:
    """把命令行拆成 (动作, 透传给 patch_zcode 的参数)。

    只认 patch_zcode 真正支持的选项（写错时立刻报错，而不是悄悄忽略）。
    动作与选项的先后顺序都接受：`apply --asar X` 和 `--asar X apply` 等价。
    """
    verb: str | None = None
    out: list[str] = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        name, has_value, _inline = arg.partition("=")
        if name in PATCH_FLAG_OPTS:
            if has_value:
                raise UsageError(f"{name} 是开关，不接受值\n\n{USAGE}")
            out.append(name)
            i += 1
            continue
        if name in PATCH_VALUE_OPTS:
            if has_value:
                out.append(arg)
                i += 1
                continue
            if i + 1 >= len(argv):
                raise UsageError(f"{name} 需要一个值，例如 {name} <路径>\n\n{USAGE}")
            value = argv[i + 1]
            # 别把下一个选项当成值：`--asar --force apply` 若照搬会把 --force 传给
            # argparse，报错指向下游、难以定位；这里直接当作用法错误（退出码 2）。
            if value.startswith("-"):
                raise UsageError(f"{name} 需要一个值，但读到的是选项 {value}\n\n{USAGE}")
            out += [name, value]
            i += 2
            continue
        if arg.startswith("-"):
            raise UsageError(f"未知参数：{arg}\n\n{USAGE}")
        if verb is not None:
            raise UsageError(f"多给了动作：{verb} 和 {arg}\n\n{USAGE}")
        verb = arg.strip().lower()
        i += 1
    return verb, out


def main() -> int:
    force_utf8(line_buffering=True)

    argv = sys.argv[1:]

    if any(arg.strip().lower() in HELP_ARGS for arg in argv):
        print(USAGE)
        return 0

    try:
        verb, forward = parse_argv(argv)
    except UsageError as exc:
        print(exc)
        return 2

    if verb is not None and verb not in VERBS:
        print(f"未知动作：{verb}\n")
        print(USAGE)
        return 2

    FORWARD.extend(forward)
    if verb is not None:
        return VERBS[verb]()
    if FORWARD:
        # 给了选项却没给动作：也是用法问题，同样走 2（早先是 SystemExit(文案) → 1）。
        print("请同时指定动作：apply | status | check | restore\n")
        print(USAGE)
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
        action = CHOICES.get(choice)
        if action is None:
            print(f"无效选择：{choice}")
            continue

        rc = VERBS[action]()
        print("\n按回车返回菜单（或直接关闭窗口）...")
        try:
            input()
        except (EOFError, KeyboardInterrupt):
            return rc
        os.system("cls" if os.name == "nt" else "clear")


if __name__ == "__main__":
    sys.exit(main())
