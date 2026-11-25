"""Every VectorFall operation as a registered model (see app/registry.py). One module per app; importing this package
registers them all. Adding a GPU application = one decorated function in one of these files (or a new file listed here).
"""
from .. import registry as R

R.group("text", "Text Engine — gigabytes of text on the card", "text")
R.group("language", "Language — VectorLM (a prototype) and the graph store", "vlm")
R.group("photo", "Photo Lab — develop, search and de-duplicate photos", "photo")
R.group("sound", "Sound Lab — edit audio in place, find sounds", "sound")
R.group("data", "Data Desk — tables, statistics, anomaly watch", "data")
R.group("sim", "Simulate — Monte Carlo on the card", "simulate", kind="simulate")
R.group("forecast", "Forecast — simulations that answer planning questions", "simulate", kind="simulate")
R.group("plan", "Planner — rosters, routes and fair teams (GPU walk solver)", "plan")
R.group("reservoir", "Reservoir Lab — teach a dynamical system to recognise and forecast", "reservoir")
R.group("fractal", "Fractals — escape-time sets, deep zoom", "fractal")
R.group("life", "Life & patterns — live GPU simulations", "life")
R.group("machine", "Machine — the GPU itself", "machine")
R.group("lineage", "Lineage — this card against the TOP500 and the Crays", "lineage")
R.group("console", "Console — your own code on the card", "console")

from . import text, vlm, photo, sound, data, sim, plan, reservoir, fractal, life, machine, console, particles, forces, lineage, custom, problems, labtpl  # noqa: E402,F401
