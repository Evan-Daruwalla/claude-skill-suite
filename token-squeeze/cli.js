#!/usr/bin/env node
// token-squeeze — deterministic, no-LLM English -> fewer-tokens compressor.
// Usage: node cli.js <file|-> [--clean] [--stats] [--json]
//   <file>   path to text file, or "-" to read stdin
//   --clean  also run Layer A whitespace reclamation (for pasted logs/tables)
//   --stats  print token before/after + guard report to stderr
//   --json   emit {input,output,tokensBefore,tokensAfter,savedPct,subs,guard}
const fs = require('fs');
const { tok, runAB, loadDict, mask } = require('./lib/pipeline');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: token-squeeze <file|-> [--clean] [--stats] [--json]');
  process.exit(1);
}
const input = fs.readFileSync(file === '-' ? 0 : file, 'utf8');

const { kept } = loadDict(tok);
const { text: output, applied } = runAB(input, kept, { clean: flags.has('--clean') });

// guard: numbers, negation/constraint words (any case), dotted identifiers,
// protected spans must survive; output must be idempotent (fixed point)
const { store } = mask(input);
const d = (s) => (s.match(/\d+/g) || []).sort().join(',');
const n = (s) => (s.match(/\b(no|not|never|must|cannot|can't|don't|won't|shouldn't|mustn't)\b/gi) || []).length;
const id = (s) => (s.match(/\b\w+(?:\.\w+)+\b/g) || []).sort().join(',');
const errs = [];
if (d(input) !== d(output)) errs.push('numbers changed');
if (n(input) !== n(output)) errs.push('negation/constraint word changed');
if (id(input) !== id(output)) errs.push('dotted identifier changed');
for (const s of store) if (!output.includes(s)) errs.push('protected span lost');
const { text: second } = runAB(output, kept, { clean: flags.has('--clean') });
if (second !== output) errs.push('not idempotent');

const before = tok(input), after = tok(output);
const savedPct = +(((1 - after / before) * 100).toFixed(1));

if (flags.has('--json')) {
  const subsDetail = {};
  for (const [k, v] of applied) { const key = `${k} -> ${v || '(deleted)'}`; subsDetail[key] = (subsDetail[key] || 0) + 1; }
  process.stdout.write(JSON.stringify({ input, output, tokensBefore: before, tokensAfter: after, savedPct, subs: applied.length, subsDetail, guard: errs.length ? errs : 'pass' }, null, 2));
} else {
  process.stdout.write(output);
}
if (flags.has('--stats')) {
  process.stderr.write(`\n[token-squeeze] ${before} -> ${after} tokens (${savedPct}% saved, o200k proxy), ${applied.length} substitutions, guard: ${errs.length ? 'FAIL ' + errs.join('; ') : 'pass'}\n`);
}
if (errs.length) process.exit(2); // non-zero so a guard failure is scriptable
