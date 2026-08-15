#!/usr/bin/env node
// SubagentStop hook — appends one JSON line per finished subagent run.
//
// Why this exists: no published study measures bugs-caught vs token-cost for
// subagent review gates in real coding work (see
// D:\ClaudeCode\docs\research\2026-08-14_subagents-mcp-workflow.md). This builds
// that dataset locally, for free, as a side effect of normal work.
//
// The SubagentStop payload carries no usage numbers, so everything below is
// derived from the agent's own transcript; name/description/model come from the
// sibling .meta.json.
//
// Two transcript facts this depends on, both verified empirically against five
// real runs on 2026-08-14:
//   1. ONE API message is split across SEVERAL transcript lines, one per content
//      block, all sharing message.id, each carrying a COPY of the same usage.
//      So usage must be counted once per message.id, while tool_use blocks must
//      be counted across every line (deduping there undercounts to zero).
//   2. cache_read_input_tokens is cumulative — each turn re-reads the whole
//      cached prefix. Summing it across turns double-counts enormously
//      (517k vs an actual 78k on one run), so it is never summed, only read
//      from the final turn.
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
    output_tokens: 0,   // generated tokens (incl. thinking), summed per message
    context_peak: 0,    // final turn's total context: cache_read + cache_creation
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

  const seen = new Set();
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
    if (id && seen.has(id)) continue;   // usage already counted for this message
    if (id) seen.add(id);

    out.turns++;
    const u = o.message.usage || {};
    out.input_new += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    out.output_tokens += u.output_tokens || 0;
    out.context_peak = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }

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
  // m1 spans three lines (thinking + two tool_use) carrying one copy of usage each;
  // m2 is a later turn whose cache_read has grown to include m1's cached prefix.
  const u1 = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 20 };
  const u2 = { input_tokens: 2, cache_creation_input_tokens: 50, cache_read_input_tokens: 100, output_tokens: 7 };
  fs.writeFileSync(tp, [
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z', message: { id: 'm1', usage: u1, content: [{ type: 'thinking' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z', message: { id: 'm1', usage: u1, content: [{ type: 'tool_use' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:01.000Z', message: { id: 'm1', usage: u1, content: [{ type: 'tool_use' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:02.000Z', message: { content: [{ type: 'tool_result' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:03.000Z', message: { id: 'm2', usage: u2, content: [{ type: 'text' }] } })
  ].join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'agent-x.meta.json'), JSON.stringify({ agentType: 'general-purpose', name: 'probe', description: 'd', model: 'haiku' }), 'utf8');

  const s = parseTranscript(tp);
  t('input_new sums per unique message', s.input_new === 162);          // (10+100) + (2+50)
  t('output sums per unique message', s.output_tokens === 27);          // 20 + 7
  t('context_peak from final turn only', s.context_peak === 150);       // 100 + 50, never summed
  t('cache_read never summed across turns', s.context_peak !== 250);
  t('usage counted once per message.id', s.turns === 2);
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
  fs.writeFileSync(bad, 'not json\n' + JSON.stringify({ type: 'assistant', message: { id: 'm9', usage: u1, content: [] } }) + '\n', 'utf8');
  t('malformed line skipped, valid line still counted', parseTranscript(bad).input_new === 110);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(fail === 0 ? `CANARY PASS ${pass}/${pass + fail}` : `CANARY FAIL ${pass}/${pass + fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

if (process.argv.includes('--canary')) {
  canary();
} else {
  let raw = '';
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
