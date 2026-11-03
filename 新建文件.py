# -*- coding: utf-8 -*-
"""由「可视化采集」生成 · 页面: https://www.sunnafh.com/vod/show/id/1"
用法: pip install requests beautifulsoup4 && python scrape.py"""
import csv, re, time
from urllib.parse import urljoin
import requests
from bs4 import BeautifulSoup

URL = "https://www.sunnafh.com/vod/show/id/1"
ITEM_SEL = "a.content-card"   # 列表项
NEXT_SEL = "#flex-1 > div.container-style__Container-sc-ae32a59d-0.cXEjlU > div.container-style__HeaderCompatibilityLayout-sc-ae32a59d-2.movie-filter__StyleMain-sc-a0162bd7-0 > div.pagination > div.pagination__PaginationWrapper-sc-878df03c-2.gVEwgS > div:nth-of-type(7) > a.pagination-link__PaginationLinkWrapper-sc-6a3c4af-0.jmzRez"     # 下一页 <a> 链接（SPA 按钮翻页请改用 Playwright）
MAX_PAGES = 1
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"}
FIELDS = [
    {"name": "title", "sel": "div.info-title-box > div.title", "type": "text", "attr": "href", "multi": False, "abs": False, "replace": [], "prefix": "", "suffix": ""},
    {"name": "info-tag", "sel": "div.info-tags > div.info-tag", "type": "text", "attr": "href", "multi": False, "abs": False, "replace": [], "prefix": "", "suffix": ""},
    {"name": "score", "sel": "div.info-title-box > div.score.__className_7bf612", "type": "text", "attr": "href", "multi": False, "abs": False, "replace": [], "prefix": "", "suffix": ""},
    {"name": "info-roles", "sel": "div.info-roles", "type": "text", "attr": "href", "multi": False, "abs": False, "replace": [], "prefix": "", "suffix": ""},
    {"name": "info-intro", "sel": "div.info-intro", "type": "text", "attr": "href", "multi": False, "abs": False, "replace": [], "prefix": "", "suffix": ""},
    {"name": "info-time", "sel": "div.info-time", "type": "text", "attr": "href", "multi": False, "abs": False, "replace": [], "prefix": "", "suffix": ""},
    {"name": "img", "sel": "div.card-img > div.new-index__CardContentWrapper-sc-ef83950b-1.eOGzRx > div.poster-loaded > img.poster-loaded", "type": "attr", "attr": "src", "multi": False, "abs": False, "replace": [], "prefix": "", "suffix": ""}
]

def field_value(item, soup, f):
    if f["sel"] in ("", "."):
        nodes = [item]
    elif f["abs"]:
        found = soup.select(f["sel"])
        nodes = found if f["multi"] else found[:1]
    elif f["multi"]:
        nodes = item.select(f["sel"])
    else:
        n = item.select_one(f["sel"])
        nodes = [n] if n else []
    vals = []
    for n in nodes:
        if n is None:
            continue
        if f["type"] == "html":
            v = n.decode_contents().strip()
        elif f["type"] == "attr":
            v = n.get(f["attr"] or "href") or ""
        else:
            v = " ".join(n.get_text().split())
        vals.append(v)
    v = " | ".join([x for x in vals if x]) if f["multi"] else (vals[0] if vals else "")
    for find, to, is_re in f["replace"]:
        v = re.sub(find, to, v) if is_re else v.replace(find, to)
    return f["prefix"] + v + f["suffix"]

def extract(soup):
    return [{f["name"]: field_value(item, soup, f) for f in FIELDS}
            for item in soup.select(ITEM_SEL)]

def main():
    sess = requests.Session()
    sess.headers.update(HEADERS)
    url = URL
    all_rows = []
    for page in range(1, MAX_PAGES + 1):
        resp = sess.get(url, timeout=15)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")
        rows = extract(soup)
        all_rows.extend(rows)
        print("第 %d 页：%d 行" % (page, len(rows)))
        if page >= MAX_PAGES or not NEXT_SEL:
            break
        nxt = soup.select_one(NEXT_SEL)
        if not nxt or not nxt.get("href"):
            print("找不到下一页链接，结束")
            break
        url = urljoin(url, nxt.get("href"))
        time.sleep(1)   # 礼貌间隔，按需调整
    with open("scrape.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=list(all_rows[0].keys()) if all_rows else [])
        w.writeheader()
        w.writerows(all_rows)
    print("完成：%d 行 → scrape.csv" % len(all_rows))

if __name__ == "__main__":
    main()