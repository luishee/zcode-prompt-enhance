"""check_beacon 的信标解析契约：只认插件格式，忽略 Python 时代的旧格式。

为什么需要：日志里同时存在两种格式——
  - 插件（MCP server）：单行纯 JSON，以 `{` 开头；
  - 已退役的 Python 服务："<ISO 时间戳> {json}"，JSON 前带时间戳。
早先两种都解析，导致几天前的旧记录混进「本次启动」的统计，展示区也被旧内容占满
（实测 21 行旧记录）。这里把「只读插件格式 + 旧格式只计数」钉住，
并验证 `purge_legacy()`（`--purge-legacy`）只删旧格式、保留 CRLF/损坏行/空行且幂等。

用法：
    python tests/test_check_beacon.py
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
from pathlib import Path
from contextlib import redirect_stdout

HERE = Path(__file__).resolve().parent
TOOLS = HERE.parent / "tools"
sys.path.insert(0, str(TOOLS))
import check_beacon  # noqa: E402

FAILED = 0
TOTAL = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILED, TOTAL
    TOTAL += 1
    if not ok:
        FAILED += 1
    print(f"{'✓' if ok else '✗'} {name}{f' — {detail}' if detail else ''}")


def read(log: Path):
    check_beacon.LOG_PATH = log
    check_beacon._CACHE.clear()
    return check_beacon.read_events()


def main() -> int:
    print(f"check_beacon 信标解析测试：{TOOLS / 'check_beacon.py'}")

    with tempfile.TemporaryDirectory(prefix="zce-beacon-test-") as td:
        log = Path(td) / "beacon.log"

        # 1. 只有旧格式：事件为空、计数正确、不抛异常
        log.write_text(
            '2026-11-10T09:14:52.885Z {"stage":"composer-seen","url":"file:///x"}\n'
            '2026-11-10T09:14:52.960Z {"stage":"attached","url":"file:///x"}\n',
            encoding="utf-8",
        )
        events, legacy = read(log)
        check("旧格式行全部被忽略", events == [] and legacy == 2, f"events={events} legacy={legacy}")

        # 2. 混合：只留插件格式，顺序不变
        log.write_text(
            '2026-11-10T09:14:52.885Z {"stage":"boot","url":"file:///old"}\n'
            '{"stage":"boot","session":"s1","ts":"2026-11-11T06:31:26.901Z"}\n'
            '{"stage":"attached","session":"s1","ts":"2026-11-11T06:31:26.932Z"}\n',
            encoding="utf-8",
        )
        events, legacy = read(log)
        check("混合日志只保留插件格式且顺序不变",
              [e.get("stage") for e in events] == ["boot", "attached"] and legacy == 1,
              f"stages={[e.get('stage') for e in events]} legacy={legacy}")

        # 3. 插件格式但坏了：标成 unparsable，不静默丢弃
        log.write_text('{"stage":"boot"\n', encoding="utf-8")
        events, legacy = read(log)
        check("损坏的插件格式行 → unparsable",
              len(events) == 1 and events[0].get("stage") == "unparsable" and legacy == 0,
              json.dumps(events, ensure_ascii=False)[:120])

        # 4. 文件开头的 BOM 不影响识别
        log.write_text('\ufeff{"stage":"boot","session":"s2"}\n', encoding="utf-8")
        events, legacy = read(log)
        check("带 BOM 的插件行仍能解析",
              len(events) == 1 and events[0].get("stage") == "boot" and legacy == 0,
              json.dumps(events, ensure_ascii=False)[:120])

        # 5. 空行不算旧格式
        log.write_text('\n  \n{"stage":"boot","session":"s3"}\n\n', encoding="utf-8")
        events, legacy = read(log)
        check("空行不计入旧格式", len(events) == 1 and legacy == 0, f"legacy={legacy}")

        # 6. 日志不存在：返回空、不抛异常
        check_beacon.LOG_PATH = Path(td) / "nope.log"
        check_beacon._CACHE.clear()
        events, legacy = check_beacon.read_events()
        check("日志不存在 → ([], 0)", events == [] and legacy == 0, f"{events} {legacy}")

        # 7. 记忆化按 (size, mtime) 失效
        log.write_text('{"stage":"boot","session":"s4"}\n', encoding="utf-8")
        e1, _ = read(log)
        log.write_text(
            '{"stage":"boot","session":"s4"}\n{"stage":"attached","session":"s4"}\n',
            encoding="utf-8",
        )
        e2, _ = read(log)
        check("日志内容变化后缓存失效", len(e1) == 1 and len(e2) == 2, f"{len(e1)} → {len(e2)}")

        # 8. --purge-legacy：物理删除旧格式行，只留插件格式
        log.write_text(
            '2026-11-10T09:14:52.885Z {"stage":"boot","url":"file:///old"}\n'
            '{"stage":"boot","session":"s5"}\n'
            '2026-11-10T09:14:52.960Z {"stage":"attached","url":"file:///old"}\n',
            encoding="utf-8",
        )
        check_beacon.LOG_PATH = log
        check_beacon._CACHE.clear()
        removed, kept = check_beacon.purge_legacy()
        check("purge 删除旧格式、保留插件格式", (removed, kept) == (2, 1), f"removed={removed} kept={kept}")
        remain = log.read_text(encoding="utf-8")
        check("purge 后文件只剩插件格式",
              remain.strip() == '{"stage":"boot","session":"s5"}', repr(remain))
        events, legacy = read(log)
        check("purge 后解析无旧格式计数",
              legacy == 0 and len(events) == 1, f"legacy={legacy} events={len(events)}")

        removed2, kept2 = check_beacon.purge_legacy()
        check("purge 幂等（再跑一次不删任何东西）",
              (removed2, kept2) == (0, 1), f"removed={removed2} kept={kept2}")

        # 9. purge 只删旧格式：CRLF / 损坏的插件行 / 空行都原样保留
        log.write_bytes(
            b'2026-11-10T00:00:00Z {"stage":"boot"}\r\n'
            b'{"stage":"boot"\r\n'
            b'\r\n'
            b'{"stage":"attached","session":"s6"}\r\n'
        )
        check_beacon._CACHE.clear()
        removed, kept = check_beacon.purge_legacy()
        after = log.read_bytes()
        check("purge 保留 CRLF/损坏行/空行，只删旧格式",
              removed == 1 and kept == 3
              and after.startswith(b'{"stage":"boot"\r\n')
              and b'2026-11-10' not in after
              and after.count(b"\r\n") == 3,
              f"removed={removed} kept={kept} after={after!r}")

        # 10. 日志不存在
        check_beacon.LOG_PATH = Path(td) / "missing.log"
        check_beacon._CACHE.clear()
        check("purge 遇到不存在的日志 → (0, 0) 且不抛异常", check_beacon.purge_legacy() == (0, 0))

        # 11. 模型锚点判定：命中 / 属性缺失 / 值为空，三种结论必须互不相同。
        # 这三条对应「按钮能挂上但换模型不跟随」——只在信标里才看得见的问题。
        def anchor_lines(events):
            buf = io.StringIO()
            with redirect_stdout(buf):
                check_beacon._report_model_anchor(events)
            return buf.getvalue()

        hit = anchor_lines([{"stage": "composer-seen", "hasModelValue": True, "modelFromDom": "deepseek-flash"}])
        check("锚点命中 → 报出模型名", "✓" in hit and "deepseek-flash" in hit, hit.strip()[:80])

        missing = anchor_lines([{"stage": "composer-seen", "hasModelValue": False, "hasModelLabel": False}])
        check("锚点缺失 → 报 ✗ 并指向 SEL.modelValue",
              "✗" in missing and "SEL.modelValue" in missing, missing.strip()[:80])
        check("锚点缺失的结论与命中不同", missing != hit)

        empty = anchor_lines([{"stage": "composer-seen", "hasModelValue": True, "modelFromDom": ""}])
        check("锚点存在但值为空 → 指向取值解析",
              "✗" in empty and "取值解析" in empty, empty.strip()[:80])

        check("没有 composer-seen 时不输出任何结论",
              anchor_lines([{"stage": "boot"}]) == "")

    print(f"\n{TOTAL - FAILED}/{TOTAL} 通过")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
