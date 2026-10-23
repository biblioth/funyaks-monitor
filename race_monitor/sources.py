"""Public source adapters. A changed/unreadable schema is an error, never no news."""
from __future__ import annotations

import io
import ipaddress
import json
import os
import re
import socket
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from urllib.parse import urljoin, urlsplit

import json5
import requests
from bs4 import BeautifulSoup
from pypdf import PdfReader

from .core import CST, clean, in_scope, normalized_name, safe_url, stamp
from .catalog import cached_directory, certification, directory_snapshot
from .browser import hk_browser_pages

UTMB_URL = "https://utmb.world/en/utmb-world-series-events"
INVIEW_URL = "https://inview.run/"
ZUI_URL = "https://reg.zuicool.com/"
WTM_URL = "https://hk100ultra.com/world-trail-majors/"
DIRECTORY_URL = "https://file.shuzixindong.com/changzheng/84554/fddbe29f6e434035918201d2a17dbcac.pdf"
SPORT = re.compile(r"越野|跑山|跑步|路跑|马拉松|攀岩|抱石|mountain\s*run|trail\s*run|climb|boulder", re.I)
REGION = re.compile(r"上海|江苏|浙江|安徽|杭州|南京|苏州|无锡|宁波|绍兴|湖州|莫干山|德清|常州|嘉兴|合肥|黄山|温州|金华|台州|丽水|南通|扬州|镇江|舟山|Shanghai|Jiangsu|Zhejiang|Anhui|Mogan", re.I)
BRAND = re.compile(r"凯乐石|KAILAS|FUGA|始祖鸟|ARC.?TERYX", re.I)


class SourceError(RuntimeError):
    pass


def public_url(url):
    if not safe_url(url):
        raise SourceError("来源 URL 无效")
    host = urlsplit(url).hostname
    try:
        addresses = socket.getaddrinfo(host, None)
    except OSError:
        raise SourceError(f"来源域名无法解析：{host}") from None
    if not addresses or any(not ipaddress.ip_address(v[4][0]).is_global for v in addresses):
        raise SourceError("来源不是公网地址")


class Client:
    def __init__(self, attempts=3, timeout=20):
        self.attempts, self.timeout = attempts, timeout

    def get(self, url, binary=False):
        original = url
        for attempt in range(self.attempts):
            retry_after = 1
            try:
                url = original
                for _ in range(6):
                    public_url(url)
                    r = requests.get(url, timeout=(5, self.timeout), allow_redirects=False, stream=True,
                                     headers={"User-Agent": "Mozilla/5.0 (compatible; RaceRegistrationMonitor/1.0; +https://github.com/biblioth/funyaks-monitor)", "Accept-Language": "zh-CN,en;q=0.8"})
                    if r.is_redirect:
                        url = urljoin(url, r.headers.get("Location", ""))
                        r.close()
                        continue
                    if r.status_code == 429:
                        value = r.headers.get("Retry-After", "1")
                        retry_after = min(60, int(value)) if value.isdigit() else 30
                    r.raise_for_status()
                    chunks, size = [], 0
                    for part in r.iter_content(65536):
                        size += len(part)
                        if size > 15_000_000:
                            raise SourceError("来源响应过大")
                        chunks.append(part)
                    r.close()
                    data = b"".join(chunks)
                    if binary:
                        return data
                    return data.decode("utf-8-sig", errors="replace")
                raise SourceError("来源重定向次数过多")
            except (requests.RequestException, SourceError) as e:
                alternate_status = ""
                wp_page = {"https://hk100ultra.com/": 2, "https://hk100ultra.com/entry/": 4, WTM_URL: 291}.get(original)
                if wp_page:
                    # These public API links are advertised in the official
                    # HTML's rel=alternate tags. No login or cookies are used.
                    try:
                        api = requests.get(f"https://hk100ultra.com/wp-json/wp/v2/pages/{wp_page}", timeout=(5, 20))
                        if api.status_code == 200:
                            value = api.json()
                            content = value.get("content", {}).get("rendered")
                            if isinstance(content, str) and len(content) > 200:
                                return content
                        alternate_status = f"；公开API HTTP {api.status_code}"
                    except (requests.RequestException, ValueError):
                        alternate_status = "；公开API读取失败"
                fallback = {"https://hk100ultra.com/": "hk_home", "https://hk100ultra.com/entry/": "hk_entry", WTM_URL: "wtm_members",
                            "https://www.kailas.com.cn/Home/Article/BrandNews/type/1.html": "kailas_news"}.get(original)
                proxy = os.environ.get("RACE_MONITOR_URL", "").rstrip("/")
                token = os.environ.get("CLOUDFLARE_ADMIN_TOKEN", "")
                if fallback and not binary and proxy.startswith("https://") and token:
                    try:
                        alternate = requests.get(proxy + "/races/source", params={"name": fallback}, headers={"Authorization": f"Bearer {token}"}, timeout=25)
                        if alternate.status_code == 200 and isinstance(alternate.json().get("html"), str):
                            return alternate.json()["html"]
                        alternate_status += f"；备用读取 HTTP {alternate.status_code}"
                        if alternate.status_code == 502:
                            alternate_status += f"（源站 {alternate.json().get('upstreamStatus', '读取失败')}）"
                    except (requests.RequestException, ValueError):
                        pass
                error = f"{urlsplit(original).hostname}：{type(e).__name__}"
                if isinstance(e, requests.HTTPError):
                    error += f" HTTP {e.response.status_code}"
                error += alternate_status
                if attempt + 1 < self.attempts:
                    time.sleep(max(retry_after, 2 ** attempt))
        raise SourceError(f"{self.attempts} 次尝试失败（{error}）")


def soup(html):
    s = BeautifulSoup(html, "html.parser")
    for node in s.select("script:not([type='application/json']), style, noscript"):
        node.decompose()
    return s


def next_data(html):
    tag = BeautifulSoup(html, "html.parser").select_one("#__NEXT_DATA__")
    if not tag:
        raise SourceError("UTMB 页面缺少结构化赛事数据")
    try:
        return json.loads(tag.string)["props"]["pageProps"]
    except (ValueError, KeyError, TypeError):
        raise SourceError("UTMB 数据结构已变化") from None


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def utmb_index(html):
    p = next_data(html)
    events = {}
    for node in walk(p):
        if node.get("tenant") and node.get("dateBegin") and node.get("title") and safe_url(node.get("url")):
            events[(node["tenant"], node["dateBegin"][:4])] = node
    if len(events) < 2:
        raise SourceError("UTMB 完整赛历为空或结构异常")
    return list(events.values())


def utmb_event(client, event):
    url = event["url"]
    html = client.get(url)
    p = next_data(html)
    current = p.get("event", {})
    begin = str(current.get("begin") or event["dateBegin"])[:10]
    end = str(current.get("end") or event.get("dateEnd") or begin)[:10]
    races = {str(x["id"]): x for x in walk(p.get("slices", [])) if x.get("id") and x.get("raceStatus") and x.get("name")}
    # Global menus can contain OTHER events' registration links. The current
    # page header and current site's explicit Register control are the only CTAs.
    own_link = p.get("pageHeader", {}).get("link") or {}
    registration = safe_url(urljoin(url, own_link.get("slug") or own_link.get("url") or "")) if re.search(r"register|报名", str(own_link.get("label", "")), re.I) else ""
    if not registration:
        registration = next((urljoin(url, a["href"]) for a in soup(html).select("a[href]") if re.search(r"^(?:register(?: now)?|registration|报名)$", clean(a.get_text()), re.I)
                             and (urlsplit(urljoin(url, a["href"])).hostname == urlsplit(url).hostname
                                  or event["tenant"].replace("-", "") in re.sub(r"[^a-z0-9]", "", a["href"].lower()))), "")
    groups = []
    statuses = []
    for race in races.values():
        distance = next((x.get("value") for x in walk(race.get("details", {})) if x.get("name") == "distance"), None)
        race_status = race["raceStatus"].get("status")
        suffix = {"registration_sold_out": "（已满）", "registration_closed": "（已截止）", "registration_open": "（报名中）"}.get(race_status, "")
        groups.append(f"{race['name']}" + (f" {distance}km" if distance else "") + suffix)
        statuses.append(race["raceStatus"].get("status"))
    status = "open" if "registration_open" in statuses else {"registration_open": "open", "registration_closed": "closed", "registration_sold_out": "sold_out"}.get(event.get("status", {}).get("status"), "preview")
    if statuses and all(x in {"registration_closed", "registration_sold_out"} for x in statuses):
        status = "closed"
    return [{"id": f"utmb:{event['tenant']}:{begin[:4]}", "series_id": f"utmb:{event['tenant']}", "edition": begin[:4],
             "name": f"{begin[:4]} {clean(current.get('name') or event['title'])}", "category": "utmb", "date": begin, "date_end": end,
             "continent": event.get("continent"),
             "location": clean(f"{event.get('country', '')} · {event.get('placeName', '')}"), "groups": "；".join(groups)[:1600] or "／".join(event.get("raceCategories", [])),
             "status": status, "registration": safe_url(registration), "official": url, "source": UTMB_URL,
             "verified": True, "priority": 0}]


def decode_astro(value):
    kind, value = value
    if kind == 0:
        return {k: decode_astro(v) for k, v in value.items()} if isinstance(value, dict) else value
    if kind == 1:
        return [decode_astro(v) for v in value]
    return value


def inview_events(html):
    s = BeautifulSoup(html, "html.parser")
    for tag in s.select("astro-island[props]"):
        try:
            data = decode_astro([0, json.loads(tag["props"])])
            if isinstance(data.get("calendar", {}).get("events"), list):
                return data["calendar"]["events"]
        except (ValueError, TypeError, KeyError):
            continue
    raise SourceError("国内赛历缺少可解析的活动数据")


def directory_rows(data, url):
    if not data.startswith(b"%PDF"):
        raise SourceError("田协目录响应不是 PDF")
    pages = [p.extract_text() or "" for p in PdfReader(io.BytesIO(data)).pages]
    text = "\n".join(pages)
    edition = re.search(r"(20\d{2})\s*年(?:全国)?马拉松赛事目录", text)
    if not edition:
        raise SourceError("无法确认田协目录年份和标题")
    rows = []
    for page_no, page in enumerate(pages, 1):
        # Row numbers are unique, and each row ends in A/B/C; wrapping inside
        # names/organisers is allowed. A row's province and name are not guessed.
        pattern = r"(?:^|\n)\s*(\d{1,4})\s+([^\s]+)\s+((?:20\d{2})[\s\S]*?)\s+(全程\s*/\s*半程|全程|半程)\s+([ABC])(?=\s|$)"
        for m in re.finditer(pattern, page):
            body = clean(m[3])
            date = re.search(r"(\d{1,2})\s*月(?:\s*(\d{1,2})\s*日)?", body)
            if not date:
                continue
            name = clean(body[:date.start()])
            rows.append({"id": f"caa:{edition[1]}:{m[1]}", "edition": edition[1], "number": int(m[1]), "province": m[2], "name": name,
                         "category": m[5], "groups": clean(m[4]), "date": f"{edition[1]}-{int(date[1]):02d}" + (f"-{int(date[2]):02d}" if date[2] else ""), "evidence": url, "page": page_no})
    if len(rows) < 20 or len({r["number"] for r in rows}) != len(rows):
        raise SourceError("田协目录行数不足或存在重复序号")
    return rows


def match_directory(name, year, rows):
    n = normalized_name(name)
    exact = [x for x in rows if x["edition"] == str(year) and normalized_name(x["name"]) == n]
    # Don't fuzzy-match A-class certification: similar names may be different races.
    return exact[0] if len(exact) == 1 else None


def caa_item(client, e, row):
    sources = e.get("sources", [])
    official = [x for x in sources if x.get("kind") in {"organizer", "government"} and safe_url(x.get("url"))]
    # Aggregators discover announcements; public primary pages must corroborate them.
    preferred = sorted(official, key=lambda x: not bool(re.search(r"报名|规程|registration", x.get("label", ""), re.I)))
    if not preferred:
        return []
    verified_url = None
    for candidate in preferred[:3]:
        body = soup(client.get(candidate["url"])).get_text(" ", strip=True)
        if str(e["year"]) in body and re.search(r"报名|registration|entry", body, re.I) and len(body) > 150:
            verified_url = candidate["url"]
            break
    if not verified_url:
        raise SourceError("当届报名公告未能从官方来源核实")
    reg = dict(e.get("registration", {}))
    # An aggregator timestamp is only displayed if the corresponding month/day
    # also appears in the primary announcement we actually fetched.
    for field in ["opensAt", "closesAt"]:
        value = str(reg.get(field) or "")
        if len(value) >= 10:
            month, day = int(value[5:7]), int(value[8:10])
            if value[:10] not in body and not re.search(rf"{month}\s*月\s*{day}\s*日", body):
                reg[field] = None
    status = "open" if e.get("status") in {"open", "registering"} else "announced"
    if e.get("status") in {"closed", "past", "ended", "soldout"}:
        status = "closed"
    return [{"id": row["id"], "series_id": "caa:" + normalized_name(row["name"]), "edition": row["edition"], "name": e["name"], "category": "caa",
             "province": row["province"],
             "date": e.get("raceMoment"), "location": f"{e.get('province', '')}·{e.get('city', '')}", "groups": "／".join(e.get("disciplines", [])),
             "status": status, "opens": reg.get("opensAt"), "closes": reg.get("closesAt"),
             "qualification": "请核对当届官方报名须知；报名时间由赛历线索与官方公告交叉核验",
             "method": e.get("lottery", {}).get("selection", {}).get("description"), "official": verified_url, "source": INVIEW_URL,
             "registration": verified_url, "evidence": row["evidence"], "certification": certification(row), "verified": True, "priority": 3}]


def chinese_dates(text, default_year=None):
    result = []
    for m in re.finditer(r"(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?", text):
        year = m[1] or default_year
        if not year:
            continue
        try:
            result.append(datetime(int(year), int(m[2]), int(m[3]), tzinfo=CST).date().isoformat())
        except ValueError:
            continue
    return result


def fuji_items(client):
    home = client.get("https://www.mtfuji100.com/")
    s = soup(home)
    info_link = next((urljoin("https://www.mtfuji100.com/", a["href"]) for a in s.select("a[href]") if "大会要項" in a.get_text()), None)
    if not info_link:
        raise SourceError("环富士山大会要项链接缺失")
    info = soup(client.get(info_link)).get_text(" ", strip=True)
    entry_url = "https://www.mtfuji100.com/racers/regarding/"
    entry_s = soup(client.get(entry_url))
    text = entry_s.get_text(" ", strip=True)
    edition = re.search(r"(?:Mt\.?FUJI\s*100|大会名)\D{0,12}(20\d{2})", info, re.I)
    if not edition:
        years = re.findall(r"(20\d{2})年のレース", text)
        if not years:
            raise SourceError("环富士山无法核实当届年份")
        year = years[0]
    else:
        year = edition[1]
    # Extract the general entry section, never the preceding priority entry.
    section = re.search(r"一般エントリー[\s\S]{0,100}?エントリー期間\s*(20\d{2})年(\d+)月(\d+)日[\s\S]{0,12}?(\d+)時(\d+)分[〜～~]\s*(?:(20\d{2})年)?(\d+)月(\d+)日[\s\S]{0,12}?(\d+)時(\d+)分", text)
    if not section:
        raise SourceError("环富士山普通报名窗口格式已变化")
    v = section.groups()
    jst = timezone(timedelta(hours=9))
    opens = datetime(*map(int, v[:5]), tzinfo=jst).isoformat()
    closes = datetime(int(v[5] or v[0]), *map(int, v[6:]), tzinfo=jst).isoformat()
    dates = chinese_dates(info, year)
    dates = [d for d in dates if d.startswith(year)]
    groups = list(dict.fromkeys(re.findall(r"FUJI\s*100mi|KAI\s*70k|ASUMI\s*40k|SAKUYA|Mt\.FUJI100 Mini", text, re.I)))
    windows = [{"label": "FUJI100mi／KAI70k／ASUMI40k 普通报名", "opens": opens, "closes": closes}]
    short = re.search(r"④\s*SAKUYA[\s\S]{0,60}?エントリー期間\s*(20\d{2})年(\d+)月(\d+)日[\s\S]{0,15}?[～〜~](20\d{2})年(\d+)月(\d+)日", text)
    if short:
        v = list(map(int, short.groups()))
        windows.append({"label": "SAKUYA／Mt.FUJI100 Mini（仅公布日期，日本当地日期）", "opens": f"{v[0]:04d}-{v[1]:02d}-{v[2]:02d}", "closes": f"{v[3]:04d}-{v[4]:02d}-{v[5]:02d}"})
    return [{"id": f"wtm:fuji:{year}", "series_id": "wtm:fuji", "edition": year, "name": f"{year} 环富士山 Mt.FUJI100", "category": "wtm",
             "date": dates[0] if dates else None, "date_end": dates[-1] if dates else None, "location": "日本·富士山地区", "groups": "／".join(groups),
             "status": "preview", "opens": opens, "closes": closes, "registration_windows": windows, "method": "主要组别普通报名超额抽签；捐赠名额及SAKUYA／Mini先到先得",
             "qualification": "按组别核对ITRA完赛要求；优先报名另有资格条件", "official": entry_url, "registration": entry_url,
             "source": entry_url, "verified": True, "priority": 0}]


def hk_items(client):
    try:
        home = client.get("https://hk100ultra.com/")
        entry = client.get("https://hk100ultra.com/entry/")
        return hk_page_items(home, entry, "official_http")
    except SourceError as original:
        try:
            home, entry = hk_browser_pages()
            return hk_page_items(home, entry, "official_browser")
        except Exception as e:
            raise SourceError(f"{original}；隔离浏览器备用失败（{type(e).__name__}）") from None


def hk_page_items(home, entry_html, transport):
    url = "https://hk100ultra.com/"
    s = soup(home)
    text = s.get_text(" ", strip=True)
    edition = re.search(r"(20\d{2})\s+(?:Edition|Events)", text)
    if not edition:
        raise SourceError("港百官网缺少当届年份")
    entry_url = urljoin(url, "entry/")
    entry = soup(entry_html).get_text(" ", strip=True)
    if "ENTRY PROCEDURES" not in entry or "Charity" not in entry:
        raise SourceError("港百报名规则结构已变化")
    charity = next((safe_url(urljoin(url, a["href"])) for a in s.select("a[href]") if "CHARITY REGISTRATION" in a.get_text().upper()), "")
    published_entry = next((safe_url(urljoin(url, a["href"])) for a in s.select("a[href]") if "raceresults.com.hk" in a["href"] and clean(a.get_text()).lower() == "register"), "")
    # Do not infer available regular entries from a generic Register button.
    days = [int(x) for x in re.findall(r"Jan(?:uary)?\s+(\d{1,2})[ ,]+" + edition[1], text, re.I)]
    days += [int(x) for x in re.findall(r"(\d{1,2})\s+January\s+" + edition[1], text)]
    date = f"{edition[1]}-01-{min(days):02d}" if days else None
    return [{"id": f"wtm:hk100:{edition[1]}", "series_id": "wtm:hk100", "edition": edition[1], "name": f"{edition[1]} 港百 Hong Kong 100", "category": "wtm",
             "date": date, "location": "中国香港", "groups": "HK100／The Half／The Third／Grand Sam",
             "status": "charity" if charity else "announced", "method": "普通名额抽签；慈善名额另行报名，实际余位请在报名平台核实",
             "qualification": "年龄及越野经验要求请查看当届规程；出现报名入口不代表当前开放或有剩余名额", "official": entry_url, "registration": charity or published_entry or entry_url,
             "source": url, "verified": True, "verification_method": transport, "priority": 0}]


def wtm_members(html, evidence=WTM_URL):
    s = soup(html)
    members = []
    cards = []
    # Mt.FUJI's official member list is a second public source with direct
    # organizer links; it remains usable when Hong Kong's page is blocked.
    for entry in s.select("ul.disc > li"):
        link = entry.select_one("b a[href]")
        if link:
            cards.append((clean(link.get_text(" ", strip=True)), entry.get_text(" ", strip=True), urljoin(evidence, link["href"])))
    # Each official member card has its own heading and series Details link.
    for heading in s.select("h3"):
        name = clean(heading.get_text(" ", strip=True))
        if not name or not re.search(r"100|Ultra|Marathon|Trail|MIUT|Transgrancanaria", name, re.I):
            continue
        parent = heading.parent
        card = parent.get_text(" ", strip=True)
        # Ascend only inside this card, not a parent that contains every country.
        for _ in range(3):
            if len(parent.select("h3")) != 1:
                break
            card = parent.get_text(" ", strip=True)
            if any("worldtrailmajors.com/" in a["href"] for a in parent.select("a[href]")):
                break
            parent = parent.parent
        link = next((safe_url(a["href"]) for a in parent.select("a[href]") if "worldtrailmajors.com/" in a["href"]), "")
        cards.append((name, card, link))
    for name, card, link in cards:
        slug = normalized_name(name)
        if "hongkong100" in slug:
            key = "hong-kong-100"
        elif "fuji100" in slug:
            key = "mt-fuji-100"
        elif "vietnammountainmarathon" in slug:
            key = "vietnam-mountain-marathon"
        else:
            key = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or slug
        asia = key in {"hong-kong-100", "mt-fuji-100", "vietnam-mountain-marathon"} or bool(re.search(r"\b(?:Asia|China|Japan|Hong Kong|Vietnam|Thailand|Malaysia|Taiwan|Korea|Indonesia|Philippines|Nepal|India|Bhutan|Laos|Cambodia|Singapore|Oman|Kazakhstan|Kyrgyzstan|Mongolia|Taipei|United Arab Emirates|Saudi Arabia)\b|亚洲|中国|日本|韩国|泰国|越南|香港|ベトナム|タイ王国|マレーシア|台湾|韓国|インドネシア|フィリピン|ネパール|ブータン|モンゴル|オマーン", card, re.I))
        members.append({"id": key, "name": name, "asia": asia, "location": "亚洲" if asia else "", "url": link, "evidence": evidence, "verified": True})
    if len(members) < 3 or not any(m["id"] == "hong-kong-100" for m in members):
        raise SourceError("WTM 官方成员清单结构已变化")
    return members


def member_catalog(client):
    errors = []
    for url in [WTM_URL, "https://www.mtfuji100.com/world-trail-majors/"]:
        try:
            return wtm_members(client.get(url), evidence=url)
        except SourceError as e:
            errors.append(str(e))
    raise SourceError("；".join(errors))


def zui_cards(html):
    s = soup(html)
    cards = []
    for card in s.select(".reg-race-block"):
        a = card.select_one(".race-name-a[href]")
        if not a:
            continue
        tag = a.select_one(".label")
        title = clean(a.get_text(" ", strip=True).replace(tag.get_text() if tag else "", ""))
        text = card.get_text(" ", strip=True)
        dates = chinese_dates(text)
        cards.append({"name": title, "url": urljoin(ZUI_URL, a["href"]), "text": text, "date": dates[0] if dates else None,
                      "status": "open" if tag and tag.get_text(strip=True) == "报名中" else "closed"})
    if not cards:
        raise SourceError("最酷赛事列表为空或结构已变化")
    return cards


def zui_detail(client, card, row=None):
    s = soup(client.get(card["url"]))
    text = s.get_text(" ", strip=True)
    if "报名截止时间" not in text or "赛事地点" not in text:
        raise SourceError("报名详情缺少日期／地点字段")
    place = re.search(r"赛事地点[：:]\s*(.*?)\s*报名截止时间", text)
    location = clean(place[1]) if place else ""
    deadline = re.search(r"报名截止时间[：:]\s*(20\d{2})年(\d+)月(\d+)日\s*(\d+):(\d+)(?::(\d+))?", text)
    closes = datetime(*map(int, deadline.groups(default="0")), tzinfo=CST).isoformat() if deadline else None
    year = re.search(r"20\d{2}", card["name"])
    if not year or not card.get("date"):
        raise SourceError("报名详情无法确定当届活动日期")
    tables = [clean(x.get_text(" ", strip=True)) for x in s.select("h5, table")]
    item = {"id": row["id"] if row else f"brand:zui:{urlsplit(card['url']).path.strip('/')}:{year[0]}",
            "edition": year[0], "name": card["name"], "category": "caa" if row else "brand", "date": card["date"], "location": location,
            "closes": closes, "groups": "；".join(tables)[:1000], "status": card["status"], "official": card["url"], "registration": card["url"], "source": ZUI_URL,
            "method": "先到先得" if "先报先得" in text or "先到先得" in text else None, "verified": bool(row), "in_region": bool(REGION.search(location)), "priority": 2}
    if row:
        item.update(province=row["province"], certification=certification(row), evidence=row["evidence"], series_id="caa:" + normalized_name(row["name"]))
    else:
        # Only an explicit organizer/sponsor relationship, not a brand keyword in
        # the title or an ad elsewhere on the page, is enough evidence to notify.
        body = text[:text.find("我的 报名")] if "我的 报名" in text else text
        relation = re.search(r"(?:主办|冠名|赞助|合作伙伴|支持单位)[^。；;\n]{0,70}(?:凯乐石|KAILAS|FUGA|始祖鸟|ARC.?TERYX)|(?:凯乐石|KAILAS|始祖鸟|ARC.?TERYX)[^。；;\n]{0,50}(?:主办|冠名|赞助)", body, re.I)
        item.update(verified=bool(relation), brand=clean(relation[0]) if relation else "品牌合作关系待核实（仅存线索，不推送）")
    return [item]


def balanced_object(text, start):
    depth, quote, escaped = 0, None, False
    for i in range(start, len(text)):
        char = text[i]
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
        elif char in {"'", '"'}:
            quote = char
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    raise SourceError("品牌静态数据对象不完整")


def arcteryx_records(code):
    records = []
    for m in re.finditer(r"P63187_\w+:\s*(?=\{)", code):
        try:
            raw = balanced_object(code, m.end())
            # Minified JavaScript booleans are literals, but not JSON5. Translate
            # only outside strings; never execute scripts from an external site.
            chars, quote, escaped, i = [], None, False, 0
            while i < len(raw):
                char = raw[i]
                if quote:
                    if escaped:
                        escaped = False
                    elif char == "\\":
                        escaped = True
                    elif char == quote:
                        quote = None
                elif char in {"'", '"'}:
                    quote = char
                elif raw[i:i + 2] in {"!0", "!1"}:
                    chars.append("true" if raw[i + 1] == "0" else "false")
                    i += 2
                    continue
                chars.append(char)
                i += 1
            records.append(json5.loads("".join(chars)))
        except ValueError:
            raise SourceError("始祖鸟公开活动数据格式已变化") from None
    return records


def arc_items(client):
    base = "https://arcteryx.com/cn/"
    page = BeautifulSoup(client.get(urljoin(base, "mountainClassroom")), "html.parser")
    runtime_url = next((urljoin(base, a["src"]) for a in page.select("script[src]") if "/runtime." in a["src"]), None)
    if not runtime_url:
        raise SourceError("始祖鸟公开网页缺少运行资源索引")
    runtime = client.get(runtime_url)
    # Resolve the currently published chunk names/hashes, never hardcode build IDs.
    names = dict(re.findall(r'(\d+):"((?:common\.|pages/|components/)[^"\n]+)"', runtime))
    maps = re.findall(r'\{((?:\d+:"[a-z0-9]+",?)+)\}', runtime)
    hashes = dict(re.findall(r'(\d+):"([a-f0-9]{7,})"', maps[-1])) if maps else {}
    code = []
    for key, name in names.items():
        if (name.startswith("common.pages/brandActivities/") or name == "pages/mountainClassroom/index") and key in hashes:
            code.append(client.get(urljoin(base, f"_nuxt/{name}.{hashes[key]}.js")))
    records = [r for js in code for r in arcteryx_records(js)]
    if not records:
        raise SourceError("始祖鸟公开数据未读到活动；小程序不在当前覆盖范围")
    items = []
    for r in records:
        summary = clean(" ".join(str(r.get(k, "")) for k in ["title", "describe", "eventstarttime", "eventendtime", "eventlocation", "content"]))
        location = clean(r.get("eventlocation"))
        if not SPORT.search(summary) or not REGION.search(location):
            continue
        dates = chinese_dates(clean(r.get("eventstarttime")))
        if not dates:
            # Do not treat the CMS creation date as the activity date.
            continue
        url = urljoin(base, f"mountainClassroomDetails/{r['id']}/")
        items.append({"id": f"brand:arc:{r['id']}:{dates[0][:4]}", "edition": dates[0][:4], "name": clean(r.get("title")),
                      "date": dates[0], "location": location, "category": "brand", "status": "preview", "official": url,
                      "entry_path": "始祖鸟会员中心小程序 → 山地课堂（以当期公告为准）", "brand": "始祖鸟官方山地课堂",
                      "source": urljoin(base, "mountainClassroom"), "verified": True, "in_region": True, "priority": 0})
    return items


def brand_article_items(client, index_url, brand, mode):
    s = soup(client.get(index_url))
    links = {}
    for a in s.select("a[href]"):
        url = safe_url(urljoin(index_url, a["href"]))
        title = clean(a.get_text(" ", strip=True))
        if not url or urlsplit(url).hostname != urlsplit(index_url).hostname:
            continue
        if mode == "letour" and title == "DISCOVER":
            links[url] = title
        elif mode == "kailas" and re.search(r"BrandNews|detail", url, re.I) and SPORT.search(title):
            links[url] = title
    if mode == "letour" and not links:
        raise SourceError("朗途官网未读到赛事链接")
    if mode == "kailas" and "品牌新闻" not in s.get_text():
        raise SourceError("凯乐石新闻目录结构已变化")
    items = []
    for url, title in links.items():
        body = soup(client.get(url))
        text = body.get_text(" ", strip=True)
        if not SPORT.search(text) or not re.search(r"报名|register|entry", text, re.I):
            continue
        # Restrict region evidence to an explicit location field, not footer/store names.
        place = re.search(r"(?:赛事地点|活动地点|比赛地点|地点|Location)[：:]\s*([^。\n]{2,100})", text, re.I)
        location = clean(place[1]) if place else "浙江·莫干山" if mode == "letour" and "Mogan" in text else ""
        if not REGION.search(location):
            continue
        date_field = re.search(r"(?:活动时间|比赛时间|赛事日期|Date)[：:]\s*([^。\n]{5,100})", text, re.I)
        dates = chinese_dates(date_field[1]) if date_field else []
        if not dates:
            continue
        heading = body.select_one("h1")
        name = clean(heading.get_text(" ", strip=True)) if heading else title
        items.append({"id": f"brand:{mode}:{urlsplit(url).path}:{dates[0][:4]}", "edition": dates[0][:4], "name": name,
                      "date": dates[0], "location": location, "groups": "请查看活动规程", "category": "brand", "status": "preview",
                      "official": url, "source": index_url, "brand": brand, "registration": url, "verified": True, "in_region": True, "priority": 1})
    return items


def collect(now, client=None, directory_cache=None):
    client = client or Client()
    directory_cache = dict(directory_cache or {})
    items, members, reports, tasks, registry, leads = [], [], {}, [], [], []

    def run(name, fn):
        try:
            value = fn()
            reports[name] = {"ok": True, "checked_at": now.isoformat()}
            return value
        except Exception as e:
            reports[name] = {"ok": False, "error": clean(str(e))[:220], "checked_at": now.isoformat()}
            return None

    index = run("utmb:index", lambda: utmb_index(client.get(UTMB_URL)))
    for event in index or []:
        if in_scope(dict(event, category="utmb")) and event.get("dateEnd", event["dateBegin"]) >= now.date().isoformat():
            tasks.append((f"utmb:{event['tenant']}", lambda e=event: utmb_event(client, e)))
    tasks.extend([("wtm:fuji", lambda: fuji_items(client)), ("wtm:hk100", lambda: hk_items(client)),
                  ("brand:arcteryx", lambda: arc_items(client)),
                  ("brand:letour", lambda: brand_article_items(client, "https://www.letoursports.net/", "凯乐石合作赛事（朗途官方发布）", "letour")),
                  ("brand:kailas", lambda: brand_article_items(client, "https://www.kailas.com.cn/Home/Article/BrandNews/type/1.html", "凯乐石官方发布", "kailas"))])
    m = run("wtm:members", lambda: member_catalog(client))
    members.extend(m or [])
    events = run("caa:discovery", lambda: inview_events(client.get(INVIEW_URL)))
    pdf_urls = {DIRECTORY_URL}
    for e in events or []:
        for source in e.get("sources", []):
            u = source.get("url", "")
            if "马拉松赛事目录" in source.get("label", "") and u.endswith(".pdf") and safe_url(u):
                pdf_urls.add(u)
    for url in sorted(pdf_urls):
        name = "caa:directory:" + urlsplit(url).path.split("/")[-1]
        def load_directory(u=url):
            data = client.get(u, binary=True)
            rows = directory_rows(data, u)
            directory_cache[u] = directory_snapshot(u, data, rows, now)
            return rows
        rows = run(name, load_directory)
        if rows is None:
            cached = cached_directory(url, directory_cache.get(url))
            if cached:
                rows = cached["rows"]
                # Keep ok=false: a usable historical plan does not mean this
                # run verified the latest directory or any signup status.
                reports[name]["fallback"] = {"kind": "verified_snapshot", "edition": cached["edition"],
                                              "verified_at": cached["verified_at"], "rows": len(rows)}
        registry.extend(rows or [])
    for e in events or []:
        row = match_directory(e.get("name", ""), e.get("year"), registry)
        reg = e.get("registration", {})
        deadline = stamp(reg.get("closesAt"))
        if (row and row["category"] == "A" and in_scope(dict(row, category="caa")) and e.get("status") != "closed"
                and (deadline is None or deadline >= now)
                and (e.get("raceMoment") or "") >= now.date().isoformat()
                and (reg.get("opensAt") or reg.get("closesAt"))):
            tasks.append(("caa:" + e["id"], lambda e=e, row=row: caa_item(client, e, row)))
    cards = run("platform:zuicool", lambda: zui_cards(client.get(ZUI_URL)))
    for card in cards or []:
        if not card.get("date") or card["date"] < now.date().isoformat():
            continue
        year = card["date"][:4]
        row = match_directory(card["name"], year, registry)
        scoped_row = row if row and row["category"] == "A" and in_scope(dict(row, category="caa")) else None
        if scoped_row or BRAND.search(card["name"]) and REGION.search(card["text"]) and SPORT.search(card["name"]):
            tasks.append(("entry:" + urlsplit(card["url"]).path.strip("/"), lambda c=card, r=scoped_row: zui_detail(client, c, r)))
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(fn): name for name, fn in tasks}
        for future in as_completed(futures):
            name = futures[future]
            try:
                found = future.result()
                reports[name] = {"ok": True, "checked_at": now.isoformat(), "items": len(found)}
                for item in found:
                    if item.get("verified") and in_scope(item):
                        items.append(item)
                    elif not item.get("verified"):
                        leads.append({k: item.get(k) for k in ["name", "source", "official", "brand"]})
            except Exception as e:
                reports[name] = {"ok": False, "error": clean(str(e))[:220], "checked_at": now.isoformat()}
    return {"items": items, "members": members, "sources": reports, "directory_cache": directory_cache, "registry_count": len(registry), "a_class_count": sum(r["category"] == "A" for r in registry),
            "review_leads": leads, "gaps": ["品牌会员小程序、微信群及仅图片发布的招募尚未接入", "国内赛事发现依赖公开赛历与最酷补漏，未覆盖所有组委会公众号", "WTM总站受限时使用港百／环富士山官方成员清单，成员同步可能延迟"]}
