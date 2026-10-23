"""Zuicool discovery and edition-specific evidence for Jiangsu/Zhejiang/Shanghai."""
import calendar
import re
from datetime import datetime
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

from .catalog import certification
from .core import CST, clean, in_scope, normalized_name, safe_url

A_CATALOG = "https://zuicool.com/tag/615955"


def dom(html):
    s = BeautifulSoup(html, "html.parser")
    for n in s.select("script,style,noscript"):
        n.decompose()
    return s


def province(location):
    m = re.match(r"^(江苏|浙江|上海)(?:省|市)?", clean(location))
    return m[1] if m else ""


def marathon_name(name):
    return "马拉松" in name and not re.search(r"越野|山地|轮滑|徒步|迷你|亲子|套餐|线上", name)


def platform_url(url):
    p = urlsplit(safe_url(url))
    return (p.hostname == "zuicool.com" and bool(re.fullmatch(r"/event/\d+/?", p.path))
            or p.hostname == "reg.zuicool.com" and bool(re.fullmatch(r"/\d+/?", p.path)))


def dotted_date(text):
    m = re.search(r"(20\d{2})[.\-/](\d{1,2})(?:[.\-/](\d{1,2}))?", text)
    if not m:
        return None, None
    y, month = int(m[1]), int(m[2])
    try:
        start = datetime(y, month, int(m[3] or 1)).date().isoformat()
        end = datetime(y, month, int(m[3] or calendar.monthrange(y, month)[1])).date().isoformat()
        return start if m[3] else f"{y}-{month:02d}", end
    except ValueError:
        return None, None


def status(text):
    if re.search(r"已截止|已关闭|已结束|报名截止$|停止报名|取消举办", text):
        return "closed"
    if re.search(r"已满|额满", text) and not re.search(r"额满即止|报满即止", text):
        return "sold_out"
    if re.search(r"报名中|点此报名|立即报名|一键报名", text):
        return "open"
    if re.search(r"报名预告|即将报名|即将开放|开启报名|开放报名|报名时间", text):
        return "announced"
    return "unknown"


def catalog_page(html, url):
    s = dom(html)
    nodes = s.select(".event-body")
    cards = []
    for n in nodes:
        a, info = n.select_one(".event-a[href]"), n.select_one(".info")
        if not a or not info or not platform_url(a["href"]):
            continue
        text = clean(info.get_text(" ", strip=True))
        date, end = dotted_date(text)
        location = clean(text.split("·", 1)[-1]) if "·" in text else ""
        cards.append({"name": clean(a.get_text()), "url": safe_url(a["href"]), "date": date, "date_end": end,
                      "location": location, "province": province(location), "a_tag": True,
                      "status": status(clean((n.select_one(".meta") or n).get_text(" ", strip=True)))})
    if not cards:
        raise ValueError("最酷A类列表为空或页面结构变化")
    next_link = next((urljoin(url, a["href"]) for a in s.select("a[href]") if "下一页" in a.get_text()), None)
    if next_link and (urlsplit(next_link).hostname != "zuicool.com" or urlsplit(next_link).path != "/tag/615955"):
        raise ValueError("最酷分页跳转到未核验入口")
    return cards, next_link


def discover(client, now, read, max_pages=20):
    cards, visited, url = {}, set(), A_CATALOG
    stats = {"catalog_pages": 0, "catalog_entries": 0, "catalog_complete": False}
    while url:
        page = len(visited) + 1
        if url in visited or page > max_pages:
            read("caa:zuicool:pagination", lambda: (_ for _ in ()).throw(ValueError("最酷分页循环或达到安全上限，覆盖不完整")))
            break
        visited.add(url)
        value = read(f"caa:zuicool:catalog:{page}", lambda u=url: catalog_page(client.get(u), u))
        if value is None:
            break  # Keep earlier pages; never turn a partial failure into no candidates.
        found, next_url = value
        stats["catalog_pages"] += 1
        stats["catalog_entries"] += len(found)
        for card in found:
            year = re.search(r"20\d{2}", card["name"])
            cards[(card["url"], year[0] if year else card["name"])] = card
        if not next_url or all(c["date_end"] and c["date_end"] < now.date().isoformat() for c in found):
            stats["catalog_complete"] = True
            break
        url = next_url
    return list(cards.values()), stats


def candidates(catalog, registrations, now):
    found = {}
    for c in catalog + registrations:
        c = dict(c)
        c["province"] = c.get("province") or province(c.get("location", ""))
        if not marathon_name(c["name"]) or not in_scope(dict(c, category="caa")):
            continue
        if c.get("status") in {"closed", "sold_out"} or (c.get("date_end") or c.get("date") or "9999") < now.date().isoformat():
            continue
        year = re.search(r"20\d{2}", c["name"])
        if not year:
            continue
        key = (year[0], normalized_name(c["name"]))
        if key not in found:
            found[key] = c
        elif urlsplit(c["url"]).hostname == "reg.zuicool.com":
            found[key]["registration_hint"] = c["url"]
    return list(found.values())


def evidence_state(text, year):
    matches = list(re.finditer(r"[AＡ](?:[12１２])?\s*类", text, re.I))
    positives, pending = [], []
    for m in matches:
        # Keep a claim in its own sentence/paragraph. Dates in a neighbouring
        # signup deadline cannot turn last year's certification into this year's.
        before = max(text.rfind(sep, 0, m.start()) for sep in ["\n", "。", "；", ";"])
        ends = [text.find(sep, m.end()) for sep in ["\n", "。", "；", ";"]]
        after = min((p for p in ends if p >= 0), default=len(text))
        snippet = text[max(before + 1, m.start() - 100):min(after, m.end() + 100)]
        years = set(re.findall(r"20\d{2}", snippet))
        if years and year not in years:
            continue
        preceding_years = re.findall(r"20\d{2}", text[max(before + 1, m.start() - 100):m.start()])
        if preceding_years and preceding_years[-1] != year:
            continue
        if re.search(r"非\s*[AＡ]|不属于|并非|未通过|未获|尚未|拟|申请|申报|认证中|待批|争创|力争", snippet):
            pending.append(clean(snippet))
        elif re.search(r"认证|中国田径协会|中国田协|田协|赛事类别|赛事等级", snippet):
            positives.append(clean(snippet))
    if pending:
        return "pending", pending[0]
    return ("declared", positives[0]) if positives else ("unknown", "")


def parse_detail(html, url):
    s = dom(html)
    is_reg = urlsplit(url).hostname == "reg.zuicool.com"
    root = s.select_one("#angReg_viewRace") if is_reg else s.select_one(".event-meta")
    heading = root.select_one("h4" if is_reg else "h1") if root else None
    if not root or not heading:
        raise ValueError("最酷当届详情缺少独立标题／正文，可能为登录或验证页")
    name = clean(re.sub(r"报名中|已截止|已关闭|已结束|已满", "", heading.get_text(" ", strip=True)))
    year = re.search(r"20\d{2}", name)
    if not year:
        raise ValueError("最酷详情无法确认当届年份")
    if is_reg:
        text = root.get_text("\n", strip=True)
        place = re.search(r"赛事地点[：:]\s*(.*?)\s*报名截止时间", text, re.S)
        dates = re.search(r"赛事日期[：:]\s*(20\d{2})年(\d+)月(\d+)日", text)
        date = datetime(*map(int, dates.groups())).date().isoformat() if dates else None
        location = clean(place[1]) if place else ""
        deadline = re.search(r"报名截止时间[：:]\s*(20\d{2})年(\d+)月(\d+)日\s*(\d+):(\d+)(?::(\d+))?", text)
        closes = datetime(*map(int, deadline.groups(default="0")), tzinfo=CST).isoformat() if deadline else None
        related = next((a["href"] for a in root.select("a[href]") if "更多赛事信息" in a.get_text() and platform_url(a["href"])), None)
        groups = "；".join(clean(n.get_text(" ", strip=True)) for n in root.select("h5"))[:1000]
        own_status = status(heading.get_text(" ", strip=True))
        news = []
        registration = url
    else:
        info = root.select_one(".start_datetime-loc")
        if not info:
            raise ValueError("最酷赛事详情缺少日期／地点")
        info_text = clean(info.get_text(" ", strip=True))
        date, _ = dotted_date(info_text)
        location = clean(info_text.split("·", 1)[-1]) if "·" in info_text else ""
        own = s.select(".event-desc_lead,.event-contact")
        text = "\n".join(n.get_text("\n", strip=True) for n in own)
        actions = s.select_one(".event-actions")
        own_status = status(actions.get_text(" ", strip=True) if actions else "")
        if own_status == "unknown":
            own_status = status(text)
        registration = next((safe_url(a["href"]) for a in actions.select("a[href]") if re.search(r"报名", a.get_text()) and safe_url(a["href"])), "") if actions else ""
        related = registration if platform_url(registration) else None
        news = [a["href"] for a in sorted(s.select(".event-wpposts a[href]"), key=lambda a: "规程" not in a.get_text())
                if re.fullmatch(r"https://zuicool.com/news/archives/\d+/?", a["href"]) and re.search(r"报名|规程", a.get_text())]
        closes, groups = None, ""
    return {"name": name, "edition": year[0], "date": date, "location": location, "province": province(location), "text": text,
            "status": own_status, "closes": closes, "groups": groups, "registration": registration, "related": related, "news": news, "url": url}


def inspect(client, card, registry, read):
    pages = [parse_detail(client.get(card["url"]), card["url"])]
    first = pages[0]
    expected_year = re.search(r"20\d{2}", card["name"])[0]
    if first["edition"] != expected_year:
        raise ValueError("最酷详情届次与列表不一致，待下轮核验")
    related = first["related"] or card.get("registration_hint")
    if related and related != first["url"]:
        other = read("caa:zuicool:linked:" + urlsplit(related).path.strip("/").replace("/", ":"), lambda: parse_detail(client.get(related), related))
        if other:
            if other["edition"] != expected_year or normalized_name(other["name"]) != normalized_name(first["name"]):
                raise ValueError("最酷报名链接与当前赛事不一致")
            pages.append(other)
    reg = next((p for p in pages if urlsplit(p["url"]).hostname == "reg.zuicool.com"), None)
    meta = next((p for p in pages if urlsplit(p["url"]).hostname == "zuicool.com"), first)
    text = "\n".join(p["text"] for p in pages)
    state, proof = evidence_state(text, expected_year)
    evidence = reg["url"] if reg else meta["url"]
    for news_url in meta["news"][:2] if state == "unknown" else []:
        def news_text(u=news_url):
            page = dom(client.get(u))
            content = page.select_one(".entry-content")
            if not content:
                raise ValueError("最酷报名公告未读到独立正文")
            title = page.select_one(".entry-title")
            if expected_year not in (title.get_text() if title else "") + content.get_text()[:1000]:
                raise ValueError("最酷报名公告无法核实当届年份")
            return content.get_text("\n", strip=True)
        article = read("caa:zuicool:news:" + news_url.rstrip("/").split("/")[-1], news_text)
        if article:
            state, proof = evidence_state(article, expected_year)
            if state != "unknown":
                evidence = news_url
                break
    rows = [r for r in registry if r["edition"] == expected_year and normalized_name(r["name"]) == normalized_name(meta["name"])]
    row = rows[0] if len(rows) == 1 and rows[0]["category"] == "A" else None
    cert = f"最酷当届详情声明A类（平台转载，未独立核实最终认证）；摘录：{proof}" if state == "declared" else certification(row) if state == "unknown" and row else ""
    if state == "unknown" and row:
        evidence = row["evidence"]
    reg_status = reg["status"] if reg else meta["status"]
    if any(p["status"] in {"closed", "sold_out"} for p in pages):
        reg_status = "closed"
    verified = bool(cert) and reg_status != "unknown" and bool(province(meta["location"]))
    reason = "当届A类依据待核验" if not cert else "报名信息尚未公布" if reg_status == "unknown" else ""
    return [{"id": f"caa:zuicool:{urlsplit(meta['url']).path.strip('/').replace('/', ':')}:{expected_year}",
             "series_id": "caa:" + normalized_name(meta["name"]), "edition": expected_year, "name": meta["name"], "category": "caa",
             "date": (reg or meta)["date"] or meta["date"], "province": province(meta["location"]), "location": meta["location"],
             "status": reg_status, "closes": reg["closes"] if reg else None, "groups": reg["groups"] if reg else "请查看当届规程",
             "official": meta["url"], "registration": reg["url"] if reg else meta["registration"], "source": card["url"],
             "certification": cert, "certification_state": state, "evidence": evidence, "verified": verified, "reason": reason,
             "qualification": "请核对最酷所载当届报名须知及组委会要求", "priority": 2}]
