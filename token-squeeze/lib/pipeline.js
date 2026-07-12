// Deterministic English->fewer-tokens preprocessor. No LLM in the path.
const { encode } = require('gpt-tokenizer');
const fs = require('fs');
const path = require('path');

const tok = (s) => encode(s).length;

// ---- Shared protected-span masking (order = most-specific first) ----
const MASK_PATTERNS = [
  /```[\s\S]*?```/g,          // fenced code
  /`[^`]*`/g,                 // inline code
  /https?:\/\/[^\s]+/g,       // URLs
  /[A-Za-z]:\\[^\s"]+/g,      // windows paths
  /"[^"]*"/g,                 // double-quoted strings
  /\b\w+(?:\.\w+)+\b/g,       // dotted identifiers: auth.js, example.com, 3.5, v2.0
];
function mask(text) {
  const store = [];
  let out = text;
  for (const re of MASK_PATTERNS) {
    out = out.replace(re, (m) => {
      const id = store.length;
      store.push(m);
      return `${id}`;
    });
  }
  return { out, store };
}
function unmask(text, store) {
  // restore in reverse so nested ids resolve correctly
  let out = text;
  for (let i = store.length - 1; i >= 0; i--) {
    out = out.replace(`${i}`, store[i]);
  }
  return out;
}

// ---- Layer A: lossless whitespace/format normalization ----
function layerA(text) {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/[ \t]{2,}/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

// ---- Layer B: token-aware dictionary substitution ----
function loadDict(tokenizer) {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'dict.json'), 'utf8'));
  const kept = [], dropped = [];
  for (const [k, v] of Object.entries(raw)) {
    // self-filter: keep only if replacement is STRICTLY fewer tokens
    if (tokenizer(v) < tokenizer(k)) kept.push([k, v]);
    else dropped.push([k, v]);
  }
  // longest key first so phrases beat their sub-phrases
  kept.sort((a, b) => b[0].length - a[0].length);
  return { kept, dropped };
}
function keyToRegex(key) {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`\\b${esc}\\b`, 'gi');
}
function matchCase(orig, repl) {
  if (!repl) return repl;
  return /^[A-Z]/.test(orig) ? repl[0].toUpperCase() + repl.slice(1) : repl;
}
// repair punctuation/casing debris left when deletion entries remove a word.
// meaning-lossless: touches only whitespace, orphan punctuation, and letter case.
function tidyPunct(text) {
  return text
    .replace(/[ \t]{2,}/g, ' ')                 // collapse runs
    .replace(/[ \t]+([,.;:!?])/g, '$1')         // space before punct
    .replace(/[,;:]+([.!?])/g, '$1')            // ",." ",!" -> "." "!"
    .replace(/([.!?])[ \t]*,+/g, '$1')          // ".," -> "."
    .replace(/,{2,}/g, ',')                     // double comma
    .replace(/(^|\n)[ \t]*[,.;:!?]+[ \t]*/g, '$1') // orphan punct at line start
    .replace(/([,.;:!?])([A-Za-z])/g, '$1 $2')  // re-space punct glued to a word
    .replace(/([.!?][ \t]+)([a-z])/g, (m, p, c) => p + c.toUpperCase()) // sentence case
    .replace(/^([ \t]*)([a-z])/, (m, p, c) => p + c.toUpperCase())
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n');
}
function layerB(text, dict) {
  const applied = [];
  let out = text;
  for (const [k, v] of dict) {
    const re = keyToRegex(k);
    out = out.replace(re, (m) => {
      applied.push([k, v]);
      return matchCase(m, v);
    });
  }
  return { out: tidyPunct(out), applied };
}

// ---- Full pipelines ----
function runA(text) {
  const { out, store } = mask(text);
  return unmask(layerA(out), store);
}
// Layer A is OFF by default (0% on real prose, per the experiment); opt in with clean=true
// only for text carrying junk whitespace (pasted logs, tables, indented dumps).
function runAB(text, dict, { clean = false } = {}) {
  const { out, store } = mask(text);
  const b = layerB(out, dict);
  const body = clean ? layerA(b.out) : b.out;
  return { text: unmask(body, store), applied: b.applied };
}

module.exports = { tok, mask, unmask, layerA, layerB, loadDict, runA, runAB };
