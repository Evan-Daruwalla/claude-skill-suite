#!/usr/bin/env node
/*
 * build-deck.js - render a deck spec (JSON) into a .pptx through one design system.
 *
 *   node build-deck.js <spec.json> <out.pptx>
 *   node build-deck.js --validate <spec.json>     check the spec only, write nothing
 *   node build-deck.js --canary                   self-test of the spec validator (no pptxgenjs needed)
 *
 * The model writes the STORY (sentence titles, key terms, speaker notes, which
 * bar to highlight); this script owns every position, size and color, so each
 * deck gets the same grid, type scale and palette. Then run deck-check.js on
 * the output - this script cannot see overflow, PowerPoint can.
 *
 * Needs pptxgenjs 4.0.1 (MIT). Resolution order: a normal require, then the
 * cache prefix %LOCALAPPDATA%\deck-builder (install once with
 *   npm install --prefix "%LOCALAPPDATA%\deck-builder" pptxgenjs@4.0.1 ).
 * node_modules never goes in the skill folder: the skill tree is synced and
 * published, a dependency tree is not.
 *
 * Slide types: title, section, points, chart, image, stats, compare, closing.
 * The spec format is in SKILL.md; examples/sample-spec.json builds a full deck.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------------------------------------------------------------- design system
// All text/background pairs below clear WCAG AA; the canary asserts it.
const THEMES = {
  teal: { dark: "0B1F2A", onDark: "FFFFFF", accentOnDark: "5EEAD4", subOnDark: "CBD5E1",
    paper: "FFFFFF", ink: "111827", body: "374151", muted: "4B5563", accent: "0F766E", panel: "F1F5F9", rest: "94A3B8" },
  ember: { dark: "1C1917", onDark: "FFFFFF", accentOnDark: "FDBA74", subOnDark: "D6D3D1",
    paper: "FFFFFF", ink: "1C1917", body: "44403C", muted: "57534E", accent: "C2410C", panel: "F5F5F4", rest: "A8A29E" },
};
const FONT = "Calibri";   // ships with every Office since 2007; Aptos does not ship with older Office
const W = 13.333, H = 7.5, MX = 0.75, CW = W - 2 * MX;   // 16:9 widescreen, inches
const T = { title: 30, hero: 44, section: 40, body: 20, stat: 60, label: 18, caption: 12, number: 96 };
const TYPES = ["title", "section", "points", "chart", "image", "stats", "compare", "closing"];

// ---------------------------------------------------------------- spec validation (pure)
const norm = (t) => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
const isStrList = (a) => Array.isArray(a) && a.every((x) => typeof x === "string" && x.trim());

function validateSpec(spec) {
  const errors = [], warnings = [];
  if (!spec || !Array.isArray(spec.slides) || !spec.slides.length) return { errors: ["spec.slides must be a non-empty array"], warnings };
  if (spec.theme && !THEMES[spec.theme]) errors.push(`theme "${spec.theme}" unknown - use one of ${Object.keys(THEMES).join(", ")}`);
  const seen = new Map();
  spec.slides.forEach((s, i) => {
    const n = i + 1, at = `slide ${n} (${s && s.type})`;
    if (!s || !TYPES.includes(s.type)) { errors.push(`slide ${n}: type must be one of ${TYPES.join(", ")}`); return; }
    if (typeof s.title !== "string" || !s.title.trim()) errors.push(`${at}: title is required (it becomes the slide's title placeholder)`);
    else {
      const k = norm(s.title);
      if (seen.has(k)) errors.push(`${at}: title duplicates slide ${seen.get(k)} - titles must be unique`);
      seen.set(k, n);
      if (["points", "chart", "image", "stats", "compare"].includes(s.type) && s.title.trim().split(/\s+/).length < 4) {
        warnings.push(`${at}: "${s.title}" reads like a topic label - the default is a full-sentence takeaway`);
      }
    }
    if ((s.type === "chart" || s.type === "image") && !(typeof s.alt === "string" && s.alt.trim())) errors.push(`${at}: alt is required - say what the ${s.type} shows`);
    if (s.type === "image" && !(typeof s.image === "string" && /\.(png|jpe?g)$/i.test(s.image))) errors.push(`${at}: image must be a .png or .jpg path`);
    if (s.type === "chart") {
      const c = s.chart || {};
      if (!isStrList(c.labels) || !Array.isArray(c.values) || c.labels.length !== c.values.length || !c.values.every(Number.isFinite)) {
        errors.push(`${at}: chart needs labels (strings) and values (finite numbers) of equal length`);
      } else if (c.highlight != null && !(Number.isInteger(c.highlight) && c.highlight >= 0 && c.highlight < c.values.length)) {
        errors.push(`${at}: chart.highlight must be an index 0..${c.values.length - 1}`);
      }
    }
    if (s.type === "stats" && !(Array.isArray(s.stats) && s.stats.length >= 1 && s.stats.length <= 4 && s.stats.every((x) => x && x.value && x.label))) {
      errors.push(`${at}: stats needs 1-4 items, each with value and label`);
    }
    if (s.type === "compare" && !(s.left && s.right && s.left.head && s.right.head && isStrList(s.left.points) && isStrList(s.right.points))) {
      errors.push(`${at}: compare needs left and right, each with head and points`);
    }
    if ((s.type === "points" || s.type === "closing") && !isStrList(s.points)) errors.push(`${at}: points must be a list of strings`);
    if (s.type === "image" && s.points != null && !isStrList(s.points)) errors.push(`${at}: points must be a list of strings`);
    if (s.notes != null && typeof s.notes !== "string") errors.push(`${at}: notes must be a string`);
  });
  const presented = spec.slides.filter((s) => s && typeof s.notes === "string" && s.notes.trim()).length;
  if (presented < spec.slides.length) warnings.push(`speaker notes on ${presented}/${spec.slides.length} slides - for a live talk the script belongs in the notes, key terms on the slide`);
  return { errors, warnings };
}

// ---------------------------------------------------------------- image size (PNG / JPEG headers)
function imageSize(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i < b.length - 9;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1], len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  throw new Error(`cannot read the size of ${file} (PNG or baseline JPEG only)`);
}
function contain(file, box) {
  const { w, h } = imageSize(file);
  const s = Math.min(box.w / w, box.h / h);
  return { x: box.x + (box.w - w * s) / 2, y: box.y + (box.h - h * s) / 2, w: w * s, h: h * s };
}

// ---------------------------------------------------------------- rendering
function loadPptxgen() {
  try { return require("pptxgenjs"); } catch (_) { /* fall through to the cache prefix */ }
  const prefix = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".cache"), "deck-builder", "node_modules", "pptxgenjs");
  try { return require(prefix); } catch (_) {
    console.error(`pptxgenjs not found. Install it once, outside the skill folder:\n  npm install --prefix "${path.dirname(path.dirname(prefix))}" pptxgenjs@4.0.1`);
    process.exit(2);
  }
}

function build(spec, specDir, outFile) {
  const pptxgen = loadPptxgen();
  const C = THEMES[spec.theme || "teal"];
  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE";
  if (spec.title) pres.title = spec.title;
  if (spec.author) pres.author = spec.author;

  const titlePh = (y, h, size, color, extra) => ({ placeholder: { options: Object.assign({ name: "title", type: "title", x: MX, y, w: CW, h, fontFace: FONT, fontSize: size, bold: true, color, valign: "top", align: "left", margin: 0 }, extra || {}), text: "" } });
  const num = { x: W - MX - 1, y: H - 0.5, w: 1, h: 0.3, fontFace: FONT, fontSize: T.caption, align: "right" };
  pres.defineSlideMaster({ title: "DARK", background: { color: C.dark }, objects: [titlePh(2.35, 1.9, T.hero, C.onDark, { valign: "bottom" })] });
  pres.defineSlideMaster({ title: "SECTION", background: { color: C.dark }, objects: [titlePh(3.55, 1.6, T.section, C.onDark)] });
  pres.defineSlideMaster({ title: "CLOSING", background: { color: C.dark }, objects: [titlePh(1.35, 1.7, T.section, C.onDark, { valign: "bottom" })] });
  pres.defineSlideMaster({ title: "CLAIM", background: { color: C.paper }, objects: [titlePh(0.55, 1.15, T.title, C.ink)], slideNumber: Object.assign({ color: C.muted }, num) });

  const text = (slide, str, o) => slide.addText(str, Object.assign({ fontFace: FONT, fontSize: T.body, color: C.body, isTextBox: true, margin: 0, valign: "top", paraSpaceAfter: 10 }, o));
  const caption = (slide, str, y) => text(slide, str, { x: MX, y: y || H - 0.62, w: CW - 1.2, h: 0.3, fontSize: T.caption, color: C.muted, objectName: "caption-source" });
  const list = (items, color, bulletColor) => items.map((p, i) => ({ text: p, options: { bullet: { code: "25A0", color: bulletColor || C.accent }, breakLine: i < items.length - 1, color } }));
  const BODY_Y = 1.95, BODY_END = 6.7;   // the band between the title and the source caption
  const centered = (h) => BODY_Y + (BODY_END - BODY_Y - h) / 2;

  for (const s of spec.slides) {
    let slide;
    if (s.type === "title") {
      slide = pres.addSlide({ masterName: "DARK" });
      slide.addShape(pres.shapes.OVAL, { x: 8.9, y: 1.1, w: 4.1, h: 4.1, fill: { color: C.accentOnDark, transparency: 82 }, line: { type: "none" }, objectName: "motif" });
      slide.addText(s.title, { placeholder: "title" });
      if (s.subtitle) text(slide, s.subtitle, { x: MX, y: 4.45, w: 8.6, h: 1.0, fontSize: 24, color: C.accentOnDark });
      if (s.byline) text(slide, s.byline, { x: MX, y: 6.35, w: 8.6, h: 0.45, fontSize: T.label, color: C.subOnDark });
    } else if (s.type === "section") {
      slide = pres.addSlide({ masterName: "SECTION" });
      if (s.number) text(slide, String(s.number), { x: MX, y: 1.55, w: 4, h: 1.7, fontSize: T.number, bold: true, color: C.accentOnDark });
      slide.addText(s.title, { placeholder: "title" });
    } else if (s.type === "closing") {
      slide = pres.addSlide({ masterName: "CLOSING" });
      slide.addText(s.title, { placeholder: "title" });
      text(slide, list(s.points, C.onDark, C.accentOnDark), { x: MX, y: 3.55, w: CW, h: 3.2, fontSize: 24, paraSpaceAfter: 16 });
    } else {
      slide = pres.addSlide({ masterName: "CLAIM" });
      slide.addText(s.title, { placeholder: "title" });
      if (s.type === "points") {
        text(slide, list(s.points, C.body), { x: MX, y: BODY_Y + 0.15, w: 9.2, h: 4.6, fontSize: 24, paraSpaceAfter: 14 });
      } else if (s.type === "chart") {
        const c = s.chart, hl = c.highlight;
        const colors = c.labels.map((_, i) => (hl == null || i === hl ? C.accent : C.rest));
        slide.addChart(pres.charts.BAR, [{ name: c.series || "value", labels: c.labels, values: c.values }], {
          x: MX, y: BODY_Y, w: CW, h: 4.55, barDir: c.horizontal ? "bar" : "col", barGapWidthPct: 60,
          chartColors: colors.length > 1 ? colors : [C.accent, C.accent],
          showValue: true, dataLabelPosition: "outEnd", dataLabelFontSize: 18, dataLabelFontFace: FONT, dataLabelColor: C.ink,
          dataLabelFormatCode: c.format || "General",
          catAxisLabelFontSize: 18, catAxisLabelFontFace: FONT, catAxisLabelColor: C.body, catAxisLineShow: false,
          valAxisHidden: true, valGridLine: { style: "none" }, catGridLine: { style: "none" },
          showLegend: false, altText: s.alt,
        });
      } else if (s.type === "image") {
        // A figure frame: an image with a white background would otherwise
        // melt into the white slide and read as slide content.
        const pad = 0.2, frame = { x: MX, y: BODY_Y, w: s.points ? 7.6 : CW, h: BODY_END - BODY_Y - 0.1 };
        const file = path.resolve(specDir, s.image);
        const img = contain(file, { x: frame.x + pad, y: frame.y + pad, w: frame.w - 2 * pad, h: frame.h - 2 * pad });
        slide.addShape(pres.shapes.RECTANGLE, { x: img.x - pad, y: img.y - pad, w: img.w + 2 * pad, h: img.h + 2 * pad, fill: { color: C.panel }, line: { type: "none" }, objectName: "figure-frame" });
        slide.addImage(Object.assign({ path: file, altText: s.alt }, img));
        if (s.points) text(slide, list(s.points, C.body), { x: MX + 8.0, y: img.y - pad, w: CW - 8.0, h: BODY_END - (img.y - pad), fontSize: 22, paraSpaceAfter: 14 });
      } else if (s.type === "stats") {
        // Cards sized to their content (value + up to 3 label lines), centered in the body band.
        const n = s.stats.length, gap = 0.35, cw = (CW - gap * (n - 1)) / n, ch = 3.0, y = centered(ch);
        s.stats.forEach((st, i) => {
          const x = MX + i * (cw + gap);
          slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h: ch, fill: { color: C.panel }, line: { type: "none" }, rectRadius: 0.12, objectName: `card-${i + 1}` });
          text(slide, String(st.value), { x: x + 0.35, y: y + 0.35, w: cw - 0.7, h: 1.25, fontSize: n > 3 ? 48 : T.stat, bold: true, color: C.accent });
          text(slide, String(st.label), { x: x + 0.35, y: y + 1.7, w: cw - 0.7, h: 1.05, fontSize: T.label, color: C.body });
        });
      } else if (s.type === "compare") {
        // Panels sized to the longer list, centered in the body band.
        const cw = (CW - 0.4) / 2, rows = Math.max(s.left.points.length, s.right.points.length);
        const ph = Math.min(BODY_END - BODY_Y, 1.5 + rows * 0.6), y = centered(ph);
        [s.left, s.right].forEach((side, i) => {
          const x = MX + i * (cw + 0.4);
          slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h: ph, fill: { color: C.panel }, line: { type: "none" }, rectRadius: 0.12, objectName: `panel-${i + 1}` });
          text(slide, side.head, { x: x + 0.4, y: y + 0.35, w: cw - 0.8, h: 0.6, fontSize: 24, bold: true, color: i === 0 ? C.ink : C.accent });
          text(slide, list(side.points, C.body), { x: x + 0.4, y: y + 1.05, w: cw - 0.8, h: ph - 1.25, fontSize: T.body, paraSpaceAfter: 12 });
        });
      }
      if (s.source) caption(slide, s.source);
    }
    if (s.notes) slide.addNotes(s.notes);
  }
  return pres.writeFile({ fileName: outFile });
}

// ---------------------------------------------------------------- self-test (validator + palette)
function runCanary() {
  let pass = 0, total = 0;
  const check = (cond, name) => { total++; if (cond) pass++; else console.log("  FAIL: " + name); };
  const ok = { slides: [
    { type: "title", title: "Decks that teach", notes: "n" },
    { type: "chart", title: "Contiguity has the largest effect here", alt: "Bar chart of four effect sizes", chart: { labels: ["a", "b"], values: [1, 2], highlight: 1 }, notes: "n" },
  ] };
  const v = validateSpec(ok);
  check(v.errors.length === 0 && v.warnings.length === 0, "a well-formed spec has no errors or warnings");
  const errs = (spec) => validateSpec(spec).errors.join(" | ");
  check(/non-empty/.test(errs({ slides: [] })), "an empty deck is rejected");
  check(/type must be/.test(errs({ slides: [{ type: "bullets", title: "x" }] })), "an unknown slide type is rejected");
  check(/title is required/.test(errs({ slides: [{ type: "points", title: " ", points: ["a"] }] })), "a blank title is rejected");
  check(/duplicates slide 1/.test(errs({ slides: [{ type: "section", title: "Why it matters" }, { type: "section", title: " why IT matters" }] })), "a duplicate title (case and spaces ignored) is rejected");
  check(/alt is required/.test(errs({ slides: [{ type: "image", title: "The render hides the overflow", image: "a.png" }] })), "an image without alt is rejected");
  check(/alt is required/.test(errs({ slides: [{ type: "chart", title: "Contiguity wins by a wide margin", chart: { labels: ["a"], values: [1] } }] })), "a chart without alt is rejected");
  check(/equal length/.test(errs({ slides: [{ type: "chart", title: "t t t t", alt: "a", chart: { labels: ["a", "b"], values: [1] } }] })), "chart labels and values must match");
  check(/highlight must be/.test(errs({ slides: [{ type: "chart", title: "t t t t", alt: "a", chart: { labels: ["a"], values: [1], highlight: 1 } }] })), "an out-of-range highlight is rejected");
  check(/1-4 items/.test(errs({ slides: [{ type: "stats", title: "t t t t", stats: [1, 2, 3, 4, 5].map((x) => ({ value: x, label: "l" })) }] })), "more than 4 stats is rejected");
  check(/theme/.test(errs({ theme: "neon", slides: [{ type: "section", title: "x" }] })), "an unknown theme is rejected");
  const w = validateSpec({ slides: [{ type: "points", title: "Background", points: ["a"] }] }).warnings.join(" | ");
  check(/topic label/.test(w) && /speaker notes on 0\/1/.test(w), "a topic-label title and missing notes warn, never error");

  // Every text color the builder uses must clear WCAG AA on the background it sits on.
  const lum = (hex) => { const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4))); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [h, l] = [lum(a), lum(b)].sort((x, y) => y - x); return (h + 0.05) / (l + 0.05); };
  for (const [name, C] of Object.entries(THEMES)) {
    const pairs = [[C.onDark, C.dark, 4.5], [C.accentOnDark, C.dark, 4.5], [C.subOnDark, C.dark, 4.5], [C.ink, C.paper, 4.5], [C.body, C.paper, 4.5],
      [C.muted, C.paper, 4.5], [C.accent, C.paper, 4.5], [C.accent, C.panel, 4.5], [C.body, C.panel, 4.5], [C.ink, C.panel, 4.5]];
    check(pairs.every(([f, b, need]) => ratio(f, b) >= need), `theme ${name}: every text/background pair is >= 4.5:1`);
  }

  if (pass === total) { console.log(`CANARY PASS ${pass}/${total}`); return true; }
  console.log(`CANARY FAIL ${pass}/${total}`);
  return false;
}

function main() {
  const a = process.argv.slice(2);
  if (a.includes("--canary")) process.exit(runCanary() ? 0 : 1);
  const validateOnly = a.includes("--validate");
  const files = a.filter((x) => !x.startsWith("--"));
  const specFile = files[0];
  if (!specFile || (!validateOnly && !files[1])) { console.error("usage: node build-deck.js <spec.json> <out.pptx> | --validate <spec.json> | --canary"); process.exit(2); }
  // Drop anything before the first bracket: a BOM from a Windows editor breaks JSON.parse.
  const spec = JSON.parse(fs.readFileSync(specFile, "utf8").replace(/^[^{[]*/, ""));
  const { errors, warnings } = validateSpec(spec);
  for (const w of warnings) console.log("WARN  " + w);
  for (const e of errors) console.log("ERROR " + e);
  if (errors.length) { console.log(`spec REJECTED - ${errors.length} error(s), nothing written`); process.exit(1); }
  if (validateOnly) { console.log("spec OK"); return; }
  build(spec, path.dirname(path.resolve(specFile)), path.resolve(files[1]))
    .then((f) => console.log(`wrote ${f}\nnext: node "${path.join(__dirname, "deck-check.js")}" "${f}"`))
    .catch((e) => { console.error("build failed: " + e.message); process.exit(1); });
}

main();
