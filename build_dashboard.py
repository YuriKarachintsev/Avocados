#!/usr/bin/env python3
"""Regenerate dashboard.html from the avocado dataset.

Usage:
    python3 build_dashboard.py                       # default input -> dashboard.html
    python3 build_dashboard.py path/to/new_data.xlsx  # .xlsx, .xls or .csv
    python3 build_dashboard.py data.csv -o out.html --cdn

The script cleans the data (trims stray spaces in column names and labels,
checks for missing values, duplicates and gaps), tags each region with its
aggregation level, and embeds the compacted rows as JSON in a single
self-contained HTML file. All aggregation happens in the browser.

By default ECharts is inlined from vendor/echarts.min.js so the file works
offline. --cdn links it from cdnjs instead (smaller file, needs internet).
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
DEFAULT_INPUT = HERE / "data" / "Avocados_quarterly_2015-2022.xlsx"
TEMPLATE = HERE / "dashboard_template.html"
ECHARTS_FILE = HERE / "vendor" / "echarts.min.js"
ECHARTS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/echarts/5.5.1/echarts.min.js"

# Column aliases, matched after lowercasing and replacing spaces with underscores.
ALIASES = {
    "date": "date",
    "average_price": "price", "averageprice": "price", "avg_price": "price", "price": "price",
    "total_volume": "volume", "totalvolume": "volume", "volume": "volume",
    "type": "type",
    "region": "region",
}

# Aggregation levels for region labels used in the Hass Avocado Board data.
# Anything not listed counts as a metro area.
NATIONAL = {"TotalUS"}
MULTI_STATE = {"West", "Plains", "SouthCentral", "Southeast", "Northeast",
               "GreatLakes", "Midsouth", "NorthernNewEngland"}
STATES = {"California", "SouthCarolina"}
# Known containment between labels at different levels (parent -> children).
# TotalUS and multi-state regions are treated as containing everything below
# them, so they are never summed with lower levels.
STATE_CHILDREN = {
    "California": {"LosAngeles", "SanDiego", "Sacramento", "SanFrancisco"},
}
LEVEL_RANK = {"National": 0, "Multi-state region": 1, "State": 2, "Metro": 3}


def level_of(region):
    if region in NATIONAL:
        return "National"
    if region in MULTI_STATE:
        return "Multi-state region"
    if region in STATES:
        return "State"
    return "Metro"


def load(path):
    path = Path(path)
    if path.suffix.lower() in (".xlsx", ".xls", ".xlsm"):
        df = pd.read_excel(path, sheet_name=0)
        try:
            notes = pd.read_excel(path, sheet_name="Notes").iloc[:, 0].dropna().astype(str).tolist()
        except (ValueError, KeyError):
            notes = []
    else:
        df, notes = pd.read_csv(path), []
    return df, notes


def clean(df):
    report = []
    rename = {}
    for c in df.columns:
        key = str(c).strip().lower().replace(" ", "_")
        if key in ALIASES:
            rename[c] = ALIASES[key]
        if str(c) != str(c).strip():
            report.append(f"column name {str(c)!r} had stray whitespace")
    df = df.rename(columns=rename)
    missing_cols = {"date", "price", "volume", "type", "region"} - set(df.columns)
    if missing_cols:
        sys.exit(f"ERROR: missing required columns {sorted(missing_cols)}; found {list(df.columns)}")
    df = df[["date", "price", "volume", "type", "region"]].copy()

    for c in ("type", "region"):
        raw = df[c].astype(str)
        dirty = (raw != raw.str.strip()).sum()
        if dirty:
            report.append(f"{dirty} '{c}' labels had stray whitespace (trimmed)")
        df[c] = raw.str.strip()
    df["type"] = df["type"].str.lower()
    df["date"] = pd.to_datetime(df["date"])
    df["price"] = pd.to_numeric(df["price"], errors="coerce")
    df["volume"] = pd.to_numeric(df["volume"], errors="coerce")

    n_missing = int(df.isna().any(axis=1).sum())
    if n_missing:
        report.append(f"dropped {n_missing} rows with missing/invalid values")
        df = df.dropna()
    bad = (df["price"] <= 0) | (df["volume"] < 0)
    if bad.any():
        report.append(f"dropped {int(bad.sum())} rows with non-positive price or negative volume")
        df = df[~bad]

    key = ["date", "type", "region"]
    dups = df.duplicated(key, keep="last")
    if dups.any():
        report.append(f"dropped {int(dups.sum())} duplicate date/type/region rows (kept last)")
        df = df[~dups]

    full = len(df["date"].unique()) * len(df["type"].unique()) * len(df["region"].unique())
    if full != len(df):
        report.append(f"grid has gaps: {full - len(df)} of {full} date/type/region combinations missing")
    return df.sort_values(key).reset_index(drop=True), report


def detect_frequency(dates):
    diffs = pd.Series(sorted(dates)).diff().dt.days.dropna()
    med = diffs.median() if len(diffs) else 0
    if med <= 10:
        return "W"
    if med <= 45:
        return "M"
    return "Q"


def build_payload(df, notes, source):
    dates = sorted(df["date"].unique())
    types = sorted(df["type"].unique())
    regions = sorted(df["region"].unique(), key=lambda r: (LEVEL_RANK[level_of(r)], r))
    present = set(regions)

    # Containment pairs among the regions actually present.
    contains = []
    for p in regions:
        lp = level_of(p)
        for c in regions:
            if c == p:
                continue
            lc = level_of(c)
            if lp == "National" and lc != "National":
                contains.append([p, c])
            elif lp == "Multi-state region" and LEVEL_RANK[lc] > LEVEL_RANK[lp]:
                contains.append([p, c])
            elif c in STATE_CHILDREN.get(p, ()):
                contains.append([p, c])

    nat = [r for r in regions if level_of(r) == "National"]
    if nat:
        default = nat[:1]
        default_label = nat[0]
    else:
        # Default to every region that is not contained in another one.
        children = {c for _, c in contains}
        default = [r for r in regions if r not in children]
        default_label = f"All {len(default)} regions (sample total, not national)"

    di = {d: i for i, d in enumerate(dates)}
    ti = {t: i for i, t in enumerate(types)}
    ri = {r: i for i, r in enumerate(regions)}
    rows = [[di[d], ti[t], ri[r], round(float(p), 4), round(float(v), 2)]
            for d, t, r, p, v in df[["date", "type", "region", "price", "volume"]].itertuples(index=False)]

    return {
        "dates": [pd.Timestamp(d).strftime("%Y-%m-%d") for d in dates],
        "freq": detect_frequency(dates),
        "types": types,
        "regions": [{"name": r, "level": level_of(r)} for r in regions],
        "contains": [[ri[p], ri[c]] for p, c in contains if p in present and c in present],
        "defaultRegions": [ri[r] for r in default],
        "defaultLabel": default_label,
        "rows": rows,
        "meta": {
            "source": Path(source).name,
            "built": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
            "notes": notes,
            "synthetic": any("synthetic" in n.lower() for n in notes),
        },
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", nargs="?", default=str(DEFAULT_INPUT), help="xlsx/xls/csv file")
    ap.add_argument("-o", "--output", default=str(HERE / "dashboard.html"))
    ap.add_argument("--cdn", action="store_true", help="load ECharts from CDN instead of inlining it")
    args = ap.parse_args()

    raw, notes = load(args.input)
    df, report = clean(raw)
    payload = build_payload(df, notes, args.input)

    print(f"Input: {args.input}")
    print(f"  rows: {len(raw)} raw -> {len(df)} clean")
    print(f"  dates: {payload['dates'][0]} .. {payload['dates'][-1]} "
          f"({len(payload['dates'])} dates, frequency {payload['freq']})")
    print(f"  types: {payload['types']}")
    levels = {}
    for r in payload["regions"]:
        levels.setdefault(r["level"], []).append(r["name"])
    for lvl, names in levels.items():
        print(f"  {lvl} ({len(names)}): {', '.join(names)}")
    print(f"  overlapping region pairs: {len(payload['contains'])}")
    print(f"  default regions: {payload['defaultLabel']}")
    for line in report:
        print(f"  note: {line}")

    data_json = json.dumps(payload, separators=(",", ":")).replace("</", "<\\/")
    if args.cdn:
        lib = f'<script src="{ECHARTS_CDN}"></script>'
    else:
        lib = "<script>" + ECHARTS_FILE.read_text(encoding="utf-8").replace("</script", "<\\/script") + "</script>"
    html = TEMPLATE.read_text(encoding="utf-8")
    html = html.replace("<!--__ECHARTS__-->", lib).replace("/*__DATA__*/", data_json)
    Path(args.output).write_text(html, encoding="utf-8")
    print(f"Wrote {args.output} ({Path(args.output).stat().st_size / 1024:.0f} KB, "
          f"ECharts {'via CDN' if args.cdn else 'inlined, works offline'})")


if __name__ == "__main__":
    main()
