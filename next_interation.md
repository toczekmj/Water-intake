# HydrateMe Implementation Plan
## Hydration Factors + Caffeine User Mode + Keto Electrolytes

## 1) Goal

Implement hydration scoring that:

- treats drinks with different hydration value (not all = water),
- supports **caffeine habituation modes** (regular vs rare users),
- adds optional **keto/electrolyte mode** with sodium/potassium/magnesium tracking,
- keeps UX simple for daily logging.

---

## 2) Product Decisions (lock these first)

### A. New user settings

Add in `settings`:

- `hydration_mode`: `standard | keto`
- `caffeine_habituation`: `regular | occasional | rare`
- `caffeine_sensitivity`: `low | medium | high` (optional v1.1)
- `use_hydration_factors`: `boolean` (default `true`)
- `electrolyte_targets_enabled`: `boolean` (auto-on when keto)

### B. Drink model updates

For each fluid type, store:

- `default_hydration_factor` (0.0–1.2)
- `caffeine_mg_per_100ml` (nullable)
- `electrolytes_per_100ml`:
  - `sodium_mg`
  - `potassium_mg`
  - `magnesium_mg`
- `is_user_editable_factor` (`true` for custom drinks)

### C. Default hydration factors (v1)

- Water: `1.00`
- Sparkling water: `1.00`
- Black coffee: `0.90`
- Black tea: `0.90`
- Milk: `0.85`
- Sports/electrolyte drink (sugar-free): `0.95`
- Juice: `0.80`
- Soda (diet): `0.75`
- Alcoholic drinks: `0.40` (or lower by type later)

---

## 3) Core Scoring Logic

For each intake entry:

1. `base_hydration_ml = volume_ml * drink_factor`
2. Apply caffeine adjustment:
   - compute `entry_caffeine_mg = volume_ml * caffeine_mg_per_100ml / 100`
   - keep running daily caffeine total
3. Adjust hydration credit by habituation mode:
   - **regular**: no penalty unless daily caffeine > 400 mg
   - **occasional**: small penalty after 200 mg/day
   - **rare**: stronger penalty after 100 mg/day
4. Clamp final credited hydration to `0..volume_ml`

### Example penalty model (simple + transparent)

- regular: `-0%` up to 400 mg, then `-10%` on caffeinated entries
- occasional: `-0%` up to 200 mg, then `-10%`, above 400 mg `-20%`
- rare: `-0%` up to 100 mg, then `-15%`, above 300 mg `-25%`

Keep this configurable in constants.

---

## 4) Keto Mode Logic

When `hydration_mode = keto`:

- Show daily electrolyte totals and targets.
- Track intake of Na/K/Mg from drinks (and optionally manual food/electrolyte entries).
- Suggested default targets:
  - Sodium: `3000–5000 mg/day`
  - Potassium: `3000–4000 mg/day`
  - Magnesium: `300–500 mg/day`
- Add keto support reminders:
  - if hydration is high but sodium low -> suggest electrolytes/broth
  - if cramps are reported + low magnesium -> targeted tip

---

## 5) Data Model / API Changes

### DB changes

- `settings` table: add fields from section 2A.
- `fluids` table: add fields from section 2B.
- `intake_entries` table: store denormalized snapshots:
  - `applied_hydration_factor`
  - `applied_caffeine_penalty_pct`
  - `credited_hydration_ml`
  - `caffeine_mg`
  - `sodium_mg`, `potassium_mg`, `magnesium_mg`

### API

- `GET/PUT settings`: include new fields
- `GET/PUT fluids`: include factor + caffeine/electrolytes
- daily stats endpoint returns:
  - total consumed ml
  - credited hydration ml
  - total caffeine mg
  - electrolyte totals
  - progress to water goal + electrolyte targets

---

## 6) UI Changes (Web/PWA)

### Settings screen

- toggle: **Use drink hydration factors**
- selector: **Caffeine user profile** (`regular / occasional / rare`)
- toggle: **Keto mode**

### Drink editor

- hydration factor input
- caffeine mg/100ml input
- electrolyte fields

### Dashboard

- show both:
  - **Total fluid**
  - **Hydration credited**
- caffeine chip: `xx mg / day`
- keto cards (if enabled): Na/K/Mg progress bars

---

## 7) Migration + Backward Compatibility

- Existing users defaults:
  - `hydration_mode = standard`
  - `caffeine_habituation = regular`
  - existing drinks get safe defaults
- Old entries remain valid:
  - if snapshots don’t exist, compute on read using historical defaults
  - optional one-time backfill later

---

## 8) Testing Requirements

### Unit tests

- hydration factor math
- caffeine penalty thresholds by habituation mode
- electrolyte aggregation
- edge cases (null caffeine, large volume, invalid values guarded)

### Integration tests

- create intake -> verify credited hydration + caffeine + electrolytes
- update settings -> verify expected recomputation behavior
- keto mode endpoint outputs

### UI tests

- settings persistence
- dashboard values match API
- custom drink factor flow

---

## 9) Rollout Plan

1. Ship backend + migrations behind feature flag.
2. Ship UI toggles hidden by flag.
3. Enable for internal/test users first.
4. Monitor:
   - entry completion rate
   - goal attainment variance
   - confusion around “total vs credited”
5. If needed, add in-app tooltip explaining credited hydration.

---

## 10) Prompt for the Implementation Agent

Implement hydration factor scoring, caffeine habituation profiles (`regular/occasional/rare`), and optional keto electrolyte tracking in HydrateMe. Add DB fields to settings/fluids/intake_entries, snapshot applied factors at entry creation, update API contracts, add settings and dashboard UI, and include unit/integration/UI tests. Use backward-compatible defaults and feature-flag rollout. Prioritize transparent math and maintain existing logging UX.

# HydrateMe PR Template + QA Checklist
## Hydration Factors + Caffeine User Mode + Keto Electrolytes

## Pull Request Title (suggested)

Add hydration factors, caffeine user profiles, and keto electrolyte tracking

---

## PR Description

### Why

Hydration is currently tracked as raw fluid volume, but different beverages do not hydrate equally for all users.  
This change introduces:

- drink hydration factors,
- caffeine habituation profiles (regular/occasional/rare),
- optional keto electrolyte tracking (Na/K/Mg),

to improve accuracy and personalization while keeping logging simple.

### What Changed

#### Backend / Data Model

- Added new `settings` fields:
  - `hydration_mode` (`standard | keto`)
  - `caffeine_habituation` (`regular | occasional | rare`)
  - `use_hydration_factors` (`boolean`)
  - `electrolyte_targets_enabled` (`boolean`)
- Extended `fluids` with:
  - `default_hydration_factor`
  - `caffeine_mg_per_100ml`
  - `sodium_mg_per_100ml`
  - `potassium_mg_per_100ml`
  - `magnesium_mg_per_100ml`
- Extended `intake_entries` snapshots:
  - `applied_hydration_factor`
  - `applied_caffeine_penalty_pct`
  - `credited_hydration_ml`
  - `caffeine_mg`
  - `sodium_mg`
  - `potassium_mg`
  - `magnesium_mg`

#### Hydration Logic

- Hydration credit now uses drink factor.
- Caffeine penalty is applied by habituation profile and daily caffeine threshold.
- Credited hydration is clamped to `0..volume_ml`.
- Daily stats include total fluid, credited hydration, caffeine, electrolytes.

#### UI

- Settings:
  - hydration factors toggle
  - caffeine user profile selector
  - keto mode toggle
- Drink editor:
  - hydration factor
  - caffeine mg/100ml
  - electrolyte fields
- Dashboard:
  - total fluid vs credited hydration
  - caffeine total
  - electrolyte cards in keto mode

### Backward Compatibility

- Existing users default to:
  - `hydration_mode=standard`
  - `caffeine_habituation=regular`
- Existing drinks receive safe defaults.
- Historical entries still render (fallback compute where snapshots absent).

### Risks / Notes

- User confusion between “total fluid” and “credited hydration”
  - mitigated via labels and helper tooltip.
- Caffeine penalties are configurable constants and may require tuning after beta data.

---

## Test Plan (for reviewer)

### Automated

- Unit tests for:
  - hydration factor math
  - caffeine penalty thresholds
  - electrolyte aggregation
- Integration tests for:
  - create intake + verify snapshots/stat totals
  - settings update behavior
  - keto mode stats payload
- UI tests for:
  - settings persistence
  - dashboard rendering
  - custom drink editing

### Manual

1. Create user with defaults.
2. Log water, coffee, tea and verify:
   - total fluid increments by raw ml
   - credited hydration reflects factors/penalty
3. Switch habituation profile:
   - regular -> occasional -> rare
   - verify caffeine penalty behavior changes
4. Enable keto mode:
   - verify electrolyte targets + progress bars
5. Log custom electrolyte drink:
   - verify Na/K/Mg totals update
6. Confirm old entries still visible and stats do not crash.

---

## QA Acceptance Checklist (Go/No-Go)

- [ ] Migration runs successfully on clean DB.
- [ ] Migration runs successfully on existing DB with user data.
- [ ] No regression in intake logging flow.
- [ ] Settings API includes new fields and persists values.
- [ ] Fluids API supports hydration/caffeine/electrolyte attributes.
- [ ] Intake creation stores factor/penalty snapshots.
- [ ] Daily stats return:
  - [ ] total fluid
  - [ ] credited hydration
  - [ ] caffeine total
  - [ ] Na/K/Mg totals
- [ ] Dashboard clearly shows “Total fluid” vs “Hydration credited”.
- [ ] Caffeine profile changes hydration credit as expected.
- [ ] Keto mode reveals electrolyte tracking UI and targets.
- [ ] Feature flag OFF = legacy behavior (or no visible new controls).
- [ ] Feature flag ON = new behavior active end-to-end.
- [ ] No high-severity lints/tests failing in changed areas.

---

## Expected Behaviors (example scenarios)

### Scenario A: Regular caffeine user

- Drinks 2 coffees (200ml each, factor 0.90), daily caffeine < 400mg
- Expected: near-full coffee credit with no extra penalty.

### Scenario B: Rare caffeine user

- Same coffee amount but profile `rare`, caffeine crosses threshold
- Expected: lower credited hydration than regular profile.

### Scenario C: Keto mode

- User logs water + broth/electrolyte drink
- Expected: hydration + Na/K/Mg totals all progress, with sodium-sensitive prompts if low.

---

## Post-merge Monitoring

Track for 1–2 weeks:

- hydration entries/day
- settings adoption:
  - hydration factors on/off
  - caffeine profile distribution
  - keto mode enablement
- support messages mentioning confusion about credited hydration
- anomalies in daily stats generation latency/errors