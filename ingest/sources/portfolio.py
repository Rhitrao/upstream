"""What a portfolio listing's own fields are worth, read the same way for every listing.

Incubator lists are typed in by hand, and they go wrong in the same few ways whoever
keeps them. The website box holds a LinkedIn page, "NA", a page title copied from a
browser tab, a registry lookup for the company's CIN, or an address a CMS has mangled
into "https:--www-geocon-in-". The description box holds a founder's email address
under "Other Email IDs". These helpers say no to each of those, so a scraper takes
what is left and nothing else.

Nothing here repairs a value. "https:--www-geocon-in-" is very probably geocon.in, but
"https:--itic-iith-ac-in-StartUp-www-alogtech-com-" shows the hyphens cannot be told
apart from real ones, and a guessed domain is a claim nobody made.
"""

from __future__ import annotations

import html
import re

from bs4 import BeautifulSoup

from ingest.identity import host, is_profile
from ingest.sources.base import clean, website

# Directories that publish a page about every registered company, app stores that
# publish one about every app, link-in-bio pages, and search engines whose result link
# someone pasted. A page on one of them says the company exists; it is not the
# company's site, and a homepage read of it would describe the directory.
DIRECTORY_HOSTS = re.compile(
    r"(?:^|\.)(?:bing\.com|duckduckgo\.com|yahoo\.com|apps\.apple\.com|play\.google\.com|bento\.me|"
    r"zaubacorp\.com|indiafilings\.com|tofler\.in|thecompanycheck\.com|instafinancials\.com|"
    r"falconebiz\.com|justdial\.com|indiamart\.com)$",
    re.IGNORECASE,
)

# A government portal or a university page can describe a startup, and a founder's
# faculty page can be where a listing points, but neither is the company's own domain.
INSTITUTION_HOSTS = re.compile(r"\.(?:gov\.in|nic\.in|ac\.in|edu|edu\.in|res\.in)$", re.IGNORECASE)

# The end of a link that is a file somebody uploaded, not a site.
FILE_SUFFIX = re.compile(r"\.(?:png|jpe?g|gif|webp|svg|pdf|docx?|xlsx?|pptx?|zip)$", re.IGNORECASE)

# What people type when the form insists on a website and they have none.
PLACEHOLDERS = frozenset({"na", "n/a", "n.a", "n.a.", "nil", "none", "null", "-", "--", "_", "#", "0", "tbd", "coming soon"})

EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
# Ten digits at least, so a year range or a "sub-25 nanometer" is never read as one.
PHONE = re.compile(r"\+?\d(?:[\s-]?\d){9,}")
# The label a contact was written under, once the contact itself has gone.
CONTACT_LABEL = re.compile(
    r"(?:\b(?:other\s+)?(?:e-?mail(?:\s+ids?)?|phone|mobile|contact(?:\s+(?:no|number|details))?)\.?\s*:?[\s,;/]*)+$",
    re.IGNORECASE,
)


def own_website(value: str | None) -> str | None:
    """A listing's website field when it can be the company's own site, else None.

    A value with words after the address ("www.elespahev.com Phone") keeps the address:
    the first token is the one the form asked for, and it is used only if it is a
    domain on its own.
    """
    text = clean(value)
    if not text or text.lower() in PLACEHOLDERS:
        return None
    # A CMS that flattened "/" and "." into "-" leaves "https:--". See the module note.
    if re.match(r"https?:-", text, re.IGNORECASE):
        return None
    url = website(text.split()[0])
    name = host(url)
    if not url or not name or "." not in name:
        return None
    if is_profile(url) or DIRECTORY_HOSTS.search(name) or INSTITUTION_HOSTS.search(name) or FILE_SUFFIX.search(name):
        return None
    if FILE_SUFFIX.search(url.split("?", 1)[0]):
        return None
    return url


def text_of(fragment: str | None) -> str | None:
    """An HTML fragment as one line of plain text, with contact details taken out.

    Entities are unescaped twice because some CMSes store them escaped already: the
    tag parser turns "&amp;nbsp;" into "&nbsp;", and only the second pass makes it a
    space.
    """
    if not fragment:
        return None
    text = BeautifulSoup(fragment, "html.parser").get_text(" ")
    return without_contacts(html.unescape(text))


def without_contacts(text: str | None) -> str | None:
    """The text less any email address or phone number, and the label it sat under.

    These are people's contact details, and a listing printing them is no reason for
    this pipeline to keep them.
    """
    line = clean(text)
    if not line:
        return None
    line = PHONE.sub(" ", EMAIL.sub(" ", line))
    line = re.sub(r"(?:\s*[,;/]\s*)+(?=\s*$)", "", clean(line) or "")
    line = CONTACT_LABEL.sub("", line)
    # Separators left behind in mid-sentence by a removed address: "a , , b".
    line = re.sub(r"\s+([,;])(?:\s*[,;])+", r"\1", line)
    return clean(line.strip(" ,;/"))
