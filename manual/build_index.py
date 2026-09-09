#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
_지식베이스/ 를 웹앱용 JSON으로 변환한다.

대상: 에스컬레이터·엘리베이터·자동문 설비 매뉴얼, 에러코드, 현장조치 절차
제외: 계약·법정검사·공문·보고·사고·인사 등 대외/민감 문서 (파일명 기준 자동 차단)

사용법:
    python build_index.py "C:\\Users\\정철\\Desktop\\국제선 승강파일"
    python build_index.py "..." --dry     # 파일만 확인하고 쓰지 않음

쓰는 것:
    data/index.json      코드·절차·매뉴얼목록·설비목록 (오프라인 캐시 대상)
    data/docs/*.json     매뉴얼 원문 (서버 검색 전용)
"""
import json, os, re, sys, hashlib, unicodedata, datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "data")

# ── 제외 필터 ────────────────────────────────────────────────
# 경로나 파일명에 아래 문구가 있으면 인덱싱하지 않는다.
BLOCK = (
    # 개인정보·인사
    "06_사고보고서", "90_개인_인사", "개인정보", "민감", "인사기록",
    "사고보고", "재해", "진단서", "주민등록", "연락처", "명부",
    # 계약·대외문서
    "계약", "도급", "입찰", "견적", "발주", "정산", "대금", "청구",
    "협약", "각서", "합의", "단가",
    # 법정검사·행정
    "법정검사", "검사결과", "합격증", "수검", "행정처분", "과태료",
    "공문", "보고서", "품의", "기안", "결재", "인수인계",
    # 운영기록
    "점검일지", "일지", "근무", "출입",
)

# 매뉴얼로 인정할 파일명 힌트 (원문텍스트 폴더에 한해 적용)
MANUAL_HINT = (
    "매뉴얼", "메뉴얼", "manual", "설명서", "취급", "보수", "정비",
    "설치", "조정", "시운전", "도면", "회로", "부품", "파라미터",
    "제어반", "트러블", "고장", "에러", "코드", "spec", "가이드",
)

TAG_RE = re.compile(r"\b(ES|EL|AD|MW|WL)\s*[-#]?\s*(\d{1,3})\b", re.I)
KIND = {"ES": "에스컬레이터", "EL": "엘리베이터", "AD": "자동문",
        "MW": "무빙워크", "WL": "휠체어리프트"}

KIND_WORDS = [("ES", ("에스컬레이터", "escalator", "무빙워크", "moving walk")),
              ("EL", ("엘리베이터", "승강기", "elevator", "lift", "ard")),
              ("AD", ("자동문", "슬라이딩도어", "tormax", "automatic door"))]

EXCLUDED = []   # 제외된 파일 기록 (사용자 확인용)


def blocked(p):
    low = p.lower()
    for b in BLOCK:
        if b.lower() in low:
            return b
    return None


def kind_of(*texts):
    blob = " ".join(t or "" for t in texts).lower()
    for code, words in KIND_WORDS:
        if any(w in blob for w in words):
            return code
    m = TAG_RE.search(blob)
    return m.group(1).upper() if m else ""


def tags_of(*texts):
    out = []
    for t in texts:
        for m in TAG_RE.finditer(t or ""):
            k = f"{m.group(1).upper()}-{int(m.group(2)):02d}"
            if k not in out:
                out.append(k)
    return out


def read(p):
    for enc in ("utf-8-sig", "utf-8", "cp949", "euc-kr"):
        try:
            with open(p, encoding=enc) as f:
                return f.read()
        except (UnicodeDecodeError, LookupError):
            continue
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def table_rows(lines):
    header, rows = None, []
    for ln in lines:
        s = ln.strip()
        if not s.startswith("|"):
            header = None
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if all(re.fullmatch(r":?-{2,}:?", c) for c in cells if c):
            continue
        if header is None:
            header = cells
        else:
            rows.append(cells)
    return header, rows


def parse_codes(path):
    if not os.path.exists(path):
        return []
    text = read(path)
    out, maker, buf = [], "", []

    def flush():
        if not buf:
            return
        header, rows = table_rows(buf)
        if not rows:
            buf.clear()
            return
        h = [c.replace(" ", "") for c in (header or [])]

        def col(*names, default=None):
            for n in names:
                for i, c in enumerate(h):
                    if n in c:
                        return i
            return default

        i_code = col("코드", "code", "no", "번호", default=0)
        i_mean = col("내용", "의미", "명칭", "설명", "원인", "고장", default=1)
        i_act = col("조치", "대책", "처리", "복구", default=None)
        for r in rows:
            if not r or i_code >= len(r) or not r[i_code].strip():
                continue
            code = re.sub(r"[`*]", "", r[i_code]).strip()
            mean = r[i_mean].strip() if i_mean is not None and i_mean < len(r) else ""
            act = r[i_act].strip() if i_act is not None and i_act < len(r) else ""
            out.append({"code": code, "meaning": mean, "action": act,
                        "maker": maker, "tags": tags_of(maker, mean, act),
                        "kind": kind_of(maker, mean, act, code)})
        buf.clear()

    for ln in text.splitlines():
        m = re.match(r"^#{1,4}\s+(.*)$", ln)
        if m:
            flush()
            maker = m.group(1).strip()
            continue
        if ln.strip().startswith("|"):
            buf.append(ln)
        else:
            flush()
            b = re.match(r"^\s*[-*]\s*`?([A-Z0-9][A-Z0-9\-_.]{0,15})`?\s*[:：\-]\s*(.+)$", ln)
            if b:
                out.append({"code": b.group(1), "meaning": b.group(2).strip(),
                            "action": "", "maker": maker,
                            "tags": tags_of(maker, b.group(2)),
                            "kind": kind_of(maker, b.group(2))})
    flush()
    seen, uniq = set(), []
    for c in out:
        k = (c["maker"], c["code"])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(c)
    return uniq


def parse_procedures(path):
    if not os.path.exists(path):
        return []
    text = read(path)
    parts, cur = [], None
    for ln in text.splitlines():
        m = re.match(r"^#{2,3}\s+(.*)$", ln)
        if m:
            if cur:
                parts.append(cur)
            cur = {"title": m.group(1).strip(), "lines": []}
        elif cur:
            cur["lines"].append(ln)
    if cur:
        parts.append(cur)

    out = []
    for p in parts:
        body = "\n".join(p["lines"]).strip()
        if not body:
            continue
        hit = blocked(p["title"])
        if hit:
            EXCLUDED.append((p["title"], hit))
            continue
        steps = [re.sub(r"^\s*(\d+[.)]|[-*])\s*", "", l).strip()
                 for l in p["lines"] if re.match(r"^\s*(\d+[.)]|[-*])\s+\S", l)]
        out.append({"title": p["title"], "body": body, "steps": steps[:20],
                    "tags": tags_of(p["title"], body),
                    "kind": kind_of(p["title"], body[:600])})
    return out


def parse_manuals(path):
    if not os.path.exists(path):
        return []
    lines = read(path).splitlines()
    header, rows = table_rows(lines)
    out = []
    for r in rows:
        title = next((c for c in r if c.strip()), "")
        if not title:
            continue
        hit = blocked(" ".join(r))
        if hit:
            EXCLUDED.append((title, hit))
            continue
        out.append({"title": re.sub(r"[`*\[\]]", "", title).strip(),
                    "note": " · ".join(c for c in r[1:] if c.strip())[:160],
                    "tags": tags_of(*r), "kind": kind_of(*r)})
    if not out:
        for ln in lines:
            b = re.match(r"^\s*[-*]\s+(.+)$", ln)
            if b:
                hit = blocked(b.group(1))
                if hit:
                    EXCLUDED.append((b.group(1).strip(), hit))
                    continue
                out.append({"title": b.group(1).strip(), "note": "",
                            "tags": tags_of(b.group(1)), "kind": kind_of(b.group(1))})
    return out


def build_docs(src_dir, strict):
    docs = []
    if not os.path.isdir(src_dir):
        return docs
    for name in sorted(os.listdir(src_dir)):
        p = os.path.join(src_dir, name)
        if not os.path.isfile(p):
            continue
        if os.path.splitext(name)[1].lower() not in (".txt", ".md"):
            continue
        hit = blocked(p)
        if hit:
            EXCLUDED.append((name, hit))
            continue
        low = name.lower()
        if strict and not any(w in low for w in MANUAL_HINT):
            EXCLUDED.append((name, "매뉴얼 아님(--all 로 포함 가능)"))
            continue
        text = read(p).strip()
        if len(text) < 40:
            continue
        did = hashlib.md5(name.encode("utf-8")).hexdigest()[:10]
        title = unicodedata.normalize("NFC", os.path.splitext(name)[0])
        docs.append({"id": did, "title": title, "source": name,
                     "tags": tags_of(title, text[:4000]),
                     "kind": kind_of(title, text[:1500]), "text": text})
    return docs


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    base = args[0] if args else "."
    dry = "--dry" in flags
    strict = "--all" not in flags      # 기본은 매뉴얼 힌트가 있는 파일만

    kb = os.path.join(base, "_지식베이스")
    if not os.path.isdir(kb):
        kb = base
    print(f"소스: {kb}")
    print(f"모드: {'전체 텍스트 포함(--all)' if not strict else '매뉴얼 관련 파일만'}\n")

    codes = parse_codes(os.path.join(kb, "에러코드_사전.md"))
    procs = parse_procedures(os.path.join(kb, "현장조치_절차서.md"))
    manuals = parse_manuals(os.path.join(kb, "MANUAL_INDEX.md"))
    docs = build_docs(os.path.join(kb, "원문텍스트"), strict)

    equip = sorted({t for src in (codes, procs, manuals, docs) for it in src
                    for t in it.get("tags", [])},
                   key=lambda k: (k.split("-")[0], int(k.split("-")[1])))

    print(f"포함: 코드 {len(codes)} / 절차 {len(procs)} / 매뉴얼색인 {len(manuals)} / 원문 {len(docs)}")
    print(f"설비 태그 {len(equip)}종")

    if EXCLUDED:
        print(f"\n제외 {len(EXCLUDED)}건 (사유별):")
        by = {}
        for name, why in EXCLUDED:
            by.setdefault(why, []).append(name)
        for why, names in sorted(by.items(), key=lambda x: -len(x[1])):
            print(f"  [{why}] {len(names)}건")
            for n in names[:5]:
                print(f"      - {n}")
            if len(names) > 5:
                print(f"      ... 외 {len(names)-5}건")
    else:
        print("\n제외된 파일 없음")

    if dry:
        print("\n--dry 모드: 파일을 쓰지 않았습니다.")
        return

    os.makedirs(os.path.join(OUT, "docs"), exist_ok=True)
    for f in os.listdir(os.path.join(OUT, "docs")):
        os.remove(os.path.join(OUT, "docs", f))

    index = {
        "builtAt": datetime.datetime.now().isoformat(timespec="seconds"),
        "codes": codes, "procedures": procs, "manuals": manuals,
        "equipment": [{"key": k, "kind": KIND.get(k.split("-")[0], k)} for k in equip],
        "docCount": len(docs),
    }
    with open(os.path.join(OUT, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, separators=(",", ":"))
    for d in docs:
        with open(os.path.join(OUT, "docs", d["id"] + ".json"), "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, separators=(",", ":"))

    size = os.path.getsize(os.path.join(OUT, "index.json")) / 1024
    total = size + sum(os.path.getsize(os.path.join(OUT, "docs", f))
                       for f in os.listdir(os.path.join(OUT, "docs"))) / 1024
    print(f"\n생성 완료 — index.json {size:.0f}KB / 전체 {total/1024:.1f}MB")
    if size > 2048:
        print("주의: index.json 이 2MB를 넘습니다. 휴대폰 첫 로딩이 느려집니다.")


if __name__ == "__main__":
    main()
