"""Whether a website is the company's, before anything on it becomes evidence.

A reachable URL is not proof of identity. RTBI's portfolio page carries an unclosed
anchor from one card that wraps the cards after it, and "the first outbound link in
the card" attached hyperverge.co — an identity-verification company — to an EV
battery maker. The homepage answered, the model read it faithfully, and the page
published a KYC product as Grinntech's. Every step worked; the association was wrong.

So a website passes three separate gates, and the state records how far it got:

    discovered  a URL exists, but nothing ties it to this company: another record
                gives the same address, it is a social profile rather than a
                domain, or its homepage describes something the source record does
                not.
    associated  the company's own source record gives it, uniquely, and nothing
                contradicts it — but the homepage does not name the company, or
                could not be read to find out.
    verified    associated, the company's name is in the domain or on the homepage,
                and the homepage does not contradict the source's description.

Only a verified homepage is read for a product sentence. Everything here is string
comparison on text already fetched: it costs nothing, and it will hold back some
genuine sites whose brand differs from the legal name. That is the right direction
to be wrong in — an unread homepage is a missing sentence, a misattributed one is a
false claim with a link beside it.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

DISCOVERED = "discovered"
ASSOCIATED = "associated"
VERIFIED = "verified"

STATES = (DISCOVERED, ASSOCIATED, VERIFIED)

# A profile page belongs to a platform. It can say who a company is; it cannot be the
# company's domain, and a homepage read of it would be a read of LinkedIn.
PROFILE_HOSTS = re.compile(
    r"(?:^|\.)(?:linkedin\.com|facebook\.com|fb\.com|twitter\.com|x\.com|instagram\.com|youtube\.com|"
    r"youtu\.be|crunchbase\.com|medium\.com|wa\.me|t\.me|github\.com|angel\.co|wellfound\.com|"
    r"tracxn\.com|google\.com|sites\.google\.com|linktr\.ee)$",
    re.IGNORECASE,
)

# Words in a company name that say what kind of entity it is, not which one. Matching
# "technologies" in a domain proves nothing about whose domain it is.
NAME_STOPWORDS = frozenset(
    """
    private pvt limited ltd llp inc corp corporation company co opc and the of for india indian
    technologies technology tech solutions solution systems system services service labs lab
    innovations innovation industries industry enterprises enterprise ventures venture global
    international research products product engineering sciences science health healthcare
    energy motors automation devices digital software group
    """.split()
)

# The part of a name that says it is registered, and nothing else.
LEGAL_SUFFIXES = frozenset("private pvt limited ltd llp inc corp corporation opc".split())

# Words any technology homepage and any source description share whatever the company
# does. Leaving them in would let two unrelated businesses "agree" because both
# mention a platform, a solution and India.
CONTENT_STOPWORDS = frozenset(
    """
    about above after again against their there these those which while where would could
    should other through under using based provide provides providing platform platforms
    solution solutions system systems technology technologies innovative innovation company
    companies india indian service services product products development develop developing
    developed business customer customers market industry industries management quality
    world global leading first better support including enable enabling users simple solve
    smart future people across every design designed build building make making create
    value focus deliver helps years price cost costs startup startups application applications
    engineering process processes solutions offer offers contact learn email phone privacy
    policy terms rights reserved cookies login signup home careers
    """.split()
)

# Below these sizes there is not enough text on one side to call a disagreement: a
# one-line description and a hero banner can share nothing and both be true.
MIN_DESCRIPTION_STEMS = 6
MIN_PAGE_STEMS = 25


def host(url: str | None) -> str | None:
    """The bare host, lowercased and without www, or None for anything unparseable."""
    if not url:
        return None
    try:
        name = urlparse(url if "//" in url else f"//{url}").hostname
    except ValueError:
        return None
    if not name:
        return None
    return re.sub(r"^www\d?\.", "", name.lower())


def is_profile(url: str | None) -> bool:
    """A social or directory profile rather than a company's own domain."""
    name = host(url)
    return bool(name and PROFILE_HOSTS.search(name))


def name_tokens(name: str) -> list[str]:
    """The distinctive words in a company name, including a brand given in brackets.

    "DocsApp (Phasorz Technologies Private Limited)" yields docsapp and phasorz; a
    four-letter floor keeps "Rana" but drops the "AI" that half these names carry.
    """
    words = re.findall(r"[a-z0-9]+", name.lower())
    return [w for w in words if len(w) >= 4 and w not in NAME_STOPWORDS]


def _squash(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def names_company(name: str, url: str | None, page_text: str | None) -> str | None:
    """Where the company's name was found: 'domain', 'page', or None.

    The domain is compared squashed, so "fabheads.in" matches Fabheads and
    "qnulabs.com" matches neither QuNu nor Labs — a brand spelled differently from the
    legal name stays unverified rather than being guessed at. The page is compared as
    whole words, and so is the whole name run together, for the "Aibono" written as
    one word on a page about "Aibono Smart Farming".
    """
    tokens = name_tokens(name)

    domain = host(url)
    if domain:
        label = _squash(domain.rsplit(".", 1)[0])
        if tokens and (any(token in label for token in tokens) or _squash("".join(tokens)) in label):
            return "domain"
        # The whole name, legal suffix removed, compared both ways: "Cre-Aid Labs" is
        # creaidlabs and "C-tech Labs" is ctechlab, and neither survives tokenising.
        # Six characters at least, so a domain called "energy" matches nothing.
        whole = _squash(" ".join(w for w in re.findall(r"[a-z0-9]+", name.lower()) if w not in LEGAL_SUFFIXES))
        if len(label) >= 6 and (label in whole or (len(whole) >= 6 and whole in label)):
            return "domain"
        # Initials, for the name nobody types in full: Transformer Neural Scan Quest
        # is tnsqai. Three words at least, or two-letter coincidences would match.
        words = [w for w in re.findall(r"[a-z0-9]+", name.lower()) if w not in LEGAL_SUFFIXES and w not in {"ai", "and", "of", "the"}]
        initials = "".join(w[0] for w in words)
        if len(initials) >= 3 and label.startswith(initials):
            return "domain"

    if page_text:
        # On a page, one word is only enough when the name is one word. "Green" is on
        # every energy site and "cell therapy" on every biotech one; NCF Green Energy
        # has to appear as NCF Green Energy. Squashed, so a footer's "Edsix Brain Lab
        # Pvt. Ltd." and a header's "EdsixBrainLab" both count.
        words = [w for w in re.findall(r"[a-z0-9]+", name.lower()) if w not in LEGAL_SUFFIXES]
        # A name made only of generic words ("Solutions Pvt. Ltd.") names nobody.
        if not any(w not in NAME_STOPWORDS for w in words):
            return None
        whole = _squash(" ".join(words))
        if len(whole) >= 5 and whole in _squash(page_text):
            return "page"
        # One word alone, only when nothing else in the name is distinctive: Sristan
        # Technologies can be "Sristan"; NCF Green Energy cannot be "green".
        distinctive = [w for w in words if w not in NAME_STOPWORDS]
        if len(distinctive) == 1 and distinctive[0] in tokens and re.search(rf"\b{re.escape(distinctive[0])}\b", page_text.lower()):
            return "page"
    return None


def _stems(text: str) -> set[str]:
    words = re.findall(r"[a-z]{5,}", text.lower())
    return {w[:6] for w in words if w not in CONTENT_STOPWORDS}


def contradicts(description: str | None, page_text: str | None) -> bool | None:
    """Whether the homepage describes a different business from the source record.

    None when it cannot be told: no description (a register label is not one), or too
    little text on either side. True only when both sides say enough and share not a
    single content word — Grinntech's battery packs and HyperVerge's face
    authentication, not a company that calls its product something new.
    """
    if not description or not page_text:
        return None
    ours, theirs = _stems(description), _stems(page_text)
    if len(ours) < MIN_DESCRIPTION_STEMS or len(theirs) < MIN_PAGE_STEMS:
        return None
    return not (ours & theirs)


def shared_hosts(companies) -> set[str]:
    """Hosts given for more than one company. None of them can identify either.

    Two records with one address is the signature of exactly the parser failure this
    module exists for, and also of an incubator's own domain used as a placeholder.
    Either way the address says nothing about which company it belongs to.
    """
    owners: dict[str, set[str]] = {}
    for company in companies:
        name = host(company.website)
        if name:
            owners.setdefault(name, set()).add(company.id)
    return {name for name, ids in owners.items() if len(ids) > 1}


def assess(
    name: str,
    url: str | None,
    description: str | None,
    page_text: str | None,
    shared: set[str],
    description_is_label: bool = False,
    name_text: str | None = None,
) -> tuple[str | None, str | None]:
    """The identity state for one website, and the reason in a sentence.

    `page_text` is the homepage as read for its product — or None when it could not be
    read, in which case only the domain can name the company and nothing can
    contradict it. `name_text` is the whole visible page, footer included, and is what
    the name is looked for in: the legal name a brand site never puts in a heading is
    usually in its copyright line.
    """
    if not url:
        return None, None
    if is_profile(url):
        return DISCOVERED, f"{host(url)} is a profile on another platform, not the company's own domain"

    found = names_company(name, url, name_text or page_text)
    if host(url) in shared and found != "domain":
        return DISCOVERED, "the same address is given for another company, so it cannot identify this one"

    if contradicts(None if description_is_label else description, page_text):
        return DISCOVERED, "the homepage describes a different business from the source record"

    if found is None:
        if page_text is None:
            return ASSOCIATED, "given in the company's own source record; the homepage could not be read to check the name"
        return ASSOCIATED, "given in the company's own source record, but the homepage does not name the company"
    where = "in the domain" if found == "domain" else "on the homepage"
    return VERIFIED, f"given in the company's own source record, with the company's name {where}"
