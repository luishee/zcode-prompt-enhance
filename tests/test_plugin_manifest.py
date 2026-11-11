"""插件清单契约测试：`.zcode-plugin/plugin.json` 与 `.mcp.json` 是否指向真实可用的 server。

为什么需要：这两个文件是「插件能不能被拉起来」的唯一契约，但错了不会在开发期报错——
ZCode 只会表现为「插件已启用，但没有任何 node 进程」，非常难查（README 坑一/坑二）。
这里把几条硬约定钉住：

  1. plugin.json 的 `mcpServers` 指向的清单文件必须存在；
  2. `.mcp.json` 的每个 server 必须有非空 `command`；
  3. 变量只允许用 ZCode 明确支持的几个（见 SUPPORTED_VARS）——
     写成 `${PLUGIN_ROOT}` 这类未知名字不会被替换，spawn 时直接失败；
  4. 把变量替换成插件根目录后，server 脚本必须真的存在且非空；
  5. server 依赖的 `prompts/` 必须随插件一起被打包（安装到缓存后原项目路径不可用）。

关于 `${CLAUDE_PLUGIN_ROOT}`：ZCode 的 MCP 配置展开函数把
`CLAUDE_PLUGIN_ROOT` / `ZCODE_PLUGIN_ROOT` 映射到同一个值（插件安装根目录），
所以两种写法等价；本测试只要求「落在受支持集合里」，不强制改名。

用法：
    python tests/test_plugin_manifest.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
PLUGIN = ROOT / "plugins" / "enhance-service"
PLUGIN_JSON = PLUGIN / ".zcode-plugin" / "plugin.json"
MARKETPLACE_JSON = ROOT / "plugins" / "marketplace.json"

# ZCode 的变量展开表（resources/glm/zcode.cjs 里 CLAUDE_*/ZCODE_* 两套别名指向同一值）。
SUPPORTED_VARS = {
    "CLAUDE_PLUGIN_ROOT", "ZCODE_PLUGIN_ROOT",
    "CLAUDE_PLUGIN_DATA", "ZCODE_PLUGIN_DATA",
    "CLAUDE_PROJECT_DIR", "ZCODE_PROJECT_DIR",
}
VAR_RE = re.compile(r"\$\{([A-Za-z0-9_]+)\}")
SCRIPT_SUFFIXES = (".js", ".mjs", ".cjs")

FAILED = 0
TOTAL = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global FAILED, TOTAL
    TOTAL += 1
    if not ok:
        FAILED += 1
    print(f"{'✓' if ok else '✗'} {name}{f' — {detail}' if detail else ''}")


def load(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        check(f"能读取并解析 {path.name}", False, str(exc))
        return None


def server_map(doc: dict) -> dict:
    """ZCode 同时接受 {"mcpServers": {...}} 与裸 {"name": {...}} 两种形状。"""
    wrapped = doc.get("mcpServers")
    if isinstance(wrapped, dict):
        return wrapped
    return {k: v for k, v in doc.items() if isinstance(v, dict)}


def main() -> int:
    print(f"插件清单契约测试：{PLUGIN}")
    manifest = load(PLUGIN_JSON)
    if manifest is None:
        return 1

    check("plugin.json 有 name", isinstance(manifest.get("name"), str) and bool(manifest["name"]))
    check("plugin.json 有 version", isinstance(manifest.get("version"), str) and bool(manifest["version"]))

    # 1. mcpServers 是一个指向真实文件的相对路径（ZCode 支持字符串形式）
    declared = manifest.get("mcpServers")
    check("plugin.json 声明了 mcpServers", isinstance(declared, str) and bool(declared), repr(declared))
    mcp_path = PLUGIN / str(declared) if isinstance(declared, str) else None
    check("mcpServers 指向的文件存在", bool(mcp_path and mcp_path.exists()),
          str(mcp_path) if mcp_path else "未声明")

    # 目录名与插件名一致：ZCode 的缓存路径是 <marketplace>/<plugin>/<version>，
    # 名字对不上时排查会看到两套目录，容易改错副本。
    check("插件目录名与 plugin.json name 一致", PLUGIN.name == manifest.get("name"), PLUGIN.name)

    # 版本号与 marketplace 清单一致（不一致会导致缓存里出现两个版本目录）
    market = load(MARKETPLACE_JSON)
    if market is not None:
        entry = next((p for p in market.get("plugins", []) if p.get("name") == manifest.get("name")), None)
        check("marketplace.json 里的版本与 plugin.json 一致",
              bool(entry) and entry.get("version") == manifest.get("version"),
              f"market={entry.get('version') if entry else None} plugin={manifest.get('version')}")

    if not (mcp_path and mcp_path.exists()):
        return 1
    mcp = load(mcp_path)
    if mcp is None:
        return 1
    servers = server_map(mcp)
    check(".mcp.json 至少声明一个 server", bool(servers), f"{len(servers)} 个")

    # 2/3. 每个 server 的 command 与变量
    unknown_vars: set[str] = set()
    scripts: list[Path] = []
    for name, conf in servers.items():
        if not isinstance(conf, dict):
            check(f"{name} 的配置是对象", False, type(conf).__name__)
            continue
        command = conf.get("command")
        check(f"{name} 有可用的 command", isinstance(command, str) and bool(command.strip()), repr(command))

        # 收集 command / args / cwd / env 里的字符串（与 ZCode 的展开范围一致）
        strings = [command] if isinstance(command, str) else []
        strings += [a for a in (conf.get("args") or []) if isinstance(a, str)]
        if isinstance(conf.get("cwd"), str):
            strings.append(conf["cwd"])
        for v in (conf.get("env") or {}).values():
            if isinstance(v, str):
                strings.append(v)

        for s in strings:
            unknown_vars.update(v for v in VAR_RE.findall(s) if v not in SUPPORTED_VARS)
            if s.endswith(SCRIPT_SUFFIXES):
                # 只校验以插件变量开头的脚本路径：其余可能是宿主提供的绝对路径
                if s.startswith("${"):
                    scripts.append(Path(s.replace("${CLAUDE_PLUGIN_ROOT}", str(PLUGIN))
                                         .replace("${ZCODE_PLUGIN_ROOT}", str(PLUGIN))))

    check("变量名都在 ZCode 支持集合内（未知变量不会被替换）",
          not unknown_vars, "未知: " + ", ".join(sorted(unknown_vars)) if unknown_vars else "")
    check("解析后的 server 脚本路径存在", bool(scripts) and all(p.exists() for p in scripts),
          ", ".join(str(p) for p in scripts) or "未找到脚本参数")
    if scripts:
        sizes = [p.stat().st_size for p in scripts if p.exists()]
        check("server 脚本非空", bool(sizes) and min(sizes) > 0,
              f"最小 {min(sizes):,} 字节" if sizes else "无")

    # 5. prompts 必须随插件打包：server 用 import.meta.url 定位自身目录，
    #    安装到 ~/.zcode/cli/plugins/cache/... 后原项目路径不可用。
    user_prompt = PLUGIN / "prompts" / "enhance_user.txt"
    system_prompt = PLUGIN / "prompts" / "enhance_system.txt"
    check("prompts/enhance_system.txt 存在且非空",
          system_prompt.exists() and system_prompt.stat().st_size > 0)
    check("prompts/enhance_user.txt 存在且含 {input} 占位符",
          user_prompt.exists() and "{input}" in user_prompt.read_text(encoding="utf-8"))

    print(f"\n{TOTAL - FAILED}/{TOTAL} 通过")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
