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

// self-test: a lossy compressor is only safe if its guards actually hold, so
// prove them on planted fixtures rather than trusting the corpus run.
// Must run BEFORE the <file> check below, which exits when no path is given.
if (flags.has('--canary')) process.exit(runCanary() ? 0 : 1);

function runCanary() {
  const { unmask } = require('./lib/pipeline');
  const { kept: K } = loadDict(tok);
  let pass = 0, fail = 0;
  const check = (c, d) => { if (c) pass++; else { fail++; console.log('  FAIL: ' + d); } };
  const sq = (s) => runAB(s, K).text;
  const nums = (s) => (s.match(/\d+/g) || []).sort().join(',');
  const negs = (s) => (s.match(/\b(no|not|never|must|cannot|can't|don't|won't|shouldn't|mustn't)\b/gi) || []).length;
  const dots = (s) => (s.match(/\b\w+(?:\.\w+)+\b/g) || []).sort().join(',');

  check(K && Object.keys(K).length > 0, 'dictionary loads with at least one entry');

  // every protected span class must survive verbatim
  const spans = {
    'fenced code': 'text\n```\nconst x = 1; // in order to\n```\nmore',
    'inline code': 'use `in order to` here',
    URL: 'see https://example.com/a?b=in+order+to now',
    'windows path': 'at C:\\Users\\a\\b.txt now',
    'quoted string': 'he said "in order to" loudly',
    'dotted identifier': 'call auth.js and v2.0 now',
  };
  for (const [label, src] of Object.entries(spans)) {
    const { store } = mask(src);
    const out = sq(src);
    check(store.length > 0 && store.every((s) => out.includes(s)), `${label} survives compression`);
  }

  // semantic guards: a dropped negation inverts meaning, a changed number lies
  const prose = 'You must not use this in order to bypass the gate, due to the fact '
    + 'that it will drop 42 rows and 7 columns at this point in time.';
  const out = sq(prose);
  check(nums(prose) === nums(out), 'numbers are preserved exactly');
  check(negs(prose) === negs(out), 'negation/constraint words are preserved');
  check(dots(prose) === dots(out), 'dotted identifiers are preserved');
  check(tok(out) < tok(prose), 'prose actually gets shorter (compression happens)');
  check(sq(out) === out, 'output is a fixed point (idempotent)');

  // mask/unmask must round-trip exactly, or protected spans corrupt silently
  const m = mask(prose);
  check(unmask(m.out, m.store) === prose, 'mask -> unmask round-trips exactly');

  // degenerate inputs must not throw
  let survived = true;
  for (const s of ['', '\n\n', '   ', 'ok', '\u00e9\u00e0\u4e2d\u6587 \ud83d\ude80', '```\n```']) {
    try { sq(s); } catch (e) { survived = false; console.log('    threw on: ' + JSON.stringify(s)); }
  }
  check(survived, 'empty / whitespace / unicode / empty-fence inputs do not throw');
  check(sq('\u00e9\u00e0\u4e2d\u6587 \ud83d\ude80').includes('\ud83d\ude80'), 'non-ASCII and emoji survive');

  const ok = fail === 0;
  console.log(`CANARY ${ok ? 'PASS' : 'FAIL'} ${pass}/${pass + fail}`);
  return ok;
}

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
