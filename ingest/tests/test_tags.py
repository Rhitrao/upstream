"""Tags come from the words of a real description, and a word with two meanings is not a tag.

    python3 -m unittest discover -s ingest/tests -t .
"""

from __future__ import annotations

import unittest

from ingest import tags


class ReadingTheWords(unittest.TestCase):
    def test_what_it_builds_and_where_it_is_used(self):
        self.assertEqual(
            tags.tags("Agricultural drones for farmers for crop monitoring and spraying."),
            (["hardware"], ["agriculture & food", "space & aerospace"]),
        )
        self.assertEqual(tags.tags("Thermostable biologics for diabetes, with room temperature insulin."), (["biological or chemical"], ["health"]))
        self.assertEqual(tags.tags("A blockchain digital locker for documents"), (["software"], []))

    def test_words_with_a_second_meaning_are_not_read_as_the_first(self):
        # Each of these put a wrong tag on a real row on 15 September 2026.
        self.assertNotIn("software", tags.tags("Green chemistry for Active Pharmaceutical Ingredients (APIs) and intermediates")[0])
        self.assertNotIn("space & aerospace", tags.tags("Electronics design automation tools; solutions in the electronics design space")[1])
        self.assertNotIn("biological or chemical", tags.tags("Compound semiconductor devices and circuits for RF")[0])
        self.assertNotIn("buildings & construction", tags.tags("Boltzmann Labs is building an AI-driven foundry for drug discovery")[1])
        self.assertNotIn("space & aerospace", tags.tags("Neurostellar Orbit is a wearable that measures focus")[1])
        self.assertNotIn("mobility", tags.tags("Improving mobility in Parkinson's with a wearable")[1])
        self.assertNotIn("hardware", tags.tags("An online platform that processes satellite data")[0])

    def test_nothing_to_read_is_no_tags(self):
        self.assertEqual(tags.tags(""), ([], []))


class WhatIsRead(unittest.TestCase):
    def test_a_list_label_is_never_read(self):
        self.assertEqual(tags.described_text(None, False, "DPIIT-recognised startup. Industry: Robotics. Stage: Prototype.", True), "")
        self.assertEqual(tags.described_text(None, False, "BIRAC Biotechnology Ignition Grant awardee, category: Medical Devices.", False), "")

    def test_an_unverified_homepage_sentence_is_not_read_and_a_verified_one_is(self):
        self.assertEqual(tags.described_text("Drones for farms", False, None, False), "")
        self.assertEqual(tags.described_text("Drones for farms", True, "Crop spraying", False), "Drones for farms Crop spraying")


if __name__ == "__main__":
    unittest.main()
