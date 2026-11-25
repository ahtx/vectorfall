import unittest

from app import registry as R
from app.models import custom as C  # noqa: F401


class CustomSimulationTests(unittest.TestCase):
    def test_series_projection_is_native_and_seeded(self):
        args = {"model": "series", "series": "100\n104\n109\n116\n125", "horizon": 12, "unit": "index", "seed": 42}
        first = R.call("sim.custom", args)
        second = R.call("sim.custom", args)
        self.assertEqual(first["result"]["headline"], second["result"]["headline"])
        self.assertEqual(first["result"]["chart"]["type"], "fan")
        self.assertEqual(first["result"]["chart"]["unit"], "index")
        self.assertEqual(first["result"]["custom"]["seed"], 42)

    def test_state_projection_has_reachable_native_lines(self):
        result = R.call("sim.custom", {"model": "states", "states": "Healthy, Recovered",
                                      "transitions": "Healthy -> Healthy : 0.2\nHealthy -> Recovered : 0.8\nRecovered -> Recovered : 1",
                                      "start": "Healthy", "horizon": 8, "seed": 42})["result"]
        self.assertEqual(result["chart"]["type"], "lines")
        self.assertEqual({s["name"] for s in result["chart"]["series"]}, {"Healthy", "Recovered"})
        self.assertEqual(result["custom"]["horizon"], 8)

    def test_missing_or_wrong_family_input_fails(self):
        with self.assertRaises(ValueError):
            R.call("sim.custom", {"model": "series", "series": ""})
        with self.assertRaises(ValueError):
            R.call("sim.custom", {"model": "states", "states": "A, B", "transitions": ""})


    def test_count_scenario_is_seeded_native_and_explicit(self):
        args = {"start": 295, "inflow_low": 10, "inflow_high": 14, "outflow_low": 9, "outflow_high": 16,
                "basis": "Explicit user-requested illustrative production and retirement assumptions",
                "horizon": 5, "unit": "ships", "seed": 42}
        first = R.call("sim.counts", args)["result"]
        second = R.call("sim.counts", args)["result"]
        self.assertEqual(first["headline"], second["headline"])
        self.assertEqual(first["chart"]["type"], "fan")
        self.assertEqual(len(first["chart"]["bands"]), 6)
        self.assertNotIn("history", first)
        self.assertIn("not a forecast", first["sentence"])
        self.assertEqual(first["scenario"]["kind"], "count")
        self.assertGreater(first["paths"], 0)

    def test_count_scenario_rejects_bad_ranges_and_workload(self):
        args = {"start": 10, "inflow_low": 5, "inflow_high": 2, "outflow_low": 0, "outflow_high": 1,
                "basis": "Explicit test assumption", "horizon": 5}
        with self.assertRaises(ValueError):
            R.call("sim.counts", args)
        args.update(inflow_low=2, inflow_high=5, paths=50000, horizon=500)
        with self.assertRaises(ValueError):
            R.call("sim.counts", args)
        with self.assertRaisesRegex(ValueError, "sim_formula"):
            R.call("sim.counts", {"start": 336, "inflow_low": 0, "inflow_high": 0,
                                  "outflow_low": 0, "outflow_high": 0, "basis": "Growth is not a count flow", "horizon": 10})


if __name__ == "__main__":
    unittest.main()
