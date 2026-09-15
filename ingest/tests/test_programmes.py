"""Public programmes are counted from what the signals name, never ranked; organisations count who published.

    python3 -m unittest discover -s ingest/tests -t .

The same cases are pinned in test/index.spec.ts for src/programmes.ts.
"""

from __future__ import annotations

import unittest

from ingest import programmes

SIGNALS = [
    {"type": "incubator", "label": "SINE IIT Bombay incubatee", "source": "sine-iitb"},
    {"type": "grant", "label": "SINE IIT Bombay DST NIDHI PRAYAS, Cohort 5", "source": "sine-iitb"},
    {"type": "grant", "label": "BIRAC BIG 21", "source": "grants-csv"},
    {"type": "grant", "label": "SINE IIT Bombay seed investment, MeitY-SAMRIDH", "source": "sine-iitb"},
    {"type": "website", "label": "website live", "source": "sine-iitb"},
]


class Counting(unittest.TestCase):
    def test_programmes_are_every_scheme_named_plus_incubation_and_recognition(self):
        self.assertEqual(
            programmes.programmes(SIGNALS, "recognised"),
            ["BIRAC", "DPIIT recognition", "DST", "MeitY", "incubation at SINE, IIT Bombay"],
        )

    def test_organisations_count_who_published_a_decision(self):
        # SINE's page speaks once for its incubation and the schemes it runs; BIRAC's list is another voice.
        self.assertEqual(programmes.organisations(SIGNALS, "recognised"), ["BIRAC", "DPIIT", "SINE, IIT Bombay"])

    def test_a_profile_is_not_recognition_and_a_website_is_the_other_trace(self):
        self.assertNotIn("DPIIT recognition", programmes.programmes(SIGNALS, "profile"))
        self.assertEqual(programmes.other_traces(SIGNALS), 1)


if __name__ == "__main__":
    unittest.main()
