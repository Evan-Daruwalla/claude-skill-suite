#!/usr/bin/env node
/*
 * deck-check.js - hard checks on a finished .pptx, measured by PowerPoint itself.
 *
 *   node deck-check.js <deck.pptx> [--renders <dir>] [--json <out.json>]
 *   node deck-check.js --measured <measurements.json>   re-check offline, no PowerPoint
 *   node deck-check.js --live-check                     build a known-bad deck in PowerPoint, prove every check fires
 *   node deck-check.js --canary                         pure self-test, no PowerPoint
 *
 * measure-deck.ps1 opens the deck read-only in the installed PowerPoint (COM),
 * so text heights are PowerPoint's own layout (TextRange2.BoundHeight), not an
 * estimate. That matters: text pushed past the slide edge is invisible in a
 * slide render, and pptxgenjs `fit:'shrink'` only writes a flag PowerPoint does
 * not apply on open (both measured 2026-09-25, see the research brief).
 *
 * HARD (exit 1): text overflowing its box or the slide; text under 18 pt
 * (Microsoft) unless the shape name starts with "caption" (floor 12 pt, this
 * skill's own choice); WCAG 2.2 contrast under 4.5:1, or 3:1 for large text
 * (>= 18 pt, or >= 14 pt bold), including text over the slide background, which
 * PowerPoint's own Accessibility Checker skips; a missing or duplicate slide
 * title; a picture or chart with no alt text that is not marked decorative.
 * WARN: large text under WCAG AAA's 4.5:1; contrast not computable (picture,
 * gradient or see-through fill behind the text); overlapping text; a non-text
 * shape off the slide; a font not installed on this machine; a picture marked
 * decorative by its name only.
 * INFO: words per slide and speaker-notes coverage. Reported, never enforced:
 * no study supports a words-per-slide limit.
 *
 * Exit 0 = no HARD findings, 1 = HARD findings, 2 = could not measure. A deck
 * PowerPoint refuses to open lands in 2 with that said plainly: COM's Open
 * threw in ~3 s on a truncated slide rather than hanging on a repair prompt
 * (measured 2026-09-25), so a refused open means a broken file.
 * Limits: chart-internal text (axis labels, data labels) is not measured; text
 * over a picture or gradient gets a WARN, not a contrast number.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const TOL = 1;             // points; PowerPoint rounds layout to fractions of a point
const MIN_BODY_PT = 18;    // Microsoft accessibility guidance
const MIN_CAPTION_PT = 12; // this skill's floor for shapes named caption*

// COM returns colors as a Long in BGR order: R + G*256 + B*65536.
function bgrToHex(n) {
  const r = n & 255, g = (n >> 8) & 255, b = (n >> 16) & 255;
  return [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
}

// WCAG 2.2 relative luminance and contrast ratio (sRGB, 0.04045 threshold).
function luminance(hex) {
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const isLarge = (size, bold) => size >= 18 || (bold && size >= 14);

// A fill we can reduce to one opaque color, or null.
function solid(fill) {
  if (!fill || !fill.visible) return null;
  if (fill.type !== 1 || (fill.transparency || 0) > 0.01) return undefined; // present but not one color
  return bgrToHex(fill.rgb);
}

// What is behind this text: its own fill, else the topmost filled shape below it
// that covers the text's center, else the slide background.
function background(shape, slide) {
  const own = solid(shape.fill);
  if (own) return { hex: own, from: "its own fill" };
  if (own === undefined) return { hex: null, from: "its own fill (not a single opaque color)" };
  const cx = (shape.boundLeft != null ? shape.boundLeft + shape.boundWidth / 2 : shape.left + shape.width / 2);
  const cy = (shape.boundTop != null ? shape.boundTop + shape.boundHeight / 2 : shape.top + shape.height / 2);
  const under = slide.shapes
    .filter((o) => o !== shape && o.z < shape.z && cx >= o.left && cx <= o.left + o.width && cy >= o.top && cy <= o.top + o.height)
    .sort((a, b) => b.z - a.z);
  for (const o of under) {
    if (o.isPicture || o.hasChart) return { hex: null, from: `picture/chart "${o.name}"` };
    const f = solid(o.fill);
    if (f) return { hex: f, from: `shape "${o.name}"` };
    if (f === undefined) return { hex: null, from: `shape "${o.name}" (not a single opaque color)` };
  }
  const bg = solid(slide.background);
  if (bg) return { hex: bg, from: "slide background" };
  return { hex: null, from: "slide background (picture or gradient)" };
}

const words = (t) => (String(t || "").match(/[A-Za-z0-9][A-Za-z0-9'.,%-]*/g) || []).length;
const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();

function checkDeck(m) {
  const out = [];
  const W = m.slideWidth, H = m.slideHeight;
  const add = (level, slide, shape, rule, msg) => out.push({ level, slide, shape, rule, msg });
  const titles = new Map();
  const info = [];

  for (const s of m.slides) {
    let wc = 0;
    if (!s.hasTitle || !norm(s.title)) {
      add("HARD", s.index, "", "TITLE", "no slide title - put one in the title placeholder (it can be hidden); screen readers and outline view navigate by it");
    } else {
      const k = norm(s.title);
      if (titles.has(k)) add("HARD", s.index, "", "TITLE", `duplicate title "${s.title.trim()}" (also slide ${titles.get(k)}) - make each title unique`);
      else titles.set(k, s.index);
    }

    const texted = [];
    for (const sh of s.shapes) {
      // Slide number, footer and date placeholders (13, 15, 16) are furniture,
      // not content: they get the caption floor, and contrast still applies.
      const caption = /^caption/i.test(sh.name || "") || [13, 15, 16].includes(sh.phType);
      const floor = caption ? MIN_CAPTION_PT : MIN_BODY_PT;

      if (sh.isPicture || sh.hasChart) {
        const what = sh.hasChart ? "chart" : "picture";
        const alt = String(sh.alt || "").trim();
        if (!sh.decorative && !alt) {
          if (/^decor/i.test(sh.name || "")) add("WARN", s.index, sh.name, "ALT", `${what} is marked decorative by its name only - screen readers cannot see a name; mark it decorative in PowerPoint (View Alt Text > Mark as decorative)`);
          else add("HARD", s.index, sh.name, "ALT", `${what} has no alt text - describe what it shows in 1-2 sentences, or mark it decorative`);
        } else if (!sh.decorative && /(^|[\\/:])[^\\/:]*\.(png|jpe?g|gif|svg|bmp|tiff?|emf|wmf)$/i.test(alt)) {
          // pptxgenjs 4.0.1 writes the image PATH as alt text when altText is
          // missing (`altText || image`), so a presence check alone passes it.
          add("HARD", s.index, sh.name, "ALT", `alt text is a file name ("${alt.slice(-60)}") - pptxgenjs writes the image path when altText is missing; describe what the ${what} shows`);
        }
      }

      if (!sh.hasText) {
        const off = sh.left < -TOL || sh.top < -TOL || sh.left + sh.width > W + TOL || sh.top + sh.height > H + TOL;
        if (off && !sh.isPicture) add("WARN", s.index, sh.name, "OFFSLIDE", "shape extends past the slide edge");
      }

      if (sh.hasText) {
        wc += words(sh.text);
        texted.push(sh);
        const bTop = sh.boundTop, bBot = sh.boundTop + sh.boundHeight;
        // Taller-than-box needs no separate test: text taller than its box
        // must cross its top or bottom edge (a mutation that dropped the
        // height test left the canary green, 2026-09-25).
        if (bTop < sh.top - TOL || bBot > sh.top + sh.height + TOL) {
          add("HARD", s.index, sh.name, "OVERFLOW", `text is ${sh.boundHeight.toFixed(0)} pt tall in a ${sh.height.toFixed(0)} pt box - cut words, split the slide, or enlarge the box; do not rely on autofit, PowerPoint does not apply it on open`);
        }
        if (bTop < -TOL || bBot > H + TOL || sh.boundLeft < -TOL || sh.boundLeft + sh.boundWidth > W + TOL) {
          add("HARD", s.index, sh.name, "OFFSLIDE", "text runs past the slide edge - it will be cut off, and a slide render will not show what is missing");
        }
      }

      const runSets = [];
      if (sh.hasText) runSets.push({ runs: sh.runs || [], bg: () => background(sh, s), where: sh.name });
      for (const c of sh.tableCells || []) {
        runSets.push({ runs: c.runs || [], bg: () => { const f = solid(c.fill); return f ? { hex: f, from: "its cell fill" } : background(sh, s); }, where: `${sh.name} r${c.row}c${c.col}` });
        wc += (c.runs || []).reduce((n, r) => n + words(r.text), 0);
      }
      for (const set of runSets) {
        const small = set.runs.filter((r) => r.size < floor - 0.01);
        if (small.length) {
          const min = Math.min(...small.map((r) => r.size));
          add("HARD", s.index, set.where, "FONTSIZE", `text at ${min} pt, under the ${floor} pt floor` + (caption ? " for captions" : " (name the shape caption* for source lines and footnotes, floor 12 pt)"));
        }
        // AA (1.4.3) is the HARD line: 4.5:1, or 3:1 for large text. Every run
        // that clears the 18 pt floor is "large", so AA alone would let body
        // text sit at 3:1; AAA's large-text line (1.4.6, 4.5:1) is kept as a
        // WARN because a projector lowers contrast further.
        let bg = null, worst = null, weak = null;
        for (const r of set.runs) {
          bg = bg || set.bg();
          if (!bg.hex) continue;
          const fg = bgrToHex(r.rgb), ratio = contrast(fg, bg.hex), large = isLarge(r.size, r.bold), need = large ? 3 : 4.5;
          if (ratio < need && (!worst || ratio < worst.ratio)) worst = { ratio, need, fg, r };
          else if (large && ratio < 4.5 && (!weak || ratio < weak.ratio)) weak = { ratio, fg, r };
        }
        if (bg && !bg.hex && set.runs.length) add("WARN", s.index, set.where, "CONTRAST", `contrast not computable - text sits on ${bg.from}; check the render`);
        if (worst) add("HARD", s.index, set.where, "CONTRAST", `#${worst.fg} on #${bg.hex} (${bg.from}) is ${worst.ratio.toFixed(2)}:1, needs ${worst.need}:1 at ${worst.r.size} pt${worst.r.bold ? " bold" : ""}`);
        else if (weak) add("WARN", s.index, set.where, "CONTRAST", `#${weak.fg} on #${bg.hex} is ${weak.ratio.toFixed(2)}:1 - meets WCAG AA for large text (3:1) but not AAA (4.5:1); projection lowers contrast`);
      }
    }

    for (let i = 0; i < texted.length; i++) {
      for (let j = i + 1; j < texted.length; j++) {
        const a = texted[i], b = texted[j];
        const x = Math.min(a.boundLeft + a.boundWidth, b.boundLeft + b.boundWidth) - Math.max(a.boundLeft, b.boundLeft);
        const y = Math.min(a.boundTop + a.boundHeight, b.boundTop + b.boundHeight) - Math.max(a.boundTop, b.boundTop);
        if (x > 2 && y > 2) add("WARN", s.index, `${a.name} + ${b.name}`, "OVERLAP", "text of two shapes overlaps");
      }
    }
    info.push({ slide: s.index, words: wc, notes: !!norm(s.notes) });
  }

  const usedFonts = new Set();
  for (const s of m.slides) for (const sh of s.shapes) {
    for (const r of sh.runs || []) usedFonts.add(r.name);
    for (const c of sh.tableCells || []) for (const r of c.runs || []) usedFonts.add(r.name);
  }
  for (const f of m.fonts || []) {
    if (!f.installed && usedFonts.has(f.name)) add("WARN", 0, "", "FONT", `"${f.name}" is not installed on this machine - PowerPoint may draw it from its cloud-font cache, but a recipient without it gets a substitute with different widths, so the overflow numbers hold only here`);
  }
  return { findings: out, info };
}

function report(m, res) {
  const lines = [`deck-check: ${m.deck} (${m.slides.length} slides, ${m.measuredWith || "measured"})`];
  for (const f of res.findings) lines.push(`${f.level.padEnd(4)}  ${f.slide ? "s" + f.slide : "deck"}${f.shape ? ` "${f.shape}"` : ""}  ${f.rule}  ${f.msg}`);
  lines.push("words per slide: " + res.info.map((i) => `s${i.slide} ${i.words}`).join(" | "));
  lines.push(`speaker notes on ${res.info.filter((i) => i.notes).length}/${res.info.length} slides`);
  const hard = res.findings.filter((f) => f.level === "HARD").length, warn = res.findings.filter((f) => f.level === "WARN").length;
  lines.push(`RESULT: ${hard ? "FAIL" : "PASS"} - ${hard} HARD, ${warn} WARN`);
  return { text: lines.join("\n"), hard };
}

function measure(deck, renders, jsonOut) {
  if (process.platform !== "win32") return { error: "deck-check needs Windows with PowerPoint installed (it measures through COM)" };
  const ps1 = path.join(__dirname, "measure-deck.ps1");
  const out = jsonOut || path.join(os.tmpdir(), `deck-check-${process.pid}.json`);
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Deck", path.resolve(deck), "-Out", out];
  if (renders) args.push("-Renders", path.resolve(renders));
  const r = spawnSync("powershell.exe", args, { encoding: "utf8", timeout: 300000 });
  if (r.status !== 0 || !fs.existsSync(out)) {
    const why = (r.stderr || r.stdout || "").trim();
    const refused = /could not open|corrupt/i.test(why);
    return { error: (refused ? "PowerPoint would not open this file - treat it as BROKEN: rebuild it, and bisect by dropping slides to find the bad one. " : `measurement failed (exit ${r.status}): `) + why.slice(0, 800) };
  }
  // Drop anything before the first bracket: a BOM breaks JSON.parse.
  const m = JSON.parse(fs.readFileSync(out, "utf8").replace(/^[^{[]*/, ""));
  if (!jsonOut) fs.unlinkSync(out);
  return { m };
}

// ---------------------------------------------------------------- self-tests
function fixture() {
  const white = { visible: true, type: 1, rgb: 0xFFFFFF, transparency: 0 };
  const txt = (name, o) => Object.assign({ name, type: 17, z: 5, left: 50, top: 100, width: 400, height: 100, fill: { visible: false },
    hasText: true, text: "some words here", boundLeft: 55, boundTop: 110, boundWidth: 300, boundHeight: 40,
    runs: [{ text: "some words here", size: 24, name: "Calibri", bold: false, rgb: 0x000000 }] }, o);
  return {
    deck: "fixture.pptx", slideWidth: 960, slideHeight: 540, measuredWith: "fixture",
    fonts: [{ name: "Calibri", installed: true }, { name: "Aptos", installed: false }],
    slides: [
      { index: 1, hasTitle: true, title: "Revenue doubled in Q3", notes: "script", background: white, shapes: [txt("ok")] },
      { index: 2, hasTitle: true, title: "Revenue doubled in Q3 ", notes: "", background: white, shapes: [
        txt("overflow", { boundHeight: 250, boundTop: -20 }),
        txt("small", { top: 300, boundTop: 310, runs: [{ text: "tiny", size: 17.5, name: "Calibri", bold: false, rgb: 0 }] }),
        txt("captionSrc", { top: 420, boundTop: 425, height: 30, boundHeight: 15, runs: [{ text: "Source: x", size: 12, name: "Calibri", bold: false, rgb: 0 }] }),
        txt("Slide Number Placeholder 0", { type: 14, phType: 13, left: 880, top: 505, boundLeft: 890, boundTop: 508, width: 60, boundWidth: 10, height: 20, boundHeight: 12, runs: [{ text: "2", size: 12, name: "Calibri", bold: false, rgb: 0 }] }),
        txt("Body Placeholder 1", { type: 14, phType: 2, left: 600, top: 300, boundLeft: 610, boundTop: 310, width: 200, boundWidth: 100, runs: [{ text: "b", size: 12, name: "Calibri", bold: false, rgb: 0 }] }),
      ] },
      { index: 3, hasTitle: false, title: "", notes: "", background: white, shapes: [
        txt("caption4.48", { runs: [{ text: "g", size: 12, name: "Calibri", bold: false, rgb: 0x777777 }] }),
        txt("caption4.54", { top: 250, boundTop: 260, runs: [{ text: "g", size: 12, name: "Calibri", bold: false, rgb: 0x767676 }] }),
        txt("large3.04", { top: 350, boundTop: 360, runs: [{ text: "g", size: 24, name: "Calibri", bold: false, rgb: 0x949494 }] }),
        txt("large2.85", { top: 420, boundTop: 430, runs: [{ text: "g", size: 24, name: "Calibri", bold: false, rgb: 0x999999 }] }),
        { name: "pic", type: 13, z: 1, left: 500, top: 50, width: 300, height: 200, isPicture: true, alt: "", decorative: false, hasText: false },
        { name: "chart", type: 3, z: 2, left: 500, top: 300, width: 300, height: 200, hasChart: true, alt: "", decorative: true, hasText: false },
      ] },
      { index: 4, hasTitle: true, title: "Dark panel", notes: "", background: white, shapes: [
        { name: "panel", type: 1, z: 1, left: 0, top: 0, width: 960, height: 540, fill: { visible: true, type: 1, rgb: 0x2B1A0F, transparency: 0 }, hasText: false },
        txt("whiteOnPanel", { z: 2, runs: [{ text: "w", size: 24, name: "Calibri", bold: false, rgb: 0xFFFFFF }] }),
        txt("darkOnPanel", { z: 3, top: 250, boundTop: 260, runs: [{ text: "d", size: 24, name: "Aptos", bold: false, rgb: 0x333333 }] }),
        { name: "photo", type: 13, z: 4, left: 600, top: 350, width: 300, height: 150, isPicture: true, alt: "a bar chart", hasText: false },
        txt("onPhoto", { z: 5, left: 620, top: 380, boundLeft: 630, boundTop: 390, width: 200, boundWidth: 150, runs: [{ text: "p", size: 24, name: "Calibri", bold: false, rgb: 0xFFFFFF }] }),
        { name: "decorLeaf", type: 13, z: 6, left: 10, top: 500, width: 20, height: 20, isPicture: true, alt: "", decorative: false, hasText: false },
        { name: "pathAlt", type: 13, z: 7, left: 40, top: 500, width: 20, height: 20, isPicture: true, alt: "C:\\decks\\img\\chart-final.PNG", decorative: false, hasText: false },
        { name: "sentenceAlt", type: 13, z: 8, left: 70, top: 500, width: 20, height: 20, isPicture: true, alt: "Bar chart: revenue doubled from 1.2 to 2.4 in Q3.", decorative: false, hasText: false },
      ] },
    ],
  };
}

function runCanary() {
  let pass = 0, total = 0;
  const check = (cond, name) => { total++; if (cond) pass++; else console.log("  FAIL: " + name); };
  const has = (res, slide, rule, level, shape) => res.findings.some((f) => f.slide === slide && f.rule === rule && f.level === level && (shape == null || f.shape === shape));

  // color math against known WCAG values
  check(bgrToHex(0x0000FF) === "FF0000", "COM BGR long 255 decodes to red");
  check(Math.abs(contrast("000000", "FFFFFF") - 21) < 1e-9, "black on white is 21:1");
  check(contrast("767676", "FFFFFF") >= 4.5 && contrast("777777", "FFFFFF") < 4.5, "#767676 passes 4.5:1 on white and #777777 does not");
  check(isLarge(18, false) && isLarge(14, true) && !isLarge(13.5, true) && !isLarge(17.9, false), "large text is 18 pt, or 14 pt bold");

  const res = checkDeck(fixture());
  check(!res.findings.some((f) => f.slide === 1), "a clean slide produces no findings");
  check(has(res, 2, "TITLE", "HARD"), "a duplicate title (after trimming and case) is HARD");
  check(has(res, 3, "TITLE", "HARD"), "a missing title is HARD");
  check(has(res, 2, "OVERFLOW", "HARD", "overflow"), "text taller than its box is HARD");
  check(has(res, 2, "OFFSLIDE", "HARD", "overflow"), "text pushed above the slide top is HARD");
  check(has(res, 2, "FONTSIZE", "HARD", "small"), "17.5 pt body text is HARD");
  check(!has(res, 2, "FONTSIZE", "HARD", "captionSrc"), "a 12 pt shape named caption* passes");
  check(!has(res, 2, "FONTSIZE", "HARD", "Slide Number Placeholder 0"), "a 12 pt slide-number placeholder passes (caption floor)");
  check(has(res, 2, "FONTSIZE", "HARD", "Body Placeholder 1"), "a 12 pt BODY placeholder still fails - only furniture gets the caption floor");
  check(has(res, 3, "CONTRAST", "HARD", "caption4.48") && !has(res, 3, "CONTRAST", "HARD", "caption4.54"), "12 pt text fails at 4.48:1 and passes at 4.54:1");
  check(has(res, 3, "CONTRAST", "WARN", "large3.04") && !has(res, 3, "CONTRAST", "HARD", "large3.04"), "24 pt text at 3.04:1 meets AA (3:1) but warns under AAA (4.5:1)");
  check(has(res, 3, "CONTRAST", "HARD", "large2.85"), "24 pt text at 2.85:1 is HARD");
  check(has(res, 3, "ALT", "HARD", "pic"), "a picture with no alt text is HARD");
  check(!has(res, 3, "ALT", "HARD", "chart"), "a chart marked decorative passes");
  check(has(res, 4, "ALT", "WARN", "decorLeaf") && !has(res, 4, "ALT", "HARD", "decorLeaf"), "decorative-by-name only is a WARN, not a pass or a HARD");
  check(has(res, 4, "ALT", "HARD", "pathAlt"), "alt text that is an image file path is HARD (the pptxgenjs default)");
  check(!has(res, 4, "ALT", "HARD", "sentenceAlt"), "a real sentence ending in a number is not mistaken for a file name");
  check(!has(res, 4, "CONTRAST", "HARD", "whiteOnPanel"), "white text on a dark shape below it passes (the shape, not the slide, is the background)");
  check(has(res, 4, "CONTRAST", "HARD", "darkOnPanel"), "dark text on a dark shape below it is HARD");
  check(has(res, 4, "CONTRAST", "WARN", "onPhoto") && !has(res, 4, "CONTRAST", "HARD", "onPhoto"), "text over a picture is a WARN (not computable)");
  check(has(res, 0, "FONT", "WARN") && res.findings.filter((f) => f.rule === "FONT").length === 1, "only a USED uninstalled font warns (Aptos used on slide 4)");
  check(res.info.find((i) => i.slide === 1).words === 3 && res.info.find((i) => i.slide === 1).notes === true, "words per slide and notes are reported");
  check(report(fixture(), res).hard > 0 && /RESULT: FAIL/.test(report(fixture(), res).text), "HARD findings turn the result to FAIL");

  if (pass === total) { console.log(`CANARY PASS ${pass}/${total}`); return true; }
  console.log(`CANARY FAIL ${pass}/${total}`);
  return false;
}

// A deck PowerPoint builds with known defects, so the COM path and the rules are
// proven together on a real file. Every expected finding must appear.
function liveCheck() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-check-live-"));
  const deck = path.join(dir, "known-bad.pptx");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "make-bad-deck.ps1"), "-Out", deck], { encoding: "utf8", timeout: 300000 });
  if (r.status !== 0) { console.log(`LIVE CHECK could not build the deck (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 600)}`); return false; }
  const got = measure(deck, null, null);
  if (got.error) { console.log("LIVE CHECK " + got.error); return false; }
  const res = checkDeck(got.m);
  const expect = [[1, "OVERFLOW", "HARD"], [1, "OFFSLIDE", "HARD"], [2, "FONTSIZE", "HARD"], [2, "CONTRAST", "HARD"],
    [3, "TITLE", "HARD"], [3, "ALT", "HARD"], [4, "TITLE", "HARD"]];
  let ok = true;
  for (const [s, rule, level] of expect) {
    const hit = res.findings.some((f) => f.slide === s && f.rule === rule && f.level === level);
    console.log(`  ${hit ? "fired" : "MISSING"}: slide ${s} ${level} ${rule}`);
    if (!hit) ok = false;
  }
  const clean = !res.findings.some((f) => f.slide === 5);
  console.log(`  ${clean ? "clean" : "FALSE POSITIVE"}: slide 5 (white text on a dark panel, 24 pt, titled)`);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(ok && clean ? "LIVE CHECK PASS" : "LIVE CHECK FAIL");
  return ok && clean;
}

function main() {
  const a = process.argv.slice(2);
  if (a.includes("--canary")) process.exit(runCanary() ? 0 : 1);
  if (a.includes("--live-check")) process.exit(liveCheck() ? 0 : 1);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  let m;
  if (opt("--measured")) {
    m = JSON.parse(fs.readFileSync(opt("--measured"), "utf8").replace(/^[^{[]*/, ""));
  } else {
    const deck = a.find((x) => /\.pptx$/i.test(x));
    if (!deck || !fs.existsSync(deck)) { console.error("usage: node deck-check.js <deck.pptx> [--renders <dir>] [--json <out.json>] | --measured <file.json> | --live-check | --canary"); process.exit(2); }
    const renders = opt("--renders") || deck.replace(/\.pptx$/i, "-renders");
    const got = measure(deck, renders, opt("--json"));
    if (got.error) { console.error("deck-check: " + got.error); process.exit(2); }
    m = got.m;
    console.log(`renders: ${path.resolve(renders)}`);
  }
  const res = checkDeck(m);
  const rep = report(m, res);
  console.log(rep.text);
  process.exit(rep.hard ? 1 : 0);
}

main();
