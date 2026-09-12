"""Group the holes in the taxonomy by hand-checkable name.

The classifier names the missing capability one company at a time, so it names
it 169 different ways: "water distribution management", "water infrastructure
optimization", "municipal water systems". Each is a fair description and the set
of them is useless — a page listing 169 groups of one is a page nobody reads.

So one pass over the distinct labels, all of them at once, produces a canonical
name for each, and the result is written to ingest/gap-labels.json and committed.
The page then groups by exact match on something a person has read, rather than
on the wording of 169 separate calls. Edit that file by hand whenever the
grouping is wrong; nothing regenerates it unless you ask — and --regroup rewrites
it wholesale, so a hand edit has to be made again afterwards. The standing one:
the model keeps inventing a group for labels that describe the company rather
than the missing field, and that group is called "no gap named", because that is
what it is.

    python3 -m ingest.gaps --regroup    # one API call, rewrites the mapping
    python3 -m ingest.gaps              # show what the current mapping does
"""

from __future__ import annotations

import argparse
import collections
import json
import pathlib

from ingest.classify import CACHE_PATH, _client, _load

LABELS_PATH = pathlib.Path(__file__).parent / "gap-labels.json"

# One call over ~170 short strings, and the result is read by people and
# committed, so this is the one place in the pipeline worth the better model.
MODEL = "claude-opus-5"

SYSTEM = """You are tidying the names of gaps in a government technology taxonomy.

Each input is one description of a capability the taxonomy has no place for, written by a \
classifier that saw a single company at a time. The same gap therefore appears under many \
names. Group them: give every input label a canonical group name, so that labels describing \
the same missing capability end up under the same one.

Aim for 10 to 16 groups. Name each in two to four lowercase words, as a plain noun phrase \
naming the field ("water infrastructure", "geospatial services", "digital health \
infrastructure"). Prefer the wording that already appears in the inputs. Every input label \
must appear in exactly one group. Do not invent labels that were not given to you."""


def distinct_labels() -> dict[str, int]:
    """Every gap label the classifier has produced, and how often."""
    counts: collections.Counter[str] = collections.Counter()
    for entry in _load(CACHE_PATH).values():
        if entry.get("sector_id") and not entry.get("subsector_id"):
            label = (entry.get("missing") or "").strip().lower()
            if label:
                counts[label] += 1
    return dict(counts.most_common())


def regroup() -> dict[str, str]:
    """Ask once, verify, write the mapping. Returns label -> group."""
    labels = distinct_labels()
    if not labels:
        raise SystemExit("no gap labels in the classify cache yet")

    listing = "\n".join(f"- {label} ({n})" for label, n in labels.items())
    schema = {
        "type": "json_schema",
        "schema": {
            "type": "object",
            "properties": {
                "groups": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            # Constrained to the labels we actually sent, so the
                            # mapping cannot quietly acquire a gap nobody found.
                            "labels": {"type": "array", "items": {"type": "string", "enum": list(labels)}},
                        },
                        "required": ["name", "labels"],
                        "additionalProperties": False,
                    },
                }
            },
            "required": ["groups"],
            "additionalProperties": False,
        },
    }

    response = _client().messages.create(
        model=MODEL,
        max_tokens=16000,
        system=SYSTEM,
        messages=[{"role": "user", "content": f"{len(labels)} labels to group:\n\n{listing}"}],
        output_config={"format": schema},
    )
    answer = json.loads(next(b.text for b in response.content if b.type == "text"))

    mapping: dict[str, str] = {}
    for group in answer["groups"]:
        for label in group["labels"]:
            mapping.setdefault(label, group["name"].strip().lower())

    # A label the model forgot keeps its own name rather than vanishing. Said out
    # loud, because a silent gap in a file about gaps would be a poor joke.
    missed = [label for label in labels if label not in mapping]
    for label in missed:
        mapping[label] = label
    if missed:
        print(f"{len(missed)} labels were left ungrouped and keep their own name: {', '.join(missed[:5])}")

    LABELS_PATH.write_text(json.dumps(dict(sorted(mapping.items())), indent=1) + "\n", encoding="utf-8")
    usage = response.usage
    print(f"{len(labels)} labels -> {len(set(mapping.values()))} groups ({usage.input_tokens:,} in / {usage.output_tokens:,} out)")
    return mapping


def mapping() -> dict[str, str]:
    return _load(LABELS_PATH)


def canonical(label: str | None) -> str | None:
    """The group a label belongs to, or the label itself if nothing says otherwise."""
    if not label:
        return None
    cleaned = label.strip().lower()
    return mapping().get(cleaned, cleaned)


def summary() -> str:
    grouped: collections.Counter[str] = collections.Counter()
    for label, n in distinct_labels().items():
        grouped[canonical(label)] += n
    lines = [f"{sum(grouped.values())} companies, {len(grouped)} groups"]
    lines += [f"  {n:>4}  {name}" for name, n in grouped.most_common()]
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--regroup", action="store_true", help="rewrite gap-labels.json with one API call")
    args = parser.parse_args()

    if args.regroup:
        regroup()
    print(summary())
