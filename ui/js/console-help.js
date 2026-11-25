// Console help content: the step-by-step Guide and the hierarchical Reference.
// A body is a list of blocks: a string is HTML; {code} is a runnable Python block (Open in editor / Run).
// Code is written with String.raw so backslashes reach Python untouched. Every code block here is run by
// tests on the card before shipping — keep them short and self-contained.
const C = String.raw;

// ---------------------------------------------------------------- the Guide: lessons, in order
export const GUIDE = [
  {
    id: "where", title: "Where your code runs", sum: "CPU, GPU, and the three names that you get free",
    body: [
      `<p>When you press <b>Run</b>, VectorFall sends your code to the server. It starts the code as a <b>new Python process</b> in the VectorFall container.
       That process is ordinary Python. <b>Python itself always runs on the CPU</b>: every line, every <code>for</code> loop, every <code>if</code>.</p>
       <p>The GPU (<span data-card="name">this card</span>) does work only when you ask for it through <b>CuPy</b>. A CuPy operation such as <code>x * 2</code> makes the CPU
       send a small program (a <i>kernel</i>) to the card. The card runs the kernel on all the elements at the same time, on its <span data-card="cores">many</span> cores. The data stays in the card's own memory (<span data-card="mem">see the Machine view</span>).</p>
       <div class="hg-cols"><div><b class="cpu">CPU</b> Python lines, <code>np.</code> arrays and maths, files, print, downloads, PIL images</div>
       <div><b class="gpu">GPU</b> <code>cp.</code> arrays and all operations on them, your own CUDA kernels</div></div>
       <p>The rule is: <b><code>np</code> = CPU, <code>cp</code> = GPU</b>. The two libraries have almost the same functions. CuPy is a copy of the NumPy interface.</p>
       <p>The Console loads three names for you, so short snippets work without imports: <code>np</code>, <code>cp</code> and <code>vf</code> (and <code>math</code> and <code>time</code>).
       The Console adds nothing else. If you write the imports yourself, as below, the result is the same, and your files are easier to read.</p>`,
      { code: C`import numpy as np      # arrays in host RAM; maths on the CPU
import cupy as cp       # arrays in the card's 1 GB; maths on the GPU
import vf               # VectorFall's display helpers (only exists inside this Console)

a = np.arange(5)        # CPU: made in host memory
b = cp.arange(5)        # GPU: made in the card's memory
print(type(a))
print(type(b))
print(b.device)         # which card holds it
print(a + 10)           # CPU maths
print(b + 10)           # GPU maths (print copies the answer back to show it)` },
      `<p>Press <b>Run</b> on the block above. The two printed lines look the same. But the second array stays on the card until <code>print</code> asks for it.</p>`,
    ],
  },
  {
    id: "move", title: "Move data to and from the card", sum: "asarray, asnumpy, and the copies that you do not see",
    body: [
      `<p>The CPU and the GPU have <b>separate memory</b>. The PCIe bus connects them. Data must cross the bus, and a copy is slow compared with a calculation.
       Thus, copy the data one time, do much work on the card, and copy back only the answer.</p>
       <table class="tbl hg-t"><tr><th>direction</th><th>how</th></tr>
       <tr><td>CPU → GPU</td><td><code>cp.asarray(np_array)</code></td></tr>
       <tr><td>GPU → CPU</td><td><code>cp.asnumpy(x)</code> or <code>x.get()</code></td></tr>
       <tr><td>GPU → CPU, quietly</td><td><code>float(x)</code>, <code>int(x)</code>, <code>print(x)</code>, <code>x.tolist()</code>, <code>if x &gt; 0:</code>. Each one copies the data and waits for the card.</td></tr></table>`,
      { code: C`import numpy as np
import cupy as cp

host = np.random.rand(1_000_000).astype(np.float32)   # CPU: a million numbers in host RAM
dev = cp.asarray(host)            # copy CPU -> GPU (about 4 MB over PCIe)
dev = dev * 2 + 1                 # GPU: two kernels, the data stays on the card
back = cp.asnumpy(dev)            # copy GPU -> CPU (the same as dev.get())
print(type(back), back[:3])
print(float(dev.sum()))           # float() copies one number back, after waiting for the GPU` },
      `<p>You cannot mix the two types of array in one expression. CuPy stops with an error. It does not make a copy that you cannot see:</p>`,
      { code: C`import numpy as np
import cupy as cp

try:
    cp.arange(3) + np.arange(3)
except TypeError as e:
    print("mixing a GPU and a CPU array:", e)

print(cp.arange(3) + cp.asarray(np.arange(3)))   # copy first, then it works` },
    ],
  },
  {
    id: "whole", title: "Think in whole arrays", sum: "one operation = one kernel over every element",
    body: [
      `<p>A Python <code>for</code> loop over a million elements runs a million times <b>on the CPU</b>. If you write the same calculation as one array expression,
       it runs one time, and the card does all the million elements in parallel. This is the most important idea for a GPU.</p>`,
      { code: C`import math, time
import cupy as cp

x = cp.linspace(0, 2 * math.pi, 1_000_000, dtype=cp.float32)
y = cp.sin(x) ** 2 + cp.cos(x) ** 2; float(y[0])   # warm-up: the first use of each operation loads it

t = time.time()
y = cp.sin(x) ** 2 + cp.cos(x) ** 2     # a few kernels over all million numbers, no Python loop
float(y.max())                           # wait for the answer
whole = time.time() - t
print("whole array, 1,000,000 elements:", round(whole * 1000, 2), "ms")

t = time.time()
for i in range(1000):                    # the slow way: a CPU loop, copying one element back from the card each step
    v = math.sin(float(x[i])) ** 2 + math.cos(float(x[i])) ** 2
each = (time.time() - t) / 1000
print("one by one, 1,000 elements:", round(each * 1000 * 1000, 1), "ms")
print("one by one for all 1,000,000 would take about", round(each * 1_000_000, 1), "s  ->",
      round(each * 1_000_000 / whole), "x slower")` },
      `<p>With <b>broadcasting</b>, arrays of different shapes combine. A column <code>(4, 1)</code> times a row <code>(1, 5)</code> gives a <code>(4, 5)</code> table.
       <code>[:, None]</code> adds an axis of length 1 to make the column.</p>`,
      { code: C`import cupy as cp

col = cp.arange(4)[:, None]     # shape (4, 1)
row = cp.arange(5)[None, :]     # shape (1, 5)
print(col * row)                # shape (4, 5): a multiplication table, built on the card` },
    ],
  },
  {
    id: "matmul", title: "Matrices and the @ operator", sum: "what a @ b means, and how the race between the CPU and the GPU works",
    body: [
      `<p><code>@</code> is the Python operator for <b>matrix multiplication</b> (since Python 3.5). <code>a @ b</code> is the same as <code>xp.matmul(a, b)</code>.
       The dot product of row <i>i</i> of <code>a</code> and column <i>j</i> of <code>b</code> gives element <i>(i, j)</i>.
       It is <b>not</b> the product of each element with its pair. That product is <code>a * b</code>.</p>
       <p>For two n×n matrices, <code>@</code> does 2n³ arithmetic operations. At n = 2000, that is 16 billion. On a CuPy array, <code>@</code> calls the NVIDIA cuBLAS library on the card.</p>`,
      { code: C`import cupy as cp
import vf

a = cp.array([[1, 2], [3, 4]], dtype=cp.float32)
b = cp.array([[5, 6], [7, 8]], dtype=cp.float32)
print("a * b  (element by element)\n", a * b)
print("a @ b  (matrix product)\n", a @ b)

n = 2000
m = cp.random.random((n, n), dtype=cp.float32)
ms = vf.timeit(lambda: m @ m)            # average time on the card, properly synchronised
print(n, "x", n, "matrix product:", round(ms, 1), "ms =", round(2 * n ** 3 / ms / 1e6, 1), "GFLOP/s")` },
      `<p><b>The race example, line by line.</b> Its function has a parameter with the name <code>xp</code>. That parameter is a <i>module</i>, not a number.
       Give <code>np</code> to run the function on the CPU. Give <code>cp</code> to run it on the card. The two libraries have the same functions, so one function works for both.
       <code>vf.race(fn, 2000)</code> calls <code>fn(np, 2000)</code>, then <code>fn(cp, 2000)</code>. It measures the time of each call and draws the bars.
       The CPU side is NumPy on <b>one host core</b>. VectorFall keeps NumPy on one thread, so that NumPy does not compete with the server.</p>`,
      { code: C`import numpy as np
import cupy as cp
import vf

def multiply(xp, n):                     # xp is np (CPU) or cp (GPU)
    a = xp.ones((n, n), dtype=xp.float32)
    return a @ a

on_cpu = multiply(np, 400)               # NumPy: runs on the CPU
on_gpu = multiply(cp, 400)               # CuPy: runs on the card
print(type(on_cpu).__module__, type(on_gpu).__module__)
vf.race(multiply, 2000)                  # both, timed, with a speed-up bar` },
    ],
  },
  {
    id: "async", title: "The card runs ahead: honest times", sum: "CuPy puts kernels in a queue, so synchronise before you measure",
    body: [
      `<p>A CuPy call <b>returns when the work goes into the queue</b>, not when the work is complete. The CPU goes ahead while the card does the work.
       This is good for speed. But <code>time.time()</code> around a CuPy line measures almost nothing, unless you wait for the card first.</p>`,
      { code: C`import time
import cupy as cp

x = cp.random.random((3000, 3000), dtype=cp.float32)
x @ x; cp.cuda.Device().synchronize()     # warm-up: the first call loads cuBLAS

t = time.time()
y = x @ x                                 # queued...
queued = time.time() - t
cp.cuda.Device().synchronize()            # ...now wait for the card to finish
done = time.time() - t
print("returned after", round(queued * 1000, 2), "ms; finished after", round(done * 1000, 1), "ms")

start, end = cp.cuda.Event(), cp.cuda.Event()   # or time on the card itself
start.record(); y = x @ x; end.record(); end.synchronize()
print("measured on the card:", round(cp.cuda.get_elapsed_time(start, end), 1), "ms")` },
      `<p><code>vf.timeit(fn)</code> does the warm-up and the synchronisation for you. It returns the average time in milliseconds.</p>`,
    ],
  },
  {
    id: "dtype", title: "float32 is the card's native speed", sum: "why the examples say dtype=cp.float32",
    body: [
      `<p><span data-card="name">this card</span> does 32-bit floats at full speed. It does 64-bit floats at only <b><span data-card="fp64">a fraction</span></b> of that speed on paper (most GeForce and Quadro cards: 1/24 to 1/64). Measure it on your card with the code below.
       The default type in NumPy and CuPy is <code>float64</code>. On this card, ask for <code>float32</code> when its precision is sufficient. It is almost always sufficient for graphics, sound, statistics and ML.</p>`,
      { code: C`import cupy as cp
import vf

for dt in (cp.float32, cp.float64):
    a = cp.random.random((1500, 1500)).astype(dt)
    print(dt.__name__, round(vf.timeit(lambda: a @ a), 1), "ms")

print(cp.random.random(3).dtype, "<- the default")
print(cp.random.random(3, dtype=cp.float32).dtype, "<- what you usually want here")` },
    ],
  },
  {
    id: "memory", title: "1 GB: memory and batches", sum: "how much is free, the memory pool, and work in pieces",
    body: [
      `<p>The card has 1&nbsp;GB. The display and VectorFall itself also use this memory. A float32 is 4 bytes, so 100 million of them fill 400&nbsp;MB.
       CuPy keeps free memory in a <b>pool</b> to use it again quickly. <code>free_all_blocks()</code> gives the memory back to the card.</p>`,
      { code: C`import cupy as cp

free, total = cp.cuda.Device().mem_info
print("card:", free // 2**20, "MB free of", total // 2**20, "MB")

pool = cp.get_default_memory_pool()
x = cp.zeros((50, 1024, 1024), cp.float32)          # 200 MB
print("in use:", pool.used_bytes() // 2**20, "MB")
del x                                               # freed, but kept in the pool
print("in use:", pool.used_bytes() // 2**20, "MB; held by the pool:", pool.total_bytes() // 2**20, "MB")
pool.free_all_blocks()                              # give it back to the card
print("held by the pool:", pool.total_bytes() // 2**20, "MB")` },
      `<p>If the data does not fit, do the work in <b>batches</b>. Keep only the totals from batch to batch. The "million random walks" example works this way.</p>`,
      { code: C`import cupy as cp

try:
    big = cp.zeros((2000, 1024, 1024), cp.float32)   # 8 GB: will not fit
except cp.cuda.memory.OutOfMemoryError as e:
    print("too big:", str(e)[:80])

total, n = 0.0, 0
for batch in range(20):                               # 20 x 10 million numbers, 40 MB at a time
    x = cp.random.random(10_000_000, dtype=cp.float32)
    total += float(x.sum()); n += x.size
print("mean of", n, "numbers:", total / n)` },
    ],
  },
  {
    id: "ewk", title: "Your own kernel: ElementwiseKernel", sum: "one line of C, run on every element",
    body: [
      `<p>A formula can need several CuPy operations. Each operation is a separate pass over the memory. You can join these operations into <b>one</b> kernel.
       You write the body for one element in C. CuPy writes the loop, compiles it one time (and keeps it in a cache), and runs it on the card.</p>
       <p>The signature gives the inputs, then the outputs, with their types. Below, <code>x</code> and <code>y</code> are each one element.</p>`,
      { code: C`import cupy as cp

soft_clip = cp.ElementwiseKernel(
    "float32 x, float32 limit",              # inputs  (a scalar is broadcast to every element)
    "float32 y",                             # output
    "y = limit * tanhf(x / limit)",          # C, run once per element, on the card
    "soft_clip")

x = cp.linspace(-10, 10, 9, dtype=cp.float32)
print(x)
print(soft_clip(x, cp.float32(3.0)))` },
    ],
  },
  {
    id: "raw", title: "Your own kernel: CUDA C with RawKernel", sum: "threads, blocks, and your own indexes",
    body: [
      `<p>A <code>RawKernel</code> is a real CUDA C function. You launch it with a <b>grid</b> of <b>blocks</b>. Each block contains <b>threads</b>.
       Each thread runs the full function one time. It finds its own element from <code>blockIdx</code>, <code>blockDim</code> and <code>threadIdx</code>.</p>
       <p>The launch is <code>kernel((blocks,), (threads_per_block,), (arguments...))</code>. Give each scalar an exact type, for example <code>cp.int32(n)</code>,
       to agree with the C signature.</p>`,
      { code: C`import cupy as cp

src = r'''
extern "C" __global__ void saxpy(const float a, const float* x, float* y, const int n) {
    int i = blockIdx.x * blockDim.x + threadIdx.x;   // this thread's element
    if (i < n) y[i] = a * x[i] + y[i];               // the last block may run past the end
}
'''
saxpy = cp.RawKernel(src, "saxpy")

n = 1_000_000
x = cp.ones(n, dtype=cp.float32)
y = cp.arange(n, dtype=cp.float32)
threads = 256                                 # threads per block
blocks = (n + threads - 1) // threads         # enough blocks to cover n
saxpy((blocks,), (threads,), (cp.float32(2.0), x, y, cp.int32(n)))
print(y[:5], "...", y[-1])` },
    ],
  },
  {
    id: "watchdog", title: "The two-second rule", sum: "a card that also drives a display stops long kernels",
    body: [
      `<p>When a card also drives a display, the driver stops <b>a kernel that runs for more than about 2 seconds</b>. <span data-card="watchdog">The Machine view tells if this applies to your card.</span>
       You then see <code>cudaErrorLaunchTimeout</code>, and the rest of the run fails. A full run can be up to 60&nbsp;s. Only each launch must be short.</p>
       <p>The repair is always the same: <b>divide the work into many short launches</b> in a Python loop. Each line below is a separate, quick launch.</p>`,
      { code: C`import cupy as cp
import vf

w, h = 1200, 800
y, x = cp.mgrid[-1.2:1.2:h * 1j, -1.8:1.8:w * 1j]
z = (x + 1j * y).astype(cp.complex64)
c = cp.complex64(-0.70 + 0.27j)
count = cp.zeros(z.shape, cp.float32)
for i in range(200):              # 200 tiny launches rather than one long one
    z = z * z + c
    count += cp.abs(z) < 2
vf.show(cp.log1p(count), "Julia set: 200 short launches")` },
    ],
  },
  {
    id: "show", title: "Show the results", sum: "vf.show, vf.plot, vf.table",
    body: [
      `<p><code>print</code> sends text to the Output tab. The <code>vf</code> helpers put pictures, charts and tables there. They accept CuPy arrays or NumPy arrays.
       They copy the GPU data back for you.</p>`,
      { code: C`import cupy as cp
import vf

t = cp.linspace(0, 1, 500, dtype=cp.float32)
vf.plot(t, cp.sin(40 * t) * cp.exp(-3 * t), title="vf.plot: a decaying wave")

img = cp.outer(cp.sin(cp.linspace(0, 9, 256)), cp.cos(cp.linspace(0, 9, 384)))
vf.show(img, "vf.show: any 2-D array becomes a greyscale picture")

vals = cp.random.normal(size=100_000, dtype=cp.float32)
counts, edges = cp.histogram(vals, 30)
vf.plot(edges[:-1], counts, kind="bar", title="vf.plot kind='bar': a histogram")
vf.table([["mean", float(vals.mean())], ["std", float(vals.std())]], ["statistic", "value"])` },
    ],
  },
  {
    id: "data", title: "Use your files and the VectorFall data", sum: "~/scripts, downloads, and the Text Engine",
    body: [
      `<p>Your process starts in <b>~/scripts</b> (the Workspace on the left). Thus your code can open the files there by name. Downloads, files and PIL run on the CPU.
       To process the result on the card, move it there with <code>cp.asarray</code>.</p>
       <p><code>vf.text</code> asks the VectorFall server about the corpus in the Text Engine. That work runs in the GPU queue of the server, not in your process.</p>`,
      { code: C`import os
import numpy as np
import cupy as cp
import vf

print("working folder:", os.getcwd(), "->", sorted(os.listdir("."))[:8])

with open("guide_demo.csv", "w") as f:              # CPU: write a small file
    f.write("x,y\n" + "\n".join("{},{}".format(i, i * i) for i in range(10)))
data = cp.asarray(np.loadtxt("guide_demo.csv", delimiter=",", skiprows=1))   # CPU reads, then copy to the card
print("sum of y on the card:", float(data[:, 1].sum()))
os.remove("guide_demo.csv")

try:
    r = vf.text.search("the")
    print("Text Engine:", r["count"], "matches for 'the'")
except Exception as e:
    print("no corpus loaded in the Text Engine:", e)` },
    ],
  },
  {
    id: "outside", title: "Run outside the Console", sum: "the terminal, plain Python, and what changes",
    body: [
      `<p>The <b>Terminal</b> below the editor runs real shell commands in ~/scripts. There, <code>python3 myfile.py</code> runs your file as
       <b>plain Python</b>, without the Console harness:</p>
       <ul><li>The terminal loads nothing for you. Import <code>numpy</code> and <code>cupy</code> yourself (the examples in this guide do this).</li>
       <li><code>vf</code> is not available there, because it draws into the Output tab. Use <code>print</code>.</li>
       <li>The terminal stops a command after 30 seconds.</li></ul>
       <p>Type <code>nvidia-smi</code> in the terminal to see the card, its memory and the processes that use it. Your script is in that list while it runs.</p>
       <p>To see exactly what the harness does, open <b>Reference → Environment → What Run does</b>. It shows the full source.</p>`,
    ],
  },
];

// ---------------------------------------------------------------- the Reference: a tree of topics
// node: {t, kids:[...]} or a leaf {id, t, sig?, keys?, body}
export const REF = [
  { t: "Environment", kids: [
    { id: "env-names", t: "Pre-loaded names", keys: ["np", "cp", "vf", "math", "time", "numpy", "cupy"], body: [
      `<p>Your code starts with these names. They are the only things that the Console adds:</p>
       <table class="tbl hg-t"><tr><td><code>np</code></td><td><code>import numpy as np</code> — arrays and maths on the <b class="cpu">CPU</b></td></tr>
       <tr><td><code>cp</code></td><td><code>import cupy as cp</code> — arrays and maths on the <b class="gpu">GPU</b></td></tr>
       <tr><td><code>vf</code></td><td>the VectorFall display helpers (see <i>vf helpers</i>). <code>import vf</code> also works.</td></tr>
       <tr><td><code>math</code>, <code>time</code></td><td>the standard modules</td></tr></table>
       <p>The versions are Python 3.6, NumPy 1.19 and CuPy 9.6. Pillow (<code>from PIL import Image</code>) and <code>cupyx.scipy</code> (image and signal routines) are also available.</p>`] },
    { id: "env-run", t: "What Run does", keys: ["run", "harness", "vfh"], body: [
      `<ol><li>VectorFall saves the text of the editor to a temporary file on the server.</li>
       <li>A new process runs <code>python3 /srv/app/vfh.py</code> on that file. The process starts in ~/scripts.</li>
       <li>The harness imports numpy, cupy, math and time, makes <code>vf</code>, and sends the <code>print</code> output to the Output tab.</li>
       <li>It runs your code and waits for the card to complete (<code>synchronize</code>). Then it shows the time, or the error. It removes its own lines from the traceback.</li>
       <li>The process stops. This frees all of its card memory.</li></ol>
       <p><button class="btn ghost xs" data-harness>Show the harness source</button></p><div class="hg-harness"></div>`] },
    { id: "env-limits", t: "Limits", keys: ["limit", "timeout", "stop"], body: [
      `<table class="tbl hg-t"><tr><td>run time</td><td>60 s for each Run. Then VectorFall stops the run. <b>Stop</b> ends it immediately.</td></tr>
       <tr><td>one kernel</td><td>about 2 s. After that, the display driver stops it (see <i>Time and sync → The two-second rule</i>).</td></tr>
       <tr><td>card memory</td><td>1 GB in total. The display and VectorFall also use it. Check it with <code>cp.cuda.Device().mem_info</code>.</td></tr>
       <tr><td>CPU</td><td>2 host cores. NumPy uses only one thread.</td></tr>
       <tr><td>files</td><td>Your process starts in ~/scripts. The files that you save there show in the Workspace.</td></tr>
       <tr><td>terminal</td><td>30 s per command</td></tr></table>`] },
    { id: "env-where", t: "CPU or GPU? The rules", keys: ["cpu", "gpu", "host", "device"], body: [
      `<table class="tbl hg-t"><tr><th>runs on the CPU</th><th>runs on the GPU</th></tr>
       <tr><td>every Python statement, loop and <code>if</code></td><td>every operation on a <code>cp</code> array</td></tr>
       <tr><td>every <code>np</code> function</td><td><code>@</code>, <code>+</code>, <code>cp.sin</code>, <code>.sum()</code> … on <code>cp</code> arrays</td></tr>
       <tr><td>files, downloads, PIL, <code>print</code></td><td><code>ElementwiseKernel</code>, <code>RawKernel</code></td></tr>
       <tr><td>the <code>vf</code> helpers (after they copy the data back)</td><td><code>cupyx.scipy</code> routines</td></tr></table>
       <p>A quick test: if <code>type(x)</code> is <code>cupy.ndarray</code>, the data is on the card.</p>`] },
  ] },
  { t: "Python syntax", kids: [
    { id: "py-at", t: "@  matrix multiply", keys: ["@", "matmul"], body: [
      `<p><code>a @ b</code> is matrix multiplication, the same as <code>xp.matmul(a, b)</code> (Python 3.5+). <code>a * b</code> multiplies element by element.
       The shapes must agree: (m, k) @ (k, n) → (m, n). For a vector, <code>M @ v</code> multiplies the matrix and the vector.</p>`,
      { code: C`import cupy as cp
M = cp.array([[2, 0], [0, 3]], dtype=cp.float32)
v = cp.array([1, 1], dtype=cp.float32)
print(M @ v)       # [2. 3.]
print(M * M)       # element by element` }] },
    { id: "py-broadcast", t: "Broadcasting, None", keys: ["broadcast", "None", "newaxis"], body: [
      `<p>Two arrays combine when their shapes agree from the right. A size of 1 stretches to fit. <code>x[:, None]</code> (or <code>x[:, cp.newaxis]</code>) changes a row into a column.</p>`,
      { code: C`import cupy as cp
x = cp.arange(3)
print(x[:, None] + x[None, :] * 10)    # (3,1) + (1,3) -> (3,3)` }] },
    { id: "py-slice", t: "Slices and indexes", keys: ["slice", "index", "mask"], body: [
      `<p><code>x[a:b:step]</code> gives a range. <code>x[r, c]</code> gives one element. <code>x[mask]</code> gives the elements where a True/False array is True.
       A slice is a <b>view</b> of the same card memory, not a copy.</p>`,
      { code: C`import cupy as cp
x = cp.arange(10)
print(x[2:8:2], x[-1])
print(x[x % 3 == 0])     # boolean mask, computed on the card
v = x[:3]; v[:] = 99     # a view: this changes x too
print(x)` }] },
    { id: "py-lambda", t: "lambda", keys: ["lambda"], body: [
      `<p><code>lambda: a @ a</code> is a small function without a name and without arguments. <code>vf.timeit(lambda: a @ a)</code> gives the <i>work</i> to the timer.
       Thus the timer can run the work several times. Without lambda, Python runs the work one time and gives only the result.</p>`] },
    { id: "py-underscore", t: "1_000_000", keys: ["_"], body: [`<p>Underscores in numbers only make them easier to read: <code>1_000_000 == 1000000</code> (Python 3.6+).</p>`] },
  ] },
  { t: "Arrays", kids: [
    { id: "ar-create", t: "Make arrays", sig: "zeros · ones · full · empty · arange · linspace · mgrid · eye · array", keys: ["zeros", "ones", "full", "empty", "arange", "linspace", "mgrid", "eye", "array"], body: [
      `<p>All of these make the array directly on the card. Give <code>dtype=cp.float32</code>, unless you need 64 bits.</p>`,
      { code: C`import cupy as cp
print(cp.zeros((2, 3), cp.float32))
print(cp.full(4, 7.5, cp.float32))
print(cp.arange(0, 1, 0.25))
print(cp.linspace(0, 1, 5, dtype=cp.float32))
y, x = cp.mgrid[0:2, 0:3]          # coordinate grids, used for images
print(x)
print(cp.eye(3, dtype=cp.float32))` }] },
    { id: "ar-random", t: "Random numbers", sig: "random · normal · randint · seed · shuffle", keys: ["random", "normal", "randint", "seed", "shuffle", "uniform"], body: [
      `<p>The card makes random numbers quickly. <b>The default dtype is float64.</b> Give <code>dtype=cp.float32</code> to <code>random</code> and <code>normal</code>.
       <code>cp.random.seed(n)</code> makes the runs repeatable.</p>`,
      { code: C`import cupy as cp
cp.random.seed(1)
print(cp.random.random(4, dtype=cp.float32))            # uniform in [0, 1)
print(cp.random.normal(0, 1, 4, dtype=cp.float32))      # bell curve
print(cp.random.randint(0, 6, 10) + 1)                  # dice` }] },
    { id: "ar-props", t: "Properties", sig: "shape · dtype · size · nbytes · ndim · device", keys: ["shape", "dtype", "size", "nbytes", "ndim"], body: [
      { code: C`import cupy as cp
x = cp.zeros((1000, 1000), cp.float32)
print(x.shape, x.dtype, x.size, x.ndim)
print(x.nbytes // 2**20, "MB on", x.device)` }] },
    { id: "ar-dtype", t: "dtypes", sig: "float32 · float64 · int32 · uint8 · complex64 · astype", keys: ["astype", "float32", "float64", "int32", "uint8", "complex64"], body: [
      `<p>On most cards, use <code>float32</code> and <code>complex64</code>. 64 bits is many times slower (<span data-card="fp64">see the Machine view</span> on this card). Images are usually <code>uint8</code>. <code>x.astype(t)</code> converts the type. It makes a copy on the card.</p>`] },
    { id: "ar-shape", t: "Reshape and join", sig: "reshape · ravel · T · concatenate · stack · where", keys: ["reshape", "ravel", "T", "transpose", "concatenate", "stack", "where"], body: [
      { code: C`import cupy as cp
x = cp.arange(6)
m = x.reshape(2, 3)
print(m, m.T, sep="\n")
print(cp.concatenate([x, x]))
print(cp.stack([x, x * 10]))
print(cp.where(x > 2, x, -1))     # pick per element` }] },
  ] },
  { t: "Move data", kids: [
    { id: "mv-asarray", t: "cp.asarray", sig: "cp.asarray(a, dtype=None)", keys: ["asarray"], body: [
      `<p>Copies a NumPy array (or a list) from host memory <b>to the card</b>. If the input is already a CuPy array, it makes no copy.</p>`] },
    { id: "mv-asnumpy", t: "cp.asnumpy / .get()", sig: "cp.asnumpy(x) · x.get()", keys: ["asnumpy", "get"], body: [
      `<p>Copies a CuPy array from the card <b>back to host memory</b> as a NumPy array. First, it waits for all the work in the queue on that data.</p>`] },
    { id: "mv-hidden", t: "Copies that you do not see", keys: ["float", "int", "print", "tolist", "item", "bool"], body: [
      `<p>These all copy from the card and wait for it: <code>float(x)</code>, <code>int(x)</code>, <code>x.item()</code>, <code>print(x)</code> and <code>x.tolist()</code>.
       A GPU value in <code>if</code> or <code>while</code> also does this. One copy is cheap. One copy in each iteration of a fast loop can take most of the run time.</p>`] },
    { id: "mv-mix", t: "np and cp together", keys: ["TypeError", "mix"], body: [
      `<p>An expression with one NumPy array and one CuPy array gives a <code>TypeError</code>. First, move one side with <code>cp.asarray</code> or <code>cp.asnumpy</code>.</p>`] },
  ] },
  { t: "Maths", kids: [
    { id: "m-elem", t: "Element by element", sig: "+ − * / ** · sin cos exp log sqrt abs · maximum minimum clip", keys: ["sin", "cos", "exp", "log", "sqrt", "abs", "maximum", "minimum", "clip", "tanh", "hypot", "log1p"], body: [
      `<p>Each one is one kernel over all the elements. Each one returns a new array on the card.</p>`,
      { code: C`import cupy as cp
x = cp.linspace(0.1, 2, 5, dtype=cp.float32)
print(cp.sqrt(x), cp.exp(x), cp.clip(x, 0.5, 1.5), sep="\n")` }] },
    { id: "m-reduce", t: "Reductions", sig: "sum · mean · std · min · max · argmax · cumsum · axis=", keys: ["sum", "mean", "std", "min", "max", "argmax", "argmin", "cumsum", "axis"], body: [
      `<p>These make an array into fewer numbers. <code>axis=0</code> works down the columns. <code>axis=1</code> works along the rows. The result stays on the card (as a 0-d array) until you call <code>float()</code> on it.</p>`,
      { code: C`import cupy as cp
m = cp.arange(12, dtype=cp.float32).reshape(3, 4)
print(m.sum(), m.sum(axis=0), m.mean(axis=1), m.argmax(), sep="\n")` }] },
    { id: "m-sort", t: "Sort and count", sig: "sort · argsort · unique · histogram · searchsorted · bincount", keys: ["sort", "argsort", "unique", "histogram", "searchsorted", "bincount"], body: [
      { code: C`import cupy as cp
x = cp.random.randint(0, 10, 20)
print(cp.sort(x))
print(cp.unique(x, return_counts=True))
print(cp.bincount(x))` }] },
    { id: "m-linalg", t: "Linear algebra", sig: "matmul · dot · linalg.norm · solve · inv · eigh · svd", keys: ["dot", "norm", "solve", "inv", "eigh", "svd", "linalg"], body: [
      `<p>These use cuBLAS and cuSOLVER. Matrix products are the best case for the card. <b>Caution:</b> keep decompositions small.
       A full <code>svd</code> of a large matrix is slow on this Kepler card. A 1500×1500 <code>svd</code> takes about 40 s.</p>`,
      { code: C`import cupy as cp
A = cp.array([[3, 1], [1, 2]], dtype=cp.float32)
b = cp.array([9, 8], dtype=cp.float32)
x = cp.linalg.solve(A, b)
print(x, A @ x)                    # A @ x == b
print(cp.linalg.eigh(A)[0], cp.linalg.norm(b))` }] },
    { id: "m-fft", t: "FFT", sig: "fft.fft · rfft · ifft · irfft · fftfreq", keys: ["fft", "rfft", "ifft", "irfft", "fftfreq"], body: [
      `<p>cuFFT on the card. <code>rfft</code> is for real signals. It returns half of the spectrum.</p>`,
      { code: C`import math
import cupy as cp
sr = 8000
t = cp.arange(sr, dtype=cp.float32) / sr
sig = cp.sin(2 * math.pi * 50 * t) + 0.5 * cp.sin(2 * math.pi * 120 * t)
spec = cp.abs(cp.fft.rfft(sig))
print("strongest frequencies:", sorted(int(i) for i in cp.argsort(spec)[-2:]), "Hz")` }] },
    { id: "m-ndimage", t: "Images and signals (cupyx.scipy)", sig: "ndimage.sobel · gaussian_filter · convolve · zoom · rotate", keys: ["cupyx", "ndimage", "sobel", "gaussian_filter", "convolve", "zoom", "rotate"], body: [
      `<p>The SciPy image routines, on the card: <code>import cupyx.scipy.ndimage as ndi</code>.</p>`,
      { code: C`import cupy as cp
import cupyx.scipy.ndimage as ndi
import vf
y, x = cp.mgrid[-1:1:300j, -1:1:400j]
img = (x * x + y * y < 0.5).astype(cp.float32)
vf.show(ndi.gaussian_filter(img, 6), "blurred")
vf.show(cp.hypot(ndi.sobel(img, 0), ndi.sobel(img, 1)), "edges")` }] },
  ] },
  { t: "Custom kernels", kids: [
    { id: "k-elem", t: "ElementwiseKernel", sig: "cp.ElementwiseKernel(inputs, outputs, body, name)", keys: ["ElementwiseKernel"], body: [
      `<p>You write the C body for one element. CuPy writes the loop and the broadcast rules. If you need the index of the element, use <code>i</code>.
       CuPy compiles the kernel when you first use it, and keeps it in a cache on disk.</p>`,
      { code: C`import cupy as cp
dist = cp.ElementwiseKernel("float32 x, float32 y", "float32 d", "d = sqrtf(x * x + y * y)", "dist")
print(dist(cp.array([3, 6], cp.float32), cp.array([4, 8], cp.float32)))` }] },
    { id: "k-red", t: "ReductionKernel", sig: "cp.ReductionKernel(in, out, map, reduce, post, identity, name)", keys: ["ReductionKernel"], body: [
      `<p>Your own reduction, of the same type as sum or max. <i>map</i> changes each element. <i>reduce</i> combines pairs (<code>a</code>, <code>b</code>). <i>post</i> changes the total.</p>`,
      { code: C`import cupy as cp
l2 = cp.ReductionKernel("float32 x", "float32 y", "x * x", "a + b", "y = sqrtf(a)", "0", "l2norm")
print(l2(cp.array([3, 4], cp.float32)))      # 5.0` }] },
    { id: "k-raw", t: "RawKernel", sig: "cp.RawKernel(cuda_source, name)(grid, block, args)", keys: ["RawKernel", "RawModule", "__global__"], body: [
      `<p>A full CUDA C kernel (<code>extern "C" __global__</code>). Launch it with a grid of blocks and a number of threads for each block.
       Each thread finds its element from <code>blockIdx.x * blockDim.x + threadIdx.x</code>. It must make sure that the element is in range.
       For a full example, see Guide → <i>CUDA C with RawKernel</i>.</p>`] },
    { id: "k-grid", t: "Threads, blocks, grid", keys: ["blockIdx", "blockDim", "threadIdx", "gridDim", "threads", "blocks"], body: [
      `<p>A launch is a <b>grid</b> of <b>blocks</b>. A block has up to 1024 <b>threads</b>. 128–256 is a good default.
       Each multiprocessor runs up to 2048 threads at the same time, and <span data-card="name">this card</span> has <span data-card="sms">some</span> of them. When some blocks are complete, the card starts others. Thus, launch at least some thousands of threads to keep it busy.
       <code>blocks = (n + threads - 1) // threads</code> rounds up, so that the threads cover all the elements.</p>`] },
    { id: "k-scalar", t: "Typed scalars", keys: ["int32", "scalar"], body: [
      `<p>The arguments to a RawKernel must agree exactly with the C types. Give <code>cp.int32(n)</code> for <code>int</code>, <code>cp.float32(a)</code> for <code>float</code>,
       and <code>cp.int64</code> for <code>long long</code>. A plain Python <code>2.0</code> becomes a 64-bit double and gives incorrect results.</p>`] },
  ] },
  { t: "Time and sync", kids: [
    { id: "t-async", t: "Asynchronous launches", keys: ["async", "asynchronous"], body: [
      `<p>CuPy calls return when the work goes <b>into the queue</b>. The CPU continues while the card works. It stops when a line needs a result (a copy back), or when you synchronise.</p>`] },
    { id: "t-sync", t: "synchronize", sig: "cp.cuda.Device().synchronize()", keys: ["synchronize", "Stream"], body: [
      `<p>Stops the CPU until the card completes all the work in the queue. Use it before you read a clock. The harness also calls it at the end of each run.</p>`] },
    { id: "t-event", t: "Events", sig: "cp.cuda.Event · record · get_elapsed_time", keys: ["Event", "get_elapsed_time", "record"], body: [
      `<p>The card itself records these times. They are the most accurate method to measure GPU work.</p>`,
      { code: C`import cupy as cp
x = cp.random.random(20_000_000, dtype=cp.float32)
a, b = cp.cuda.Event(), cp.cuda.Event()
a.record(); cp.sort(x); b.record(); b.synchronize()
print("sorting 20 million:", round(cp.cuda.get_elapsed_time(a, b), 1), "ms")` }] },
    { id: "t-watchdog", t: "The two-second rule", keys: ["cudaErrorLaunchTimeout", "watchdog", "timeout"], body: [
      `<p>The display driver stops each kernel that runs for more than about 2 s, with <code>cudaErrorLaunchTimeout</code>. Then that process cannot use the card again. Press Run again.
       Divide long work into a loop of shorter launches, with fewer iterations or fewer elements in each call.</p>`] },
  ] },
  { t: "Memory", kids: [
    { id: "mem-info", t: "How much is free", sig: "cp.cuda.Device().mem_info", keys: ["mem_info"], body: [
      { code: C`import cupy as cp
free, total = cp.cuda.Device().mem_info
print(free // 2**20, "MB free of", total // 2**20, "MB")` }] },
    { id: "mem-pool", t: "The memory pool", sig: "cp.get_default_memory_pool() · used_bytes · total_bytes · free_all_blocks", keys: ["get_default_memory_pool", "free_all_blocks", "used_bytes", "total_bytes", "del"], body: [
      `<p>When you free a CuPy array (<code>del x</code>, or a new value for the name), its memory goes back to a pool. CuPy uses the pool again.
       Thus the free memory of the card does not increase until <code>free_all_blocks()</code>. At the end of your run, all the memory becomes free.</p>`] },
    { id: "mem-oom", t: "Out of memory", keys: ["OutOfMemoryError"], body: [
      `<p><code>cp.cuda.memory.OutOfMemoryError</code> means that the allocation does not fit. Use <code>float32</code>, or free the arrays that you do not need.
       You can also process the data in batches and keep only the totals (Guide → <i>1 GB: memory and batches</i>).</p>`] },
  ] },
  { t: "vf helpers", kids: [
    { id: "vf-show", t: "vf.show", sig: "vf.show(x, title=None)", keys: ["show"], body: [
      `<p>Shows an image in Output. The image can be a PIL image, a 2-D array (greyscale, scaled from min to max) or an (h, w, 3) array (RGB, 0–255).
       The helper copies CuPy arrays back for you. It makes images larger than 1600 px smaller.</p>`] },
    { id: "vf-plot", t: "vf.plot", sig: "vf.plot(y) · vf.plot(x, y, kind='line'|'bar'|'scatter', title=None)", keys: ["plot"], body: [
      `<p>A chart in Output. If there are more than 4,000 points, the chart keeps an equal sample of them.</p>`] },
    { id: "vf-table", t: "vf.table", sig: "vf.table(rows, columns=None)", keys: ["table"], body: [
      `<p>A table in Output from a list of lists (with optional column names) or a list of dicts. Up to 500 rows.</p>`] },
    { id: "vf-race", t: "vf.race", sig: "vf.race(fn, *args, n=3)", keys: ["race"], body: [
      `<p>Calls <code>fn(np, *args)</code> on the CPU and <code>fn(cp, *args)</code> on the card. It calls each one <code>n</code> times after a warm-up.
       Then it draws the two times and the speed-up. It returns the GPU result. Write <code>fn</code> with the array module as its first parameter (call it <code>xp</code>).</p>`] },
    { id: "vf-timeit", t: "vf.timeit", sig: "vf.timeit(fn, n=5) → ms", keys: ["timeit"], body: [
      `<p>Runs <code>fn()</code> one time to warm up. Then it runs <code>fn()</code> <code>n</code> times and synchronises the card. It returns the average in milliseconds.</p>`] },
    { id: "vf-machine", t: "vf.machine", sig: "vf.machine() → dict", keys: ["machine"], body: [
      `<p>The live data that the Machine page shows: GPU load, memory, temperature, clocks, host CPU, and the jobs that run now.</p>`,
      { code: C`import vf
m = vf.machine()
print(sorted(m.keys()))` }] },
    { id: "vf-text", t: "vf.text", sig: "search(q) · near(q, side) · generate(seed, order, n) · stats() · retrieve(q) · tokens(text) · predict(context) · pipeline(name, seed, **changes) · score(name) · compare(*names) · pipelines() · model(name, **params)", keys: ["text", "search", "near", "generate", "retrieve", "stats", "tokens", "predict", "pipeline", "compare", "BPE", "perplexity"], body: [
      `<p>Questions to the corpus in the Text Engine. The VectorFall server answers them in its GPU queue, not in your process. Each one returns a dict.
       <code>tokens</code> shows words, BPE and characters; <code>predict</code> shows each n-gram level, the neural LM and the blend for a context;
       <code>pipeline</code> writes text with a saved or built-in generation pipeline (keyword changes go on top of it); <code>compare</code> scores pipelines against real held-out text.</p>`,
      { code: C`import vf
p = vf.text.predict("I do not")
print([w["w"] for w in p["blend"]["top"][:5]], "· blend perplexity", p["scores"]["blend"])
r = vf.text.pipeline("Kneser-Ney 5-gram", seed="The sea", rs=1, sampling={"temperature": 0.9})
print(r["text"])` }] },
    { id: "vf-data", t: "vf.data", sig: "list() · load(name) → {column: values} · save(name, {column: values}) → id", keys: ["data", "load", "save", "list", "Data Desk"], body: [
      `<p>Use the Data Desk from your code, in the two directions. <code>load</code> finds a table by its id, its exact name or a part of its name.
       It gives number columns as NumPy arrays (empty cells are <code>nan</code>) and text columns as lists.
       <code>save</code> writes a new table. All the other tools can use it: anomaly watch, Simulate, the Reservoir Lab and the Planner.
       Load and save go through the server (CPU). Move the numbers to the card yourself with <code>cp.asarray</code>.</p>`,
      { code: C`import vf
tables = vf.data.list()                         # newest first
print([t["name"] for t in tables])
t = next(t for t in tables if t.get("rows") and any(isinstance(v, np.ndarray) for v in vf.data.load(t["id"]).values()))
d = vf.data.load(t["id"])                       # or vf.data.load("part of a name")
col = next(k for k, v in d.items() if isinstance(v, np.ndarray))
x = cp.asarray(d[col])                          # host -> card
x = x[~cp.isnan(x)]
print(t["name"], "·", col, "· mean", float(x.mean()), "· std", float(x.std()))
vf.plot(cp.asnumpy(x), title=col)
# vf.data.save("my result", {"value": x})       # writes a new Data Desk table (uncomment to keep a result)` }] },
  ] },
  { t: "The card", kids: [
    { id: "k420", t: "What this card is", keys: ["card", "GPU", "architecture", "compute capability"], body: [
      `<div class="cardfacts"><p class="dim">The facts about the card appear here when the server answers.</p></div>
       <p>Good for: the same small calculation on millions of values, for example images, fractals, sound, random walks and matrix products.
       Bad for: one long chain of steps where each step needs the last one, or work that copies data back and forth all the time.</p>`] },
  ] },
];

export function refLeaves(nodes = REF, path = []) {
  const out = [];
  for (const n of nodes) {
    if (n.kids) out.push(...refLeaves(n.kids, path.concat(n.t)));
    else out.push({ ...n, path });
  }
  return out;
}
