#!/usr/bin/env node
// SubagentStop hook — appends one JSON line per finished subagent run.
//
// Why this exists: no published study measures bugs-caught vs token-cost for
// subagent review gates in real coding work (see
// the project's research brief). This builds
// that dataset locally, for free, as a side effect of normal work.
//
// The SubagentStop payload carries no usage numbers, so everything below is
// derived from the agent's own transcript; name/description/model come from the
// sibling .meta.json.
//
// Three transcript facts this depends on. The first two were written from five
// runs on 2026-08-14 and were PARTLY WRONG; corrected 2026-08-15 against 409
// real transcripts, which is the sample size that exposed the error:
//   1. ONE API message is split across SEVERAL transcript lines, one per content
//      block, all sharing message.id. tool_use blocks must be counted across
//      every line (deduping there undercounts to zero).
//   2. Three usage fields ARE identical on every line of a message —
//      input_tokens, cache_creation_input_tokens, cache_read_input_tokens
//      (differ in 0 of 6,335 multi-line ids). Those are deduped per id.
//   3. output_tokens is NOT. It STREAMS: the first line holds a partial count,
//      the last holds the total, and the max is on the last line in 100% of
//      multi-line ids. The original "each line carries a copy of the same
//      usage" claim was false for exactly this field, and taking the first
//      line undercounted the aggregate by 86% (345x on one transcript). It is
//      taken as the MAX per message.id.
//      That wrong version shipped GREEN: the canary's fixture gave every split
//      line identical usage, so 15/15 tested the assumption rather than the
//      behaviour. The fixture now streams 5 -> 12 -> 20.
//   4. cache_read_input_tokens is cumulative but NOT monotonic — each turn
//      re-reads the cached prefix, so summing double-counts enormously (517k
//      vs an actual 78k), but the final turn is not the peak either (28/409
//      transcripts) and a terminal `<synthetic>` message with all-zero usage
//      would reset it to 0. context_peak is the running MAX.
//
// Deliberately NOT reproduced: the harness's own `subagent_tokens` figure. No
// combination of these fields matched it across all five runs (closest was
// 14-105 tokens under, inconsistently), and its definition is undocumented.
// Guessing an aggregate would be inventing a number, so the exact components
// are logged instead and any aggregate can be computed later.
//
// Never blocks a turn: every failure path exits 0 silently.
'use strict';

const fs = require('fs');
const path = require('path');

// os.homedir() before __dirname. With both env vars unset the old fallback
// wrote the dataset into <hook-dir>/.claude/agent-runs.jsonl — inside the
// version-controlled skill directory — splitting the log in two with no signal.
// If there is no home at all, there is no correct place to write, so don't.
const HOME_DIR = process.env.USERPROFILE || process.env.HOME || require('os').homedir() || '';
const LOG = HOME_DIR ? path.join(HOME_DIR, '.claude', 'agent-runs.jsonl') : null;

function parseTranscript(file) {
  const out = {
    input_new: 0,       // uncached input + newly cached input, summed per message
    output_tokens: 0,   // generated tokens (incl. thinking), MAX per message id
    context_peak: 0,    // MAX over turns of cache_read + cache_creation
    tool_uses: 0,
    turns: 0,
    duration_ms: null,
    // 'parsed' | 'absent' | 'unreadable' | 'no-usage'. Without this an
    // unreadable transcript produced input_new:0, output_tokens:0, turns:0 —
    // BYTE-IDENTICAL to a genuinely cheap run. Measured on the live dataset
    // 2026-08-20: 120 of 314 rows (38%) were all-zero and ALL 120 carried a
    // result_head, so the agent demonstrably ran. A cost dataset that silently
    // records 38% of its runs as free is not a cost dataset.
    transcript: 'parsed'
  };
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  } catch (e) {
    out.transcript = (e && e.code === 'ENOENT') ? 'absent' : 'unreadable';
    return out;
  }

  // output_tokens is the ONE usage field that differs across the lines of a
  // split message: it streams, so the first line carries a partial count and
  // the last carries the total. Verified over 409 real transcripts (2026-08-15):
  // 6,335 multi-line ids, output_tokens differs in 4,855 of them, max is on the
  // last line in 6,335/6,335, and input/cache_creation/cache_read differ in ZERO.
  // So usage is deduped per id (correct for the other three fields) while
  // output_tokens is taken as the MAX seen for that id. Taking the first line's
  // value — the previous behaviour — undercounted the aggregate by 86.3%.
  const seen = new Set();
  const outById = new Map();
  let first = null, last = null;

  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }

    if (o.timestamp) {
      const t = Date.parse(o.timestamp);
      if (!isNaN(t)) {
        if (first === null || t < first) first = t;
        if (last === null || t > last) last = t;
      }
    }

    if (o.type !== 'assistant' || !o.message) continue;

    // tool_use blocks live on their own lines sharing the message.id above —
    // counted before the dedup, or they vanish
    const content = o.message.content;
    if (Array.isArray(content)) {
      for (const b of content) if (b && b.type === 'tool_use') out.tool_uses++;
    }

    const id = o.message.id;
    const u = o.message.usage || {};

    // output_tokens and context_peak are read on EVERY line, before the dedup:
    // the former because it streams (see above), the latter because cache_read
    // is not strictly monotonic — the final turn is not always the peak
    // (28/409 transcripts), and a terminal `<synthetic>` message with all-zero
    // usage would otherwise reset it to 0.
    if (id) outById.set(id, Math.max(outById.get(id) || 0, u.output_tokens || 0));
    else out.output_tokens += u.output_tokens || 0;
    out.context_peak = Math.max(
      out.context_peak,
      (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    );

    if (id && seen.has(id)) continue;   // usage already counted for this message
    if (id) seen.add(id);

    out.turns++;
    out.input_new += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }

  for (const v of outById.values()) out.output_tokens += v;

  // A transcript we could READ but that carried no usage at all is a third
  // state: the file exists and parses, and still tells us nothing about cost.
  // Left as 'parsed' it would be another silent zero.
  if (out.turns === 0 && out.output_tokens === 0 && out.input_new === 0) out.transcript = 'no-usage';

  if (first !== null && last !== null) out.duration_ms = last - first;
  return out;
}

function readMeta(transcriptPath) {
  try {
    return JSON.parse(fs.readFileSync(transcriptPath.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch (_) {
    return {};
  }
}

function buildEntry(payload) {
  const tp = payload.agent_transcript_path || '';
  const meta = tp ? readMeta(tp) : {};
  const stats = tp ? parseTranscript(tp)
    : { input_new: 0, output_tokens: 0, context_peak: 0, tool_uses: 0, turns: 0, duration_ms: null, transcript: 'none-declared' };
  const msg = payload.last_assistant_message;

  return {
    ts: new Date().toISOString(),
    session_id: payload.session_id || null,
    agent_id: payload.agent_id || null,
    agent_type: payload.agent_type || meta.agentType || null,
    name: meta.name || null,
    description: meta.description || null,
    // absent in meta.json when the agent inherited the session model
    model: meta.model || null,
    cwd: payload.cwd || null,
    input_new: stats.input_new,
    output_tokens: stats.output_tokens,
    context_peak: stats.context_peak,
    tool_uses: stats.tool_uses,
    turns: stats.turns,
    // transcript-derived: excludes spawn overhead, so slightly under the
    // harness-reported duration_ms
    duration_ms: stats.duration_ms,
    // WHY the numbers above are what they are. 'parsed' means they are real;
    // anything else means the zeros are ignorance, not cheapness.
    transcript: stats.transcript || 'parsed',
    // Array.from, not slice: slice(0,200) cuts at a UTF-16 code UNIT, so an
    // emoji landing on the boundary left a LONE SURROGATE in the line. Every
    // downstream reader then died — Python json.dumps().encode('utf-8'),
    // str.encode, and a UTF-8 csv write all raise "surrogates not allowed".
    // One bad line breaks the whole dataset for those readers.
    result_head: typeof msg === 'string' ? Array.from(msg).slice(0, 200).join('') : null,
    // for hand-annotation later: did this run catch something real?
    finding: null
  };
}

function canary() {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sublog-'));
  let pass = 0, fail = 0;
  const t = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL: ' + name); } };

  const tp = path.join(dir, 'agent-x.jsonl');
  // m1 spans three lines (thinking + two tool_use). Its output_tokens STREAMS —
  // 5, 12, then the true total 20 — which is the shape that made the old
  // first-line dedup undercount by 86%. The other three usage fields are
  // identical across the lines, exactly as real transcripts have them.
  // m3 is a terminal `<synthetic>` message with all-zero usage: it makes the
  // final turn NOT the peak, so a `context_peak` that merely reads the last
  // turn scores 0 here and fails.
  const u1 = (out) => ({ input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: out });
  const u2 = { input_tokens: 2, cache_creation_input_tokens: 50, cache_read_input_tokens: 100, output_tokens: 7 };
  const u3 = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  fs.writeFileSync(tp, [
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z', message: { id: 'm1', usage: u1(5), content: [{ type: 'thinking' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z', message: { id: 'm1', usage: u1(12), content: [{ type: 'tool_use' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z', message: { id: 'm1', usage: u1(20), content: [{ type: 'tool_use' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:02.000Z', message: { content: [{ type: 'tool_result' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:03.000Z', message: { id: 'm2', usage: u2, content: [{ type: 'text' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:03.000Z', message: { id: 'm3', usage: u3, model: '<synthetic>', content: [{ type: 'text' }] } })
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'agent-x.meta.json'), JSON.stringify({ agentType: 'general-purpose', name: 'probe', description: 'd', model: 'haiku' }), 'utf8');

  const s = parseTranscript(tp);
  t('input_new sums per unique message', s.input_new === 162);          // (10+100) + (2+50) + 0
  t('output takes MAX per id, not first line', s.output_tokens === 27); // max(5,12,20) + 7 + 0
  t('output is NOT the first line per id', s.output_tokens !== 12);     // 5 + 7 = the old bug
  t('context_peak is the MAX turn', s.context_peak === 150);            // 100+50, not the 0 final turn
  t('zero-usage final turn does not reset peak', s.context_peak !== 0);
  t('cache_read never summed across turns', s.context_peak !== 250);
  t('usage counted once per message.id', s.turns === 3);
  t('tool_use counted across split lines', s.tool_uses === 2);          // the bug this caught
  t('duration from first/last timestamp', s.duration_ms === 3000);

  const e = buildEntry({ agent_transcript_path: tp, agent_id: 'a1', session_id: 's1', cwd: 'C:/x', last_assistant_message: 'z'.repeat(500) });
  t('meta name merged', e.name === 'probe');
  t('meta model merged', e.model === 'haiku');
  t('agent_type falls back to meta', e.agent_type === 'general-purpose');
  t('result_head truncated to 200', e.result_head.length === 200);
  t('finding left null for annotation', e.finding === null);
  // Named, not counted: `length === 16` told you a field was missing but never
  // which one, and it silently accepted a rename.
  const EXPECTED_KEYS = ['ts', 'session_id', 'agent_id', 'agent_type', 'name', 'description',
    'model', 'cwd', 'input_new', 'output_tokens', 'context_peak', 'tool_uses', 'turns',
    'duration_ms', 'transcript', 'result_head', 'finding'];
  const missing = EXPECTED_KEYS.filter((k) => !(k in e));
  const extra = Object.keys(e).filter((k) => EXPECTED_KEYS.indexOf(k) < 0);
  t('every field present' + (missing.length ? ' (missing: ' + missing.join(',') + ')' : '') +
    (extra.length ? ' (unexpected: ' + extra.join(',') + ')' : ''),
    missing.length === 0 && extra.length === 0);

  // missing transcript must degrade, not throw
  const e2 = buildEntry({ agent_transcript_path: path.join(dir, 'nope.jsonl'), agent_id: 'a2' });
  t('missing transcript yields zeros, no throw', e2.input_new === 0 && e2.duration_ms === null);

  const bad = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(bad, 'not json\n' + JSON.stringify({ type: 'assistant', message: { id: 'm9', usage: u1(20), content: [] } }) + '\n', 'utf8');
  t('malformed line skipped, valid line still counted', parseTranscript(bad).input_new === 110);

  // ---- 2026-08-20 audit -------------------------------------------------
  // (a) zeros must carry their REASON. 38% of the live dataset was all-zero
  //     and indistinguishable from a cheap run.
  t('a parsed transcript is labelled parsed', parseTranscript(tp).transcript === 'parsed');
  t('an ABSENT transcript says so', parseTranscript(path.join(dir, 'nope.jsonl')).transcript === 'absent');
  t('an absent transcript is not silently zero-cost', e2.transcript === 'absent');
  const dirAsTranscript = parseTranscript(dir);            // EISDIR, not ENOENT
  t('an UNREADABLE transcript is distinguished from an absent one',
    dirAsTranscript.transcript === 'unreadable');
  const emptyT = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(emptyT, '\n', 'utf8');
  t('a readable transcript with no usage says no-usage', parseTranscript(emptyT).transcript === 'no-usage');
  t('a run with no declared transcript says none-declared',
    buildEntry({ agent_id: 'a3' }).transcript === 'none-declared');

  // (b) result_head must never end in a lone surrogate — a single such line
  //     makes the whole file unreadable to Python and to any UTF-8 csv writer.
  const rocket = '\u{1F680}';
  const e3 = buildEntry({ agent_id: 'a4', last_assistant_message: 'x'.repeat(199) + rocket + 'tail' });
  const head = e3.result_head;
  t('result_head cuts on characters, not code units', Array.from(head).length === 200);
  t('result_head contains no lone surrogate',
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(head));
  t('result_head survives a JSON round-trip intact', JSON.parse(JSON.stringify({ h: head })).h === head);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(fail === 0 ? `CANARY PASS ${pass}/${pass + fail}` : `CANARY FAIL ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

if (process.argv.includes('--canary')) {
  canary();
} else {
  // Self-imposed deadline, under the harness's 5,000 ms hook budget. With stdin
  // held open this process ran to 9,085 ms and only the harness ended it, which
  // DROPS the entry — a run that cost real tokens vanishes from the cost
  // dataset. Exiting on our own terms at 4 s keeps the failure visible as a
  // missing line rather than a killed process. .unref() so the timer never
  // holds the process open on the normal path.
  setTimeout(() => process.exit(0), 4000).unref();

  // Buffer chunks, do NOT concatenate as strings: `raw += chunk` decodes each
  // 64 KiB Buffer independently, so a multi-byte character straddling the
  // boundary is destroyed. Measured: U+1F680 starting at byte 65534 logged a
  // cwd ending "���Q".
  const chunks = [];
  // without this, an 'error' event on stdin is unhandled and exits non-zero
  // with a stack trace — the one path that could surface to the user
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  process.stdin.on('end', () => {
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      const payload = JSON.parse(raw);
      // stdin `5` (a bare scalar) used to write a fully-null phantom row.
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) process.exit(0);
      const entry = buildEntry(payload);
      if (!LOG) process.exit(0);          // no home dir: nowhere correct to write
      fs.mkdirSync(path.dirname(LOG), { recursive: true });
      fs.appendFileSync(LOG, JSON.stringify(entry) + '\n', 'utf8');
    } catch (_) {
      // a logging failure must never block the turn
    }
    process.exit(0);
  });
}
