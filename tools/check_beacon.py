"""解读注入脚本的诊断信标，判断按钮卡在哪一步。

用法：
    python tools/check_beacon.py [--wait 秒数]

看不到 ZCode 的 DOM 时，靠这份日志区分三类失败：
  1. 完全没有 boot → 补丁没生效 / ZCode 没重启 / 脚本路径被拦；
  2. 有 boot 但没有 composer-seen → 输入框选择器失配（DOM 结构变了）；
  3. 有 composer-seen 但 attach-failed → 锚点失配（工具栏结构变了）。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

# 信标由插件（MCP server）写入 %LOCALAPPDATA%\zcode-prompt-enhance\beacon.log。
# 旧位置 logs/beacon.log 是已退役的 Python 服务写的，只作历史兜底。
# 注意：不能写成「存在才用主路径，否则退回旧路径」——那样在两者都不存在时会报出旧路径，
# 让人误以为在看插件日志（实际排查时被这个坑过一次）。
_PRIMARY_LOG = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "zcode-prompt-enhance" / "beacon.log"
_LEGACY_LOG = Path(__file__).resolve().parent.parent / "logs" / "beacon.log"


def resolve_log() -> tuple[Path, str]:
    """返回 (要读的路径, 来源说明)。"""
    if _PRIMARY_LOG.exists():
        return _PRIMARY_LOG, "插件（当前实现）"
    if _LEGACY_LOG.exists():
        return _LEGACY_LOG, "旧 Python 服务遗留"
    return _PRIMARY_LOG, "期望位置，尚不存在"


def _force_utf8() -> None:
    """Windows 控制台默认 GBK，中文信标解读会乱码；统一按 UTF-8 输出。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError, OSError):
            pass


def read_events() -> list[dict]:
    log_path, _ = resolve_log()
    if not log_path.exists():
        return []
    events = []
    for line in log_path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        # 插件写的是 "<ISO 时间戳> {json}"，旧 Python 服务写的是纯 JSON。
        # 两种都要能读，否则插件写的那份会被整行判成 unparsable，日志等于白记。
        payload = line
        if not line.startswith("{"):
            brace = line.find("{")
            payload = line[brace:] if brace >= 0 else line
        try:
            events.append(json.loads(payload))
        except json.JSONDecodeError:
            events.append({"stage": "unparsable", "raw": line[:200]})
    return events


def main() -> int:
    _force_utf8()
    parser = argparse.ArgumentParser()
    parser.add_argument("--wait", type=float, default=0, help="等待日志出现的秒数")
    args = parser.parse_args()

    deadline = time.time() + args.wait
    while args.wait and time.time() < deadline and not read_events():
        time.sleep(2)

    events = read_events()
    log_path, source = resolve_log()
    if not events:
        print("✗ 没有任何信标，无法判断按钮为何不出现。")
        print("  按可能性排序：")
        print("   1. 注入层没生效 —— asar 被 ZCode 升级覆盖了，重跑 tools/patch_zcode.py apply")
        print("   2. ZCode 未完全重启 —— 补丁要重启后才加载")
        print("   3. 信标上报仍在重试中 —— 注入脚本失败后会每 3s 重试（最多 20 次，约 60s）；")
        print("      若刚重启 ZCode，稍等片刻再查；用 --wait 60 可以让它自己等")
        print(f"  读取路径：{log_path}（{source}）")
        return 1

    print(f"收到 {len(events)} 条信标（来源：{source} · {log_path}）：")
    for ev in events[:40]:
        stage = ev.get("stage")
        detail = {k: v for k, v in ev.items() if k not in ("stage", "ts", "url")}
        print(f"  - {stage}  {json.dumps(detail, ensure_ascii=False)}")

    stages = {ev.get("stage") for ev in events}
    print()

    # 写回结果单独说清楚：这是「增强成功但回填失败」这类问题的唯一线索
    for stage, label in (("write-ok", "写回成功"), ("write-failed", "写回失败")):
        for ev in events:
            if ev.get("stage") != stage:
                continue
            if stage == "write-ok":
                print(f"✓ 最近一次写回成功，走的策略：{ev.get('strategy')}"
                      f"（找到官方 API={ev.get('hasApi')}）")
            else:
                print(f"✗ 最近一次写回失败：已尝试 {ev.get('tried')}；"
                      f"找到官方 API={ev.get('hasApi')}")
                print(f"  期望长度 {ev.get('wantLen')} / 实得 {ev.get('gotLen')}")
                print(f"  期望开头：{str(ev.get('wantHead'))[:50]}")
                print(f"  实得开头：{str(ev.get('gotHead'))[:50]}")
                if not ev.get("hasApi"):
                    print("  → 没找到官方输入 API：说明编辑器组件结构变了，需要更新 findEditorApi")
            break

    if "attached" in stages:
        print("✓ 脚本已加载，按钮已挂到输入框工具栏上。")
        if not any(ev.get("stage") == "composer-seen" for ev in events):
            print("  （缺 composer-seen，可能只是没记录到首次接手）")
        return 0
    if "attach-failed" in stages:
        print("✗ 找到了 composer，但锚点失配，按钮没挂上。")
        for ev in events:
            if ev.get("stage") == "attach-failed":
                print(f"  hasActions={ev.get('hasActions')} hasEditor={ev.get('hasEditor')}")
        print("  → 需要按当前 DOM 更新 SEL.actions / SEL.editor 选择器。")
        return 1
    if "composer-seen" in stages:
        print("✗ 找到了 composer 但尚未挂上按钮（可能仍在等编辑器/工具栏渲染）。")
        return 1

    print("✗ 脚本加载了，但没有找到任何 composer（输入框选择器可能已变）。")
    for ev in events:
        if ev.get("stage") == "boot":
            print(f"  boot 时 composers={ev.get('composers')} hasRoot={ev.get('hasRoot')}")
    return 1


if __name__ == "__main__":
    sys.exit(main())