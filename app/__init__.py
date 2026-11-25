import os as _os
# numpy 1.19's bundled OpenBLAS (0.3.13) can deadlock into a busy spin when several threads call it at once
# (seen: the GPU worker stuck forever in np.linalg.svd while request threads did numpy maths). One BLAS thread per
# caller removes the shared pool — and on this 2-core host GPU work should not fan host maths across both cores.
for _v in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    _os.environ.setdefault(_v, "1")
