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

sys.path.insert(0, str(Path(__file__).resolve().parent))
from zce_common import force_utf8  # noqa: E402

# 信标由插件（MCP server）写入 %LOCALAPPDATA%\zcode-prompt-enhance\beacon.log。
# 已退役的 Python 服务曾写在仓库 logs/ 下；那条回退分支已删除——它在两个位置都不存在时
# 会报出旧路径，让人误以为在看插件日志（实际排查时被这个坑过一次）。
_PRIMARY_LOG = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "zcode-prompt-enhance" / "beacon.log"


def resolve_log() -> tuple[Path, str]:
    """返回 (要读的路径, 来源说明)。"""
    if _PRIMARY_LOG.exists():
        return _PRIMARY_LOG, "插件（当前实现）"
    return _PRIMARY_LOG, "期望位置，尚不存在"


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
    force_utf8()
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
    # 打印"最后 40 条"而不是"最早 40 条"：日志到 5MB 上限后最早的那批是几天前的，
    # 而下面要判断的是本次启动，打印旧会话内容会跟结论打架（实测很容易看串）。
    for ev in events[-40:]:
        stage = ev.get("stage")
        detail = {k: v for k, v in ev.items() if k not in ("stage", "ts", "clientTs", "url", "session")}
        print(f"  - {stage}  {json.dumps(detail, ensure_ascii=False)}")

    # 只认「本次启动」的事件：上次运行成功过的 attached 不能证明这次按钮挂上了，
    # 而「按钮没出现」正是这个工具唯一要回答的问题。
    # 会话边界优先用注入脚本生成的 session（每次 boot 一个），因为 url 在多次启动之间
    # 是稳定的，按 url 划分会把上一次的 attached 也算进来（会误报"✓ 已挂上"）。
    # 老版本注入脚本没有 session 字段，仍退回按 url 划分。
    last_session = next((ev.get("session") for ev in reversed(events) if ev.get("session")), "")
    if last_session:
        recent = [ev for ev in events if ev.get("session") == last_session]
        print(f"（只统计本次启动：session={last_session}，{len(recent)} 条）")
    else:
        last_url = next((ev.get("url") for ev in reversed(events) if ev.get("url")), "")
        recent = [ev for ev in events if ev.get("url") == last_url] if last_url else events
        print("（信标里没有 session 字段：注入脚本是旧版本，按 url 划分会话）")
    stages = {ev.get("stage") for ev in recent}
    print()

    # 写回结果单独说清楚：这是「增强成功但回填失败」这类问题的唯一线索
    last_write = next(
        (ev for ev in reversed(recent) if ev.get("stage") in ("write-ok", "write-failed")),
        None,
    )
    if last_write:
        if last_write.get("stage") == "write-ok":
            print(f"✓ 最近一次写回成功，走的策略：{last_write.get('strategy')}"
                  f"（找到官方 API={last_write.get('hasApi')}）")
        else:
            print(f"✗ 最近一次写回失败：已尝试 {last_write.get('tried')}；"
                  f"找到官方 API={last_write.get('hasApi')}")
            print(f"  期望长度 {last_write.get('wantLen')} / 实得 {last_write.get('gotLen')}")
            print(f"  期望开头：{str(last_write.get('wantHead'))[:50]}")
            print(f"  实得开头：{str(last_write.get('gotHead'))[:50]}")
            if not last_write.get("hasApi"):
                print("  → 没找到官方输入 API：说明编辑器组件结构变了，需要更新 findEditorApi")

    if "attached" in stages:
        print("✓ 脚本已加载，按钮已挂到输入框工具栏上。")
        if "composer-seen" not in stages:
            print("  （缺 composer-seen，可能只是没记录到首次接手）")
        return 0
    if "attach-failed" in stages:
        print("✗ 找到了 composer，但锚点失配，按钮没挂上。")
        for ev in recent:
            if ev.get("stage") == "attach-failed":
                print(f"  hasActions={ev.get('hasActions')} hasEditor={ev.get('hasEditor')}")
        print("  → 需要按当前 DOM 更新 SEL.actions / SEL.editor 选择器。")
        return 1
    if "composer-seen" in stages:
        print("✗ 找到了 composer 但尚未挂上按钮（可能仍在等编辑器/工具栏渲染）。")
        return 1

    print("✗ 脚本加载了，但没有找到任何 composer（输入框选择器可能已变）。")
    for ev in recent:
        if ev.get("stage") == "boot":
            print(f"  boot 时 composers={ev.get('composers')} hasRoot={ev.get('hasRoot')}")
    return 1


if __name__ == "__main__":
    sys.exit(main())