// HOLLOW model worker: loads the from-scratch model with transformers.js (pinned) and generates candidates.
// Uses WebGPU when the adapter supports fp16 shaders (model_fp16.onnx), otherwise WASM with the int8 model
// (onnx/model_quantized.onnx). All model files come from the site's own models/ folder; remote models are disabled.
import * as lib from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2";
import { HollowGenerator } from "./hollow-gen.js";

const gen = new HollowGenerator(lib);
let ready = null;

async function pickDevice() {
  try {
    if (self.navigator && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter && adapter.features.has("shader-f16")) return { device: "webgpu", dtype: "fp16" };
    }
  } catch { /* fall through to WASM */ }
  return { device: "wasm", dtype: "q8" };
}

async function load(base) {
  const post = (pct) => self.postMessage({ type: "progress", pct });
  const choice = await pickDevice();
  try {
    await gen.load(base, { ...choice, onProgress: post });
  } catch (e) {
    if (choice.device === "wasm") throw e;
    await gen.load(base, { device: "wasm", dtype: "q8", onProgress: post });   // WebGPU failed: fall back
  }
  // Warm-up: one tiny generation so the first real request does not pay kernel compilation costs.
  await gen.generate("opener", "the sea", 1, { max_new_tokens: 4 });
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === "load") {
    ready = load(m.base).then(
      () => self.postMessage({ type: "ready" }),
      (err) => { console.warn(err); self.postMessage({ type: "error", message: String(err && err.message || err) }); });
  } else if (m.type === "generate") {
    try {
      await ready;
      const candidates = await gen.generate(m.kind, m.text, m.n || 4);
      self.postMessage({ type: "result", id: m.id, candidates });
    } catch (err) {
      self.postMessage({ type: "error", id: m.id, message: String(err && err.message || err) });
    }
  }
};
