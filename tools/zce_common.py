"""tools/ 共用的小工具：控制台编码 + 补丁相关的路径常量。

为什么单独抽一个模块：
  1. `_force_utf8` 原先在 menu.py / patch_zcode.py / check_beacon.py 各抄一份，
     三份已经出现行为差异（只有 menu 带 line_buffering），改一处不会同步另两处；
  2. asar 里的注入路径与脚本标签原先在 patch_zcode.py 和 verify_patch.py 各写一遍，
     一旦有一处改错，校验会拿错路径比对——而且不会报错，只会"看起来通过"。

依赖：仅标准库，可被任意 tools/ 脚本导入（不反向依赖它们）。
"""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent

# 注入脚本必须放在 assets/ 下：渲染层通过自定义协议提供文件，路由规则是
#   "/" 或 "/index.html" -> rendererDir/index.html
#   "/assets/*"          -> rendererDir/assets/*
#   其余路径            -> 404
# 放在 rendererDir 根下会被路由成 /zcode-enhance.js 直接 404，按钮根本不出现。
INJECT_NAME = "zcode-enhance.js"
RENDERER_REL = "out/renderer"
INJECT_REL = f"{RENDERER_REL}/assets/{INJECT_NAME}"
HTML_REL = f"{RENDERER_REL}/index.html"
# 相对 index.html（同目录）→ ./assets/...；协议层会把 /assets/x.js 映射到 assets/x.js
SCRIPT_TAG = f'<script src="./assets/{INJECT_NAME}"></script>'

DEFAULT_ENDPOINT = "http://127.0.0.1:8770"


def force_utf8(line_buffering: bool = False) -> None:
    """强制 UTF-8 输出（Windows 控制台默认 GBK，中文会变成乱码）。

    line_buffering 只在"会调起子进程、且两者共用一个控制台句柄"的脚本里需要
    （menu.py）：否则父进程的输出被块缓冲，会出现「[1/2] 检测…」跑到子进程
    输出之后的错乱顺序（实测如此）。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", line_buffering=line_buffering)
        except (AttributeError, ValueError, OSError):
            pass
