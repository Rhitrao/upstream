"""The RDI taxonomy, flattened.

Reads the same rdi-taxonomy.json as src/taxonomy.ts. Never copy or shorten the list
here, or the classifier drifts from the coverage map.

Run directly to check the counts: python3 ingest/taxonomy.py
"""

import json
import pathlib

TAXONOMY = json.loads(
    (pathlib.Path(__file__).parent.parent / "rdi-taxonomy.json").read_text(encoding="utf-8")
)


def flatten(taxonomy):
    return [
        {
            "sector_id": sector["id"],
            "sector": sector["short"],
            "sector_type": sector["type"],
            "subsector_id": sub["id"],
            "subsector": sub["name"],
            "projects": sub["projects"],
        }
        for sector in taxonomy["sectors"]
        for sub in sector["subsectors"]
    ]


SUBSECTORS = flatten(TAXONOMY)


def summary():
    sunrise_sectors = sum(1 for s in TAXONOMY["sectors"] if s["type"] == "sunrise")
    sunrise = sum(1 for e in SUBSECTORS if e["sector_type"] == "sunrise")
    return f"{sunrise} sunrise sub-sectors across {sunrise_sectors} sectors, {len(SUBSECTORS)} total"


if __name__ == "__main__":
    print(summary())
