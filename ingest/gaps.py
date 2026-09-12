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

# The one group that is not a hole in the taxonomy.
#
# The classifier keeps naming the thing it lacked rather than the field the
# taxonomy lacked: "company technology details", "application domain
# specification", "insufficient company information". Those are 147 companies
# whose published description was a name and a dropdown industry — a fact about
# our sources, not about the RDI scheme. Filed under a name that says so, and
# the page gives it its own section rather than counting it as a taxonomy gap.
#
# src/page.ts splits on this exact string. A test asserts it survives a regroup.
NO_GAP_NAMED = "no gap named"
# Not committed; it is a debugging aid for the one call that costs real money.
RAW_PATH = pathlib.Path(__file__).parent / "cache" / "regroup-response.json"

# One call over ~170 short strings, and the result is read by people and
# committed, so this is the one place in the pipeline worth the better model.
MODEL = "claude-opus-5"

SYSTEM = f"""You are tidying the names of gaps in a government technology taxonomy.

Each input is one description of a capability the taxonomy has no place for, written by a \
classifier that saw a single company at a time. The same gap therefore appears under many \
names. Group them: give every input label a canonical group name, so that labels describing \
the same missing capability end up under the same one.

Aim for 10 to 16 groups. Name each in two to four lowercase words, as a plain noun phrase \
naming the field ("water infrastructure", "geospatial services", "digital health \
infrastructure"). Prefer the wording that already appears in the inputs. Every input label \
must appear in exactly one group.

One group is different from the others and must be named exactly "{NO_GAP_NAMED}": the labels \
that name what the COMPANY failed to say ("company technology details", "application domain \
specification", "insufficient company information") rather than a field the taxonomy lacks. \
Those are not holes in the taxonomy and must not be grouped as though they were. Put every such \
label in that one group, and no other label in it.

Each input is numbered. Answer with the numbers, not the label text: every group carries the \
list of input numbers that belong to it. Every number from 0 to N-1 must appear exactly once \
across all groups."""


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

    # Numbered, and the answer comes back as numbers. Echoing 489 labels back cost
    # more output than the model had room for once thinking was counted — it
    # stopped at max_tokens with the JSON half-written. An index is four characters.
    ordered = list(labels)
    listing = "\n".join(f"{i}. {label} ({labels[label]})" for i, label in enumerate(ordered))
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
                            # Indices into the numbered list, not the labels
                            # themselves. An enum of 489 strings is refused by
                            # the API ("Schema is too complex") and echoing them
                            # back exhausts the output budget; a bounded integer
                            # does neither, and an out-of-range one is as easy to
                            # reject as an invented string was.
                            # Bare integers: the API rejects minimum/maximum here.
                            # The range check is done on the way out instead.
                            "labels": {"type": "array", "items": {"type": "integer"}},
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

    # Every label comes back in the answer, so the output is roughly as long as the
    # input list. At 489 labels the old 16,000 ceiling was not obviously enough,
    # and a truncated response arrives as a message with no text block at all —
    # which used to surface as a bare StopIteration from the generator below.
    # Streamed because the SDK refuses a non-streaming call that could run past ten
    # minutes, and a 32,000-token ceiling qualifies. Nothing here consumes the
    # stream as it arrives; the final message is all this wants.
    with _client().messages.stream(
        model=MODEL,
        max_tokens=32000,
        system=SYSTEM,
        messages=[{"role": "user", "content": f"{len(labels)} labels to group:\n\n{listing}"}],
        output_config={"format": schema},
    ) as stream:
        response = stream.get_final_message()

    # Kept on disk before anything can fail on it: this call is the expensive part
    # of the module, and re-running it to find out what it said is a waste.
    RAW_PATH.write_text(response.model_dump_json(indent=1), encoding="utf-8")

    text = next((b.text for b in response.content if b.type == "text"), None)
    if text is None:
        kinds = ", ".join(b.type for b in response.content) or "nothing"
        raise SystemExit(
            f"The model returned no JSON (stop_reason={response.stop_reason}, blocks: {kinds}). "
            f"The full response is in {RAW_PATH}. If stop_reason is max_tokens, raise the ceiling."
        )
    answer = json.loads(text)

    mapping: dict[str, str] = {}
    invented: list[int] = []
    for group in answer["groups"]:
        for index in group["labels"]:
            if not isinstance(index, int) or not 0 <= index < len(ordered):
                invented.append(index)
                continue
            mapping.setdefault(ordered[index], group["name"].strip().lower())

    # An index pointing at nothing is not a gap anyone found. Dropped, and counted
    # out loud rather than silently — a file about holes should not have its own.
    if invented:
        print(f"{len(invented)} out-of-range indices came back and were dropped: {invented[:5]}")

    # The page reads this exact name to decide which section a group belongs in.
    # A regroup that loses it would quietly file 147 thin descriptions as holes in
    # the taxonomy, which is the claim this whole split exists to stop.
    if NO_GAP_NAMED not in set(mapping.values()):
        print(
            f"WARNING: no group came back named {NO_GAP_NAMED!r}. The labels that describe the "
            f"company rather than the taxonomy are now filed as taxonomy gaps, and the page will "
            f"present them as a finding about the RDI scheme. Rename the right group by hand."
        )

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
