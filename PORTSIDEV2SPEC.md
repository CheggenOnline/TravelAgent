# Portside v2 — build instruction

This extends the existing Portside app. It is not a rewrite. All the constraints in
`README.md` still hold: single self-contained `index.html`, no frameworks, no bundler, no
CDN, works fully offline, bump the `sw.js` cache version on every change.

Read this whole document before writing code. Build in the phases at the end — do not attempt
it in one pass.

**One judgement call to confirm with Christian before building the dashboard:** cards are
ranked by *computed urgency*, not shown in a fixed order. A fixed dashboard is correct on day
one and stale by day three. If he wants fixed order instead, that is a small change to
`scoreCard()` — everything else is unaffected.

---

## 1. The three ideas this is built on

Everything below follows from these. If an implementation detail conflicts with one of these,
the principle wins.

**1. Requirements roll up; packing rolls down.**
Activities do not own packing lists. Activities own *requirements*. A requirement rolls **up**
into the suitcase (what leaves the house) and **down** into a daypack list for the morning of
that activity. If it is not in the suitcase it cannot be in the daypack.

**2. The departure boundary flips the advice.**
The same missing item produces a different suggestion depending on which side of departure you
are on. Before: "add to your packing list." After: "buy, rent or borrow it there — or this
activity is at risk." Never give the pre-departure answer to a post-departure problem.

**3. Claude at capture time; deterministic logic thereafter.**
Call the API once, when something is added, and **store the result as data**. Everything after
that — diffing requirements against the packing list, computing gaps, building the daypack,
scoring dashboard cards — is plain local JavaScript. It must work offline, cost nothing to
re-run, and give the same answer twice.

---

## 2. Data model additions

Existing shape is `S.trips[] → trip.items[]`. Keep `items` exactly as it is. Add these arrays
to each trip. All new fields are optional with sane defaults so v1 data keeps working.

### trip (new fields)

```js
trip.departureAt   // "YYYY-MM-DDTHH:MM" — when you leave home. Derived from the earliest
                   // critical flight/ship item if not set by the user. Drives principle 2.
trip.people    = []  // Person[]
trip.bags      = []  // Bag[]
trip.lists     = []  // List[]
trip.refs      = []  // Ref[]
trip.suggestions = []  // Suggestion[] — pending, never auto-applied
```

### Person / Bag

```js
Person { id, name, isMe:bool, notes }          // notes = dietary, mobility, age if a child
Bag    { id, name, kind:'checked'|'cabin'|'daypack'|'person', personId, weightKg:null }
```

Seed one Person (`isMe:true`) and three Bags (checked, cabin, daypack) on trip creation. Do
not make the user configure this before they can use the app.

### List — one type, three flavours

```js
List {
  id, kind:'checklist'|'packing'|'shopping',
  title,
  due:'YYYY-MM-DDTHH:MM'|'',   // deadline. Flows into the timeline and Now view.
  leadMinutes: number|null,     // how far ahead to start surfacing it. See §3.
  forActivityId:'',             // set when this is a derived daypack list
  archived:false,
  createdAt,
  entries:[Entry]
}

Entry {
  id, text, done:false,
  qty:null, bagId:'', personId:'',
  where:'',                     // shopping only: 'home' | 'there'
  price:null, currency:'',      // shopping only
  requiredFor:[activityId],     // which activities need this — drives at-risk warnings
  source:'manual'|'ai'|'derived',
  reason:'',                    // "Mountain hike, 20 Aug" — always set when source !== manual
  note:''
}
```

A packing list is a List with `kind:'packing'` whose entries carry `bagId`. A shopping list is
a List with `kind:'shopping'` whose entries carry `where` and `price`. Do not create three
separate types — the UI differs, the storage does not.

### Ref — the reference vault

```js
Ref {
  id, label, value,
  category:'identity'|'booking'|'money'|'medical'|'connectivity'|'emergency'|'other',
  masked:false,             // hide the value until tapped
  expires:'YYYY-MM-DD'|'',  // passport expiry, insurance validity
  relatedItemId:'',         // ties a booking ref to the flight it belongs to
  note:''
}
```

Values must be copyable in one tap. Refs must be searchable and must render with **no network**.

> **Security note to state plainly in the UI:** refs are stored in plain `localStorage`, not
> encrypted. The app must show a one-line warning on the vault screen and must NOT encourage
> storing full card numbers, PINs or passwords. Passport *number* and insurance policy number
> are the intended use; card PINs are not.

### Suggestion — proposals awaiting a decision

```js
Suggestion {
  id, kind:'pack-add'|'pack-swap'|'buy-there'|'list-create'|'item-add',
  title, reason,            // reason is mandatory and user-visible
  payload:{},               // enough to apply it without another API call
  status:'pending'|'accepted'|'dismissed',
  createdAt
}
```

**Never apply a suggestion automatically.** Propose, the user accepts. See §5.

### item (new fields on existing items)

```js
item.leadMinutes = null    // surface earlier than the reminder; see §3
item.requirements = null   // set by the REQUIREMENTS call, see §5. Shape:
// { generatedAt, pack:[{text, qty, essential:bool, daypack:bool}], hazards:[string], notes }
```

### Migration

Bump the storage key to `portside.v2`. In `load()`: if `portside.v2` is absent and
`portside.v1` exists, read v1, add the new arrays with empty defaults, write v2, and **leave
v1 in place untouched** as a fallback. Losing trip data is the worst possible outcome — do not
migrate destructively, and do not delete v1 for at least one release.

---

## 3. Due time vs surface time

Every List and every item has two distinct concepts:

- `due` — when it must be finished.
- `leadMinutes` — how long before `due` it starts appearing on the dashboard.

"Order currency" is due before departure but should surface two weeks out. A daypack list is
due at 07:00 but should nag the **evening before**, while you can still do something about it.
Defaults: checklists 1 day, packing lists 3 days, daypack lists 14 hours (so an 07:00 daypack
surfaces at 17:00 the previous day), shopping lists surface for the whole trip.

---

## 4. The dashboard

Replace the current Now tab. Cards are computed, ranked and filtered — a card that has nothing
to say does not render.

### Card ranking

Each card returns a score from `scoreCard()`. Sort descending, drop zeros, render in order.
Suggested scores (tune later, keep them in one table so they are easy to change):

| Card | Renders when | Score |
|---|---|---|
| **Hard deadline** | Any `critical` timed item ahead (all-aboard, flight, last train, tour meeting) | 1000 minus minutes remaining; always first inside 6 h |
| **Needs attention** | Any alert exists (see below) | 900 per unresolved critical alert, else 400 |
| **Today** | Any item dated today | 800 |
| **Next checklist** | A list is inside its surface window | 700 + (100 if overdue) |
| **Packing status** | Pre-departure, or a daypack is due | 650 pre-departure, 850 if a daypack gap exists |
| **Suggestions** | Any `status:'pending'` | 600, capped at 3 shown |
| **Coming up** | Any future item beyond today | 500 |
| **Shopping / wishlist** | List has unticked entries | 300, +200 when in destination and `where:'there'` |
| **Quick refs** | Any refs exist | 250 |
| **Trip summary** | Always, if a trip exists | 100 |

**Needs attention** aggregates: critical items that passed without being ticked; a cancellation
deadline within 48 h; a document expiring within 90 days or before the trip ends; a required
packing item still unticked with under 24 h to its activity; storage full.

### Card behaviour

- **Every card is actionable in place.** Tick a checklist entry from the dashboard without
  navigating. This is the single most important UX rule here.
- Cards show at most **3–5 rows** plus a "see all" that opens the full view.
- Checklist card shows `title`, progress (`4/11`), due, and the next unticked entries.
- Packing card shows gap count and *which activity* caused the gap.
- Shopping card groups by `where`, and shows the "there" group when the trip is underway.
- Quick refs shows the 4 most contextually relevant refs — booking refs near a flight,
  room/wifi while at a hotel, insurance and emergency numbers otherwise.
- Every card has a genuinely useful empty state, not a blank box.

---

## 5. The AI calls

Four calls total. Two exist, two are new. All follow principle 3: called once, result stored.

**EXTRACT** *(exists — upgrade it, see §6)*

**REQUIREMENTS** *(new)* — fires when an activity item is added or materially edited.
Input: the item, plus trip context (dates, destination, the relevant leg, season).
Output stored in `item.requirements`:

```json
{ "pack":[{"text":"Waterproof shell jacket","qty":1,"essential":true,"daypack":true}],
  "hazards":["Weather changes fast above 1000 m","Sunset 17:20 — bring a headlamp"],
  "notes":"No mobile coverage on the ridge. Tell someone your route." }
```

**LIST_SUGGEST** *(new)* — fires on demand ("check my list") and once when a trip enters its
packing window. Input: the list, the trip, and all activities with requirements.
Output: an array of Suggestions with mandatory `reason`.

**RECOMMEND** *(exists, unchanged)*

### The requirement diff — this is local code, not an API call

```
for each activity with requirements:
    for each required pack entry:
        find a matching entry in the trip's packing list
          (normalised lowercase compare, plus a small local synonym map:
           "shell"≈"rain jacket"≈"waterproof", "headlamp"≈"head torch", etc.)
        if no match → it is a GAP
```

Then apply the departure boundary:

- `now < trip.departureAt` → Suggestion `pack-add`: "Add to packing list."
- `now >= trip.departureAt` → Suggestion `buy-there`: "Buy / rent / borrow at destination",
  and if the item is `essential`, raise a **Needs attention** alert that the activity is at risk.

Run this diff on every render. It is cheap, offline, and deterministic. Never call the API to
re-check a list you have already analysed.

### Daypack generation

When an activity has requirements and a `daypack:true` subset, create a List with
`kind:'packing'`, `forActivityId` set, `due` at a sensible hour on the morning of the activity,
`leadMinutes` 14 h.

**The entries must reference what is actually packed.** For each daypack requirement, if a
matching entry exists in the trip packing list, the daypack entry says "Boots — in checked
bag". If it does not exist, the entry is flagged as missing, not silently listed. That is the
difference between a generic list and a useful one.

### Suggestion discipline — non-negotiable

1. Never modify a list without acceptance. Propose only.
2. Every suggestion carries a visible `reason`.
3. Cap at **8 pending suggestions**; show the highest-value ones and drop the rest.
4. Dismissals are sticky. Write the normalised text to a **global** `S.neverSuggest[]` that
   survives across trips. If Christian says no to thermal underwear twice, it must never be
   suggested again on any trip. A feature that nags is a feature he will stop reading.
5. Separate "essential for this activity" from "nice to have" visually.

---

## 6. Program capture — the core flow, upgraded

Photographing a printed programme (cruise daily, festival schedule, conference agenda) is the
most important input path in the app. Current extraction pulls isolated facts. A programme is
a *structured schedule* and needs three changes:

1. **Pick list, not add-all.** A cruise daily has forty rows; the user wants five. The review
   screen becomes a selectable list, everything **unselected by default** for programmes,
   with select-all available. For single documents (one boarding pass) keep the current
   behaviour of everything selected.
2. **Ask the date once.** Programmes usually print "Tuesday" not a date. If the extractor
   returns rows without dates, ask once at the top of the review screen and apply to all rows.
3. **Multi-page is one programme.** Several photos submitted together produce one reviewable
   set. Keep the source photos attached to the created items so the user can re-read what the
   sign actually said.

Extend the EXTRACT output with `"kind":"program"|"document"` and an optional `"programDate"`
so the review screen knows which mode to render.

---

## 7. Phases

Ship each phase before starting the next. Run the smoke test before every commit.

**Phase 1 — foundations and dashboard**
Data model + migration to `portside.v2`. Lists in all three flavours with full CRUD. Refs
vault. New dashboard with computed card ranking and tick-in-place. No new AI calls.
*Deliverable: he can build checklists, packing lists and shopping lists by hand and see them
sensibly ranked on one screen.*

**Phase 2 — the intelligence**
REQUIREMENTS call, the local requirement diff, the departure boundary, daypack generation,
Suggestions with accept/dismiss and sticky global dismissals, LIST_SUGGEST.
*Deliverable: adding a mountain hike checks his packing list and proposes what is missing,
and produces a daypack list due the morning of the hike.*

**Phase 3 — capture and polish**
Program pick-list mode, date-once, multi-photo grouping. Airline rule checks (flag a power
bank assigned to a checked bag). Base-list learning: after a trip, offer to drop never-ticked
items from the reusable template.

Defer until asked: money/expenses, group sharing, disruption cascade.

---

## 8. Acceptance criteria

Phase 1 is done when all of these are true:

- Existing v1 data opens in v2 with nothing lost, and `portside.v1` still exists in storage.
- A checklist with a due time appears on the dashboard inside its lead window and disappears
  when complete.
- An entry can be ticked from the dashboard card without navigating away.
- The refs vault opens and displays values with the network disabled.
- Cards with no content do not render at all.

Phase 2 is done when this exact scenario works:

> Create a trip departing in 5 days. Add a packing list with a few items. Add an activity
> "Mountain hike, 6 hours, 1400 m" on day 4. The app proposes the missing gear **with reasons**,
> proposes nothing already on the list, and creates a daypack list due the morning of day 4
> that references the packed items by bag. Dismiss one suggestion, reload, add a second similar
> activity — the dismissed item is not proposed again.

Then change the trip so departure was yesterday, and re-run: the same gaps must now be phrased
as buy/rent/borrow, and any essential gap must raise an at-risk alert.

---

## 9. Do not

- Do not add a framework, a bundler, or any runtime dependency.
- Do not use absolute paths — the app is served from a subfolder.
- Do not forget to bump `CACHE` in `sw.js`. Installed users will not see your work otherwise.
- Do not let the service worker intercept API calls (both existing guards stay).
- Do not auto-apply AI suggestions, and do not re-suggest a dismissed item.
- Do not call the API for anything that can be computed locally.
- Do not make the user fill in People, Bags or Refs before they can use the app.
- Do not turn an activity into a sub-trip. It is an event with requirements, nothing more.
- Do not commit an API key, ever.
