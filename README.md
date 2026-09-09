# Intake AI Take-Home Assignment 1a - eSource Build Agent

A Chrome browser extension that acts as an autonomous agent to build a clinical trial study
structure — visits, forms, and fields — inside **any** eSource platform, driven entirely by a
structured input file and a human-in-the-loop approval gate.

---

## 1. What this is

Given `data/abc-101-study.ir.json` (4 visits, 28 form instances, 195 fields), this extension
drives a target eSource web application through its real UI — the same way a human study
builder would — to construct the entire study to spec: correct field types, labels, required
flags, coded values, range checks, and skip logic.

The one constraint that shaped every design decision here: **the exact same extension, with the
same input file and no code changes, has to work on an eSource platform it has never seen.**
Nothing about a specific mock's DOM, element names, button labels, or screen layout is ever
hardcoded into the agent's logic. Everything the agent needs to know about a target platform —
what its element library calls a "single choice" control, where its Save button lives, whether it
supports reusing a form across visits — is discovered at runtime, generically, and never assumed.

---

## 2. What's in this submission

```
├── extension/                  ← the actual deliverable: load this, unpacked, in Chrome
├── data/abc-101-study.ir.json  ← the input file used for every run
├── esource-mock/                ← the provided Mock A, used for development and verification
├── recording/                  
│   └── demo.mp4                   (end-to-end run, including a real human-gate moment)
└── README.md                  
```

> **Note on the recording:** `recording/demo.mp4` contains a trimmed ~3 minute recording,
> satisfying the assignment's requested length, of one end-to-end run including a real
> human-gate approval/rejection moment. The complete, unedited 14-minute recording of the same
> run — showing more of the build across multiple fields and a real rate-limit wait in context —
> is also available here: https://drive.google.com/file/d/1rkz4k_Rrtjx8P1QPXnDvZS0aZb7XLyJN/view?usp=sharing. Both are unedited captures of the same real run;
> the shorter one is trimmed to length, not cut for content.

---

## 3. Setup & installation

The repository intentionally ships with **no working API credentials**. You'll need a free Groq
API key to run the agent.

1. **Get a free Groq API key** — sign up at [console.groq.com](https://console.groq.com), create
   an API key from the dashboard. Groq's free tier is used deliberately here (see §9) and is
   sufficient to run the agent, with one caveat covered in detail in §8.
2. **Load the extension:**
   - Open `chrome://extensions`
   - Enable "Developer mode" (top right)
   - Click "Load unpacked" and select the `extension/` folder
3. **Enter your API key:** click the extension's icon → Options, paste in your Groq key. It is
   stored only in `chrome.storage.local` on your machine — never committed to this repo, never
   sent anywhere except Groq's own API.
4. **Run the target eSource platform** you want to build against (e.g. `esource-mock/`, per its
   own README, on `localhost:5173`).
5. **Open the extension's side panel**, upload the IR file (`data/abc-101-study.ir.json`), and
   click **Start Build**.
6. Approve or reject items as they appear in the human-gate queue. A **Groq call counter**, a live
   **escalation feed**, and a **Last Run Status** panel are all visible in the side panel
   throughout the run.

---

## 4. Architecture

### 4.1 High-level shape

- **Background service worker** — orchestrates the full run, owns the desired-state (IR) vs.
  actual-state comparison, talks to the LLM, owns the request-budget governor.
- **`chrome.debugger` (CDP)-attached tab** — the sole channel into the target page:
  `Accessibility.getFullAXTree` for structure, `Page.captureScreenshot` for visual grounding,
  `Input.dispatch*Event` for every action. This is what makes "extension only, any platform"
  possible at all — it needs no cooperation, API, or special hooks from the target site.
- **Side panel** — the human-gate surface: one pending item at a time, full context (including a
  cropped, marked-up screenshot of exactly what's in question), Approve/Reject.
- **`chrome.storage.local`** — used only as a trace log and an optimization cache. It is
  **never** the source of truth for what's already built — that always comes from live
  perception of the real platform, which is what keeps re-runs idempotent even if storage is
  cleared or the platform is reset.

The extension never touches the mock's own debug hooks (`__readState()`, etc.) at runtime — those
exist purely for the developer's own by-hand verification (see §7), and using them from the agent
itself would be answering a different question than the one the assignment asks.

### 4.2 The per-field loop: Perceive → Locate → Decide → Gate → Act → Confirm → Record

Every field in every form goes through the same seven-step loop:

1. **Perceive** *(free)* — read the current screen via AXTree + a Set-of-Mark-annotated
   screenshot (numbered boxes over interactive elements, so a vision call can reference "element
   #5" instead of guessing coordinates).
2. **Locate** *(free)* — try a literal label-text match against the AXTree first. Most simple
   properties (Label, Required, Minimum/Maximum/Units, Formula) resolve here, at zero cost.
3. **Decide** *(paid, cached)* — for genuinely ambiguous or semantic decisions (which of this
   platform's element-library entries corresponds to `multi_select`?), check an in-run type-
   mapping cache first; only on a cache miss does a vision call actually run. Because the cache is
   keyed by *canonical type*, not by field, this collapses ~195 fields down to roughly one paid
   call per distinct type the platform actually needs disambiguated — on the order of 15–20 calls
   for the entire run, not 195.
4. **Gate** — a risk-tiered decision (confidence × reversibility × blast-radius, not a single
   threshold): clear-cut cases build automatically; ambiguous ones escalate to the side panel with
   full context, and nothing commits until a human decides.
5. **Act** — every action goes through CDP's `Input` synthetic events, never `.value=` or
   `.click()` directly. Framework-controlled inputs can silently swallow direct DOM mutation, so
   this is what makes the agent actually work against an unknown widget library rather than just
   an unstyled HTML form.
6. **Confirm** — independently re-runs Locate from a freshly re-perceived AXTree (never reusing
   the element handle Act just used) and compares the *actual* resulting state against what was
   intended — not just "does the label still exist somewhere on screen." If Confirm's own
   re-Locate resolves to a *different* element than Act's did, that disagreement is itself treated
   as a distinct escalation trigger, since it means something was silently mis-grounded. A failed
   Confirm allows exactly one informed retry (a fresh Decide call, told what just went wrong) —
   never a blind re-click, and never an unbounded loop.
7. **Record** — every action writes a structured trace entry: which IR entry it came from, what
   was decided and why, the confidence, the gate outcome, the confirm result, and a timestamp.
   This is what answers the assignment's traceability requirement — not just *which* element was
   built, but *why*.

### 4.3 Above the field loop

```
Step 0 — Orient: confirm the landing screen is actually a usable starting point
                  (bounded exploration if not — see below)

For each visit in the IR, in order:
  → CREATE VISIT (name, window)
  For each form under that visit, in IR order:
    → probe reuse/attach affordance once per distinct form definition, cache the result
    → CREATE or ATTACH the form accordingly
    For each field in IR order (this order matters — it's what guarantees a
      skip-logic rule's controlling field already exists before the rule is set):
      → run the 7-step loop above
    → SAVE FORM — its own explicit, mandatory Act + Confirm; the agent never
      navigates away from a form until this step is independently confirmed to
      have actually persisted
    → (optional) ACTIVATE, gated by three independent checks (see §5)
```

**Step 0 — Orient** exists because Mock A happens to start on an already-usable screen, and a
different, unseen platform might not (a login wall, an intermediate dashboard). Orient runs a
free structural check first; if the screen doesn't already look usable, it makes one vision call
to classify the screen as USABLE / NAVIGABLE / UNKNOWN, and — if NAVIGABLE — follows the most
promising candidate, capped at 4 hops, before escalating. This costs at most a handful of extra
calls and is the kind of thing that only matters once the agent is run against something other
than the platform it was built against.

**Idempotency** comes from re-deriving "what's already built" by walking the real platform at the
start of every run (existing visits, existing forms, existing field labels) — never from trusting
local storage. Re-running the agent recognizes already-built items and skips them rather than
duplicating them.

**Draft vs. Activate:** the IR file has no status field, so there's no ground truth telling the
agent whether a finished form should end in Draft or Active. **Documented assumption:** every
field is built and fully verified in Draft first; Activation, where the platform supports it, is
the very last step for a form, gated by three independent checks — the run wasn't stopped
partway through this form, every field the IR names has a `created`/`already_exists` outcome with
zero escalations or rejections, and a fresh, independent re-scan of the editor genuinely finds
every expected field label on screen right now.

---

## 5. Type-mapping strategy

The input file speaks in canonical types (`text`, `single_select`, `checkbox`, `boolean`, …). A
target platform speaks its own vocabulary for the same concepts, and — per the assignment's own
warning — near-identical names are routinely placed right next to each other for genuinely
different controls (a "Dropdown" next to a "Combo" next to a "Picklist"). This mapping is treated
as a semantic problem, never a string-matching one:

- The first time a canonical type needs disambiguating on a given platform, a vision-capable model
  is shown a screenshot of the platform's real element library and asked, in plain language, which
  entry actually matches the *meaning* of the canonical type (e.g. "a control for choosing exactly
  one value from a fixed list of options").
- That resolution is cached for the rest of the run, keyed by canonical type — so the cost of
  disambiguation is paid once per type, not once per field.
- A resolution a human approves through the gate is cached exactly the same way an LLM-confident
  one is. Without this, a genuinely ambiguous type would re-escalate individually for every field
  of that type, which is exactly the "hasn't saved anybody time" failure the assignment warns
  against.
- As a free, corroborating (never authoritative) second signal, once a field is built, its real
  rendered ARIA role is compared against a *cluster* of roles plausible for its canonical type —
  not a strict one-to-one mapping, since the same canonical type can legitimately be implemented
  several different ways across platforms (e.g. `multi_select` as a `listbox`, or just as a group
  of native checkboxes — both valid). A role that shares zero overlap with any plausible cluster
  (e.g. expected `text`, actually rendered `checkbox`) is a genuine, hard contradiction and
  escalates; an absent or generic role is treated as inconclusive, never as a failure, since custom
  widgets on an unseen platform frequently expose no specific role at all even when built
  correctly.
- Coded values (`{code, label}` pairs) are always entered and verified as pairs, never labels
  alone, and always via per-option entry rather than any bulk-paste shortcut a platform might
  offer — bulk shortcuts require guessing a delimiter format at runtime with no generic way to
  discover it, and are explicitly warned to replace rather than append.
- Range checks and formulas are written, then independently re-located and re-read to confirm the
  actual value that landed matches what was intended — not just trusted from the click.

---

## 6. Human-gate design

**Principle:** the gate exists to catch exactly the things the agent isn't confident about — never
everything, and never nothing. Over-escalation (making a human re-verify all 195 fields) defeats
the purpose as completely as under-escalation does.

**What the reviewer sees:** one pending item at a time, with a tightly cropped, Set-of-Mark
annotated screenshot of exactly the element in question (not a full-page screenshot — an early
version sent the full page and the marks were too small to read; the crop is scoped to just the
field's own newly-added candidates), plus the agent's own reasoning for why it's unsure.
Approve/Reject controls decide the outcome; an approval both builds the field and — for
type-mapping ambiguity specifically — caches the resolution for every later field of the same
type, so a human never has to resolve the same ambiguity twice in one run.

**What triggers escalation:**

| Trigger | How it's caught |
|---|---|
| Ambiguous canonical-type-to-platform mapping | Decide's confidence falls below the auto-build floor |
| A coded-value list can't be entered cleanly | Confirm's independent read-back compares the full option set as `{code, label}` pairs; any mismatch escalates |
| A skip-logic rule's controlling field can't be found | The field-selector locate step throws rather than guessing a nearest match |
| A range check the platform silently altered | Confirm's independent re-read of Min/Max/Units after typing |
| Uncertain form/field save | The commit-and-retry step allows one informed retry, then escalates rather than looping or falsely reporting success |
| A confirmed element's ARIA role contradicts its expected type with zero overlap | The structural-role cross-check inside Confirm (§5) |
| A visit window wants a calendar date rather than the IR's relative-day integer | Documented policy — escalate rather than fabricate a date (see §8) |
| No calculated/derived field type exists on the target platform at all | The same "no candidate found for this canonical type" path every type goes through |

**Escalation is never a dead end for the run.** A per-run policy skips a failed item and moves on
(dependency-aware — a form whose own build failed doesn't try to build fields under it), backed by
a single circuit breaker that stops the whole run if escalations pile up in a way that suggests a
structural break rather than isolated ambiguity, and every run ends with a grouped summary of
everything that needed attention.

---

## 7. Verification: how this was checked by hand

Every claim above was checked against the platform's real, saved state — not assumed from a
function's return value:

- Every field built during development was independently verified via the mock's own
  `__readState()` dump (used only as a developer's manual audit tool, never called from the
  agent) against the real IR entry — label, type, required flag, options (code *and* label),
  min/max/units, skip logic, and formula, field by field, with no discrepancies found.
- Visits and forms were separately confirmed present in the platform's own real UI (the Visit
  Schedule table, the Source Documents table) — not just trusted from the agent's own success
  return value.
- The human-gate's escalation triggers were exercised directly: several occur naturally against
  the real platform (a genuine `radio`-vs-`single_select` ambiguity on "Sex at Birth"/"Ethnicity" —
  exactly the confusable pair the input file's own schema doc calls out by name); others were
  forced via clearly disclosed, temporary fault injection so the escalation *mechanism* itself
  could be proven correct even where the specific platform being developed against doesn't happen
  to produce that failure organically (e.g. Mock A's own range-check inputs accept literally
  anything, so an organic "platform rejects a range value" case can't occur on it — the mechanism
  was proven instead by injecting a fault after the real code had already run). Every injection was
  fully removed immediately after capture; nothing test-only remains in the shipped code.
- The largest single run completed during development built **131 fields across three complete
  visits with zero escalations and zero rejections** — stopped only by the day's Groq token
  budget being exhausted, not by any bug (see §8).

---

## 8. Known limitations — where it breaks, and what it does when it breaks

**The one real, repeated obstacle during development and testing was Groq's free-tier daily
token/rate budget — nothing else.** Every mechanism in this agent (the per-field loop, the
save-then-confirm discipline, the skip-logic wiring, the reuse probe, the Draft→Activate gate, the
escalation matrix) was live-tested end-to-end against the real 195-field input and worked
correctly. The only thing that ever stopped a run mid-flight was the daily budget on Groq's free
tier being used up — never a crash, a hang, or an incorrect build.

Concretely:

- **A genuinely uninterrupted, single-sitting run of the full 195-field input has not yet been
  completed**, purely because Groq's free-tier daily token allowance runs out before a full run
  finishes in one day, given the free tier's request/token ceilings. This is a resource
  constraint of the free tier, not a defect in the agent.
- **What the agent does when this happens:** it stops cleanly at exactly the point it was
  interrupted, leaves the reconciliation state exactly where it is, and surfaces this plainly in
  the side panel rather than failing silently or corrupting anything. Because "what's already
  built" is always re-derived from the live platform rather than trusted from local state (§4.3),
  resuming later — even the next day, once the budget resets — picks up correctly from wherever
  the run actually stopped, with no duplication and no lost progress.
- **Run time:** based on two large, real (though budget-interrupted) runs, a full 195-field build
  is estimated at **roughly 38–50 minutes of active wall-clock time**, including realistic
  rate-limit throttling. This is an honest extrapolation from real, partial-run data, not a
  measurement from one clean, uninterrupted 195-field run — the free-tier budget is what stands
  between this and a single fully measured end-to-end number.
- **Disclosed, minor limitations, none of which affected any real run:** the extension currently
  assumes the target platform's builder lives in a single tab (a builder that opens a new
  window/tab, or is embedded in an iframe with its own navigation, isn't handled yet); the human
  gate currently shows one pending item at a time rather than a full non-blocking triage queue,
  and approval is Approve/Reject only, with no inline edit — both are named, reasoned next steps
  in §10, not overlooked gaps.

---

## 9. AI tools used

**Claude (Anthropic), used through the claude.ai chat interface, across an extended, multi-session
build process.**  Claude helped me understand the codebase's architecture and implementation, and did the bulk of the live
debugging along with me. I was the one at the keyboard for every actual test — running commands in the
browser, reading console output, reporting back screenshots, and deciding and mentioning the next step to do when something
looked wrong checking for its approval. Claude's proposals were reviewed, tested, and either accepted, pushed back on, or asked to be reworked.

**Where it genuinely helped:**
- The overall architecture (why Perceive/Locate/Decide/Gate/Act/Confirm/Record is the right shape,
  why LOCATE tries a free literal-label match before ever paying for a semantic model call, why
  Confirm must independently re-locate an element rather than trust the handle Act just used) came
  from Claude reasoning through our discussion and the assignment's own stated failure modes, sometimes grounded in
  published research on tool-using agent failure rates that I would not have gone and found myself
  on this timeline.
- Few of the real bugs this project found were diagnosed by Claude from raw evidence that
  I provided (console traces, screenshots, `__readState()` dumps) rather than guessed at — e.g. a
  Groq rate-limit ceiling that took two wrong guesses before Claude found the actual documented
  cause, or a vision-model reasoning-budget issue that turned out to be genuine prompt ambiguity
  rather than a token-limit problem once actually investigated.
- Some escalation triggers forced during Phase 7's testing (the range-check mismatch, the
  uncertain-commit retry, the structural-role contradiction) were designed with the help of Claude 
  as a specific, minimal, disclosed test — including recognizing, ahead of running it, when the "obvious" test
  (typing a bad value into the mock's own UI) wouldn't actually prove anything because the mock
  doesn't validate input at all, and proposing honest fault-injection instead of a fake pass.

**Where it got in the way, or was simply wrong, and had to be corrected:**
- **A real crash Claude caused directly.** While wiring the human-gate screenshot feature, Claude
  gave me an import path written for a six-folder structure that, unknown to it at that moment, no
  longer matched my actual working folder (which had been flattened outside of a guided step). The
  result was a genuine "service worker registration failed" crash. It took several rounds of
  back-and-forth — me reporting exact error text and screenshots, Claude ruling out wrong theories
  first — before the actual cause (a stale relative import path) was found.
- **A design Claude shipped that looked right in code but was actually unusable.** The first
  version of the human-gate screenshot sent the entire page as one image. It worked technically,
  but I was the one who noticed, by actually looking at it, that the Set-of-Mark boxes were too
  small to see and the image looked cluttered — Claude's own review of its code hadn't caught
  this, because it's a visual/UX problem, not a logic bug. That feedback is what led to the
  cropped-screenshot redesign that's actually in the final build.
- **A real research mistake, corrected by hands-on testing, not by re-reading.** Early on, Claude's
  reading of the mock's screens concluded a certain UI button handled whole-form reuse. It didn't —
  live, manual clicking through three real screens showed it was a field-level control with nothing
  to do with forms. The underlying conclusion (no reuse mechanism exists) turned out to still be
  right, but for a reason Claude had originally gotten wrong.
- **A dropped import line during a multi-file edit**, which would have crashed the very first visit
  of any real run — caught only because I insisted on re-reading the actual pasted file before the
  next test run, rather than assuming the edit instruction had been applied cleanly.
- **Scope honesty required real pushback from me, not just from Claude.** Given the time I had
  left, I explicitly asked Claude to scope Phase 7 down to a lighter, honestly-labeled version
  rather than attempt the full design — and separately asked for the escalation-trigger testing to
  be lightened the same way. Claude's response in both cases was to lay out exactly what would be
  cut, why each cut was safe, and to insist that whatever got cut be named plainly in this README
  rather than quietly dropped — but the decision to cut scope at all, and by how much, was mine. 
  Thus, I ensured that all the necessary components were implemented and not skipped.
- **What I did myself:** every real test in this repository was run by me, manually by hand, against the actual running mock — I read every console error and screenshot before reporting it back, caught the "no SoM marks visible", "looks messy" and several other issues by my own inspection rather than Claude's, and made every real scope decision (the Phase 7 lightweight-gate scope-down, the 4-live/4-traced trigger split, keeping the file layout permanently flat) after being shown real trade-offs, not by Claude's decision alone. 
---

## 10. What I'd build next, given two more weeks

- **A reversibility probe.** Right now, visit and form creation always escalate to the human gate
  regardless of confidence, as a deliberately conservative interim policy — since on the platform
  developed against, a saved visit can't be edited or deleted at all. A proper probe would check,
  generically, for a resulting edit/delete affordance after any create-action, and use its
  presence or absence to gate *future* instances of that same action class more intelligently over
  the course of a run, rather than treating every creation as equally irreversible up front.
- **Non-blocking, concurrent handling of independent escalations.** Today the build loop waits on
  one pending gate item at a time; a real triage queue where independent items (different forms,
  different visits) could be reviewed without blocking the rest of the run would meaningfully
  speed up a run with several genuine ambiguities.
- **An edit affordance on gate items**, not just Approve/Reject — letting a reviewer correct a
  near-miss mapping directly rather than rejecting and leaving that field unbuilt.
- **Multi-tab/iframe support**, for a target platform whose builder doesn't live in a single flat
  tab.
- **A paid LLM tier or a second provider as overflow**, purely to remove the daily-budget
  interruption described in §8 and get a genuinely uninterrupted full-run measurement.

---

## 11. Documented assumptions (things I'd ask a clinical SME rather than guess)

- **Calculated fields on a platform with no derived-field concept.** Seven fields in the input
  (BMI, Pulse Pressure, QTcF) are explicitly "not entered by hand" — they carry a formula
  referencing other fields by label. If a target platform has no live-computed field type at all,
  is the right behavior to leave it unbuilt and escalate, to build a plain read-only field
  pre-populated with the formula string for a human to interpret later, or something else?
  **Default adopted:** escalate — never invent a fallback representation for a value that's
  supposed to be derived, not entered.
- **Visit windows with no absolute reference date.** The input's visit windows are relative
  day-offset integers (`-28`, `0`, `25`, `81`) with no enrollment or baseline date anywhere in the
  file. If a target platform's visit-creation UI requires an actual calendar date rather than a
  relative offset, what date should the agent use? **Default adopted:** if the UI doesn't appear
  to accept a plain relative-day integer, escalate rather than fabricate a date.
