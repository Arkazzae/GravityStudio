"""Small real GPU operations; a passing result verifies this runtime, not a model."""
import ctypes
from datetime import datetime, timezone
import json
import os
import subprocess
import sys


def pci_address(index, hip):
    if not hip:
        return None
    library = ctypes.CDLL("libamdhip64.so")
    buffer = ctypes.create_string_buffer(32)
    function = library.hipDeviceGetPCIBusId
    function.argtypes = [ctypes.c_char_p, ctypes.c_int, ctypes.c_int]
    function.restype = ctypes.c_int
    if function(buffer, len(buffer), index) != 0:
        raise RuntimeError("HIP did not report the selected physical GPU")
    return buffer.value.decode().lower()


result = {"schemaVersion": 1, "passed": False, "verifiedAt": datetime.now(timezone.utc).isoformat(),
          "runtime": {"revision": os.environ.get("GRAVITY_RUNTIME_REVISION"),
                      "profileId": os.environ.get("GRAVITY_RUNTIME_PROFILE_ID"),
                      "comfyCommit": os.environ.get("GRAVITY_COMFY_COMMIT")}, "devices": []}
try:
    import torch
    import torch.nn.functional as functional

    result["runtime"].update(torchVersion=torch.__version__, cudaVersion=torch.version.cuda, hipVersion=torch.version.hip)
    if not torch.cuda.is_available() or torch.cuda.device_count() != 1:
        raise RuntimeError("A single-GPU worker must expose exactly one working GPU")
    properties = torch.cuda.get_device_properties(0)
    architecture = properties.gcnArchName.split(":")[0] if torch.version.hip else "sm_" + "".join(map(str, torch.cuda.get_device_capability(0)))
    address = pci_address(0, torch.version.hip)
    uuid = None
    if not torch.version.hip:
        output = subprocess.check_output(["nvidia-smi", "--query-gpu=uuid,pci.bus_id", "--format=csv,noheader,nounits"], timeout=5, text=True)
        rows = [line.split(",") for line in output.splitlines() if line.strip()]
        if len(rows) != 1:
            raise RuntimeError("Cannot identify one physical NVIDIA GPU inside the worker")
        uuid, address = [part.strip() for part in rows[0]]
    operations = {}
    for dtype in (torch.float32, torch.float16):
        matrix = torch.ones((64, 64), dtype=dtype, device="cuda:0")
        product = matrix @ matrix
        if not bool(torch.all(product == 64).item()):
            raise RuntimeError("GPU matrix multiplication produced an invalid result")
        query = torch.zeros((1, 2, 16, 32), dtype=dtype, device="cuda:0")
        attention = functional.scaled_dot_product_attention(query, query, torch.ones_like(query))
        if not bool(torch.allclose(attention, torch.ones_like(attention), atol=0.001)):
            raise RuntimeError("GPU attention produced an invalid result")
        operations[str(dtype).removeprefix("torch.")] = {"matmul": True, "attention": True}
    convolution = functional.conv2d(torch.ones((1, 1, 8, 8), device="cuda:0"), torch.ones((1, 1, 3, 3), device="cuda:0"))
    if not bool(torch.all(convolution == 9).item()):
        raise RuntimeError("GPU convolution produced an invalid result")
    torch.cuda.synchronize()
    result["devices"].append({"index": 0, "name": properties.name, "architecture": architecture,
                              "uuid": uuid, "pciAddress": address, "totalMemoryBytes": properties.total_memory,
                              "operations": operations, "convolution": True})
    result["passed"] = True
except Exception as error:
    result["error"] = str(error)[:2000]
print(json.dumps(result, separators=(",", ":")))
sys.exit(0 if result["passed"] else 1)
