"""Fetch the immutable upstream source and verify bytes before extraction."""
import hashlib
import io
from pathlib import Path
import re
import sys
import tarfile
import urllib.request

commit, expected = sys.argv[1:]
if not re.fullmatch(r"[a-f0-9]{40}", commit) or not re.fullmatch(r"[a-f0-9]{64}", expected):
    raise SystemExit("A full source commit and SHA-256 are required")
with urllib.request.urlopen(f"https://codeload.github.com/Comfy-Org/ComfyUI/tar.gz/{commit}", timeout=60) as response:
    source = response.read(100 * 1024 * 1024 + 1)
if len(source) > 100 * 1024 * 1024 or hashlib.sha256(source).hexdigest() != expected:
    raise SystemExit("ComfyUI source archive failed verification")
destination = Path("/opt/ComfyUI")
destination.mkdir(parents=True, exist_ok=True)
prefix = f"ComfyUI-{commit}/"
with tarfile.open(fileobj=io.BytesIO(source), mode="r:gz") as archive:
    for member in archive.getmembers():
        if not member.name.startswith(prefix):
            continue
        member.name = member.name[len(prefix):]
        if not member.name:
            continue
        if member.issym() or member.islnk():
            raise SystemExit("Source archive contains an unexpected link")
        archive.extract(member, destination, filter="data")
