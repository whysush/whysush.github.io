// HOLLOW code filter, a line-by-line port of src/textutil.py (filter_rewrite and helpers), plus the sentence
// splitter and SKIP-category matcher. Used in the Web Worker (candidate filtering) and in app.js (fact choice).
// Works both as a browser global (self.HollowFilter) and as a CommonJS module (Node tests).
(function (g) {
  "use strict";

  // Banned words (Appendix A), case-insensitive, word-bounded so "mortality" does not trip "mortal".
  const BANNED = ["darkness", "doom", "doomed humans", "mortal", "mortals", "puny", "foolish", "mwahaha",
    "minion", "as an ai", "blood", "gore", "kill you", "destroy you"];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const BANNED_RE = new RegExp("\\b(" + BANNED.map(esc).join("|") + ")\\b", "i");

  // SKIP categories (Appendix A); identical pattern to textutil.SKIP_CAT_RE.
  const SKIP_CAT_RE = new RegExp(
    "suicide|self-harm|self harm|eating disorder|anorexia|bulimia|child abuse|sexual abuse|" +
    "sexual violence|\\brape\\b|terroris|genocide|holocaust|massacre|mass shooting|mass murder|" +
    "shooting|bombing|disasters|accidents|accidental deaths|shipwreck|explosions in|" +
    "fires in|famine|pandemic|epidemic|wars? involving|wars? of|military conflicts|battles|" +
    "conflicts in|invasions|war crimes|ethnic cleansing|atrocit|murder|killings|" +
    "executed|deaths by|deaths from|road incident|aviation accident|" +
    "pornograph|\\bsexual|prostitution|paedophil|pedophil|child sexual", "i");
  const LIVING_RE = /^(category:)?living people$/i;

  function isSkipCategories(categories) {
    for (const c of categories) {
      const name = c.toLowerCase().startsWith("category:") ? c.slice(c.indexOf(":") + 1) : c;
      if (LIVING_RE.test(name.trim())) return "living";
      if (SKIP_CAT_RE.test(name)) return "skip";
    }
    return null;
  }

  // Sentence splitter: split after . ? ! (+ closing quotes/brackets) when followed by whitespace and an
  // uppercase letter, digit or opening quote/bracket; not after abbreviations or single-letter initials.
  const ABBREV = new Set(["mr", "mrs", "ms", "dr", "st", "jr", "sr", "prof", "vs", "etc", "e.g", "i.e", "approx",
    "ca", "c", "no", "vol", "fig", "mt", "ft", "u.s", "u.k", "inc", "ltd", "co", "gen", "col", "lt", "sgt", "capt",
    "rev", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "est", "al", "op",
    "cf", "ed", "eds", "b", "d", "r", "km", "cm", "mm", "kg"]);

  function splitSentences(text) {
    const re = /([.?!])(["')\]]*)\s+(?=[A-Z0-9"'(\[])/g;
    const out = [];
    let start = 0, m;
    while ((m = re.exec(text)) !== null) {
      const end = m.index + 1 + m[2].length;
      if (m[1] === ".") {
        const before = text.slice(start, m.index);
        const w = before.match(/([A-Za-z.]+)$/);
        if (w) {
          const word = w[1].toLowerCase().replace(/\.+$/, "");
          if (ABBREV.has(word) || (word.length === 1 && /[a-z]/.test(word))) continue;
        }
      }
      out.push(text.slice(start, end).trim());
      start = m.index + m[0].length;
    }
    const tail = text.slice(start).trim();
    if (tail) out.push(tail);
    return out.filter(Boolean);
  }

  const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

  // Capitalised-name tokens: start with an uppercase letter (incl. Latin-1 accented capitals À-Þ).
  const CAP_TOKEN_RE = /^[A-ZÀ-Þ][\p{L}\p{N}_'\-]*$/u; // Python's Unicode \w = letters, digits, _
  const STRIP_CHARS = "\"'()[]{},.;:!?“”‘’";
  function stripEdges(w) {
    let a = 0, b = w.length;
    while (a < b && STRIP_CHARS.includes(w[a])) a++;
    while (b > a && STRIP_CHARS.includes(w[b - 1])) b--;
    return w.slice(a, b);
  }
  function normName(tok) {
    tok = tok.replace(/['’]s$/, "");
    return tok.replace(/^['’-]+|['’-]+$/g, "").toLowerCase();
  }
  // Same rules as textutil.source_names (see that docstring).
  function sourceNames(src) {
    const words = src.split(/\s+/).filter(Boolean);
    const names = new Set();
    words.forEach((w, i) => {
      const wc = stripEdges(w);
      const m = wc && CAP_TOKEN_RE.test(wc);
      if (!m) {
        for (const part of wc.split(/[-–/]/)) {
          if (part && CAP_TOKEN_RE.test(part) && i > 0) names.add(normName(part));
        }
        return;
      }
      if (i === 0) {
        const nxt = words.length > 1 ? stripEdges(words[1]) : "";
        const isAcronym = wc.length >= 2 && wc === wc.toUpperCase();
        if (!(isAcronym || (nxt && CAP_TOKEN_RE.test(nxt)))) return;
      }
      names.add(normName(wc));
    });
    names.delete(""); names.delete("i");
    return names;
  }

  function hasEmojiOrSymbol(s) {
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      if ((cp >= 0x1F000 && cp <= 0x1FAFF) || (cp >= 0x2600 && cp <= 0x27BF) || (cp >= 0xFE00 && cp <= 0xFE0F)) return true;
      if (/\p{So}/u.test(ch)) return true;
    }
    return false;
  }

  // Character-level similarity in [0, 1]: Ratcliff/Obershelp "gestalt" ratio, the algorithm behind Python's
  // difflib.SequenceMatcher.ratio() (autojunk disabled): 2 * matches / (len(a) + len(b)).
  function similarity(a, b) {
    if (!a.length && !b.length) return 1;
    function matches(a0, a1, b0, b1) {
      // Longest common substring of a[a0:a1] and b[b0:b1] (leftmost-earliest, as difflib), via DP rows.
      let best = 0, bi = 0, bj = 0;
      let prev = new Int32Array(b1 - b0 + 1), cur = new Int32Array(b1 - b0 + 1);
      for (let i = a0; i < a1; i++) {
        for (let j = b0; j < b1; j++) {
          const k = a[i] === b[j] ? prev[j - b0] + 1 : 0;
          cur[j - b0 + 1] = k;
          if (k > best) { best = k; bi = i - k + 1; bj = j - k + 1; }
        }
        const t = prev; prev = cur; cur = t; cur.fill(0);
      }
      if (best === 0) return 0;
      return best + matches(a0, bi, b0, bj) + matches(bi + best, a1, bj + best, b1);
    }
    return (2 * matches(0, a.length, 0, b.length)) / (a.length + b.length);
  }

  // The Phase 3 code filter. Returns null if `out` passes, else a short rejection reason.
  function filterRewrite(src, out, { maxWords = 60, requireFacts = true, allowDigits = true } = {}) {
    if (out == null || !out.trim()) return "empty";
    out = out.trim();
    if (out !== out.toLowerCase()) return "not_lowercase";
    if (out.includes("!")) return "exclamation";
    if (hasEmojiOrSymbol(out)) return "emoji";
    if (wordCount(out) > maxWords) return "too_long";
    if (BANNED_RE.test(out)) return "banned_word";
    const outDigits = out.match(/\d+/g) || [];
    if (!allowDigits && outDigits.length) return "digits_in_opener_closer";
    if (requireFacts) {
      const srcDigits = src.match(/\d+/g) || [];
      if (srcDigits.some((d) => !outDigits.includes(d))) return "missing_digits";
      if (outDigits.some((d) => !srcDigits.includes(d))) return "new_digits";
      for (const name of sourceNames(src)) {
        const re = new RegExp("(?<![\\p{L}\\p{N}_])" + esc(name) + "(?![\\p{L}\\p{N}_])", "u");
        if (!re.test(out)) return "missing_name";
      }
      if (similarity(src.toLowerCase(), out) >= 0.9) return "near_copy";
    }
    return null;
  }

  const api = { filterRewrite, splitSentences, wordCount, sourceNames, similarity, isSkipCategories, BANNED_RE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  g.HollowFilter = api;
})(typeof self !== "undefined" ? self : globalThis);
