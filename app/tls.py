"""HTTPS on port 8493, so browsers allow the microphone and camera (they refuse both on plain http from a LAN address).

A self-signed certificate is made once in /srv/data/run/tls/ for the names and addresses in VF_TLS_HOSTS
(comma-separated; default localhost,127.0.0.1). The browser warns the first time, you accept it, and from then on
https://<host>:8493 is the same app with mic/camera access. Delete the files in that folder to make a new
certificate after you change VF_TLS_HOSTS. TLS is terminated here and the bytes are piped to the normal server on 8092 -- websockets included.
"""
import asyncio
import ipaddress
import os
import ssl
import subprocess

DIR = "/srv/data/run/tls"
PORT = 8493
UPSTREAM = ("127.0.0.1", 8092)


def _san():
    """subjectAltName entries for the certificate, from VF_TLS_HOSTS."""
    out = []
    for h in (os.environ.get("VF_TLS_HOSTS") or "localhost,127.0.0.1").split(","):
        h = h.strip()
        if not h:
            continue
        try:
            ipaddress.ip_address(h)
            out.append("IP:" + h)
        except ValueError:
            out.append("DNS:" + h)
    return ",".join(out)


def _cert():
    os.makedirs(DIR, exist_ok=True)
    crt, key = os.path.join(DIR, "vectorfall.crt"), os.path.join(DIR, "vectorfall.key")
    if not (os.path.exists(crt) and os.path.exists(key)):
        cfg = os.path.join(DIR, "openssl.cnf")
        with open(cfg, "w") as f:
            f.write("[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=VectorFall\n"
                    "[ext]\nsubjectAltName=" + _san() + "\n"
                    "basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650", "-keyout", key,
                        "-out", crt, "-config", cfg], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return crt, key


async def _pipe(r, w):
    try:
        while True:
            b = await r.read(65536)
            if not b:
                break
            w.write(b)
            await w.drain()
    except Exception:  # noqa: BLE001
        pass
    finally:
        try:
            w.close()
        except Exception:  # noqa: BLE001
            pass


async def _client(cr, cw):
    try:
        ur, uw = await asyncio.open_connection(*UPSTREAM)
    except Exception:  # noqa: BLE001
        cw.close()
        return
    await asyncio.gather(_pipe(cr, uw), _pipe(ur, cw))


async def start():
    try:
        crt, key = _cert()
        ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        ctx.load_cert_chain(crt, key)
        await asyncio.start_server(_client, "0.0.0.0", PORT, ssl=ctx)
        print("VECTORFALL https on :{}".format(PORT), flush=True)
    except Exception as e:  # noqa: BLE001
        print("VECTORFALL https disabled:", e, flush=True)
