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
import secrets
import shutil
import stat
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from asar_reader import Asar, iter_leaves  # noqa: E402
from zce_common import (  # noqa: E402
    DEFAULT_ENDPOINT, HTML_REL, INJECT_REL, PROJECT_DIR, RENDERER_REL, SCRIPT_TAG, force_utf8,
)

STATE_NAME = "patch-state.json"

# ZCode 装在别处时用环境变量 ZCODE_ASAR 覆盖，或命令行 --asar 指定；
# 都没给时再看状态文件里上次实际打过的路径（见 resolve_asar）。
DEFAULT_ASAR = Path(os.environ.get("ZCODE_ASAR") or r"D:\Program Files\ZCode\resources\app.asar")


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
        # 本次 build_blob 删掉了多少 integrity 条目（0 = 没动过）。写盘前据此判断风险。
        self.removed_integrity = 0

        # 头部自检：这几条关系不成立就说明这不是我们认识的 asar。
        # 不做检查的话，一段垃圾前缀会算出离谱的 region/data_start，
        # 然后照样写出去 —— 得到一个「能覆盖但读不出来」的 app.asar。
        if _four != 4 or self.p_size != self.region + 4:
            raise ValueError(f"asar 头部前缀不自洽（prefix={self.prefix.hex()}）")
        if not 16 <= self.data_start <= self.file_size:
            raise ValueError(f"asar 数据区起点异常：{self.data_start}（文件 {self.file_size} 字节）")
        if self.json_len > self.region:
            raise ValueError(f"asar 头部 JSON 长度 {self.json_len} 超出区大小 {self.region}")

    def close(self) -> None:
        self.reader.close()

    def add_entry(self, rel: str, size: int, offset: int) -> bool:
        """登记/覆盖一个文件条目，返回这次是否顺带丢掉了已有的 integrity 字段。

        为什么必须计入风险：覆盖 index.html 的条目要重写 size/offset，原来那条
        integrity（旧内容的哈希）留着就是错的，只能一起丢掉。它的效果和
        free_space 删字段完全相同；不统计它，"没基线却删了 integrity"的保护
        就会被这条路径绕过（实测如此）。
        """
        node = self.header
        parts = rel.replace("\\", "/").split("/")
        for part in parts[:-1]:
            node = node["files"].setdefault(part, {"files": {}})
        previous = node["files"].get(parts[-1]) or {}
        node["files"][parts[-1]] = {"size": size, "offset": str(offset)}
        return "integrity" in previous

    def serialize(self) -> bytes:
        return json.dumps(self.header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    def free_space(self) -> int:
        """删除 integrity 字段直到 JSON 能塞进原来的 JSON 区，返回删掉的条目数。

        余量通常只有几十~几百字节，新增一个文件条目就可能超；integrity 每条约 250 字节，
        而它在本机 fuse 关闭的前提下不参与校验。
        """
        raw = self.serialize()
        if len(raw) <= self.region:
            return 0
        removed = 0
        for _rel, entry in iter_leaves(self.header):
            if "integrity" in entry:
                del entry["integrity"]
                removed += 1
                raw = self.serialize()
                if len(raw) <= self.region:
                    break
        if len(raw) > self.region:
            raise RuntimeError(f"JSON 区放不下：需要 {len(raw)} 字节，可用 {self.region} 字节")
        print(f"  为腾出空间删除了 {removed} 个文件的 integrity 字段")
        print("  ⚠ 前提是 ZCode 的 EnableEmbeddedAsarIntegrityValidation fuse 处于 Disabled；"
              "若某次升级启用了它，应用会拒绝启动 —— 那时请先 restore 再排查。")
        return removed

    def build_blob(self, new_html: bytes, new_js: bytes) -> bytes:
        if SCRIPT_TAG.encode() not in new_html:
            raise RuntimeError("注入后的 index.html 找不到脚本标签，补丁逻辑有误")

        # 新文件追加到原文件末尾，偏移相对 data_start
        append_base = self.file_size - self.data_start
        dropped = int(self.add_entry(HTML_REL, len(new_html), append_base))
        dropped += int(self.add_entry(INJECT_REL, len(new_js), append_base + len(new_html)))

        # 已有的 index.html 条目被覆盖成新偏移，原数据区中的旧副本成了死区（不影响正确性）
        self.removed_integrity = dropped + self.free_space()
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


def load_inject_js(endpoint: str, token: str) -> bytes:
    source = (PROJECT_DIR / "inject" / "zcode-enhance.js").read_text(encoding="utf-8")
    for placeholder in ("__ZCE_ENDPOINT__", "__ZCE_TOKEN__"):
        if placeholder not in source:
            raise RuntimeError(f"注入脚本缺少 {placeholder} 占位符")
    # 去掉结尾斜杠：否则请求路径会变成 http://127.0.0.1:8770//api/enhance
    source = source.replace("__ZCE_ENDPOINT__", endpoint.rstrip("/"))
    source = source.replace("__ZCE_TOKEN__", token)
    return source.encode("utf-8")


def state_path() -> Path:
    """状态文件位置。ZCE_STATE_FILE 只给测试/多环境用，正常不设。

    不把状态塞进 LOCALAPPDATA 是历史选择（升级前就在仓库根）；
    真要迁移得同时处理"旧文件还在"的兼容读取，收益不如成本，故保留现状。
    """
    override = os.environ.get("ZCE_STATE_FILE")
    return Path(override) if override else PROJECT_DIR / STATE_NAME


# 备份刻意放在安装目录之外：ZCode 的升级安装器会整目录替换 resources/，
# 备份若留在那里会被一起删掉，升级后就再也回滚不了（2026-11-10 修正）。
BACKUP_DIR = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "zcode-prompt-enhance" / "backups"
RUNTIME_DIR = BACKUP_DIR.parent
# 与服务端同名环境变量，方便把两个组件指到同一个令牌（测试也用它避免碰到真实令牌）
TOKEN_PATH = Path(os.environ.get("PROMPT_ENHANCER_TOKEN_FILE") or (RUNTIME_DIR / "token"))


def ensure_token(create: bool = True) -> str:
    """读取或首次生成访问令牌（注入脚本与服务端共用）。

    为什么需要：8770 之前允许任意 Origin，本机浏览器里任何一个网页都能
    调 /api/enhance，用用户的 key 花用户的钱。令牌随补丁写进 asar，
    网页拿不到它。

    create=False 用于 --dry-run / --out：那两种模式只产出"供检查的包"，
    不该在用户机器上留下新的令牌文件（早先会留，与"演练无副作用"矛盾）。
    """
    try:
        token = TOKEN_PATH.read_text(encoding="utf-8").strip()
        if token:
            return token
    except OSError:
        pass
    if not create:
        return ""
    token = secrets.token_urlsafe(24)
    try:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
        TOKEN_PATH.write_text(token, encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(f"无法写入令牌文件 {TOKEN_PATH}：{exc}") from exc
    return token


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
    """原子替换 asar；被占用时明确报错，绝不退化成「先 truncate 再写」。

    早先 os.replace 失败后会就地覆写。两个问题：
      1) Asar 读取器一直开着 app.asar 的读句柄，Windows 上 os.replace 必然
         PermissionError —— 也就是说"原子替换"从来没真正生效过，永远走破坏性分支；
      2) 就地 truncate 一旦中途失败（断电 / 被结束进程 / 磁盘写满），
         374MB 的 app.asar 就是半截文件，ZCode 直接起不来。
    """
    tmp = path.with_name(path.name + ".zce-tmp")
    with open(tmp, "wb") as fp:
        fp.write(blob)
        fp.flush()
        os.fsync(fp.fileno())

    try:
        os.replace(tmp, path)
        return "原子替换"
    except PermissionError:
        pass  # 常见原因之一：文件带只读属性，下面去掉再试一次
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"写入 {path} 失败：{exc}") from exc

    # 先清只读属性再重试。注意 S_IWRITE|S_IREAD：
    # 单给 S_IWRITE 在 POSIX 上等于把权限改成 0o200（连读都没了），
    # 虽然本项目只面向 Windows，也不该留这种只会坑后来人的写法。
    try:
        original_mode = stat.S_IMODE(os.stat(path).st_mode)
    except OSError:
        original_mode = None
    try:
        os.chmod(path, stat.S_IWRITE | stat.S_IREAD)
        os.replace(tmp, path)
        return "原子替换（去掉只读属性后）"
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        if original_mode is not None:
            try:  # 替换失败就把属性还回去，别留下"文件变可写"的副作用
                os.chmod(path, original_mode)
            except OSError:
                pass
        raise RuntimeError(
            f"无法替换 {path}：{exc}\n"
            "  最常见原因是 ZCode 还在运行（含托盘图标），或当前账号没有 Program Files 的写权限。\n"
            "  请完全退出 ZCode 后重试；必要时以管理员身份运行本工具。"
        ) from exc


def compare_asar(backup: Path, patched: Path) -> tuple[bool, str]:
    """与基线逐字节比对：只允许 index.html 变化 + 新增注入脚本。

    与 tools/verify_patch.py 的分工：这里是"写完立刻判生死"的最小实现
    （遇到第一处差异就返回），verify_patch 是"给人看的全量报告"
    （逐条列出差异、检查占位符与标签数量）。两者共用 zce_common 里的路径常量。
    """
    with Asar(str(backup)) as old, Asar(str(patched)) as new:
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


def verify_refresh(asar: Path, expect_html: bytes, expect_js: bytes) -> tuple[bool, str]:
    """刷新脚本后的针对性校验（没有基线备份时用）。

    不做全量比对（没有基线），只把刚写进去的两个条目逐字节读回：
    index.html 必须与补丁前完全一致，注入脚本必须与源码一致。
    """
    with Asar(str(asar)) as reader:
        try:
            html = reader.read(HTML_REL)
            js = reader.read(INJECT_REL)
        except Exception as exc:  # noqa: BLE001
            return False, f"读回失败：{exc}"
    if html != expect_html:
        return False, "index.html 读回与预期不一致"
    if html.count(SCRIPT_TAG.encode()) != 1:
        return False, "index.html 的脚本标签数量不为 1"
    if not js or js != expect_js:
        return False, "注入脚本读回与源码不一致"
    return True, f"refresh 校验通过（脚本 {len(expect_js):,} 字节，标签 1 个）"


def probe_official_feature(reader: Asar) -> str | None:
    """探测官方是否已实现增强提示词（包里已预留 chat.promptEnhance.* 文案）。

    命中即说明 UI 开始接这些文案了，可以提示退役注入层。
    注意排除我们自己的注入脚本——它的注释里就写着 chat.promptEnhance.*。
    """
    needle = b"chat.promptEnhance."
    try:
        candidates = reader.find(".js", RENDERER_REL)
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
    """读状态文件。读不出来就当没有：一个被截断的 patch-state.json
    不该让 status / restore / verify 三个命令一起抛 traceback。"""
    p = state_path()
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def write_state(payload: dict) -> None:
    """原子写状态文件，避免中途失败留下半截 JSON。"""
    p = state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)


def resolve_asar(explicit: str | None) -> Path:
    """确定要处理哪个 app.asar：--asar → 状态文件记录 → ZCODE_ASAR/默认值。

    为什么读状态文件：装了两份 ZCode、或把仓库换了位置时，硬编码默认值会把补丁
    打到另一个包（或报"找不到"却不提示还有一条线索）。记录路径失效时静默回退默认值，
    保持原来"找不到就报错"的行为。
    """
    if explicit:
        return Path(explicit)
    recorded = read_state().get("asar")
    if recorded:
        recorded_path = Path(recorded)
        if recorded_path.exists():
            if recorded_path != DEFAULT_ASAR:
                print(f"（沿用上次记录的 asar：{recorded_path}；可用 --asar 覆盖）")
            return recorded_path
    return DEFAULT_ASAR


def integrity_guard(removed: int, has_baseline: bool, force: bool) -> str | None:
    """判断「删了 integrity 又没有基线备份」是否必须先拦下来。返回提示文本或 None。

    为什么拦：删 integrity 依赖官方 fuse 关闭；一旦某次升级启用校验，ZCode 会拒绝启动。
    有基线时最坏情况还能 restore；没有基线（用户删了那 374MB）就直接无路可退：
    restore 无备份、apply 的自动回滚也没有比对基准。所以这种组合必须显式确认。
    """
    if removed <= 0 or has_baseline or force:
        return None
    return (
        f"✗ 本次注入需要删掉 {removed} 个文件的 integrity 字段，但本机没有可回滚的基线备份。\n"
        "  若某次升级启用了 EnableEmbeddedAsarIntegrityValidation，ZCode 会拒绝启动，\n"
        "  而那时既没有 backup 可 restore，也没有自动回滚的比对基准——等于没有退路。\n"
        "  建议先重建基线：修复安装 / 重装 ZCode（会重装 resources/），再执行 apply。\n"
        "  确认已知风险后可加 --force 继续。"
    )


def cmd_status(args) -> int:
    asar = Path(args.asar)
    if not asar.exists():
        print(f"找不到 {asar}")
        return 1
    packer = open_packer(asar)
    if packer is None:
        return 1
    st = read_state()
    try:
        print(f"asar        : {asar}")
        print(f"大小        : {packer.file_size:,} 字节")
        print(f"JSON 区     : {packer.region:,} 字节（余量 {packer.region - packer.json_len}）")
        try:
            html = packer.reader.read(HTML_REL)
            patched = SCRIPT_TAG.encode() in html
        except Exception:  # noqa: BLE001
            patched = False
        print(f"当前状态    : {'已打补丁' if patched else '原始'}")
    finally:
        packer.close()

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
        if st.get("patchedAt"):
            print(f"补丁时间    : {st['patchedAt']}")
        else:
            print("补丁时间    : —（已还原或尚未记录）")
    return 0


def open_packer(asar: Path):
    """构造 AsarPacker，把「不是合法 asar」变成可读提示。

    升级后最需要这条：若 ZCode 改了打包格式，AsarPacker 会在解析头部 JSON 时抛异常。
    实测（2026-11-10，对非 asar 文件）异常发生在任何写入之前、文件一字节未改——是安全的，
    但原始 traceback 对使用者毫无指引，所以翻译成可操作的提示。
    """
    try:
        return AsarPacker(asar)
    except (json.JSONDecodeError, UnicodeDecodeError, struct.error, KeyError, ValueError) as exc:
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
    try:
        original_html = packer.reader.read(HTML_REL)
    except (FileNotFoundError, ValueError) as exc:
        print(f"✗ {asar} 里读不到 {HTML_REL}（{exc}）")
        print("  这不是预期的 ZCode 包结构，未做任何修改。")
        packer.close()
        return 1

    # 已打过补丁时走「刷新脚本」：只更新注入脚本本体，不重复插标签、不新建基线。
    # 这条路径是必需的 —— 用户可能已经删了基线备份（374MB），
    # 没有它就再也装不进更新后的脚本，只能等下一次 ZCode 升级。
    already_patched = SCRIPT_TAG.encode() in original_html

    original_hash = sha256_file(asar)
    version = asar_version(packer.reader)

    # 只有「就地替换」才需要备份和状态文件；--out / --dry-run 属于演练，
    # 不该写状态（否则 status 会误报已打补丁），也不该白拷 374MB。
    out = Path(args.out) if args.out else asar
    in_place = args.out is None and not args.dry_run

    try:
        new_js = load_inject_js(args.endpoint, ensure_token(create=in_place))
    except (RuntimeError, UnicodeDecodeError) as exc:
        packer.close()
        print(f"✗ 生成注入内容失败：{exc}")
        return 1
    if not in_place:
        print("（演练/输出模式：不生成访问令牌，产物只供检查，不能直接投用）")

    if already_patched:
        try:
            existing_js = packer.reader.read(INJECT_REL)
        except (FileNotFoundError, ValueError):
            existing_js = b""
        if existing_js == new_js:
            packer.close()
            print("已打过补丁，且注入脚本与当前源码一致，无需操作。")
            return 0
        print("检测到已打补丁：刷新注入脚本（不重复插标签、不新建基线）")

    backup = Path(args.backup) if args.backup else default_backup_path(version, original_hash)
    if in_place and already_patched:
        # 沿用已有基线用于全量比对；没有就跳过比对（refresh 用针对性校验兜底）
        st = read_state()
        baseline = Path(st["backup"]) if st.get("backup") else None
        if baseline and baseline.exists():
            backup = baseline
            print(f"沿用已有基线 -> {backup}")
        else:
            print("（没有基线备份：跳过全量比对，只做针对性校验；也意味着无法自动回滚）")
    elif in_place and not backup.exists():
        backup.parent.mkdir(parents=True, exist_ok=True)
        print(f"备份原文件 -> {backup}")
        shutil.copy2(asar, backup)
        for old in prune_backups(backup):
            print(f"（清理旧备份 {old}）")
    elif in_place:
        print(f"备份已存在，跳过 -> {backup}")

    try:
        new_html = original_html if already_patched else build_new_html(original_html)
        blob = packer.build_blob(new_html, new_js)
    except (RuntimeError, UnicodeDecodeError, ValueError) as exc:
        packer.close()
        print(f"✗ 生成注入内容失败：{exc}")
        return 1
    # 关键：写盘前必须放掉读句柄。Windows 上只要它还开着，os.replace 就 PermissionError。
    removed_integrity = packer.removed_integrity
    packer.close()

    # 删了 integrity 又没有基线 = 一旦出事无路可退，必须在写盘前拦下来（文件此时未被修改）。
    if in_place:
        blocked = integrity_guard(removed_integrity, backup.exists(), args.force)
        if blocked:
            print(blocked)
            return 1

    if args.dry_run:
        # 演练产物写到项目目录，别指望 Program Files 可写
        out = PROJECT_DIR / "build" / f"{asar.name}.dryrun"
        print(f"[dry-run] 写出到 {out}，不覆盖原文件")

    out.parent.mkdir(parents=True, exist_ok=True)
    if in_place:
        try:
            how = write_in_place(asar, blob)
        except RuntimeError as exc:
            print(f"✗ {exc}")
            return 1
        print(f"写入        : 成功（{how}）")
    else:
        out.write_bytes(blob)
        print(f"写入        : 成功（{out}）")

    print(f"补丁完成：{out}（{len(blob):,} 字节，原 {original_hash[:12]}…）")

    # 写完立刻自检。
    #   首次注入：与基线逐字节比对（只允许 index.html 变化）—— 这次写的是"新偏移"，
    #             必须全量比对才敢说没算错偏移；
    #   刷新脚本：只读回刚写的两个条目（快，且足够覆盖本次改动的风险面）；
    #   需要更强保证时用 --full-verify 强制走全量。
    if not in_place:
        ok, msg = True, "（演练模式跳过校验）"
    elif already_patched and not args.full_verify:
        ok, msg = verify_refresh(asar, new_html, new_js)
    elif backup.exists():
        ok, msg = compare_asar(backup, asar)
    else:
        ok, msg = verify_refresh(asar, new_html, new_js)
    print(f"结构校验: {'✓ ' if ok else '✗ '}{msg}")
    if ok and already_patched and not args.full_verify:
        print("          （刷新模式只校验注入的两个条目；要全量比对请加 --full-verify 或跑 tools/verify_patch.py）")
    if not ok:
        if in_place and backup.exists():
            print("→ 校验未通过，自动回滚")
            try:
                shutil.copy2(backup, asar)
                print(f"✓ 已还原：{asar} <- {backup}")
            except OSError as exc:
                print(f"✗ 自动回滚失败：{exc}")
                print(f"  请手动执行：copy /y \"{backup}\" \"{asar}\"")
        elif in_place:
            print("→ 校验未通过，且没有基线可回滚；请用「修复安装」重装 ZCode 的 resources/")
        return 1

    if in_place:
        st = read_state() if already_patched else {}
        if not already_patched:
            st["backup"] = str(backup)
            st["originalSha256"] = original_hash
        st.update({
            "asar": str(asar),
            "version": version,
            "patchedSha256": sha256_file(out),
            "patchedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
            "endpoint": args.endpoint,
            "injectRel": INJECT_REL,
            "scriptTag": SCRIPT_TAG,
            "tokenFile": str(TOKEN_PATH),
        })
        write_state(st)
        print(f"访问令牌    : {TOKEN_PATH}（服务端据此拒绝非应用来源的调用）")
        with Asar(str(asar)) as reader:
            hit = probe_official_feature(reader)
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
    if not asar.exists():
        print(f"找不到 {asar}（ZCode 可能已被卸载或换了安装目录）")
        return 1
    try:
        shutil.copy2(backup, asar)
    except PermissionError:
        print(f"✗ 无法写入 {asar}：文件被占用或权限不足")
        print("  ZCode 正在运行（含托盘图标）时文件是锁住的，请完全退出后重试；")
        print("  Program Files 下还需要管理员权限。")
        return 1
    except OSError as exc:
        print(f"✗ 还原失败：{exc}")
        return 1
    print(f"已还原：{asar} <- {backup}")

    # 还原也要验：copy2 中途失败（磁盘满 / 被杀 / 被占用）可能留下截断文件，
    # 而"已还原"的提示会让人以为没事。有 originalSha256 就比对。
    expected = st.get("originalSha256")
    if expected:
        actual = sha256_file(asar)
        if actual != expected:
            print(f"✗ 校验不一致：期望 {expected[:12]}…，实得 {actual[:12]}…")
            print("  文件可能被其他进程改写，或还原过程中断了。请完全退出 ZCode 后重试还原。")
            return 1
        print(f"✓ 校验通过：SHA256 与注入前的基线一致（{expected[:12]}…）")

    if st:
        # 还原后文件已回到原始状态，状态文件不能再声称"已打补丁"
        for key in ("patchedSha256", "patchedAt", "endpoint"):
            st.pop(key, None)
        write_state(st)
    return 0


def cmd_verify(args) -> int:
    """独立校验：用原始 reader 复读，并对抽样文件与备份逐字节比对。"""
    asar = Path(args.asar)
    if not asar.exists():
        print(f"找不到 {asar}")
        return 1
    packer = open_packer(asar)
    if packer is None:
        return 1
    ok = True

    try:
        html = packer.reader.read(HTML_REL)
        if SCRIPT_TAG.encode() in html:
            print("✓ index.html 含注入脚本标签")
        else:
            print("✗ index.html 缺少注入脚本标签")
            ok = False

        try:
            js = packer.reader.read(INJECT_REL)
            print(f"✓ 注入脚本可读出（{len(js):,} 字节）")
        except (FileNotFoundError, ValueError):
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
            with Asar(str(backup)) as old:
                mismatched = 0
                checked = 0
                for rel in old.find(".js", RENDERER_REL)[:20]:
                    checked += 1
                    try:
                        if old.read(rel) != packer.reader.read(rel):
                            mismatched += 1
                            print(f"✗ 内容不一致：{rel}")
                    except Exception as exc:  # noqa: BLE001
                        mismatched += 1
                        print(f"✗ 读取失败：{rel} {exc}")
            print(f"{'✓' if mismatched == 0 else '✗'} 抽样比对 {checked} 个渲染层文件，不一致 {mismatched}")
            ok = ok and mismatched == 0
        else:
            print("（没有可用基线备份，跳过抽样比对——补齐基线需重新 apply 或等下次升级）")
    finally:
        packer.close()

    return 0 if ok else 1


def main() -> int:
    force_utf8()
    parser = argparse.ArgumentParser(description="ZCode 增强提示词注入工具")
    parser.add_argument("--asar", default=None,
                        help="app.asar 路径（默认：状态文件记录 → ZCODE_ASAR → 内置默认值）")
    parser.add_argument("--backup", default=None,
                        help=r"备份路径（默认 %%LOCALAPPDATA%%\zcode-prompt-enhance\backups）")
    parser.add_argument("--endpoint", default=DEFAULT_ENDPOINT, help="本地增强服务地址")
    parser.add_argument("--out", default=None, help="写到别处而非就地替换（用于验证）")
    parser.add_argument("--dry-run", action="store_true", help="只生成不覆盖")
    parser.add_argument("--full-verify", action="store_true",
                        help="写完做全量逐字节比对（默认只在首次注入时做）")
    parser.add_argument("--force", action="store_true",
                        help="允许在无基线备份时删除 integrity 字段（已知风险）")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status")
    sub.add_parser("apply")
    sub.add_parser("restore")
    sub.add_parser("verify")
    args = parser.parse_args()
    args.asar = str(resolve_asar(args.asar))

    return {"status": cmd_status, "apply": cmd_apply,
            "restore": cmd_restore, "verify": cmd_verify}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())