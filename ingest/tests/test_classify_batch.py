"""Batch classification against a fake client: two rounds, half price, a batch that has not
ended is kept for the next run, and nothing is asked for twice."""

import json
import pathlib
import tempfile
import types
import unittest
from unittest import mock

from ingest import classify
from ingest.sources.base import Company


def message(payload: dict, tokens=(1000, 50)):
    return types.SimpleNamespace(
        content=[types.SimpleNamespace(type="text", text=json.dumps(payload))],
        usage=types.SimpleNamespace(input_tokens=tokens[0], output_tokens=tokens[1]),
    )


class FakeBatches:
    def __init__(self, answer, ended_after=0):
        self.answer, self.ended_after, self.created, self.polls = answer, ended_after, [], 0

    def create(self, requests):
        self.created.append(requests)
        return types.SimpleNamespace(id=f"batch-{len(self.created)}")

    def retrieve(self, batch_id):
        self.polls += 1
        return types.SimpleNamespace(processing_status="ended" if self.polls > self.ended_after else "in_progress")

    def results(self, batch_id):
        requests = self.created[int(batch_id.split("-")[1]) - 1]
        for request in requests:
            payload = self.answer(request)
            yield types.SimpleNamespace(
                custom_id=request["custom_id"],
                result=types.SimpleNamespace(type="succeeded", message=message(payload)) if payload else types.SimpleNamespace(type="errored"),
            )


def sector_then_subsector(request):
    if request["params"]["system"] == classify.SECTOR_SYSTEM:
        return {"sector_id": "none"} if "Nothing" in request["params"]["messages"][0]["content"] else {"sector_id": "1"}
    sector = classify.SECTOR_BY_ID["1"]
    sub = sector["subsectors"][0]
    return {"subsector_id": sub["id"], "project_type": sub["projects"][0], "reason": "Fits.", "missing": None}


class BatchClassification(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        self.patches = [
            mock.patch.object(classify, "BATCH_STATE_PATH", root / "batch_pending.json"),
            mock.patch.object(classify, "CACHE_PATH", root / "classify.json"),
        ]
        for patch in self.patches:
            patch.start()
        self.companies = [
            Company(id="solar", name="Solar Co", description="Perovskite solar cells", source="fsid-iisc"),
            Company(id="nothing", name="Nothing Co", description="Nothing deep tech here", source="fsid-iisc"),
        ]

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.tmp.cleanup()

    def run_batches(self, fake, ceiling=1.0, **kwargs):
        client = types.SimpleNamespace(messages=types.SimpleNamespace(batches=fake))
        usage = classify.Usage()
        return classify._classify_in_batches(list(self.companies), {}, usage, {}, ceiling, client=client, sleep=lambda s: None, **kwargs)

    def test_two_rounds_place_what_fits_and_bill_half(self):
        fake = FakeBatches(sector_then_subsector)
        results, usage = self.run_batches(fake)
        self.assertEqual(len(fake.created), 2)
        self.assertEqual(len(fake.created[1]), 1)  # only the company with a sector is asked twice
        self.assertTrue(results["solar"].on_map)
        self.assertIsNone(results["nothing"].sector_id)
        self.assertEqual(usage.calls, 3)
        self.assertAlmostEqual(usage.cost, 0.5 * (3000 * 1.0 + 150 * 5.0) / 1_000_000)
        self.assertFalse(classify.BATCH_STATE_PATH.exists())
        cached = json.loads(classify.CACHE_PATH.read_text())
        self.assertEqual(set(cached), {"solar", "nothing"})
        # Structured output is asked for inside the batch, as in a direct call.
        self.assertIn("output_config", fake.created[0][0]["params"])

    def test_a_batch_still_running_is_kept_and_collected_next_time(self):
        clock = iter(range(0, 10**9, 10**6))
        fake = FakeBatches(sector_then_subsector, ended_after=10**6)
        results, usage = self.run_batches(fake, clock=lambda: next(clock))
        self.assertEqual(results, {})
        self.assertEqual(usage.pending, 2)
        state = json.loads(classify.BATCH_STATE_PATH.read_text())
        self.assertEqual((state["stage"], state["batch_id"]), ("sector", "batch-1"))

        fake.ended_after = 0
        fake.polls = 0
        results, usage = self.run_batches(fake)
        self.assertEqual(len(fake.created), 2)  # the first batch was collected, not asked again
        self.assertTrue(results["solar"].on_map)

    def test_the_ceiling_decides_how_many_are_sent(self):
        fake = FakeBatches(sector_then_subsector)
        _, usage = self.run_batches(fake, ceiling=classify.COST_PER_COMPANY * classify.BATCH_DISCOUNT)
        self.assertEqual(len(fake.created[0]), 1)
        self.assertEqual(usage.over_budget, 1)


if __name__ == "__main__":
    unittest.main()
