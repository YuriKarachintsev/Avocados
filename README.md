# Avocado Market Dashboard

An interactive dashboard of avocado prices and volumes in a single file, `dashboard.html`.

## Open it

Double-click `dashboard.html`. It opens in any modern browser (Chrome, Edge, Firefox, Safari) with no server and no build step.
The data and the charting library (Apache ECharts 5.5.1) are inlined, so the file **works offline**.

## Regenerate with new data

Requires Python 3.9+ with `pandas` and `openpyxl`:

```bash
pip install pandas openpyxl
python3 build_dashboard.py                          # uses data/Avocados_quarterly_2015-2022.xlsx
python3 build_dashboard.py path/to/new_file.xlsx    # or .xls / .csv
python3 build_dashboard.py new.csv -o other.html    # custom output path
python3 build_dashboard.py --cdn                    # load ECharts from cdnjs instead of inlining (~90 KB file, needs internet)
```

The input needs these columns: `date`, `average_price`, `total_volume`, `type`, `region`.
Spaces and case in the column names don't matter.

On each run, the script:
- trims stray whitespace in column names and labels
- drops rows with missing or invalid values and duplicate date/type/region rows, and tells you how many
- reports gaps in the date × type × region grid
- detects the data frequency (weekly, monthly or quarterly)
- tags each region with its aggregation level

It prints a short data report, then writes `dashboard.html`.

All aggregation happens in the browser from the embedded rows, so new regions, dates or a finer frequency (for example weekly data) are picked up automatically.

## Files

| File | Purpose |
|---|---|
| `dashboard.html` | The generated dashboard (self-contained) |
| `build_dashboard.py` | Cleans the data and writes the HTML |
| `dashboard_template.html` | Layout, styles and chart code; the script fills in the data |
| `vendor/echarts.min.js` | ECharts 5.5.1 (Apache-2.0, see `vendor/ECHARTS_LICENSE`), inlined at build time |
| `data/` | Source workbook |

## How the numbers are calculated

- **Average price** is volume-weighted: Σ(price × volume) ÷ Σ volume, across regions, types and periods.
- **Estimated revenue** = Σ(price × volume). It is an estimate, not reported revenue.
- **Volume** totals add up the observations in the selected range. Each row is one dated reading, so a "yearly" total is the sum of that year's readings, not a full-year sales figure.
- **KPI change** compares against the period of equal length immediately before the selection. With "All" selected there is no earlier period.
- **Year-over-year** compares the same seasons (quarters) in the previous year.
- **Region levels**: regions are tagged National, Multi-state region, State or Metro. A region inside another selected region (e.g. a metro inside its state, or anything inside `TotalUS`) is left out of totals so nothing is double counted. In this dataset, California (state) and the 13 metros don't overlap, so the default is all 14 regions combined. That is a sample total, not a national figure.
- **Elasticity** is the slope of a log-log fit of volume on price. It is a rough approximation, not a causal estimate. The default "within-region" view first removes each region/type's average level.

## Caveats about this dataset

- The workbook's `Notes` sheet says rows 29–896 are **synthetic** and not real market figures. The dashboard shows a banner saying so.
- The data is **quarterly** (4 Jan/Apr/Jul/Oct, 2015–2022), so weekly and monthly granularity are greyed out. Seasonality is shown by quarter.
- Volume grows over time while prices follow a yearly index. That trend mixes into the price–volume fit, which is why organic shows a slightly positive "elasticity".
