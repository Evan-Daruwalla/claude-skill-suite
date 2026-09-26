# deck-builder rules, by evidence tier

Every claim comes from a research brief of 2026-09-25 whose load-bearing
citations were each re-read from the source's own text. The sources are
listed at the end. Tiers:
- **HARD:** deck-check fails the deck.
- **DEFAULT:** build-deck does it, and the review questions ask about it.
- **REPORTED:** a number is printed, never enforced.
- **NOT CHECKED:** the evidence is mixed.

| Rule | Tier | Evidence | Strength |
|---|---|---|---|
| No text overflows its box or the slide | HARD | Measured on PowerPoint 16: overflow past the slide edge is invisible in a render; `fit:'shrink'` is not applied on open | Measured |
| Contrast >= 4.5:1, or >= 3:1 for large text (>= 18 pt, or >= 14 pt bold) | HARD | WCAG 2.2 SC 1.4.3 and its glossary | Standard |
| Large text >= 4.5:1 | WARN | WCAG 2.2 SC 1.4.6 (AAA) | Standard |
| Body text >= 18 pt | HARD | Microsoft accessibility guidance ("18pt or larger") | Vendor guidance |
| Captions, slide numbers, footers >= 12 pt | HARD | This skill's own floor | Choice, not evidence |
| Unique, non-empty slide title in the title placeholder | HARD | Microsoft ("Give every slide a unique title") | Vendor guidance |
| Alt text on pictures and charts, or a decorative mark | HARD | Microsoft; ECMA-376 `descr` on `cNvPr` | Vendor guidance / standard |
| PowerPoint opens the file | HARD (exit 2) | Measured: COM `Open` threw on a truncated slide in ~3 s | Measured, 2 corruption classes |
| Labels next to what they label; no legend when direct labels fit | DEFAULT | Spatial contiguity meta-analysis, g = 0.63, 58 comparisons | Meta-analysis |
| One highlighted element per chart or diagram | DEFAULT | Signaling meta-analysis, d = .38, 29 studies | Meta-analysis (shares an author with the next row) |
| Key terms on the slide, the script in speaker notes | DEFAULT | Verbal redundancy meta-analysis, 57 studies: key terms beat verbatim text | Meta-analysis |
| Cut interesting-but-irrelevant material | DEFAULT | Seductive detail meta-analysis, 39 effects | Meta-analysis (abstract level) |
| Warm, pleasant palette; relevant decoration allowed | DEFAULT | Emotional design meta-analysis, d = .387 retention, N = 2,924; embellished charts recalled better (CHI 2010) | Meta-analysis + one lab study |
| Design effort goes to complex material and live talks | DEFAULT | Overview of 29 reviews: design matters more when system-paced and complex | Meta-meta-analysis |
| Numbers to remember printed on the slide | DEFAULT | One study's data, via a practitioner critique | Single source |
| Sentence headline stating the takeaway | DEFAULT | Garner and Alley 2013 (N = 110, the author's own method, weakened control); one 2023 study (N = 59) | Weak |
| One idea per slide | DEFAULT | No study of its own; traces to the same Garner and Alley study | Extrapolation |
| Story arc, alignment grid, consistent layouts | DEFAULT | Duarte, Reynolds, Williams, Knaflic | PRACTITIONER |
| Live deck vs read-alone deck (slidedoc) | DEFAULT | Duarte, Reynolds; no comparative study exists | PRACTITIONER |
| Words per slide, bullets per slide, 6x6, fonts per deck, palette size | REPORTED | No traceable study (searched two ways, 2026-09-25) | None |
| Serif vs sans serif | NOT CHECKED | Mixed results on screens | Mixed |

## Things the evidence does NOT support (do not repeat them as findings)

- **"Minimal is always better."** Emotional design and embellished charts
  point the other way. Relevance is the tested variable.
- **"Slides improve learning."** Slides vs no slides: g = 0.067 (CI crosses
  zero) for college students.
- **"Assertion-evidence is proven."** Two small studies, and the first was
  run by the method's author against a control built to lose.
- **"Text-only slides are forgettable."** Speech plus on-screen text beat
  speech alone for picture-free material (Adesope and Nesbit 2012).

## Sources

- Noetel et al. (2022). Multimedia Design for Learning: An Overview of Reviews With Meta-Meta-Analysis. Review of Educational Research. https://doi.org/10.3102/00346543211052329
- Adesope and Nesbit (2012). Verbal redundancy in multimedia learning environments: A meta-analysis. J. Educational Psychology. https://doi.org/10.1037/a0026147
- Schroeder and Cenkci (2018). Spatial Contiguity and Spatial Split-Attention Effects: a Meta-Analysis. Educational Psychology Review. https://doi.org/10.1007/s10648-018-9435-9
- Alpizar, Adesope and Wong (2020). A meta-analysis of signaling principle in multimedia learning environments. ETR&D. https://doi.org/10.1007/s11423-020-09748-7
- Rey (2012). A review of research and a meta-analysis of the seductive detail effect. Educational Research Review. https://doi.org/10.1016/j.edurev.2012.05.003
- Brom, Starkova and D'Mello (2018). How effective is emotional design? Educational Research Review. https://doi.org/10.1016/j.edurev.2018.09.004
- Bateman et al. (2010). Useful junk? The effects of visual embellishment on comprehension and memorability of charts. CHI 2010. https://doi.org/10.1145/1753326.1753716
- Baker, Goodboy, Bowman and Wright (2018). Does teaching with PowerPoint increase students' learning? A meta-analysis. Computers and Education. https://doi.org/10.1016/j.compedu.2018.08.003
- Garner and Alley (2013). How the design of presentation slides affects audience comprehension: A case for the assertion-evidence approach. Int. J. Engineering Education 29(6).
- Getting to the (Power) Point: Assertion-Evidence design and English grammatical competence (2023). Shanlax Int. J. Education. https://doi.org/10.34293/education.v11i4.6375
- Kosslyn, Kievit, Russell and Shephard (2012). PowerPoint presentation flaws and failures: a psychological analysis. Frontiers in Psychology 3:230. https://doi.org/10.3389/fpsyg.2012.00230
- W3C. WCAG 2.2 (SC 1.4.3, SC 1.4.6, and the definitions of contrast ratio and large scale text). https://www.w3.org/TR/WCAG22/
- Microsoft Support. Make your PowerPoint presentations accessible to people with disabilities. https://support.microsoft.com/en-us/office/make-your-powerpoint-presentations-accessible-to-people-with-disabilities-6f7772b2-2f33-4bd2-8ca7-dae3b2b3ef25
