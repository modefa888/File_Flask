#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
抓取指定网页，提取其中所有“包含指定字符串”的 URL 链接，
保存到内存列表中并打印输出。

直接修改文件底部 __main__ 里的参数即可运行。

依赖:
    pip install requests beautifulsoup4
"""

import re
import sys
from urllib.parse import urldefrag, urljoin

import requests
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}
SKIP_PREFIX = ("javascript:", "mailto:", "tel:", "data:", "#")

# 匹配 http/https 开头的 URL；遇到空白、引号、尖括号、右括号等即截断
URL_RE = re.compile(r'https?://[^\s<>"\'\)\]\}]+', re.IGNORECASE)

# ----------------------------------------------------------------------
# 1. 抓取页面
# ----------------------------------------------------------------------
def fetch_html(url: str, timeout: int = 10) -> str:
    """请求页面并返回 HTML 文本。"""
    resp = requests.get(url, headers=HEADERS, timeout=timeout)
    resp.raise_for_status()
    # 很多站点不声明编码，requests 会猜成 ISO-8859-1，这里纠正一下
    if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
        resp.encoding = resp.apparent_encoding
    return resp.text


# ----------------------------------------------------------------------
# 2. 解析页面中所有链接（<a href> + 纯文本 URL）
# ----------------------------------------------------------------------
def extract_links(html: str, base_url: str) -> list[tuple[str, str]]:
    """
    解析 HTML，返回 [(绝对url, 链接文字), ...]，已去重、去掉锚点。

    来源分两类：
      1) <a href="..."> 标签，链接文字为标签文本
      2) 页面纯文本（如 <p> 元素）中直接写出的 http(s) URL，链接文字为空
    """
    soup = BeautifulSoup(html, "html.parser")
    result, seen = [], set()

    def add(url: str, text: str) -> None:
        url = urldefrag(url.strip())[0]          # 去掉 #anchor
        if not url or url in seen:
            return
        if url.lower().startswith(SKIP_PREFIX):
            return
        seen.add(url)
        result.append((url, text.strip()))

    # ---- 来源 A：<a href="..."> 标签 ----
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if not href or href.lower().startswith(SKIP_PREFIX):
            continue
        add(urljoin(base_url, href), a.get_text(" ", strip=True))

    # ---- 来源 B：页面纯文本中的 URL（覆盖 <p> 等纯文本场景）----
    page_text = soup.get_text(" ", strip=True)
    for m in URL_RE.finditer(page_text):
        # rstrip 去掉句尾的 . , ; : ! ? ) ] } 等标点
        add(m.group(0).rstrip(".,;:!?)]}"), "")

    return result

# ----------------------------------------------------------------------
# 3. 按关键词过滤
# ----------------------------------------------------------------------
def filter_links(
    links: list[tuple[str, str]], keywords: list[str]
) -> list[dict]:
    """
    保留 url 中包含任一关键词的链接，返回字典列表：
        [{"url": ..., "keyword": ..., "text": ...}, ...]
    关键词匹配不区分大小写。
    """
    result, seen = [], set()
    for url, text in links:
        low_url = url.lower()
        for kw in keywords:
            if kw.lower() in low_url and (url, kw) not in seen:
                seen.add((url, kw))
                result.append({"url": url, "keyword": kw, "text": text})
                break  # 一条链接只记录第一个命中的关键词
    return result


# ----------------------------------------------------------------------
# 4. 输出 / 保存
# ----------------------------------------------------------------------
def print_hits(hits: list[dict]) -> None:
    print("=" * 70)
    print(f"共命中 {len(hits)} 条链接：")
    print("=" * 70)
    for i, item in enumerate(hits, 1):
        # print(f"[{i:>3}] [{item['keyword']:<8}] {item['url']}")
        if item["text"]:
            print(f"       链接文字: {item['text']}")


def save_to_txt(hits: list[dict], file_path: str) -> None:
    """把命中的 URL 按行写入 txt 文件（可选）。"""
    with open(file_path, "w", encoding="utf-8") as f:
        for item in hits:
            f.write(item["url"] + "\n")
    print(f"\n[*] 已保存 {len(hits)} 条链接到文件: {file_path}")


# ----------------------------------------------------------------------
# 5. 离线自测（不需要联网）
# ----------------------------------------------------------------------
def selftest() -> None:
    print("=" * 60)
    print("离线自测：解析 + 过滤")
    print("=" * 60)

    html = """
    <html><body>
        <a href="/about">关于我们</a>
        <a href="/contact-us">Contact Us</a>
        <a href="https://docs.example.com/guide">Docs Guide</a>
        <a href="/blog/post-1">博客</a>
        <a href="javascript:void(0)">JS</a>
        <a href="/about#team">About Team</a>
    </body></html>
    """
    base = "https://example.com/news/index.html"
    keywords = ["about", "contact", "docs"]

    links = extract_links(html, base)
    print(f"\n[1] 共提取到 {len(links)} 条链接：")
    for u, t in links:
        print(f"    {u}  ->  {t}")

    hits = filter_links(links, keywords)
    print(f"\n[2] 命中关键词 {keywords} 的链接共 {len(hits)} 条：")
    for item in hits:
        print(f"    [{item['keyword']}] {item['url']}  ->  {item['text']}")

    assert len(links) == 5, "提取到的链接数量不符合预期"
    assert len(hits) == 3, "过滤结果数量不符合预期"
    assert {h["url"] for h in hits} == {
        "https://example.com/about",
        "https://example.com/contact-us",
        "https://docs.example.com/guide",
    }, "过滤结果 URL 不符合预期"
    print("\n✅ 自测通过")


# ----------------------------------------------------------------------
# 6. 主流程（参数由调用方直接传入）
# ----------------------------------------------------------------------
def main(url: str, keywords: list[str], output: str | None = None) -> int:
    print(f"[*] 请求页面: {url}")
    try:
        html = fetch_html(url)
    except requests.RequestException as e:
        print(f"[!] 请求失败: {e}", file=sys.stderr)
        return 1
    print(f"[*] 页面大小: {len(html)} 字符")

    links = extract_links(html, url)
    print(f"[*] 提取到链接 {len(links)} 条")

    hits = filter_links(links, keywords)
    print(f"[*] 命中关键词 {keywords} 的链接 {len(hits)} 条\n")

    print_hits(hits)

    if output:
        save_to_txt(hits, output)

    return 0


# ----------------------------------------------------------------------
# 入口：直接传参
# ----------------------------------------------------------------------
if __name__ == "__main__":
    # ===== 方式一：离线自测（不联网） =====
    # selftest()
    # sys.exit(0)

    # ===== 方式二：真实抓取 =====
    from datetime import datetime

    now = datetime.now()
    # 生成形如 2026-11-1 的日期串（月、日不补零）
    date_str = f"{now.year}-{now.month}-{now.day}"

    TARGET_URL = f"https://www.freeclashnode.com/free-node/{date_str}-node-share-links.htm"
    KEYWORDS = ["https://node.freeclashnode.com/uploads/"]
    OUTPUT_FILE = None          # 例如 "result.txt"，设为 None 则不保存

    sys.exit(main(TARGET_URL, KEYWORDS, OUTPUT_FILE))