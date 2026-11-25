"""Text Engine: load a lot of text, compress it onto the card, and do instant things with it.

How it fits: every word and punctuation mark becomes a 2-byte code (frequency-ranked, so the 65,533 most common
tokens are a single uint16; rarer ones are an escape code plus a side table). Ordinary English shrinks ~2.8x, so the
card holds about 1.8 GB of text. Bigger corpora stay (compressed) in the host's RAM and stream through the card.

Why it is fast: a hand-written kernel scans the code stream with 16-byte vector loads at ~20 GB/s on the K420,
so "find every place this word or phrase occurs" over 150 million words takes ~15 ms. Everything else is built on
that scan: concordance, Markov next-word statistics, text generation with provenance, BM25 passage retrieval,
bigram tables. Exact text (snippets, transforms) comes from the original file, located through checkpoints.

Tokens: words = runs of [A-Za-z0-9'] and UTF-8 bytes; each of . , ! ? ; : " ( ) - is its own token; a blank line is
a paragraph token. Spaces are implied. The GPU tokenizer and TOKEN_RE below implement exactly the same rules.
"""
import bz2
import gzip
import hashlib
import html
import io
import json
import lzma
import math
import os
import re
import shutil
import time
import urllib.request
import uuid
import zipfile

import numpy as np

import cupy as cp

from . import engine, jobs

ROOT = "/srv/data/corpora"
EMB_CACHE = "/srv/data/embcache"   # word vectors + embedding maps, keyed by corpus content hash (shared by all corpora)
EMB_FMT = 1                        # bump when the embedding maths changes, so stale cache files are never used
EMB_KEEP = 256                     # cache files kept; the oldest go first


def _save_npy(arr):
    def w(t):
        with open(t, "wb") as f:
            np.save(f, arr)
    return w


def _save_json(obj):
    def w(t):
        with open(t, "w") as f:
            json.dump(obj, f)
    return w


def _cache_put(name, write):
    os.makedirs(EMB_CACHE, exist_ok=True)
    path = os.path.join(EMB_CACHE, name)
    tmp = path + ".{}.tmp".format(uuid.uuid4().hex[:8])
    try:
        write(tmp)
        os.replace(tmp, path)
    except Exception:  # noqa: BLE001  (a cache that can't be written is only a slower next time)
        try:
            os.remove(tmp)
        except OSError:
            pass
        return
    try:
        files = [os.path.join(EMB_CACHE, f) for f in os.listdir(EMB_CACHE) if not f.endswith(".tmp")]
        if len(files) > EMB_KEEP:
            files.sort(key=os.path.getmtime)
            for f in files[:len(files) - EMB_KEEP]:
                os.remove(f)
    except OSError:
        pass


def _cache_get(name):
    path = os.path.join(EMB_CACHE, name)
    if not os.path.exists(path):
        return None
    try:
        os.utime(path)                     # keep recently used entries at the back of the eviction line
    except OSError:
        pass
    return path
CHUNK = 48 << 20                     # bytes tokenized per GPU step
CK = 64                              # a byte-offset checkpoint every 64 tokens
COMMON, PAD, ESC = 65533, 65534, 65535
SEG = 32 << 20                       # tokens per GPU segment (64 MB), multiple of 8
WINDOW = 200                         # tokens per passage for retrieval
RESERVE = 230 << 20                  # card memory kept free for work
TOKEN_RE = re.compile(rb"[A-Za-z0-9'\x80-\xff]+|[.,!?;:\"()\-]|\n\n+")
PUNCT = set(b'.,!?;:"()-')
STOP = set("""a about above after again against all am an and any are as at be because been before being below between both
but by can could did do does doing down during each few for from further had has have having he her here hers herself him
himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our
ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they
this those through to too under until up very was we were what when where which while who whom why will with would you
your yours yourself yourselves said says upon one also may shall must us thy thee thou unto ye o oh mr mrs""".split())
JUNK = set("""quot amp nbsp lt gt apos http https www com org net io co html htm php asp aspx js css json xml href src
rel alt img div span px em rem pt utm gtm id ids url urls uri api cdn svg png jpg jpeg gif webp ico class style script var
const function return null true false undefined nan lorem ipsum pdf doc docx xlsx ppt pptx txt rss feed wp nofollow
noopener noreferrer target blank onclick datetime srcset sizes width height iframe embed meta charset viewport""".split())
WORDLIKE = re.compile(r"^[^\W\d_][\w'\-]*$", re.UNICODE)
FILTER_DEFAULT = {"exclude": [], "stop": True, "junk": True, "min": 0, "max": 0}
builtins_max = max


def is_junk(w):
    """Markup, code and identifier debris that web pages and exports leave in text (w is lowercase)."""
    if len(w) < 2 or len(w) > 24 or w in JUNK or not WORDLIKE.match(w):
        return True
    if any(ch.isdigit() for ch in w) or "_" in w:
        return True
    if re.match(r"^[bcdfghjklmnpqrstvwxz]{5,}$", w):        # consonant soup: ids, hashes
        return True
    return False


def clean_markup(b):
    """Turn web-page / JSON dumps back into prose: entities, tags, scripts, URLs, e-mails, hashes go; markup or JSON
    lines keep only their human-readable string values."""
    t = b.decode("utf-8", "replace")
    for _ in range(2):
        t = html.unescape(t)
    t = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", t)
    t = re.sub(r"(?s)<!--.*?-->", " ", t)
    t = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</h\d>|</li>|</tr>|</title>", "\n", t)
    t = re.sub(r"(?s)<[^<>]{0,2000}>", " ", t)
    t = re.sub(r"\\u([0-9a-fA-F]{4})", lambda m: chr(int(m.group(1), 16)), t)
    t = t.replace("\\/", "/").replace('\\"', '"').replace("\\n", "\n").replace("\\t", " ")
    t = re.sub(r"(?i)\b(?:https?://|www\.)\S+", " ", t)
    t = re.sub(r"\S+@\S+\.[A-Za-z]{2,}", " ", t)
    t = re.sub(r"\b[0-9a-fA-F]{10,}\b", " ", t)
    out = []
    for line in t.split("\n"):
        st = line.strip()
        if not st:
            out.append("")
            continue
        sym = sum(1 for ch in st if ch in '{}[]":,=<>|\\/_;#@$%^&*~`')
        if len(st) > 30 and sym > len(st) * 0.12:
            vals = re.findall(r'"([^"]{3,})"', st)
            keep = [v.strip() for v in vals if len(re.findall(r"[^\W\d_]{2,}", v)) >= 3 and not re.search(r"[{}<>=]", v)]
            if keep:
                out.append(" ".join(keep))
            continue
        out.append(st)
    t = "\n".join(out)
    t = re.sub(r"[ \t]{2,}", " ", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.encode("utf-8")


os.makedirs(ROOT, exist_ok=True)

# ---------------------------------------------------------------- kernels
_SRC = r'''
__device__ __forceinline__ bool W(unsigned char x){ return (x>='a'&&x<='z')||(x>='A'&&x<='Z')||(x>='0'&&x<='9')||x==39||x>=128; }
__device__ __forceinline__ bool P(unsigned char x){ return x=='.'||x==','||x=='!'||x=='?'||x==';'||x==':'||x=='"'||x=='('||x==')'||x=='-'; }
__device__ __forceinline__ bool S(const unsigned char* b, long long i, long long nb){
  unsigned char c=b[i]; unsigned char p = i>0 ? b[i-1] : 32; unsigned char n = i+1<nb ? b[i+1] : 32;
  if (W(c)) return !W(p);
  if (P(c)) return true;
  if (c==10) return n==10 && p!=10;
  return false; }
extern "C" __global__ void tcount(const unsigned char* b, long long nb, int span, int* cnt, long long nt){
  long long t = blockDim.x*(long long)blockIdx.x+threadIdx.x; if (t>=nt) return;
  long long a=t*span, e=a+span; if (e>nb) e=nb; int c=0;
  for (long long i=a;i<e;i++) if (S(b,i,nb)) c++;
  cnt[t]=c; }
extern "C" __global__ void temit(const unsigned char* b, long long nb, int span, const long long* off, long long nt,
    long long* st, unsigned long long* hs, int* ln){
  long long t = blockDim.x*(long long)blockIdx.x+threadIdx.x; if (t>=nt) return;
  long long a=t*span, e=a+span; if (e>nb) e=nb; long long k=off[t];
  for (long long i=a;i<e;i++) if (S(b,i,nb)) {
    unsigned char c=b[i]; unsigned long long h=1469598103934665603ULL; int L=0;
    if (W(c)) { while (i+L<nb && W(b[i+L])) { h^=b[i+L]; h*=1099511628211ULL; L++; } }
    else if (c==10) { h^=10; h*=1099511628211ULL; h^=10; h*=1099511628211ULL; L=2; }
    else { h^=c; h*=1099511628211ULL; L=1; }
    st[k]=i; hs[k]=h; ln[k]=L; k++; } }
extern "C" __global__ void findset(const uint4* s, long long n8, const unsigned short* codes, int nc,
    unsigned long long* cnt, long long* out, long long cap, long long base){
  long long stride=(long long)blockDim.x*gridDim.x;
  for (long long i=blockDim.x*(long long)blockIdx.x+threadIdx.x; i<n8; i+=stride){
    uint4 v=s[i]; unsigned int w[4]={v.x,v.y,v.z,v.w};
    #pragma unroll
    for (int j=0;j<8;j++){
      unsigned short t = (unsigned short)((j&1) ? (w[j>>1]>>16) : (w[j>>1]&0xFFFFu));
      for (int c=0;c<nc;c++) if (t==codes[c]) { unsigned long long k=atomicAdd(cnt,1ULL); if (k<(unsigned long long)cap) out[k]=base+i*8+j; break; }
    } } }
extern "C" __global__ void pairhist(const unsigned short* s, long long n, const int* lut, int N, unsigned int* hist){
  long long stride=(long long)blockDim.x*gridDim.x;
  for (long long i=blockDim.x*(long long)blockIdx.x+threadIdx.x; i+1<n; i+=stride){
    int a=lut[s[i]]; if (a<0) continue; int b=lut[s[i+1]]; if (b<0) continue;
    atomicAdd(&hist[(long long)a*N+b], 1u); } }
extern "C" __global__ void coocdir(const unsigned short* s, long long n, const int* lut, int N, int win, unsigned int* co){
  // one direction only: co[a][b] counts b within win words to the right of a (the left-context matrix is its transpose)
  long long stride=(long long)blockDim.x*gridDim.x;
  for (long long i=blockDim.x*(long long)blockIdx.x+threadIdx.x; i<n; i+=stride){
    int a=lut[s[i]]; if (a<0) continue;
    for (int d=1; d<=win; d++){ if (i+d>=n) break; int b=lut[s[i+d]]; if (b<0) continue;
      atomicAdd(&co[(long long)a*N+b], 1u); } } }
extern "C" __global__ void coocwin(const unsigned short* s, long long n, const int* lut, int N, int win, unsigned int* co){
  long long stride=(long long)blockDim.x*gridDim.x;
  for (long long i=blockDim.x*(long long)blockIdx.x+threadIdx.x; i<n; i+=stride){
    int a=lut[s[i]]; if (a<0) continue;
    for (int d=1; d<=win; d++){ if (i+d>=n) break; int b=lut[s[i+d]]; if (b<0) continue;
      atomicAdd(&co[(long long)a*N+b], 1u); atomicAdd(&co[(long long)b*N+a], 1u); } } }
extern "C" __global__ void seqhist(const unsigned short* s, long long n, const int* lut, int N, int win, unsigned int* h){
  long long stride=(long long)blockDim.x*gridDim.x;
  for (long long i=blockDim.x*(long long)blockIdx.x+threadIdx.x; i<n; i+=stride){
    int a=lut[s[i]]; if (a<0) continue;
    for (int d=1; d<=win; d++){ if (i+d>=n) break; int b=lut[s[i+d]]; if (b<0) continue;
      atomicAdd(&h[(long long)a*N+b], 1u); break; } } }
extern "C" __global__ void casemap(const unsigned char* in, unsigned char* out, long long n, int mode){
  long long i=blockDim.x*(long long)blockIdx.x+threadIdx.x; if (i>=n) return;
  unsigned char c=in[i];
  bool up=(c>='A'&&c<='Z'), lo=(c>='a'&&c<='z');
  if (mode==1){ out[i]= lo ? c-32 : c; return; }
  unsigned char l = up ? c+32 : c;
  if (mode==0 || !(up||lo)){ out[i]=l; return; }
  bool cap=false;
  if (mode==2){ unsigned char p = i>0 ? in[i-1] : 32;
    cap = !((p>='a'&&p<='z')||(p>='A'&&p<='Z')||(p>='0'&&p<='9')||p==39||p>=128); }
  else { long long j=i-1; int nl=0;
    while (j>=0 && i-j<64){ unsigned char q=in[j]; if (q==32||q==9||q=='"'||q=='('||q==39){ j--; continue; } if (q==10){ nl++; j--; continue; } break; }
    if (j<0) cap=true; else { unsigned char q=in[j];
      if (q=='!'||q=='?'||nl>=2) cap=true;
      else if (q=='.') { long long k=j-1; char w[5]; int L=0;
        while (k>=0 && L<5){ unsigned char z=in[k]; if (z>='A'&&z<='Z') z+=32; if (z<'a'||z>'z') break; w[L++]=z; k--; }
        bool ab=false;
        if (L>=1 && L<=4){ char r[5]; for (int u=0;u<L;u++) r[u]=w[L-1-u];
          if (L==2 && ((r[0]=='m'&&r[1]=='r')||(r[0]=='m'&&r[1]=='s')||(r[0]=='d'&&r[1]=='r')||(r[0]=='s'&&r[1]=='t')||(r[0]=='j'&&r[1]=='r')||(r[0]=='s'&&r[1]=='r')||(r[0]=='v'&&r[1]=='s')||(r[0]=='m'&&r[1]=='t')||(r[0]=='n'&&r[1]=='o')||(r[0]=='c'&&r[1]=='o')||(r[0]=='f'&&r[1]=='t'))) ab=true;
          if (L==3 && ((r[0]=='m'&&r[1]=='r'&&r[2]=='s')||(r[0]=='e'&&r[1]=='t'&&r[2]=='c')||(r[0]=='g'&&r[1]=='e'&&r[2]=='n')||(r[0]=='c'&&r[1]=='o'&&r[2]=='l')||(r[0]=='r'&&r[1]=='e'&&r[2]=='v')||(r[0]=='i'&&r[1]=='n'&&r[2]=='c'))) ab=true;
          if (L==4 && ((r[0]=='c'&&r[1]=='a'&&r[2]=='p'&&r[3]=='t')||(r[0]=='p'&&r[1]=='r'&&r[2]=='o'&&r[3]=='f'))) ab=true;
          if (L==1 && k>=0 && in[k]=='.') ab=true; }
        if (!ab) cap=true; } }
    unsigned char p = i>0 ? in[i-1] : 32; unsigned char nx = i+1<n ? in[i+1] : 32;
    bool pw=(p>='a'&&p<='z')||(p>='A'&&p<='Z'), nw=(nx>='a'&&nx<='z')||(nx>='A'&&nx<='Z')||nx==39;
    if (l=='i' && !pw && !nw) cap=true; }
  out[i] = cap ? l-32 : l; }
extern "C" __global__ void linehash(const unsigned char* b, const long long* ls, const long long* le, long long n, unsigned long long* h){
  long long i=blockDim.x*(long long)blockIdx.x+threadIdx.x; if (i>=n) return;
  unsigned long long x=1469598103934665603ULL;
  for (long long k=ls[i]; k<le[i]; k++){ x^=b[k]; x*=1099511628211ULL; }
  h[i]=x; }
extern "C" __global__ void lowerhash(const unsigned char* b, const long long* off, const int* ln, long long n, unsigned long long* h){
  long long i=blockDim.x*(long long)blockIdx.x+threadIdx.x; if (i>=n) return;
  unsigned long long x=1469598103934665603ULL;
  for (int k=0;k<ln[i];k++){ unsigned char c=b[off[i]+k]; if (c>='A'&&c<='Z') c+=32; x^=c; x*=1099511628211ULL; }
  h[i]=x; }
'''
_MOD = {}


def K(name):
    if "m" not in _MOD:
        _MOD["m"] = cp.RawModule(code=_SRC)
    return _MOD["m"].get_function(name)


def _grid(n, bs=256):
    return (max(1, int((n + bs - 1) // bs)),)


def fnv(tok):
    h = 1469598103934665603
    for x in tok:
        h ^= x
        h = (h * 1099511628211) & 0xFFFFFFFFFFFFFFFF
    return h


PARA_HASH = fnv(b"\n\n")

# ---------------------------------------------------------------- loading + normalising text
_NORM = [(b"\r\n", b"\n"), (b"\r", b"\n"), (b"\xef\xbb\xbf", b""), (b"\xe2\x80\x9c", b'"'), (b"\xe2\x80\x9d", b'"'),
         (b"\xe2\x80\x98", b"'"), (b"\xe2\x80\x99", b"'"), (b"\xe2\x80\x94", b"--"), (b"\xe2\x80\x93", b"-"),
         (b"\xe2\x80\xa6", b"..."), (b"\xc2\xa0", b" "),
         (b"&quot;", b'"'), (b"&#34;", b'"'), (b"&#39;", b"'"), (b"&apos;", b"'"), (b"&nbsp;", b" "), (b"&lt;", b"<"),
         (b"&gt;", b">"), (b"&amp;", b"&")]


def normalise(data):
    for a, b in _NORM:
        if a in data:
            data = data.replace(a, b)
    return data


def sources(name, path=None, data=None):
    """A dropped file -> [(doc name, opener)], where opener() gives a readable stream of plain text.
    Streams .gz .bz2 .xz and every text member of a .zip, so a 10 GB archive never sits whole in memory."""
    low = name.lower()
    raw = (lambda: open(path, "rb")) if path else (lambda: io.BytesIO(data))
    if low.endswith(".gz"):
        return [(name[:-3], lambda: gzip.open(raw()))]
    if low.endswith(".bz2"):
        return [(name[:-4], lambda: bz2.open(raw()))]
    if low.endswith((".xz", ".lzma")):
        return [(name.rsplit(".", 1)[0], lambda: lzma.open(raw()))]
    if low.endswith(".zip"):
        z = zipfile.ZipFile(path if path else io.BytesIO(data))
        out = []
        for n in z.namelist():
            if n.endswith("/") or n.startswith("__MACOSX"):
                continue
            if n.lower().endswith((".txt", ".md", ".csv", ".json", ".html", ".htm", ".xml", ".srt", ".log", ".tex", ".rst", ".eml")):
                out.append((n, (lambda n=n: z.open(n))))
        return out
    if low.endswith((".html", ".htm")):
        return [(name, lambda: io.BytesIO(strip_html(raw().read())))]
    if low.endswith((".pdf", ".docx", ".pptx", ".xlsx", ".epub", ".odt", ".rtf")):
        return [(name, lambda: io.BytesIO(extract_document(name, raw().read())))]
    return [(name, raw)]


def extract_document(name, data):
    """Pull the readable text out of a document and throw the rest away. Parsing a file format (unzipping a .docx,
    decoding a PDF's text operators) is byte-shuffling the CPU must do — the GPU can't parse formats. But it happens
    once, only the text is kept, and everything after (indexing, search, Markov) runs on the card."""
    low = name.lower()
    try:
        if low.endswith(".pdf"):
            from . import pdftext
            return pdftext.plain_text(data).encode("utf-8")
        if low.endswith(".docx"):
            import docx
            d = docx.Document(io.BytesIO(data))
            parts = [p.text for p in d.paragraphs]
            for t in d.tables:
                for row in t.rows:
                    parts.append("\t".join(c.text for c in row.cells))
            return "\n".join(parts).encode("utf-8")
        if low.endswith(".pptx"):
            from pptx import Presentation
            pr = Presentation(io.BytesIO(data))
            out = []
            for i, slide in enumerate(pr.slides):
                out.append("\n\n--- Slide {} ---".format(i + 1))
                for sh in slide.shapes:
                    if sh.has_text_frame:
                        out.append(sh.text_frame.text)
                    if sh.has_table:
                        for row in sh.table.rows:
                            out.append("\t".join(c.text for c in row.cells))
            return "\n".join(out).encode("utf-8")
        if low.endswith(".xlsx"):
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
            out = []
            for ws in wb.worksheets:
                out.append("\n\n### {} ###".format(ws.title))
                for row in ws.iter_rows(values_only=True):
                    out.append("\t".join("" if v is None else str(v) for v in row))
            return "\n".join(out).encode("utf-8")
        if low.endswith(".epub"):
            z = zipfile.ZipFile(io.BytesIO(data))
            html = b"".join(z.read(n) for n in z.namelist() if n.lower().endswith((".xhtml", ".html", ".htm")))
            return strip_html(html)
        if low.endswith(".rtf"):
            txt = re.sub(rb"\\[a-z]+-?\d* ?|[{}]", b" ", data)
            return re.sub(rb"\s+", b" ", txt)
    except Exception as e:  # noqa: BLE001
        raise ValueError("could not read {}: {}".format(name, e))
    return data


def _copy_norm(src, dst):
    """Normalise while copying, cutting only at an ASCII space/newline so no UTF-8 sequence or CRLF is split."""
    n, carry = 0, b""
    while True:
        buf = src.read(16 << 20)
        if not buf:
            break
        data = carry + buf
        k = max(data.rfind(b" ", 0, len(data) - 4), data.rfind(b"\n", 0, len(data) - 4))
        if k < 0:
            k = len(data) - 5
        carry, data = data[k + 1:], data[:k + 1]
        data = normalise(data)
        dst.write(data)
        n += len(data)
    data = normalise(carry)
    dst.write(data)
    return n + len(data)


def strip_html(b):
    b = re.sub(rb"(?is)<(script|style)[^>]*>.*?</\1>", b" ", b)
    b = re.sub(rb"(?s)<br\s*/?>|</p>|</div>|</h\d>|</li>", b"\n", b)
    b = re.sub(rb"(?s)<[^>]+>", b" ", b)
    try:
        return html.unescape(b.decode("utf-8", "replace")).encode("utf-8")
    except Exception:  # noqa: BLE001
        return b


def gutenberg_strip(b):
    s = b.find(b"*** START OF")
    if s >= 0:
        s = b.find(b"\n", s) + 1
        b = b[s:]
    e = b.find(b"*** END OF")
    if e >= 0:
        b = b[:e]
    return b.strip()


BUNDLES = {
    "classics": {"name": "Twenty classic novels", "ids": [1342, 2701, 84, 11, 1661, 98, 1400, 345, 174, 76, 1260, 768,
                                                          64317, 2554, 1184, 135, 1080, 158, 161, 2641]},
    "shakespeare": {"name": "Shakespeare: complete works", "ids": [100]},
    "holmes": {"name": "Sherlock Holmes", "ids": [1661, 834, 108, 2097, 244, 2852, 3289, 2350]},
    "philosophy": {"name": "Philosophy & ideas", "ids": [1497, 3300, 2009, 4363, 5827, 7370, 34901, 1232, 3207, 4280]},
    "war_peace": {"name": "War and Peace", "ids": [2600]},
}


def fetch_gutenberg(i):
    for url in ("https://www.gutenberg.org/cache/epub/{0}/pg{0}.txt".format(i),
                "https://www.gutenberg.org/files/{0}/{0}-0.txt".format(i)):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "vectorfall/1.0 (personal research)"})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            first = data[:4000].decode("utf-8", "replace")
            m = re.search(r"Title:\s*(.+)", first)
            return (m.group(1).strip() if m else "Gutenberg #{}".format(i)), gutenberg_strip(data)
        except Exception:  # noqa: BLE001
            continue
    raise RuntimeError("could not download Gutenberg #{}".format(i))


# ---------------------------------------------------------------- a corpus
class Corpus:
    def __init__(self, cid):
        self.id = cid
        self.dir = os.path.join(ROOT, cid)
        with open(os.path.join(self.dir, "meta.json")) as f:
            self.meta = json.load(f)
        self.raw = None
        self.codes = None
        self.segs = []              # [{"a": first token, "n": tokens, "gpu": cupy array | None}]
        self.ready = False

    # -- paths / meta -----------------------------------------------------
    @property
    def version(self):
        return self.meta["version"]

    def vpath(self, v=None):
        return os.path.join(self.dir, "v{}.txt".format(self.version if v is None else v))

    def ipath(self, name, v=None):
        return os.path.join(self.dir, "index_v{}".format(self.version if v is None else v), name)

    def content_hash(self):
        """sha256 of this version's text. Computed once and kept in meta.json; recomputed only if the file changes."""
        path = self.vpath()
        st = os.stat(path)
        ch = self.meta.get("content") or {}
        if ch.get("v") == self.version and ch.get("size") == st.st_size and ch.get("mtime") == st.st_mtime:
            return ch["sha"]
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for blk in iter(lambda: f.read(1 << 22), b""):
                h.update(blk)
        self.meta["content"] = {"v": self.version, "size": st.st_size, "mtime": st.st_mtime, "sha": h.hexdigest()}
        self.save_meta()
        return self.meta["content"]["sha"]

    def save_meta(self):
        tmp = os.path.join(self.dir, "meta.json.tmp")
        with open(tmp, "w") as f:
            json.dump(self.meta, f)
        os.replace(tmp, os.path.join(self.dir, "meta.json"))

    # -- indexing ---------------------------------------------------------
    def _chunks(self):
        n = self.raw.size
        a = 0
        while a < n:
            b = min(n, a + CHUNK)
            if b < n:                               # end the chunk right after a space so no token is cut
                win = np.asarray(self.raw[max(a, b - (1 << 20)):b])
                sp = np.flatnonzero(win == 32)
                if sp.size:
                    b = b - win.size + int(sp[-1]) + 1
            yield a, b
            a = b

    def _tok_gpu(self, host):
        b = cp.asarray(host)
        nb = b.size
        span = 64
        nt = (nb + span - 1) // span
        cnt = cp.empty(nt, cp.int32)
        K("tcount")(_grid(nt), (256,), (b, cp.int64(nb), cp.int32(span), cnt, cp.int64(nt)))
        off = (cp.cumsum(cnt, dtype=cp.int64) - cnt).astype(cp.int64)
        total = int(off[-1]) + int(cnt[-1]) if nt else 0
        st = cp.empty(total, cp.int64)
        hs = cp.empty(total, cp.uint64)
        ln = cp.empty(total, cp.int32)
        if total:
            K("temit")(_grid(nt), (256,), (b, cp.int64(nb), cp.int32(span), off, cp.int64(nt), st, hs, ln))
        return b, st, hs, ln

    def build_index(self, job=None):
        t0 = time.time()
        self.raw = np.memmap(self.vpath(), dtype=np.uint8, mode="r") if os.path.getsize(self.vpath()) else np.zeros(0, np.uint8)
        nbytes = int(self.raw.size)
        chunks = list(self._chunks())
        # pass 1: vocabulary with counts
        H, C, O, L = [], [], [], []
        acc = {"H": np.zeros(0, np.uint64), "C": np.zeros(0, np.int64), "O": np.zeros(0, np.int64), "L": np.zeros(0, np.int32)}
        total_tokens = 0

        def reduce_acc():
            if not H:
                return
            h = np.concatenate([acc["H"]] + H)
            c = np.concatenate([acc["C"]] + C)
            o = np.concatenate([acc["O"]] + O)
            l_ = np.concatenate([acc["L"]] + L)
            order = np.argsort(h, kind="mergesort")
            hs = h[order]
            first = np.flatnonzero(np.r_[True, hs[1:] != hs[:-1]])
            acc.update(H=hs[first], C=np.add.reduceat(c[order], first), O=o[order][first], L=l_[order][first])
            del H[:], C[:], O[:], L[:]

        for k, (a, b) in enumerate(chunks):
            host = np.ascontiguousarray(self.raw[a:b])

            def p1(host=host, a=a):
                bb, st, hs, ln = self._tok_gpu(host)
                if hs.size == 0:
                    return np.zeros(0, np.uint64), np.zeros(0, np.int64), np.zeros(0, np.int64), np.zeros(0, np.int32), 0
                u, ui, uc = cp.unique(hs, return_index=True, return_counts=True)
                return (cp.asnumpy(u), cp.asnumpy(uc).astype(np.int64), cp.asnumpy(st[ui]) + a,
                        cp.asnumpy(ln[ui]), int(hs.size))
            u, uc, uo, ul, n = engine.run_on_gpu(p1, "index pass 1", 300)
            H.append(u)
            C.append(uc)
            O.append(uo)
            L.append(ul)
            total_tokens += n
            if len(H) >= 12:
                reduce_acc()
            if job:
                job.step(0.45 * (k + 1) / len(chunks), "reading words: {:.0f} of {:.0f} MB".format(b / 2**20, nbytes / 2**20))
        reduce_acc()
        hsorted, counts, offs, lens = acc["H"], acc["C"], acc["O"], acc["L"]
        V = int(hsorted.size)
        rank = np.argsort(-counts, kind="mergesort")          # gid = frequency rank (0 = most common)
        gid_of_sorted = np.empty(V, np.uint32)
        gid_of_sorted[rank] = np.arange(V, dtype=np.uint32)
        vcounts, voffs, vlens, vhash = counts[rank], offs[rank], lens[rank], hsorted[rank]
        # vocabulary bytes (one blob + offsets), lower-case hashes for case-insensitive search
        blob_parts, boff = [], np.zeros(V + 1, np.int64)
        pos = 0
        for i in range(V):
            o, l_ = int(voffs[i]), int(vlens[i])
            w = b"\n\n" if self.raw[o] == 10 else bytes(self.raw[o:o + l_])
            blob_parts.append(w)
            pos += len(w)
            boff[i + 1] = pos
            if job and i % 200000 == 0 and V > 200000:
                job.step(0.45 + 0.05 * i / V, "building the vocabulary: {:,} of {:,} words".format(i, V))
        blob = np.frombuffer(b"".join(blob_parts), np.uint8) if blob_parts else np.zeros(0, np.uint8)

        def lowj():
            if V == 0:
                return np.zeros(0, np.uint64)
            gb = cp.asarray(blob)
            go = cp.asarray(boff[:-1])
            gl = cp.asarray(np.diff(boff).astype(np.int32))
            out = cp.empty(V, cp.uint64)
            K("lowerhash")(_grid(V), (256,), (gb, go, gl, cp.int64(V), out))
            return cp.asnumpy(out)
        lowh = engine.run_on_gpu(lowj, "vocabulary case folding", 120)

        # pass 2: encode the stream as uint16 codes + escapes + byte checkpoints
        codes = np.empty(total_tokens, np.uint16)
        esc_pos, esc_gid, ckpt = [], [], []
        T0 = 0
        gH = None
        for k, (a, b) in enumerate(chunks):
            host = np.ascontiguousarray(self.raw[a:b])

            def p2(host=host, a=a, T0=T0):
                nonlocal gH
                if gH is None:
                    gH = (cp.asarray(hsorted), cp.asarray(gid_of_sorted))
                bb, st, hs, ln = self._tok_gpu(host)
                n = int(hs.size)
                if n == 0:
                    return np.zeros(0, np.uint16), np.zeros(0, np.int64), np.zeros(0, np.uint32), np.zeros(0, np.int64)
                idx = cp.searchsorted(gH[0], hs)
                gid = gH[1][cp.minimum(idx, V - 1)]
                cd = cp.where(gid < COMMON, gid, ESC).astype(cp.uint16)
                el = cp.nonzero(gid >= COMMON)[0]
                first = (-T0) % CK
                ckl = cp.arange(first, n, CK, dtype=cp.int64)
                return (cp.asnumpy(cd), cp.asnumpy(el) + T0, cp.asnumpy(gid[el]).astype(np.uint32), cp.asnumpy(st[ckl]) + a)
            cd, ep, eg, ck = engine.run_on_gpu(p2, "index pass 2", 300)
            codes[T0:T0 + cd.size] = cd
            esc_pos.append(ep)
            esc_gid.append(eg)
            ckpt.append(ck)
            T0 += cd.size
            if job:
                job.step(0.5 + 0.45 * (k + 1) / len(chunks), "compress onto the card: {:.0f} of {:.0f} MB".format(b / 2**20, nbytes / 2**20))
        engine.run_on_gpu(lambda: cp.get_default_memory_pool().free_all_blocks(), "free")
        idir = os.path.dirname(self.ipath("x"))
        if os.path.isdir(idir):
            shutil.rmtree(idir)
        os.makedirs(idir)
        np.save(self.ipath("codes.npy"), codes)
        np.save(self.ipath("esc_pos.npy"), np.concatenate(esc_pos) if esc_pos else np.zeros(0, np.int64))
        np.save(self.ipath("esc_gid.npy"), np.concatenate(esc_gid) if esc_gid else np.zeros(0, np.uint32))
        np.save(self.ipath("ckpt.npy"), np.concatenate(ckpt) if ckpt else np.zeros(0, np.int64))
        np.save(self.ipath("vhash.npy"), vhash)
        np.save(self.ipath("vcount.npy"), vcounts)
        np.save(self.ipath("vlow.npy"), lowh)
        np.save(self.ipath("vboff.npy"), boff)
        np.save(self.ipath("vblob.npy"), blob)
        self.meta["index"] = {"version": self.version, "tokens": int(total_tokens), "vocab": V, "bytes": nbytes,
                              "built_s": round(time.time() - t0, 1), "built_at": time.time()}
        self.save_meta()

    # -- activation -------------------------------------------------------
    def load(self, job=None):
        ix = self.meta.get("index") or {}
        if ix.get("version") != self.version or not os.path.exists(self.ipath("codes.npy")):
            self.build_index(job)
        self.raw = np.memmap(self.vpath(), dtype=np.uint8, mode="r") if os.path.getsize(self.vpath()) else np.zeros(0, np.uint8)
        self.codes = np.load(self.ipath("codes.npy"))
        self.esc_pos = np.load(self.ipath("esc_pos.npy"))
        self.esc_gid = np.load(self.ipath("esc_gid.npy"))
        self.ckpt = np.load(self.ipath("ckpt.npy"))
        self.vhash = np.load(self.ipath("vhash.npy"))
        self.vcount = np.load(self.ipath("vcount.npy"))
        self.vlow = np.load(self.ipath("vlow.npy"))
        self.vboff = np.load(self.ipath("vboff.npy"))
        self.vblob = np.load(self.ipath("vblob.npy"))
        self.T = int(self.codes.size)
        self.V = int(self.vhash.size)
        self.hash_order = np.argsort(self.vhash)
        self.hash_sorted = self.vhash[self.hash_order]
        self.low_order = np.argsort(self.vlow, kind="mergesort")
        self.low_sorted = self.vlow[self.low_order]
        # one id per case-insensitive group (for stats / tables)
        first = np.flatnonzero(np.r_[True, self.low_sorted[1:] != self.low_sorted[:-1]]) if self.V else np.zeros(0, np.int64)
        grp = np.zeros(self.V, np.int64)
        if self.V:
            g = np.cumsum(np.r_[0, (self.low_sorted[1:] != self.low_sorted[:-1]).astype(np.int64)])
            grp[self.low_order] = g
        self.lgroup = grp
        self.ngroups = int(first.size)
        self._stats = None
        self._gsum = None
        self._emb = None
        self.filt = None
        self._gw = None
        self._ispunct = None
        self._invalidate_filter()
        self.attach_gpu()
        self.ready = True

    def attach_gpu(self):
        def up():
            self.release_gpu_inner()
            free = cp.cuda.runtime.memGetInfo()[0]
            budget = free - RESERVE
            self.segs = []
            for a in range(0, self.T, SEG):
                n = min(SEG, self.T - a)
                padded = (n + 7) // 8 * 8
                g = None
                if padded * 2 <= budget:
                    g = cp.full(padded, PAD, cp.uint16)
                    g[:n] = cp.asarray(self.codes[a:a + n])
                    budget -= padded * 2
                self.segs.append({"a": a, "n": n, "gpu": g})
            return sum(1 for s in self.segs if s["gpu"] is not None)
        return engine.run_on_gpu(up, "upload corpus", 300)

    def release_gpu_inner(self):
        for s in self.segs:
            s["gpu"] = None
        self.segs = []
        cp.get_default_memory_pool().free_all_blocks()

    def release(self):
        engine.run_on_gpu(self.release_gpu_inner, "release corpus", 60)
        self.ready = False

    def residency(self):
        res = [s for s in self.segs if s["gpu"] is not None]
        return {"segments": len(self.segs), "resident": len(res),
                "on_card_mb": round(sum(s["n"] for s in res) * 2 / 2**20, 1),
                "stream_mb": round(self.T * 2 / 2**20, 1)}

    # -- vocabulary -------------------------------------------------------
    def word_b(self, g):
        return bytes(self.vblob[self.vboff[g]:self.vboff[g + 1]])

    def word(self, g):
        return self.word_b(int(g)).decode("utf-8", "replace")

    def gid_exact(self, tok):
        h = np.uint64(fnv(tok))
        i = int(np.searchsorted(self.hash_sorted, h))
        if i < self.V and self.hash_sorted[i] == h:
            return int(self.hash_order[i])
        return None

    def gids_any_case(self, tok):
        h = np.uint64(fnv(tok.lower()))
        a = int(np.searchsorted(self.low_sorted, h, "left"))
        b = int(np.searchsorted(self.low_sorted, h, "right"))
        return [int(x) for x in self.low_order[a:b]]

    def query_terms(self, text, case=False):
        """Tokenise a query exactly like the corpus; each token -> the set of matching vocabulary ids."""
        toks = TOKEN_RE.findall(normalise(text.encode("utf-8")))
        out = []
        for t in toks:
            if t.startswith(b"\n"):
                t = b"\n\n"
            ids = ([self.gid_exact(t)] if self.gid_exact(t) is not None else []) if case else self.gids_any_case(t)
            out.append({"tok": t.decode("utf-8", "replace"), "ids": ids})
        return out

    # -- the scan ---------------------------------------------------------
    def _scan(self, ids, cap=None):
        """Every position of any of these vocabulary ids (sorted), via the GPU scan; rare ids from the escape table.
        cap limits how many positions come back (the count is always exact); buffers stay small, segment by segment."""
        common = [i for i in ids if i < COMMON][:16]
        rare = [i for i in ids if i >= COMMON]
        parts, total = [], 0
        if common:
            exp_total = int(self.vcount[np.array(common)].sum())
            want = exp_total if cap is None else min(cap, exp_total)

            def job():
                got, tot, kept = [], 0, 0
                codes = cp.asarray(np.array(common, np.uint16))
                cnt = cp.zeros(1, cp.uint64)
                for s_ in self.segs:
                    g = s_["gpu"]
                    if g is None:
                        n = s_["n"]
                        g = cp.full((n + 7) // 8 * 8, PAD, cp.uint16)
                        g[:n] = cp.asarray(self.codes[s_["a"]:s_["a"] + n])
                    n8 = g.size // 8
                    exp_seg = exp_total * s_["n"] / max(1, self.T)
                    nparts = max(1, int(math.ceil(exp_seg * 1.3 / 5e6)))
                    for q in range(nparts):
                        a8, b8 = n8 * q // nparts, n8 * (q + 1) // nparts
                        room = max(0, want - kept)
                        bufn = int(min(room, 8_000_000))
                        out = cp.empty(max(1, bufn), cp.int64)
                        cnt.fill(0)
                        K("findset")((96,), (256,), (g[a8 * 8:b8 * 8], cp.int64(b8 - a8), codes, cp.int32(len(common)), cnt,
                                                     out, cp.int64(bufn), cp.int64(s_["a"] + a8 * 8)))
                        c = int(cnt[0])
                        tot += c
                        k = min(c, bufn)
                        if k:
                            got.append(cp.asnumpy(out[:k]))
                            kept += k
                    del g
                return got, tot
            got, total = engine.run_on_gpu(job, "scan", 300)
            parts += got
        if rare:
            m = np.isin(self.esc_gid, np.array(rare, np.uint32))
            rp = self.esc_pos[m]
            total += int(rp.size)
            if cap is not None:
                rp = rp[:max(0, cap - sum(p_.size for p_ in parts))]
            parts.append(rp)
        pos = np.sort(np.concatenate(parts)) if parts else np.zeros(0, np.int64)
        return pos, total

    def gids_at(self, idx):
        idx = np.asarray(idx, np.int64)
        ok = (idx >= 0) & (idx < self.T)
        out = np.full(idx.size, -1, np.int64)
        v = self.codes[idx[ok]].astype(np.int64)
        e = v == ESC
        if e.any():
            q = idx[ok][e]
            j = np.searchsorted(self.esc_pos, q)
            j = np.minimum(j, self.esc_pos.size - 1)
            v[e] = np.where(self.esc_pos[j] == q, self.esc_gid[j].astype(np.int64), -1)
        out[ok] = v
        return out

    def phrase(self, terms, cap=None):
        """Positions where the tokens of `terms` occur in sequence. Scans the rarest term on the GPU, verifies the rest."""
        t0 = time.time()
        if not terms or any(not t["ids"] for t in terms):
            return np.zeros(0, np.int64), 0, 0.0
        cost = [int(self.vcount[np.array(t["ids"])].sum()) for t in terms]
        r = int(np.argmin(cost))
        single = len(terms) == 1
        pos, total = self._scan(terms[r]["ids"], cap if single else (None if cost[r] < 6_000_000 else 3_000_000))
        if not single:
            for j, t in enumerate(terms):
                if j == r or pos.size == 0:
                    continue
                g = self.gids_at(pos + (j - r))
                pos = pos[np.isin(g, np.array(t["ids"], np.int64))]
            pos = pos - r
            total = int(pos.size)
            if cap is not None:
                pos = pos[:cap]
        return pos, total, round((time.time() - t0) * 1000, 2)

    # -- byte offsets of tokens (exact text) -------------------------------
    def spans(self, j0, n):
        if self.T == 0:
            return []
        j0 = max(0, min(int(j0), self.T - 1))
        ck = j0 // CK
        off = int(self.ckpt[ck]) if ck < self.ckpt.size else 0
        skip = j0 - ck * CK
        need = skip + n
        window = max(4096, need * 24)
        size = self.raw.size
        while True:
            buf = bytes(self.raw[off:off + window])
            out = []
            for m in TOKEN_RE.finditer(buf):
                out.append(m.span())
                if len(out) >= need:
                    break
            if (len(out) >= need and out[-1][1] < len(buf)) or off + window >= size:
                break
            window *= 4
        return [(off + a, off + b) for a, b in out[skip:skip + n]]

    def text(self, a, b):
        return bytes(self.raw[max(0, a):max(0, b)]).decode("utf-8", "replace")

    def read(self, at, hl=0, before=2500, after=4000):
        """The document around a byte, cut at paragraph breaks: pre | the found stretch | post."""
        raw, size = self.raw, len(self.raw)
        docs = self.meta.get("docs") or []
        at = max(0, min(int(at), size))
        ds, de, name = 0, size, None
        for k, d in enumerate(docs):
            if d["start"] <= at:
                ds, name = d["start"], d["name"]
                de = docs[k + 1]["start"] if k + 1 < len(docs) else size
            else:
                break
        he = min(de, at + max(0, int(hl)))
        a, b = max(ds, at - max(0, int(before))), min(de, he + max(0, int(after)))
        if a > ds and at - a > 400:                        # start at a paragraph (or at least a line) break
            seg = bytes(raw[a:at - 200])
            j = seg.find(b"\n\n")
            j = j + 2 if j >= 0 else (seg.find(b"\n") + 1 if b"\n" in seg else 0)
            a += j
        if b < de and b - he > 400:
            seg = bytes(raw[he + 200:b])
            j = seg.rfind(b"\n\n")
            if j < 0:
                j = seg.rfind(b"\n")
            if j > 0:
                b = he + 200 + j
        def snap(x):                                       # never cut inside a UTF-8 character
            while 0 < x < size and (raw[x] & 0xC0) == 0x80:
                x += 1
            return x
        a, b, at2, he = snap(a), snap(b), snap(at), snap(he)
        return {"doc": name, "doc_start": int(ds), "doc_end": int(de), "a": int(a), "b": int(b), "at": int(at2), "end": int(he),
                "pre": self.text(a, at2), "match": self.text(at2, he), "post": self.text(he, b),
                "pct": round((at2 - ds) / max(1, de - ds), 4), "doc_bytes": int(de - ds)}

    def doc_at(self, byte):
        docs = self.meta.get("docs") or []
        best = None
        for d in docs:
            if d["start"] <= byte:
                best = d
            else:
                break
        return best["name"] if best else None

    def kwic(self, positions, k, width=90):
        out = []
        for p in positions:
            sp = self.spans(int(p), k)
            if not sp:
                continue
            a, b = sp[0][0], sp[-1][1]
            left = self.text(a - width, a)
            right = self.text(b, b + width)
            left = left.split("\n\n")[-1].replace("\n", " ")
            right = right.split("\n\n")[0].replace("\n", " ")
            out.append({"pos": int(p), "byte": a, "end": b, "left": left, "match": self.text(a, b).replace("\n", " "),
                        "right": right, "doc": self.doc_at(a)})
        return out

    # -- features ---------------------------------------------------------
    def search(self, q, case=False, limit=60, offset=0, sample=False):
        terms = self.query_terms(q, case)
        pos, total, ms = self.phrase(terms, 300_000)
        if sample and pos.size > limit:
            pick = np.sort(np.random.RandomState(7).choice(pos.size, limit, replace=False))
            shown = pos[pick]
        else:
            shown = pos[offset:offset + limit]
        t = time.time()
        hits = self.kwic(shown, max(1, len(terms)))
        return {"query": q, "terms": [t_["tok"] for t_ in terms], "unknown": [t_["tok"] for t_ in terms if not t_["ids"]],
                "count": int(total), "gpu_ms": ms, "sampled": bool(total > pos.size), "offset": offset, "snippet_ms": round((time.time() - t) * 1000, 1), "hits": hits,
                "per_million": round(total / max(1, self.T) * 1e6, 2)}

    def neighbours(self, q, side="next", top=24, case=False, show_off=False):
        terms = self.query_terms(q, case)
        pos, total, ms = self.phrase(terms, 2_000_000)
        if pos.size == 0:
            return {"query": q, "count": 0, "items": [], "gpu_ms": ms}
        if pos.size > 4_000_000:
            pos = pos[np.random.RandomState(3).choice(pos.size, 4_000_000, replace=False)]
        g = self.gids_at(pos + len(terms) if side == "next" else pos - 1)
        g = g[g >= 0]
        u, c = np.unique(g, return_counts=True)
        n = int(c.sum())
        ent = float(-(c / n * np.log2(c / n)).sum()) if n else 0.0
        distinct = int(u.size)
        if not show_off:
            keep = self.gen_mask()[u] & ~self.punct_mask()[u]
            u, c = u[keep], c[keep]
        o = np.argsort(-c)[:top]
        return {"query": q, "side": side, "count": int(total), "gpu_ms": ms, "distinct": distinct, "entropy_bits": round(ent, 2),
                "shown_mentions": int(c.sum()),
                "items": [{"word": self.word(u[i]), "count": int(c[i]), "p": round(float(c[i]) / n, 4)} for i in o]}

    def generate(self, seed="", order=2, n=80, temp=1.0, rs=None):
        rng = np.random.RandomState(rs if rs is not None else int(time.time() * 1000) % (2**31))
        t0 = time.time()
        toks = []
        for t in TOKEN_RE.findall(normalise(seed.encode("utf-8"))):
            g = self.gid_exact(b"\n\n" if t.startswith(b"\n") else t)
            if g is not None:
                toks.append(g)
        out = []
        if not toks:                                   # start at a random sentence start
            dot = self.gid_exact(b".")
            if dot is not None:
                p, _, _ = self.phrase([{"tok": ".", "ids": [dot]}], 5000)
                if p.size:
                    s = int(p[rng.randint(p.size)]) + 1
                    toks = [int(self.gids_at([s])[0])]
                    out.append((toks[0], s))
        cache = {}
        scans = 0
        for _ in range(int(n)):
            nxt = None
            for k in range(min(order, len(toks)), 0, -1):
                ctx = tuple(toks[-k:])
                if ctx not in cache:
                    pos, _, _ = self.phrase([{"tok": "", "ids": [g]} for g in ctx], 200_000)
                    scans += 1
                    cache[ctx] = pos[pos + k < self.T]
                P = cache[ctx]
                if P.size:
                    vals = self.gids_at(P + k)
                    if temp != 1.0 and vals.size > 1:
                        u, inv, c = np.unique(vals, return_inverse=True, return_counts=True)
                        w = c.astype(np.float64) ** (1.0 / max(0.05, temp))
                        j = rng.choice(u.size, p=w / w.sum())
                        cand = np.flatnonzero(inv == j)
                        i = int(cand[rng.randint(cand.size)])
                    else:
                        i = rng.randint(vals.size)
                    nxt, src, used = int(vals[i]), int(P[i]) + k, k
                    break
            if nxt is None:
                src = rng.randint(max(1, self.T))
                nxt, used = int(self.gids_at([src])[0]), 0
            toks.append(nxt)
            out.append((nxt, src, used))
        words = []
        for item in out:
            g, src = item[0], item[1]
            used = item[2] if len(item) > 2 else 0
            words.append({"w": self.word(g), "src": int(src), "order": used})
        seed_words = [self.word(g) for g in toks[:len(toks) - len(out)]] if len(toks) > len(out) else []
        return {"seed": detok(seed_words), "text": detok(seed_words + [w["w"] for w in words]), "words": words,
                "ms": round((time.time() - t0) * 1000, 1), "scans": scans, "order": order}

    def source(self, pos, width=220):
        sp = self.spans(int(pos), 1)
        if not sp:
            return {}
        a, b = sp[0]
        return {"byte": a, "end": b, "left": self.text(a - width, a).replace("\n", " "), "match": self.text(a, b),
                "right": self.text(b, b + width).replace("\n", " "), "doc": self.doc_at(a)}

    def retrieve(self, q, top=8):
        t0 = time.time()
        terms = [t for t in self.query_terms(q) if t["ids"] and t["tok"].lower() not in STOP and len(t["tok"]) > 1]
        npass = max(1, (self.T + WINDOW - 1) // WINDOW)
        score = np.zeros(npass, np.float32)
        used = []
        for t in terms[:12]:
            pos, total = self._scan(t["ids"], None)
            if not pos.size:
                continue
            tf = np.bincount(pos // WINDOW, minlength=npass).astype(np.float32)
            df = int((tf > 0).sum())
            idf = math.log((npass - df + 0.5) / (df + 0.5) + 1.0)
            score += idf * tf * 2.2 / (tf + 1.2)
            used.append({"term": t["tok"], "passages": df, "idf": round(idf, 2)})
        if not used:
            return {"query": q, "passages": [], "terms": [], "ms": round((time.time() - t0) * 1000, 1)}
        k = min(top, int((score > 0).sum()))
        best = np.argsort(-score)[:k]
        out = []
        for p in best:
            a_tok, b_tok = int(p) * WINDOW, min(self.T - 1, int(p) * WINDOW + WINDOW - 1)
            sa, sb = self.spans(a_tok, 1), self.spans(b_tok, 1)
            if not sa or not sb:
                continue
            out.append({"passage": int(p), "score": round(float(score[p]), 2), "doc": self.doc_at(sa[0][0]), "byte": sa[0][0], "end": sb[0][1],
                        "text": self.text(sa[0][0], sb[0][1]).strip()})
        return {"query": q, "terms": used, "passages": out, "ms": round((time.time() - t0) * 1000, 1), "of": npass}

    # -- statistics ---------------------------------------------------------
    def stats(self):
        st = dict(self._stats_base())
        gsum, rep = self._groups()
        allow = self.allow_mask()
        top = []
        for gi in np.argsort(-gsum)[:50000]:
            if allow[gi] and rep[gi] >= 0:
                top.append({"w": self.word(int(rep[gi])), "c": int(gsum[gi])})
                if len(top) >= 80:
                    break
        st["top_content"] = top
        st["filter"] = self.filter_info()
        return st

    def _stats_base(self):
        if self._stats:
            return self._stats
        t0 = time.time()
        V = self.V
        kinds = np.zeros(V, np.int8)
        top = min(V, 300000)
        syl_w = 0.0
        letters = 0.0
        hist = np.zeros(21, np.int64)
        for g in range(V if V <= 300000 else top):
            w = self.word_b(g)
            if w == b"\n\n":
                kinds[g] = 2
                continue
            if len(w) == 1 and w[0] in PUNCT:
                kinds[g] = 1
                continue
            c = int(self.vcount[g])
            s = w.decode("utf-8", "replace").lower()
            syl = max(1, len(re.findall(r"[aeiouy]+", s)) - (1 if s.endswith("e") and len(s) > 3 else 0))
            syl_w += syl * c
            letters += len(s) * c
            hist[min(20, len(s))] += c
        words_n = int(self.vcount[kinds == 0].sum())
        punct = {self.word(g): int(self.vcount[g]) for g in np.flatnonzero(kinds == 1)}
        sentences = max(1, punct.get(".", 0) + punct.get("!", 0) + punct.get("?", 0))
        paras = int(self.vcount[kinds == 2].sum())
        wmask = kinds == 0
        wps = words_n / sentences
        spw = syl_w / max(1, words_n if V <= 300000 else self.vcount[:top][wmask[:top]].sum())
        # case-insensitive top words
        gsum = np.bincount(self.lgroup[wmask], weights=self.vcount[wmask].astype(np.float64), minlength=self.ngroups)
        rep = np.full(self.ngroups, -1, np.int64)
        idx = np.flatnonzero(wmask)[::-1]
        rep[self.lgroup[idx]] = idx                     # most frequent spelling represents its group (words only)
        order = np.argsort(-gsum)
        topw, topc = [], []
        for gi in order[:3000]:
            if rep[gi] < 0 or gsum[gi] <= 0:
                continue
            w = self.word(rep[gi])
            topw.append(w)
            topc.append(int(gsum[gi]))
        content = [(w, c) for w, c in zip(topw, topc) if w.lower() not in STOP and not w.isdigit()]
        hapax = int(((gsum == 1)).sum())
        unique_ci = int((gsum > 0).sum())
        fre = 206.835 - 1.015 * wps - 84.6 * spw
        fk = 0.39 * wps + 11.8 * spw - 15.59
        zipf = [int(x) for x in np.sort(gsum[gsum > 0])[::-1][:4000]]
        self._stats = {"bytes": int(self.raw.size), "tokens": self.T, "words": words_n, "vocab": V, "unique_words": unique_ci,
                       "sentences": sentences, "paragraphs": paras, "hapax": hapax,
                       "type_token": round(unique_ci / max(1, words_n), 4), "words_per_sentence": round(wps, 1),
                       "letters_per_word": round(letters / max(1, words_n), 2), "syllables_per_word": round(spw, 2),
                       "reading_ease": round(fre, 1), "grade_level": round(fk, 1),
                       "reading_minutes": round(words_n / 238.0, 1),
                       "top_words": [{"w": w, "c": c} for w, c in zip(topw[:60], topc[:60])],
                       "top_content": [{"w": w, "c": c} for w, c in content[:80]],
                       "word_lengths": [int(x) for x in hist], "zipf": zipf, "punctuation": punct,
                       "compression": round(self.raw.size / max(1, self.T * 2 + self.esc_pos.size * 12), 2),
                       "ms": round((time.time() - t0) * 1000, 1)}
        return self._stats

    # ---- the vocabulary filter: every view (graphs, tables, embeddings, generation) respects it -------------
    def _fpath(self):
        return os.path.join(self.dir, "filter.json")

    def get_filter(self):
        if getattr(self, "filt", None) is None:
            f = dict(FILTER_DEFAULT)
            try:
                with open(self._fpath()) as fh:
                    f.update(json.load(fh))
            except Exception:  # noqa: BLE001
                pass
            self.filt = f
        return self.filt

    def _invalidate_filter(self):
        self._allow = None
        self._gallow = None
        self._emb = None
        self._maps = {}
        self._sem = {}
        self._gid_row = None

    def set_filter(self, exclude=None, stop=None, junk=None, min=None, max=None):  # noqa: A002
        f = dict(self.get_filter())
        if stop is not None:
            f["stop"] = bool(stop)
        if junk is not None:
            f["junk"] = bool(junk)
        if min is not None:
            f["min"] = int(builtins_max(0, int(min)))
        if max is not None:
            f["max"] = int(builtins_max(0, int(max)))
        if exclude is not None:
            f["exclude"] = sorted({str(w).strip().lower() for w in exclude if str(w).strip()})
        self.filt = f
        with open(self._fpath(), "w") as fh:
            json.dump(f, fh)
        self._invalidate_filter()
        return self.filter_info()

    def toggle_word(self, word, off=None):
        f = self.get_filter()
        w = str(word).strip().lower()
        ex = set(f["exclude"])
        if off is None:
            off = w not in ex
        (ex.add if off else ex.discard)(w)
        return self.set_filter(exclude=sorted(ex))

    def _glower(self):
        if getattr(self, "_gw", None) is None:
            _, rep = self._groups()
            self._gw = [self.word(int(r)).lower() if r >= 0 else "" for r in rep]
        return self._gw

    def punct_mask(self):
        """Per vocabulary id: punctuation or paragraph break (never listed as words, always usable by generation)."""
        if getattr(self, "_ispunct", None) is None:
            m = np.zeros(self.V, bool)
            for g in range(self.V):
                w = self.word_b(g)
                if w == b"\n\n" or (len(w) == 1 and w[0] in PUNCT):
                    m[g] = True
            self._ispunct = m
        return self._ispunct

    def allow_mask(self):
        """Per case-insensitive group: does the current filter let this word through?"""
        if getattr(self, "_allow", None) is None:
            f = self.get_filter()
            gsum, _ = self._groups()
            ex = set(f["exclude"])
            a = np.zeros(self.ngroups, bool)
            for gi, w in enumerate(self._glower()):
                if not w or not WORDLIKE.match(w) or w in ex:
                    continue
                if f["stop"] and w in STOP:
                    continue
                if f["junk"] and is_junk(w):
                    continue
                a[gi] = True
            if f["min"]:
                a &= gsum >= f["min"]
            if f["max"]:
                a &= gsum <= f["max"]
            self._allow = a
            self._gallow = a[self.lgroup] | self.punct_mask()
        return self._allow

    def gen_mask(self):
        """Per vocabulary id: may generation emit it (allowed words + punctuation)?"""
        self.allow_mask()
        return self._gallow

    def filter_info(self):
        a = self.allow_mask()
        gsum, _ = self._groups()
        f = self.get_filter()
        wordlike = np.array([bool(w) and bool(WORDLIKE.match(w)) for w in self._glower()], bool)
        return {"filter": f, "words": int(wordlike.sum()), "allowed": int(a.sum()),
                "allowed_mentions": int(gsum[a].sum()), "mentions": int(gsum[wordlike].sum()),
                "max_count": int(gsum.max()) if gsum.size else 0}

    def word_allowed(self, w):
        gs = self.gids_any_case(str(w).lower().encode("utf-8"))
        if not gs:
            return False
        return bool(self.allow_mask()[self.lgroup[gs[0]]])

    def _groups(self):
        """Case-insensitive groups: total count per group and its most frequent spelling."""
        if self._gsum is None or getattr(self, "_rep", None) is None:
            gsum = np.bincount(self.lgroup, weights=self.vcount.astype(np.float64), minlength=self.ngroups)
            rep = np.full(self.ngroups, -1, np.int64)
            idx = np.arange(self.V)[::-1]
            rep[self.lgroup[idx]] = idx
            self._gsum, self._rep = gsum, rep        # assign together, only after both succeed
        return self._gsum, self._rep

    def _content_lut(self, n):
        """LUT code -> index of the top-n content words (case-insensitive), -1 for everything else."""
        gsum, rep = self._groups()
        allow = self.allow_mask()
        words = []
        for gi in np.argsort(-gsum):
            g = rep[gi]
            if g < 0 or not allow[gi]:
                continue
            w = self.word(g).lower()
            words.append(w)
            if len(words) >= n:
                break
        lut = np.full(65536, -1, np.int32)
        for k, w in enumerate(words):
            for g in self.gids_any_case(w.encode("utf-8")):
                if g < COMMON:
                    lut[g] = k
        return lut, words

    def pairs(self, n=40):
        """Word-to-word transition counts among the top-n content words (one GPU pass with atomics)."""
        t0 = time.time()
        lut, names = self._content_lut(n)
        N = len(names)

        def job():
            gl = cp.asarray(lut)
            h = cp.zeros(N * N, cp.uint32)
            for s in self.segs:
                g = s["gpu"] if s["gpu"] is not None else cp.asarray(self.codes[s["a"]:s["a"] + s["n"]])
                K("pairhist")((96,), (256,), (g, cp.int64(s["n"]), gl, cp.int32(N), h))
            return cp.asnumpy(h).reshape(N, N)
        m = engine.run_on_gpu(job, "transition matrix", 120)
        return {"words": names, "matrix": m.tolist(), "ms": round((time.time() - t0) * 1000, 1)}

    def bigrams(self, top=60):
        t0 = time.time()
        lut, names = self._content_lut(2000) if self.V else (None, [])
        N = len(names)
        if not N:
            return {"items": [], "ms": 0}

        def job():
            gl = cp.asarray(lut)
            h = cp.zeros(N * N, cp.uint32)
            for s in self.segs:
                g = s["gpu"] if s["gpu"] is not None else cp.asarray(self.codes[s["a"]:s["a"] + s["n"]])
                K("pairhist")((96,), (256,), (g, cp.int64(s["n"]), gl, cp.int32(N), h))
            o = cp.argsort(-h.astype(cp.int64))[:top]
            return cp.asnumpy(o), cp.asnumpy(h[o])
        o, c = engine.run_on_gpu(job, "bigrams", 120)
        items = [{"a": names[int(i) // N], "b": names[int(i) % N], "c": int(x)} for i, x in zip(o, c) if x > 0]
        return {"items": items, "ms": round((time.time() - t0) * 1000, 1)}

    def vocab(self, prefix="", top=200):
        p = prefix.lower().encode("utf-8")
        out = []
        for g in range(self.V):
            w = self.word_b(g)
            if (not p or w.lower().startswith(p)) and not (len(w) == 1 and w[0] in PUNCT) and w != b"\n\n":
                out.append({"w": w.decode("utf-8", "replace"), "c": int(self.vcount[g])})
                if len(out) >= top:
                    break
        return out


    # ---- vocabulary analysis -------------------------------------------
    def vocab_analysis(self, contains="", min_count=0, max_count=0, drop_stop=False, words_only=True, sort="freq", top=400,
                       show_off=False):
        gsum, rep = self._groups()
        allow = self.allow_mask()
        ex = set(self.get_filter()["exclude"])
        order = np.argsort(-gsum) if sort == "freq" else np.argsort(gsum) if sort == "rare" else None
        c = contains.lower()
        out, n_total = [], 0
        for gi in (order if order is not None else range(self.ngroups)):
            g = int(rep[gi])
            if g < 0 or gsum[gi] <= 0:
                continue
            cnt = int(gsum[gi])
            w = self.word(g)
            if words_only and not re.match(r"^[A-Za-z][A-Za-z'\-]*$", w):
                continue
            off = not allow[gi]
            if off and not (show_off and w.lower() in ex):      # user-excluded words can be listed (struck) to restore
                continue
            if drop_stop and w.lower() in STOP:
                continue
            if c and c not in w.lower():
                continue
            if min_count and cnt < min_count:
                continue
            if max_count and cnt > max_count:
                continue
            n_total += 1
            if len(out) < top:
                out.append({"w": w, "c": cnt, "off": bool(off)})
        return {"total_matching": n_total, "shown": len(out), "items": out, "vocab": self.ngroups,
                "allowed": int(allow.sum())}

    def transition_table(self, n=24, normalise=True):
        """The full next-word Markov table among the top-n content words — counts straight off the GPU."""
        p = self.pairs(n)
        m = np.array(p["matrix"], np.float64)
        row = m.sum(1, keepdims=True)
        prob = (m / np.maximum(row, 1)) if normalise else m
        return {"words": p["words"], "counts": m.astype(np.int64).tolist(), "prob": np.round(prob, 4).tolist(),
                "row_totals": row.ravel().astype(np.int64).tolist(), "ms": p["ms"]}

    # ---- embeddings & meaning (GPU) ------------------------------------
    def _embeddings(self, ve=1500, win=5, dim=64):
        """GloVe-style word vectors: windowed co-occurrence -> PPMI -> truncated SVD, all on the card. Cached."""
        if getattr(self, "_emb", None) is not None and self._emb[0] == (ve, win, dim):
            return self._emb
        gsum, rep = self._groups()
        allow = self.allow_mask()
        words, codes_per = [], []
        for gi in np.argsort(-gsum):
            g = int(rep[gi])
            if g < 0 or not allow[gi]:
                continue
            w = self.word(g).lower()
            if w in STOP or len(w) < 2:
                continue
            ids = [x for x in self.gids_any_case(w.encode("utf-8")) if x < COMMON]
            if not ids:
                continue
            words.append(w)
            codes_per.append(ids)
            if len(words) >= ve:
                break
        N = len(words)
        lut = np.full(65536, -1, np.int32)
        for k, ids in enumerate(codes_per):
            for g in ids:
                lut[g] = k

        def job():
            gl = cp.asarray(lut)
            co = cp.zeros(N * N, cp.uint32)
            for s_ in self.segs:
                g = s_["gpu"] if s_["gpu"] is not None else cp.asarray(self.codes[s_["a"]:s_["a"] + s_["n"]])
                K("coocwin")((96,), (256,), (g, cp.int64(s_["n"]), gl, cp.int32(N), cp.int32(win), co))
            co = co.reshape(N, N).astype(cp.float32)
            tot = float(co.sum()) + 1e-6
            rowsum = co.sum(1, keepdims=True) + 1e-6
            colsum = co.sum(0, keepdims=True) + 1e-6
            ppmi = cp.maximum(cp.log((co * tot) / (rowsum * colsum) + 1e-9), 0).astype(cp.float32)
            # Randomized subspace iteration for the top `dim` singular vectors: a handful of N x k GEMMs on the card
            # plus a tiny k x N SVD on the host. A full cuSOLVER gesvd of N x N takes ~40 s on Kepler; this takes ms.
            k = min(N, dim + 24)
            Q = cp.asarray(np.random.RandomState(11).standard_normal((N, k)).astype(np.float32))
            for _ in range(5):
                Q = cp.asarray(np.linalg.qr(cp.asnumpy(ppmi @ (ppmi.T @ Q)))[0].astype(np.float32))
            B = cp.asnumpy(Q.T @ ppmi)
            Ub, S, _ = np.linalg.svd(B, full_matrices=False)
            U = Q @ cp.asarray(Ub.astype(np.float32))
            S = cp.asarray(S.astype(np.float32))
            emb = U[:, :dim] * cp.sqrt(S[:dim])[None, :]
            emb = emb / (cp.linalg.norm(emb, axis=1, keepdims=True) + 1e-9)
            return cp.asnumpy(emb)
        if N < 8:
            raise ValueError("too few words pass the current filter to build embeddings — loosen it")
        # The vectors depend only on the text, the words that survive the filter, and the parameters, so that is the key.
        # Same text loaded again (even as a different corpus) -> no GPU work at all.
        kh = hashlib.sha256("{}|{}|{},{},{}|".format(EMB_FMT, self.content_hash(), ve, win, dim).encode())
        kh.update("\n".join(words).encode("utf-8"))
        ekey = kh.hexdigest()[:40]
        emb, hit = None, _cache_get(ekey + ".emb.npy")
        if hit:
            try:
                emb = np.load(hit)
                if emb.shape[0] != N:
                    emb = None
            except Exception:  # noqa: BLE001
                emb = None
        self._emb_cached = emb is not None
        if emb is None:
            emb = engine.run_on_gpu(job, "word embeddings", 180)
            _cache_put(ekey + ".emb.npy", _save_npy(np.ascontiguousarray(emb, np.float32)))
        self._emb_key = ekey
        idx = {w: i for i, w in enumerate(words)}
        row = np.full(self.V, -1, np.int32)
        for k, ids in enumerate(codes_per):
            for g in ids:
                row[g] = k
        for k, w in enumerate(words):                       # escaped (rare) spellings too
            for g in self.gids_any_case(w.encode("utf-8")):
                if row[g] < 0:
                    row[g] = k
        self._gid_row = row
        self._emb_counts = np.array([float(gsum[self.lgroup[ids[0]]]) for ids in codes_per])
        self._emb = ((ve, win, dim), words, idx, emb)
        return self._emb

    def similar_words(self, word, k=20):
        _, words, idx, emb = self._embeddings()
        w = word.strip().lower()
        if w not in idx:
            near = [x for x in words if x.startswith(w[:3])][:1]
            if not near:
                return {"word": word, "items": [], "known": False}
            w = near[0]
        v = emb[idx[w]]
        sims = emb @ v
        order = np.argsort(-sims)
        out = [{"w": words[i], "sim": round(float(sims[i]), 3)} for i in order if words[i] != w][:k]
        return {"word": w, "items": out, "known": True}

    # ---- relation space: vectors for analogies and word arithmetic -----
    def _relspace(self, ve=5000, win=3, dim=128, ctx="dir"):
        """Word vectors for relation queries. Unlike _embeddings (topics, 1,500 content words) these keep function
        words (do / don't / is / isn't), cover 5,000 words and use a short window, which carries grammatical relations
        (Levy & Goldberg 2015: small window, context-distribution smoothing 0.75, sqrt singular values). Honours the
        filter's crossed-out words and debris rule, never its hide-stopwords switch. Built on the card, cached."""
        key = (ve, win, dim, ctx, self.version, json.dumps(self.get_filter(), sort_keys=True))
        if getattr(self, "_rel", None) is not None and self._rel[0] == key:
            return self._rel[1]
        f = self.get_filter()
        ex = set(f.get("exclude") or [])
        gsum, rep = self._groups()
        words, codes_per = [], []
        for gi in np.argsort(-gsum):
            g = int(rep[gi])
            if g < 0:
                continue
            w = self.word(g).lower()
            if not w or not WORDLIKE.match(w) or w in ex or (f.get("junk") and is_junk(w)):
                continue
            ids = [x for x in self.gids_any_case(w.encode("utf-8")) if x < COMMON]
            if not ids:
                continue
            words.append(w)
            codes_per.append(ids)
            if len(words) >= ve:
                break
        N = len(words)
        if N < 50:
            raise ValueError("too few words for a relation space — load more text")
        lut = np.full(65536, -1, np.int32)
        for k, ids in enumerate(codes_per):
            for g in ids:
                lut[g] = k
        counts = np.array([float(gsum[self.lgroup[ids[0]]]) for ids in codes_per])

        def ppmi_(m):
            rowsum = m.sum(1, keepdims=True) + 1e-6
            cds = (m.sum(0, keepdims=True) + 1e-6) ** 0.75          # smoothed context distribution
            m *= float(cds.sum())                                    # P(w,c) / (P(w) P.75(c)); the total cancels
            m /= rowsum
            m /= cds
            m += 1e-9
            cp.log(m, out=m)
            cp.maximum(m, 0, out=m)                                   # PPMI, in place

        def job():
            gl = cp.asarray(lut)
            co = cp.zeros(N * N, cp.uint32)
            for s_ in self.segs:
                g = s_["gpu"] if s_["gpu"] is not None else cp.asarray(self.codes[s_["a"]:s_["a"] + s_["n"]])
                K("coocdir" if ctx == "dir" else "coocwin")((96,), (256,), (g, cp.int64(s_["n"]), gl, cp.int32(N), cp.int32(win), co))
            r = co.reshape(N, N).astype(cp.float32)
            del co
            if ctx == "dir":
                m = cp.empty((N, 2 * N), cp.float32)
                m[:, :N] = r                                         # right contexts
                m[:, N:] = r.T                                       # left contexts
                del r
                ppmi_(m[:, :N])
                ppmi_(m[:, N:])
            else:
                m = r
                ppmi_(m)
            k = min(N, dim + 32)
            Q = cp.asarray(np.random.RandomState(17).standard_normal((N, k)).astype(np.float32))
            for _ in range(4):
                Q = cp.asarray(np.linalg.qr(cp.asnumpy(m @ (m.T @ Q)))[0].astype(np.float32))
            B = cp.asnumpy(Q.T @ m)
            Ub, S, _ = np.linalg.svd(B, full_matrices=False)
            U = Q @ cp.asarray(Ub.astype(np.float32))
            e = U[:, :dim] * cp.sqrt(cp.asarray(S[:dim].astype(np.float32)))[None, :]
            e = e / (cp.linalg.norm(e, axis=1, keepdims=True) + 1e-9)
            return cp.asnumpy(e)
        kh = hashlib.sha256("rel|{}|{}|{},{},{},{}|".format(EMB_FMT, self.content_hash(), ve, win, dim, ctx).encode())
        kh.update("\n".join(words).encode("utf-8"))
        ekey = kh.hexdigest()[:40]
        emb, hit = None, _cache_get(ekey + ".rel.npy")
        if hit:
            try:
                emb = np.load(hit)
                if emb.shape[0] != N:
                    emb = None
            except Exception:  # noqa: BLE001
                emb = None
        cached = emb is not None
        if emb is None:
            emb = engine.run_on_gpu(job, "relation vectors", 180)
            _cache_put(ekey + ".rel.npy", _save_npy(np.ascontiguousarray(emb, np.float32)))
        sp = {"words": words, "idx": {w: i for i, w in enumerate(words)}, "E": emb.astype(np.float32), "counts": counts,
              "win": win, "dim": dim, "ctx": ctx, "cached": cached}
        self._rel = (key, sp)
        return sp

    def _rel_get(self, sp, w):
        w = str(w).strip().lower()
        if w not in sp["idx"]:
            raise ValueError("“{}” is not among the {:,} commonest words".format(w, len(sp["words"])))
        return sp["idx"][w]

    @staticmethod
    def _top(sp, scores, k, skip=()):
        o = np.argsort(-scores)
        out = []
        for i in o:
            if i in skip:
                continue
            out.append({"w": sp["words"][i], "score": round(float(scores[i]), 4), "count": int(sp["counts"][i])})
            if len(out) >= k:
                break
        return out

    def rel_analogy(self, a, b, c, k=15, method="3cosmul"):
        """a is to b as c is to ?  3CosMul (Levy & Goldberg 2014) or 3CosAdd (Mikolov 2013). The baseline is the
        plain nearest neighbour of c: if the answer is the same, the relation added nothing."""
        t0 = time.time()
        sp = self._relspace()
        E = sp["E"]
        ia, ib, ic = (self._rel_get(sp, x) for x in (a, b, c))
        if method == "3cosadd":
            v = E[ib] - E[ia] + E[ic]
            s = E @ (v / (np.linalg.norm(v) + 1e-9))
        else:
            sa, sb, sc = ((E @ E[i] + 1) / 2 for i in (ia, ib, ic))
            s = sb * sc / (sa + 1e-3)
        res = self._top(sp, s, k, {ia, ib, ic})
        base = self._top(sp, E @ E[ic], 1, {ia, ib, ic})[0]["w"]
        d = E[ib] - E[ia]
        for r in res:                                  # how well each answer's own offset matches b - a
            j = sp["idx"][r["w"]]
            dd = E[j] - E[ic]
            r["offset_cos"] = round(float(dd @ d / (np.linalg.norm(dd) * np.linalg.norm(d) + 1e-9)), 3)
        return {"a": a, "b": b, "c": c, "method": method, "items": res, "baseline_nearest_c": base,
                "vocab": len(sp["words"]), "ms": round((time.time() - t0) * 1000, 1)}

    def rel_pairs(self, a, b, k=30, neighbours=25, closeness=0.5):
        """Other pairs (x, y) whose difference vector points the same way as b - a (do : don't -> is : isn't …).
        Every word x is moved by b - a; y is searched among the words nearest that point; the pair is scored by the
        cosine of y - x with b - a. A control re-scores random neighbouring pairs, so a score can be read against
        chance (the 99th percentile of random neighbour pairs)."""
        t0 = time.time()
        sp = self._relspace()
        E = sp["E"]
        ia, ib = self._rel_get(sp, a), self._rel_get(sp, b)
        d = E[ib] - E[ia]
        dn = d / (np.linalg.norm(d) + 1e-9)
        N, nb = E.shape[0], max(5, min(int(neighbours), 100))

        def job():
            G = cp.asarray(E)
            dg = cp.asarray(dn)
            best_y = np.zeros((N, 3), np.int64)
            best_s = np.full((N, 3), -2.0, np.float32)
            rs = np.random.RandomState(3)
            ctrl = []
            for s0 in range(0, N, 1024):
                X = G[s0:s0 + 1024]
                T = X + cp.asarray(d)[None, :]
                T /= cp.linalg.norm(T, axis=1, keepdims=True) + 1e-9
                S = T @ G.T                                            # chunk x N
                rows = cp.arange(X.shape[0])
                S[rows, rows + s0] = -9                                # never pair a word with itself
                cand = cp.argsort(-S, axis=1)[:, :nb]                  # nearest words to x + (b - a)
                Y = G[cand]                                            # chunk x nb x D
                diff = Y - X[:, None, :]
                cosd = (diff.reshape(-1, diff.shape[2]) @ dg).reshape(diff.shape[:2]) / (cp.linalg.norm(diff, axis=2) + 1e-9)
                cosd += closeness * cp.sum(Y * X[:, None, :], axis=2)    # real pairs are also near each other
                j3 = cp.argsort(-cosd, axis=1)[:, :3]
                best_y[s0:s0 + X.shape[0]] = cp.asnumpy(cp.take_along_axis(cand, j3, axis=1))
                best_s[s0:s0 + X.shape[0]] = cp.asnumpy(cp.take_along_axis(cosd, j3, axis=1))
                # control: a random neighbour of x (among its own nearest words), scored the same way
                Sx = X @ G.T
                Sx[rows, rows + s0] = -9
                nn = cp.argsort(-Sx, axis=1)[:, :nb]
                pick = cp.asarray(rs.randint(0, nb, X.shape[0]))
                yc = G[nn[rows, pick]]
                dc = yc - X
                ctrl.append(cp.asnumpy((dc @ dg) / (cp.linalg.norm(dc, axis=1) + 1e-9) + closeness * cp.sum(yc * X, axis=1)))
            return best_y, best_s, np.concatenate(ctrl)
        by, bs, ctrl = engine.run_on_gpu(job, "relation pairs", 60)
        thr = float(np.percentile(ctrl, 99))
        # One-to-one, best first: each word appears in at most one pair, so a hub word can't claim every pair.
        flat = np.argsort(-bs.ravel())
        out, used, n_above = [], {ia, ib}, 0
        for f in flat:
            x, slot = divmod(int(f), 3)
            y, sc = int(by[x, slot]), float(bs[x, slot])
            if x in used or y in used or x == y:
                continue
            used.add(x)
            used.add(y)
            n_above += sc > thr
            if len(out) < k:
                out.append({"x": sp["words"][x], "y": sp["words"][y], "score": round(sc, 3), "above_chance": bool(sc > thr),
                            "count_x": int(sp["counts"][x]), "count_y": int(sp["counts"][y])})
            elif sc <= thr:
                break
        return {"a": a, "b": b, "items": out, "control_p99": round(thr, 3), "control_median": round(float(np.median(ctrl)), 3),
                "above_chance": int(n_above), "vocab": N, "closeness": closeness, "ms": round((time.time() - t0) * 1000, 1)}

    def rel_arith(self, expr, k=15):
        """Word arithmetic: "king - man + woman", "paris - france + italy". Terms are words joined by + or -."""
        t0 = time.time()
        sp = self._relspace()
        E = sp["E"]
        terms = re.findall(r"(^|[+-])\s*([^+\-\s][^+\-]*?)\s*(?=[+-]|$)", expr.strip())
        if not terms:
            raise ValueError("write words joined by + and -, e.g. king - man + woman")
        v, used = np.zeros(E.shape[1], np.float32), set()
        parts = []
        for sign, w in terms:
            i = self._rel_get(sp, w)
            v += (-1.0 if sign == "-" else 1.0) * E[i]
            used.add(i)
            parts.append(("-" if sign == "-" else "+") + sp["words"][i])
        s = E @ (v / (np.linalg.norm(v) + 1e-9))
        return {"expr": " ".join(parts).lstrip("+"), "items": self._top(sp, s, k, used), "vocab": len(sp["words"]),
                "ms": round((time.time() - t0) * 1000, 1)}

    def rel_axis(self, a, b, k=20):
        """Every word placed on the line from a to b (projection on b - a): the words most like each end."""
        t0 = time.time()
        sp = self._relspace()
        E = sp["E"]
        ia, ib = self._rel_get(sp, a), self._rel_get(sp, b)
        d = E[ib] - E[ia]
        d = d / (np.linalg.norm(d) + 1e-9)
        s = E @ d
        return {"a": a, "b": b, "toward_b": self._top(sp, s, k, {ia, ib}), "toward_a": self._top(sp, -s, k, {ia, ib}),
                "vocab": len(sp["words"]), "ms": round((time.time() - t0) * 1000, 1)}

    def rel_between(self, a, b, k=15):
        """Words close to both a and b (ranked by the smaller of the two similarities)."""
        t0 = time.time()
        sp = self._relspace()
        E = sp["E"]
        ia, ib = self._rel_get(sp, a), self._rel_get(sp, b)
        s = np.minimum(E @ E[ia], E @ E[ib])
        return {"a": a, "b": b, "items": self._top(sp, s, k, {ia, ib}), "similarity_ab": round(float(E[ia] @ E[ib]), 3),
                "vocab": len(sp["words"]), "ms": round((time.time() - t0) * 1000, 1)}

    def rel_odd(self, words):
        """Odd one out: the word least similar, on average, to the others."""
        t0 = time.time()
        sp = self._relspace()
        E = sp["E"]
        ws = [w for w in re.split(r"[\s,]+", words.strip().lower()) if w]
        if len(ws) < 3:
            raise ValueError("give at least three words")
        ix = [self._rel_get(sp, w) for w in ws]
        M = E[ix] @ E[ix].T
        mean = (M.sum(1) - 1) / (len(ix) - 1)
        o = np.argsort(mean)
        return {"odd": sp["words"][ix[o[0]]], "items": [{"w": sp["words"][ix[i]], "mean_sim": round(float(mean[i]), 3)} for i in o],
                "ms": round((time.time() - t0) * 1000, 1)}

    def rel_test(self, max_per=40):
        """How far to trust the space: analogy accuracy on relations found in this corpus's own vocabulary
        (contractions, plurals, -ing, -ed, -ly), top-1 by 3CosMul, against the nearest-neighbour-of-c baseline."""
        t0 = time.time()
        sp = self._relspace()
        E, idx = sp["E"], sp["idx"]
        words = sp["words"]
        rels = {"negation (do : don't)": [], "plural (-s)": [], "-ing": [], "past (-ed)": [], "adverb (-ly)": []}
        for w in words[:3000]:
            if len(w) < 3:
                continue
            if w.endswith("n't") and w[:-3] in idx:
                rels["negation (do : don't)"].append((w[:-3], w))
            if w + "s" in idx and not w.endswith("s"):
                rels["plural (-s)"].append((w, w + "s"))
            if w + "ing" in idx:
                rels["-ing"].append((w, w + "ing"))
            if w + "ed" in idx:
                rels["past (-ed)"].append((w, w + "ed"))
            if w + "ly" in idx:
                rels["adverb (-ly)"].append((w, w + "ly"))
        G = (E @ E.T + 1) / 2                                          # cosine mapped to [0, 1] for 3CosMul
        out = []
        for name, pairs in rels.items():
            pairs = pairs[:max_per]
            if len(pairs) < 4:
                continue
            hit = base = n = 0
            for i, (a, b) in enumerate(pairs):
                for c, dgold in pairs[:i] + pairs[i + 1:]:
                    ia, ib, ic, ig = idx[a], idx[b], idx[c], idx[dgold]
                    s = G[ib] * G[ic] / (G[ia] + 1e-3)
                    s[[ia, ib, ic]] = -1
                    hit += int(np.argmax(s) == ig)
                    nn = E @ E[ic]
                    nn[[ia, ib, ic]] = -9
                    base += int(np.argmax(nn) == ig)
                    n += 1
                    if n >= 600:
                        break
                if n >= 600:
                    break
            out.append({"relation": name, "pairs": len(pairs), "questions": n, "accuracy": round(hit / n, 3),
                        "baseline": round(base / n, 3), "examples": ["{} : {}".format(a, b) for a, b in pairs[:4]]})
        return {"relations": out, "vocab": len(words), "chance": round(1 / len(words), 5), "ms": round((time.time() - t0) * 1000, 1)}

    def meaning(self, clusters=10, keywords=40, collocations=30):
        """Keyness, collocations (PMI), and semantic clusters — the GPU's take on 'what is this about'."""
        _, words, idx, emb = self._embeddings()
        gsum, rep = self._groups()
        total = float(gsum.sum())
        # keyness: a word's share here vs. a flat baseline, weighted by how content-like it is
        kw = []
        for gi in np.argsort(-gsum)[:3000]:
            g = int(rep[gi])
            if g < 0:
                continue
            w = self.word(g)
            wl = w.lower()
            if not self.allow_mask()[gi] or wl in STOP or len(wl) < 3:
                continue
            c = gsum[gi]
            kw.append((w, float(c * math.log(c + 1))))
            if len(kw) >= keywords:
                break
        kw.sort(key=lambda x: -x[1])

        def coll_job():
            N = len(words)
            lut = np.full(65536, -1, np.int32)
            for k, w in enumerate(words):
                for g in self.gids_any_case(w.encode("utf-8")):
                    if g < COMMON:
                        lut[g] = k
            gl = cp.asarray(lut)
            h = cp.zeros(N * N, cp.uint32)
            for s_ in self.segs:
                g = s_["gpu"] if s_["gpu"] is not None else cp.asarray(self.codes[s_["a"]:s_["a"] + s_["n"]])
                K("pairhist")((96,), (256,), (g, cp.int64(s_["n"]), gl, cp.int32(N), h))
            h = h.reshape(N, N).astype(cp.float32)
            tot = float(h.sum()) + 1e-6
            r = h.sum(1, keepdims=True) + 1e-6
            cc = h.sum(0, keepdims=True) + 1e-6
            pmi = cp.log((h * tot) / (r * cc) + 1e-9) * (h >= 5)
            flat = cp.argsort(-pmi.ravel())[:collocations * 2]
            return cp.asnumpy(flat), cp.asnumpy(h.ravel()[flat]), cp.asnumpy(pmi.ravel()[flat])
        flat, hv, pmiv = engine.run_on_gpu(coll_job, "collocations", 120)
        N = len(words)
        colls, seen = [], set()
        for f, c, pm in zip(flat, hv, pmiv):
            a, b = int(f) // N, int(f) % N
            if a == b or (b, a) in seen or c < 5:
                continue
            seen.add((a, b))
            colls.append({"a": words[a], "b": words[b], "c": int(c), "pmi": round(float(pm), 2)})
            if len(colls) >= collocations:
                break

        def clus_job():
            e = cp.asarray(emb)
            k = min(clusters, e.shape[0])
            cen = e[cp.random.permutation(e.shape[0])[:k]]
            lab = None
            for _ in range(25):
                d = e @ cen.T
                lab = d.argmax(1)
                for j in range(k):
                    m = lab == j
                    if int(m.sum()):
                        v = e[m].mean(0)
                        cen[j] = v / (cp.linalg.norm(v) + 1e-9)
            return cp.asnumpy(lab), cp.asnumpy(cen)
        lab, cen = engine.run_on_gpu(clus_job, "semantic clusters", 120)
        cl = []
        for j in range(cen.shape[0]):
            members = np.where(lab == j)[0]
            if not len(members):
                continue
            sims = emb[members] @ cen[j]
            order = members[np.argsort(-sims)]
            cl.append({"words": [words[i] for i in order[:8]], "size": int(len(members))})
        cl.sort(key=lambda c: -c["size"])
        return {"keywords": [{"w": w, "score": round(s, 1)} for w, s in kw], "collocations": colls,
                "clusters": cl, "vocab_used": len(words)}

    def generate2(self, seed="", order=3, length=90, temp=1.0, stop_at="none", avoid_stop=False, theme="", rs=None,
                  mode="markov", topics=16):
        """Markov generation over the corpus, honouring the vocabulary filter.

        mode "markov": an n-gram walk (order = words of memory); every emitted word is traceable to a real position.
        mode "topics": Markov over the embedding space — words are clustered into semantic topics, the topic-to-topic
        transition matrix is counted on the card from the token stream, and each word choice is weighted toward the
        topic the topic-chain wants next. theme (any words) further biases choices toward its embedding direction."""
        rng = np.random.RandomState(rs if rs is not None else int(time.time() * 1000) % (2**31))
        t0 = time.time()
        gm, pm = self.gen_mask(), self.punct_mask()
        emb = rows = theme_vec = sem = None
        if theme.strip() or mode == "topics":
            _, words_e, idx, emb = self._embeddings()
            rows = self._gid_row
            if theme.strip():
                tv = [emb[idx[w]] for w in re.findall(r"[^\W\d_][\w'\-]*", theme.lower()) if w in idx]
                if tv:
                    theme_vec = np.mean(tv, 0)
                    theme_vec = theme_vec / (np.linalg.norm(theme_vec) + 1e-9)
        if mode == "topics":
            sem = self._semantic(topics)
        toks = []
        for t in TOKEN_RE.findall(normalise(seed.encode("utf-8"))):
            g = self.gid_exact(b"\n\n" if t.startswith(b"\n") else t)
            if g is not None:
                toks.append(g)
        nseed = len(toks)
        out, cache, scans = [], {}, 0
        state = target = None

        def topic_of(g):
            if sem is None or g < 0 or g >= rows.size or rows[g] < 0:
                return -1
            return int(sem["lab"][rows[g]])

        def next_target(st):
            return int(rng.choice(sem["P"].shape[0], p=sem["P"][st]))
        if not toks:
            dot = self.gid_exact(b".")
            if dot is not None:
                p_, _, _ = self.phrase([{"tok": ".", "ids": [dot]}], 5000)
                for _ in range(40):
                    if not p_.size:
                        break
                    s0 = int(p_[rng.randint(p_.size)]) + 1
                    g0 = int(self.gids_at([s0])[0])
                    if g0 >= 0 and gm[g0] and not pm[g0]:
                        toks = [g0]
                        out.append((g0, s0, 0, topic_of(g0)))
                        break
        if sem is not None:
            for g in reversed(toks):
                if topic_of(g) >= 0:
                    state = topic_of(g)
                    break
            if state is None and theme_vec is not None:
                state = int(np.argmax(sem["cen"] @ theme_vec))
            if state is None:
                state = int(np.argmax(sem["size"]))
            target = next_target(state)
        want = int(length)
        while len(out) < want:
            nxt, src, used = None, 0, 0
            for k in range(min(order, len(toks)), 0, -1):
                ctx = tuple(toks[-k:])
                if ctx not in cache:
                    pos, _, _ = self.phrase([{"tok": "", "ids": [g]} for g in ctx], 200000)
                    scans += 1
                    pos = pos[pos + k < self.T]
                    cache[ctx] = (pos, self.gids_at(pos + k) if pos.size else np.zeros(0, np.int64))
                P, allv = cache[ctx]
                if not P.size:
                    continue
                ok = (allv >= 0)
                ok[ok] = gm[allv[ok]]
                vals = allv[ok]
                if not vals.size:
                    continue
                uniq, cnt = np.unique(vals, return_counts=True)
                w = cnt.astype(np.float64) ** (1.0 / max(0.05, temp))
                if rows is not None:
                    r = rows[np.minimum(uniq, rows.size - 1)]
                    has = r >= 0
                    if theme_vec is not None and k <= 2 and has.any():
                        w[has] *= 1.0 + 3.0 * np.maximum(0.0, emb[r[has]] @ theme_vec)
                    if sem is not None and has.any():
                        cl = sem["lab"][r[has]]
                        w[has] *= (0.15 + sem["P"][state, cl]) * np.where(cl == target, 4.0, 1.0)
                j = rng.choice(uniq.size, p=w / w.sum())
                nxt = int(uniq[j])
                hit = np.flatnonzero(allv == nxt)
                src = int(P[hit[rng.randint(hit.size)]]) + k
                used = k
                break
            if nxt is None:
                for _ in range(60):
                    src = rng.randint(max(1, self.T))
                    nxt = int(self.gids_at([src])[0])
                    if nxt >= 0 and gm[nxt] and not pm[nxt]:
                        break
            toks.append(nxt)
            tp = topic_of(nxt)
            out.append((nxt, src, used, tp))
            if sem is not None and tp >= 0:
                state = tp
                target = next_target(state)
            wd = self.word(nxt)
            if stop_at == "sentence" and wd in (".", "!", "?") and len(out) >= want * 0.6:
                break
            if stop_at == "paragraph" and wd == "\n\n" and len(out) >= 10:
                break
        words_out = []
        for g, src, k, tp in out:
            w = self.word(g)
            if avoid_stop and w.lower() in STOP and w not in (".", ",", "!", "?", ";", ":"):
                continue
            words_out.append({"w": w, "src": int(src), "order": k, "t": tp})
        seed_words = [self.word(g) for g in toks[:nseed]]
        dt = time.time() - t0
        res = {"seed": detok(seed_words), "text": detok(seed_words + [w["w"] for w in words_out]), "words": words_out,
               "ms": round(dt * 1000, 1), "tok_s": round(len(out) / max(dt, 1e-6), 1), "scans": scans, "order": order, "mode": mode,
               "length": len(words_out), "theme": theme}
        if sem is not None:
            res["topics"] = [{"id": i, "words": sem["names"][i], "size": int(sem["size"][i])} for i in range(len(sem["names"]))]
        return res

    # ---- topics (semantic clusters) and the embedding map ---------------------------------------------------
    def _semantic(self, topics=16):
        topics = int(topics)
        if topics in self._sem:
            return self._sem[topics]
        _, words, idx, emb = self._embeddings()
        n = len(words)
        nk = int(min(topics, builtins_max(2, n // 8)))

        def km():
            e = cp.asarray(emb)
            cen = e[cp.asarray(np.linspace(0, n - 1, nk).astype(np.int64))].copy()
            lab = None
            for _ in range(30):
                lab = (e @ cen.T).argmax(1)
                for j in range(nk):
                    m = lab == j
                    if int(m.sum()):
                        v = e[m].mean(0)
                        cen[j] = v / (cp.linalg.norm(v) + 1e-9)
            return cp.asnumpy(lab), cp.asnumpy(cen)
        lab, cen = engine.run_on_gpu(km, "topic clusters", 120)
        lut = np.full(65536, -1, np.int32)
        row = self._gid_row
        lim = min(self.V, COMMON)
        has = np.flatnonzero(row[:lim] >= 0)
        lut[has] = lab[row[has]]

        def trans():
            gl = cp.asarray(lut)
            h = cp.zeros(nk * nk, cp.uint32)
            for s_ in self.segs:
                g = s_["gpu"] if s_["gpu"] is not None else cp.asarray(self.codes[s_["a"]:s_["a"] + s_["n"]])
                K("seqhist")((96,), (256,), (g, cp.int64(s_["n"]), gl, cp.int32(nk), cp.int32(6), h))
            return cp.asnumpy(h).reshape(nk, nk).astype(np.float64)
        H = engine.run_on_gpu(trans, "topic transitions", 120)
        P = (H + 0.5) / (H + 0.5).sum(1, keepdims=True)
        size = np.bincount(lab, minlength=nk)
        counts = self._emb_counts
        names = []
        for j in range(nk):
            mem = np.flatnonzero(lab == j)
            mem = mem[np.argsort(-counts[mem])][:5]
            names.append([words[i] for i in mem])
        self._sem[topics] = {"lab": lab, "cen": cen, "P": P, "H": H, "size": size, "names": names}
        return self._sem[topics]

    def topics_info(self, topics=16):
        sem = self._semantic(topics)
        return {"topics": [{"id": i, "words": sem["names"][i], "size": int(sem["size"][i])} for i in range(len(sem["names"]))],
                "transitions": np.round(sem["P"], 4).tolist(), "counts": sem["H"].astype(np.int64).tolist()}

    def embed_map(self, n=500, topics=12, perplexity=20.0, iters=420):
        """The embedding space, laid out in 2-D by t-SNE on the card (exact gradients, n x n), coloured by topic."""
        key = (int(n), int(topics))
        if key in self._maps:
            return self._maps[key]
        t0 = time.time()
        _, words, idx, emb = self._embeddings()
        mname = "{}.map.{}.{}.{}.{}.json".format(self._emb_key, int(min(n, len(words))), int(topics), perplexity, iters)
        hit = _cache_get(mname)
        if hit:
            try:
                with open(hit) as f:
                    res = json.load(f)
                res.update(ms=round((time.time() - t0) * 1000, 1), cached=True, emb_cached=bool(self._emb_cached))
                self._maps[key] = res
                return res
            except Exception:  # noqa: BLE001
                pass
        n = int(min(n, len(words)))
        sem = self._semantic(topics)
        X = np.ascontiguousarray(emb[:n], np.float32)

        def job():
            x = cp.asarray(X)
            offd = 1.0 - cp.eye(n, dtype=cp.float32)
            D = cp.maximum(2.0 - 2.0 * (x @ x.T), 0.0)
            logU = math.log(perplexity)
            beta = cp.ones((n, 1), cp.float32)
            lo = cp.zeros((n, 1), cp.float32)
            hi = cp.full((n, 1), cp.inf, cp.float32)
            for _ in range(48):                                       # per-point bandwidth for the target perplexity
                Pc = cp.exp(-D * beta) * offd
                sP = Pc.sum(1, keepdims=True) + 1e-12
                Hh = cp.log(sP) + beta * (D * Pc).sum(1, keepdims=True) / sP
                up = Hh > logU
                lo = cp.where(up, beta, lo)
                hi = cp.where(up, hi, beta)
                beta = cp.where(cp.isinf(hi), beta * 2.0, (lo + hi) / 2.0)
            Pc = cp.exp(-D * beta) * offd
            Pc = Pc / (Pc.sum(1, keepdims=True) + 1e-12)
            Pm = cp.maximum((Pc + Pc.T) / (2.0 * n), 1e-12)
            xc = x - x.mean(0)
            _, _, Vt = cp.linalg.svd(xc, full_matrices=False)
            Y = xc @ Vt[:2].T
            Y = (Y / (Y.std() + 1e-9) * 1e-2).astype(cp.float32)
            upd = cp.zeros_like(Y)
            gains = cp.ones_like(Y)
            for it in range(iters):
                ex = 12.0 if it < 100 else 1.0
                sq = (Y * Y).sum(1)
                num = offd / (1.0 + sq[:, None] + sq[None, :] - 2.0 * (Y @ Y.T))
                Q = cp.maximum(num / num.sum(), 1e-12)
                PQ = (ex * Pm - Q) * num
                grad = 4.0 * (PQ.sum(1)[:, None] * Y - PQ @ Y)
                mom = 0.5 if it < 120 else 0.8
                gains = cp.where(cp.sign(grad) != cp.sign(upd), gains + 0.2, gains * 0.8)
                gains = cp.maximum(gains, 0.01)
                upd = mom * upd - 200.0 * gains * grad
                Y = Y + upd
                Y = Y - Y.mean(0)
            return cp.asnumpy(Y)
        Y = engine.run_on_gpu(job, "embedding map (t-SNE)", 180)
        Y = Y - Y.min(0)
        Y = Y / (Y.max(0) + 1e-9) * 2.0 - 1.0
        counts = self._emb_counts
        res = {"items": [{"w": words[i], "c": int(counts[i]), "x": round(float(Y[i, 0]), 4), "y": round(float(Y[i, 1]), 4),
                          "t": int(sem["lab"][i])} for i in range(n)],
               "topics": [{"id": j, "words": sem["names"][j], "size": int(sem["size"][j])} for j in range(len(sem["names"]))],
               "vocab": len(words), "ms": round((time.time() - t0) * 1000, 1), "cached": False,
               "emb_cached": bool(getattr(self, "_emb_cached", False))}
        _cache_put(mname, _save_json(res))
        self._maps[key] = res
        return res


_ENDP = {".", ",", "!", "?", ";", "-"}


def quote_dirs(words):
    """Opening or closing, for every straight double quote. Generated text drops quotes, so plain parity drifts out of
    step; read each quote from its neighbours first (`, " said` closes, `\\n\\n " The` opens) and fall back on parity
    only when the neighbours can't tell. Returns {index: True for opening, False for closing}."""
    out, open_ = {}, False
    for i, w in enumerate(words):
        if w != '"':
            continue
        p = next((x for x in reversed(words[:i]) if x != '"'), None) if i else None
        n = words[i + 1] if i + 1 < len(words) else None
        if p is None or p == "\n\n" or p in (":", "("):
            d = True
        elif n is None or n == "\n\n" or n in (".", ",", "!", "?", ";", ")"):
            d = False
        elif p in _ENDP and n[:1].islower():
            d = False                              # `," said he`
        elif p not in _ENDP and n[:1].isupper() and not open_:
            d = True                               # `said "Come`
        else:
            d = not open_
        out[i] = d
        open_ = d
    return out


def detok(words):
    out = []
    no_space = True
    qd = quote_dirs(words)
    for i, w in enumerate(words):
        if w == "\n\n":
            out.append("\n\n")
            no_space = True
            continue
        if w == '"':
            if qd.get(i, True):                    # opening: space before, none after
                out.append(("" if no_space else " ") + '"')
                no_space = True
            else:                                  # closing: hugs the previous word
                out.append('"')
                no_space = False
            continue
        if w == "-":                               # hyphens and dashes join their neighbours: sea-like, still--and
            out.append("-")
            no_space = True
            continue
        if w in (".", ",", "!", "?", ";", ":", ")"):
            out.append(w)
            no_space = False
            continue
        out.append(("" if no_space else " ") + w)
        no_space = w in ("(", "-")
    return "".join(out).strip()


# ---------------------------------------------------------------- the library of corpora
ACTIVE = {"c": None, "blank": None}       # blank: id of a selected corpus that has no text yet


def list_corpora():
    out = []
    for cid in sorted(os.listdir(ROOT)):
        mp = os.path.join(ROOT, cid, "meta.json")
        if not os.path.exists(mp):
            continue
        with open(mp) as f:
            m = json.load(f)
        a = ACTIVE["c"]
        out.append({"id": cid, "name": m.get("name"), "bytes": m.get("bytes"), "docs": len(m.get("docs") or []),
                    "version": m.get("version"), "created": m.get("created"),
                    "active": bool(a and a.id == cid) or ACTIVE.get("blank") == cid,
                    "index": m.get("index"), "recipe": m.get("recipe") or []})
    return sorted(out, key=lambda x: -(x["created"] or 0))


def create(name, parts, job=None):
    """parts: [(doc name, opener)] -> a new corpus on disk (normalised as it is copied), returns its id."""
    cid = uuid.uuid4().hex[:10]
    d = os.path.join(ROOT, cid)
    os.makedirs(d)
    docs, pos = [], 0
    with open(os.path.join(d, "v0.txt"), "wb") as f:
        for i, (dn, opener) in enumerate(parts):
            if pos:
                f.write(b"\n\n\n")
                pos += 3
            src = opener()
            try:
                n = _copy_norm(src, f)
            finally:
                try:
                    src.close()
                except Exception:  # noqa: BLE001
                    pass
            docs.append({"name": dn, "start": pos, "bytes": n})
            pos += n
            if job:
                job.step(0.05 * (i + 1) / max(1, len(parts)), "copying {} ({:.0f} MB so far)".format(dn, pos / 2**20))
    meta = {"id": cid, "name": name, "created": time.time(), "version": 0, "bytes": pos, "docs": docs, "recipe": [],
            "versions": [{"v": 0, "bytes": pos, "op": "original", "at": time.time(), "docs": docs}]}
    with open(os.path.join(d, "meta.json"), "w") as f:
        json.dump(meta, f)
    return cid


def activate(cid, job=None):
    a = ACTIVE["c"]
    if a and a.id == cid and a.ready:
        return a
    if a:
        a.release()
        ACTIVE["c"] = None
    c = Corpus(cid)
    if os.path.getsize(c.vpath()) == 0:            # a blank corpus: nothing to put on the card until text is added
        ACTIVE["blank"] = cid
        return None
    ACTIVE["blank"] = None
    c.load(job)
    ACTIVE["c"] = c
    return c


def create_blank(name):
    """A named, empty corpus, selected at once (the old one leaves the card). Text added later goes into it."""
    cid = create(name or "Untitled corpus", [])
    activate(cid)
    return cid


def add_parts(cid, parts, job=None):
    """Append documents to a corpus. Into a blank corpus they become its original text; otherwise they become a new
    version (undoable like a transform), with the earlier documents and their boundaries kept."""
    c = Corpus(cid)
    old = c.vpath()
    old_bytes = os.path.getsize(old)
    blank = old_bytes == 0 and c.version == 0
    v = c.version if blank else c.version + 1
    dst = c.vpath(v)
    docs = [] if blank else list(c.meta.get("docs") or [])
    pos = 0 if blank else old_bytes
    tmp = dst + ".tmp"
    with open(tmp, "wb") as f:
        if not blank:
            with open(old, "rb") as src:
                shutil.copyfileobj(src, f, 8 << 20)
        for i, (dn, opener) in enumerate(parts):
            if pos:
                f.write(b"\n\n\n")
                pos += 3
            src = opener()
            try:
                n = _copy_norm(src, f)
            finally:
                try:
                    src.close()
                except Exception:  # noqa: BLE001
                    pass
            docs.append({"name": dn, "start": pos, "bytes": n})
            pos += n
            if job:
                job.step(0.05 * (i + 1) / max(1, len(parts)), "add {} ({:.0f} MB until now)".format(dn, pos / 2**20))
    os.replace(tmp, dst)
    added = len(parts)
    c.meta["bytes"] = pos
    c.meta["docs"] = docs
    if blank:
        c.meta["versions"] = [{"v": 0, "bytes": pos, "op": "original", "at": time.time(), "docs": docs}]
    else:
        c.meta["version"] = v
        name = "Add {} document{}".format(added, "" if added == 1 else "s")
        c.meta.setdefault("recipe", []).append({"op": "add", "name": name, "params": {"docs": [d for d, _ in parts]},
                                                "engine": "CPU", "changed": added, "secs": 0, "at": time.time()})
        c.meta.setdefault("versions", []).append({"v": v, "bytes": pos, "op": name, "at": time.time(), "docs": docs})
    c.meta.pop("content", None)
    c.save_meta()
    a = ACTIVE["c"]
    if a and a.id == cid:
        a.release()
        ACTIVE["c"] = None
    activate(cid, job)
    return {"id": cid, "version": v, "added": added, "bytes": pos}


def delete(cid):
    a = ACTIVE["c"]
    if a and a.id == cid:
        a.release()
        ACTIVE["c"] = None
    if ACTIVE.get("blank") == cid:
        ACTIVE["blank"] = None
    shutil.rmtree(os.path.join(ROOT, cid), ignore_errors=True)


# ---------------------------------------------------------------- transforms (each makes a new version)
TRANSFORMS = {
    "lower": {"name": "lowercase", "engine": "GPU", "params": []},
    "upper": {"name": "UPPERCASE", "engine": "GPU", "params": []},
    "title": {"name": "Title Case", "engine": "GPU", "params": []},
    "sentence": {"name": "Sentence case", "engine": "GPU", "params": []},
    "replace": {"name": "Find & replace", "engine": "CPU", "params": ["find", "replace", "case", "whole"]},
    "regex": {"name": "Regex replace", "engine": "CPU", "params": ["pattern", "replace"]},
    "nopunct": {"name": "Remove punctuation", "engine": "CPU", "params": []},
    "nodigits": {"name": "Remove numbers", "engine": "CPU", "params": []},
    "spaces": {"name": "Tidy whitespace", "engine": "CPU", "params": []},
    "html": {"name": "Strip HTML", "engine": "CPU", "params": []},
    "clean": {"name": "Clean web markup", "engine": "CPU", "params": []},
    "dedupe": {"name": "Remove duplicate lines", "engine": "GPU", "params": []},
    "sortlines": {"name": "Sort lines", "engine": "CPU", "params": ["reverse"]},
    "keep": {"name": "Keep lines matching", "engine": "CPU", "params": ["pattern"]},
    "drop": {"name": "Drop lines matching", "engine": "CPU", "params": ["pattern"]},
}


def _gpu_bytes_map(raw, mode, out_path):
    """Case transforms, 64 MB at a time through the card, streamed straight to the new version's file."""
    step, ctx = 64 << 20, 64
    with open(out_path, "wb") as f:
        for a in range(0, raw.size, step):
            b = min(raw.size, a + step)
            lo = max(0, a - ctx)
            host = np.ascontiguousarray(raw[lo:b])

            def job(host=host):
                gi = cp.asarray(host)
                go = cp.empty_like(gi)
                K("casemap")(_grid(gi.size), (256,), (gi, go, cp.int64(gi.size), cp.int32(mode)))
                return cp.asnumpy(go)
            res = engine.run_on_gpu(job, "case transform", 120)
            f.write(res[a - lo:].tobytes())
    return os.path.getsize(out_path)


def _dedupe(raw):
    data = np.asarray(raw)
    nl = np.flatnonzero(data == 10)
    starts = np.r_[0, nl + 1]
    ends = np.r_[nl, data.size]
    keep = np.zeros(starts.size, bool)
    hashes = np.empty(starts.size, np.uint64)
    step = 4_000_000
    for i in range(0, starts.size, step):
        s, e = starts[i:i + step], ends[i:i + step]
        lo, hi = int(s[0]), int(e[-1])
        host = np.ascontiguousarray(data[lo:hi])

        def job(host=host, s=s, e=e, lo=lo):
            gb = cp.asarray(host)
            h = cp.empty(s.size, cp.uint64)
            K("linehash")(_grid(s.size), (256,), (gb, cp.asarray(s - lo), cp.asarray(e - lo), cp.int64(s.size), h))
            return cp.asnumpy(h)
        hashes[i:i + step] = engine.run_on_gpu(job, "hash lines", 120)
    blank = (ends - starts) == 0
    _, first = np.unique(hashes, return_index=True)
    keep[first] = True
    keep |= blank
    removed = int((~keep).sum())
    lens = (ends - starts + 1)
    lens[-1] -= 1
    mask = np.repeat(keep, lens)
    return data[mask].tobytes(), removed


def apply_transform(c, op, p, out_path):
    raw = c.raw
    t0 = time.time()
    changed = None
    if op in ("lower", "upper", "title", "sentence"):
        _gpu_bytes_map(raw, {"lower": 0, "upper": 1, "title": 2, "sentence": 3}[op], out_path)
        return None, None, time.time() - t0
    if raw.size > (4 << 30):
        raise ValueError("this transform works on corpora up to 4 GB; the case transforms stream any size")
    if op == "replace":
        find = (p.get("find") or "").encode("utf-8")
        rep = (p.get("replace") or "").encode("utf-8")
        if not find:
            raise ValueError("nothing to find")
        data = bytes(raw)
        if p.get("case") and not p.get("whole"):
            changed = data.count(find)
            new = data.replace(find, rep)
        else:
            pat = re.escape(find)
            if p.get("whole"):
                pat = rb"(?<![A-Za-z0-9'])" + pat + rb"(?![A-Za-z0-9'])"
            rx = re.compile(pat, 0 if p.get("case") else re.IGNORECASE)
            new, changed = rx.subn(rep.replace(b"\\", b"\\\\"), data)
    elif op == "regex":
        rx = re.compile((p.get("pattern") or "").encode("utf-8"), re.MULTILINE)
        new, changed = rx.subn((p.get("replace") or "").encode("utf-8"), bytes(raw))
    elif op == "nopunct":
        data = bytes(raw)
        table = bytes(range(256))
        new = data.translate(table, b"!\"#$%&()*+,./:;<=>?@[\\]^_`{|}~")
        changed = len(data) - len(new)
    elif op == "nodigits":
        data = bytes(raw)
        new = data.translate(bytes(range(256)), b"0123456789")
        changed = len(data) - len(new)
    elif op == "spaces":
        data = bytes(raw)
        new = re.sub(rb"[ \t]+\n", b"\n", re.sub(rb"[ \t]{2,}", b" ", data))
        new = re.sub(rb"\n{3,}", b"\n\n", new)
        changed = len(data) - len(new)
    elif op == "html":
        data = bytes(raw)
        new = strip_html(data)
        changed = len(data) - len(new)
    elif op == "clean":
        data = bytes(raw)
        new = clean_markup(data)
        changed = len(data) - len(new)
    elif op == "dedupe":
        new, changed = _dedupe(raw)
    elif op in ("sortlines", "keep", "drop"):
        lines = bytes(raw).split(b"\n")
        if op == "sortlines":
            lines.sort(key=lambda x: x.lower(), reverse=bool(p.get("reverse")))
        else:
            rx = re.compile((p.get("pattern") or "").encode("utf-8"), re.IGNORECASE)
            before = len(lines)
            lines = [ln for ln in lines if bool(rx.search(ln)) == (op == "keep")]
            changed = before - len(lines)
        new = b"\n".join(lines)
    else:
        raise ValueError("unknown transform " + op)
    with open(out_path, "wb") as f:
        f.write(new)
    return new, changed, time.time() - t0


class _Seg:
    """A byte segment that looks enough like a Corpus for apply_transform (it only reads .raw)."""
    def __init__(self, b):
        self.raw = np.frombuffer(b, np.uint8) if b else np.zeros(0, np.uint8)


def _per_doc(c, op, params, out_path, docs):
    """Apply a length-changing transform one document at a time, so every document keeps its name and the new
    boundaries are exact. The separators between documents are copied through untouched."""
    raw = bytes(c.raw)
    tmp = out_path + ".seg"
    out, new_docs, pos, changed = bytearray(), [], 0, 0
    for d in docs:
        a, b = int(d["start"]), int(d["start"]) + int(d["bytes"])
        out += raw[pos:a]
        seg = raw[a:b]
        if seg:
            nb, ch, _ = apply_transform(_Seg(seg), op, params, tmp)
            if nb is None:
                with open(tmp, "rb") as f:
                    nb = f.read()
            changed += int(ch or 0)
        else:
            nb = b""
        new_docs.append({"name": d["name"], "start": len(out), "bytes": len(nb)})
        out += nb
        pos = b
    out += raw[pos:]
    with open(out_path, "wb") as f:
        f.write(out)
    try:
        os.remove(tmp)
    except OSError:
        pass
    return new_docs, changed


def transform(cid, op, params, job=None):
    c = activate(cid, job)
    if job:
        job.step(0.1, "applying " + TRANSFORMS[op]["name"])
    v = c.version + 1
    new, changed, secs = apply_transform(c, op, params, c.vpath(v))
    size = os.path.getsize(c.vpath(v))
    same_len = size == c.raw.size
    c.meta["version"] = v
    c.meta["bytes"] = size
    if not same_len:
        docs = c.meta.get("docs") or []
        if docs and op not in ("sortlines",):     # sorting lines across documents has no per-document meaning
            if job:
                job.step(0.3, "keeping document boundaries")
            try:
                c.meta["docs"], changed = _per_doc(c, op, params, c.vpath(v), docs)
                size = os.path.getsize(c.vpath(v))
            except Exception:  # noqa: BLE001
                apply_transform(c, op, params, c.vpath(v))
                size = os.path.getsize(c.vpath(v))
                c.meta["docs"] = []
        else:
            c.meta["docs"] = []
        c.meta["bytes"] = size
    step = {"op": op, "name": TRANSFORMS[op]["name"], "params": params, "engine": TRANSFORMS[op]["engine"],
            "changed": changed, "secs": round(secs, 3), "at": time.time()}
    c.meta.setdefault("recipe", []).append(step)
    c.meta.setdefault("versions", []).append({"v": v, "bytes": size, "op": TRANSFORMS[op]["name"], "at": time.time(),
                                              "docs": c.meta.get("docs") or []})
    c.save_meta()
    if job:
        job.step(0.5, "make the index of the new version")
    c.release()
    ACTIVE["c"] = None
    activate(cid, job)
    return {"version": v, "changed": changed, "secs": round(secs, 3), "bytes": size, "step": step}


def undo(cid, job=None):
    c = Corpus(cid)
    if c.version == 0:
        raise ValueError("nothing to undo")
    old = c.version
    c.meta["version"] = old - 1
    c.meta["bytes"] = os.path.getsize(c.vpath(old - 1))
    if c.meta.get("recipe"):
        c.meta["recipe"].pop()
    c.meta["versions"] = [x for x in c.meta.get("versions", []) if x["v"] < old]
    if c.meta["versions"]:
        c.meta["docs"] = c.meta["versions"][-1].get("docs") or c.meta.get("docs") or []
    c.save_meta()
    for path in (c.vpath(old), os.path.dirname(c.ipath("x", old))):
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        elif os.path.exists(path):
            os.remove(path)
    a = ACTIVE["c"]
    if a and a.id == cid:
        a.release()
        ACTIVE["c"] = None
    activate(cid, job)
    return {"version": old - 1}


EXTRACT = {
    "emails": rb"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}",
    "urls": rb"https?://[^\s<>\"')]+",
    "years": rb"\b(1[5-9]\d\d|20\d\d)\b",
    "numbers": rb"\b\d[\d,]*(?:\.\d+)?\b",
    "dates": rb"\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? \d{4})\b",
    "names": rb"\b(?:[A-Z][a-z]+(?: [A-Z][a-z]+){1,3})\b",
    "hashtags": rb"(?<![\w])#[A-Za-z]\w+",
    "money": rb"[$\xc2\xa3\xe2\x82\xac]\s?\d[\d,]*(?:\.\d\d)?",
}


def extract(c, kind, top=300):
    t0 = time.time()
    rx = re.compile(EXTRACT[kind])
    counts = {}
    step = 64 << 20
    raw = c.raw
    for a in range(0, raw.size, step):
        buf = bytes(raw[a:min(raw.size, a + step + 256)])
        lim = min(step, raw.size - a)
        for m in rx.finditer(buf):
            if m.start() >= lim:
                break
            k = m.group(0)
            counts[k] = counts.get(k, 0) + 1
    items = sorted(counts.items(), key=lambda x: -x[1])
    if kind == "names":
        items = [(k, v) for k, v in items if not k.split(b" ")[0].lower().decode("utf-8", "replace") in STOP]
    return {"kind": kind, "distinct": len(items), "total": sum(v for _, v in items),
            "items": [{"v": k.decode("utf-8", "replace"), "c": v} for k, v in items[:top]], "ms": round((time.time() - t0) * 1000, 1)}
