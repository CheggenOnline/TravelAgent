# Travel Agent — deployment & maintenance brief

**Read this before touching anything.** It is written for the coding agent that publishes and
maintains this app for Christian Heggen. It covers what the app is, where it gets published,
and the handful of rules that will break it if ignored.

Travel Agent is a personal trip organiser: flights, cruise all-aboard countdowns, places to
see, and reminders, filed automatically into categories. It optionally uses the Claude API to
read photos of tickets and to generate recommendations. It is a **single self-contained HTML
file with zero dependencies** — no framework, no build step, no CDN, no npm. That is a
deliberate design constraint, not an accident: the app has to work on a cruise ship with no
signal.

> **Naming note.** The app was previously called *Portside*; it has been renamed to
> **Travel Agent**. Every user-facing reference now says "Travel Agent". The internal
> `localStorage` keys deliberately keep the `portside` name (`portside.v2`, migrated from
> `portside.v1`, see rule #6) so existing installs keep their data. Do not "finish the
> rename" on those — see the non-negotiables.

> **v2 (complete).** The app has been extended per `PORTSIDEV2SPEC.md`, all three phases:
> - **Phase 1** — a computed, ranked **dashboard**; hand-built **lists** (checklist / packing
>   / shopping); a searchable **refs vault**; non-destructive migration to `portside.v2`.
> - **Phase 2** — a **REQUIREMENTS** call fired once when an activity is added (stored on the
>   item), a purely-local **requirement diff** against the packing list, the **departure
>   boundary** (before → "add to packing"; after → "buy/rent/borrow there" + an at-risk alert
>   for essential gaps), **daypack** lists that reference what is actually packed, and
>   **suggestions** with sticky, global dismissals (`S.neverSuggest`). LIST_SUGGEST on demand.
> - **Phase 3** — **programme capture** as a pick-list (unselected by default, ask-the-date
>   once, multi-photo = one programme), an **airline-rule** check (power bank in a checked
>   bag), and **base-list learning** (a reusable "usual" packing list that keeps what you tick
>   and drops what you never use).
>
> **Follow-ups on top of v2:** pasted/photographed content that is a packing/shopping/checklist
> (e.g. a Norwegian "pakkeliste") is detected by EXTRACT and creates a real **list** via a list
> review, not itinerary items; the **Add ＋** flow has a **format** selector (event / list /
> note) alongside category, and items carry a `format` field; the photo input allows choosing
> from the **library** (camera no longer forced).
>
> Deferred until asked (per the spec): money/expenses, group sharing, disruption cascade.

---

## What is in this package

```
index.html             the entire app — deploy this
sw.js                  service worker — deploy this
manifest.webmanifest   PWA manifest — deploy this
README.md              this brief
package.json           dev only, for the test runner
test/smoke.mjs         18-check browser test, Claude API stubbed
```

| File | What it is |
|---|---|
| `index.html` | **The entire app.** HTML, CSS and JS all inlined. This is the source of truth — edit it directly. ~82 KB. |
| `sw.js` | Service worker. Caches the app so it launches with no network. |
| `manifest.webmanifest` | PWA manifest. Icons are inlined as base64 data URLs, so there are no image files to manage. |
| `test/smoke.mjs` | Regression test. See "Before you commit a code change" below. |

The three deploy files are what must reach the web root. Committing `README.md`,
`package.json` and `test/` alongside them is fine and encouraged — GitHub Pages ignores them
and the next agent to pick this up will want them.

---

## Task 1 — publish it

**Target:** repo `cheggenonline/travelagent`. This repo is dedicated to the app, so the three
deploy files live at the **repository root** (not in a subfolder).

Once GitHub Pages is enabled for this repo (Settings → Pages → serve from `main` / root), the
app is live about a minute after a commit to the served branch at:

```
https://cheggenonline.github.io/travelagent/
```

Rules for this commit:

- Keep the three filenames **exactly** as they are. `index.html` references `sw.js` and
  `manifest.webmanifest` by name.
- All three go in the same folder (the repo root). Do not nest them.
- Do not add a Jekyll config. The site is Jekyll-processed by default and passes these files
  through unchanged. Adding an empty `.nojekyll` at the repo root is safe and slightly faster
  if you want it, but it is not required.

**If you are deploying somewhere else instead** (Netlify, Azure Static Web Apps, another repo):
put the three files at the site root and enable Pages on `main` / `/root`. Every internal path
in the app is relative, so it works at a domain root or in a subfolder with no edits.

---

## Task 2 — verify before reporting success

Do not tell Christian it is live until these pass:

1. The URL loads and shows the bottom nav with five tabs (Now, Timeline, Add, Ideas, Trips).
2. A service worker is registered and its scope ends in `/travelagent/`.
3. Reload with the network disabled — the app still loads. This is the whole point of `sw.js`.
4. `manifest.webmanifest` returns HTTP 200 and parses as JSON.
5. Report the URL and tell him to use Safari → Share → **Add to Home Screen**. It must launch
   full-screen with no browser chrome.

He is usually on an iPhone, so "works on desktop Chrome" is not sufficient evidence.

---

## Non-negotiables

These are the ways this app actually breaks. Treat them as hard rules.

1. **Bump the cache version on every change to `index.html`.**
   Open `sw.js`, change `const CACHE = 'travelagent-v1'` to `-v2`, `-v3`, and so on. If you
   skip this, everyone who already installed the app keeps serving the **old** file from cache,
   possibly forever, and your fix appears to have done nothing. This is the number one failure
   mode of this project.

2. **No absolute paths.** The app may be served from a subfolder. Use `./thing` or bare
   `thing`. A leading slash (`/sw.js`) resolves to the domain root and breaks the deploy.

3. **No external dependencies, ever.** No CDN scripts, no web fonts, no analytics, no npm
   packages shipped to the browser. If you cannot inline it, do not add it. The app must work
   with the phone in airplane mode.

4. **The service worker must never intercept the Claude API.** `sw.js` guards on
   `req.method !== 'GET'` and on cross-origin requests. Keep **both** guards. Remove either one
   and API calls start returning cached HTML, which fails in a confusing, hard-to-debug way.

5. **Never commit an API key.** The key is typed in by the user and lives only in that
   browser's `localStorage`. It is never in the source. If a key ever appears in a commit or a
   log, treat it as compromised and tell Christian to revoke it at console.anthropic.com.

6. **Do not rename the storage key, and never migrate destructively.** Trip data lives under
   `localStorage['portside.v2']`. It still carries the old `portside` name on purpose. `load()`
   migrates from `portside.v1` when v2 is absent and **leaves v1 in place as a fallback** — do
   not delete v1. Any future schema change must add fields with safe defaults (as v2 did) or
   ship a real migration in `load()` and bump to `portside.v3`. Renaming or reshaping without a
   migration silently wipes his trips.

---

## Code map — finding your way around `index.html`

Everything is in one file, in this order. The landmarks are stable; search for these names.

| Landmark | What it does |
|---|---|
| `CATS` | The ten categories and their emoji. Adding one also needs a matching `--c-<key>` CSS variable. |
| `store` | `localStorage` wrapper that never throws; silently falls back to in-memory if storage is blocked. |
| `S`, `load()`, `save()` | Whole app state as one JSON blob. `save()` warns the user if storage is full. |
| `claude()` | The only network call in the app. Direct browser call to the Messages API using the `anthropic-dangerous-direct-browser-access` header. Handles 401 / 429 / out-of-credit with plain-language errors. |
| `parseLoose()`, `repairJSON()` | Tolerant parsing of model output — closes unbalanced brackets and truncated strings. **Do not "simplify" these.** Models do return truncated JSON, and without this the whole flow dies on a missing brace. |
| `EXTRACT_SYS`, `REC_SYS` | The two system prompts. Most behaviour changes belong **here**, not in code — e.g. how all-aboard times are detected, or the rule that recommendations must leave 60 minutes of slack. |
| `vNow`, `vTimeline`, `vAdd`, `vIdeas`, `vTrips`, `vSettings` | One function per tab. Each returns an HTML string; `render()` swaps it in. |
| `addItems()`, `dupKey()` | Saving items, including duplicate detection so photographing the same programme twice does not double up. |
| `document.addEventListener('click', …)` | A single delegated handler. Every button carries `data-act="…"`; add a new case there rather than attaching listeners. |
| `tick()` | Runs every 20 s: updates the countdown and fires reminder notifications. |
| `itemToVevent()`, `downloadICS()` | Calendar export. This is the reliable reminder path — see gaps below. |
| `shrink()`, `fileToImg()` | Photo downscaling. Two sizes: a small thumbnail for storage, a larger one sent to the API. Keep this split or storage fills up fast. |

---

## Before you commit a code change

**Run the smoke test.** It is the fastest way to avoid shipping a regression:

```bash
npm install          # once — pulls Playwright
npm test             # serves the folder over http and drives a real browser
```

It runs 18 checks and exits non-zero on any failure. The Claude API is stubbed, so it costs no
tokens and needs no key. Screenshots land in `test/shots/` for eyeballing layout. It covers:
boot, saving the API key, trip autofill, paste-to-sort, the all-aboard countdown becoming the
hero, the duplicate guard, photo staging and reading, manual entry, recommendations, reload
persistence, `.ics` events and alarms, service worker registration, offline reload, and a cold
offline start (the installed-app case). It also asserts the console is clean.

To test the live deploy instead of local files:

```bash
node test/smoke.mjs https://cheggenonline.github.io/travelagent/
```

Two notes. The recommendations stub returns **deliberately malformed JSON** with a missing
closing brace — that check exists to prove `repairJSON()` still recovers the payload, so if you
touch that function and this check fails, the function is broken, not the test. And the stubs
use dates in 2099 so the countdown assertions do not rot over time.

If you add a feature, add a check. If a check fails and you believe the test is wrong, say so
explicitly to Christian rather than deleting it.

---

## Known gaps — context, not a to-do list

Do not "fix" these without asking. Several are deliberate.

- **Times are naive local strings** (`YYYY-MM-DDTHH:MM`), with no timezone handling. A time
  entered as 17:00 stays 17:00 and the countdown uses the device clock. This is intentional:
  phones pick up local time in each port, which is the right behaviour for cruising. Adding
  timezone support is a real project, not a tweak.
- **Browser notifications only fire while the app is open.** The `.ics` export exists because
  of this — the phone's own calendar is the dependable alarm. Do not oversell in-app reminders.
- **Data is per-device.** Sync is export/import JSON by hand. There is no account, no server,
  and adding one would change the app's privacy story — ask first.
- **iOS can evict storage** for web apps left unused for a long stretch. The export backup is
  the mitigation. Worth reminding Christian before a big trip.
- One photo per item; no re-reading a photo after saving.

---

## How Christian wants this run

- Ship small changes and verify them in a real browser before committing.
- Tell him the URL and what changed, in a sentence or two. He does not need a changelog.
- Do not add a framework, a bundler, or a build step. The single-file constraint is the point.
- Ask before anything that touches stored trip data, or that sends data anywhere new.
- He is often on a phone. Prefer one clear instruction over a list of options.
