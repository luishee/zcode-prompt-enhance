"""深度校验补丁：把补丁后的 asar 与原始 asar 逐文件逐字节比对。

为什么值得跑 374MB 的比对：asar 头部里的偏移一旦算错，症状往往是
「某个文件读出垃圾」或「应用启动即崩」，抽样比对可能刚好绕开问题。
这里比对**全部**条目，只有 index.html 与新增的注入脚本允许不同。

与 patch_zcode.compare_asar 的分工：那边是写完立刻判生死的快速版本
（遇到第一处差异就返回），这里是给人看的全量报告（逐条列差异、校验占位符与标签数量）。
路径常量统一来自 zce_common，避免两边各写一份后悄悄跑偏。

用法：
    python tools/verify_patch.py --original app.asar --patched app.asar.patched
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from asar_reader import Asar, iter_leaves  # noqa: E402
from zce_common import HTML_REL, INJECT_REL, SCRIPT_TAG, force_utf8  # noqa: E402

ALLOWED_DIFF = {HTML_REL}


def main() -> int:
    force_utf8()
    parser = argparse.ArgumentParser()
    parser.add_argument("--original", required=True)
    parser.add_argument("--patched", required=True)
    parser.add_argument("--inject-rel", default=INJECT_REL)
    args = parser.parse_args()
    inject_rel = args.inject_rel.replace("\\", "/")
    allowed = ALLOWED_DIFF | {inject_rel}

    with Asar(args.original) as old, Asar(args.patched) as new:
        old_files = dict(iter_leaves(old.header))
        new_files = dict(iter_leaves(new.header))

        print(f"原始条目 {len(old_files):,} → 补丁后 {len(new_files):,}"
              f"（新增 {len(set(new_files) - set(old_files))}）")

        missing = sorted(set(old_files) - set(new_files))
        if missing:
            print(f"✗ 补丁后丢了 {len(missing)} 个条目：{missing[:5]}")
            return 1

        changed, checked, failed = [], 0, 0
        for rel, meta in old_files.items():
            if "offset" not in meta:  # unpacked / link 条目本体不在 asar 里
                continue
            checked += 1
            try:
                a = old.read(rel)
            except Exception as exc:  # noqa: BLE001
                print(f"✗ 原始读取失败 {rel}: {exc}")
                failed += 1
                continue
            try:
                b = new.read(rel)
            except Exception as exc:  # noqa: BLE001
                print(f"✗ 补丁后读取失败 {rel}: {exc}")
                failed += 1
                continue
            if a != b:
                if rel in allowed:
                    changed.append(rel)
                else:
                    print(f"✗ 非预期差异：{rel}（原 {len(a)} 字节 → 新 {len(b)} 字节）")
                    failed += 1

        print(f"比对 {checked:,} 个文件；预期变更 {changed}；非预期差异 {failed}")
        if failed:
            return 1

        # 注入脚本必须可读、且占位符已被替换。
        # 注意：这段必须在 with 块内读——早先被反缩进到块外（重构残留），
        # 靠 js 变量泄漏到函数作用域才没报错，读起来像是"读完就关了句柄还在用"。
        try:
            js = new.read(inject_rel)
        except (FileNotFoundError, ValueError):
            print(f"✗ 找不到注入脚本 {inject_rel}")
            return 1
        if b"__ZCE_ENDPOINT__" in js or b"__ZCE_TOKEN__" in js:
            print("✗ 注入脚本里的端点/令牌占位符没有被替换")
            return 1

        html = new.read(HTML_REL).decode("utf-8", "replace")
        if SCRIPT_TAG not in html or html.count(SCRIPT_TAG) != 1:
            print("✗ index.html 的脚本标签缺失或重复")
            return 1

        # 打印放在 with 内：虽然 read() 已返回 bytes、关闭句柄后再用也安全，
        # 但读起来像"读完就关了还在用"，与文件顶部批评的写法混淆。
        print(f"✓ 注入脚本 {len(js):,} 字节，端点与令牌已注入")
        print("✓ index.html 恰好包含一个注入脚本标签")

    print("全部校验通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
