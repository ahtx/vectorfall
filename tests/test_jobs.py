import atexit
import os
import tempfile
import time
import unittest

_tmp = tempfile.TemporaryDirectory()
os.environ["VF_JOBS_DB"] = os.path.join(_tmp.name, "jobs.db")

from app import jobs

atexit.register(jobs.DB.close)

try:
    from app import api_v1
    from app import registry as R
except ModuleNotFoundError as ex:
    api_v1 = R = None
    GPU_IMPORT_ERROR = str(ex)
else:
    GPU_IMPORT_ERROR = None


class DurableJobTests(unittest.TestCase):
    def test_completed_job_survives_memory_loss(self):
        j = jobs.start("test", "answer", lambda job: {"answer": 42})
        for _ in range(100):
            if jobs.get(j.id)["state"] == "done":
                break
            time.sleep(.01)
        jobs.JOBS.clear()
        jobs._load()
        got = jobs.get(j.id)
        self.assertEqual(got["state"], "done")
        self.assertEqual(got["result"]["answer"], 42)
        self.assertTrue(got["started"])

    def test_running_job_is_interrupted_on_restore(self):
        j = jobs.Job("test", "interrupted")
        jobs._save(j)
        jobs.JOBS.clear()
        jobs._load()
        got = jobs.get(j.id)
        self.assertEqual(got["state"], "interrupted")
        self.assertIn("restart", got["error"])

    @unittest.skipIf(api_v1 is None, "GPU runtime dependencies: " + str(GPU_IMPORT_ERROR))
    def test_mcp_start_and_job(self):
        @R.model("test.answer", "Answer", "test", device="cpu")
        def answer():
            return {"answer": 42}

        try:
            started = api_v1._mcp_one({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": {"name": "vf_start", "arguments": {"model": "test_answer", "params": {}}}})
            self.assertIn("structuredContent", started["result"], started)
            job = started["result"]["structuredContent"]
            for _ in range(100):
                got = api_v1._mcp_one({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                    "params": {"name": "vf_job", "arguments": {"id": job["id"]}}})["result"]["structuredContent"]
                if got["state"] == "done":
                    break
                time.sleep(.01)
            self.assertEqual(got["result"]["result"]["answer"], 42)
            names = [t["name"] for t in api_v1._mcp_tools()]
            self.assertIn("vf_start", names)
            self.assertIn("vf_job", names)
        finally:
            R.REGISTRY.pop("test.answer", None)
            R.GROUPS.pop("test", None)


if __name__ == "__main__":
    unittest.main()
