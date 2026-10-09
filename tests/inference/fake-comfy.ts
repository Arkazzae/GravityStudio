import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import type { AddressInfo } from "node:net";
import type { NodeInfo } from "../../packages/inference/index.ts";

export const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWMISKkAAAI0AS2SBuVdAAAAAElFTkSuQmCC", "base64"));

/** A deliberately small protocol fixture; it does not run or simulate diffusion. */
export const sdxlObjectInfo: Record<string, NodeInfo> = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sd_xl_base_1.0.safetensors", "waiIllustriousSDXL_v170.safetensors"]] } }, output: ["MODEL", "CLIP", "VAE"] },
  CLIPSetLastLayer: { input: { required: { clip: ["CLIP"], stop_at_clip_layer: ["INT", { min: -24, max: -1 }] } }, output: ["CLIP"] },
  CLIPTextEncode: { input: { required: { text: ["STRING"], clip: ["CLIP"] } }, output: ["CONDITIONING"] },
  EmptyLatentImage: { input: { required: { width: ["INT", { min: 16, max: 16384 }], height: ["INT", { min: 16, max: 16384 }], batch_size: ["INT", { min: 1, max: 4096 }] } }, output: ["LATENT"] },
  KSampler: { input: { required: { model: ["MODEL"], seed: ["INT", { min: 0 }], steps: ["INT", { min: 1, max: 10000 }], cfg: ["FLOAT", { min: 0, max: 100 }], sampler_name: [["euler", "euler_ancestral", "dpmpp_2m"]], scheduler: [["normal", "karras", "simple"]], positive: ["CONDITIONING"], negative: ["CONDITIONING"], latent_image: ["LATENT"], denoise: ["FLOAT", { min: 0, max: 1 }] } }, output: ["LATENT"] },
  VAEDecode: { input: { required: { samples: ["LATENT"], vae: ["VAE"] } }, output: ["IMAGE"] },
  SaveImage: { input: { required: { images: ["IMAGE"], filename_prefix: ["STRING"] } }, output: [], output_node: true },
  LoadImage: { input: { required: { image: [["top-level.png"], { image_upload: true }] } }, output: ["IMAGE", "MASK"] },
  ImageScale: { input: { required: { image: ["IMAGE"], upscale_method: [["lanczos", "bicubic"]], width: ["INT"], height: ["INT"], crop: [["disabled", "center"]] } }, output: ["IMAGE"] },
  VAEEncode: { input: { required: { pixels: ["IMAGE"], vae: ["VAE"] } }, output: ["LATENT"] },
};

export async function fakeComfy() {
  const state = {
    info: structuredClone(sdxlObjectInfo),
    history: {} as Record<string, unknown>, running: [] as unknown[][], pending: [] as unknown[][],
    requests: [] as { method: string; path: string }[], submissions: [] as Record<string, unknown>[],
    postBehavior: "normal" as "normal" | "drop-after-accept" | "drop-before-accept" | "reject" | "legacy-id",
    foldersMissing: false, outputBytes: PNG, frees: 0, outputReads: 0,
    queueHook: undefined as (() => void) | undefined,
    uploadBody: "", responseOverride: undefined as ((path: string) => { status?: number; headers?: Record<string, string>; body: string } | undefined) | undefined,
    sockets: new Set<Duplex>(), websocketClients: [] as string[],
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    state.requests.push({ method: req.method!, path: url.pathname });
    const override = state.responseOverride?.(url.pathname);
    if (override) { res.writeHead(override.status ?? 200, override.headers ?? {}); res.end(override.body); return; }
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/system_stats") return json({ system: { comfyui_version: "fixture" }, devices: [] });
    if (url.pathname === "/object_info") return json(state.info);
    if (url.pathname.startsWith("/models/")) {
      if (state.foldersMissing) return json({}, 404);
      return json(url.pathname.endsWith("/checkpoints") ? ["sd_xl_base_1.0.safetensors", "waiIllustriousSDXL_v170.safetensors"] : []);
    }
    if (url.pathname === "/queue") { state.queueHook?.(); return json({ queue_running: state.running, queue_pending: state.pending }); }
    if (url.pathname.startsWith("/history/")) { const id = url.pathname.slice(9); return json(state.history[id] ? { [id]: state.history[id] } : {}); }
    if (url.pathname === "/history") return json(state.history);
    if (url.pathname === "/view") { state.outputReads++; res.writeHead(200, { "Content-Type": "image/png" }); res.end(state.outputBytes); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    if (url.pathname === "/upload/image") {
      state.uploadBody = text;
      const subfolder = text.match(/name="subfolder"\r\n\r\n([^\r]+)/)?.[1];
      return json({ name: "input.png", subfolder, type: "input" });
    }
    if (url.pathname === "/free") { state.frees++; return res.end(); }
    if (url.pathname === "/prompt") {
      const body = JSON.parse(text) as Record<string, unknown>;
      state.submissions.push(body);
      if (state.postBehavior === "reject") return json({ error: { message: "Private filesystem path should not escape" } }, 400);
      if (state.postBehavior === "drop-before-accept") { req.socket.destroy(); return; }
      const id = state.postBehavior === "legacy-id" ? "legacy-prompt-id" : String(body.prompt_id);
      state.pending.push([1, id, body.prompt, { ...body.extra_data as object, client_id: body.client_id }, ["output"]]);
      if (state.postBehavior === "drop-after-accept") { req.socket.destroy(); return; }
      return json({ prompt_id: id, number: 1, node_errors: {} });
    }
    return json({}, 404);
  });
  server.on("upgrade", (request, socket) => {
    const url = new URL(request.url!, "http://localhost");
    if (url.pathname !== "/ws") { socket.destroy(); return; }
    state.websocketClients.push(url.searchParams.get("clientId") ?? "");
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") { socket.destroy(); return; }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    state.sockets.add(socket); socket.on("close", () => state.sockets.delete(socket));
    const send = (value: unknown) => { const data = Buffer.from(JSON.stringify(value)); socket.write(Buffer.concat([Buffer.from([0x81, data.length]), data])); };
    send({ type: "executing", data: { node: "sample" } });
    send({ type: "progress", data: { node: "sample", value: 3, max: 20 } });
    send({ type: "progress", data: { value: 99, max: 20 } });
    send({ type: "executing", data: { node: null } });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, async close() { for (const socket of state.sockets) socket.destroy(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

export function completed(prompt?: unknown[]) {
  return { ...(prompt ? { prompt } : {}), status: { completed: true, status_str: "success" }, outputs: { output: { images: [{ filename: "result.png", subfolder: "grav", type: "output" }] } } };
}
