"""A state for a company whose source gave only a city.

The DPIIT register publishes a state for every company. The grants lists publish a
city and nothing else, so 37 rows had a place and no state, and a view by state would
have counted them as unknown. This is the whole table those sources need — every city
they actually print — rather than a gazetteer: a city not in it stays without a state,
which is a gap the page can count, instead of a guess it cannot.
"""

from __future__ import annotations

CITY_STATE = {
    "ahmedabad": "Gujarat",
    "bangalore": "Karnataka",
    "bengaluru": "Karnataka",
    "bhubaneshwar": "Odisha",
    "bhubaneswar": "Odisha",
    "chennai": "Tamil Nadu",
    "gandhinagar": "Gujarat",
    "ghaziabad": "Uttar Pradesh",
    "gwalior": "Madhya Pradesh",
    "hosur": "Tamil Nadu",
    "jammu, j & k": "Jammu and Kashmir",
    "jharkhand": "Jharkhand",
    "kanpur": "Uttar Pradesh",
    "kochi": "Kerala",
    "mumbai": "Maharashtra",
    "new delhi": "Delhi",
    "noida": "Uttar Pradesh",
    "pune": "Maharashtra",
    "thiruvananthapuram": "Kerala",
    "trivandrum": "Kerala",
    "visakhapatnam": "Andhra Pradesh",
}


# One place, one spelling. The register writes districts ("Bengaluru Urban"), the grants
# lists write cities ("Bangalore"), and the page counted them as four places in
# Karnataka. Only a spelling, or a district that is the city under its official name,
# is folded; a district that holds more than one town ("Ernakulam", "Khordha") stays as
# the source wrote it, since folding it into its best-known city would be a guess.
PLACE_NAMES = {
    "bangalore": "Bengaluru",
    "bengaluru urban": "Bengaluru",
    "bhubaneshwar": "Bhubaneswar",
    "trivandrum": "Thiruvananthapuram",
    "kanpur nagar": "Kanpur",
    "mumbai suburban": "Mumbai",
    "south eastdelhi": "South East Delhi",
    "jammu, j & k": "Jammu",
}

# A state printed where a city should be says nothing a state column does not.
STATE_NAMES = {"jharkhand"}


def state_for(city: str | None) -> str | None:
    return CITY_STATE.get(city.strip().lower()) if city else None


def place_name(city: str | None) -> str | None:
    if not city or not city.strip():
        return None
    key = city.strip().lower()
    if key in STATE_NAMES:
        return None
    return PLACE_NAMES.get(key, city.strip())
