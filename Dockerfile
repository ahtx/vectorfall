# syntax=docker/dockerfile:1
# VectorFall image for NVIDIA cards, from Kepler (sm_30) to Blackwell. It builds from public sources only.
#
# CUDA 10.2 is the last toolkit with Kepler sm_30 support, and CuPy 9.6 is the last CuPy built for it. Later cards
# run the same kernels: CuPy compiles them at run time with NVRTC, and the driver JIT-compiles the PTX for the card.
# The host needs the NVIDIA driver (470 for Kepler) and the NVIDIA Container Toolkit (Docker) or a CDI spec (Podman).
#
#   docker build -t ghcr.io/ahtx/vectorfall:0.1.0 \
#       --build-arg VF_VERSION=$(cat VERSION) --build-arg VF_REVISION=$(git rev-parse --short HEAD) .
#
# NVIDIA removed the CUDA 10.2 images from Docker Hub. This file installs the toolkit from NVIDIA's runfile into a
# plain Ubuntu 18.04 image. The base image is pinned by digest and the runfile by sha256, so a rebuild gives the
# same toolchain.
FROM ubuntu:18.04@sha256:152dc042452c496007f07ca9127571cb9c29697f42acbfad72324b2bb2e43c98

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates libxml2 openssl \
        python3 python3-pip ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# CUDA 10.2 toolkit: the runtime libraries that CuPy loads (cuBLAS, cuFFT, cuRAND, cuSOLVER, cuSPARSE, NVRTC) and
# the headers. The static libraries, NPP, nvJPEG, the samples and the tools are removed in the same layer.
ARG CUDA_RUN=cuda_10.2.89_440.33.01_linux.run
ARG CUDA_SHA256=560d07fdcf4a46717f2242948cd4f92c5f9b6fc7eae10dd996614da913d5ca11
RUN wget -q --tries=5 --timeout=30 https://developer.download.nvidia.com/compute/cuda/10.2/Prod/local_installers/${CUDA_RUN} \
    && echo "${CUDA_SHA256}  ${CUDA_RUN}" | sha256sum -c - \
    && sh ${CUDA_RUN} --silent --toolkit --no-opengl-libs --override \
    && rm -f ${CUDA_RUN} \
    && rm -rf /usr/local/cuda-10.2/doc /usr/local/cuda-10.2/samples /usr/local/cuda-10.2/nsight* \
              /usr/local/cuda-10.2/libnsight /usr/local/cuda-10.2/libnvvp /usr/local/cuda-10.2/extras \
    && rm -f /usr/local/cuda-10.2/lib64/*.a /usr/local/cuda-10.2/lib64/libnpp* /usr/local/cuda-10.2/lib64/libnvjpeg*
ENV PATH=/usr/local/cuda-10.2/bin:$PATH \
    LD_LIBRARY_PATH=/usr/local/cuda-10.2/lib64 \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 PYTHONUNBUFFERED=1

# Python 3.6 stack (the versions are verified on the K420, K1200 and GTX 1080). CuPy's fastrlock dependency builds
# from source on Python 3.6, so gcc and python3-dev are needed for this step only.
RUN apt-get update && apt-get install -y --no-install-recommends gcc python3-dev \
    && python3 -m pip install --no-cache-dir --upgrade "pip<21.4" "setuptools<60" \
    && python3 -m pip install --no-cache-dir "numpy==1.19.5" "fastrlock==0.8.3" "cupy-cuda102==9.6.0" "scipy==1.5.4" \
       "fastapi==0.79.1" "uvicorn==0.16.0" "pydantic==1.9.2" "python-multipart==0.0.5" "pillow==8.4.0" \
       "aiofiles==0.8.0" "websockets==9.1" \
       "pdfminer.six==20211012" "python-docx==0.8.11" "python-pptx==0.6.21" "openpyxl==3.0.10" "XlsxWriter==3.2.2" \
    && apt-get purge -y gcc python3-dev && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* /root/.cache

# OPENBLAS_NUM_THREADS=1: numpy 1.19's OpenBLAS can deadlock when several threads call it at once.
ENV CUPY_CACHE_DIR=/srv/data/cupy_cache CUDA_CACHE_PATH=/srv/data/cuda_cache CUDA_CACHE_MAXSIZE=536870912 \
    OPENBLAS_NUM_THREADS=1 VF_DATA=/srv/data
WORKDIR /srv
COPY VERSION ./VERSION
COPY app ./app
COPY ui ./ui
# the vf command-line client, inside the container too (docker exec vectorfall vf list)
RUN chmod +x app/vf_cli.py && ln -sf /srv/app/vf_cli.py /usr/local/bin/vf && mkdir -p /srv/data

ARG VF_VERSION=dev
ARG VF_REVISION=unknown
ENV VF_REVISION=${VF_REVISION}
LABEL org.opencontainers.image.title="VectorFall" \
      org.opencontainers.image.description="VectorFall: personal supercomputing. A GPU algorithms lab for you and your AI agents, on NVIDIA cards from Kepler on (CUDA 10.2)." \
      org.opencontainers.image.source="https://github.com/ahtx/vectorfall" \
      org.opencontainers.image.url="https://amirhusain.com/vectorfall" \
      org.opencontainers.image.documentation="https://github.com/ahtx/vectorfall/blob/main/docs/INSTALL.md" \
      org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0" \
      org.opencontainers.image.vendor="Amir Husain" \
      org.opencontainers.image.version="${VF_VERSION}" \
      org.opencontainers.image.revision="${VF_REVISION}" \
      org.opencontainers.image.base.name="docker.io/library/ubuntu:18.04"

VOLUME ["/srv/data"]
EXPOSE 8092 8493
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python3 -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:8092/api/version', timeout=8); sys.exit(0)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8092", "--no-access-log"]
