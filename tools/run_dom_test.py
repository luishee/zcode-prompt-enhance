"""在无头浏览器里跑注入脚本的 DOM 自测。

思路：用 Edge/Chrome 的 --headless --dump-dom --virtual-time-budget，
让页面把断言结果写进 #result 与 document.title，再把渲染后的 DOM 抓回来解析。
这样不需要装 puppeteer / playwright（本机 python 与 node 都没这些依赖）。
"""

from __future__ import annotations

import argparse
import html
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
WEB_DIR = PROJECT_DIR / "web"
LOCAL_JS = WEB_DIR / "zcode-enhance.local.js"

BROWSER_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def find_browser() -> str:
    for path in BROWSER_CANDIDATES:
        if Path(path).exists():
            return path
    found = shutil.which("chrome") or shutil.which("msedge")
    if found:
        return found
    raise SystemExit("找不到 Chrome/Edge，无法运行 DOM 自测")


def prepare(endpoint: str, token: str = "dom-test-token") -> None:
    source = (PROJECT_DIR / "inject" / "zcode-enhance.js").read_text(encoding="utf-8")
    for placeholder in ("__ZCE_ENDPOINT__", "__ZCE_TOKEN__"):
        if placeholder not in source:
            raise SystemExit(f"注入脚本缺少 {placeholder} 占位符")
    source = source.replace("__ZCE_ENDPOINT__", endpoint).replace("__ZCE_TOKEN__", token)
    LOCAL_JS.write_text(source, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", default=None)
    parser.add_argument("--endpoint", default="http://127.0.0.1:8770")
    parser.add_argument("--keep", action="store_true", help="保留生成的 local.js")
    args = parser.parse_args()

    # 先找浏览器再写临时文件：否则找不到浏览器时会在 web/ 下留下一个孤儿文件
    browser = args.browser or find_browser()
    page = WEB_DIR / "mock_composer.html"

    try:
        prepare(args.endpoint)
        with tempfile.TemporaryDirectory() as profile:
            cmd = [
                browser,
                # 实测（2026-11-10，Edge 142）：--headless=new 在这里会一直挂着不退出，
                # 旧版 --headless 配合 --dump-dom 能正常输出并结束。
                "--headless",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--allow-file-access-from-files",
                f"--user-data-dir={profile}",
                "--virtual-time-budget=6000",
                "--dump-dom",
                page.as_uri(),
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                                  errors="replace", timeout=120)

        dom = proc.stdout or ""
        title = re.search(r"<title>(.*?)</title>", dom, re.S)
        title = title.group(1).strip() if title else "(无标题)"

        body = re.search(r'<pre id="result"[^>]*>(.*?)</pre>', dom, re.S)
        report = body.group(1).strip() if body else "(没抓到 #result，页面可能没跑起来)"
        report = html.unescape(report)

        print(report)
        print()
        print(f"document.title = {title}")
        if proc.returncode != 0:
            print(f"浏览器退出码 {proc.returncode}")

        return 0 if title == "DOMTEST:PASS" else 1
    finally:
        if not args.keep and LOCAL_JS.exists():
            LOCAL_JS.unlink()


if __name__ == "__main__":
    sys.exit(main())