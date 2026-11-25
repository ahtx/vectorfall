"""Sound Lab models: one model per effect (its own parameters), editing with undo, rendering chains, finding sounds."""
import os

from .. import media, registry as R
from ..registry import Blob, model

SOUND = {"k": "sound", "type": "sound", "label": "Clip", "required": True}
RANGE = [{"k": "start", "type": "float", "label": "From (s; empty = whole clip; with --apply)", "min": 0},
         {"k": "end", "type": "float", "label": "To (s)", "min": 0}]
OUT = {"k": "apply", "type": "bool", "label": "Apply to the clip (an edit that you can undo). If off, return a processed copy", "default": False}
# model names for the effect ids (the ids are the stored ones the UI and saved chains use)
NAMES = {"gain": "volume", "normalize": "normalize", "fade": "fade", "eq": "equalizer", "lowpass": "lowpass", "highpass": "highpass",
         "telephone": "telephone", "reverb": "reverb", "echo": "echo", "pitch": "pitch", "tempo": "tempo", "speed": "tape_speed",
         "reverse": "reverse", "denoise": "denoise", "vocals": "karaoke", "crush": "bitcrush", "loudness": "loudness",
         "band": "band_gain"}


def _wav(sid, which="out"):
    d = os.path.join("/srv/data/sounds", os.path.basename(sid))
    if which == "out" and not os.path.exists(os.path.join(d, "out.wav")):
        media.sound_current(sid)
    with open(os.path.join(d, "render.wav" if which == "render" else "out.wav"), "rb") as f:
        return f.read()


def _fx_model(fid, spec):
    params = spec.get("params") or []
    fields = [SOUND] + [{"k": p["k"], "type": "float", "label": p.get("label", p["k"]), "default": p.get("default"),
                         "min": p.get("min"), "max": p.get("max")} for p in params] + RANGE + [OUT]
    for f in fields:
        if f.get("min") is None:
            f.pop("min", None)
        if f.get("max") is None:
            f.pop("max", None)

    def run(sound, start=None, end=None, apply=False, **p):
        if apply:
            return media.sound_apply(sound, fid, p, start, end)
        if start is not None or end is not None:
            raise R.Refused("--start/--end choose part of the clip for --apply; a processed copy is always the whole clip")
        # a processed copy: the effect on the clip's current version, as a WAV (the clip itself is unchanged)
        r = media.sound_render(sound, [{"id": fid, "params": p}], current=True)
        return Blob(_wav(sound, "render"), "audio/wav", "{}-{}.wav".format(sound, NAMES[fid]), {k: r[k] for k in ("ms", "seconds", "realtime_x", "timings") if k in r})
    model("sound.fx." + NAMES[fid], spec.get("name", fid), "sound",
          "{} on the card. Returns the processed audio; --apply makes it an undoable edit of the clip.".format(spec.get("name", fid)),
          output="audio/wav", fields=fields)(run)


for _fid, _spec in media.FX.items():
    _fx_model(_fid, _spec)


@model("sound.list", "List clips", "sound", "Every clip in the Sound Lab.", device="cpu")
def sound_list():
    return media.sound_list()


@model("sound.effects", "Effects", "sound", "Every effect with its parameters, defaults and ranges.", device="cpu")
def effects():
    return media.FX


@model("sound.upload", "Add a clip", "sound", "Decode any audio file (up to 5 minutes, stereo 44.1 kHz).", device="cpu", mutating=True,
       fields=[{"k": "file", "type": "file", "label": "Audio file", "required": True, "accept": "audio/*"},
               {"k": "filename", "type": "str", "label": "Name", "default": "sound.wav"}])
def upload(file, filename):
    return media.sound_add(filename or "sound", file)


@model("sound.trim", "Keep or cut a part", "sound", "Keep only a range of the clip, or remove it (an undoable edit that changes its length).",
       mutating=True, fields=[SOUND, {"k": "op", "type": "choice", "label": "keep or cut", "choices": ["keep", "cut"], "required": True}] + RANGE)
def trim(sound, op, start=None, end=None):
    return media.sound_trim(sound, op, start, end)


@model("sound.apply", "Apply an effect", "sound", "One effect by id, in place, on all or part of the clip (an undoable edit). "
       "For several effects as one edit, use sound.chain.", mutating=True,
       fields=[SOUND, {"k": "fx", "type": "choice", "label": "Effect", "choices": list(media.FX), "required": True},
               {"k": "params", "type": "json", "label": "Effect parameters", "default": {}}] + RANGE)
def apply(sound, fx, params, start=None, end=None):
    return media.sound_apply(sound, fx, params or {}, start, end)


CHAIN = {"k": "chain", "type": "json", "label": "Chain: [{id, params, on}] in order (on: false bypasses a step)", "required": True,
         "help": 'For example [{"id": "highpass", "params": {"hz": 80}}, {"id": "denoise", "params": {"amount": 0.5}}, {"id": "loudness", "params": {"target": -16}}]. '
                 "The ids and parameters are in sound.effects."}


@model("sound.chain", "Apply an effect chain", "sound",
       "Several effects in order as ONE undoable edit, on the whole clip or on a range. Bypassed steps (on: false) are skipped.",
       mutating=True, long=True, fields=[SOUND, CHAIN] + RANGE)
def chain(job, sound, chain, start=None, end=None):
    return media.sound_apply_chain(sound, chain or [], start, end, job)


@model("sound.preview", "Preview a chain", "sound",
       "Listen before an edit: the chain on a stretch of the current version (10 s from the start when no range is given, "
       "30 s at most), as a WAV. The clip does not change.", output="audio/wav",
       example={"chain": [{"id": "highpass", "params": {"hz": 120}}, {"id": "loudness", "params": {"target": -16}}], "start": 0, "end": 5},
       fields=[SOUND, CHAIN, {"k": "start", "type": "float", "label": "From (s)", "min": 0}, {"k": "end", "type": "float", "label": "To (s)", "min": 0}])
def preview(sound, chain, start=None, end=None):
    data, meta = media.sound_preview(sound, chain or [], start, end)
    return Blob(data, "audio/wav", "{}-preview.wav".format(sound), meta)


@model("sound.loudness", "Loudness meter", "sound",
       "EBU R128 / ITU-R BS.1770 readings: integrated, momentary and short-term maximum loudness (LUFS), loudness range (LU), "
       "true peak and sample peak (dBFS), RMS, clipped samples, and the gain to reach the streaming, podcast and broadcast targets.",
       device="cpu", fields=[SOUND, {"k": "start", "type": "float", "label": "From (s; empty = whole clip)", "min": 0},
                             {"k": "end", "type": "float", "label": "To (s)", "min": 0},
                             {"k": "which", "type": "choice", "label": "Version", "choices": ["cur", "in"], "default": "cur"},
                             {"k": "steps", "type": "bool", "label": "Also return the 100 ms K-weighted energies (for meters)", "default": False}])
def loudness(sound, start=None, end=None, which="cur", steps=False):
    return media.sound_loudness(sound, start, end, steps, which)


MARKERS = {"k": "markers", "type": "json", "label": "Markers: [{t, end, label}] in seconds (no end = a point)", "required": True}


@model("sound.markers.get", "Markers", "sound", "The markers and labelled regions of a clip.", device="cpu",
       fields=[SOUND, {"k": "format", "type": "choice", "label": "Format", "choices": ["json", "tsv"], "default": "json"}])
def markers_get(sound, format="json"):
    ms = media.sound_markers(sound)
    if format == "tsv":
        return Blob(media.markers_tsv(ms).encode("utf-8"), "text/plain", "{}-labels.txt".format(sound))
    return ms


@model("sound.markers.set", "Set markers", "sound",
       "Replace the markers of a clip. Give JSON, or an Audacity label file (start, end, label; tab-separated) as tsv.",
       device="cpu", mutating=True,
       fields=[SOUND, {"k": "markers", "type": "json", "label": "Markers: [{t, end, label}] in seconds (no end = a point)"},
               {"k": "tsv", "type": "str", "label": "Or: an Audacity label file"}])
def markers_set(sound, markers=None, tsv=None):
    if markers is None and not tsv:
        raise R.Refused("give markers (JSON) or tsv (an Audacity label file)")
    return media.sound_markers_set(sound, markers if markers is not None else media.parse_tsv(tsv))


@model("sound.render", "Render a chain", "sound", "A chain of effects on the original audio of the clip, as a preview (the clip does not change).",
       fields=[SOUND, {"k": "chain", "type": "json", "label": "Chain: [{id, params}]", "default": []}])
def render(sound, chain):
    return media.sound_render(sound, chain or [])


@model("sound.view", "Waveform and spectrogram", "sound", "The clip's current version: waveform envelope, spectrogram, history.", fields=[SOUND])
def view(sound):
    return media.sound_current(sound)


@model("sound.original", "Original waveform", "sound", "Peaks and spectrogram of the clip as uploaded.", fields=[SOUND])
def original(sound):
    return media.sound_original(sound)


@model("sound.audio", "Get the audio", "sound", "The clip's current version (or the original) as a WAV file.", device="cpu", output="audio/wav",
       fields=[SOUND, {"k": "which", "type": "choice", "label": "Version", "choices": ["out", "in", "render"], "default": "out"}])
def audio(sound, which):
    d = os.path.join("/srv/data/sounds", os.path.basename(sound))
    if which == "in" and not os.path.exists(os.path.join(d, "in.wav")):
        media.sound_write_in(sound)
    if which == "render" and not os.path.exists(os.path.join(d, "render.wav")):
        raise R.Refused("render this clip first", 404)
    name = {"out": "out.wav", "in": "in.wav", "render": "render.wav"}[which]
    if which == "out":
        _wav(sound)
    with open(os.path.join(d, name), "rb") as f:
        return Blob(f.read(), "audio/wav", "{}-{}.wav".format(sound, which))


@model("sound.undo", "Undo", "sound", "Step the clip back one edit.", mutating=True, fields=[SOUND])
def undo(sound):
    return media.sound_step(sound, -1)


@model("sound.redo", "Redo", "sound", "Step the clip forward one edit.", mutating=True, fields=[SOUND])
def redo(sound):
    return media.sound_step(sound, 1)


@model("sound.batch", "Process many clips", "sound", "One chain of effects on many clips' current versions; returns a zip.", long=True,
       fields=[{"k": "sounds", "type": "strs", "label": "Clip ids (empty = all)"},
               {"k": "chain", "type": "json", "label": "Chain: [{id, params}]", "required": True}])
def batch(job, sounds, chain):
    return media.sound_batch(sounds or [s["id"] for s in media.sound_list()], chain, job)


@model("sound.delete", "Delete a clip", "sound", "", device="cpu", mutating=True, fields=[SOUND])
def delete(sound):
    return media.sound_delete(sound)


# ---------------------------------------------------------------- finding sounds
def _sf():
    from .. import soundfind
    return soundfind


MARKS = {"k": "marks", "type": "json", "label": "Marks: [{a, b, label}] in seconds", "required": True}
EVENTS = {"k": "events", "type": "json", "label": "Events: [{label, a, b, score, marked}] (from sound.find)", "required": True}


@model("sound.marks.get", "Marked examples", "sound", "The examples marked on a clip.", device="cpu", fields=[SOUND])
def marks_get(sound):
    return _sf().get_marks(sound)


@model("sound.marks.set", "Mark examples", "sound", "Replace the marked examples (each at least 0.05 s, with a label).", device="cpu",
       mutating=True, fields=[SOUND, MARKS])
def marks_set(sound, marks):
    return _sf().set_marks(sound, marks or [])


@model("sound.find", "Find every occurrence", "sound",
       "Learn the marked sounds (log-mel + reservoir features on the card) and find all the other times that they occur. "
       "Marks labelled \"nothing\" are examples of what is NOT the sound. The check hides each mark in turn and compares with the same "
       "marks moved to random places (chance); each event has its background rate (how often unmarked audio scores as high).",
       long=True, timeout=600,
       fields=[SOUND, {"k": "threshold", "type": "float", "label": "Sensitivity (higher = stricter)", "default": 0.5, "min": 0.05, "max": 0.95}])
def find(job, sound, threshold):
    return _sf().find(sound, threshold)


@model("sound.find.apply", "Find in another clip", "sound",
       "Use the detector learned from the marks on one clip to find the same sounds in another clip.",
       long=True, timeout=600,
       fields=[{"k": "model", "type": "sound", "label": "Clip with the marks (its detector)", "required": True}, SOUND,
               {"k": "threshold", "type": "float", "label": "Sensitivity (higher = stricter)", "default": 0.5, "min": 0.05, "max": 0.95}])
def find_apply(job, model, sound, threshold):
    return _sf().apply(model, sound, threshold)


@model("sound.events.table", "Detections → table", "sound", "Save detected events as a Data Desk table.", device="cpu", mutating=True,
       fields=[SOUND, EVENTS])
def events_table(sound, events):
    return _sf().events_table(sound, events or [])


@model("sound.events.reservoir", "Detections → Reservoir Lab", "sound", "Turn the marks and confident detections into labelled examples.",
       mutating=True, fields=[SOUND, EVENTS, {"k": "name", "type": "str", "label": "Project name", "default": ""}])
def events_reservoir(sound, events, name):
    return _sf().to_reservoir(sound, name, events or [])


@model("sound.events.mute", "Mute or duck detections", "sound", "Silence (or turn down 12 dB) every detected event, as one undoable edit.",
       mutating=True, device="mixed",
       fields=[SOUND, EVENTS, {"k": "how", "type": "choice", "label": "How", "choices": ["mute", "duck"], "default": "mute"}])
def events_mute(sound, events, how):
    if not events:
        raise R.Refused("no events to change")
    return _sf().mute(sound, events, how)
