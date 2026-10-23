"""Anonymous official HK100 pages in an isolated browser; no challenge solver."""
import os
import re
from urllib.parse import urlsplit


def hk_browser_pages():
    from playwright.sync_api import sync_playwright

    pages = []
    with sync_playwright() as p:
        # GitHub Linux runs this under Xvfb. No user's desktop or profile is used.
        browser = p.chromium.launch(headless=not bool(os.environ.get("DISPLAY")))
        try:
            context = browser.new_context()
            for url, expected in [("https://hk100ultra.com/", r"20\d{2}\s+(?:Edition|Events)"), ("https://hk100ultra.com/entry/", r"ENTRY PROCEDURES")]:
                page = context.new_page()
                try:
                    page.goto(url, wait_until="domcontentloaded", timeout=30000)
                    page.locator("body").filter(has_text=re.compile(expected, re.I)).wait_for(timeout=15000)
                    if urlsplit(page.url).hostname != "hk100ultra.com":
                        raise RuntimeError("港百官网跳转到未核验域名")
                    html = page.content()
                    if len(html.encode()) > 2_000_000:
                        raise RuntimeError("港百浏览器页面过大")
                    pages.append(html)
                finally:
                    page.close()
        finally:
            browser.close()
    return pages
