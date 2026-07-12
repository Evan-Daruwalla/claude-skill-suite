// Reproducible experiment + assertions. Run: node test.js
const fs = require('fs');
const path = require('path');
const { tok, loadDict, runAB, mask } = require('./lib/pipeline');

const CORPUS = path.join(__dirname, 'corpus');
const files = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.txt')).sort();
const { kept } = loadDict(tok);

const d = (s) => (s.match(/\d+/g) || []).sort().join(',');
const n = (s) => (s.match(/\bNOT\b|\bNEVER\b|\bMUST\b/g) || []).length;
const id = (s) => (s.match(/\b\w+(?:\.\w+)+\b/g) || []).sort().join(',');

let tC = 0, tB = 0, fails = 0;
for (const f of files) {
  const c = fs.readFileSync(path.join(CORPUS, f), 'utf8');
  const { text: o } = runAB(c, kept);
  const { store } = mask(c);
  const errs = [];
  if (d(c) !== d(o)) errs.push('numbers');
  if (n(c) !== n(o)) errs.push('negations');
  if (id(c) !== id(o)) errs.push('identifiers');
  for (const s of store) if (!o.includes(s)) errs.push('span');
  const cT = tok(c), bT = tok(o); tC += cT; tB += bT;
  const pct = ((1 - bT / cT) * 100).toFixed(1);
  console.log(`${f.padEnd(28)} ${String(cT).padStart(4)} -> ${String(bT).padStart(4)}  ${String(pct).padStart(5)}%  ${errs.length ? 'GUARD FAIL: ' + errs.join(',') : 'ok'}`);
  if (errs.length) fails++;
  // null case must never expand
  if (f.includes('nullcase') && bT > cT) { console.error('  ! null case expanded'); fails++; }
}
console.log(`TOTAL ${tC} -> ${tB} (${((1 - tB / tC) * 100).toFixed(1)}% saved, o200k proxy)`);
if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nAll guards passed.');
