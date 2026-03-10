/**
 * ╔══════════════════════════════════════════════════════╗
 * ║   SLAM-N-JAM 2026 — Live Tournament Server           ║
 * ║   Node.js / Express                                  ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * AUTO-UPDATES EVERY 60 SECONDS:
 *   • ESPN scoreboard API  → live player point totals
 *   • ESPN bracket API     → game results, winners, advancement
 *
 * ROUTES:
 *   GET  /api/teams          → all teams + rosters + real-time pts
 *   GET  /api/bracket        → full tournament bracket (all regions)
 *   GET  /api/scores         → raw ESPN feed + active overrides
 *   GET  /api/history        → historical winners
 *   GET  /api/status         → server health + cache timestamps
 *   POST /api/admin/login    → get admin token
 *   POST /api/admin/roster   → upload roster JSON
 *   POST /api/admin/roster/csv → upload roster via CSV
 *   POST /api/admin/override → manual score override
 *   DELETE /api/admin/override/:name → remove override
 *   POST /api/admin/bracket/result   → manual bracket result override
 */

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Paths ────────────────────────────────────────────
const DATA        = path.join(__dirname, 'data');
const ROSTER_F    = path.join(DATA, 'rosters.json');
const OVERRIDE_F  = path.join(DATA, 'overrides.json');
const BRACKET_F   = path.join(DATA, 'bracket.json');
const HISTORY_F   = path.join(DATA, 'history.json');

// ─── Admin auth ───────────────────────────────────────
const ADMIN_PASS  = process.env.ADMIN_PASSWORD || 'slamnjam2026';
const ADMIN_TOKEN = Buffer.from(ADMIN_PASS).toString('base64');

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── File helpers ─────────────────────────────────────
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// ─── HTTP helper ──────────────────────────────────────
function fetchURL(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error('JSON parse failed')); }
      });
    }).on('error', reject);
  });
}

// ════════════════════════════════════════════════════════
//  ESPN SCORING CACHE
//  Fetches individual player point totals from live games
// ════════════════════════════════════════════════════════
let scoreCache     = {};   // { "Player Name": totalPts }
let scoreCacheTime = 0;
const SCORE_TTL    = 60_000; // 60 seconds

async function fetchLiveScores() {
  try {
    // NCAA Tournament group ID = 100
    const data   = await fetchURL('https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?groups=100&limit=50');
    const scores = {};
    for (const event of (data.events || [])) {
      for (const comp of (event.competitions || [])) {
        for (const team of (comp.competitors || [])) {
          for (const leader of (team.leaders || [])) {
            if (leader.name === 'points') {
              for (const l of (leader.leaders || [])) {
                const name = l.athlete?.displayName;
                const pts  = parseFloat(l.value) || 0;
                if (name) scores[name] = (scores[name] || 0) + pts;
              }
            }
          }
        }
      }
    }
    return scores;
  } catch (e) {
    console.error('[Scores] ESPN fetch failed:', e.message);
    return null; // null = keep old cache
  }
}

async function getLiveScores() {
  if (Date.now() - scoreCacheTime > SCORE_TTL) {
    const fresh = await fetchLiveScores();
    if (fresh !== null) {
      scoreCache     = fresh;
      scoreCacheTime = Date.now();
      console.log(`[${new Date().toISOString()}] Scores refreshed — ${Object.keys(scoreCache).length} players`);
    }
  }
  return scoreCache;
}

// ════════════════════════════════════════════════════════
//  ESPN BRACKET CACHE
//  Fetches bracket structure: matchups, seeds, winners
// ════════════════════════════════════════════════════════
let bracketCache     = null;
let bracketCacheTime = 0;
const BRACKET_TTL    = 90_000; // 90 seconds

// ESPN bracket regions for men's tournament
const ESPN_REGIONS = {
  East:    '1',
  West:    '2',
  South:   '3',
  Midwest: '4'
};

async function fetchESPNBracket() {
  try {
    const data = await fetchURL(
      'https://site.api.espn.com/apis/v2/sports/basketball/mens-college-basketball/tournaments/22?region=us&lang=en&groups=100'
    );

    const bracket = { east: {}, west: {}, south: {}, midwest: {}, final4: { sf: [], final: [], champion: 'TBD' } };
    const roundMap = { 1: 'r64', 2: 'r32', 3: 'r16', 4: 'r8', 5: 'r4', 6: 'rfinal' };

    const groups = data?.bracket?.fullViewable?.groups || [];

    for (const group of groups) {
      const regionName = (group.name || '').toLowerCase();
      let regionKey = null;
      if (regionName.includes('east'))    regionKey = 'east';
      if (regionName.includes('west'))    regionKey = 'west';
      if (regionName.includes('south'))   regionKey = 'south';
      if (regionName.includes('midwest')) regionKey = 'midwest';

      for (const round of (group.rounds || [])) {
        const roundKey = roundMap[round.number] || `r${round.number}`;
        const matchups = [];

        for (const matchup of (round.matchups || [])) {
          const [c1, c2] = matchup.competitors || [];
          const parseTeam = (c) => c ? {
            seed:  c.seed || null,
            name:  c.team?.shortDisplayName || c.team?.displayName || 'TBD',
            score: c.score !== undefined ? parseInt(c.score) : null,
            won:   c.winner === true ? true : c.winner === false ? false : null,
          } : { seed: null, name: 'TBD', score: null, won: null };

          matchups.push({ id: matchup.id || String(Math.random()), t1: parseTeam(c1), t2: parseTeam(c2) });
        }

        if (regionKey) {
          if (!bracket[regionKey][roundKey]) bracket[regionKey][roundKey] = [];
          bracket[regionKey][roundKey].push(...matchups);
        }
      }
    }

    // Final Four / Championship
    const finalGroups = (data?.bracket?.fullViewable?.groups || []).filter(g =>
      (g.name || '').toLowerCase().includes('final') || (g.name || '').toLowerCase().includes('national')
    );
    for (const fg of finalGroups) {
      for (const round of (fg.rounds || [])) {
        for (const matchup of (round.matchups || [])) {
          const [c1, c2] = matchup.competitors || [];
          const parseTeam = (c) => c ? {
            seed: c.seed || null,
            name: c.team?.shortDisplayName || 'TBD',
            score: c.score !== undefined ? parseInt(c.score) : null,
            won: c.winner === true ? true : c.winner === false ? false : null,
          } : { seed: null, name: 'TBD', score: null, won: null };
          const m = { id: matchup.id, t1: parseTeam(c1), t2: parseTeam(c2) };
          if (round.number === 5) bracket.final4.sf.push(m);
          if (round.number === 6) {
            bracket.final4.final.push(m);
            // Champion is the winner of the final
            if (c1?.winner) bracket.final4.champion = c1.team?.shortDisplayName || 'TBD';
            else if (c2?.winner) bracket.final4.champion = c2.team?.shortDisplayName || 'TBD';
          }
        }
      }
    }

    return bracket;
  } catch (e) {
    console.error('[Bracket] ESPN fetch failed:', e.message);
    return null;
  }
}

async function getLiveBracket() {
  if (Date.now() - bracketCacheTime > BRACKET_TTL || !bracketCache) {
    const fresh = await fetchESPNBracket();
    if (fresh !== null) {
      // Merge with any saved manual overrides
      const saved = readJSON(BRACKET_F, null);
      if (saved && saved._manualOverrides) {
        fresh._manualOverrides = saved._manualOverrides;
        applyBracketOverrides(fresh, saved._manualOverrides);
      }
      bracketCache     = fresh;
      bracketCacheTime = Date.now();
      writeJSON(BRACKET_F, { ...fresh, _cachedAt: new Date().toISOString() });
      console.log(`[${new Date().toISOString()}] Bracket refreshed from ESPN`);
    } else if (!bracketCache) {
      // First run and ESPN failed — use saved file or seed blank
      bracketCache = readJSON(BRACKET_F, buildBlankBracket());
    }
  }
  return bracketCache;
}

function applyBracketOverrides(bracket, overrides) {
  // overrides: { matchupId: { winnerId, score1, score2 } }
  for (const [id, ov] of Object.entries(overrides || {})) {
    for (const region of Object.values(bracket)) {
      if (typeof region !== 'object') continue;
      for (const matchups of Object.values(region)) {
        if (!Array.isArray(matchups)) continue;
        const m = matchups.find(x => x.id === id);
        if (m) {
          if (ov.score1 !== undefined) m.t1.score = ov.score1;
          if (ov.score2 !== undefined) m.t2.score = ov.score2;
          if (ov.winner === 't1') { m.t1.won = true; m.t2.won = false; }
          if (ov.winner === 't2') { m.t1.won = false; m.t2.won = true; }
        }
      }
    }
  }
}

function buildBlankBracket() {
  // Returns a seeded 2026 bracket with demo data for off-season display
  return readJSON(path.join(DATA, 'bracket_seed.json'), {
    east: {}, west: {}, south: {}, midwest: {},
    final4: { sf: [], final: [], champion: 'TBD' },
    _source: 'blank'
  });
}

// ════════════════════════════════════════════════════════
//  MERGED SCORES  (ESPN live + admin overrides)
// ════════════════════════════════════════════════════════
async function getMergedScores() {
  const live      = await getLiveScores();
  const overrides = readJSON(OVERRIDE_F, {});
  return { ...live, ...overrides };
}

// ════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════

app.get('/api/status', async (req, res) => {
  res.json({
    ok: true,
    scoresCachedAt:   scoreCacheTime  ? new Date(scoreCacheTime).toISOString()  : null,
    bracketCachedAt:  bracketCacheTime ? new Date(bracketCacheTime).toISOString(): null,
    livePlayerCount:  Object.keys(scoreCache).length,
    ts: Date.now()
  });
});

// Teams + real-time point totals
app.get('/api/teams', async (req, res) => {
  const rosters = readJSON(ROSTER_F, { teams: [] });
  const scores  = await getMergedScores();

  const teams = (rosters.teams || []).map(team => {
    let total = 0;
    const players = (team.players || []).map(p => {
      const pts = scores[p.name] ?? p.pts ?? 0;
      total += pts;
      // Mark as eliminated if their school is out of the bracket
      return { ...p, pts };
    });
    return { ...team, players, totalPts: total };
  });

  teams.sort((a, b) => b.totalPts - a.totalPts);
  res.json({ teams, lastFetch: new Date(scoreCacheTime).toISOString(), livePlayerCount: Object.keys(scores).length });
});

// Live bracket
app.get('/api/bracket', async (req, res) => {
  const bracket = await getLiveBracket();
  res.json({ bracket, cachedAt: new Date(bracketCacheTime).toISOString() });
});

// Raw scores (for admin transparency)
app.get('/api/scores', async (req, res) => {
  const live      = await getLiveScores();
  const overrides = readJSON(OVERRIDE_F, {});
  res.json({ live, overrides, merged: { ...live, ...overrides }, liveCount: Object.keys(live).length });
});

// History — inline fallback guarantees data is always returned
const HISTORY_DATA = { winners: [
  {year:2025,winner:"Nutty Professor"},{year:2024,winner:"Studio K"},
  {year:2023,winner:"Shy Ballers"},    {year:2022,winner:"Team McCarty"},
  {year:2021,winner:"Shy Ballers"},    {year:2020,winner:"*Vacant*"},
  {year:2019,winner:"One Putt Jackson"},{year:2018,winner:"Team McCarty"},
  {year:2017,winner:"Team McCarty"},   {year:2016,winner:"All World"},
  {year:2015,winner:"Itchy Ron"},      {year:2014,winner:"Itchy Ron"},
  {year:2013,winner:"One Legler Up"},  {year:2012,winner:"Money Bross"},
  {year:2011,winner:"Old School"},     {year:2010,winner:"Morley Brothers"},
  {year:2009,winner:"Juice / Steve Dyer"},{year:2008,winner:"One Legler Up"},
  {year:2007,winner:"Dream Team"},     {year:2006,winner:"Old School"},
  {year:2005,winner:"Dream Team"},     {year:2004,winner:"Jim & Frank"},
  {year:2003,winner:"Committee"},      {year:2002,winner:"Reese"},
  {year:2001,winner:"Committee"},      {year:2000,winner:"Morley Brothers"},
  {year:1999,winner:"Slam Dunks"},     {year:1998,winner:"Juice / Steve Dyer"},
  {year:1997,winner:"Team McCarty"},   {year:1996,winner:"Montreal Jacques"},
  {year:1995,winner:"Frank & Bill"},   {year:1994,winner:"Special K McNutt"},
  {year:1993,winner:"Charles Snowden"},{year:1992,winner:"Juice / Steve Dyer"},
  {year:1991,winner:"Rick Clark"},     {year:1990,winner:"John Snipes"},
  {year:1989,winner:"Juice / Steve Dyer"},{year:1988,winner:"Committee"},
  {year:1987,winner:"Bill Mac Attack McCarty"},{year:1986,winner:"Scott Marsden"},
  {year:1985,winner:"Jack Baltimore Thorpe"},{year:1984,winner:"Jack Baltimore Thorpe"},
  {year:1983,winner:"Special K McNutt"}
]};

app.get('/api/history', (req, res) => {
  // Try disk first (allows future edits), fall back to inline data
  const saved = readJSON(HISTORY_F, null);
  res.json(saved && saved.winners && saved.winners.length ? saved : HISTORY_DATA);
});

// ── Admin: Login ──────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASS) res.json({ token: ADMIN_TOKEN });
  else res.status(401).json({ error: 'Wrong password' });
});

// ── Admin: Upload roster JSON ─────────────────────────
app.post('/api/admin/roster', requireAdmin, (req, res) => {
  const { teams } = req.body;
  if (!Array.isArray(teams)) return res.status(400).json({ error: 'Expected { teams: [...] }' });
  writeJSON(ROSTER_F, { teams, updatedAt: new Date().toISOString() });
  res.json({ ok: true, teamCount: teams.length });
});

// ── Admin: Upload roster CSV ──────────────────────────
// Format: TeamName,PlayerName,School  (header row required)
app.post('/api/admin/roster/csv', requireAdmin, (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ error: 'No CSV provided' });

  const lines   = csv.trim().split('\n').slice(1);
  const teamMap = {};
  let playerCount = 0;

  for (const line of lines) {
    const parts = line.split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    const [teamName, playerName, school] = parts;
    if (!teamName || !playerName) continue;
    if (!teamMap[teamName]) teamMap[teamName] = { name: teamName, players: [] };
    teamMap[teamName].players.push({ name: playerName, school: school || '—', pts: 0, active: true });
    playerCount++;
  }

  const teams = Object.values(teamMap);
  writeJSON(ROSTER_F, { teams, updatedAt: new Date().toISOString() });
  res.json({ ok: true, teamCount: teams.length, playerCount });
});

// ── Admin: Score override ─────────────────────────────
app.post('/api/admin/override', requireAdmin, (req, res) => {
  const { playerName, pts } = req.body;
  if (!playerName || pts === undefined) return res.status(400).json({ error: 'playerName + pts required' });
  const overrides = readJSON(OVERRIDE_F, {});
  overrides[playerName] = Number(pts);
  writeJSON(OVERRIDE_F, overrides);
  scoreCacheTime = 0; // bust cache
  res.json({ ok: true, playerName, pts: overrides[playerName] });
});

app.delete('/api/admin/override/:playerName', requireAdmin, (req, res) => {
  const overrides = readJSON(OVERRIDE_F, {});
  delete overrides[decodeURIComponent(req.params.playerName)];
  writeJSON(OVERRIDE_F, overrides);
  scoreCacheTime = 0;
  res.json({ ok: true });
});

// ── Admin: Manual bracket result ──────────────────────
// Body: { matchupId, winner: 't1'|'t2', score1, score2 }
app.post('/api/admin/bracket/result', requireAdmin, (req, res) => {
  const { matchupId, winner, score1, score2 } = req.body;
  if (!matchupId || !winner) return res.status(400).json({ error: 'matchupId + winner required' });
  const saved = readJSON(BRACKET_F, {});
  if (!saved._manualOverrides) saved._manualOverrides = {};
  saved._manualOverrides[matchupId] = { winner, score1, score2 };
  writeJSON(BRACKET_F, saved);
  if (bracketCache) {
    if (!bracketCache._manualOverrides) bracketCache._manualOverrides = {};
    bracketCache._manualOverrides[matchupId] = { winner, score1, score2 };
    applyBracketOverrides(bracketCache, bracketCache._manualOverrides);
  }
  bracketCacheTime = 0; // force re-fetch next poll
  res.json({ ok: true });
});

// ── Admin: Force refresh ESPN data now ───────────────
app.post('/api/admin/refresh', requireAdmin, async (req, res) => {
  scoreCacheTime  = 0;
  bracketCacheTime = 0;
  await Promise.all([getLiveScores(), getLiveBracket()]);
  res.json({ ok: true, message: 'ESPN data force-refreshed' });
});

// ════════════════════════════════════════════════════════
//  INIT DATA FILES
// ════════════════════════════════════════════════════════
if (!fs.existsSync(ROSTER_F))   writeJSON(ROSTER_F,   { teams: [] });
if (!fs.existsSync(OVERRIDE_F)) writeJSON(OVERRIDE_F, {});
if (!fs.existsSync(BRACKET_F))  writeJSON(BRACKET_F,  buildBlankBracket());

if (!fs.existsSync(HISTORY_F)) {
  writeJSON(HISTORY_F, { winners: [
    {year:2025,winner:"Nutty Professor"},{year:2024,winner:"Studio K"},
    {year:2023,winner:"Shy Ballers"},    {year:2022,winner:"Team McCarty"},
    {year:2021,winner:"Shy Ballers"},    {year:2020,winner:"*Vacant*"},
    {year:2019,winner:"One Putt Jackson"},{year:2018,winner:"Team McCarty"},
    {year:2017,winner:"Team McCarty"},   {year:2016,winner:"All World"},
    {year:2015,winner:"Itchy Ron"},      {year:2014,winner:"Itchy Ron"},
    {year:2013,winner:"One Legler Up"},  {year:2012,winner:"Money Bross"},
    {year:2011,winner:"Old School"},     {year:2010,winner:"Morley Brothers"},
    {year:2009,winner:"Juice / Steve Dyer"},{year:2008,winner:"One Legler Up"},
    {year:2007,winner:"Dream Team"},     {year:2006,winner:"Old School"},
    {year:2005,winner:"Dream Team"},     {year:2004,winner:"Jim & Frank"},
    {year:2003,winner:"Committee"},      {year:2002,winner:"Reese"},
    {year:2001,winner:"Committee"},      {year:2000,winner:"Morley Brothers"},
    {year:1999,winner:"Slam Dunks"},     {year:1998,winner:"Juice / Steve Dyer"},
    {year:1997,winner:"Team McCarty"},   {year:1996,winner:"Montreal Jacques"},
    {year:1995,winner:"Frank & Bill"},   {year:1994,winner:"Special K McNutt"},
    {year:1993,winner:"Charles Snowden"},{year:1992,winner:"Juice / Steve Dyer"},
    {year:1991,winner:"Rick Clark"},     {year:1990,winner:"John Snipes"},
    {year:1989,winner:"Juice / Steve Dyer"},{year:1988,winner:"Committee"},
    {year:1987,winner:"Bill Mac Attack McCarty"},{year:1986,winner:"Scott Marsden"},
    {year:1985,winner:"Jack Baltimore Thorpe"},{year:1984,winner:"Jack Baltimore Thorpe"},
    {year:1983,winner:"Special K McNutt"}
  ]});
}

// ════════════════════════════════════════════════════════
//  START + WARM CACHE
// ════════════════════════════════════════════════════════
app.listen(PORT, async () => {
  console.log(`\n🏀 SLAM-N-JAM server running → http://localhost:${PORT}`);
  console.log('📡 Warming ESPN cache...');
  await Promise.all([getLiveScores(), getLiveBracket()]);
  console.log('✅ Ready.\n');

  // Keep refreshing in background
  setInterval(getLiveScores,  SCORE_TTL);
  setInterval(getLiveBracket, BRACKET_TTL);
});
