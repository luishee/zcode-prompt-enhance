"""asar 写入层的回归测试（patch_zcode.py 里风险最高的那段）。

为什么必须有：偏移算错、JSON 区算错、备份/还原路径算错，症状都是"ZCode 直接起不来"，
而这部分此前只靠"写完再读回"兜底，没有任何自动化判据。

做法：不碰真实安装包，现场合成一个结构相同的小 asar
（16 字节 pickle 前缀 + 对齐的 header JSON + 数据区，条目带 integrity 字段），
再用真实 CLI 跑 apply / 幂等 apply / 刷新 / --out / restore / 非法包。

用法：
    python tests/test_patch_zcode.py
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TOOLS = ROOT / "tools"
TOOL = TOOLS / "patch_zcode.py"

sys.path.insert(0, str(TOOLS))
from asar_reader import Asar, iter_leaves  # noqa: E402
import patch_zcode  # noqa: E402
from zce_common import HTML_REL, INJECT_REL, SCRIPT_TAG  # noqa: E402

FAILED = 0
TOTAL = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILED, TOTAL
    TOTAL += 1
    if not ok:
        FAILED += 1
    print(f"{'✓' if ok else '✗'} {name}{f' — {detail}' if detail else ''}")


# ------------------------------------------------------------------ 构造合成包

def build_asar(path: Path, files: dict[str, bytes], slack: int = 0, integrity: bool = True) -> None:
    """按 asar 的口径写一个最小包。

    头部布局（与 patch_zcode.py 顶部注释一致）：
        prefix[0:4] = 4，prefix[4:8] = P+8，prefix[8:12] = P+4，prefix[12:16] = len(json)
        P（JSON 区）= 对齐后的 JSON + 补零；数据区从 16+P 开始。
    """
    data = bytearray()
    tree: dict = {"files": {}}
    for rel in sorted(files):
        parts = rel.replace("\\", "/").split("/")
        node = tree
        for part in parts[:-1]:
            node = node.setdefault("files", {}).setdefault(part, {"files": {}})
        blob = files[rel]
        entry = {"size": len(blob), "offset": str(len(data))}
        if integrity:
            # 约 120 字节/条，和真实包同量级：free_space 靠删它腾地方
            entry["integrity"] = {
                "algorithm": "SHA256",
                "hash": "0" * 44,
                "blockSize": 4194304,
                "blocks": ["0" * 44],
            }
        node.setdefault("files", {})[parts[-1]] = entry
        data += blob
        data += b"\x00" * ((-len(data)) % 4)

    raw = json.dumps(tree, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    region = len(raw) + slack
    region += (-region) % 4  # 真实包也是 4 字节对齐
    prefix = struct.pack("<IIII", 4, region + 8, region + 4, len(raw))
    path.write_bytes(prefix + raw + b"\x00" * (region - len(raw)) + bytes(data))


def sample_files() -> dict[str, bytes]:
    return {
        "package.json": json.dumps({"name": "zcode", "version": "9.9.9"}).encode(),
        HTML_REL: b"<!doctype html><html><body><div id=\"root\"></div></body></html>",
        "out/renderer/assets/app.js": b"console.log('zcode');\n" * 40,
        "out/renderer/assets/vendor.js": b"/* vendor */\n" * 60,
        "out/main/index.js": b"require('electron');\n" * 20,
    }


def header_region(path: Path) -> tuple[int, int]:
    """返回 (JSON 区长度 P, JSON 真实长度 L)，用来验证"P 不变"这条核心不变量。"""
    with open(path, "rb") as fp:
        _four, h_size, _p_size, json_len = struct.unpack("<IIII", fp.read(16))
    return h_size - 8, json_len


def run_tool(*argv: str, env: dict) -> subprocess.CompletedProcess:
    full = [sys.executable, str(TOOL), *argv]
    return subprocess.run(full, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", env=env, timeout=300)


def sandbox_env(tmp: Path) -> dict:
    """把状态、备份、令牌全部关进临时目录：绝不能碰真实的 patch-state.json / LOCALAPPDATA。"""
    env = dict(os.environ)
    env["ZCE_STATE_FILE"] = str(tmp / "state.json")
    env["LOCALAPPDATA"] = str(tmp)
    env.pop("ZCODE_ASAR", None)
    return env


def read_all(path: Path) -> dict[str, bytes]:
    with Asar(str(path)) as reader:
        return {rel: reader.read(rel) for rel, meta in iter_leaves(reader.header)
                if "offset" in meta}


def read_html(path: Path) -> bytes:
    """必须用 with：Windows 上句柄没关会让临时目录删不掉。"""
    with Asar(str(path)) as reader:
        return reader.read(HTML_REL)


# ------------------------------------------------------------------ 用例

def case_apply(tmp: Path) -> None:
    asar = tmp / "app.asar"
    build_asar(asar, sample_files())
    original = asar.read_bytes()
    region_before, _ = header_region(asar)
    env = sandbox_env(tmp)

    res = run_tool("--asar", str(asar), "apply", env=env)
    check("apply 成功退出", res.returncode == 0, res.stdout.strip().splitlines()[-1] if res.stdout else res.stderr[:120])

    region_after, _ = header_region(asar)
    check("JSON 区长度 P 保持不变（数据区起点不变 ⇒ 旧偏移仍有效）",
          region_after == region_before, f"{region_before} → {region_after}")

    with Asar(str(asar)) as reader:
        html = reader.read(HTML_REL)
        js = reader.read(INJECT_REL)
    check("index.html 打上脚本标签且只出现一次",
          html.count(SCRIPT_TAG.encode()) == 1, f"count={html.count(SCRIPT_TAG.encode())}")
    check("注入脚本已登记且非空", len(js) > 1000, f"{len(js)} 字节")
    check("注入脚本里的占位符已被替换",
          b"__ZCE_ENDPOINT__" not in js and b"__ZCE_TOKEN__" not in js)
    check("注入脚本带访问令牌（浏览器来源才不会被 401）", b"X-ZCE-Token" in js)

    before = {rel: b for rel, b in read_all(_restore_original(tmp, original)).items()}
    after = read_all(asar)
    changed = sorted(rel for rel, blob in before.items() if after.get(rel) != blob)
    check("除 index.html 外，原有文件逐字节未变", changed == [HTML_REL], str(changed))

    state = json.loads((tmp / "state.json").read_text(encoding="utf-8"))
    backup = Path(state.get("backup") or "")
    check("状态文件记录了基线与补丁时间",
          bool(state.get("patchedAt")) and backup.exists(), f"backup={backup.name}")
    check("基线备份与原文件逐字节一致",
          backup.exists() and backup.read_bytes() == original)

    # 覆盖 index.html 条目必然丢掉它原来的 integrity（旧哈希已失效）：
    # 这是"删 integrity"的另一条来源，必须和 free_space 一起被统计（见 removed_integrity）
    with Asar(str(asar)) as reader:
        leaves = dict(iter_leaves(reader.header))
    check("被改写的 index.html 条目不再带 integrity（旧哈希已失效）",
          "integrity" not in leaves[HTML_REL])
    check("其余条目的 integrity 按需保留（不是无脑全删）",
          any("integrity" in meta for rel, meta in leaves.items() if rel != HTML_REL))

    # 幂等：再跑一次不该产生任何字节变化
    digest = asar.read_bytes()
    res2 = run_tool("--asar", str(asar), "apply", env=env)
    check("重复 apply 幂等（不改文件、提示无需操作）",
          res2.returncode == 0 and "无需操作" in res2.stdout and asar.read_bytes() == digest,
          res2.stdout.strip().splitlines()[-1] if res2.stdout else "")

    # 刷新：端点变了 ⇒ 只更新注入脚本，不重复插标签、不新建基线
    res3 = run_tool("--asar", str(asar), "--endpoint", "http://127.0.0.1:9999", "apply", env=env)
    check("已打补丁时走刷新路径", res3.returncode == 0 and "刷新注入脚本" in res3.stdout,
          res3.stdout.strip().splitlines()[0][:80] if res3.stdout else res3.stderr[:80])
    with Asar(str(asar)) as reader:
        html3 = reader.read(HTML_REL)
        js3 = reader.read(INJECT_REL)
    check("刷新后标签仍只有一个", html3.count(SCRIPT_TAG.encode()) == 1)
    check("刷新后端点已更新", b"127.0.0.1:9999" in js3)
    check("刷新后 asar 变大（新副本追加在末尾，旧字节保留）", asar.stat().st_size > len(digest),
          f"{len(digest)} → {asar.stat().st_size}")


def _restore_original(tmp: Path, original: bytes) -> Path:
    """把原始字节写成一个临时 asar，便于和补丁后的包逐文件比对。"""
    path = tmp / "original.asar"
    if not path.exists():
        path.write_bytes(original)
    return path


def case_out_mode(tmp: Path) -> None:
    asar = tmp / "app.asar"
    build_asar(asar, sample_files())
    out = tmp / "out.asar"
    env = sandbox_env(tmp)

    res = run_tool("--asar", str(asar), "--out", str(out), "apply", env=env)
    check("--out 模式成功", res.returncode == 0 and out.exists(), res.stderr[:120])
    check("--out 产物已注入", SCRIPT_TAG.encode() in read_html(out))
    check("--out 不写状态文件", not (tmp / "state.json").exists())
    check("--out 不建备份", not (tmp / "zcode-prompt-enhance" / "backups").exists())
    check("--out 不生成访问令牌（演练无副作用）",
          not (tmp / "zcode-prompt-enhance" / "token").exists())
    check("--out 明确提示产物只供检查", "只供检查" in res.stdout)
    check("--out 不动原文件", SCRIPT_TAG.encode() not in read_html(asar))


def case_restore(tmp: Path) -> None:
    asar = tmp / "app.asar"
    build_asar(asar, sample_files())
    original = asar.read_bytes()
    env = sandbox_env(tmp)

    check("restore 前置：apply 成功", run_tool("--asar", str(asar), "apply", env=env).returncode == 0)
    res = run_tool("--asar", str(asar), "restore", env=env)
    check("restore 成功退出", res.returncode == 0, res.stdout.strip().splitlines()[-1] if res.stdout else "")
    check("restore 后与原文件逐字节一致", asar.read_bytes() == original)
    check("restore 做了哈希校验", "校验通过" in res.stdout, res.stdout.strip()[-80:])
    state = json.loads((tmp / "state.json").read_text(encoding="utf-8"))
    check("restore 后状态不再声称已打补丁", "patchedAt" not in state and "patchedSha256" not in state,
          json.dumps(state)[:120])


def case_baseline_missing(tmp: Path) -> None:
    """基线被删 + 刷新时要动 integrity → 必须拦下来，文件一字节不能改。

    这是本机真实出现过的最危险组合（用户删了 374MB 基线，还剩一层注入）。
    """
    asar = tmp / "app.asar"
    files = sample_files()
    files[HTML_REL] = (b'<!doctype html><html><body><div id="root"></div>'
                       + SCRIPT_TAG.encode() + b"</body></html>")
    files[INJECT_REL] = b"// old inject\n" + b"x" * 2000
    # integrity=True：两个被覆盖的条目都带着旧哈希，刷新必然要丢掉它们
    build_asar(asar, files)
    before = asar.read_bytes()
    env = sandbox_env(tmp)

    res = run_tool("--asar", str(asar), "apply", env=env)
    check("无基线 + 要动 integrity → 拒绝写入", res.returncode == 1,
          res.stdout.strip().splitlines()[0][:80] if res.stdout else res.stderr[:80])
    check("拒绝时给出手动放行方式", "--force" in res.stdout)
    check("拒绝时文件一字节未改", asar.read_bytes() == before)
    check("拒绝时不留下新备份/状态", not (tmp / "state.json").exists()
          and not (tmp / "zcode-prompt-enhance" / "backups").exists())

    res2 = run_tool("--asar", str(asar), "--force", "apply", env=env)
    check("加 --force 后放行并写入", res2.returncode == 0 and asar.read_bytes() != before,
          res2.stdout.strip().splitlines()[-1][:80] if res2.stdout else res2.stderr[:80])
    check("放行后仍是刷新语义（标签只有一个）",
          read_html(asar).count(SCRIPT_TAG.encode()) == 1)


def case_invalid(tmp: Path) -> None:
    bogus = tmp / "bogus.asar"
    bogus.write_bytes(b"not an asar at all" * 1000)
    before = bogus.read_bytes()
    env = sandbox_env(tmp)
    for cmd in ("status", "apply"):
        res = run_tool("--asar", str(bogus), cmd, env=env)
        check(f"非法包 {cmd} 失败但不改文件",
              res.returncode == 1 and "不是可识别的 asar" in res.stdout and bogus.read_bytes() == before,
              res.stdout.strip().splitlines()[0][:70] if res.stdout else "")

    missing = tmp / "nope.asar"
    res = run_tool("--asar", str(missing), "status", env=env)
    check("路径不存在时报错退出", res.returncode == 1 and "找不到" in res.stdout)


def case_units(tmp: Path) -> None:
    # 保护逻辑：只有"删了 integrity + 没有基线 + 没 --force"才拦
    check("integrity 保护：有基线放行", patch_zcode.integrity_guard(3, True, False) is None)
    check("integrity 保护：没删字段放行", patch_zcode.integrity_guard(0, False, False) is None)
    check("integrity 保护：--force 放行", patch_zcode.integrity_guard(3, False, True) is None)
    blocked = patch_zcode.integrity_guard(3, False, False)
    check("integrity 保护：无基线且要删字段时拦下",
          isinstance(blocked, str) and "--force" in blocked and "integrity" in blocked)

    # free_space 直接测：塞几个新条目，看它删 integrity 直到放得下
    asar = tmp / "tight.asar"
    build_asar(asar, sample_files(), slack=0)
    packer = patch_zcode.AsarPacker(asar)
    try:
        integrity_before = sum(1 for _rel, meta in iter_leaves(packer.header) if "integrity" in meta)
        for i in range(4):
            packer.add_entry(f"out/renderer/assets/extra{i}.js", 16, 4096 + i)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            removed = packer.free_space()
        integrity_after = sum(1 for _rel, meta in iter_leaves(packer.header) if "integrity" in meta)
        check("free_space 会删 integrity 腾地方", removed >= 1, f"removed={removed}")
        check("free_space 之后 JSON 能塞进原来的区",
              len(packer.serialize()) <= packer.region,
              f"{len(packer.serialize())} <= {packer.region}")
        check("free_space 只删到够用为止（不是无脑全删）",
              removed == integrity_before - integrity_after,
              f"{integrity_before} → {integrity_after}，删了 {removed}")
    finally:
        packer.close()

    # 顶不住的极端情况：宁可报错也不能写出半截包
    asar2 = tmp / "toosmall.asar"
    build_asar(asar2, sample_files(), slack=0, integrity=False)
    packer2 = patch_zcode.AsarPacker(asar2)
    try:
        for i in range(20):
            packer2.add_entry(f"out/renderer/assets/x{i}.js", 16, 4096 + i)
        with contextlib.redirect_stdout(io.StringIO()):
            try:
                packer2.free_space()
                raised = False
            except RuntimeError as exc:
                raised = "JSON 区放不下" in str(exc)
        check("空间实在不够时抛 RuntimeError（不静默截断）", raised)
    finally:
        packer2.close()

    # write_in_place 的临时文件写入失败必须转成 RuntimeError（带可操作提示），
    # 而不是漏出裸 OSError traceback —— cmd_apply 只捕 RuntimeError，
    # 否则"Program Files 无写权限"这个高频场景会退化成看不懂的栈。
    missing = tmp / "no-such-dir" / "app.asar"
    outcome = "no-raise"
    try:
        patch_zcode.write_in_place(missing, b"data")
    except RuntimeError:
        outcome = "RuntimeError"
    except OSError as exc:  # noqa: BLE001
        outcome = f"OSError:{type(exc).__name__}"
    check("write_in_place 写临时文件失败 → RuntimeError（不裸抛 OSError）",
          outcome == "RuntimeError", outcome)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="zce-patch-test-") as tmpdir:
        base = Path(tmpdir)
        for i, case in enumerate((case_apply, case_out_mode, case_restore,
                                  case_baseline_missing, case_invalid, case_units)):
            work = base / f"case{i}"
            work.mkdir(parents=True, exist_ok=True)
            print(f"\n--- {case.__name__} ---")
            case(work)

    print(f"\n{'全部通过' if FAILED == 0 else f'失败 {FAILED} 项'} / 共 {TOTAL} 项")
    return 0 if FAILED == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
