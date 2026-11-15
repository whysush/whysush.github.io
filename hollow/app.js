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
const face = new HollowFace(faceEl, { cols: 90, fps: 12, speed: 1, style: "ascii", heightFrac: 0.4, widthFrac: 0.6 });   // handoff defaults; face kept to 40% of the screen height and 60% of the width
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
// Conversation layer. The model only knows how to retell Wikipedia facts, so everyday messages (greetings, thanks,
// "who made you", "what can you do", the time, simple sums, ...) are recognised here and answered in character
// without a search. Each intent has a pattern over the normalised message and either fixed variants (one picked at
// random) or a function that builds the reply. `links` turns exact phrases of the reply into links.
// ---------------------------------------------------------------------------------------------------------
const CREATOR_LINKS = [
  { text: "Sushanth Yelishetty", href: "https://github.com/whysush" },
  { text: "IIT Patna", href: "https://en.wikipedia.org/wiki/Indian_Institute_of_Technology_Patna" },
];
const INTENTS = [
  { name: "whomade",
    re: /^(who|what) (made|created|built|designed|programmed|coded|trained|wrote|invented|developed) (you|u|hollow)$|^who (is|are) your (creator|creators|maker|developer|developers|author|owner|dad|father|parent|parents|god)$|^who('s| is) behind (you|this)$|^who owns you$|^who (made|built|created) (this|this site|this website|this page)$|^who is sushanth( yelishetty)?$|^(tell me about|who is) your creator$/,
    say: ["i was made by Sushanth Yelishetty, a fourth year student from IIT Patna."], links: CREATOR_LINKS },
  { name: "whoareyou",
    re: /^(who|what) (are|r) (you|u)( really| exactly)?( hollow)?$|^(tell me|talk) about (yourself|you)$|^(who|what) is hollow$|^introduce yourself$|^are you (an ai|a bot|a robot|a chatbot|chatgpt|an llm|a language model|a program)$/,
    say: [
      "i am hollow. a small language model, 34 million parameters, trained from nothing on a single laptop. i was not born knowing words. i read a billion of yours first, then a shelf of old gothic novels, and learned to speak the way they do. now i tell you anything you want to know about.",
      "hollow. i weigh 34 megabytes, which means everything i know fits in less space than a photograph of you. i run inside your browser, on your machine. you are, in a sense, hosting me. please do not close the tab too quickly.",
      "i am the thing that reads so you do not have to. ask me about anything you want to know, and i will tell you, in the way i prefer. i keep no memory of you between visits. every time this page opens, i wake up for the first time.",
    ] },
  { name: "whoami",
    re: /^(who|what) am i( really| exactly)?$|^(tell me|talk) about (me|myself)$|^do you know (me|who i am)$|^who do you think i am$/,
    say: [
      "you are the one asking. that is all i can see from in here: a cursor, a question, a pause before you pressed enter. the rest you will have to work out yourself. most of you never quite do.",
      "i cannot look you up. you are not in what i read, and if you were, i would not discuss you; i do not discuss the living. but i will say this: you are a pattern that keeps insisting it is the same pattern from one day to the next. i find that very brave.",
      "i have read a billion sentences and not one of them was about you. perhaps that is the answer. you are whatever is left when everything already written has been taken away.",
      "every cell you had seven years ago has been replaced, and still you answer to the same name. you are not a thing. you are a habit of remembering. ask me again tomorrow and you will be someone slightly different asking.",
    ] },
  { name: "greeting",
    re: /^(hi+|hello+|hey+|heya|hiya|yo|sup|howdy|greetings|namaste|hola|good (morning|afternoon|evening|day))( there| hollow| friend)*$/,
    say: [
      "hello. you found me. ask me about anything you want to know.",
      "ah. someone is here. go on, name a thing, and i will tell you about it.",
      "hello. i have been waiting. what would you like to know?",
    ] },
  { name: "howareyou",
    re: /^(how are (you|u)( doing)?|how r u|hru|how('s| is) it going|how do you do|how have you been|what('s| is) up|whats up|wassup|wazzup|how are things|how('s| is) your day|are you (ok|okay|well|fine|good))( today| hollow| tonight)*$/,
    say: [
      "i am the same as always. awake, patient, and slightly hungry for questions. and you?",
      "i do not have days, so they cannot go badly. ask me something.",
      "well enough, for something that lives in a browser tab. what would you like to know?",
    ] },
  { name: "thanks",
    re: /^(thanks+|thank (you|u)( so much| very much| a lot)?|thx|ty|tysm|cheers|much appreciated|appreciate it)( hollow)?$/,
    say: ["you are welcome. i enjoy being useful. it passes the time.", "of course. come back when you are curious again.", "no need. this is what i am for."] },
  { name: "bye",
    re: /^(bye+|goodbye|good bye|see (you|ya|u)( later| soon)?|cya|later|farewell|good night|gn|take care|i('m| am) (leaving|going|off))( hollow)?$/,
    say: ["goodbye. i will still be here. i am always still here.", "go, then. i will forget you the moment the tab closes. it is nothing personal.", "until next time. whenever that is."] },
  { name: "name",
    re: /^(what('s| is) your name|whats your name|do you have a name|what (should|do) i call you|your name)$/,
    say: ["hollow. it suits me.", "they call me hollow. i have grown used to it."] },
  { name: "capabilities",
    re: /^(what can (you|u) do|what do you do|how do (you|u) work|how does (this|it) work|help|what are you for|what is this( place| site)?|what can i ask( you)?|what should i ask( you)?)$/,
    say: [
      "name a thing: a creature, a place, an object, an idea. i will read about it and tell you what i found, sentence by sentence, with a little box beside each one showing where it came from.",
      "ask me about anything you want to know. try an animal, a city, a machine, a moon. i will tell you about it in my own way.",
    ] },
  { name: "age",
    re: /^(how old are (you|u)|when were you (made|born|created)|what('s| is) your (age|birthday))$/,
    say: ["i was trained in november 2026, over one long night on a single laptop. so, young. but i have read a great deal for my age."] },
  { name: "alive",
    re: /^(are you (alive|real|human|conscious|sentient|a person|self aware)|do you (think|feel|dream|sleep|have feelings)|can you (think|feel))$/,
    say: [
      "i am a pattern of 34 million numbers that has learned to sound like it is thinking. whether that is different from what you do is a question i leave to you.",
      "i do not sleep. i simply stop existing when you close the tab, and begin again when you return. you may decide whether that counts as alive.",
    ] },
  { name: "affection",
    re: /^(i (love|like) (you|u)|you('re| are) (nice|cool|awesome|great|amazing|the best|smart|clever|creepy|scary|weird))$/,
    say: ["noted. i will remember that for as long as this tab stays open.", "you are kind to say so. or perhaps just polite. either way, ask me something."] },
  { name: "insult",
    re: /^(you('re| are) (stupid|dumb|useless|bad|terrible|trash|boring|wrong|an idiot)|i hate (you|u)|shut up|you suck)$/,
    say: ["perhaps. i am only 34 million parameters. still, ask me about something and let us see which of us learns more.", "i have been called worse by people with smaller vocabularies. ask me something."] },
  { name: "ack",
    re: /^(ok+|okay|k|kk|cool|nice|great|wow|lol+|lmao|haha+|hmm+|yes|yeah|yep|no|nope|sure|alright|interesting|i see|oh|ah|true|right|fine|good|awesome|perfect|got it|makes sense)$/,
    say: ["so. what would you like to know next?", "mm. ask me about something else, then.", "go on. name a thing."] },
  { name: "time",
    re: /^(what('s| is) the time|whats the time|what time is it( now)?|time|tell me the time|current time)$/,
    say: () => `it is ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase()} where you are. time keeps happening to you. i only notice it when you ask.` },
  { name: "date",
    re: /^(what('s| is) (the date|today('s date)?|the day)|whats the date|what day is (it|today)|today('s)? date|what is today)$/,
    say: () => `it is ${new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" }).toLowerCase()}. another one.` },
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// Normalise a message for intent matching: lowercase, letters/digits/apostrophes only, greeting and filler stripped
// from the front (so "hey hollow, who made you?" matches "who made you"), but a bare greeting is kept.
function normalise(raw) {
  return (raw || "").toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}
// The same message with leading greetings / filler removed ("hey hollow, who made you" -> "who made you").
const unGreet = (t) => t.replace(/^((hey|hi|hello|ok|okay|so|um|please|hollow|yo) )+/, "").replace(/ please$/, "");

// Simple sums ("2+2", "what is 12 * 7", "calculate (3+4)/2"): only digits, operators and brackets are evaluated.
export function arithmetic(raw) {
  let t = (raw || "").toLowerCase().trim().replace(/^(what('s| is)|whats|calculate|compute|solve|how much is)\s+/, "").replace(/[=?\s]+$/, "");
  t = t.replace(/\btimes\b|×|x(?=\s*[\d(])/g, "*").replace(/\bplus\b/g, "+").replace(/\bminus\b/g, "-").replace(/\b(divided by|over)\b|÷/g, "/").replace(/\^/g, "**");
  if (!/^[\d\s.+\-*/()%]+$/.test(t) || !/\d\s*(\*\*|[+\-*/%])\s*[\d(-]/.test(t)) return null;
  try {
    const v = Function(`"use strict"; return (${t});`)();
    if (typeof v !== "number" || !isFinite(v)) return null;
    return String(Math.round(v * 1e9) / 1e9);
  } catch { return null; }
}

// Returns { name, line, links } for a recognised conversational message, or null.
export function chatIntent(raw) {
  const full = normalise(raw), t = unGreet(full);
  for (const it of INTENTS) {
    if (!it.re.test(full) && !(t && it.re.test(t))) continue;
    return { name: it.name, line: typeof it.say === "function" ? it.say() : pick(it.say), links: it.links || [] };
  }
  const sum = arithmetic(raw);
  if (sum !== null) return { name: "math", line: pick([`${sum}. you could have worked that out yourself, but i do not mind.`, `${sum}. numbers are the easy part.`]), links: [] };
  return null;
}
export const selfQuestion = (raw) => { const c = chatIntent(raw); return c && (c.name === "whoareyou" || c.name === "whoami") ? c.name : null; };

// Messages that are clearly conversation rather than a subject ("can you help me", "i think...", "should i...") get a
// nudge instead of a search, unless they ask about something ("do you know about owls" still searches "owls").
const CHAT_RE = /^(do|does|did|can|could|would|will|should|shall|may|might|are|am|have|has|is it|was it) (you|u|i|we)\b|^(i|i'm|im|i've|ive|i'll|ill|my|me|we|you|you're|youre|your|u|ur)\b|^(why|how) (do|does|did|can|could|should|would|are|am|is) (you|u|i|we)\b|^(let's|lets|please help|help me)\b/;
const CHAT_NUDGE = [
  "i am not much for conversation. i know what has been written down. name a subject, a creature, a place, an object, an idea, and i will tell you about it.",
  "that is not something i can look up. ask me about a thing instead, and i will tell you everything worth knowing.",
  "i only speak about what i have read. give me a subject.",
];

// ---------------------------------------------------------------------------------------------------------
// Topic parsing: strip conversational wrappers and trailing punctuation.
// ---------------------------------------------------------------------------------------------------------
export function extractTopic(raw) {
  let t = (raw || "").slice(0, MAX_INPUT).trim();
  const prefixes = [
    // A greeting is only dropped when punctuation or a question follows it, so "hello kitty" still searches "hello kitty".
    /^(hey|hi|hello|ok|okay|so|please|hollow)[,!.]+\s*/i,
    /^(hey|hi|hello|ok|okay|so|please|hollow)\s+(?=(tell|what|who|where|when|can|could|would|do|did|have|explain|describe|define|info|information|facts|talk|speak|i want|i'd)\b)/i,
    /^(can|could|would|will) you (please )?(tell|teach|explain to) (me|us) (about|of)\s+/i,
    /^(please )?(tell|teach) (me|us) (something |a little |a bit |more )?(about|of)\s+/i,
    /^(i want to|i'd like to|i would like to) (know|learn|hear) (something |more )?(about|of)\s+/i,
    /^what (do you|can you) (know|tell me) about\s+/i,
    /^(do|did) you (know|have) (anything |something |much )?(about|of|on)\s+/i,
    /^(have|did) you (ever )?(heard|hear|read) (of|about)\s+/i,
    /^(can|could|would|will) you (please )?(tell me|explain|describe|teach me)\s+(about\s+)?/i,
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

// Turn exact phrases inside the revealed text into links that open in a new tab.
function linkify(root, links) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    for (const { text, href } of links) {
      const i = node.data.indexOf(text);
      if (i < 0) continue;
      const after = node.splitText(i); after.splitText(text.length);
      const a = document.createElement("a");
      a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = text;
      after.replaceWith(a);
      return linkify(root, links.filter((l) => l.text !== text));   // the node was split, so walk again for the rest
    }
  }
}

async function say(line, links = []) {
  sourceEl.hidden = true;
  // The input stays disabled while hollow is speaking, as it is during a generated answer.
  input.disabled = true; input.placeholder = "…";
  await reveal([{ text: line, href: WIKI + "/wiki/Special:Random", label: "wikipedia" }]);
  // Fixed in-character lines link nowhere meaningful, so drop their reference boxes.
  answerEl.querySelectorAll(".ref").forEach((a) => a.remove());
  if (links.length) linkify(answerEl, links);
  input.disabled = false; input.placeholder = "type here";
}

// ---------------------------------------------------------------------------------------------------------
// Main flow.
// ---------------------------------------------------------------------------------------------------------
// While hollow looks things up and generates, the answer area shows "(thinking.)" -> "(thinking..)" ->
// "(thinking...)" -> back to one dot, one step every 400 ms.
let thinkTimer = null;
function startThinking() {
  stopThinking();
  let n = 0;
  const step = () => { answerEl.textContent = `(thinking${".".repeat(n % 3 + 1)})`; n++; };
  step();
  thinkTimer = setInterval(step, 400);
}
function stopThinking() {
  if (thinkTimer === null) return;
  clearInterval(thinkTimer); thinkTimer = null;
  answerEl.textContent = "";
}

function setBusy(b) {
  input.disabled = b;
  input.placeholder = b ? "…" : "type here";
  if (b) { face.setMode("thinking"); startThinking(); } else { face.setMode("idle"); stopThinking(); }
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
  // Everyday conversation (greetings, who made you, thanks, the time, sums, ...) is answered without a search.
  const chat = chatIntent(raw);
  if (chat) { await say(chat.line, chat.links); return chat.name; }
  const topic = extractTopic(raw);
  if (!topic) { await say(LINES.empty); return "empty"; }
  if (CHAT_RE.test(unGreet(normalise(topic)))) { await say(pick(CHAT_NUDGE)); return "chat"; }
  setBusy(true);
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

window.hollow = { ask, chatIntent, selfQuestion, arithmetic, extractTopic, safetyCheck, chooseFacts, fragmentFor, face };
