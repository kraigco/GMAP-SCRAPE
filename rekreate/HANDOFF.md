# Handoff — paste this into a new session

A snapshot, written 2026-08-27. The live version of this is in Rekoll; when the
two disagree, believe Rekoll.

---

```text
You're picking up the Rekreate Lead Intelligence Engine at e:\GMAP-SCRAPE\rekreate
— a Google Maps lead scraper that audits each prospect's website, writes a cold
outreach hook grounded in what it found, and pushes everything to a Google Sheet.

FIRST: this repo has a memory layer. Run these before anything else and read what
comes back — it holds decisions that aren't recoverable from the code:

  rekoll recall "state of play"
  rekoll recall "what is still outstanding"

(If `rekoll` isn't found: an Application Control policy blocks the pipx .exe on
this machine. Use ~/.local/bin/rekoll.cmd, or
%LOCALAPPDATA%\pipx\pipx\venvs\rekoll\Scripts\python.exe -m rekoll)

WHERE IT STANDS
- 197 tests, typecheck clean. Node 22+ runs the TypeScript directly — no build step.
- Dashboard: `npm run dashboard` → http://127.0.0.1:5173
- Google Sheets is connected and holds 326 leads. Every scrape auto-pushes,
  upserted on place_id, so re-scraping updates rows instead of duplicating.
- Outreach hooks are built (src/pitch/hooks.ts) — a per-business opening line
  from the measured gap × the niche. Letter template in
  src/pitch/templates/cold-outreach-v1.md.
- First commit is 3cd94a7. Check `git status` — the hook work may still be
  uncommitted.

DO THESE NEXT, IN ORDER
1. Check the Google Places quota. A sweep died at ~50-60 calls with
   "SearchTextRequest per day" exhausted, which is abnormally low. Look at
   console.cloud.google.com/apis/api/places.googleapis.com/quotas — likely no
   billing attached, or a low cap someone set. This is the main limit on scraping.
2. The user must re-paste apps-script/Code.gs into the sheet's Apps Script editor
   and redeploy (Deploy > Manage deployments > pencil > Version: NEW VERSION —
   editing code alone changes nothing). Then run
   `node src/cli/index.ts push --all` to fill the hook columns for all 326 leads.
3. Run one live search from the dashboard and confirm it auto-pushes to the sheet.
   That's the last untested link.
4. Audit the Philadelphia list. 181 of its 216 leads say "not audited" so they
   can't be written to. Auditing costs no Places quota — it only fetches the
   prospects' own sites.
5. The letter needs two things from the user before drafts can be generated:
   who signs it, and a postal address (CAN-SPAM requires one).

HARD RULES — breaking these is a bug, not a style choice
- Never invent a prospect's problem. Every line of outreach must rest on
  something the audit measured. "Says nothing" always beats "says something
  plausible". `unknown` is never a gap.
- The Places field mask is frozen — adding a field re-prices every call.
- Every search TERM is a full sweep of the box, so terms multiply cost directly.
- Report coverage honestly: partial sweeps, halted budgets and unsearched terms
  must all be visible in the output, never smoothed over.
- Secrets live in .env only. Never write one into source, a test or a comment.
- Ask before adding a dependency. There are deliberately no Google SDKs and no
  ORM; JWTs are signed with node:crypto and every API is called with plain fetch.

NOT BUILT YET: Postgres persistence, lead scoring, the AI pitch stage, and the
Sheets review round-trip. Without persistence the 30-day Google data TTL can't be
enforced, so out/searches/*.csv is currently an indefinite store of Google data.

Read CLAUDE.md and .cursor/rules/rekreate-engine.mdc for the full constraints.
And follow the standing rule already in Rekoll: recall before starting, save
every decision as it's made, save a state-of-play at the end.
```
