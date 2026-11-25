"""Lineage models: this card's LINPACK, and where that speed sits in the history of the TOP500."""
from .. import lineage as L
from ..registry import model


@model("lineage.linpack", "LINPACK on the card", "lineage",
       "HPL-style dense solve Ax = b (blocked LU, partial pivots, residual check) in FP64 and FP32. "
       "A full run fills the free memory, and the server keeps the result for this card.",
       fields=[{"k": "precision", "type": "choice", "label": "Precision", "default": "both", "choices": ["both", "fp64", "fp32"]},
               {"k": "size", "type": "choice", "label": "Size", "default": "auto", "choices": ["auto", "quick"],
                "help": "auto: as large as the free memory allows, up to about 45 s per precision; quick: a few seconds, not saved."}],
       long=True, timeout=300, example={"precision": "both", "size": "quick"})
def linpack(job, precision, size):
    return L.linpack(job, precision, size)


@model("lineage.compare", "Compare with history", "lineage",
       "The last TOP500 list where a speed would have been #1, its estimated rank on each list, the last list it "
       "makes, and how many Cray-1, Cray-2 and Cray C90 machines it equals. Empty speeds use this card's saved LINPACK runs.",
       device="cpu",
       fields=[{"k": "fp64", "type": "float", "label": "FP64 GFLOP/s", "default": None, "min": 0, "soft": True},
               {"k": "fp32", "type": "float", "label": "FP32 GFLOP/s", "default": None, "min": 0, "soft": True}],
       example={"fp64": 250.0, "fp32": 7000.0})
def compare(fp64, fp32):
    return L.compare(fp64, fp32)


@model("lineage.history", "Supercomputer history", "lineage",
       "Every TOP500 #1 since June 1993 with the #500 entry of each list, and the record holders before 1993, with sources.",
       device="cpu")
def history():
    D = L.data()
    return {"headline": "{} lists, {} machines".format(len(D["lists"]), len(D["machines"])),
            "lists": D["lists"], "machines": D["machines"], "rank_curve": D.get("rank_curve", {}), "notes": D.get("notes")}


@model("lineage.state", "Lineage page state", "lineage",
       "The card, its saved LINPACK runs, the comparison and the history: what the Lineage page loads.", device="cpu")
def state():
    return L.state()


@model("lineage.cancel", "Stop LINPACK", "lineage", "Stop a LINPACK run after the current panel.", device="cpu",
       mutating=True)
def cancel():
    L.cancel()
    return {"cancelled": True}
