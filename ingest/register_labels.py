"""Which RDI sub-sectors a list's label can put a company in, by itself: a DPIIT register
label, or the category a BIRAC grant list filed an award under.

A register record is a name, an industry the founder picked from a dropdown, a
sector picked from a second one, and a stage. Given that and nothing else, the
classifier still names a sub-sector, because the prompt asks for one — and five
companies labelled "AI / NLP" went into AI in Healthcare on the strength of NLP
having a use in health records. The classifier's own notes said the healthcare
focus "would need clarification". A label that says NLP says nothing about health.

So a sub-sector chosen from a label alone stands only where the label names that
sub-sector's own subject: "Space Technology" names Space Technologies, "Robotics"
names both sub-sectors with robotics in the title. A label that names a customer
("Manufacturing & Warehouse" under Internet of Things), a method with uses
everywhere ("Machine Learning", "Computer Vision"), or a field the taxonomy has no
sub-sector for ("Drones", "Renewable Energy") supports nothing, and the company is
left unplaced rather than placed by a guess.

Every entry below is a hand judgement, checked against rdi-taxonomy.json, and the
test pins the table. A label that is not in the table supports nothing: a new
dropdown value has to be read by a person before it can place anyone.

Costs nothing. The classifier's cached answer is kept; this decides whether it is
published.
"""

from __future__ import annotations

import re

# Lower-cased register label -> the sub-sectors it names. Industries and sectors share
# the table: the register uses the same vocabulary for both, and a record is
# supported by the union of what its industry and its sectors name.
SUPPORTS: dict[str, frozenset[str]] = {
    # 2.6 Advanced Materials lists "Nanomaterials".
    "nanotechnology": frozenset({"2.6"}),
    # 4.1 Biotechnology & Life Sciences. Not 4.3: "industrial biotech" is narrower.
    "biotechnology": frozenset({"4.1"}),
    # 2.3 Advanced Manufacturing & Robotics and 2.7 Intelligent Systems & Robotics.
    "robotics": frozenset({"2.3", "2.7"}),
    "robotics technology": frozenset({"2.3", "2.7"}),
    "robotics application": frozenset({"2.3", "2.7"}),
    # 2.5 Space Technologies.
    "space technology": frozenset({"2.5"}),
    # 2.2 Semiconductors & Electronics.
    "semiconductor": frozenset({"2.2"}),
    "electronics": frozenset({"2.2"}),
    # Both 2.3 and 2.6 list "Metal / multi-material 3D printing".
    "3d printing": frozenset({"2.3", "2.6"}),
    # 5.2 Digital Agriculture (AgriTech).
    "agri-tech": frozenset({"5.2"}),
    # 4.4 Pharmaceuticals & Drug Development.
    "pharmaceutical": frozenset({"4.4"}),
    # BIRAC BIG award categories (grants_csv.CATEGORY_LINE), judged the same way on 15 Sep 2026.
    # 4.5 Medical Devices & Diagnostics, by name.
    "medical devices": frozenset({"4.5"}),
    "diagnostics": frozenset({"4.5"}),
    "medical devices and diagnostics": frozenset({"4.5"}),
    # 4.4 Pharmaceuticals & Drug Development. Not 4.7: "drugs" does not name biologics.
    "drugs and related areas": frozenset({"4.4"}),
    # 4.3 Synthetic Biology & Industrial Biotech names the first of the three; clean energy
    # and environment each span a dozen sub-sectors, so they name none.
    "industrial biotechnology, clean energy & environment": frozenset({"4.3"}),
}

# Read by a person and judged to name no sub-sector. Not consulted — anything absent
# from SUPPORTS supports nothing — but kept so the test can say every label the
# register has sent us was looked at, rather than silently missed.
NAMES_NOTHING: frozenset[str] = frozenset(
    {
        "ai",
        "machine learning",
        "nlp",
        "computer vision",
        "aeronautics aerospace & defence",
        "aviation & others",
        "defence equipment",
        "drones",
        "internet of things",
        "manufacturing & warehouse",
        "smart home",
        "wearables",
        "green technology",
        "clean tech",
        "waste management",
        "renewable energy",
        "renewable energy solutions",
        "renewable solar energy",
        "manufacture of electrical equipment",
        "manufacture of machinery and equipment",
        "technology hardware",
        "manufacturing",
        "embedded",
        "construction & engineering",
        "it consulting",
        "ooh media",
        "skill development",
        "microbrewery",
        # BIRAC: agriculture is a field of application with sub-sectors in three sectors.
        "agriculture and allied areas",
    }
)

# The shape dpiit._description writes. Parsed back here rather than carried as extra
# fields, so the one string the classifier saw is the one string judged.
_INDUSTRY = re.compile(r"Industry: (.+?)\.(?: Sector:| Stage:|$)")
_SECTOR = re.compile(r"Sector: (.+?)\.(?: Stage:|$)")
_CATEGORY = re.compile(r"awardee, category: (.+?)\.$")


def labels(description: str | None) -> list[str]:
    """The industry and sector labels in a register description, lower-cased."""
    if not description:
        return []
    found: list[str] = []
    if match := _INDUSTRY.search(description):
        found.append(match.group(1).strip().lower())
    if match := _SECTOR.search(description):
        found.extend(s.strip().lower() for s in match.group(1).split(", ") if s.strip())
    # A grant category is one label, commas and all: "Industrial Biotechnology, Clean Energy & Environment".
    if match := _CATEGORY.search(description.strip()):
        found.append(match.group(1).strip().lower())
    return found


def supported(description: str | None) -> frozenset[str]:
    """Every sub-sector the labels in this description name."""
    out: set[str] = set()
    for label in labels(description):
        out |= SUPPORTS.get(label, frozenset())
    return frozenset(out)


def supports(description: str | None, subsector_id: str | None) -> bool:
    return subsector_id is not None and subsector_id in supported(description)


def unsupported_note(description: str | None, subsector_id: str, subsector_name: str) -> str:
    said = " / ".join(labels(description)) or "nothing"
    return (
        f"{'The grant list' if _CATEGORY.search((description or '').strip()) else 'The register'}'s labels ({said}) do not name {subsector_id} {subsector_name}. The classifier picked it "
        f"from the label alone; that is a guess, so the company is left unplaced rather than published there."
    )
