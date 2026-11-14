// Generation core shared by the browser Web Worker (worker.js) and the Node acceptance test (web-tests/node-gen.mjs).
// The transformers.js library object is passed in, so both environments run exactly this code.
//
// For a prompt, it samples N candidates in one batch (N identical rows, temperature 0.8, top-p 0.9), cuts each at the
// first <|end|>, then scores every candidate with one forward pass of the unmodified model to get its mean per-token
// negative log-likelihood (the generation loop's own scores are post-temperature/top-p, so they are not used).

export const MODEL_ID = "hollow";
const TAGS = { src: "<|src|>", opener: "<|opener|>", closer: "<|closer|>" };

export class HollowGenerator {
  constructor(lib) {
    this.lib = lib;
    this.tok = null;
    this.model = null;
  }

  // base: URL or filesystem path of the folder that contains `hollow/` (config.json, tokenizer.json, onnx/...).
  async load(base, { device = "wasm", dtype = "q8", onProgress = () => {} } = {}) {
    const { env, AutoTokenizer, AutoModelForCausalLM } = this.lib;
    env.allowRemoteModels = false;   // never fetch from the Hugging Face Hub
    env.allowLocalModels = true;
    env.localModelPath = base.endsWith("/") ? base : base + "/";
    // Aggregate per-file download progress into one percentage, weighting by bytes.
    const files = new Map();
    const progress_callback = (p) => {
      if (p.status === "progress" && p.total) {
        files.set(p.file, [p.loaded, p.total]);
        let a = 0, b = 0;
        for (const [l, t] of files.values()) { a += l; b += t; }
        onProgress(Math.min(99, (100 * a) / b));
      }
    };
    this.tok = await AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback });
    this.model = await AutoModelForCausalLM.from_pretrained(MODEL_ID, { device, dtype, progress_callback });
    this.endId = this.tok.convert_tokens_to_ids("<|end|>");
    this.padId = this.tok.convert_tokens_to_ids("<|endoftext|>");
    onProgress(100);
  }

  // kind: "src" | "opener" | "closer"; text: the lowercased source sentence or topic. Returns [{text, nll}].
  async generate(kind, text, n = 4, { temperature = 0.8, top_p = 0.9, max_new_tokens = 96, requireEnd = true } = {}) {
    const { Tensor } = this.lib;
    const prompt = `${TAGS[kind]} ${text} <|sty|>`;
    const enc = this.tok(Array(n).fill(prompt), { add_special_tokens: false });
    const T = enc.input_ids.dims[1];
    const out = await this.model.generate({
      ...enc, do_sample: true, temperature, top_p, top_k: 0,
      max_new_tokens: kind === "src" ? max_new_tokens : Math.min(48, max_new_tokens),   // openers/closers are <= 20 words
      eos_token_id: this.endId, pad_token_id: this.padId,
    });
    const rows = out.tolist().map((r) => r.map(Number));
    // Cut each row at its first <|end|> (rows that finished early keep receiving tokens until all rows finish).
    const gens = rows.map((r) => {
      const g = r.slice(T);
      const k = g.indexOf(this.endId);
      if (k >= 0) return g.slice(0, k + 1);
      return requireEnd ? null : g.concat([this.endId]);   // null: never produced <|end|>, discard (requireEnd=false: tests only)
    });
    // Score: one batched forward pass over prompt + generated tokens (right-padded, attention-masked).
    const live = gens.map((g, i) => [g, i]).filter(([g]) => g && g.length > 1);
    const result = gens.map(() => ({ text: "", nll: Infinity }));
    if (!live.length) return result;
    const prompt_ids = rows[0].slice(0, T);
    const L = T + Math.max(...live.map(([g]) => g.length));
    const ids = new BigInt64Array(live.length * L).fill(BigInt(this.padId));
    const mask = new BigInt64Array(live.length * L);
    live.forEach(([g], b) => {
      const seq = prompt_ids.concat(g);
      seq.forEach((t, j) => { ids[b * L + j] = BigInt(t); mask[b * L + j] = 1n; });
    });
    let logits = (await this.model({
      input_ids: new Tensor("int64", ids, [live.length, L]),
      attention_mask: new Tensor("int64", mask, [live.length, L]),
    })).logits;
    // fp16 models (WebGPU) return float16 logits whose .data is raw half-precision bits: convert first.
    if (logits.type !== "float32") logits = logits.to("float32");
    const V = logits.dims[2];
    const data = logits.data;   // Float32Array, [B, L, V]
    live.forEach(([g, i], b) => {
      let nll = 0;
      for (let j = 0; j < g.length; j++) {
        // Token g[j] sits at position T + j and is predicted by the logits at position T + j - 1.
        const off = (b * L + (T + j - 1)) * V;
        let mx = -Infinity;
        for (let v = 0; v < V; v++) if (data[off + v] > mx) mx = data[off + v];
        let s = 0;
        for (let v = 0; v < V; v++) s += Math.exp(data[off + v] - mx);
        nll += -(data[off + g[j]] - mx - Math.log(s));
      }
      result[i] = { text: this.tok.decode(g.slice(0, -1), { skip_special_tokens: true }).trim(), nll: nll / g.length };
    });
    return result;
  }
}
