# vfctl

`vfctl` starts, stops and checks a VectorFall server on this computer. It works with Docker and with Podman. The
installer puts it in `~/.local/bin`. It is one Python file. It needs Python 3.6 or later and no other packages.

`vfctl` reads the settings from the `.env` file of the VectorFall folder. The folder is `$VF_HOME`, or the folder
that the installer used (default `~/vectorfall`).

## Commands

| Command | What it does |
| --- | --- |
| `vfctl start` | Starts the server. It makes the container when the container does not exist. It waits until the server answers, then shows the address. `--no-wait` does not wait. |
| `vfctl stop` | Stops the server. |
| `vfctl restart` | Restarts the server. When `.env` or the image changed, it makes the container again. The data stays. |
| `vfctl status` | Shows the folder, the engine, the image, the card, the container state and uptime, the server version, the card that the server found, the running jobs and the address. The exit code is 0 when the server answers. |
| `vfctl logs [-f] [-n N]` | Shows the last N lines of the server log (default 200). `-f` follows the log. |
| `vfctl doctor [--quick]` | Checks the installation. See below. `--quick` does not run `vf test`. |
| `vfctl gpu` | Lists the NVIDIA cards and marks the card that VectorFall uses. |
| `vfctl gpu select [N or UUID]` | Chooses the card. Without a value, it asks. When the server runs, it restarts the server on the new card. |
| `vfctl url` | Shows the addresses of the web interface, HTTPS, the API, MCP and the CLI. |
| `vfctl update` | Gets the image again and makes the container again. The data stays. |
| `vfctl update --build DIR` | Builds the image from the source folder DIR, then makes the container again. |
| `vfctl backup [FILE]` | Saves the data folder to FILE (default `backups/vectorfall-data-<date>.tar.gz`). It stops the server during the copy and starts it again. `--live` does not stop the server. |
| `vfctl restore FILE` | Puts back a backup. It keeps the current data folder beside it as `data.before-restore-<date>`. |
| `vfctl uninstall [--purge]` | Removes the container. `--purge` also removes the image and the data folder. `--yes` asks no questions. |
| `vfctl version` | Shows the vfctl version and the server version. |

## Doctor

`vfctl doctor` does these checks. Each line shows PASS, WARN or FAIL. A WARN or a FAIL line also shows a fix.

| Check | PASS when |
| --- | --- |
| Container engine | `docker info` or `podman info` answers. |
| NVIDIA driver | `nvidia-smi` answers. A WARN shows when the bus has more NVIDIA cards than the driver serves (a Kepler card with a driver after 470). |
| GPU access | Docker: the NVIDIA Container Toolkit is installed. Podman: the CDI spec lists the card. |
| The card | The card in `VF_GPU` is on this computer. |
| Disk | The data folder has 5 GB free or more (WARN under 5 GB, FAIL under 1 GB). |
| Ports | When there is no container: the HTTP and HTTPS ports are free. |
| Container | The container runs and uses the current settings. |
| Card in the container | `nvidia-smi -L` in the container shows the card. |
| Server | `/api/version` answers. |
| Card detection | `/api/machine` shows the card, its architecture and its cores. |
| HTTPS | The HTTPS port answers. The line shows the end date of the certificate, and a WARN when the certificate does not cover a name in `VF_TLS_HOSTS`. |
| GPU self-test | A 512 x 512 matrix product on the card agrees with the CPU result. |
| `vf test` | Every model that does not change stored data runs with its example inputs. A model that refuses its test inputs is not a failure. A model that needs an optional part that is not installed (a model file or a module) gives a WARN. |

The exit code is 1 when one or more checks fail. Send the output of `vfctl doctor` with a bug report.

## Settings that vfctl uses

| Key | What it is |
| --- | --- |
| `VF_ENGINE` | `docker` or `podman` |
| `VF_IMAGE` | The image |
| `VF_NAME` | The container name (default `vectorfall`) |
| `VF_GPU` | The card UUID |
| `VF_BIND`, `VF_PORT`, `VF_TLS_PORT` | The listen address and the ports |
| `VF_DATA` | The data folder |

`vfctl` gives every other `VF_*` key in `.env` to the server.

## How vfctl starts the container

With Docker, `vfctl` uses `docker run --gpus device=<UUID>`. With Podman, it uses
`podman run --device nvidia.com/gpu=<UUID> --security-opt label=disable`. Both mount the data folder at
`/srv/data` and use the restart policy `unless-stopped`. The container has a label with a hash of the settings.
When the hash changes, `vfctl start` makes the container again.

The files in the data folder belong to the root user of the container. `vfctl backup`, `vfctl restore` and
`vfctl uninstall --purge` use a short container of the VectorFall image to read and write them. They do not need
`sudo`.
