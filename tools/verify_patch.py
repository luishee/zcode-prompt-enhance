"""深度校验补丁：把补丁后的 asar 与原始 asar 逐文件逐字节比对。

为什么值得跑 374MB 的比对：asar 头部里的偏移一旦算错，症状往往是
「某个文件读出垃圾」或「应用启动即崩」，抽样比对可能刚好绕开问题。
这里比对**全部**条目，只有 index.html 与新增的注入脚本允许不同。

用法：
    python tools/verify_patch.py --original app.asar --patched app.asar.patched
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from asar_reader import Asar  # noqa: E402

ALLOWED_DIFF = {"out/renderer/index.html"}


def iter_leaves(node, prefix=""):
    for name, child in node.get("files", {}).items():
        full = f"{prefix}/{name}".lstrip("/")
        if "files" in child:
            yield from iter_leaves(child, full)
        else:
            yield full, child


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--original", required=True)
    parser.add_argument("--patched", required=True)
    parser.add_argument("--inject-rel", default="out/renderer/assets/zcode-enhance.js")
    args = parser.parse_args()

    old = Asar(args.original)
    new = Asar(args.patched)

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
        except Exception as exc:
            print(f"✗ 原始读取失败 {rel}: {exc}")
            failed += 1
            continue
        try:
            b = new.read(rel)
        except Exception as exc:
            print(f"✗ 补丁后读取失败 {rel}: {exc}")
            failed += 1
            continue
        if a != b:
            if rel in ALLOWED_DIFF:
                changed.append(rel)
            else:
                print(f"✗ 非预期差异：{rel}（原 {len(a)} 字节 → 新 {len(b)} 字节）")
                failed += 1

    print(f"比对 {checked:,} 个文件；预期变更 {changed}；非预期差异 {failed}")
    if failed:
        return 1

    # 注入脚本必须可读、且占位符已被替换
    try:
        js = new.read(args.inject_rel)
    except FileNotFoundError:
        print(f"✗ 找不到注入脚本 {args.inject_rel}")
        return 1
    if b"__ZCE_ENDPOINT__" in js:
        print("✗ 注入脚本里的端点占位符没有被替换")
        return 1
    print(f"✓ 注入脚本 {len(js):,} 字节，端点已注入")

    html = new.read("out/renderer/index.html").decode("utf-8", "replace")
    tag = '<script src="./assets/zcode-enhance.js"></script>'
    if tag not in html or html.count(tag) != 1:
        print("✗ index.html 的脚本标签缺失或重复")
        return 1
    print("✓ index.html 恰好包含一个注入脚本标签")

    print("全部校验通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())