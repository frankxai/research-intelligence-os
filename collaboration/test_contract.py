"""Contract checks: python -m unittest discover -s collaboration -p 'test_*.py'
Dependency: jsonschema==4.26.0
"""
import copy
import json
from pathlib import Path
import unittest
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parent

class TranslationContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = json.loads((ROOT / "translation.schema.json").read_text())
        cls.example = json.loads((ROOT / "example.json").read_text())
        Draft202012Validator.check_schema(cls.schema)
        cls.validator = Draft202012Validator(cls.schema, format_checker=FormatChecker())

    def test_candidate_is_valid(self):
        self.validator.validate(self.example)

    def test_evidence_free_promotions_are_rejected(self):
        for status in ("evaluated", "submitted", "accepted"):
            with self.subTest(status=status):
                record = copy.deepcopy(self.example)
                record["status"] = status
                self.assertTrue(list(self.validator.iter_errors(record)))

    def test_invalid_source_url_is_rejected(self):
        record = copy.deepcopy(self.example)
        record["source"]["url"] = "invalid-url"
        self.assertTrue(list(self.validator.iter_errors(record)))

    def test_independent_rerun_requires_result(self):
        record = copy.deepcopy(self.example)
        record["source"]["inspection_scope"] = "independent_rerun"
        self.assertTrue(list(self.validator.iter_errors(record)))

    def test_complete_accepted_record_is_valid(self):
        record = copy.deepcopy(self.example)
        record["status"] = "accepted"
        record["rights"]["permission_to_run"] = True
        record["result"].update(outcome="measured", evidence="https://example.org/evidence", actual_cost_eur=0)
        record["review"].update(reviewer="Independent reviewer", receipt="https://example.org/review", verdict="pass")
        record["upstream"].update(submission="https://example.org/pr/1", acceptance="https://example.org/pr/1#merged")
        self.validator.validate(record)

if __name__ == "__main__":
    unittest.main()
