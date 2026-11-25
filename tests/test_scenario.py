import unittest

from app import registry as R
from app.models import custom  # noqa: F401


class DeclarativeScenarioTests(unittest.TestCase):
    def test_debt_dynamics_are_deterministic_and_native(self):
        result = R.call("sim.formula", {
            "initial": {"debt": 2.5}, "rates": {"interest": {"value": 0.03}, "growth": {"value": 0.01}, "primary": {"value": 0.02}},
            "equations": {"debt": "(1 + interest) / (1 + growth) * debt - primary"},
            "outputs": ["debt"], "basis": "Explicit illustrative debt-dynamics assumptions", "horizon": 2,
            "paths": 100, "unit": "ratio", "seed": 42})["result"]
        expected = 2.5
        for _ in range(2):
            expected = 1.03 / 1.01 * expected - 0.02
        self.assertAlmostEqual(result["chart"]["series"][0]["y"][-1], expected, places=7)
        self.assertEqual(result["scenario"]["kind"], "formula")
        self.assertFalse(result["scenario"]["stochastic"])
        self.assertIn("deterministic sensitivity", result["sentence"])
        self.assertNotIn("5–95%", result["sentence"])
        self.assertNotIn("median", result["chart2"]["title"].lower())

    def test_multiple_outputs_and_static_rates(self):
        result = R.call("sim.formula", {
            "initial": {"fleet": 2, "aircraft": 40},
            "rates": {"availability": {"low": 0.6, "high": 0.8, "distribution": "uniform", "static": True}},
            "equations": {"sorties": "fleet * aircraft * availability"}, "outputs": ["fleet", "sorties"],
            "basis": "Explicit illustrative sortie assumptions", "horizon": 2, "paths": 1000, "seed": 42})["result"]
        self.assertEqual(result["chart2"]["type"], "lines")
        self.assertEqual({s["name"] for s in result["chart2"]["series"]}, {"fleet", "sorties"})
        self.assertEqual(result["chart2"]["series"][0]["y"], [2, 2, 2])
        self.assertTrue(all(48 <= y <= 64 for y in result["chart2"]["series"][1]["y"]))

    def test_random_formula_functions_are_bounded_and_stochastic(self):
        result = R.call("sim.formula", {"initial": {"x": 1}, "equations": {"x": "x + uniform(-0.01, 0.01)"},
                                        "outputs": ["x"], "basis": "Explicit sensitivity", "horizon": 1,
                                        "paths": 1000, "seed": 42})["result"]
        self.assertTrue(result["scenario"]["stochastic"])
        self.assertTrue(result["scenario"]["effective_uncertainty"])
        self.assertEqual(result["chart"]["type"], "fan")
        self.assertTrue(0.99 <= result["chart"]["bands"][-1][2] <= 1.01)
        self.assertGreater(result["chart"]["bands"][-1][4] - result["chart"]["bands"][-1][0], 0.001)
        clipped = R.call("sim.formula", {"initial": {"x": 1}, "equations": {"x": "clip(x + uniform(0, 1), 2, 3)"},
                                         "outputs": ["x"], "basis": "Explicit clipped sensitivity", "horizon": 1,
                                         "paths": 1000, "seed": 42})["result"]
        self.assertFalse(clipped["scenario"]["effective_uncertainty"])
        self.assertIn("not uncertainty estimates", clipped["sentence"])

    def test_choice_builds_an_equal_weight_scenario_ensemble(self):
        result = R.call("sim.formula", {
            "initial": {"imf": 7.0, "adb": 6.6, "wb": 6.5, "oecd": 6.8},
            "equations": {"gdp": "choice(imf, adb, wb, oecd)", "cpi": "choice(4.4, 5.1, 5.2)"},
            "outputs": ["gdp", "cpi"], "basis": "Published alternatives with equal scenario weights, not calibrated probabilities",
            "horizon": 1, "paths": 5000, "unit": "percent", "seed": 42})["result"]
        self.assertTrue(result["scenario"]["stochastic"])
        self.assertTrue(result["scenario"]["effective_uncertainty"])
        self.assertGreaterEqual(result["chart"]["bands"][-1][0], 6.5)
        self.assertLessEqual(result["chart"]["bands"][-1][4], 7.0)
        self.assertGreater(result["chart"]["bands"][-1][4] - result["chart"]["bands"][-1][0], 0.3)
        self.assertIn("not a calibrated forecast", result["sentence"])

    def test_equation_lists_are_bounded_and_normalized(self):
        result = R.call("sim.formula", {"initial": {"x": 1}, "equations": [{"name": "x", "formula": "x + 1", "description": "Increment"}],
                                        "outputs": ["x"], "basis": "Explicit list schema", "horizon": 1, "paths": 100})["result"]
        self.assertEqual(result["chart"]["series"][0]["y"], [1, 2])
        assigned = R.call("sim.formula", {"initial": {"x": 1}, "equations": [{"name": "x", "formula": "x = x + 1"}],
                                          "outputs": ["x"], "basis": "Assignment list schema", "horizon": 1, "paths": 100})["result"]
        self.assertEqual(assigned["chart"]["series"][0]["y"], [1, 2])
        extra = R.call("sim.formula", {"initial": {"x": 1, "metadata": 333}, "equations": [{"name": "x", "formula": "x = x + 1"}],
                                       "outputs": ["x"], "basis": "Extra initial metadata", "horizon": 1, "paths": 100})["result"]
        self.assertEqual(extra["chart"]["series"][0]["y"], [1, 2])
        with self.assertRaisesRegex(ValueError, "target must match"):
            R.call("sim.formula", {"initial": {"x": 1}, "equations": [{"name": "x", "formula": "other = x + 1"}],
                                   "outputs": ["x"], "basis": "Mismatched assignment", "horizon": 1})
        with self.assertRaisesRegex(ValueError, "duplicate equation"):
            R.call("sim.formula", {"initial": {"x": 1}, "equations": [{"name": "x", "formula": "x + 1"}, {"name": "x", "formula": "x + 2"}],
                                   "outputs": ["x"], "basis": "Duplicate schema", "horizon": 1})

    def test_disallowed_code_and_bad_inputs_fail_closed(self):
        base = {"initial": {"x": 1}, "equations": {"x": "x + 1"}, "outputs": ["x"], "basis": "test", "horizon": 1}
        for formula in ("__import__('os').system('true')", "x.__class__", "[1][0]", "(lambda: 1)()"):
            with self.assertRaises(ValueError, msg=formula):
                R.call("sim.formula", {**base, "equations": {"x": formula}})
        with self.assertRaises(ValueError):
            R.call("sim.formula", {**base, "rates": {"r": {"distribution": "uniform"}}})
        with self.assertRaises(ValueError):
            R.call("sim.formula", {**base, "paths": 50000, "horizon": 500})
        with self.assertRaisesRegex(ValueError, "do not affect"):
            R.call("sim.formula", {**base, "equations": {"x": "x + 1", "turnout": "0.5"}})
        with self.assertRaisesRegex(ValueError, "do not affect"):
            R.call("sim.formula", {**base, "rates": {"unused_rate": {"value": 0.1}}})


if __name__ == "__main__":
    unittest.main()
