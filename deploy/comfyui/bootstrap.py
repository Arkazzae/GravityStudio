"""Keep startup offline; models are supplied through the shared model volume."""
import os
from pathlib import Path
import sys

for directory in ("input", "output", "temp", "user"):
    Path("/data", directory).mkdir(parents=True, exist_ok=True)
arguments = [
    "main.py", "--listen", "0.0.0.0", "--port", "8188",
    "--models-directory", "/models", "--input-directory", "/data/input",
    "--output-directory", "/data/output", "--temp-directory", "/data/temp",
    "--user-directory", "/data/user", "--disable-auto-launch", "--offline",
    "--disable-all-custom-nodes", "--preview-method", "none",
    "--reserve-vram", os.environ.get("GRAVITY_RESERVE_VRAM_GIB", "2"),
]
os.execv(sys.executable, [sys.executable, *arguments, *sys.argv[1:]])
