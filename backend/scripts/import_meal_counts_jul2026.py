"""One-shot importer for the "Sailors and Staff food consumption" spreadsheet
(shipped as `/app/backend/data/food_consumption_2026-07.xlsx`).

Sums up the three cohort blocks (MJPTBC-WRES, Sailors, Staff) for each
of Breakfast / Lunch / Dinner and stores one row per date in the
`meal_daily_counts` collection, matching the format the Meals Calendar
UI expects.

Rerun-safe — every row is upserted by `date`.

Usage:
    cd /app/backend && python -m scripts.import_meal_counts_jul2026 [/path/to/xlsx]

If no path is given, `/app/backend/data/food_consumption_2026-07.xlsx` is used.
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient


DEFAULT_XLSX = Path(__file__).resolve().parents[1] / "data" / "food_consumption_2026-07.xlsx"


def _parse(xlsx_path: Path) -> list[dict]:
    """Read the 'July 2026' sheet and return a list of daily count docs."""
    df = pd.read_excel(xlsx_path, sheet_name="July 2026", header=[0, 1])
    # Columns 1..3 = MJPTBCWRES B/L/D
    # Columns 5..7 = Sailors    B/L/D
    # Columns 9..11 = Staff     B/L/D
    docs: list[dict] = []
    for _, row in df.iterrows():
        raw_date = row.iloc[0]
        if pd.isna(raw_date):
            continue
        try:
            iso = pd.to_datetime(raw_date).date().isoformat()
        except Exception:
            continue
        # Only care about calendar rows, skip the aggregate "total" row.
        if not iso.startswith("20"):
            continue

        def _n(idx):
            v = row.iloc[idx]
            return int(v) if pd.notna(v) and str(v) != "" else 0

        breakfast = _n(1) + _n(5) + _n(9)
        lunch     = _n(2) + _n(6) + _n(10)
        dinner    = _n(3) + _n(7) + _n(11)
        total = breakfast + lunch + dinner
        if breakfast == 0 and lunch == 0 and dinner == 0:
            continue    # skip empty rows
        docs.append({
            "date": iso,
            "breakfast": breakfast,
            "lunch": lunch,
            "dinner": dinner,
            "total": total,
            "source": "spreadsheet-jul2026",
        })
    return docs


async def _apply(docs: list[dict]) -> None:
    load_dotenv("/app/backend/.env")
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    written = 0
    for d in docs:
        r = await db.meal_daily_counts.update_one(
            {"date": d["date"]},
            {"$set": d, "$setOnInsert": {"id": str(uuid.uuid4())}},
            upsert=True,
        )
        written += 1 if (r.upserted_id or r.modified_count) else 0
    print(f"✔ Upserted {written}/{len(docs)} daily-count rows")
    # Sanity: dump a preview of the first + last row
    if docs:
        first = await db.meal_daily_counts.find_one({"date": docs[0]["date"]}, {"_id": 0})
        last = await db.meal_daily_counts.find_one({"date": docs[-1]["date"]}, {"_id": 0})
        print(f"  first row: {first}")
        print(f"  last row:  {last}")


def main() -> None:
    xlsx = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_XLSX
    if not xlsx.exists():
        print(f"✗ spreadsheet not found at {xlsx}", file=sys.stderr)
        sys.exit(1)
    docs = _parse(xlsx)
    if not docs:
        print("✗ parsed 0 rows — spreadsheet layout may have changed", file=sys.stderr)
        sys.exit(1)
    print(f"Parsed {len(docs)} rows from {xlsx.name}. Grand-total meal count = "
          f"{sum(d['total'] for d in docs):,}")
    asyncio.run(_apply(docs))


if __name__ == "__main__":
    main()
