# compact-io Pattern Reference

Extended lookup table for input compression patterns. Use when SKILL.md rules don't cover a specific phrase.

---

## Extended Throat-Clearing Patterns

| Pattern | Action |
|---|---|
| "I hope this message finds you well" | delete |
| "First and foremost, I'd like to say…" | delete |
| "Without further ado…" | delete |
| "I wanted to reach out because…" | delete → start with the reason |
| "I'm writing to inquire about…" | → "What is…" / "Can you…" |
| "Allow me to explain…" | delete |
| "Let me start by saying…" | delete |
| "As you may already know…" | delete (or keep if truly useful framing) |
| "I know you're busy so I'll keep this brief" | delete |
| "Apologies for the long message but…" | delete |

---

## Extended Verbose-to-Compact Map

| Verbose | Compact |
|---|---|
| "in close proximity to" | "near" |
| "at the present moment" | "now" |
| "during the time that" | "while" |
| "in a timely manner" | "promptly" / "on time" |
| "on a daily basis" | "daily" |
| "at regular intervals" | "regularly" |
| "in the near future" | "soon" |
| "make a decision" | "decide" |
| "take into consideration" | "consider" |
| "come to the conclusion" | "conclude" |
| "have the ability to" | "can" |
| "be in a position to" | "can" |
| "in the process of" | *(delete — rephrase verb)* |
| "on the occasion of" | "when" |
| "with the exception of" | "except" |
| "in accordance with" | "per" / "following" |
| "subsequent to" | "after" |
| "prior to" | "before" |
| "utilize" | "use" |
| "assistance" | "help" |
| "approximately" | "about" |
| "commence" | "start" |
| "terminate" | "end" |
| "facilitate" | "help" / "enable" |
| "demonstrate" | "show" |
| "endeavor" | "try" |
| "implement" | "do" / "run" / "apply" |
| "leverage" (non-financial) | "use" |
| "interface with" | "talk to" / "connect to" |
| "touch base" | "check in" |
| "circle back" | "follow up" |
| "bandwidth" (metaphorical) | "time" / "capacity" |
| "synergize" | *(delete or rewrite — meaningless)* |
| "moving forward" | *(delete)* |
| "going forward" | *(delete)* |
| "at the end of the day" | *(delete)* |

---

## Clause-Level Compression

### "There is/are" openers
These almost always can be rewritten more directly.

| Verbose | Compact |
|---|---|
| "There is a problem with X" | "X has a problem" / "X is broken" |
| "There are several options available" | "Options:" |
| "There is no doubt that" | "Clearly," / *(delete)* |
| "There is a possibility that" | "Maybe" / "Possibly" |
| "There is a need for" | "We need" |

### "It is/was" openers
| Verbose | Compact |
|---|---|
| "It is important to note that X" | "Note: X" or just "X" |
| "It is worth mentioning that X" | *(delete intro)* → X |
| "It is clear that X" | "Clearly, X" or just "X" |
| "It is possible that X" | "Maybe X" |
| "It was decided that" | "We decided to" |

---

## Over-hedging Patterns (Output Mode)

Claude's own hedges that add length without value:

| Pattern | Action |
|---|---|
| "I should point out that" | delete → just say it |
| "It's important to mention" | delete → just say it |
| "You might find it helpful to know" | delete |
| "Keep in mind that" | "Note:" or delete |
| "It's possible that you may want to" | "Consider" |
| "You could potentially" | "You can" |
| "Generally speaking, most of the time" | "Usually" |
| "In most cases, typically" | "Usually" |
| "There's no one-size-fits-all answer, but" | *(drop if not needed)* |
| "It really depends on your specific situation" | *(only keep if true and material)* |

---

## Structural Bloat (Output Mode)

Watch for these structural patterns that expand length without value:

**The Artificial Tricolon**: "There are three main reasons: first… second… third…"
→ If all three are short and obvious, just list them without the setup sentence.

**The Restatement Close**: Ending with "So in summary, what I've shown above is…"
→ Delete if the content was already clear. Only summarize content >500 words.

**The Disclaimer Sandwich**: Wrapping every claim with "It's worth noting" before and "but of course, this can vary" after.
→ Keep disclaimers only when omitting them would be genuinely misleading.

**The Setup Paragraph**: Starting a response with a paragraph that just describes what the response will contain.
→ Delete. Start with the content itself.

---

## Preserving Meaning: Edge Cases

These *look* like filler but are sometimes meaningful. Use judgment:

| Pattern | Keep if... | Cut if... |
|---|---|---|
| "However," | it signals a genuine contrast | it's just transitional decoration |
| "In fact," | it emphasizes something surprising | it's redundant with context |
| "Of course," | it's acknowledging a shared assumption that matters | it's padding |
| "Interestingly," | the thing is genuinely interesting and the user might skip it | it's self-congratulatory |
| "To be clear," | there was genuine ambiguity | it's defensive throat-clearing |

---

## Negation Preservation (Critical)

**Never compress negations into ambiguity.**

- "do NOT do X" — preserve exactly, never soften to "avoid X" if "avoid" weakens the constraint
- "never", "must not", "prohibited" — preserve the strength
- "at most 3", "minimum 5" — preserve exact numbers

When in doubt about whether compression preserves a constraint's force: keep the original phrasing.
