"""在无头浏览器里跑注入脚本的 DOM 自测。

思路：用 Edge/Chrome 的 --headless --dump-dom --virtual-time-budget，
让页面把断言结果写进 #result 与 document.title，再把渲染后的 DOM 抓回来解析。
这样不需要装 puppeteer / playwright（本机 python 与 node 都没这些依赖）。
"""

from __future__ import annotations

import argparse
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


def prepare(endpoint: str) -> None:
    source = (PROJECT_DIR / "inject" / "zcode-enhance.js").read_text(encoding="utf-8")
    if "__ZCE_ENDPOINT__" not in source:
        raise SystemExit("注入脚本缺少 __ZCE_ENDPOINT__ 占位符")
    LOCAL_JS.write_text(source.replace("__ZCE_ENDPOINT__", endpoint), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", default=None)
    parser.add_argument("--endpoint", default="http://127.0.0.1:8770")
    parser.add_argument("--keep", action="store_true", help="保留生成的 local.js")
    args = parser.parse_args()

    prepare(args.endpoint)
    browser = args.browser or find_browser()
    page = WEB_DIR / "mock_composer.html"

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
    report = (report.replace("&lt;", "<").replace("&gt;", ">")
                    .replace("&amp;", "&").replace("&quot;", '"'))

    print(report)
    print()
    print(f"document.title = {title}")
    if proc.returncode != 0:
        print(f"浏览器退出码 {proc.returncode}")
    if not args.keep and LOCAL_JS.exists():
        LOCAL_JS.unlink()

    return 0 if title == "DOMTEST:PASS" else 1


if __name__ == "__main__":
    sys.exit(main())