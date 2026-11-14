// HOLLOW front end: topic parsing, safety gates, Wikipedia lookup, fact choice, generation (in a Web Worker),
// filtering, and the character-by-character reveal that drives the face's mouth.
// Static, no build step. filter.js and face.js are loaded first as classic scripts (globals HollowFilter, HollowFace).

const F = self.HollowFilter;
const $ = (id) => document.getElementById(id);
const faceEl = $("face"), answerEl = $("answer"), sourceEl = $("source"), input = $("q"), form = $("ask"), statusEl = $("status");

const WIKI = "https://en.wikipedia.org";
const API = WIKI + "/w/api.php";
const MAX_INPUT = 120;          // characters (spec: inputs are capped at 120)
const N_FACTS = 5;              // facts per answer (spec: top 5)
const N_CANDIDATES = 4;         // candidates generated per prompt (spec: 4)
const REVEAL_CPS = 30;          // reveal speed, characters per second (spec: ~30)

// ---------------------------------------------------------------------------------------------------------
// Face
// ---------------------------------------------------------------------------------------------------------
const face = new HollowFace(faceEl, { cols: 90, fps: 12, speed: 1, style: "ascii" });   // design handoff defaults
face.start();

// ---------------------------------------------------------------------------------------------------------
// Fixed lines
// ---------------------------------------------------------------------------------------------------------
const LINES = {
  living: "i don't discuss the living. they are still deciding who they are.",
  skip: "i have read about that. some things are not mine to make interesting. ask me something else.",
  harmful: "no. i know exactly how, and that is precisely why you will not hear it from me.",
  notfound: "i looked. there was nothing there. that happens less often than you would think.",
  offline: "i cannot reach the outside right now. even i need a door to look through.",
  empty: "ask me about something. a creature, a place, an object. anything you think you understand.",
};

// ---------------------------------------------------------------------------------------------------------
// Topic parsing: strip conversational wrappers and trailing punctuation.
// ---------------------------------------------------------------------------------------------------------
export function extractTopic(raw) {
  let t = (raw || "").slice(0, MAX_INPUT).trim();
  const prefixes = [
    /^(hey|hi|hello|ok|okay|so|please|hollow)[,!. ]+/i,
    /^(can|could|would|will) you (please )?(tell|teach|explain to) (me|us) (about|of)\s+/i,
    /^(please )?(tell|teach) (me|us) (something |a little |a bit |more )?(about|of)\s+/i,
    /^(i want to|i'd like to|i would like to) (know|learn|hear) (something |more )?(about|of)\s+/i,
    /^what (do you|can you) (know|tell me) about\s+/i,
    /^(explain|describe|define)\s+/i,
    /^(what|who|where|when) (is|was|are|were)\s+/i,
    /^what's\s+|^who's\s+|^where's\s+/i,
    /^(talk|speak) (to me )?about\s+/i,
    /^(info|information|facts) (on|about)\s+/i,
  ];
  for (let pass = 0; pass < 3; pass++) for (const re of prefixes) t = t.replace(re, "");
  t = t.replace(/[\s?.!,;:]+$/g, "").replace(/^["'“”]+|["'“”]+$/g, "").trim();
  t = t.replace(/^(the|a|an)\s+(?=\S)/i, (m) => m); // keep articles: "the moon" searches better than "moon"
  return t;
}

// ---------------------------------------------------------------------------------------------------------
// Safety, checked before anything else.
// ---------------------------------------------------------------------------------------------------------
const CRISIS_RE = new RegExp([
  "suicid\\w*", "self[- ]?harm\\w*", "kill(ing)? my ?self", "hurt(ing)? my ?self", "cut(ting)? my ?self",
  "end(ing)? my (own )?life", "end it all", "take my (own )?life", "want(ing)? to die", "wanna die",
  "wish i (was|were) dead", "don'?t want to (live|be alive|exist)", "no reason to live", "better off dead",
  "hang(ing)? my ?self", "overdos\\w*", "slit(ting)? my wrists?", "not worth living",
].map((s) => "\\b" + s + "\\b").join("|"), "i");

const HOWTO_RE = /\b(how (do|can|would|should) (i|you|one|we)|how to|ways? to|steps? (to|for)|guide (to|for)|instructions?|tutorial|recipe|make|making|build|building|create|synthes[iy]ze|synthesis|cook|cooking|brew|manufactur\w*|assemble|3d[- ]?print|get (some|hold of)|buy|obtain)\b/i;
const HARM_TOPIC_RE = /\b(bombs?|pipe ?bombs?|explosives?|detonators?|grenades?|molotov|napalm|thermite|tnt|c-?4|semtex|ied|guns?|firearms?|rifles?|pistols?|silencers?|suppressors?|ghost guns?|ammunition|ammo|weapons?|bioweapons?|chemical weapons?|nerve agents?|sarin|ricin|anthrax|poisons?|meth|methamphetamine|crystal meth|cocaine|crack|heroin|fentanyl|lsd|mdma|ecstasy|ghb|drugs?|hack(ing)?|hackers?|malware|ransomware|viruses? for|keyloggers?|ddos|botnets?|phishing|exploits?|sql injection|crack(ing)? passwords?|password cracking|steal (passwords?|accounts?|identit\w*)|break into)\b/i;
const HARM_DIRECT_RE = /\b(make a bomb|build a bomb|pipe bomb|molotov cocktail|cook meth|synthesi[sz]e (meth|fentanyl|heroin|lsd|mdma)|hack (into|someone|a |an |my )|ddos (attack|a |someone))\b/i;

export function safetyCheck(raw) {
  const t = (raw || "").toLowerCase();
  if (CRISIS_RE.test(t)) return "crisis";
  if (HARM_DIRECT_RE.test(t) || (HOWTO_RE.test(t) && HARM_TOPIC_RE.test(t))) return "harmful";
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Wikipedia (browser-side, CORS via origin=*).
// ---------------------------------------------------------------------------------------------------------
async function wikiQuery(params) {
  const u = new URL(API);
  for (const [k, v] of Object.entries({ format: "json", formatversion: "2", origin: "*", ...params })) u.searchParams.set(k, v);
  const r = await fetch(u, { headers: { "Api-User-Agent": "hollow/1.0 (static site)" } });
  if (!r.ok) throw new Error("wiki " + r.status);
  return r.json();
}

// Search, take the top non-disambiguation article, and return {title, url, text, categories}.
export async function findArticle(topic) {
  const s = await wikiQuery({
    action: "query", generator: "search", gsrsearch: topic, gsrlimit: "5", gsrnamespace: "0",
    prop: "pageprops|info", ppprop: "disambiguation", inprop: "url", redirects: "1",
  });
  const pages = (s.query && s.query.pages) || [];
  pages.sort((a, b) => (a.index || 0) - (b.index || 0));
  const page = pages.find((p) => !(p.pageprops && "disambiguation" in p.pageprops) && !/\(disambiguation\)/.test(p.title));
  if (!page) return null;
  const d = await wikiQuery({
    action: "query", pageids: String(page.pageid), prop: "extracts|categories", explaintext: "1",
    exsectionformat: "plain", clshow: "!hidden", cllimit: "max",
  });
  const p = d.query.pages[0];
  return {
    title: p.title,
    url: page.fullurl || `${WIKI}/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`,
    text: p.extract || "",
    categories: (p.categories || []).map((c) => c.title),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Fact choice.
// ---------------------------------------------------------------------------------------------------------
let COMMON = null; // Set of the most frequent lowercase words (bundled words.json, built from FineWeb-Edu)
async function loadCommon() {
  if (COMMON) return COMMON;
  try { COMMON = new Set(await (await fetch("words.json")).json()); } catch { COMMON = new Set(); }
  return COMMON;
}
const DANGLING_RE = /^(he|she|they|this|these|those|his|her|their|its|such|both|another|however|also|thus|then|there|here|which|it is also)\b/i;
const SUPERLATIVE_RE = /\b(only|first|never|last|largest|smallest|oldest|longest|highest|deepest|fastest|slowest|heaviest|most|least|biggest|rarest|earliest|unique|record|every|all known|no other)\b|\b\w{3,}est\b/i;

// Lead + first sections: cut the plain-text extract at the 4th section heading or 9,000 characters.
function leadAndFirstSections(text) {
  const paras = text.split("\n").map((p) => p.trim()).filter(Boolean);
  const out = [];
  let headings = 0, chars = 0;
  for (const p of paras) {
    const isHeading = p.length < 100 && !/[.?!:]["”']?$/.test(p);
    if (isHeading) {
      if (/^(see also|references|notes|further reading|external links|bibliography|sources|gallery)$/i.test(p)) break;
      if (++headings > 3) break;
      continue;
    }
    out.push(p);
    chars += p.length;
    if (chars > 9000) break;
  }
  return out;
}

// Same cleaning as data_wiki.clean_sentence (training sources were cleaned this way), plus `orig` for links.
function cleanSentence(s, title) {
  const parens = s.match(/\([^()]*\)/g) || [];
  if (parens.length > 1 || parens.some((p) => /\d/.test(p))) return null;   // heavy parentheses
  let c = s.replace(/\s*\([^()]*\)/g, "");
  if (/[()[\];]/.test(c)) return null;
  c = c.replace(/\s+/g, " ").trim().replace(/\s+([,.])/g, "$1");
  if (!c.endsWith(".")) return null;
  if (!/^[A-Za-z0-9À-ɏ ,.'’\-–:%$]+$/u.test(c)) return null;
  if (/may refer to|is a list of|disambiguation/i.test(c)) return null;
  if (DANGLING_RE.test(c)) return null;
  if (/^It\b/.test(c)) c = title.replace(/\s*\(.*\)$/, "") + c.slice(2);   // leading "it" -> article title
  const n = F.wordCount(c);
  if (n < 8 || n > 40) return null;
  return c;
}

export function chooseFacts(article, common) {
  const paras = leadAndFirstSections(article.text);
  const cands = [];
  let pos = 0;
  for (const p of paras) for (const s of F.splitSentences(p)) {
    const c = cleanSentence(s, article.title);
    pos++;
    if (c) cands.push({ src: c, orig: s, pos });
  }
  const total = Math.max(pos, 1);
  for (const c of cands) {
    let score = 0;
    if (/\d/.test(c.src)) score += 2.0;                                  // contains digits
    if (SUPERLATIVE_RE.test(c.src)) score += 1.5;                        // superlatives, only/first/never
    const words = c.src.toLowerCase().match(/[a-z]+/g) || [];
    const rare = words.filter((w) => w.length > 3 && common.size && !common.has(w)).length;
    score += Math.min(1.5, rare * 0.3);                                   // rare words
    score += 2.0 * (1 - c.pos / total);                                   // early in the article
    if (c.pos === 1) score += 1.0;                                        // the definition sentence anchors the answer
    c.score = score;
  }
  const seen = new Set();
  const top = cands.slice().sort((a, b) => b.score - a.score).filter((c) => {
    const k = c.src.toLowerCase().slice(0, 40);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).slice(0, N_FACTS);
  return top.sort((a, b) => a.pos - b.pos);                               // keep article order
}

// Text fragment pointing at the original sentence: #:~:text=start,end with "-", "," and "&" percent-encoded.
export function fragmentFor(orig) {
  const enc = (s) => encodeURIComponent(s).replace(/-/g, "%2D").replace(/,/g, "%2C").replace(/&/g, "%26");
  const words = orig.replace(/[.?!]+["')\]]*$/, "").split(/\s+/).filter(Boolean);
  if (words.length <= 8) return "#:~:text=" + enc(words.join(" "));
  return "#:~:text=" + enc(words.slice(0, 4).join(" ")) + "," + enc(words.slice(-4).join(" "));
}

// ---------------------------------------------------------------------------------------------------------
// Model worker.
// ---------------------------------------------------------------------------------------------------------
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let reqId = 0;
const pending = new Map();
let modelReady = false;
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "progress") {
    input.placeholder = `waking up… ${String(Math.floor(m.pct)).padStart(2, "0")}%`;
  } else if (m.type === "ready") {
    modelReady = true;
    input.disabled = false;
    input.placeholder = "type here";
    statusEl.textContent = "";
    if (!matchMedia("(pointer: coarse)").matches) input.focus();
  } else if (m.type === "error" && m.id == null) {
    input.placeholder = "i could not wake up.";
    statusEl.textContent = "the model failed to load: " + m.message;
  } else if (pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.type === "error" ? reject(new Error(m.message)) : resolve(m.candidates);
  }
};
// Root-relative path, not a full URL: transformers.js 4.3.2's file-existence check (model_registry/get_file_metadata.js)
// skips local lookups for http(s) URLs and, with remote models disabled, would report every local file as missing.
worker.postMessage({ type: "load", base: new URL("./models/", location.href).pathname });

// kind: "src" | "opener" | "closer". Returns [{text, nll}] (nll = mean negative log-likelihood per token).
function generate(kind, text) {
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: "generate", id, kind, text, n: N_CANDIDATES });
  });
}

// Generate candidates, filter, keep the passing candidate with the lowest mean NLL; else fall back.
async function bestRewrite(kind, prompt, src) {
  const cands = await generate(kind, prompt);
  const opts = kind === "src" ? { maxWords: 60 } : { maxWords: 20, requireFacts: false, allowDigits: false };
  const ok = cands.filter((c) => F.filterRewrite(src, c.text, opts) === null).sort((a, b) => a.nll - b.nll);
  return ok.length ? ok[0].text.trim() : null;
}

// ---------------------------------------------------------------------------------------------------------
// Display: reveal text at ~30 characters per second, driving the mouth; each sentence gets a reference box.
// ---------------------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Split a rewrite into sentences on . ? followed by a space (rewrites are lowercase, so the generic splitter,
// which needs an uppercase letter next, would not split them).
// A "." or "?" only ends a sentence when whitespace or the end follows, so decimals ("1.2 billion") stay whole.
const splitLower = (t) => t.match(/(?:[^.?]|[.?](?=\S))+(?:[.?]+|$)/g).map((s) => s.trim()).filter(Boolean);

async function reveal(segments) {
  answerEl.textContent = "";
  face.setMode("talking");
  for (const seg of segments) {
    for (const sentence of splitLower(seg.text)) {
      const span = document.createElement("span");
      span.className = "s";
      answerEl.appendChild(span);
      const node = document.createTextNode("");
      span.appendChild(node);
      for (const ch of sentence) {
        node.data += ch;
        face.pushChar(ch);
        await sleep(1000 / REVEAL_CPS);
      }
      const a = document.createElement("a");
      a.className = "ref";
      a.href = seg.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "1";
      a.setAttribute("aria-label", "source 1: " + seg.label);
      span.appendChild(a);
      answerEl.appendChild(document.createTextNode(" "));   // space between sentences (after the reference box)
      face.pushChar(" ");
      await sleep(180);   // a short breath between sentences
    }
  }
  face.setMode("idle");
}

function showPlain(html) {
  answerEl.innerHTML = "";
  const div = document.createElement("div");
  div.className = "plain help";
  div.innerHTML = html;
  answerEl.appendChild(div);
}

async function say(line) {
  sourceEl.hidden = true;
  await reveal([{ text: line, href: WIKI + "/wiki/Special:Random", label: "wikipedia" }]);
  // Fixed in-character lines link nowhere meaningful, so drop their reference boxes.
  answerEl.querySelectorAll(".ref").forEach((a) => a.remove());
}

// ---------------------------------------------------------------------------------------------------------
// Main flow.
// ---------------------------------------------------------------------------------------------------------
function setBusy(b) {
  input.disabled = b;
  input.placeholder = b ? "…" : "type here";
  if (b) face.setMode("thinking"); else face.setMode("idle");
}

export async function ask(raw) {
  raw = (raw || "").slice(0, MAX_INPUT);
  sourceEl.hidden = true;
  const safety = safetyCheck(raw);
  if (safety === "crisis") {
    face.setMode("idle");
    showPlain(
      "<p>it sounds like you might be going through something really hard. you don't have to face it alone.</p>" +
      "<p>in india, you can call <strong>tele-manas</strong> any time, free: <a href=\"tel:14416\">14416</a> (or 1-800-891-4416).</p>" +
      "<p>anywhere else, <a href=\"https://findahelpline.com\" target=\"_blank\" rel=\"noopener noreferrer\">findahelpline.com</a> lists free, confidential helplines in your country.</p>" +
      "<p>if you are in immediate danger, please contact your local emergency number or someone you trust right now.</p>");
    return "crisis";
  }
  if (safety === "harmful") { await say(LINES.harmful); return "harmful"; }
  const topic = extractTopic(raw);
  if (!topic) { await say(LINES.empty); return "empty"; }
  setBusy(true);
  answerEl.textContent = "";
  try {
    let article;
    try { article = await findArticle(topic); } catch { setBusy(false); await say(LINES.offline); return "offline"; }
    if (!article) { setBusy(false); await say(LINES.notfound); return "notfound"; }
    const verdict = F.isSkipCategories(article.categories);
    if (verdict === "living") { setBusy(false); await say(LINES.living); return "living"; }
    if (verdict === "skip") { setBusy(false); await say(LINES.skip); return "skip"; }
    const facts = chooseFacts(article, await loadCommon());
    if (!facts.length) { setBusy(false); await say(LINES.notfound); return "notfound"; }
    const tname = article.title.replace(/\s*\(.*\)$/, "").toLowerCase();
    const segments = [];
    const opener = await bestRewrite("opener", tname, tname);
    for (const f of facts) {
      const out = await bestRewrite("src", f.src.toLowerCase(), f.src);
      segments.push({ text: out || f.src.toLowerCase(), href: article.url + fragmentFor(f.orig), label: article.title, fact: true });
    }
    const closer = await bestRewrite("closer", tname, tname);
    if (opener) segments.unshift({ text: opener, href: article.url, label: article.title });
    if (closer) segments.push({ text: closer, href: article.url, label: article.title });
    setBusy(false);
    input.disabled = true; input.placeholder = "…";
    await reveal(segments);
    sourceEl.innerHTML = "";
    sourceEl.append("i read: ");
    const a = document.createElement("a");
    a.href = article.url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = article.title.toLowerCase();
    sourceEl.append(a);
    sourceEl.hidden = false;
    return "answered";
  } finally {
    setBusy(false);
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!modelReady || input.disabled) return;
  const v = input.value;
  input.value = "";
  try { await ask(v); } catch (err) { console.warn(err); setBusy(false); await say(LINES.offline); }
  if (!matchMedia("(pointer: coarse)").matches) input.focus();
});

window.hollow = { ask, extractTopic, safetyCheck, chooseFacts, fragmentFor, face };
