import unittest

from ingest.sources import dpiit


def record(**fields):
    return {"name": "ZELBYX TECHNOLOGY PRIVATE LIMITED", "registeredOn": 1788421351254, "stages": ["Prototype"], **fields}


class WhatTheRegisterSays(unittest.TestCase):
    def test_a_profile_is_not_a_recognition(self):
        self.assertEqual(dpiit.recognition(record(dippRecognitionStatus=None, dippNumber=None)), "profile")
        self.assertEqual(dpiit._label(record(dippRecognitionStatus=None, dippNumber=None)), "Startup India profile, not DPIIT recognised")
        self.assertEqual(dpiit._label(record(dippRecognitionStatus="NA")), "Startup India profile, not DPIIT recognised")
        self.assertEqual(dpiit._label(record(dippRecognitionStatus="PENDING")), "Startup India profile, DPIIT recognition pending")

    def test_a_recognition_says_its_number_and_no_year(self):
        self.assertEqual(dpiit._label(record(dippRecognitionStatus="RECOGNISED", dippNumber="DIPP12345")), "DPIIT recognised (DIPP12345)")
        self.assertEqual(dpiit._label(record(dippRecognitionStatus="EXPIRED", dippNumber="DIPP9")), "DPIIT recognition expired (DIPP9)")
        self.assertEqual(dpiit._label(record(dippRecognitionStatus="CANCELLED", dippNumber="DIPP8")), "DPIIT recognition cancelled (DIPP8)")

    def test_the_company_carries_status_and_stage(self):
        company = dpiit._company(record(dippRecognitionStatus="RECOGNISED", dippNumber="DIPP1"), "AI")
        self.assertEqual((company.dpiit_status, company.dpiit_stage), ("recognised", "Prototype"))


if __name__ == "__main__":
    unittest.main()
