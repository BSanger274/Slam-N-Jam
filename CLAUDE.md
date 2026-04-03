# Slam-N-Jam — Claude Code Context

## What This Project Is
A live NCAA tournament fantasy scoring website for a 17-team draft league. Built on Node.js/Express, hosted on Render. Players were drafted to teams before the tournament; points accumulate as their real players score in games.

## Tech Stack
- **Backend:** Node.js / Express (`server.js`)
- **Frontend:** `public/index.html` (single-page)
- **Hosting:** Render (free tier — spins down when idle)
- **Data stores:** JSON files on disk
  - `rosters.json` — which players belong to which fantasy team
  - `totals.json` — cumulative season scoring totals
  - `gamelog.json` — game-by-game log entries
  - `processed.json` — tracks which games have already been processed to avoid double-counting

## Scoring Pipeline — Critical Rules

### Single Source of Truth
`playerTotals` is the **single source of truth** for all scoring. Never overwrite it with raw API data or stale values. All score updates must **add to** existing totals, not replace them.

### Live vs. Completed Games
- Live game data does **not persist** after games end — this is a known limitation
- Completed games require **manual box score entry** by the admin
- The admin help panel in the UI is used for this manual entry workflow

### Double-Count Prevention
`processed.json` tracks game IDs that have already been scored. Always check this before processing any game data.

## Key Architectural Decisions
- **Auto-elimination:** Losing teams are automatically eliminated after each round; uses school name normalization to match team names consistently
- **File-backed persistence:** All data is written to JSON files so it survives Render restarts
- **Final Four hardcoded:** UConn vs. Illinois and Arizona vs. Michigan (ESPN bracket API returned unreliable data)

## CRITICAL Deployment Rule
**Always fetch `/api/scores` before pushing any code to GitHub / triggering a Render deploy.**
Render restarts wipe in-memory state. Fetching first ensures accumulated `playerTotals` are written to disk and preserved.

## Known Bugs / Limitations
- Live game data does not persist after games end — completed rounds require manual box score entry
- ESPN bracket API is unreliable for late-round matchup data — hardcode if needed

## UI Features
- Draft round filters
- Clickable top scorers
- Pulsing LIVE indicator during active games
- Admin help panel (for manual score entry)
- Score ticker

## Repo
- GitHub: `BSanger274/Slam-N-Jam`
- Main files: `server.js`, `public/index.html`
- Data files: `rosters.json`, `totals.json`, `gamelog.json`, `processed.json`
