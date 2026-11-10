"""给 ZCode 的 app.asar 打补丁：把「增强提示词」按钮注入渲染层。

设计（2026-11-10 实测确认）：
- asar 头部 = 16 字节 pickle 前缀 + 对齐后的 header JSON，之后紧接着文件数据区。
  实测关系：data_start = 16 + P；prefix[4:8] = P + 8；prefix[8:12] = P + 4；
  prefix[12:16] = L（JSON 真实长度）；P = ceil(L/4)*4。
- 关键技巧：**保持 P 与原来完全一致**，则 data_start 不变、所有已有文件偏移继续有效。
  于是只需：(1) 在固定长度的 JSON 区里写入新 JSON（不足处补 0）；
  (2) 把新文件追加到整个文件末尾，并在 JSON 里登记它们的偏移。
  这样避免了「重排 374MB 数据区」这种高风险操作。
- JSON 区只有 3 字节余量，所以要删掉若干文件的 integrity 字段腾地方。
  ZCode 的 EnableEmbeddedAsarIntegrityValidation fuse 是 Disabled（实测），
  integrity 不参与校验，删掉安全。

对比「全量解包再重打包」：那个方案会重写 374MB 且要正确处理 unpacked 文件，
出错就直接起不来；本方案其余字节原样复制，风险面小得多。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from asar_reader import Asar  # noqa: E402

# ZCode 装在别处时用环境变量 ZCODE_ASAR 覆盖，或命令行 --asar 指定
DEFAULT_ASAR = Path(os.environ.get("ZCODE_ASAR") or r"D:\Program Files\ZCode\resources\app.asar")
DEFAULT_ENDPOINT = "http://127.0.0.1:8770"

# 脚本必须放在 assets/ 下：ZCode 的渲染层通过自定义协议提供文件，路由规则是
#   "/" 或 "/index.html" -> rendererDir/index.html
#   "/assets/*"          -> rendererDir/assets/*
#   其余路径            -> 404
# 早先放在 rendererDir 根下会被路由成 /zcode-enhance.js 直接 404，按钮根本不出现。
INJECT_REL = "out/renderer/assets/zcode-enhance.js"
HTML_REL = "out/renderer/index.html"
# 相对 index.html（同目录）→ ./assets/...；协议层会把 /assets/x.js 映射到 assets/x.js
SCRIPT_TAG = '<script src="./assets/zcode-enhance.js"></script>'
STATE_NAME = "patch-state.json"

PROJECT_DIR = Path(__file__).resolve().parent.parent


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fp:
        for chunk in iter(lambda: fp.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class AsarPacker:
    """在保持头部 JSON 区长度不变的前提下改写 asar。"""

    def __init__(self, path: Path):
        self.path = path
        self.reader = Asar(str(path))
        with open(path, "rb") as fp:
            self.prefix = fp.read(16)
        (_four, self.h_size, self.p_size, self.json_len) = struct.unpack("<IIII", self.prefix)
        # P：JSON 区总长度（含补零）
        self.region = self.h_size - 8
        self.data_start = 16 + self.region
        self.file_size = path.stat().st_size
        self.header = self.reader.header

    def entry(self, rel: str) -> dict:
        node = self.header
        for part in rel.replace("\\", "/").split("/"):
            node = node["files"][part]
        return node

    def add_entry(self, rel: str, size: int, offset: int) -> None:
        node = self.header
        parts = rel.replace("\\", "/").split("/")
        for part in parts[:-1]:
            node = node["files"].setdefault(part, {"files": {}})
        node["files"][parts[-1]] = {"size": size, "offset": str(offset)}

    def _iter_entries(self):
        """遍历所有叶子文件条目（含 unpacked / link）。"""
        stack = [self.header]
        while stack:
            cur = stack.pop()
            for child in cur.get("files", {}).values():
                if "files" in child:
                    stack.append(child)
                else:
                    yield child

    def serialize(self) -> bytes:
        return json.dumps(self.header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    def free_space(self) -> None:
        """删除 integrity 字段直到 JSON 能塞进原来的 JSON 区。

        余量只有 3 字节，新增一个文件条目必然超；integrity 每条约 250 字节，
        而它在本机 fuse 关闭的前提下不参与校验。
        """
        raw = self.serialize()
        if len(raw) <= self.region:
            return
        removed = 0
        for entry in self._iter_entries():
            if "integrity" in entry:
                del entry["integrity"]
                removed += 1
                raw = self.serialize()
                if len(raw) <= self.region:
                    break
        if len(raw) > self.region:
            raise RuntimeError(f"JSON 区放不下：需要 {len(raw)} 字节，可用 {self.region} 字节")
        print(f"  为腾出空间删除了 {removed} 个文件的 integrity 字段")

    def build_blob(self, new_html: bytes, new_js: bytes) -> bytes:
        if SCRIPT_TAG.encode() not in new_html:
            raise RuntimeError("注入后的 index.html 找不到脚本标签，补丁逻辑有误")

        # 新文件追加到原文件末尾，偏移相对 data_start
        append_base = self.file_size - self.data_start
        self.add_entry(HTML_REL, len(new_html), append_base)
        self.add_entry(INJECT_REL, len(new_js), append_base + len(new_html))

        # 已有的 index.html 条目被覆盖成新偏移，原数据区中的旧副本成了死区（不影响正确性）
        self.free_space()
        raw = self.serialize()
        assert len(raw) <= self.region, "JSON 超长"
        # 补 0 对齐：读取方按 prefix[12:16] 给出的真实长度解析 JSON，补位字节不参与解析
        json_region = raw + b"\x00" * (self.region - len(raw))

        prefix = struct.pack(
            "<IIII",
            4,
            self.region + 8,
            self.region + 4,
            len(raw),
        )

        with open(self.path, "rb") as fp:
            fp.seek(self.data_start)
            data = fp.read()
        return prefix + json_region + data + new_html + new_js


def build_new_html(original: bytes) -> bytes:
    html = original.decode("utf-8")
    if SCRIPT_TAG in html:
        # 幂等：重复打补丁不会插入第二个标签
        return original
    marker = "</body>"
    if marker not in html:
        raise RuntimeError("index.html 里找不到 </body>，无法注入")
    return html.replace(marker, f"  {SCRIPT_TAG}\n{marker}", 1).encode("utf-8")


def load_inject_js(endpoint: str) -> bytes:
    source = (PROJECT_DIR / "inject" / "zcode-enhance.js").read_text(encoding="utf-8")
    if "__ZCE_ENDPOINT__" not in source:
        raise RuntimeError("注入脚本缺少 __ZCE_ENDPOINT__ 占位符")
    return source.replace("__ZCE_ENDPOINT__", endpoint).encode("utf-8")


def state_path() -> Path:
    return PROJECT_DIR / STATE_NAME


# 备份刻意放在安装目录之外：ZCode 的升级安装器会整目录替换 resources/，
# 备份若留在那里会被一起删掉，升级后就再也回滚不了（2026-11-10 修正）。
BACKUP_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "zcode-prompt-enhance" / "backups"


def asar_version(reader: Asar) -> str:
    try:
        pkg = json.loads(reader.read("package.json").decode("utf-8"))
        return str(pkg.get("version") or "unknown")
    except Exception:
        return "unknown"


def default_backup_path(version: str, digest: str) -> Path:
    return BACKUP_DIR / f"app.asar.{version}.{digest[:8]}.orig"


def prune_backups(keep: Path, keep_extra: int = 1) -> list[str]:
    """只保留当前基线 + 最近 1 份（每份 374MB，不清理会随升级一直涨）。

    当前基线永不删除，否则升级后就没法回滚了。
    """
    removed: list[str] = []
    try:
        others = sorted(
            (p for p in BACKUP_DIR.glob("app.asar.*.orig") if p.resolve() != keep.resolve()),
            key=lambda p: p.stat().st_mtime,
        )
    except OSError:
        return removed
    for old in others[: max(0, len(others) - keep_extra)]:
        try:
            old.unlink()
            removed.append(old.name)
        except OSError:
            pass
    return removed


def write_in_place(path: Path, blob: bytes) -> str:
    """优先原子替换；Program Files 下实测 os.replace 会 PermissionError
    （ZCode 运行时尤其容易），回落为就地覆写。"""
    tmp = path.with_name(path.name + ".zce-tmp")
    try:
        tmp.write_bytes(blob)
        os.replace(tmp, path)
        return "原子替换"
    except (PermissionError, OSError):
        tmp.unlink(missing_ok=True)
    try:
        os.chmod(path, stat.S_IWRITE)
    except OSError:
        pass
    with open(path, "r+b") as fp:
        fp.seek(0)
        fp.truncate()
        fp.write(blob)
    return "就地覆写"


def compare_asar(backup: Path, patched: Path) -> tuple[bool, str]:
    """与基线逐字节比对：只允许 index.html 变化 + 新增注入脚本。"""
    from verify_patch import iter_leaves

    old = Asar(str(backup))
    new = Asar(str(patched))
    old_files = dict(iter_leaves(old.header))
    new_files = dict(iter_leaves(new.header))

    missing = set(old_files) - set(new_files)
    if missing:
        return False, f"补丁后丢了 {len(missing)} 个条目，例如 {sorted(missing)[:3]}"

    checked = 0
    for rel, meta in old_files.items():
        if "offset" not in meta:
            continue
        checked += 1
        try:
            if old.read(rel) != new.read(rel) and rel != HTML_REL:
                return False, f"非预期差异：{rel}"
        except Exception as exc:  # noqa: BLE001
            return False, f"读取失败 {rel}: {exc}"

    if INJECT_REL not in new_files:
        return False, "注入脚本未登记进头部"
    return True, f"比对 {checked:,} 个文件，非预期差异 0"


def probe_official_feature(reader: Asar) -> str | None:
    """探测官方是否已实现增强提示词（包里已预留 chat.promptEnhance.* 文案）。

    命中即说明 UI 开始接这些文案了，可以提示退役注入层。
    注意排除我们自己的注入脚本——它的注释里就写着 chat.promptEnhance.*。
    """
    needle = b"chat.promptEnhance."
    try:
        candidates = reader.find(".js", "out/renderer")
    except FileNotFoundError:
        return None
    for rel in candidates:
        if "IntlProvider" in rel or rel == INJECT_REL:
            continue
        try:
            if needle in reader.read(rel):
                return rel
        except Exception:
            continue
    return None


def read_state() -> dict:
    p = state_path()
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}


def cmd_status(args) -> int:
    asar = Path(args.asar)
    if not asar.exists():
        print(f"找不到 {asar}")
        return 1
    packer = AsarPacker(asar)
    st = read_state()
    print(f"asar        : {asar}")
    print(f"大小        : {packer.file_size:,} 字节")
    print(f"JSON 区     : {packer.region:,} 字节（余量 {packer.region - packer.json_len}）")
    try:
        html = packer.reader.read(HTML_REL)
        patched = SCRIPT_TAG.encode() in html
    except Exception:
        patched = False
    print(f"当前状态    : {'已打补丁' if patched else '原始'}")
    if st:
        # backup 可能是 null：基线被用户主动删掉过（patch-state.json 里有 backupDeletedAt）。
        # 早先这里直接 Path(st.get('backup',''))，遇到 None 会抛 TypeError 把 status 整个打崩。
        raw_backup = st.get("backup")
        if raw_backup:
            print(f"备份        : {raw_backup}（存在={Path(raw_backup).exists()}）")
        else:
            print("备份        : 已被删除（无回滚基线）")
            if st.get("backupDeletedAt"):
                print(f"              删除于 {st['backupDeletedAt']}——restore 不可用，")
                print("              补救途径：修复安装 ZCode 会重装 resources/，等效回到原始状态")
        print(f"补丁时间    : {st.get('patchedAt')}")
    return 0


def open_packer(asar: Path):
    """构造 AsarPacker，把「不是合法 asar」变成可读提示。

    升级后最需要这条：若 ZCode 改了打包格式，AsarPacker 会在解析头部 JSON 时抛异常。
    实测（2026-11-10，对非 asar 文件）异常发生在任何写入之前、文件一字节未改——是安全的，
    但原始 traceback 对使用者毫无指引，所以翻译成可操作的提示。
    """
    try:
        return AsarPacker(asar)
    except (json.JSONDecodeError, UnicodeDecodeError, struct.error, KeyError) as exc:
        print(f"✗ {asar} 不是可识别的 asar 包（{type(exc).__name__}: {exc}）")
        print("  未做任何修改——解析失败发生在写入之前。")
        print("  最可能的原因：ZCode 升级后改了打包格式。")
        print("  此时「保持头部 JSON 区长度不变」的方案不再适用，需改用完整解包→注入→重打包。")
        print("  也请顺便确认路径是否指到了正确的 app.asar。")
        return None


def cmd_apply(args) -> int:
    asar = Path(args.asar)
    if not asar.exists():
        print(f"找不到 {asar}")
        return 1

    packer = open_packer(asar)
    if packer is None:
        return 1
    original_html = packer.reader.read(HTML_REL)
    if SCRIPT_TAG.encode() in original_html:
        print("已经打过补丁，无需重复操作（如需更新脚本请先 restore 再 apply）")
        return 0

    original_hash = sha256_file(asar)
    version = asar_version(packer.reader)

    # 只有「就地替换」才需要备份和状态文件；--out / --dry-run 属于演练，
    # 不该写状态（否则 status 会误报已打补丁），也不该白拷 374MB。
    out = Path(args.out) if args.out else asar
    in_place = args.out is None and not args.dry_run

    backup = Path(args.backup) if args.backup else default_backup_path(version, original_hash)
    if in_place and not backup.exists():
        backup.parent.mkdir(parents=True, exist_ok=True)
        print(f"备份原文件 -> {backup}")
        shutil.copy2(asar, backup)
        for old in prune_backups(backup):
            print(f"（清理旧备份 {old}）")
    elif in_place:
        print(f"备份已存在，跳过 -> {backup}")

    new_html = build_new_html(original_html)
    new_js = load_inject_js(args.endpoint)
    blob = packer.build_blob(new_html, new_js)

    if args.dry_run:
        out = Path(str(out) + ".dryrun")
        print(f"[dry-run] 写出到 {out}，不覆盖原文件")

    out.parent.mkdir(parents=True, exist_ok=True)
    if in_place:
        how = write_in_place(asar, blob)
        print(f"写入        : 成功（{how}）")
    else:
        out.write_bytes(blob)
        print(f"写入        : 成功（{out}）")

    print(f"补丁完成：{out}（{len(blob):,} 字节，原 {original_hash[:12]}…）")

    # 写完立刻自检：只允许 index.html 变化 + 新增注入脚本；不通过就回滚，
    # 绝不留一个「启动不了」的半成品在安装目录里。
    ok, msg = compare_asar(backup, asar) if in_place else (True, "（演练模式跳过校验）")
    print(f"结构校验: {'✓ ' if ok else '✗ '}{msg}")
    if not ok:
        if in_place:
            print("→ 校验未通过，自动回滚")
            shutil.copy2(backup, asar)
            print(f"✓ 已还原：{asar} <- {backup}")
        return 1

    if in_place:
        state_path().write_text(json.dumps({
            "asar": str(asar),
            "backup": str(backup),
            "version": version,
            "originalSha256": original_hash,
            "patchedSha256": sha256_file(out),
            "patchedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
            "endpoint": args.endpoint,
            "injectRel": INJECT_REL,
            "scriptTag": SCRIPT_TAG,
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        hit = probe_official_feature(Asar(str(asar)))
        if hit:
            print(f"官方探测: ⚠ {hit} 已引用 chat.promptEnhance.*，官方可能已实现，"
                  f"建议确认后用 restore 退役注入层")
        print("提示：ZCode 需完全退出后重新启动，补丁才会生效。")
    return 0


def cmd_restore(args) -> int:
    asar = Path(args.asar)
    st = read_state()
    if args.backup:
        backup = Path(args.backup)
    elif st.get("backup"):
        backup = Path(st["backup"])
    else:
        # 基线被主动删除过：别去猜 app.asar.zce-bak，直接说清楚没有退路与补救办法
        print("✗ 没有回滚基线（patch-state.json 里 backup 为空）")
        if st.get("backupDeletedAt"):
            print(f"  基线删除于 {st['backupDeletedAt']}")
        print("  补救途径：修复安装 / 重装 ZCode 会重装 resources/，等效回到原始状态；")
        print("  或等下次 ZCode 升级后执行 apply —— 那时会自动建立新的基线。")
        return 1

    if not backup.exists():
        print(f"找不到备份 {backup}，无法还原")
        return 1
    shutil.copy2(backup, asar)
    print(f"已还原：{asar} <- {backup}")
    return 0


def cmd_verify(args) -> int:
    """独立校验：用原始 reader 复读，并对抽样文件与备份逐字节比对。"""
    asar = Path(args.asar)
    packer = AsarPacker(asar)
    ok = True

    html = packer.reader.read(HTML_REL)
    if SCRIPT_TAG.encode() in html:
        print("✓ index.html 含注入脚本标签")
    else:
        print("✗ index.html 缺少注入脚本标签")
        ok = False

    try:
        js = packer.reader.read(INJECT_REL)
        print(f"✓ 注入脚本可读出（{len(js):,} 字节）")
    except FileNotFoundError:
        print("✗ 注入脚本读不出")
        ok = False

    # 备份位置只认状态文件/显式参数。早先这里硬编码回退到 <asar>.zce-bak——
    # 那是「备份放安装目录内」的旧方案遗留，现在的备份一律在 LOCALAPPDATA，
    # 保留这个回退只会让人以为「找不到备份」是正常现象。
    state = read_state()
    if args.backup:
        backup = Path(args.backup)
    elif state.get("backup"):
        backup = Path(state["backup"])
    else:
        backup = None

    if backup and backup.exists():
        old = Asar(str(backup))
        mismatched = 0
        checked = 0
        for rel in old.find(".js", "out/renderer")[:20]:
            checked += 1
            try:
                if old.read(rel) != packer.reader.read(rel):
                    mismatched += 1
                    print(f"✗ 内容不一致：{rel}")
            except Exception as exc:
                mismatched += 1
                print(f"✗ 读取失败：{rel} {exc}")
        print(f"{'✓' if mismatched == 0 else '✗'} 抽样比对 {checked} 个渲染层文件，不一致 {mismatched}")
        ok = ok and mismatched == 0
    else:
        print("（没有可用基线备份，跳过抽样比对——补齐基线需重新 apply 或等下次升级）")

    return 0 if ok else 1


def _force_utf8() -> None:
    """统一按 UTF-8 输出。

    实测：Windows 控制台代码页是 GBK，Python 默认按 GBK 写 stdout，
    中文提示会变成「褰撳墠鐘舵€�」这种乱码。直接改流编码，不依赖调用方先 chcp 65001。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError, OSError):
            pass


def main() -> int:
    _force_utf8()
    parser = argparse.ArgumentParser(description="ZCode 增强提示词注入工具")
    parser.add_argument("--asar", default=str(DEFAULT_ASAR), help="app.asar 路径")
    parser.add_argument("--backup", default=None,
                        help=r"备份路径（默认 %%LOCALAPPDATA%%\zcode-prompt-enhance\backups）")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help="本地增强服务地址")
    parser.add_argument("--out", default=None, help="写到别处而非就地替换（用于验证）")
    parser.add_argument("--dry-run", action="store_true", help="只生成不覆盖")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("apply")
    sub.add_parser("restore")
    sub.add_parser("verify")
    args = parser.parse_args()

    return {"status": cmd_status, "apply": cmd_apply,
            "restore": cmd_restore, "verify": cmd_verify}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())