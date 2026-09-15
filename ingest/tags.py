"""What kind of thing a company builds, and where it is used, by keyword — never by a model.

Two small vocabularies a reader can filter on, derived from the words a company or a source
used to describe it:

    build    hardware · software · biological or chemical
    domain   health · agriculture & food · energy · mobility · space & aerospace ·
             defence & security · water & environment · manufacturing & industry ·
             buildings & construction · education · finance

Read only from real descriptions: a sentence from the company's own verified homepage, or a
source's description. A list's label (the DPIIT dropdown, a BIRAC grant category) is not
read, because it is not a description, and a filter built on it would be the label again
under another name. A company with no real description gets no tags, and the page says so.

A keyword is evidence about the words, not about the company. Measured on 15 September 2026
over 437 described rows: a build tag on 70%, a domain tag on 88%, and about 85% of tags right
on a hand-read sample of 30. The misses were words with two meanings — "API" in pharma
(an active pharmaceutical ingredient), "design space", "compound semiconductor" — and each
rule below that caught one has been narrowed. A customer-type vocabulary was measured too
(36% coverage, "children" read as consumers) and dropped.

Costs nothing and is recomputed every run, so a better rule changes every row next night.
"""

from __future__ import annotations

import re


def _rx(*patterns: str) -> re.Pattern[str]:
    return re.compile("|".join(f"(?:{p})" for p in patterns), re.IGNORECASE)


BUILD: dict[str, re.Pattern[str]] = {
    "hardware": _rx(
        r"\bdevices?\b", r"\bsensors?\b", r"\brobot", r"\bdrones?\b", r"\bhardware\b", r"\bmachines?\b(?! learning)",
        r"\bequipment\b", r"\binstruments?\b", r"\bbatter(?:y|ies)\b", r"\bchips?\b", r"\bsemiconductor", r"\bvehicles?\b",
        r"\bsatellites? (?:bus|payload|constellation|hardware)", r"\bimplants?\b", r"\bprosthe", r"\bwearables?\b", r"\belectrolys[ez]rs?\b", r"\bmotors?\b",
        r"\b3d[- ]print", r"\bUAVs?\b", r"\brockets?\b", r"\blaunch vehicles?\b", r"\breactors?\b", r"\bwheelchairs?\b",
        r"\bactuators?\b", r"\blidar\b", r"\bradars?\b", r"\bantennas?\b", r"\bcircuits?\b", r"\bmicrofluidic", r"\bturbines?\b",
        r"\bchargers?\b", r"\binverters?\b", r"\bthrusters?\b", r"\bphotonic", r"\blasers?\b", r"\bspectromet", r"\bscanners?\b",
        r"\bcartridges?\b", r"\bpoint[- ]of[- ]care\b", r"\bsplints?\b", r"\borthos[ie]s", r"\bstents?\b", r"\bcatheters?\b",
        r"\bventilators?\b", r"\bkiosks?\b", r"\bIoT\b", r"\bembedded\b", r"\bmicroscopes?\b", r"\bROVs?\b", r"\bexoskeleton",
        r"\bpumps?\b", r"\bgadgets?\b", r"\bsolar (?:cells?|panels?|modules?)\b", r"\bsuperconduct", r"\belectronics\b", r"\bhumanoids?\b", r"\bheadbands?\b", r"\bair handling units?\b", r"\bcooling systems?\b", r"\brefrigerat", r"\bengine control\b", r"\bpower electronics\b",
    ),
    "software": _rx(
        r"\bsoftware\b", r"\b(?:online|digital|web|mobile|cloud|data|saas|analytics|learning|messaging) platforms?\b",
        r"\bmobile app", r"\bapps?\b", r"\bSaaS\b", r"\balgorithms?\b", r"\banalytics\b", r"\bcloud\b", r"\bdashboards?\b",
        r"\bapplication programming interface", r"\bweb[- ]based\b", r"\bmachine learning\b", r"\bdeep learning\b",
        r"\bartificial intelligence\b", r"\bAI[- ](?:powered|based|driven|tool|model|platform|system)", r"\bcomputer vision\b",
        r"\bblockchain\b", r"\bdigital twins?\b", r"\blarge language models?\b", r"\bLLMs?\b", r"\bchatbots?\b",
        r"\bmarketplace\b", r"\bportal\b", r"\bdesign automation\b", r"\bsimulation software\b",
    ),
    "biological or chemical": _rx(
        r"\bdrugs?\b", r"\bmolecul", r"\bvaccin", r"\bantibod", r"\benzym", r"\bbacteri", r"\bmicrob", r"\bcell therap",
        r"\bformulations?\b", r"\bbiomaterials?\b", r"\bferment", r"\bpeptides?\b", r"\bproteins?\b", r"\bprobiotic",
        r"\bbiologics?\b", r"\btherapeutics?\b", r"\bnanoparticles?\b", r"\bcatalysts?\b", r"\bpolymers?\b", r"\bbio-?fertili",
        r"\bbiopesticide", r"\bnutraceutical", r"\breagents?\b", r"\bassays?\b", r"\bdiagnostic kits?\b", r"\bhydrogels?\b",
        r"\bbiochar\b", r"\bbioplastic", r"\bchemicals?\b", r"\bactive pharmaceutical ingredients?\b", r"\bgenom", r"\bCRISPR\b",
        r"\bmRNA\b", r"\bstem cells?\b", r"\btissue engineer", r"\bgreen chemistry\b", r"\bbiosimilar", r"\bmicroalgae\b",
    ),
}

DOMAIN: dict[str, re.Pattern[str]] = {
    "health": _rx(
        r"\bhealth", r"\bmedical\b", r"\bpatients?\b", r"\bclinic", r"\bhospitals?\b", r"\bdiseases?\b", r"\bdiagnos",
        r"\btherap", r"\bsurg", r"\bcancer", r"\bcardi", r"\bneuro", r"\beye\b", r"\bophthalm", r"\bdental\b", r"\bmaternal\b",
        r"\bpharma", r"\bdrugs?\b", r"\brehabilit", r"\bwounds?\b", r"\binfections?\b", r"\bdialysis\b", r"\bneonat", r"\bsutur", r"\bparkinson", r"\bblind\b", r"\belderly\b", r"\bdiabet", r"\binsulin\b", r"\bkidney", r"\bdementia\b", r"\bmicrobiome\b",
    ),
    "agriculture & food": _rx(
        r"\bagri", r"\bfarm", r"\bcrops?\b", r"\bsoil\b", r"\blivestock\b", r"\bdairy\b", r"\bpoultry\b", r"\baquacultur",
        r"\bfisher", r"\bfood\b", r"\birrigat", r"\bharvest", r"\bveterinar", r"\bcattle\b", r"\bmillets?\b", r"\bhydroponic",
        r"\bstubble\b", r"\bcrop residue",
    ),
    "energy": _rx(
        r"\benergy\b", r"\bsolar\b", r"\bbatter(?:y|ies)\b", r"\bhydrogen\b", r"\belectrolys", r"\bfuel cells?\b", r"\bgrid\b",
        r"\bpower electronics\b", r"\brenewable", r"\bwind (?:energy|power|turbine)", r"\bcharging\b", r"\bthermal storage\b",
    ),
    "mobility": _rx(r"\belectric vehicles?\b", r"\bEVs?\b", r"\b(?:e-|electric |urban |shared |last[- ]mile )mobility\b", r"\bautomotive\b", r"\btwo-wheelers?\b", r"\btransport", r"\brailways?\b", r"\btraffic\b"),
    "space & aerospace": _rx(
        r"\bspace (?:tech|mission|sector|industry|economy|debris|situational)", r"\bspacecraft\b", r"\bouter space\b",
        r"\bsatellites?\b", r"\baerospace\b", r"\brockets?\b", r"\blaunch vehicles?\b", r"\borbital\b", r"\bin orbit\b", r"\blow earth orbit\b", r"\baircraft\b",
        r"\baviation\b", r"\bUAVs?\b", r"\bdrones?\b", r"\bavionics\b",
    ),
    "defence & security": _rx(r"\bdefen[cs]e\b", r"\bmilitary\b", r"\barmed forces\b", r"\barmy\b", r"\bnavy\b", r"\bsurveillance\b", r"\bcyber", r"\bborder\b", r"\bforensic"),
    "water & environment": _rx(
        r"\bwater\b", r"\bwastewater\b", r"\bwaste\b", r"\bpollut", r"\bair quality\b", r"\bcarbon (?:capture|footprint|emission|neutral|negative)",
        r"\bclimate\b", r"\bemissions?\b", r"\brecycl", r"\bcircular economy\b", r"\bplastic waste\b", r"\bsanitation\b",
        r"\bdesalinat", r"\bsewer", r"\bmanual scavenging\b",
    ),
    "manufacturing & industry": _rx(
        r"\bmanufactur", r"\bindustrial\b", r"\bfactor(?:y|ies)\b", r"\bmachining\b", r"\binspection\b", r"\bpredictive maintenance\b",
        r"\bsupply chains?\b", r"\bwarehous", r"\boil and gas\b", r"\bmining\b", r"\bsteel\b", r"\bcement\b",
    ),
    "buildings & construction": _rx(r"\bconstruction\b", r"\bbuildings\b", r"\bbuilding (?:materials?|envelope|sector|industry)\b", r"\bbuilding-integrated\b", r"\bgreen building", r"\bconcrete\b", r"\bHVAC\b", r"\bbricks?\b", r"\bcivil engineering\b"),
    "education": _rx(r"\beducation", r"\bstudents?\b", r"\bschools?\b", r"\bteach", r"\bliteracy\b", r"\blearners?\b", r"\bskilling\b"),
    "finance": _rx(r"\bfintech\b", r"\bfinancial\b", r"\bpayments?\b", r"\blending\b", r"\binsur", r"\bbanking\b"),
}

LABEL_PREFIXES = ("DPIIT-recognised startup. Industry:", "BIRAC Biotechnology Ignition Grant awardee, category:")


def described_text(product: str | None, product_verified: bool, description: str | None, description_is_label: bool) -> str:
    """The words the tags are read from: the company's own sentence and a source's, never a label."""
    parts = []
    if product and product_verified:
        parts.append(product)
    if description and not description_is_label and not description.startswith(LABEL_PREFIXES):
        parts.append(description)
    return " ".join(parts)


def tags(text: str) -> tuple[list[str], list[str]]:
    """(build tags, domain tags) for a description, each in vocabulary order."""
    if not text:
        return [], []
    return [k for k, rx in BUILD.items() if rx.search(text)], [k for k, rx in DOMAIN.items() if rx.search(text)]
