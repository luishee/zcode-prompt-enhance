"""入口 `.bat` 与其转发目标（tools/menu.py）的契约测试。

为什么需要这两组判据：

1. `.bat` 的“薄”是靠三条不成文约定撑起来的——**UTF-8 无 BOM**、**仅 CRLF**、
   **中文只出现在 echo 行**。违反它们不会在运行时立刻报错，症状是「同一行中文
   有时正常、有时被当成命令执行」（实测：加了 BOM 会报 `'锘緻echo' 不是内部或
   外部命令` 且 `@echo off` 失效、整段命令被回显；另存为 GBK 则 chcp 65001 下中文
   全乱）。约定写进断言比写进文档靠人记可靠。
2. `.bat` 的退出码语义（`0` 成功 / `1` 缺依赖 / `2` 参数不对，且**只有失败才 pause**）
   是自动化依赖的契约。其中「多余参数必须报错」是 2026-11-11 修掉的静默失败：
   老写法会丢掉 `--asar`，让 `apply` 照着**默认路径**执行，参数写了没生效却毫无提示。

用法：
    python tests/test_entry_bat.py
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BAT = ROOT / "修复增强提示词按钮.bat"
MENU = ROOT / "tools" / "menu.py"

FAILED = 0
TOTAL = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILED, TOTAL
    TOTAL += 1
    if ok:
        print(f"  \u2713 {name}")
    else:
        FAILED += 1
        print(f"  \u2717 {name}" + (f"\n      {detail}" if detail else ""))


def run_menu(*args: str) -> tuple[int, str]:
    cp = subprocess.run(
        [sys.executable, str(MENU), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace", cwd=ROOT,
        stdin=subprocess.DEVNULL,  # 免得某个动作误入交互菜单把测试挂住
    )
    return cp.returncode, (cp.stdout or "") + (cp.stderr or "")


def run_bat(*args: str) -> tuple[int, str]:
    env = os.environ.copy()
    env["ZCE_NO_PAUSE"] = "1"  # 测试里不让 pause 卡住
    cp = subprocess.run(
        ["cmd", "/c", str(BAT), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
        cwd=ROOT, env=env,
    )
    return cp.returncode, (cp.stdout or "") + (cp.stderr or "")


def console_cp() -> int | None:
    """`.bat` 里会 chcp 65001，测试跑完把调用方的控制台代码页还回去。"""
    try:
        import ctypes

        return ctypes.windll.kernel32.GetConsoleOutputCP()
    except Exception:
        return None


def set_console_cp(cp: int | None) -> None:
    if cp is None:
        return
    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleOutputCP(cp)
    except Exception:
        pass


def test_bat_file() -> None:
    print("\n[1] .bat 文件本身的约定")
    if not BAT.exists():
        check("入口 .bat 存在", False, str(BAT))
        return
    raw = BAT.read_bytes()
    check("入口 .bat 存在且非空", len(raw) > 0)

    check("无 BOM（有 BOM 会让首行 @echo off 失效）", not raw.startswith(b"\xef\xbb\xbf"))
    try:
        text = raw.decode("utf-8")
        ok_utf8 = True
    except UnicodeDecodeError as exc:
        text, ok_utf8 = "", False
        check("内容可按 UTF-8 解码", False, str(exc))
    if ok_utf8:
        check("内容可按 UTF-8 解码", True)

    check("仅 CRLF（LF 会破坏 goto/label 解析）", raw.replace(b"\r\n", b"").count(b"\n") == 0)

    bad_lines = [
        line for line in text.splitlines()
        if any(ord(ch) > 127 for ch in line) and not line.lstrip().lower().startswith("echo")
    ]
    check("非 ASCII 只出现在 echo 行", not bad_lines, "越界行: " + repr(bad_lines[:2]))

    for token in ("chcp 65001", "pushd", "exit /b", "%*", "tools\\menu.py", "ZCE_NO_PAUSE"):
        check(f"含关键结构 {token}", token in text)
    check('有 RC 兜底（set "RC=1"）', 'set "RC=1"' in text)
    check(
        "解释器探测是“真跑一次”而不是只看 where",
        "import sys" in text and "where.exe" in text and "py.exe" in text,
    )


def test_menu_cli() -> None:
    print("\n[2] menu.py 的命令行契约")
    for arg in ("-h", "--help", "/?"):
        rc, out = run_menu(arg)
        check(f"{arg} → 退出码 0 且有用法", rc == 0 and "用法：" in out, f"rc={rc} out={out[:120]!r}")

    rc, out = run_menu("bogus")
    check("未知动作 → 退出码 2", rc == 2 and "未知参数" in out, f"rc={rc} out={out[:120]!r}")

    rc, out = run_menu("apply", "extra")
    check(
        "多余参数 → 退出码 2 且没有真的执行 apply（静默丢弃的回归判据）",
        rc == 2 and "多给了参数" in out and "[1/2]" not in out,
        f"rc={rc} out={out[:160]!r}",
    )

    rc, out = run_menu("--asar", "X")
    check("单独给选项（漏了动作）→ 退出码 2", rc == 2, f"rc={rc} out={out[:120]!r}")

    rc, out = run_menu("restore")
    check(
        "restore 遇到关闭的 stdin → 当作取消（rc 0、不抛 traceback）",
        rc == 0 and "已取消" in out and "Traceback" not in out,
        f"rc={rc} out={out[:200]!r}",
    )


def test_bat_end_to_end() -> None:
    print("\n[3] .bat 端到端（退出码 + 不因 pause 卡住）")
    if os.name != "nt":
        check("跳过：非 Windows", True)
        return

    old = console_cp()
    try:
        rc, out = run_bat("-h")
        check("-h → 退出码 0", rc == 0, f"rc={rc} out={out[:120]!r}")
        check("-h 成功时不 pause", "Press any key" not in out and "请按任意键" not in out)

        rc, out = run_bat("bogus")
        check("未知动作 → 退出码 2", rc == 2 and "未知参数" in out, f"rc={rc} out={out[:160]!r}")
        check("失败时 pause 被 ZCE_NO_PAUSE 抑制", "Press any key" not in out)

        rc, out = run_bat("apply", "--asar", str(ROOT / "不存在的包.asar"))
        check(
            "缺 tools/menu.py 之外的用法错误 → 退出码 2（参数没被静默忽略）",
            rc == 2 and "多给了参数" in out,
            f"rc={rc} out={out[:200]!r}",
        )
    finally:
        set_console_cp(old)


def main() -> int:
    print(f"入口 .bat 契约测试：{BAT}")
    test_bat_file()
    test_menu_cli()
    test_bat_end_to_end()

    print(f"\n{TOTAL - FAILED}/{TOTAL} 通过")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
