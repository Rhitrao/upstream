"""The fetch cache: fresh copies are served, stale ones are asked for conditionally, and a
304 keeps the page and moves only the time it was checked."""

import datetime
import json
import pathlib
import tempfile
import unittest
from unittest import mock

from ingest.sources import base


class Response:
    def __init__(self, status, text="", headers=None):
        self.status_code, self.text, self.headers = status, text, headers or {}


class ConditionalFetch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patch_dir = mock.patch.object(base, "CACHE_DIR", pathlib.Path(self.tmp.name))
        self.patch_dir.start()

    def tearDown(self):
        self.patch_dir.stop()
        self.tmp.cleanup()

    def _age(self, url, days):
        path = base._cache_path(url)
        entry = json.loads(path.read_text())
        entry["fetched_at"] = (base._now() - datetime.timedelta(days=days)).isoformat()
        path.write_text(json.dumps(entry))

    def test_a_304_keeps_the_page_and_moves_the_check_time(self):
        url = "https://example.org/portfolio"
        with mock.patch.object(base, "_send", return_value=Response(200, "<html>v1</html>", {"ETag": '"abc"'})):
            self.assertEqual(base.fetch(url), "<html>v1</html>")
        self._age(url, 40)
        seen = {}

        def not_modified(url, body, **kwargs):
            seen.update(kwargs.get("extra_headers") or {})
            return Response(304)

        with mock.patch.object(base, "_send", side_effect=not_modified):
            self.assertEqual(base.fetch(url), "<html>v1</html>")
        self.assertEqual(seen, {"If-None-Match": '"abc"'})
        checked = datetime.datetime.fromisoformat(json.loads(base._cache_path(url).read_text())["fetched_at"])
        self.assertLess((base._now() - checked).total_seconds(), 60)

    def test_a_fresh_copy_is_served_without_asking(self):
        url = "https://example.org/fresh"
        with mock.patch.object(base, "_send", return_value=Response(200, "one")):
            base.fetch(url)
        with mock.patch.object(base, "_send", side_effect=AssertionError("should not be asked")):
            self.assertEqual(base.fetch(url), "one")

    def test_a_form_post_is_cached_by_its_form(self):
        url = "https://example.org/wp-admin/admin-ajax.php"
        with mock.patch.object(base, "_send", return_value=Response(200, '{"page": 1}')) as send:
            base.fetch_form(url, {"action": "search", "page": "1"})
            base.fetch_form(url, {"action": "search", "page": "1"})
            self.assertEqual(send.call_count, 1)
            base.fetch_form(url, {"action": "search", "page": "2"})
            self.assertEqual(send.call_count, 2)


if __name__ == "__main__":
    unittest.main()
