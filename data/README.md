# The input file

`abc-101-study.ir.json` is an **IR** — an intermediate representation of a
study specification. Upstream, something reads a clinical trial protocol and
emits this. Downstream, something builds it into an eSource system. Your agent
is the downstream half.

It describes protocol ABC-101: **four visits**, **seven source documents
(forms) under each**, and **195 fields** across the 28 forms.

Seventeen of those forms are distinct definitions; the rest are the same form
appearing at more than one visit. Vital Signs appears at all four, Visit Status
and Disease Activity Assessment at three, and Physical Examination, 12-Lead
ECG, Study Drug Administration and Adverse Events at two each. When a form
appears twice its definition is byte-for-byte identical both times. Whether
that means "build it once and attach it" or "build it again under this visit"
is a question about the platform, and platforms answer it differently — find
out how this one does before you assume.

## Shape

```jsonc
{
  "ir_version": "1.0",
  "study":  { "protocol_id": "...", "title": "..." },
  "visits": [
    {
      "name": "Screening",
      "window_start_day": -28,    // study day the visit window opens
      "window_end_day": -1,       // study day it closes
      "forms": [
        {
          "name": "Demographics",
          "repeating": false,     // see below
          "fields": [ /* … */ ]
        }
      ]
    }
  ]
}
```

### Visit

| Key | Meaning |
|---|---|
| `name` | The visit's name, as it should appear in the eSource. |
| `window_start_day`, `window_end_day` | The visit window in study days. Negative days are before baseline. |
| `forms` | Ordered. Seven per visit. |

### Form

| Key | Meaning |
|---|---|
| `name` | The form's name, as it should appear in the eSource. |
| `repeating` | `true` = a log that holds many records per subject-visit (medical history, con meds). `false` = a single record. Platforms model this differently; find out how this one does. |
| `fields` | Ordered. Preserve the order where the platform lets you. |

### Field

| Key | Present when | Meaning |
|---|---|---|
| `label` | always | The field's label. Matched exactly, so reproduce it verbatim. |
| `type` | always | A canonical type — see the vocabulary below. |
| `required` | always | Whether the field is mandatory. |
| `options` | coded types only | Ordered list of `{ code, label }`. `code` is what the system stores; `label` is what a human reads. Both matter. |
| `min`, `max`, `units` | numeric types | A range check. |
| `formula` | `calculated` only | The expression, written against other fields' labels. |
| `skip_logic` | conditional fields | `{ "when_field_label": …, "equals_value": … }` — this field is shown only when the named field in the **same form** holds that value. For coded fields the value is the **code**; for `boolean` fields it is `Yes` or `No`. |

## The canonical type vocabulary

These are semantic types, not widget names. Every eSource platform has its own
element library with its own labels; mapping these thirteen onto whatever this
one happens to call them is part of your agent's job, not something we hand
you.

| Type | Means |
|---|---|
| `text` | Free text, one line |
| `textarea` | Free text, multiple lines |
| `integer` | Whole number; may carry min / max / units |
| `decimal` | Number with a fractional part; may carry min / max / units |
| `date` | Calendar date, no time |
| `time` | Time of day, no date |
| `datetime` | Date and time together |
| `boolean` | Yes / No |
| `single_select` | Choose exactly one from a coded list |
| `multi_select` | Choose zero or more from a coded list |
| `radio` | Choose exactly one from a coded list, all choices visible at once |
| `checkbox` | A single tick — on or off. **Not** a list. |
| `calculated` | Derived from other fields by a formula; not entered by hand |

Two of these pairs are semantically close and are routinely confused:
`single_select` vs `radio` (same data, different presentation) and `checkbox`
vs `multi_select` (one tick vs a coded list). They are distinct here, and a
platform's element library will usually have distinct entries for them too —
sometimes sitting right next to each other with near-identical names.
