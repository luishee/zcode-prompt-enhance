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


def _report_model_anchor(recent: list[dict]) -> None:
    """报告「跟随当前模型」用的界面锚点是否命中。

    为什么单独说：按钮能挂上、增强也能成功，但模型锚点失效时用户完全看不出来 ——
    服务端会回落到通道默认模型，结果看起来正常，只是换模型后不生效。

    数据来源优先 model-pick（用户点按钮那一刻的取值），其次 composer-seen：
    composer-seen 是在 composer 刚出现时发的，那时模型目录还没加载完，
    data-model 往往是空串，只看它会误报「锚点存在但取不到值」。

    锚点在 composer 的**兄弟**节点（chat toolbar）里，不在 composer 子树内，
    所以注入脚本是逐级向上找「最近一层含锚点的祖先」。四种失效分开报：
      - 三锚点全无     → 选择器全失配，DOM 结构变了；
      - 锚点在但值为空 → 取值解析或加载时机有问题；
      - 只命中 label   → 只能拿到显示名，模型 id 可能对不上。
    """
    picks = [ev for ev in recent if ev.get("stage") == "model-pick"]
    if picks:
        last = picks[-1]
        anchor = last.get("anchor")
        model = last.get("model")
        source = "点击时"
    else:
        seen = [ev for ev in recent if ev.get("stage") == "composer-seen"]
        if not seen:
            return
        last = seen[-1]
        anchor = last.get("modelAnchor")
        model = last.get("modelFromDom")
        source = "首次挂载时"

    if anchor and model:
        via = {"config": "data-testid=v4-model-config", "value": "data-model-current-value",
               "label": "data-composer-open-label（显示名）"}.get(anchor, anchor)
        if anchor == "label":
            print(f"△ 模型锚点只命中显示名：{model}（{source}，来源 {via}）")
            print("  显示名可能被截断或与上游 id 不一致；能命中 data-model 时优先用它。")
        else:
            print(f"✓ 模型锚点命中：{model}（{source}，来源 {via}）")
        return

    has_config = last.get("hasModelConfig")
    has_value = last.get("hasModelValue")
    has_label = last.get("hasModelLabel")

    if has_config or has_value or has_label:
        print(f"✗ 模型锚点存在但取不到值（{source}）：增强会回落到通道默认模型。")
        print(f"  锚点存在情况：v4-model-config={has_config} current-value={has_value} open-label={has_label}")
        print("  → 检查取值解析（data-model 直接用；data-model-current-value 应按第一个 / 切分）")
        return

    print(f"✗ 三个模型锚点都没找到（{source}）：增强会回落到通道默认模型，")
    print("  表现为「在界面里换模型后增强不跟随」。")
    print("  → 锚点通常在 chat toolbar（composer 的兄弟节点），确认 modelScope 的向上查找范围")


def _report_server_records(events: list[dict]) -> None:
    """汇总服务端写入的记录（有 `kind`、没有 `stage`/`session`）。

    为什么不能靠会话过滤：这些记录不带 session，按 session 划分时会被整批滤掉，
    而「点了按钮但输入框没变」的答案恰恰在这里 —— 服务端判定结果不合格，
    主动退回原文（`success:true` + `improved:false`）。早先它们只存在于日志里，
    在结论区一条都看不到，排查时永远缺这一环。
    """
    records = [ev for ev in events if ev.get("kind") and not ev.get("stage")]
    if not records:
        return
    counts: dict[str, int] = {}
    reasons: dict[str, int] = {}
    for ev in records:
        kind = str(ev.get("kind"))
        counts[kind] = counts.get(kind, 0) + 1
        for reason in ev.get("reasons") or []:
            # 只留判定名（去掉「校验未过：」前缀与具体细节），便于看趋势
            name = str(reason).split("：")[-1].split(":")[0].strip()
            reasons[name] = reasons.get(name, 0) + 1
    summary = "、".join(f"{k}×{v}" for k, v in sorted(counts.items()))
    print(f"服务端记录（全量累计，无 session，不按本次启动过滤）：{summary}")
    if reasons:
        top = sorted(reasons.items(), key=lambda kv: -kv[1])
        print("  判定原因：" + "、".join(f"{k}×{v}" for k, v in top[:6]))
    last = records[-1]
    print(f"  最近一次：{json.dumps({k: v for k, v in last.items() if k != 'ts'}, ensure_ascii=False)[:200]}")
    if counts.get("enhance-fallback"):
        print("  → 这些是「点了按钮但草稿没变」：服务端校验判定结果不合格，主动退回原文。")
        print("     草稿本身够清楚时属正常；频率高则是校验规则误判（见 validateEnhancement）。")
    print()


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
        # 服务端记录没有 stage，用 kind 兜底；否则这里会打出 "None"，
        # 与下面的「服务端记录」汇总重复且更难看懂。
        stage = ev.get("stage") or ev.get("kind") or "?"
        detail = {k: v for k, v in ev.items()
                  if k not in ("stage", "kind", "ts", "clientTs", "url", "session")}
        if ev.get("kind"):
            detail = {"kind": ev["kind"], **detail}
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

    # 服务端自己写的记录（kind 而非 stage）没有 session / url，按上面的会话过滤
    # 一条都进不来。而「点了按钮但内容没变」正是要靠它解释的，所以单独汇总。
    _report_server_records(events)

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
        _report_model_anchor(recent)
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