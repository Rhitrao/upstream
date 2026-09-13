"""Whether a source's run is fit to upload, decided before anything is sent.

A scraper returning nothing must never look like a quiet day. DPIIT is the largest
source and its site has been seen answering 403; a portfolio page that is redesigned
returns zero cards without raising anything. Uploading that run would not delete
companies, but it would record the source as healthy and let the page call its data
current.

So each source is judged against its own last good run:

    failed       the scraper raised
    quarantined  it returned zero records, or fewer than half its last good count
    ok           otherwise, including a first run with no history to compare against

A failed or quarantined source uploads nothing, so the rows it put on the page last
time stay as they are. The run still uploads the healthy sources, records every
verdict with /api/source-runs, and exits non-zero so the Actions job goes red.
"""

from __future__ import annotations

import dataclasses
import json

import requests

from ingest.upload import TIMEOUT_SECONDS, ingest_key

OK = "ok"
QUARANTINED = "quarantined"
FAILED = "failed"

# A source that returns under half of what it returned last time has more likely broken
# than shrunk. Portfolios and registers grow; they do not halve overnight.
DROP_RATIO = 0.5


@dataclasses.dataclass(slots=True)
class Verdict:
    source: str
    status: str
    records: int
    previous: int | None = None
    data_as_of: str | None = None
    reason: str | None = None

    def payload(self) -> dict:
        return {k: v for k, v in dataclasses.asdict(self).items() if v is not None}


def judge(source: str, records: int, previous: int | None, data_as_of: str | None = None) -> Verdict:
    if records == 0:
        return Verdict(source, QUARANTINED, 0, previous, data_as_of, "returned no records")
    if previous and records < previous * DROP_RATIO:
        return Verdict(
            source,
            QUARANTINED,
            records,
            previous,
            data_as_of,
            f"returned {records} records against {previous} at its last good run",
        )
    return Verdict(source, OK, records, previous, data_as_of)


def failed(source: str, error: str) -> Verdict:
    return Verdict(source, FAILED, 0, reason=error[:300] or "the scraper raised")


def history(base_url: str) -> dict[str, dict]:
    """Each source's last good run, as the Worker has it. Empty if it cannot be read.

    Unreadable history is not a reason to stop: the zero-records check needs none, and
    a first run has none either. It is said out loud, because it disables the drop check.
    """
    try:
        response = requests.get(f"{base_url.rstrip('/')}/api/sources", timeout=TIMEOUT_SECONDS)
        response.raise_for_status()
        return {row["source"]: row for row in response.json()}
    except (requests.RequestException, ValueError, KeyError, TypeError) as error:
        print(f"  could not read source history ({error}); only the zero-records check applies this run")
        return {}


def record(base_url: str, verdicts: list[Verdict]) -> None:
    response = requests.post(
        f"{base_url.rstrip('/')}/api/source-runs",
        headers={"content-type": "application/json", "X-Ingest-Key": ingest_key()},
        data=json.dumps({"runs": [v.payload() for v in verdicts]}),
        timeout=TIMEOUT_SECONDS,
    )
    if response.status_code != 200:
        # Loud, not fatal: the verdicts are also in the log and the exit code.
        print(f"  could not record source health: {response.status_code} {response.text[:200]}")
