# Install VectorFall

This page tells you how to install VectorFall on Linux with Docker or Podman, and on Windows with Docker Desktop and
WSL2. It also tells you how to install it without the installer.

## Before you start

You need these items:

1. A Linux computer with an x86-64 processor.
2. An NVIDIA card and its driver. A Kepler card (GTX 600/700, Quadro K) needs driver 470. Other cards need driver
   440.33 or later. See the card table in the [README](../README.md#supported-cards).
3. Docker with the NVIDIA Container Toolkit, or Podman with an NVIDIA CDI spec.
4. Python 3.6 or later (for `vfctl`).

Do a check of the driver:

```sh
nvidia-smi -L
```

The command must show your card. If it shows an error, install the driver first.

## Install with the installer

```sh
curl -fsSLO https://raw.githubusercontent.com/ahtx/vectorfall/v0.1.0/install.sh
bash install.sh
```

The installer does these steps. Each step shows OK, WARN or FAIL. A FAIL shows the command that repairs the problem.

| Step | What the installer does |
| --- | --- |
| 1. The computer | Checks Linux, x86-64, Python 3, and the container engine (Docker first, then Podman). |
| 2. The driver and the GPU access | Checks `nvidia-smi`. For Docker, checks the NVIDIA Container Toolkit. For Podman, checks the CDI spec. |
| 3. Settings | Makes the VectorFall folder (default `~/vectorfall`) with `.env`, `vfctl` and the compose files. Asks which card to use. |
| 4. The image | Gets `ghcr.io/ahtx/vectorfall:0.1.0`, or builds it with `--build`. |
| 5. The card in a container | Starts a test container and checks that it sees the card. |
| 6. The server | Puts the `vfctl` command in `~/.local/bin`, starts the server, waits until it answers and shows the address. |

The installer does not use `sudo`. When it needs a change that needs `sudo`, it shows the command, and you run it.
Run the installer again at any time. It keeps your settings and your data. It changes only what you tell it to change.

### Installer options

| Option | What it does |
| --- | --- |
| `--dir D` | The VectorFall folder (default `~/vectorfall`) |
| `--engine docker` or `--engine podman` | The container engine (default: the engine that works, Docker first) |
| `--gpu G` | The card: an index or a UUID from `nvidia-smi -L` |
| `--port P`, `--tls-port P` | The HTTP port (default 8092) and the HTTPS port (default 8493) |
| `--lan` | Also serve the local network. The default is this computer only. |
| `--build [SRC]` | Build the image from a source folder, not from the registry |
| `--pull` | Get the image again (an update) |
| `--bin D` | The folder for the `vfctl` command (default `~/.local/bin`, or `/usr/local/bin` for root) |
| `--no-start` | Do not start the server |
| `--yes` | Ask no questions. Use this in scripts. |
| `--uninstall [--purge]` | Remove the container. `--purge` also removes the image and the VectorFall folder. |

Example for a script, with card 1 on the local network:

```sh
bash install.sh --yes --gpu 1 --lan
```

### Which card the installer chooses

When the computer has one card, the installer uses it. When the computer has more cards, the installer asks. With
`--yes`, it chooses the smallest card that no other program uses, so that the larger cards stay free for other work.
To change the card later, run `vfctl gpu select`.

## Repair the GPU access

### Docker: the NVIDIA Container Toolkit

Install the toolkit with the steps in the
[NVIDIA install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html). Then
connect it to Docker:

```sh
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

### Podman: the CDI spec

Podman finds the cards through a CDI spec. Make the spec after you install the toolkit, and make it again after
each driver change:

```sh
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
nvidia-ctk cdi list
```

The list shows `nvidia.com/gpu=0`, `nvidia.com/gpu=GPU-...` (one line for each card) and `nvidia.com/gpu=all`.
VectorFall uses the UUID name. On a computer with SELinux, VectorFall starts the container with
`--security-opt label=disable`, so that the container can open the card.

### Docker refuses your user

Add your user to the `docker` group, then log out and log in again:

```sh
sudo usermod -aG docker $USER
```

## Install without the installer

You can use Docker Compose or Podman Compose with the same `.env` file.

1. Get the files:

   ```sh
   mkdir ~/vectorfall && cd ~/vectorfall
   for f in compose.yaml compose.podman.yaml .env.example vfctl; do
     curl -fsSLO https://raw.githubusercontent.com/ahtx/vectorfall/v0.1.0/$f
   done
   cp .env.example .env
   ```

2. Find the UUID of your card with `nvidia-smi -L`. Write it in `.env` as `VF_GPU=GPU-...`.
3. Start the server.

   With Docker:

   ```sh
   docker compose up -d
   ```

   With Podman:

   ```sh
   podman-compose -f compose.podman.yaml up -d
   ```

4. Open `http://localhost:8092`.

Docker Compose gives the card to the container with a device reservation. Podman Compose uses the CDI name
`nvidia.com/gpu=<UUID>`. `vfctl` can manage a container that compose made, because the container has the same name.

## Windows: Docker Desktop and WSL2

VectorFall runs on Windows 10 (21H2 or later) and Windows 11 in Docker Desktop with the WSL2 back end. You do not
need the Linux installer.

1. Install the current NVIDIA Windows driver from nvidia.com. Do not install a Linux NVIDIA driver in WSL2. The
   Windows driver serves WSL2.
2. Install [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) and select the WSL2 back
   end.
3. Do a check of the GPU access in PowerShell:

   ```powershell
   docker run --rm --gpus all ubuntu:22.04 nvidia-smi -L
   ```

4. Start VectorFall in PowerShell. Use the UUID from step 3:

   ```powershell
   docker run -d --name vectorfall --restart unless-stopped --gpus "device=GPU-..." `
     -p 127.0.0.1:8092:8092 -p 127.0.0.1:8493:8493 -v vectorfall-data:/srv/data `
     ghcr.io/ahtx/vectorfall:0.1.0
   ```

5. Open `http://localhost:8092`.

The data is in the Docker volume `vectorfall-data`. `vfctl` also runs in a WSL2 Linux distribution that uses Docker
Desktop. We did not test Kepler cards in WSL2.

## After the install

| Command | What it does |
| --- | --- |
| `vfctl status` | Shows the container, the card, the version, the address and the running jobs |
| `vfctl doctor` | Checks the installation and shows a fix for each problem |
| `vfctl url` | Shows the addresses of the web interface, the API and MCP |
| `vfctl update` | Gets the new image and restarts the server. Your data stays. |
| `vfctl backup` | Saves the data folder to a `.tar.gz` file |

See [VFCTL.md](VFCTL.md) for all the commands.

## Remove VectorFall

```sh
bash install.sh --uninstall           # removes the container; the data and the image stay
bash install.sh --uninstall --purge   # also removes the image and the VectorFall folder with the data
```
