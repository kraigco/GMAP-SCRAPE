# Rekreate Lead Intelligence Engine — PLAN

Status: **largely built.** This document is the original design, kept for the
reasoning behind each decision. It is no longer a description of what exists.

What is built and running: discovery (recursive tiling), qualify, audit, the
outreach hook, the Google Sheets export, the dashboard, and a free-tier ledger
that caps Places usage at 30 calls/day and 1,000/month.

What is still unbuilt, and where the plan below is still a plan rather than a
record: **Stage 5 (Score)**, **Stage 6 (Pitch)**, the **Postgres schema in
section 2**, and the Sheets review round-trip. Until persistence lands, the
30-day TTL that section 2 specifies for Google-sourced fields cannot be
enforced, and `out/searches/*.csv` is an indefinite store of that data.

For the current state of play, read Rekoll rather than this file.

---

## 0. Verification done before writing this plan

The rules file requires checking two APIs rather than working from memory. Both checked.

**Places API Text Search (New)** — confirmed against the live reference:

- `POST https://places.googleapis.com/v1/places:searchText`
- The field mask is an HTTP **header** (`X-Goog-FieldMask`), not a body field. Comma-separated, `places.`-prefixed.
- Headers: `Content-Type: application/json`, `X-Goog-Api-Key`, `X-Goog-FieldMask`.
- Body shape:
  ```json
  {
    "textQuery": "property management company",
    "locationRestriction": {
      "rectangle": {
        "low":  { "latitude": 39.867, "longitude": -75.280 },
        "high": { "latitude": 40.138, "longitude": -74.956 }
      }
    },
    "pageSize": 20,
    "pageToken": "...",
    "regionCode": "US",
    "languageCode": "en"
  }
  ```
  `rectangle.low` is the SW corner, `rectangle.high` the NE corner.
- Pagination: the response field is `nextPageToken`. `pageSize` max 20. Hard ceiling 60 results across all pages. No delay before token use is documented for the New API — the legacy API's ~2s token warm-up does not appear in the current reference. See Q7.
- Billing works exactly as constraint 3 states: the SKU is set by the **highest tier** field requested. `places.websiteUri`, `places.rating` and `places.userRatingCount` are Enterprise-tier fields, which is what puts our fixed mask at Text Search Enterprise (~$35/1k). `places.reviews` would move it to Enterprise + Atmosphere. The mask stays frozen.

**Anthropic SDK** — the blueprint's "Claude 3.5 Sonnet" is outdated, and the API shape has changed too:

- Package `@anthropic-ai/sdk`; model id **`claude-opus-5`**.
- `thinking: { type: "adaptive" }`. The older `{ type: "enabled", budget_tokens: N }` form is **rejected with a 400** on this model — it must not be carried over from any pre-2026 example.
- Depth is controlled with `output_config: { effort: ... }` instead. The pitch stage generates one sentence, so `low` is the right default. See Q5.

---

## 1. Pipeline stages and contracts

Seven stages, each a separate module with an explicit input/output type. Stages 1–2 touch Google, stage 4 touches prospect sites, stage 6 touches Anthropic. Stages 3 and 5 touch nothing.

| # | Stage | Input | Output | External I/O |
|---|-------|-------|--------|--------------|
| 1 | **Discover** | `SweepConfig` | `RawPlace[]` + `RunSummary` | Places API |
| 2 | **Persist** | `RawPlace[]` | upserted cache rows | Postgres |
| 3 | **Qualify** | `ProspectFacts` | `Qualified` or `Disqualified{reason}` | none (pure) |
| 4 | **Audit** | `{ placeId, websiteUri }` | `SiteAudit` | prospect's own site |
| 5 | **Score** | `ScoreInput` | `{ score, tier, reasons, gaps }` | none (pure) |
| 6 | **Pitch** | `{ name, rating, reviewCount, gaps }` | `{ hook, promptVersion, model }` | Anthropic API |
| 7 | **Export** | joined rows | CSV / Google Sheet | filesystem / Sheets |

### Stage 1 — Discover

```ts
type SweepConfig = {
  niche: string;            // 'property-management'
  market: string;           // 'philadelphia-core'
  bbox: BBox;               // { swLat, swLng, neLat, neLng }
  keywords: string[];       // from the niche config file, never from code
  maxCalls: number;         // hard budget — halts the sweep
  maxDepth: number;         // recursion floor
  splitThreshold: number;   // default 60
};

type RawPlace = {           // zod-validated, 1:1 with the frozen field mask
  id: string;
  displayName?: { text: string; languageCode?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: 'OPERATIONAL' | 'CLOSED_TEMPORARILY' | 'CLOSED_PERMANENTLY';
  primaryType?: string;
  types?: string[];
  location?: { latitude: number; longitude: number };
};

type RunSummary = {
  callsUsed: number; tilesSearched: number; tilesSplit: number;
  uniquePlaces: number; duplicatesDropped: number;
  estimatedCostUsd: number; budgetExhausted: boolean; maxDepthHit: number;
};
```

**Contract note:** every field of `RawPlace` except `id` is optional. Places omits absent fields entirely rather than returning null, so the zod schema must model that or the first prospect without a website crashes the sweep.

The tiling engine is separated from the network so it is testable offline:

```ts
// pure — no fetch, no clock, no randomness
function planTiles(
  root: BBox,
  probe: (bbox: BBox) => number,   // injected: result count for a tile
  opts: { splitThreshold: number; maxDepth: number }
): TileNode[];
```

In production `probe` is the API-backed searcher; in tests it is a fixture function. That injection is what makes "a tile returning 60 splits into exactly 4" verifiable without a network call.

### Stage 3 — Qualify

Runs **before** scoring and before any audit, so we never spend an HTTP fetch on a lead we were always going to drop. The lists live in `config/niches/*.ts`, not in code:

- `businessStatus !== 'OPERATIONAL'`
- national brand match (Greystar, Lincoln Property, Cushman, JLL, CBRE, RE/MAX, Keller Williams, Century 21, Coldwell Banker, Berkshire Hathaway, AvalonBay, Equity Residential, Bozzuto, Morgan Properties, Invitation Homes, …)
- software vendor / portal match (AppFolio, Buildium, Yardi, Entrata, Zillow, Apartments.com, Realtor.com, …)
- neither `nationalPhoneNumber` nor `websiteUri`

Disqualified leads are **stored with their reason, not deleted**. A local franchisee caught by a brand-name match is a false positive we want to be able to find and re-audit later.

### Stage 4 — Audit

Every check is **tri-state**: `'yes' | 'no' | 'unknown'`. A timeout, a 403, or a robots.txt disallow yields `unknown` for the checks it blocks. `unknown` never becomes a gap — enforced in the type system by having the gap-derivation function match only on explicit `'no'`, and covered by a dedicated fixture (all-unknown produces zero gaps).

```ts
type AuditState = 'yes' | 'no' | 'unknown';

type SiteAudit = {
  placeId: string; auditedAt: Date;
  inputUrl: string | null; finalUrl: string | null;   // after redirects
  reachable: AuditState; https: AuditState;
  ttfbMs: number | null; mobileViewport: AuditState;
  bookingPath: AuditState; contactForm: AuditState;
  platform: Platform;                                  // includes 'unknown'
  socialProfiles: Partial<Record<SocialNetwork, string>>;
  httpStatus: number | null; error: string | null;
};
```

Plain `fetch` plus an HTML parse. No headless browser in Phase 3. If a check turns out to genuinely require JS execution — booking-widget detection on SPA sites is the likely candidate — I will say why and ask before adding one.

### Stage 5 — Score

```ts
function score(input: ScoreInput, weights: ScoringWeights): ScoreResult;
// ScoreResult = { score: number; tier: Tier; reasons: Reason[]; gaps: Gap[] }
```

Pure. No `Date.now()`, no I/O, no randomness. `weights` is one exported object — changing a number must never require touching a pipeline file. `gaps` is emitted in exactly the shape stage 6 consumes, so the pitch stage re-derives nothing.

### Stage 6 — Pitch

Receives `{ name, rating, reviewCount, gaps }` and **nothing else**. No HTML, no URL, no address, no raw audit object. Runs only where `score >= pitchThreshold`. The prompt lives in a versioned file (`src/pitch/prompts/v1.md`) and its version string is stored on every generated row, so hooks are diffable across prompt revisions. The exact `input_gaps` the model saw is stored alongside the output.

### Stage 7 — Export (Google Sheets)

**Decided: Google Sheets is the primary export.** Target spreadsheet
`1VFBHcbtfMmUu6p6mGw2bMExFdZ8iiwev3BAfEXaxgTE`. CSV stays as a secondary
`--csv` flag for offline use.

Three tabs:

| Tab | Contents |
|---|---|
| `Leads` | One row per qualified prospect, score descending. The working surface. |
| `Runs` | One row per sweep — calls used, tiles, unique places, estimated USD. The spend ledger from constraint 6, made visible. |
| `Disqualified` | Dropped leads with their reason, so a local firm wrongly killed by a brand-name match is findable rather than invisible. |

Sorted by score descending, `review_status` defaults to `'unreviewed'`, and **every
lead whose `google_refreshed_at` is older than 30 days is excluded** (constraint 5).
No sending.

**Auth.** An API key cannot write to Sheets. A service-account JSON key is required,
and the spreadsheet must be shared with the service account's address as Editor.
No new dependency: the RS256 JWT is signed with `node:crypto`, exchanged for an
access token at Google's OAuth endpoint, and the Sheets v4 REST API is called with
plain `fetch`. Same posture as the raw-SQL-no-ORM rule.

**Review round-trip.** Review happens *in the sheet*, so the sheet is the source of
truth for `review_status` and a one-way write would silently discard the user's work.
Two commands:

- `export` — writes/updates rows, keyed on `place_id` in a hidden first column so
  re-exports update in place rather than appending duplicates (constraint 11 applies
  to the sheet too, not just Postgres).
- `sync-reviews` — reads the `review_status` column back and writes it into
  `outreach`, so the database stays authoritative for everything downstream.

**Staleness in a persistent sheet.** Rows already written can age past 30 days while
sitting in the sheet. Excluding stale leads at write time is not sufficient. On every
export the tool re-checks written rows and clears the Google-sourced columns (name,
address, phone, rating, review count) of any row that has gone stale, leaving
`place_id`, our scores, gaps and hook intact — which is exactly the retention split
the schema already encodes, applied to the sheet.

---

## 2. Postgres schema

### Where it lives — and what it must not touch

**Decided: the Codex Supabase instance, in a dedicated `outbound` schema. All migrations
live in *this* repo (`sql/`). No file in `rekreate-codex` changes.**

Codex already has a leads pipeline — `website_leads` (sql/009, sql/015) plus `lead_notes`,
`lead_status`, `assigned_to` and a `notify_new_lead` trigger. **Scraped prospects must never
be written into it.** Three reasons, in order of seriousness:

1. **Consent.** `website_leads` is an append-only record of people who contacted Rekreate,
   carrying a consent audit trail. A Google Maps scrape has no consent behind it. Writing
   cold prospects into that table corrupts exactly the record sql/015 was written to protect.
2. **Retention conflict.** `website_leads` is immutable and permanent. Our Google-cached
   columns must expire at 30 days (constraint 5). Those two rules cannot hold in one table.
3. **Semantics.** Inbound moves `new → contacted → qualified → won/lost`. Outbound is scored
   `HOT/WARM/WATCH/COLD`. Different objects with different lifecycles.

A prospect who actually replies gets **converted** into a real `website_leads` row — a
deliberate, one-way, human-triggered action, following the pattern already in
`sql/020-lead-conversion.sql`. That is out of scope for v1 and is a Codex-side change.

Using a separate schema in the same database is what makes leads appear live in Kodex with
no sync code, while keeping a hard blast-radius boundary around Codex's tables.

**RLS posture is inherited from Codex, not invented.** Every table below is
`ENABLE ROW LEVEL SECURITY` with grants revoked from `anon` and `authenticated` — the
"Variant A, service-role only" posture in `sql/TEMPLATE-new-table.sql`. Prospect names,
phone numbers and audit findings are PII-adjacent; no browser role touches them directly.

**Migrations are never applied from here.** The Codex convention is that the conductor
applies DDL at deploy time. This repo generates and version-controls the SQL; applying it
is a separate, deliberate step.

### The two zones

Deliberately not denormalised. **`prospects` is the anchor table** — it holds `place_id`, which Google's terms permit us to keep indefinitely. The Google cache (`google_places`) hangs off it and can be truncated at any moment without touching anything we derived. Every derived table FKs to `prospects`, never to `google_places`, so a cache purge can never cascade into Rekreate's own data.

```sql
-- Everything below is created in `outbound`. Nothing in `public` is modified.
CREATE SCHEMA IF NOT EXISTS outbound;
SET search_path TO outbound, public;

-- Supabase already provides pgcrypto (gen_random_uuid) in the extensions schema.

CREATE TYPE audit_state AS ENUM ('yes', 'no', 'unknown');
CREATE TYPE lead_tier   AS ENUM ('HOT', 'WARM', 'WATCH', 'COLD');

-- ---------------------------------------------------------------
-- ANCHOR — place_id only. Indefinite retention (constraint 5).
-- ---------------------------------------------------------------
CREATE TABLE prospects (
  place_id             text PRIMARY KEY,
  niche                text        NOT NULL,
  market               text        NOT NULL,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  disqualified         boolean     NOT NULL DEFAULT false,
  disqualified_reason  text,
  disqualified_at      timestamptz
);

-- ---------------------------------------------------------------
-- ZONE A — GOOGLE CACHE. 30-day TTL. Safe to truncate wholesale.
-- Nothing in this table is Rekreate's data.
-- ---------------------------------------------------------------
CREATE TABLE google_places (
  place_id             text PRIMARY KEY
                         REFERENCES prospects(place_id) ON DELETE CASCADE,
  display_name         text,
  formatted_address    text,
  national_phone       text,
  website_uri          text,
  rating               numeric(2,1),
  user_rating_count    integer,
  business_status      text,
  primary_type         text,
  types                text[],
  latitude             double precision,
  longitude            double precision,
  google_refreshed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX google_places_stale_idx ON google_places (google_refreshed_at);

-- ---------------------------------------------------------------
-- ZONE B — DERIVED. Rekreate's own data. No TTL.
-- ---------------------------------------------------------------
CREATE TABLE site_audits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id         text NOT NULL REFERENCES prospects(place_id) ON DELETE CASCADE,
  audited_at       timestamptz NOT NULL DEFAULT now(),
  input_url        text,
  final_url        text,
  reachable        audit_state NOT NULL DEFAULT 'unknown',
  https            audit_state NOT NULL DEFAULT 'unknown',
  ttfb_ms          integer,
  mobile_viewport  audit_state NOT NULL DEFAULT 'unknown',
  booking_path     audit_state NOT NULL DEFAULT 'unknown',
  contact_form     audit_state NOT NULL DEFAULT 'unknown',
  platform         text        NOT NULL DEFAULT 'unknown',
  social_profiles  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  http_status      integer,
  error            text
);
CREATE INDEX site_audits_place_idx ON site_audits (place_id, audited_at DESC);

CREATE TABLE lead_scores (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id         text NOT NULL REFERENCES prospects(place_id) ON DELETE CASCADE,
  audit_id         uuid REFERENCES site_audits(id) ON DELETE SET NULL,
  scored_at        timestamptz NOT NULL DEFAULT now(),
  weights_version  text    NOT NULL,
  score            integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  tier             lead_tier NOT NULL,
  reasons          jsonb NOT NULL,
  gaps             jsonb NOT NULL
);
CREATE INDEX lead_scores_place_idx ON lead_scores (place_id, scored_at DESC);

CREATE TABLE pitches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id         text NOT NULL REFERENCES prospects(place_id) ON DELETE CASCADE,
  score_id         uuid REFERENCES lead_scores(id) ON DELETE SET NULL,
  prompt_version   text NOT NULL,
  model            text NOT NULL,
  hook             text NOT NULL,
  input_gaps       jsonb NOT NULL,   -- exactly what the model was shown
  generated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outreach (
  place_id         text PRIMARY KEY REFERENCES prospects(place_id) ON DELETE CASCADE,
  review_status    text NOT NULL DEFAULT 'unreviewed',
  reviewed_at      timestamptz,
  notes            text
);

-- ---------------------------------------------------------------
-- RUN LEDGER — cost accountability (constraint 6)
-- ---------------------------------------------------------------
CREATE TABLE runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  status             text NOT NULL DEFAULT 'running',
  config             jsonb NOT NULL,
  calls_used         integer NOT NULL DEFAULT 0,
  tiles_searched     integer NOT NULL DEFAULT 0,
  tiles_split        integer NOT NULL DEFAULT 0,
  unique_places      integer NOT NULL DEFAULT 0,
  estimated_cost_usd numeric(10,4) NOT NULL DEFAULT 0,
  budget_exhausted   boolean NOT NULL DEFAULT false
);

CREATE TABLE run_places (
  run_id    uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  place_id  text NOT NULL REFERENCES prospects(place_id) ON DELETE CASCADE,
  PRIMARY KEY (run_id, place_id)
);
```

**Staleness query** (constraint 5 — drives `refresh-stale` and gates every export):

```sql
SELECT place_id FROM google_places
WHERE google_refreshed_at < now() - make_interval(days => $1)   -- $1 = 30
ORDER BY google_refreshed_at ASC;
```

**Idempotency** (constraint 11): harvest upserts on `place_id` in both tables — `ON CONFLICT (place_id) DO UPDATE SET ..., google_refreshed_at = now()` for the cache, `DO UPDATE SET last_seen_at = now()` for the anchor. Running the same sweep twice yields the same row count.

---

## 3. Module structure

```
.
├── .cursor/rules/rekreate-engine.mdc      # binding constraints (written)
├── PLAN.md
├── package.json  tsconfig.json  vitest.config.ts  .gitignore  .env.example
├── sql/                                  # migrations for the `outbound` schema
│   └── 001-outbound-prospects.sql     # applied by the conductor, never from here
├── src/
│   ├── cli/
│   │   └── index.ts              # commander: harvest | refresh-stale | audit |
│   │                             #            score | pitch | export |
│   │                             #            sync-reviews
│   ├── config/
│   │   ├── env.ts                # zod-validated process.env — fails loud at boot
│   │   ├── scoring.ts            # THE weights object + tier thresholds
│   │   └── niches/
│   │       └── property-management.ts   # keywords, disqualifiers, markets
│   ├── places/
│   │   ├── field-mask.ts         # frozen mask constant — single source of truth
│   │   ├── schema.ts             # zod for the searchText response
│   │   ├── client.ts             # POST, backoff, call budget, cost accounting
│   │   ├── tiling.ts             # PURE recursion — no network
│   │   └── types.ts
│   ├── db/
│   │   ├── client.ts             # Supabase Postgres, search_path=outbound
│   │   └── repositories/         # places, prospects, audits, scores, pitches,
│   │                             # outreach, runs
│   ├── audit/
│   │   ├── index.ts  fetch.ts  robots.ts  fingerprints.ts
│   │   └── checks/               # https, ttfb, viewport, booking, contact-form,
│   │                             # platform, social
│   ├── scoring/
│   │   ├── disqualify.ts  gaps.ts  score.ts
│   ├── pitch/
│   │   ├── prompts/v1.md         # versioned, diffable
│   │   └── generate.ts
│   ├── export/
│   │   ├── sheets.ts             # v4 REST over fetch — Leads/Runs/Disqualified
│   │   ├── google-auth.ts        # service-account JWT via node:crypto, no dep
│   │   ├── sync-reviews.ts       # read review_status back into outreach
│   │   └── csv.ts                # secondary, --csv flag
│   └── lib/
│       └── logger.ts  backoff.ts  cost.ts  concurrency.ts  bbox.ts
└── tests/
    └── fixtures/                 # places responses, HTML samples, scoring cases
```

---

## 4. Build phases and acceptance criteria

Each phase ends with a command you run yourself to verify it.

| Phase | Scope | Acceptance criterion |
|-------|-------|----------------------|
| **0** | Scaffold (this step) | `npm install && npm run typecheck && npm test` passes with zero tests and no logic present |
| **1** | Places client + tiling | `npm test -- tiling` proves: 60 splits into exactly 4; under 60 does not split; `maxDepth` respected; the same place found in two overlapping tiles appears once. Then `npm run cli -- harvest --dry-run --max-calls 5` prints a run summary with calls used, tiles searched, tiles split, unique places and estimated USD — and stops at 5 calls |
| **2** | Persistence | `npm run cli -- harvest --max-calls 20` run twice gives an identical `SELECT count(*) FROM prospects`. `npm run cli -- refresh-stale --dry-run` lists place_ids older than 30 days |
| **3** | Site audit | `npm run cli -- audit --limit 10` writes 10 `site_audits` rows; a deliberately unreachable host records `reachable='no'` with the rest `'unknown'` rather than crashing |
| **4** | Scoring | `npm test -- scoring` passes all five fixtures (HOT lead, national brand disqualified, no website, recently-rebuilt negative, all-unknown producing **zero** gaps). `npm run cli -- score` populates `lead_scores` |
| **5** | Pitch + Sheets export | `npm run cli -- pitch --threshold 75` writes hooks only for leads at or above 75, each with `prompt_version` stored. `npm run cli -- export` fills the **Leads** tab score-descending with a `review_status` column and no stale leads, and creates **Runs** and **Disqualified**. Running it twice updates rows in place rather than appending. Then: edit a `review_status` cell by hand, run `npm run cli -- sync-reviews`, and `SELECT review_status FROM outreach` reflects your edit |

The working style from the rules file holds throughout: propose, wait for approval, one phase at a time, no scaffolding ahead.

---

## 5. Cost model

Enterprise Text Search is roughly **$35 per 1,000 requests**. Each *page* is a billed request, so a tile that pages out to 60 results costs 3 calls, not 1.

Worst case for the starting bbox with 8 keywords, tiling to depth 2 (~40 tiles), every tile paging to 3 pages:

```
8 keywords x 40 tiles x 3 pages = 960 calls ≈ $33.60
```

Realistically much lower — most tiles return under 20 results and cost a single call. But `maxCalls` is what makes this a ceiling rather than a hope: the budget is decremented **before** each request is issued, and the sweep halts mid-tile when it reaches zero, recording `budget_exhausted = true`. Recursion depth is bounded independently by `maxDepth`. Both fail closed.

Suggested first real sweep: **`maxCalls: 200`** (about $7). See Q3.

---

## 6. Open questions

Q1–Q3 block Phase 1. The rest can wait until their phase.

**Q1 — Postgres. RESOLVED.** The Codex Supabase instance, in a dedicated `outbound` schema,
with all migrations version-controlled in this repo under `sql/`. No Docker, no second
database, no change to any file in `rekreate-codex`. See §2. Outstanding sub-item: I need
either a direct connection string or `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` before Phase 2.

**Q2 — GCP.** Is there a project with **Places API (New)** enabled and billing attached, and is the key restricted (IP or API)? A key restricted to the *legacy* Places API returns a `403 PERMISSION_DENIED` that reads like an auth failure — worth ruling out before Phase 1.

**Q3 — Cost ceiling.** Confirm the `maxCalls` default for the first sweep; I suggest 200 (~$7). Also: do you want a hard USD ceiling in addition to the call count, or is the call count sufficient?

**Q4 — Pitch threshold.** The spec puts HOT at ≥75. Should generation run at ≥75 (HOT only) or ≥55 (HOT + WARM)? WARM is roughly 3–4x the volume, so this is mostly a cost decision.

**Q5 — Model and effort.** Confirming `claude-opus-5`. For a one-sentence hook I would default to `output_config: { effort: "low" }` with adaptive thinking — cheap and fast. Say if you want it higher.

**Q6 — Two River Development.** The pitch prompt may reference this build. To stop the model inventing details, I want to give it one or two verified sentences plus the case-study URL rather than let it improvise. What exact wording are you comfortable having sent to a prospect?

**Q7 — Page-token timing.** The New API reference documents no delay before using `nextPageToken`, unlike the legacy API's ~2s warm-up. I plan to treat an immediate-reuse `INVALID_ARGUMENT` as retryable with a short backoff rather than adding a blanket sleep to every page. Flagging in case you would rather I just sleep.

**Q8 — robots.txt.** The constraint says respect it. When a prospect's robots.txt disallows the path, should the audit record `unknown` for every blocked check (my default — safe, and `unknown` never scores as a gap), or should the lead be skipped outright? Worth noting the first option means a site we *cannot* audit scores lower than one we can, which is arguably backwards.

**Q9 — Brand matching.** "Greystar … and similar" — exact substring or fuzzy? Exact is predictable but misses variants like "Greystar Real Estate Partners LLC"; fuzzy risks killing a local firm with an unlucky name. I lean exact case-insensitive substring, with every disqualification stored and reviewable.

**Q10 — Sheets auth. RESOLVED.** Service account, on the existing spreadsheet
`1VFBHcbtfMmUu6p6mGw2bMExFdZ8iiwev3BAfEXaxgTE`. Zero new dependencies — JWT signed
with `node:crypto`, Sheets v4 over `fetch`. Review happens in the sheet, so
`sync-reviews` reads `review_status` back into `outreach`. See Stage 7.
Outstanding sub-item: the service-account JSON key and Sheets API enablement are on
the user; until the key file exists, Phase 5 cannot run end to end.

**Q11 — Repo.** This directory is not a git repo yet. Want me to `git init`? I have not run it.

**Q12 — Bbox widening.** You mentioned expanding to Montgomery, Delaware, Bucks and Camden. Should the niche config carry several named markets (`philadelphia-core`, `philadelphia-metro`) selectable with `--market`, or one bbox you edit by hand? I would default to named markets.
