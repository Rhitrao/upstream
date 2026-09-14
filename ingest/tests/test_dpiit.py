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


class FoundersAsSinePrintsThem(unittest.TestCase):
    def test_the_line_that_separates_the_names_wins(self):
        from ingest.sources import sine

        records = [{"founder_name": "Nisha Yadav Saugandha Das"}, {"founder_name": "Nisha Yadav, Saugandha Das."}]
        self.assertEqual(sine._founders(records), "Nisha Yadav, Saugandha Das")
        self.assertEqual(sine._founders([{"founder_name": "Prof. A Rao."}]), "Prof. A Rao")
        self.assertIsNone(sine._founders([{"founder_name": "  "}]))

    def test_names_are_told_apart_and_otherwise_left_as_written(self):
        from ingest.sources.base import founder_line

        self.assertEqual(founder_line("Rohan M Despande/Ayush S Gaikwadi"), "Rohan M Despande, Ayush S Gaikwadi")
        self.assertEqual(founder_line("Prof. Udayan Ganguly Prof. Swaroop Ganguly"), "Prof. Udayan Ganguly, Prof. Swaroop Ganguly")
        self.assertEqual(founder_line("DHINESH R KANAGARAJ (IITM alumnus) /fabheads-automation/"), "DHINESH R KANAGARAJ (IITM alumnus)")
        self.assertEqual(founder_line("Prof.U.B.Desai, Dr.Srikanth Parikh."), "Prof.U.B.Desai, Dr.Srikanth Parikh")
        self.assertEqual(founder_line("Mr.Suhas Khalkar"), "Mr.Suhas Khalkar")
        self.assertEqual(founder_line("Prof. Dr. Dhwanil Shukla, Prof. Dr. Omkar Halbe"), "Prof. Dr. Dhwanil Shukla, Prof. Dr. Omkar Halbe")
        self.assertEqual(founder_line("Kunal Khanna, Prof. Jayesh Bellare and Prof. Rohit Srivastava"), "Kunal Khanna, Prof. Jayesh Bellare and Prof. Rohit Srivastava")
        self.assertEqual(founder_line("Dr KAVITHA and Dr ANANT RAHEJA (IITM alumni)"), "Dr KAVITHA and Dr ANANT RAHEJA (IITM alumni)")
        self.assertEqual(founder_line("Prof. Padma Devarajan Mrs. Maharukh Rustomjee"), "Prof. Padma Devarajan, Mrs. Maharukh Rustomjee")
