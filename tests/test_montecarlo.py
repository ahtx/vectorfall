import unittest

try:
    from app import montecarlo
except (ImportError, ModuleNotFoundError) as ex:
    montecarlo = None
    IMPORT_ERROR = str(ex)
else:
    IMPORT_ERROR = None


@unittest.skipIf(montecarlo is None, "GPU runtime dependencies: " + str(IMPORT_ERROR))
class MonteCarloTests(unittest.TestCase):
    def test_budget_seed_is_reproducible(self):
        params = {"items": "Design, 10, 20, 40\nBuild, 30, 50, 90", "budget": 80,
                  "sims": 10000, "correlation": .2, "seed": 42}
        a = montecarlo.budget(params)
        b = montecarlo.budget(params)
        self.assertEqual(a["chart"], b["chart"])
        self.assertEqual(a["facts"], b["facts"])
        self.assertEqual(a["headline"], b["headline"])
        self.assertEqual(dict(a["facts"])["seed"], "42")


if __name__ == "__main__":
    unittest.main()
