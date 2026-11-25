#!/usr/bin/env bash
# VectorFall installer for Linux: from a computer with an NVIDIA card to a running VectorFall server.
#
#   bash install.sh                       install (run it again to repair or change settings; the data stays)
#   bash install.sh --yes --gpu 0         no questions: card 0
#   bash install.sh --uninstall [--purge] remove the container (--purge: also the image and the data)
#
# Steps: 1. check Linux, Python 3 and the container engine (Docker or Podman); 2. check the NVIDIA driver and the
# GPU access for containers (NVIDIA Container Toolkit for Docker, a CDI spec for Podman); 3. write the settings
# (.env) and choose the card; 4. get the image (or build it with --build); 5. check that the card is visible in a
# container; 6. start the server, wait until it answers and show the address.
# The installer does not use sudo. When something is missing, it tells you the command to run.
# Copyright (c) 2026 Amir Husain. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0.
set -euo pipefail

VF_VERSION="0.1.0"
DIR="${VF_HOME:-$HOME/vectorfall}"
IMAGE="${VF_IMAGE:-ghcr.io/ahtx/vectorfall:${VF_VERSION}}"
RAW="${VF_RAW:-https://raw.githubusercontent.com/ahtx/vectorfall/v${VF_VERSION}}"
ENGINE=""
GPU=""
PORT=""
TLS_PORT=""
LAN=0
BUILD=""
YES=0
START=1
PULL=0
MODE=install
PURGE=0
BIN=""
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo .)"

usage() {
  cat <<EOF
VectorFall ${VF_VERSION} installer

  install.sh [options]                 install, repair or change settings
  install.sh --uninstall [--purge]     remove the container (--purge: the image and the data folder too)

Options:
  --dir D          the VectorFall folder: settings, data, vfctl (default ${DIR})
  --engine E       docker or podman (default: the one that works, Docker first)
  --gpu G          the card: an index or a UUID from nvidia-smi -L (default: ask; with --yes the only card,
                   else the smallest idle card)
  --port P         the web interface and API port (default 8092)
  --tls-port P     the HTTPS port (default 8493)
  --lan            serve the local network too (default: this computer only)
  --image I        the image (default ${IMAGE})
  --build [SRC]    build the image from a source folder (default: the folder of this script) instead of pulling it
  --pull           get the image again even when it is already here (an update)
  --bin D          where to put the vfctl command (default ~/.local/bin, or /usr/local/bin as root)
  --no-start       write the settings and get the image, but do not start the server
  --yes, -y        no questions (for scripts)
  --uninstall      remove VectorFall (see above); --purge also removes the image and ${DIR}
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift ;;
    --engine) ENGINE="$2"; shift ;;
    --gpu) GPU="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --tls-port) TLS_PORT="$2"; shift ;;
    --lan) LAN=1 ;;
    --image) IMAGE="$2"; shift ;;
    --build) if [ $# -gt 1 ] && [ "${2#--}" = "$2" ]; then BUILD="$2"; shift; else BUILD="$SRC"; fi ;;
    --pull) PULL=1 ;;
    --bin) BIN="$2"; shift ;;
    --no-start) START=0 ;;
    --yes|-y) YES=1 ;;
    --uninstall) MODE=uninstall ;;
    --purge) PURGE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install.sh: unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '  %sOK%s    %s\n' "$G" "$N" "$*"; }
warn() { printf '  %sWARN%s  %s\n' "$Y" "$N" "$*"; }
fail() { printf '  %sFAIL%s  %s\n' "$R" "$N" "$1"; shift; for l in "$@"; do printf '        %s\n' "$l"; done; exit 1; }
TTY_IN=""; if [ "$YES" = 0 ] && [ -r /dev/tty ] && { true </dev/tty; } 2>/dev/null; then TTY_IN=/dev/tty; fi
ask() { # ask "question" default -> REPLY
  if [ -z "$TTY_IN" ]; then REPLY="$2"; return; fi
  read -r -p "  $1 [$2] " REPLY <"$TTY_IN" || REPLY=""; REPLY="${REPLY:-$2}"
}
if [ -z "$BIN" ]; then if [ "$(id -u)" = 0 ]; then BIN=/usr/local/bin; else BIN="$HOME/.local/bin"; fi; fi
DIR="$(mkdir -p "$DIR" && cd "$DIR" && pwd)"

vfctl() { VF_HOME="$DIR" python3 "$DIR/vfctl" "$@"; }

# ---------------------------------------------------------------- uninstall
if [ "$MODE" = uninstall ]; then
  step "Removing VectorFall from $DIR"
  if [ -f "$DIR/vfctl" ] && [ -f "$DIR/.env" ]; then
    if [ "$PURGE" = 1 ]; then vfctl uninstall --yes --purge; else vfctl uninstall --yes; fi
  else
    warn "no VectorFall settings in $DIR"
  fi
  if [ -L "$BIN/vfctl" ] || [ -f "$BIN/vfctl" ]; then rm -f "$BIN/vfctl"; ok "removed $BIN/vfctl"; fi
  if [ "$PURGE" = 1 ]; then
    if rm -rf "$DIR" 2>/dev/null; then ok "removed $DIR"; else warn "some files in $DIR belong to root; remove them with: sudo rm -rf $DIR"; fi
  fi
  exit 0
fi

# ---------------------------------------------------------------- 1. the computer and the container engine
step "1. Checking the computer"
[ "$(uname -s)" = Linux ] || fail "VectorFall installs on Linux." "On Windows, use Docker Desktop with WSL2: see docs/INSTALL.md."
[ "$(uname -m)" = x86_64 ] || fail "VectorFall needs an x86-64 computer (this one is $(uname -m))."
ok "Linux $(uname -r), x86-64"
command -v python3 >/dev/null || fail "Python 3 is not installed (vfctl needs it)." \
  "Debian/Ubuntu: sudo apt install python3     Fedora/RHEL: sudo dnf install python3"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 1)' || fail "vfctl needs Python 3.6 or later."
ok "$(python3 --version 2>&1)"

engine_ok() { command -v "$1" >/dev/null && "$1" info >/dev/null 2>&1; }
if [ -z "$ENGINE" ] && [ -f "$DIR/.env" ]; then ENGINE="$(sed -n 's/^VF_ENGINE=//p' "$DIR/.env" | tail -1)"; fi
if [ -n "$ENGINE" ]; then
  engine_ok "$ENGINE" || {
    if command -v "$ENGINE" >/dev/null && "$ENGINE" info 2>&1 | grep -qi "permission denied"; then
      fail "$ENGINE refuses this user." "sudo usermod -aG docker \$USER   then log out and in (or run this script with sudo)"
    fi
    fail "$ENGINE does not answer." "Start it (sudo systemctl start $ENGINE) or choose the other engine with --engine."; }
elif engine_ok docker; then ENGINE=docker
elif engine_ok podman; then ENGINE=podman
elif command -v docker >/dev/null && docker info 2>&1 | grep -qi "permission denied"; then
  fail "Docker refuses this user." "sudo usermod -aG docker \$USER   then log out and in (or run this script with sudo)"
else
  fail "Neither Docker nor Podman is installed and running." \
    "Docker: https://docs.docker.com/engine/install/   Podman: sudo apt install podman (or dnf install podman)"
fi
ok "container engine: $ENGINE ($($ENGINE --version 2>/dev/null | head -1))"

# ---------------------------------------------------------------- 2. the driver and the GPU access
step "2. Checking the NVIDIA driver and the GPU access"
if ! nvidia-smi -L >/dev/null 2>&1; then
  hint="Install the NVIDIA driver, then run this script again."
  if command -v lspci >/dev/null && lspci -nn | grep -E "VGA|3D controller" | grep -q "10de:"; then
    hint="An NVIDIA card is on the bus, but the driver does not answer. Kepler cards (GTX 600/700, Quadro K) need driver 470 (Ubuntu: sudo apt install nvidia-driver-470). Later cards: a current driver."
  fi
  fail "nvidia-smi does not answer." "$hint"
fi
DRIVER="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)"
ok "NVIDIA driver $DRIVER"
nvidia-smi -L | sed 's/^/        /'
if command -v lspci >/dev/null; then
  ON_BUS=$(lspci -nn | grep -E "VGA|3D controller|Display" | grep -c "10de:" || true)
  DRIVEN=$(nvidia-smi -L | grep -c "^GPU" || true)
  if [ "$ON_BUS" -gt "$DRIVEN" ]; then
    warn "$ON_BUS NVIDIA cards on the bus, $DRIVEN driven. Drivers after 470 do not support Kepler cards."
  fi
fi

if [ "$ENGINE" = docker ]; then
  if command -v nvidia-ctk >/dev/null || command -v nvidia-container-cli >/dev/null || command -v nvidia-container-runtime-hook >/dev/null; then
    ok "NVIDIA Container Toolkit"
  else
    fail "The NVIDIA Container Toolkit is not installed (Docker needs it to give the card to a container)." \
      "Install it: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html" \
      "Then: sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker"
  fi
else
  CDI="$( (nvidia-ctk cdi list 2>/dev/null || true; cat /etc/cdi/*.yaml /var/run/cdi/*.yaml 2>/dev/null || true) | grep -o 'nvidia.com/gpu=[^ ]*\|name: *"\?GPU-[0-9a-f-]*' || true)"
  if [ -z "$CDI" ]; then
    command -v nvidia-ctk >/dev/null || fail "The NVIDIA Container Toolkit is not installed (Podman needs its nvidia-ctk to make the CDI spec)." \
      "Install it: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html"
    fail "No CDI spec for the NVIDIA cards (Podman finds the cards through it)." \
      "sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml   (again after each driver change)"
  fi
  ok "CDI spec for the NVIDIA cards"
fi

# ---------------------------------------------------------------- 3. settings and the card
step "3. Settings in $DIR"
fetch() { # fetch NAME: from the source folder of this script, else from the release on GitHub
  if [ -f "$SRC/$1" ]; then
    [ "$SRC/$1" -ef "$DIR/$1" ] || cp "$SRC/$1" "$DIR/$1"
  else
    curl -fsSL "$RAW/$1" -o "$DIR/$1.tmp" || fail "could not download $RAW/$1"
    mv "$DIR/$1.tmp" "$DIR/$1"
  fi
}
for f in vfctl compose.yaml compose.podman.yaml .env.example; do fetch "$f"; done
chmod +x "$DIR/vfctl"
if [ -f "$DIR/.env" ]; then ok "keeping the settings in $DIR/.env"; else cp "$DIR/.env.example" "$DIR/.env"; ok "new settings: $DIR/.env"; fi
set_env() { # set_env KEY VALUE (keeps the other lines)
  if grep -q "^$1=" "$DIR/.env"; then sed -i "s|^$1=.*|$1=$2|" "$DIR/.env"; else printf '%s=%s\n' "$1" "$2" >>"$DIR/.env"; fi
}
get_env() { sed -n "s/^$1=//p" "$DIR/.env" | tail -1; }
set_env VF_ENGINE "$ENGINE"
set_env VF_IMAGE "$IMAGE"
[ -n "$PORT" ] && set_env VF_PORT "$PORT"
[ -n "$TLS_PORT" ] && set_env VF_TLS_PORT "$TLS_PORT"
if [ "$LAN" = 1 ]; then
  set_env VF_BIND 0.0.0.0
  IP="$(ip -4 route get 192.0.2.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)"
  set_env VF_TLS_HOSTS "localhost,127.0.0.1,$(hostname)${IP:+,$IP}"
  warn "serving the local network: everyone on it can use VectorFall (the Console only from private addresses)"
fi
set_env VF_URL "http://localhost:$(get_env VF_PORT)"
set_env VECTORFALL_URL "http://localhost:$(get_env VF_PORT)"

CUR="$(get_env VF_GPU)"
if [ -n "$GPU" ]; then
  vfctl gpu select "$GPU" >/dev/null || fail "no such card: $GPU (nvidia-smi -L lists the cards)"
elif [ -n "$CUR" ] && nvidia-smi -L | grep -q "$CUR" && [ "$CUR" != 0 ]; then
  : # keep the card that is already chosen
elif [ -n "$TTY_IN" ] && [ "$(nvidia-smi -L | grep -c '^GPU')" -gt 1 ]; then
  vfctl gpu select <"$TTY_IN"
else
  vfctl gpu select --yes >/dev/null
fi
GPU_UUID="$(get_env VF_GPU)"
ok "card: $(nvidia-smi -L | grep "$GPU_UUID" | sed 's/ (UUID.*//')  ($GPU_UUID)"

# ---------------------------------------------------------------- 4. the image
step "4. The image $IMAGE"
if [ -n "$BUILD" ]; then
  [ -f "$BUILD/Dockerfile" ] || fail "no Dockerfile in $BUILD"
  echo "  Building from $BUILD (the CUDA 10.2 download is 2.5 GB; the first build takes 10 to 30 minutes) ..."
  "$ENGINE" build -t "$IMAGE" --build-arg VF_VERSION="$(cat "$BUILD/VERSION" 2>/dev/null || echo dev)" "$BUILD"
  set_env VF_SOURCE "$BUILD"
elif [ "$PULL" = 1 ] || ! "$ENGINE" image inspect "$IMAGE" >/dev/null 2>&1; then
  "$ENGINE" pull "$IMAGE" || fail "could not get $IMAGE." "Check the network, or build it from the source: install.sh --build <source folder>"
fi
ok "$IMAGE is here"

# ---------------------------------------------------------------- 5. the card in a container
step "5. Checking that a container can use the card"
if [ "$ENGINE" = podman ]; then GPUARG=(--device "nvidia.com/gpu=$GPU_UUID" --security-opt label=disable); else GPUARG=(--gpus "device=$GPU_UUID"); fi
if OUT="$("$ENGINE" run --rm "${GPUARG[@]}" -e NVIDIA_DRIVER_CAPABILITIES=compute,utility --entrypoint nvidia-smi "$IMAGE" -L 2>&1)" && grep -q "$GPU_UUID" <<<"$OUT"; then
  ok "$(grep "$GPU_UUID" <<<"$OUT" | sed 's/ (UUID.*//')"
else
  if [ "$ENGINE" = podman ]; then
    fail "Podman could not give the card to a container:" "$(tail -3 <<<"$OUT")" \
      "sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml   then run this script again"
  else
    fail "Docker could not give the card to a container:" "$(tail -3 <<<"$OUT")" \
      "sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker   then run this script again"
  fi
fi

# ---------------------------------------------------------------- 6. vfctl and the server
step "6. vfctl and the server"
mkdir -p "$BIN"
cat >"$BIN/vfctl" <<EOF
#!/bin/sh
# VectorFall control (installed by install.sh)
VF_HOME="\${VF_HOME:-$DIR}" exec python3 "$DIR/vfctl" "\$@"
EOF
chmod +x "$BIN/vfctl"
ok "vfctl is $BIN/vfctl"
case ":$PATH:" in *":$BIN:"*) ;; *) warn "$BIN is not on your PATH. Add it: echo 'export PATH=\"$BIN:\$PATH\"' >> ~/.bashrc" ;; esac
if [ "$START" = 1 ]; then
  vfctl start
  printf '\n%sVectorFall is ready.%s Open the address above in a browser.\n' "$G" "$N"
  echo "  vfctl status    vfctl doctor    vfctl logs -f    vfctl help"
else
  echo "  Not started (--no-start). Start it with: vfctl start"
fi
