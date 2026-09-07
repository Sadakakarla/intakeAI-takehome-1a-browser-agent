# Take-Home Assignment 2 — Software Engineer, Intake AI

**Time:** Up to one week from receipt. Work alone.
**What you get:** This folder — a running eSource mock and a structured specification of a four-visit study.
**What you return:** A code repository with a README and a loadable browser extension.

---

## Background

### What is eSource?

In a clinical trial, *source data* is the first place a clinical observation is
written down. Historically that was paper: a coordinator measured a patient's
blood pressure, wrote it on a worksheet, and later transcribed it into the
sponsor's electronic data capture (EDC) system. Every transcription step is a
place where data gets lost, mistyped, or delayed, and it consumes an enormous
amount of site staff time.

**eSource** means capturing that first record electronically, at the point of
care, in a purpose-built system — removing the paper-to-EDC transcription step
entirely. In practice an eSource system is a web application. It holds a study,
a schedule of visits, and under each visit a set of source documents (forms):
Demographics, Vital Signs, ECG, Hematology, Concomitant Medications. Each form
holds anywhere from five to fifty fields, and each field carries a type, a
label, whether it is required, a range check with units, a list of coded values,
and sometimes conditional logic that shows or hides it based on another answer.

### The part nobody talks about: someone has to build the study first

Before a single patient is enrolled, that entire structure has to exist in the
system. Every visit. Every form. Every field, with the right type, the right
label, the right range, the right coded values, the right skip logic — matching
the protocol exactly, because the protocol is the contract with the regulator.

Today this is done by hand. A study builder opens the eSource platform's form
designer and clicks through it, field by field, for a study that might have
thirty visits and four hundred fields. It takes weeks. It is error-prone in
ways that are expensive to discover late, because a field built with the wrong
type is a database column that has to be migrated after patients are already
enrolled in it. And it has to be redone, from scratch, every time the sponsor
amends the protocol.

**That build is what this assignment is about.**

The critical fact: **every eSource platform is different.** There are several
major commercial products and a long tail of sponsor- and CRO-specific builds.
They have different navigation, different form designers, different DOM,
different widget libraries, and different names for identical concepts — one
calls it a Dropdown, the next a Picklist, the next a Combo. There is no API you
can rely on and no standard you can code against.

### What's in this folder

- `esource-mock/` — a mock eSource platform. The root `README.md` tells you how
  to run it on localhost. It starts empty: a study name and nothing else.
- `data/abc-101-study.ir.json` — the input. Four visits, seven forms under each,
  195 fields across the 28 forms — seventeen distinct form definitions, several
  of them recurring at more than one visit. `data/README.md` documents the
  schema and the canonical type vocabulary.

The mock is representative of what an eSource looks like. It is **one example
of the category, not the category itself.**

---

## The assignment

Build a **browser extension** that acts as an agent. Given the input file, it
should drive the eSource application in the browser — creating each visit,
creating the source documents under it, and building every field with its
correct type, label, required flag, coded values, range check and skip logic —
with a human in the loop to reconcile anything it is not sure about.

At the end of a successful run, the study built inside the mock should match
the input file.

**The core constraint, and please read it twice:**

> **WE KNOW THAT DUMPING THE DOM OF THIS PARTICULAR eSOURCE MOCK AND WRITING
> DETERMINISTIC SELECTORS AGAINST IT WILL PRODUCE A PERFECT RESULT ON THIS
> MOCK. THAT IS NOT WHAT WE ARE ASKING FOR AND IT WILL NOT PASS. BUILD IT SO
> THAT IT WORKS ON ANY eSOURCE. THE SAME EXTENSION, WITH THE SAME INPUT FILE
> AND NO CODE CHANGES, SHOULD WORK ACROSS 100 DIFFERENT eSOURCE MOCKS —
> DIFFERENT LAYOUTS, DIFFERENT DOM, DIFFERENT WIDGET LIBRARIES, DIFFERENT
> NAVIGATION, DIFFERENT NAMES FOR THE SAME FIELD TYPE, DIFFERENT PLACES WHERE
> "SAVE" LIVES. ANY CSS SELECTOR, ELEMENT ID, BUTTON LABEL, LIBRARY ENTRY NAME,
> OR SCREEN ORDER HARDCODED TO THE MOCK WE GAVE YOU IS A FAILED SUBMISSION.**

We will run your extension against an eSource mock you have not seen, using the
same input file.

Beyond that constraint the assignment is open-ended. Any stack, any model, any
API, any library. AI coding assistants are expressly permitted and expected —
tell us what you used and where it helped or hurt.

### The human gate

The extension must not silently commit. Where the agent is confident, it
builds. Where it is not — an ambiguous mapping between a canonical type and the
platform's element library, a coded-value list it can't enter cleanly, a skip
logic rule whose controlling field it can't find, a range check the platform
won't accept, a form it isn't sure it created — it surfaces the item to a human
for a decision *before* that piece is saved.

Designing that experience is a real part of this assignment, not a footnote. A
tool that makes the study builder re-verify all 195 fields has saved nobody any
time. A tool that quietly guesses is worse than useless, because a wrong field
type discovered after go-live costs more than building it by hand would have.
The interesting engineering is in deciding what gets built automatically, what
gets escalated, how the escalation is presented, and how fast a human can clear
the queue.

---

## Special considerations

These are the parts that are actually hard.

**Type mapping is semantic, not string matching.** The input speaks in
canonical types (`single_select`, `multi_select`, `checkbox`, `boolean`). The
platform's element library speaks its own language. The two are related by
meaning, not by spelling, and platforms routinely place near-identical names
next to each other — a list-of-choices control and a single tick-box may sit
one row apart with almost the same name. Getting these wrong is the single most
common way a build looks finished and is not.

**Missing forms and fields are the most heavily penalized failure.** Recall
matters more than precision. A spurious extra field is a problem; a form or
field that never got built is a much bigger one, because nobody notices until
data collection has already started.

**A new element is not automatically a named element.** Adding a control to a
form and giving it the right label are separate acts. An element that exists
but was never named is structurally present and semantically worthless.

**Coded values are pairs.** Every option has a code (what the system stores) and
a label (what a human reads). Entering only labels produces a field that looks
right and stores the wrong thing. Bulk-entry shortcuts, where a platform offers
them, tend to *replace* rather than *append* — check what actually happened.

**Skip logic depends on order.** A conditional field references another field in
the same form by label. That field has to exist before the rule can be set.
There are thirteen such rules in the input. Build order is your problem to work
out.

**The same form appears at more than one visit.** There are seventeen distinct
form definitions across twenty-eight appearances — Vital Signs alone is at all
four visits, with identical fields every time. Whether the platform lets you
reuse a definition or requires
you to build it again under each visit is something to find out, not assume —
and a naive agent will get this wrong in one direction or the other.

**Range checks and units apply to some types and not others.** Platforms
commonly discard values the current type can't hold — silently — when the type
is changed. If your agent sets a type after setting a range, it may find the
range gone, and it will not be told.

**Saving is explicit, and reaching a screen is not building.** Work in a form
designer typically lives in a working copy until something commits it, and
navigating away can discard that copy without warning. Assume nothing is
persisted until you have confirmed it is.

**Not every button that looks like the one you want is the one you want.** Real
form designers are full of adjacent controls that look identical and do
different things, including some that look like they save and don't. Read what
happened rather than trusting that a click did what its label implied.

**Verify what you built, don't assume it.** The difference between an agent that
works and a demo that works once is read-back: after building something, check
that what's there is what you meant. This is also how you catch the failures
above, all of which are invisible at the moment they occur.

**Idempotency.** Running twice should not produce two Demographics forms under
Screening, or two copies of every field. Decide what a re-run means and make it mean that.

**Traceability.** For every element the agent creates, you should be able to say
which entry in the input file it came from and why. In a regulated environment
this is not optional.

**Don't use the mock's debug hooks.** `__readState()` and friends exist so a
human can check results by hand. They are not part of the platform, they will
not be there on the systems that matter, and an agent that reads them is
answering a different question than the one we asked.

---

## Verifying your work

Check it by hand. Run the extension end to end, then open the mock and compare
what got built against the input file — every form present, every field
present, every type correct, every coded value list complete with both codes
and labels, every range and unit, every skip logic rule, the right forms marked
as repeating. `__readState()` in the DevTools console will dump the saved study
as JSON, which is a great deal easier to diff than clicking through 28 forms.

Then do the thing that actually matters: **change the mock, and run again.**
Rename its element library entries. Move Save somewhere else. Reorder the
screens. Swap a dropdown for a radio group. Restructure the DOM. Or write a
second mock of your own with a different shape. Run your extension against it
unchanged and report honestly what happened.

A submission that reports 70% on a mock it had never seen is stronger than one
that reports 100% on the mock it was written against. We will be running the
second experiment ourselves either way.

---

## What to submit

A single repository containing:

- **The extension**, loadable unpacked in Chrome, with setup instructions clear
  enough that we can install it and run it ourselves against this folder.
- **A short screen recording** (2–3 minutes, unedited is fine) of one end-to-end
  run, including the human gate.
- **A README** covering:
  - your architecture — how the agent perceives the page, decides what to do,
    acts, and confirms;
  - how you map canonical types onto an unknown platform's element library;
  - how the human gate decides what to escalate, and what the reviewer sees;
  - what you did to make it generalize, and **what evidence you have that it
    does** — including your results against a modified or second mock;
  - the results of your by-hand verification;
  - where it breaks, and what it does when it breaks;
  - roughly how long a full run takes;
  - what you would build next given two more weeks;
  - which AI tools you used, and where they helped or got in the way.

---

## Ground rules

- One week from receipt. Work independently.
- Document your assumptions. If there's something you'd want to ask a clinical
  subject matter expert, write the question down rather than guessing silently
  — we'd rather see the question.
- Free tiers and trial credits are fine. Don't spend money you aren't
  comfortable spending.
- Materials are provided for this assignment only; please don't redistribute
  them.

We are evaluating how you handle an underspecified problem where the obvious
solution is the wrong one. If anything is unclear, email [CONTACT]. Good luck.
