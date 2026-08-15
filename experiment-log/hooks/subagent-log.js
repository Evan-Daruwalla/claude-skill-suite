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

const LOG = path.join(process.env.USERPROFILE || process.env.HOME || __dirname, '.claude', 'agent-runs.jsonl');

function parseTranscript(file) {
  const out = {
    input_new: 0,       // uncached input + newly cached input, summed per message
    output_tokens: 0,   // generated tokens (incl. thinking), MAX per message id
    context_peak: 0,    // MAX over turns of cache_read + cache_creation
    tool_uses: 0,
    turns: 0,
    duration_ms: null
  };
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  } catch (_) {
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
    : { input_new: 0, output_tokens: 0, context_peak: 0, tool_uses: 0, turns: 0, duration_ms: null };
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
    result_head: typeof msg === 'string' ? msg.slice(0, 200) : null,
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
  t('every field present', Object.keys(e).length === 16);

  // missing transcript must degrade, not throw
  const e2 = buildEntry({ agent_transcript_path: path.join(dir, 'nope.jsonl'), agent_id: 'a2' });
  t('missing transcript yields zeros, no throw', e2.input_new === 0 && e2.duration_ms === null);

  const bad = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(bad, 'not json\n' + JSON.stringify({ type: 'assistant', message: { id: 'm9', usage: u1(20), content: [] } }) + '\n', 'utf8');
  t('malformed line skipped, valid line still counted', parseTranscript(bad).input_new === 110);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(fail === 0 ? `CANARY PASS ${pass}/${pass + fail}` : `CANARY FAIL ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

if (process.argv.includes('--canary')) {
  canary();
} else {
  let raw = '';
  // without this, an 'error' event on stdin is unhandled and exits non-zero
  // with a stack trace — the one path that could surface to the user
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => {
    try {
      const entry = buildEntry(JSON.parse(raw));
      fs.mkdirSync(path.dirname(LOG), { recursive: true });
      fs.appendFileSync(LOG, JSON.stringify(entry) + '\n', 'utf8');
    } catch (_) {
      // a logging failure must never block the turn
    }
    process.exit(0);
  });
}
