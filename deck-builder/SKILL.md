---
name: deck-builder
description: >-
  Builds clear, good-looking .pptx slide decks on Windows and PROVES them
  before delivery. You write the story as a JSON spec (sentence titles, key
  terms, speaker notes, one highlighted element per chart). build-deck.js
  renders it through one fixed design system. deck-check.js then measures the
  file inside the installed PowerPoint (COM) and fails it on overflowing or
  cut-off text, contrast under WCAG AA, text under 18 pt, missing or duplicate
  titles, and missing or file-name alt text. It also renders every slide to
  PNG for a visual review. Design rules are tiered by evidence (research brief
  of 2026-09-25). Use when: "make a deck", "build a presentation", "slides
  for my talk", "make this into a PowerPoint", "check this deck", "is this
  pptx readable". For editing an existing deck or filling a template, use
  anthropic-skills:pptx, then run deck-check.js on the result.
---

# deck-builder - evidence-tiered decks, checked by PowerPoint itself

The bundled `anthropic-skills:pptx` knows the pptxgenjs mechanics. This skill
adds three things it lacks on this machine:
1. **Design rules sorted by how much evidence stands behind them.**
2. **A builder, so every deck gets the same grid, type scale and palette.**
3. **A checker that measures through real PowerPoint.** The bundled QA path
   needs LibreOffice, pdftoppm and markitdown. None of the three is
   installed here.

Two measured facts make the checker necessary (2026-09-25):
- **Text pushed past the slide edge does not show up in a slide render.** 30
  lines in a 342 pt box measured 1,197 pt, and the PNG looked clean.
- **pptxgenjs `fit:'shrink'` only sets a flag.** PowerPoint does not apply it
  on open, so the overflow ships.

The evidence behind every rule comes from a sourced research brief
(2026-09-25). Each load-bearing claim in it was re-read from its source. The
rules, with their evidence tier and full citations, are in
`references/rules.md`.

## Setup (once)

- Windows with PowerPoint installed. deck-check exits 2 without it.
- pptxgenjs 4.0.1 (MIT), installed OUTSIDE the skill folder:
  `npm install --prefix "%LOCALAPPDATA%\deck-builder" pptxgenjs@4.0.1`
  build-deck.js finds it there. Never install into the skill folder: that
  tree is synced and published.

## Workflow

1. **Brief - answer four questions before any slide.**
   - Who is the audience?
   - Will it be **presented live** or **read alone**?
   - What is the ONE takeaway?
   - How many minutes?

   Live talks are where design matters most (Noetel 2022: speaker-paced
   beats self-paced). For a deck that will be read alone, more words per
   slide are fine and the notes matter less. That split is practitioner
   guidance; no study tests it.
2. **Storyline - titles first.** Write every slide title as a full sentence
   that states the takeaway ("Contiguity had the largest effect", not
   "Results"). Then read the titles alone, in order: they must tell the whole
   story. Cut any slide whose title adds nothing. (Sentence titles: DEFAULT,
   two small studies. One idea per slide: DEFAULT, extrapolation.)
3. **Evidence per slide.**
   - Pick the slide type that shows the claim: `chart`, `image`, `stats`,
     `compare`, or `points` as a last resort.
   - Highlight ONE element (signaling, meta-analysis d = .38).
   - Label data where it sits, not in a legend (spatial contiguity,
     g = 0.63).
   - Numbers the audience must remember go ON the slide.
   - Anything interesting but irrelevant comes out (seductive details). Warm
     color is allowed (emotional design raised retention, d = .387).
4. **Write the spec, validate, build.**
   - Validate: `node build-deck.js --validate spec.json`
   - Build: `node build-deck.js spec.json out.pptx`

   The validator rejects missing or duplicate titles, charts or images
   without alt text, and malformed charts. It warns on topic-label titles
   and on slides without notes.
5. **Check - `node deck-check.js out.pptx`.** Fix every HARD in the spec and
   rebuild; never hand-patch the .pptx. Decide each WARN and say what you
   decided. Exit 0 = no HARD, 1 = HARD, 2 = could not measure. A deck
   PowerPoint refuses to open also exits 2: treat it as broken.
6. **Look - review the renders** (`out-renders/slide-NN.png`), ideally through
   a fresh subagent that did not write the spec. It asks what the checker
   cannot:
   - Is there a large empty area on one side, or crowding on the other?
   - Do the edges of repeated elements line up from slide to slide?
   - Is exactly one thing emphasized per slide, and is it the right thing?
   - Does every image and decoration support the title's claim?
   - Is the chart readable without its legend?
   - Would the chart colors survive colorblindness? The checker does not
     test chart colors.
7. **Deliver.** Report the .pptx path, the deck-check RESULT line (the real
   output), the renders folder, and every WARN you accepted and why.

## Spec format

```json
{ "theme": "teal | ember", "title": "file metadata", "author": "name",
  "slides": [
    { "type": "title",   "title": "...", "subtitle": "...", "byline": "...", "notes": "..." },
    { "type": "section", "number": "01", "title": "..." },
    { "type": "chart",   "title": "sentence takeaway", "chart": { "labels": ["a","b"], "values": [1,2],
      "highlight": 1, "format": "0.00", "horizontal": false }, "alt": "what it shows", "source": "..." },
    { "type": "image",   "title": "...", "image": "relative/or/absolute.png", "alt": "...", "points": ["key term"], "source": "..." },
    { "type": "stats",   "title": "...", "stats": [ { "value": "78,177", "label": "participants" } ] },
    { "type": "compare", "title": "...", "left": { "head": "...", "points": [] }, "right": { "head": "...", "points": [] } },
    { "type": "points",  "title": "...", "points": ["key term", "key term"] },
    { "type": "closing", "title": "...", "points": ["next step"] } ] }
```

- Every slide takes an optional `notes`: the script for a live talk. Put the
  script in the notes and the key terms on the slide (Adesope and Nesbit
  2012). The full script on the slide did worse than key terms.
- `stats` holds 1-4 items. Image paths resolve relative to the spec file.
  PNG and baseline JPEG only.
- `source` becomes a 12 pt line named `caption-source`. deck-check lets
  shapes named `caption*` go down to 12 pt; everything else needs 18 pt.
- A full working example: `examples/sample-spec.json`. It builds a 9-slide
  deck that passes with 0 HARD and 0 WARN.

The design system (fixed in build-deck.js, so decks stay consistent):
- Canvas: 13.333 x 7.5 in (16:9).
- Margins: 0.75 in.
- Font: Calibri throughout. It ships with every Office since 2007, and Aptos
  does not ship with older Office. deck-check warns on any font that is not
  installed on this machine.
- Type scale: titles 30 pt bold; body 20-24 pt; stats 60 pt; captions 12 pt.
- Palettes: two themes. Every text/background pair clears 4.5:1, and the
  canary asserts it.
- Masters: dark masters for the title, section and closing slides; white for
  content. Every title lives in a real title placeholder, so outline view
  and screen readers see it.

Need a layout the eight types do not cover? Copy the nearest branch in
build-deck.js. Follow the pptxgenjs gotchas in `anthropic-skills:pptx`
(no `#` in colors; a fresh options object for every call). The result must
still pass deck-check.

## What deck-check measures

| Check | Level | Source |
|---|---|---|
| Text crosses its box edge (overflow) | HARD | Measured `BoundTop`/`BoundHeight` |
| Text runs past the slide edge | HARD | Measured; invisible in renders |
| Contrast under WCAG AA: 4.5:1, or 3:1 at >= 18 pt / >= 14 pt bold | HARD | WCAG 2.2 SC 1.4.3 |
| Large text under 4.5:1 (AAA) | WARN | WCAG 2.2 SC 1.4.6; projectors lower contrast |
| Text under 18 pt (12 pt for `caption*` shapes and slide number, footer and date placeholders) | HARD | Microsoft accessibility guidance; 12 pt is this skill's floor |
| Slide with no title, or a duplicate title | HARD | Microsoft |
| Picture or chart with no alt text, or a file name as alt text | HARD | Microsoft; pptxgenjs writes the image PATH as alt text when `altText` is missing |
| Picture "decorative" by its name only | WARN | Screen readers read the decorative flag, not names |
| Background is a picture, gradient or see-through fill (contrast not computable) | WARN | Check the render |
| Two text boxes overlap; a non-text shape is off the slide | WARN | |
| A used font is not installed on this machine | WARN | Recipients get a substitute with different widths |
| Words per slide; speaker-notes coverage | INFO | Reported, never enforced: no study supports a words-per-slide limit |

Contrast is computed against what is really behind the text:
1. The text's own fill;
2. otherwise the topmost filled shape below it;
3. otherwise the slide background, walking slide -> layout -> master.

PowerPoint's own Accessibility Checker skips the most common case, text in a
transparent box over the slide background. Microsoft's page says so.

## Proof (run after any change to the scripts)

- `node deck-check.js --canary` - MUST print `CANARY PASS 27/27`.
- `node build-deck.js --canary` - MUST print `CANARY PASS 14/14`.
- `node deck-check.js --live-check` makes a deck with known defects inside
  PowerPoint (make-bad-deck.ps1). It must print `LIVE CHECK PASS`: all 7
  expected HARD findings fire, and the clean slide stays clean. It is not in
  the canary runner because it needs Office.

## Limits

- Text inside charts (axis and data labels) is not measured. Chart colors are
  not checked for colorblind safety.
- Text over a picture or gradient gets a WARN, not a contrast number.
- **Every measurement is "as this PowerPoint lays it out".** It was tested on
  PowerPoint 16 only. Keynote, Google Slides and LibreOffice may wrap text
  differently.
- **The checker cannot judge the story, relevance or balance.** That is what
  step 6 is for.
