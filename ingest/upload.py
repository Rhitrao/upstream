"""Send companies and signals to the Worker.

Batches of 50, because D1 binds at most 100 parameters per statement and one
company is a lot of columns. Signals travel in the same batch as their company:
the endpoint refuses a signal whose company it has not seen, so splitting them
apart would silently drop the evidence and keep the row.

Anything but a 200 stops the run and prints what the server said. A pipeline that
swallows an upload error leaves a page that looks fine and is stale.

    INGEST_KEY=... python3 -m ingest.upload payload.json --base-url http://127.0.0.1:8788/upstream
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import pathlib

import requests

from ingest.sources.base import Company, Signal, payload

PRODUCTION = "https://rohitrao.in/upstream"
BATCH = 50
TIMEOUT_SECONDS = 60


class UploadError(RuntimeError):
    """The server said no. The run stops here, loudly."""


def ingest_key() -> str:
    """From the environment, or the .dev.vars the Worker already uses locally."""
    key = os.environ.get("INGEST_KEY")
    if key:
        return key.strip()

    dev_vars = pathlib.Path(__file__).parent.parent / ".dev.vars"
    if dev_vars.exists():
        for line in dev_vars.read_text(encoding="utf-8").splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "INGEST_KEY" and value.strip():
                return value.strip()

    raise UploadError("no INGEST_KEY in the environment or .dev.vars")


def batches(companies: list[Company], signals: list[Signal], gaps: list[dict], size: int = BATCH):
    """Companies in slices of `size`, each carrying its own signals.

    Gaps ride along in slices of their own: they are keyed by company id and
    reference nothing, so they do not have to travel with anything. Where one
    list runs out first the other keeps going, which is the normal case — a run
    has far more gaps than it has batches of companies, or the reverse.
    """
    by_company: dict[str, list[Signal]] = {}
    for signal in signals:
        by_company.setdefault(signal.company_id, []).append(signal)

    company_chunks = [companies[i : i + size] for i in range(0, len(companies), size)] or [[]]
    gap_chunks = [gaps[i : i + size] for i in range(0, len(gaps), size)] or [[]]

    for chunk, gap_chunk in itertools.zip_longest(company_chunks, gap_chunks, fillvalue=[]):
        yield chunk, [s for c in chunk for s in by_company.get(c.id, [])], gap_chunk


def upload(
    source: str,
    companies: list[Company],
    signals: list[Signal],
    gaps: list[dict] | None = None,
    *,
    base_url: str = PRODUCTION,
    key: str | None = None,
    mode: str | None = None,
    size: int = BATCH,
    merged: list[dict] | None = None,
) -> list[dict]:
    """Post everything, one batch at a time. Returns what the server said to each."""
    url = f"{base_url.rstrip('/')}/api/ingest"
    headers = {"content-type": "application/json", "X-Ingest-Key": key or ingest_key()}
    results = []

    for chunk, chunk_signals, chunk_gaps in batches(companies, signals, gaps or [], size):
        body = {
            "source": source,
            "companies": [payload(c) for c in chunk],
            "signals": [payload(s) for s in chunk_signals],
            "gaps": chunk_gaps,
        }
        # The Worker decides whether a run is a backfill by looking at what this
        # source has done before, and it is chunk-aware; mode is here for the
        # case that inference cannot cover, which is re-seeding a wiped history.
        if mode is not None:
            body["mode"] = mode
        # Once, with the first batch: {from, into} pairs the Worker folds together.
        if merged:
            body["merged"], merged = merged, None

        response = requests.post(url, headers=headers, data=json.dumps(body), timeout=TIMEOUT_SECONDS)
        if response.status_code != 200:
            raise UploadError(f"{response.status_code} from {url}: {response.text[:400]}")

        result = response.json()
        results.append(result)
        print(f"  {source}: {len(chunk)} companies, {len(chunk_signals)} signals, {len(chunk_gaps)} gaps -> {result}")

    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("payload", help="a JSON file: {source, companies: [...], signals: [...]}")
    parser.add_argument("--base-url", default=PRODUCTION)
    parser.add_argument("--mode", choices=["backfill", "live"], help="override what the Worker would infer")
    args = parser.parse_args()

    data = json.loads(pathlib.Path(args.payload).read_text(encoding="utf-8"))
    upload(
        data["source"],
        [Company(**c) for c in data.get("companies", [])],
        [Signal(**s) for s in data.get("signals", [])],
        data.get("gaps", []),
        base_url=args.base_url,
        mode=args.mode,
    )
