#!/usr/bin/env node
/*
 * agent-runs — read and annotate the subagent cost log that
 * hooks/subagent-log.js writes to ~/.claude/agent-runs.jsonl.
 *
 * The log measures COST automatically and cannot measure VALUE: `finding` is
 * null on every row by design, because only a person who checked the agent's
 * output knows whether it caught anything real. This is the missing half — a
 * way to record value without rewriting the log, and a reader that counts right.
 *
 * Three things a naive read of the raw file gets wrong (measured 2026-09-10 on
 * 1,531 rows):
 *
 *  1. About half the rows are NOT WORK. 798 rows carry no agent_type, no
 *     description and zero usage, and their result_head reads like "do all",
 *     "3", "go M2" or the literal "<no suggestion>" — the harness's
 *     prompt-suggestion agent guessing the user's next message. Counted as
 *     subagents they double the run count, and they made an all-zero row look
 *     like "a real run whose cost was lost" when 798 of 807 were not work.
 *  2. A row is a STOP, not an agent. An agent resumed with SendMessage stops
 *     again and is logged again (29 agent_ids appear more than once). Its token
 *     count is USUALLY cumulative — 26 of those 29 never decrease — but 3 drop
 *     sharply between stops (40,895 -> 7,090), so neither summing the stops nor
 *     taking the last one is safe. The reader counts each agent's MAXIMUM
 *     across stops: exact when the field is cumulative, and a floor rather
 *     than a double-count when it is not.
 *  3. Annotations must never rewrite the log. It is append-only and live, and
 *     a rewrite would race the hook. Verdicts go in a SIDECAR,
 *     ~/.claude/agent-findings.jsonl, joined at read time; the latest verdict
 *     for an agent wins.
 *
 * Usage:
 *   node agent-runs.js list [--unannotated] [--all] [--session <id>] [--since <iso>] [--limit <n>]
 *   node agent-runs.js annotate <agent_id> <verdict> <note...>
 *   node agent-runs.js report
 *   node agent-runs.js --canary
 *   --runs <file> and --findings <file> override the default paths.
 *
 * Verdicts — annotate ONLY what you verified, and the note must say how:
 *   caught  reported at least one issue later confirmed real; none refuted
 *   mixed   some confirmed real, at least one refuted
 *   wrong   what it reported was refuted
 *   clean   reported nothing, and nothing was later found in its scope
 *   n/a     not a review at all: extraction, planning, drafting
 *
 * Exit 0 ok · 1 refused (unknown agent, suggestion row) · 2 usage error.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const DEFAULT_RUNS = path.join(CLAUDE_DIR, 'agent-runs.jsonl');
const DEFAULT_FINDINGS = path.join(CLAUDE_DIR, 'agent-findings.jsonl');
const VERDICTS = ['caught', 'mixed', 'wrong', 'clean', 'n/a'];

// Unparseable lines are COUNTED, never silently dropped: a reader that loses
// rows without saying so is the failure this file exists to correct.
function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { rows: [], bad: 0, missing: true };
    throw e;
  }
  const rows = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { bad++; }
  }
  return { rows, bad, missing: false };
}

// The prompt-suggestion agent's signature. ALL FOUR conditions, so a real work
// agent whose transcript was lost (typed, described, zero usage — 9 such rows
// exist) is never misread as a suggestion.
function isSuggestion(r) {
  return !!r && r.agent_type == null && r.description == null &&
    !r.input_new && !r.output_tokens && !r.turns;
}

// One entry per agent. `last` is its latest stop by timestamp (for the result
// and the time — not file order, a late append can land first); `maxOut` is
// its highest output_tokens across stops (see point 2 above); `stops` counts
// how many times it was logged.
function agentsOf(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!r || !r.agent_id) continue;
    const out = r.output_tokens || 0;
    const cur = by.get(r.agent_id);
    if (!cur) { by.set(r.agent_id, { last: r, stops: 1, maxOut: out }); continue; }
    cur.stops++;
    if (out > cur.maxOut) cur.maxOut = out;
    if (String(r.ts) >= String(cur.last.ts)) cur.last = r;
  }
  return [...by.values()];
}

// Latest verdict per agent wins; ties go to the later line.
function findingsOf(rows) {
  const latest = new Map();
  for (const f of rows) {
    if (!f || !f.agent_id) continue;
    const cur = latest.get(f.agent_id);
    if (!cur || String(f.ts) >= String(cur.ts)) latest.set(f.agent_id, f);
  }
  return latest;
}

function annotate(runsFile, findingsFile, agentId, verdict, note, now = new Date()) {
  if (!VERDICTS.includes(verdict)) {
    return { ok: false, code: 2, msg: `verdict must be one of: ${VERDICTS.join(', ')}` };
  }
  if (!note || !String(note).trim()) {
    return { ok: false, code: 2, msg: 'a note is required: say HOW the verdict was verified' };
  }
  const hits = readJsonl(runsFile).rows.filter((r) => r && r.agent_id === agentId);
  if (!hits.length) return { ok: false, code: 1, msg: `no run with agent_id ${agentId} in ${runsFile}` };
  if (hits.every(isSuggestion)) {
    return { ok: false, code: 1, msg: `${agentId} is a prompt-suggestion row, not a work agent — nothing to annotate` };
  }
  const entry = { ts: now.toISOString(), agent_id: agentId, verdict, note: String(note).trim() };
  fs.mkdirSync(path.dirname(findingsFile), { recursive: true });
  fs.appendFileSync(findingsFile, JSON.stringify(entry) + '\n', 'utf8');
  return { ok: true, entry };
}

function report(runsFile, findingsFile) {
  const runs = readJsonl(runsFile);
  const found = findingsOf(readJsonl(findingsFile).rows);
  const suggestionRows = runs.rows.filter(isSuggestion).length;
  const agents = agentsOf(runs.rows.filter((r) => !isSuggestion(r)));
  const byVerdict = {};
  let annotated = 0;
  for (const a of agents) {
    const f = found.get(a.last.agent_id);
    if (f) annotated++;
    const key = f ? f.verdict : '(unannotated)';
    const b = byVerdict[key] || (byVerdict[key] = { agents: 0, output_tokens: 0 });
    b.agents++;
    b.output_tokens += a.maxOut;
  }
  return {
    rows: runs.rows.length, badLines: runs.bad, suggestionRows,
    workRows: runs.rows.length - suggestionRows, workAgents: agents.length,
    resumedAgents: agents.filter((a) => a.stops > 1).length, annotated, byVerdict,
  };
}

function list(runsFile, findingsFile, o = {}) {
  const runs = readJsonl(runsFile).rows.filter((r) => o.all || !isSuggestion(r));
  const found = findingsOf(readJsonl(findingsFile).rows);
  let agents = agentsOf(runs);
  if (o.session) agents = agents.filter((a) => a.last.session_id === o.session);
  if (o.since) agents = agents.filter((a) => String(a.last.ts) >= o.since);
  if (o.unannotated) agents = agents.filter((a) => !found.has(a.last.agent_id));
  agents.sort((x, y) => String(y.last.ts).localeCompare(String(x.last.ts)));
  if (o.limit) agents = agents.slice(0, o.limit);
  return agents.map((a) => {
    const r = a.last;
    const f = found.get(r.agent_id);
    const head = String(r.result_head || '').replace(/\s+/g, ' ').slice(0, 90);
    return `${String(r.ts).slice(0, 16)}  ${r.agent_id}  ${f ? f.verdict : '-'}  ` +
      `${r.agent_type || 'suggestion'}  out=${a.maxOut}  stops=${a.stops}  ` +
      `${r.description || ''}\n    ${head}`;
  });
}

function canary() {
  let pass = 0, fail = 0;
  const t = (name, cond) => { if (cond) pass++; else { fail++; console.error('FAIL: ' + name); } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentruns-'));
  const runsF = path.join(dir, 'runs.jsonl');
  const findF = path.join(dir, 'findings.jsonl');

  const work = (id, ts, out, extra = {}) => JSON.stringify({
    ts, session_id: 's', agent_id: id, agent_type: 'general-purpose',
    description: 'audit ' + id, input_new: out * 3, output_tokens: out, turns: 4,
    result_head: 'findings for ' + id, finding: null, ...extra,
  });
  const lines = [
    // a1's LATER stop is written FIRST: the last stop is chosen by ts, not order
    work('a1', '2026-01-01T02:00:00Z', 250),
    work('a1', '2026-01-01T01:00:00Z', 100),
    JSON.stringify({ ts: '2026-01-01T03:00:00Z', session_id: 's', agent_id: 's1',
      agent_type: null, description: null, input_new: 0, output_tokens: 0, turns: 0,
      result_head: 'do all', finding: null }),
    // a real agent whose transcript was lost: typed + described, zero usage
    JSON.stringify({ ts: '2026-01-01T04:00:00Z', session_id: 's', agent_id: 'e1',
      agent_type: 'general-purpose', description: 'eval sample', input_new: 0,
      output_tokens: 0, turns: 0, result_head: 'draft', finding: null }),
    '{ this line is not json',
    work('b1', '2026-01-01T05:00:00Z', 40) + '\r',     // a CRLF line still parses
    // r1's count DROPS between stops, as 3 real agents' do
    work('r1', '2026-01-01T06:00:00Z', 300),
    work('r1', '2026-01-01T07:00:00Z', 50),
  ];
  fs.writeFileSync(runsF, lines.join('\n') + '\n', 'utf8');
  const rows = readJsonl(runsF).rows;

  // 1. classification — the reason this file exists
  t('a prompt-suggestion row is recognised', isSuggestion(rows.find((r) => r.agent_id === 's1')));
  t('a typed, zero-usage row is WORK (lost transcript), not a suggestion',
    !isSuggestion(rows.find((r) => r.agent_id === 'e1')));
  t('an ordinary work row is not a suggestion', !isSuggestion(rows.find((r) => r.agent_id === 'b1')));

  // 2. a row is a STOP, not an agent
  const ag = agentsOf(rows);
  const a1 = ag.find((a) => a.last.agent_id === 'a1');
  const r1 = ag.find((a) => a.last.agent_id === 'r1');
  t('two stops of one agent collapse to one agent', a1 && a1.stops === 2);
  t('the LAST stop is chosen by timestamp, not by file order', a1 && a1.last.output_tokens === 250);
  t('a count that DROPS between stops keeps its maximum, not its last value',
    r1 && r1.last.output_tokens === 50 && r1.maxOut === 300);

  // 3. the report counts correctly
  let r = report(runsF, findF);
  t('unparseable lines are COUNTED, not dropped', r.badLines === 1);
  t('a CRLF line is still read', r.rows === 7);
  t('suggestion rows are separated from work', r.suggestionRows === 1 && r.workRows === 6);
  t('work agents are deduplicated', r.workAgents === 4 && r.resumedAgents === 2);
  t('tokens are each agent\'s MAXIMUM, never a sum of stops',
    r.byVerdict['(unannotated)'].output_tokens === 250 + 0 + 40 + 300);
  t('a missing findings file reads as zero annotations', r.annotated === 0);

  // 4. annotate refuses anything it cannot stand behind
  t('an unknown agent is refused', annotate(runsF, findF, 'zz', 'caught', 'x').code === 1);
  t('a verdict outside the vocabulary is refused', annotate(runsF, findF, 'a1', 'great', 'x').code === 2);
  t('an empty note is refused', annotate(runsF, findF, 'a1', 'caught', '  ').code === 2);
  t('a prompt-suggestion row cannot be annotated', annotate(runsF, findF, 's1', 'n/a', 'x').code === 1);

  // 5. annotate appends to the SIDECAR and never touches the log
  const before = fs.readFileSync(runsF);
  const ok1 = annotate(runsF, findF, 'a1', 'caught', 'first look', new Date('2026-01-02T00:00:00Z'));
  t('a valid annotation is accepted', ok1.ok === true);
  t('the run log is byte-identical after annotating', before.equals(fs.readFileSync(runsF)));
  annotate(runsF, findF, 'a1', 'mixed', 'one claim refuted on re-check', new Date('2026-01-03T00:00:00Z'));
  r = report(runsF, findF);
  t('the LATEST verdict for an agent wins', r.byVerdict.mixed && r.byVerdict.mixed.agents === 1 && !r.byVerdict.caught);
  t('annotated count is per agent, not per annotation line', r.annotated === 1);
  t('--unannotated drops an annotated agent',
    !list(runsF, findF, { unannotated: true }).some((l) => l.includes(' a1 ')));
  t('list hides suggestion rows unless --all',
    !list(runsF, findF).some((l) => l.includes(' s1 ')) &&
    list(runsF, findF, { all: true }).some((l) => l.includes(' s1 ')));

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  console.log(fail === 0 ? `CANARY PASS ${pass}/${pass + fail}` : `CANARY FAIL ${pass}/${pass + fail}`);
  return fail === 0 ? 0 : 1;
}

function main(argv) {
  if (argv.includes('--canary')) return canary();
  const opt = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : argv[i + 1]; };
  const runsFile = opt('--runs') || DEFAULT_RUNS;
  const findingsFile = opt('--findings') || DEFAULT_FINDINGS;
  const cmd = argv[0];

  if (cmd === 'annotate') {
    const [, id, verdict, ...rest] = argv.filter((a, i) =>
      !['--runs', '--findings'].includes(a) && !['--runs', '--findings'].includes(argv[i - 1]));
    const res = annotate(runsFile, findingsFile, id, verdict, rest.join(' '));
    if (!res.ok) { console.error('agent-runs: REFUSED — ' + res.msg); return res.code; }
    console.log(`annotated ${res.entry.agent_id}: ${res.entry.verdict} — ${res.entry.note}`);
    return 0;
  }
  if (cmd === 'report') {
    const r = report(runsFile, findingsFile);
    console.log(`rows ${r.rows} (unparseable ${r.badLines}) · prompt-suggestion rows ${r.suggestionRows} · work rows ${r.workRows}`);
    console.log(`work agents ${r.workAgents} (resumed ${r.resumedAgents}) · annotated ${r.annotated}`);
    for (const [v, b] of Object.entries(r.byVerdict).sort((x, y) => y[1].agents - x[1].agents)) {
      console.log(`  ${v.padEnd(14)} agents ${String(b.agents).padStart(5)}   output tokens ${b.output_tokens}`);
    }
    return 0;
  }
  if (cmd === 'list') {
    const lim = opt('--limit');
    for (const l of list(runsFile, findingsFile, {
      unannotated: argv.includes('--unannotated'), all: argv.includes('--all'),
      session: opt('--session'), since: opt('--since'), limit: lim ? Number(lim) : null,
    })) console.log(l);
    return 0;
  }
  console.error('usage: agent-runs.js list [--unannotated] [--all] [--session <id>] [--since <iso>] [--limit <n>]\n' +
    '       agent-runs.js annotate <agent_id> <verdict> <note...>   (verdicts: ' + VERDICTS.join(', ') + ')\n' +
    '       agent-runs.js report | --canary');
  return 2;
}

module.exports = { readJsonl, isSuggestion, agentsOf, findingsOf, annotate, report, list };
if (require.main === module) process.exit(main(process.argv.slice(2)));
