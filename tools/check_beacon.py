"""解读注入脚本的诊断信标，判断按钮卡在哪一步。

用法：
    python tools/check_beacon.py [--wait 秒数] [--purge-legacy]
    --purge-legacy：先物理删除旧格式行（只留插件格式），再做常规分析

看不到 ZCode 的 DOM 时，靠这份日志区分三类失败：
  1. 完全没有 boot → 补丁没生效 / ZCode 没重启 / 脚本路径被拦；
  2. 有 boot 但没有 composer-seen → 输入框选择器失配（DOM 结构变了）；
  3. 有 composer-seen 但 attach-failed → 锚点失配（工具栏结构变了）。

只认**插件格式**的信标：插件（MCP server）写的是单行纯 JSON，一定以 `{` 开头。
已退役的 Python 服务写的是 "<ISO 时间戳> {json}"（前面带时间戳），这类旧格式一律忽略，
否则几天前那批记录会混进「本次启动」的统计，也会把下面的展示区占满。
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
LOG_PATH = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "zcode-prompt-enhance" / "beacon.log"

# --wait 轮询时同一份日志会被反复读：按 (大小, mtime) 记忆化，内容没变就不重新解析。
_CACHE: dict[tuple[int, int], tuple[list[dict], int]] = {}


def read_events() -> tuple[list[dict], int]:
    """返回 (插件格式事件, 被忽略的旧格式行数)。

    判据：插件写的是单行纯 JSON（以 `{` 开头）；旧 Python 服务写的是
    "<ISO 时间戳> {json}"。只解析前者，旧格式只计数不展示。
    """
    try:
        st = LOG_PATH.stat()
    except OSError:
        return [], 0
    stamp = (st.st_size, st.st_mtime_ns)
    if stamp in _CACHE:
        return _CACHE[stamp]

    events: list[dict] = []
    legacy = 0
    for line in LOG_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip().lstrip("\ufeff")  # 容错：文件开头若带 BOM 也认得出插件格式
        if not line:
            continue
        if not line.startswith("{"):
            legacy += 1  # 旧格式（Python 时代），忽略
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            # 插件格式但坏了（例如写盘被打断）：不静默丢弃，标成 unparsable 让人看见
            events.append({"stage": "unparsable", "raw": line[:200]})
    result = (events, legacy)
    _CACHE.clear()  # 只留最近一次，避免缓存无限增长
    _CACHE[stamp] = result
    return result


def purge_legacy() -> tuple[int, int]:
    """删掉日志里 Python 时代的旧格式行，只保留插件格式（纯 JSON）。

    返回 (删除行数, 保留行数)。按字节逐行处理：
      - 日志是本机服务写的 UTF-8，按字节过滤既不会因解码替换弄坏内容，
        也能原样保留行尾（CRLF/LF 都不改）；
      - 只删「非空且不以 `{` 开头」的行，空行与损坏的插件行（以 `{` 开头）都保留；
      - 临时文件 + os.replace 原子替换，避免中途失败留下半截日志。

    注意：这是维护动作，清理期间若有新信标写入可能被覆盖掉；建议 ZCode 退出时执行。
    """
    try:
        raw = LOG_PATH.read_bytes()
    except OSError:
        return 0, 0

    kept: list[bytes] = []
    removed = 0
    for line in raw.splitlines(keepends=True):
        stripped = line.strip().lstrip(b"\xef\xbb\xbf")
        if stripped and not stripped.startswith(b"{"):
            removed += 1
            continue
        kept.append(line)

    if removed:
        tmp = LOG_PATH.with_name(LOG_PATH.name + ".tmp")
        try:
            tmp.write_bytes(b"".join(kept))
            os.replace(tmp, LOG_PATH)
        except OSError:
            try:  # 清理失败不该掩盖原始错误
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            raise
        _CACHE.clear()
    return removed, len(kept)


def main() -> int:
    force_utf8()
    parser = argparse.ArgumentParser()
    parser.add_argument("--wait", type=float, default=0, help="等待日志出现的秒数")
    parser.add_argument(
        "--purge-legacy", action="store_true",
        help="先删掉日志里 Python 时代旧的「<时间戳> {json}」行（只保留插件格式），再照常分析",
    )
    args = parser.parse_args()

    if args.purge_legacy:
        try:
            removed, kept = purge_legacy()
        except OSError as exc:
            print(f"✗ 清理旧格式日志失败：{exc}")
            print("  日志可能正被插件写入，稍后重试；下面的分析将基于未清理的日志继续")
        else:
            if removed:
                print(f"✓ 已清理 {removed} 行旧格式记录，保留 {kept} 行插件格式（{LOG_PATH}）")
            else:
                print(f"（没有旧格式记录，无需清理；{LOG_PATH}）")

    deadline = time.time() + args.wait
    while args.wait and time.time() < deadline and not read_events()[0]:
        time.sleep(2)

    events, legacy = read_events()
    if not events:
        print("✗ 没有任何信标，无法判断按钮为何不出现。")
        if legacy:
            print(f"  （日志里有 {legacy} 行旧格式记录，来自已退役的 Python 服务，已忽略——"
                  "它们不能证明插件这次跑过）")
        print("  按可能性排序：")
        print("   1. 注入层没生效 —— asar 被 ZCode 升级覆盖了，重跑 tools/patch_zcode.py apply")
        print("   2. ZCode 未完全重启 —— 补丁要重启后才加载")
        print("   3. 信标上报仍在重试中 —— 注入脚本失败后会每 3s 重试（最多 20 次，约 60s）；")
        print("      若刚重启 ZCode，稍等片刻再查；用 --wait 60 可以让它自己等")
        print(f"  读取路径：{LOG_PATH}（尚无信标）")
        return 1

    print(f"收到 {len(events)} 条信标（{LOG_PATH}）：")
    if legacy:
        print(f"（另有 {legacy} 行旧格式记录来自已退役的 Python 服务，已忽略）")
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