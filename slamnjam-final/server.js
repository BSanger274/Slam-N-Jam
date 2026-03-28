/**
 * SLAM-N-JAM 2026 — Live Tournament Server
 * Node.js / Express
 *
 * FIXES IN THIS VERSION:
 *  1. Tries multiple ESPN tournament IDs (22,23,24,20,19) — ESPN hasn't
 *     confirmed the 2026 ID yet, so we probe until one returns data.
 *     When all fail, falls back to seed bracket so page is never empty.
 *  2. Archive season bug fixed: was `scoresCache?.merged` (undefined
 *     variable) — now correctly uses `scoreCache` + overrides.
 *  3. requireAdmin accepts both x-admin-token AND Authorization: Bearer
 *     headers so the Archive Season button works from the frontend.
 *  4. HISTORY_DATA and CHAMPION_ROSTERS hardcoded inline — they now
 *     survive Render free-tier restarts that wipe disk state.
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
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ─── Paths ────────────────────────────────────────────
const DATA       = path.join(__dirname, 'data');
const ROSTER_F   = path.join(DATA, 'rosters.json');
const OVERRIDE_F   = path.join(DATA, 'overrides.json');
const COMPLETED_F  = path.join(DATA, 'completed.json');  // persists new-round pts across restarts
const TOTALS_F     = path.join(DATA, 'totals.json');      // auto-accumulated player pts (replaces HARDCODED_OVERRIDES)
const GAMELOG_F    = path.join(DATA, 'gamelog.json');     // auto-saved game log entries
const PROCESSED_F  = path.join(DATA, 'processed.json');   // tracks which ESPN game IDs already processed
const BRACKET_F  = path.join(DATA, 'bracket.json');
const HISTORY_F  = path.join(DATA, 'history.json');
const AVERAGES_F = path.join(__dirname, 'data', 'averages.json');
const JERSEY_F   = path.join(DATA, 'jerseys.json');

// ─── Admin auth ───────────────────────────────────────
const ADMIN_PASS  = process.env.ADMIN_PASSWORD || 'slamnjam2026';
const ADMIN_TOKEN = Buffer.from(ADMIN_PASS).toString('base64');

// FIX: Accept token from x-admin-token OR Authorization: Bearer header
function requireAdmin(req, res, next) {
  const tok = req.headers['x-admin-token'] || (req.headers['authorization'] || '').replace('Bearer ', '');
  if (tok !== ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
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

// ─── Player name normalization ───────────────────────
// Strips Jr./Sr./II/III/IV suffixes and normalizes punctuation
// so ESPN names like "John Mobley Jr." match roster "John Mobley Jr."
// and vice versa when one side is missing the suffix
function normalizeName(name) {
  return (name || '')
    .replace(/\s+(jr\.?|sr\.?|ii|iii|iv)$/i, '')  // strip suffix
    .replace(/\./g, '')                              // strip periods
    .replace(/'/g, "'")                              // normalize apostrophes
    .replace(/\s+/g, ' ')                            // collapse spaces
    .trim()
    .toLowerCase();
}

// ─── School name normalization (ESPN bracket -> roster) ─
const SCHOOL_NAME_MAP_SRV = {
  'Ohio State':'Ohio St', 'South Florida':'So Florida', 'Michigan State':'Mich St',
  'Michigan St':'Mich St', 'Texas Tech':'Tx Tech', 'Tennessee':'Tenn',
  'Tennessee State':'Tenn St', 'Tennessee St':'Tenn St', 'Connecticut':'UConn',
  'North Carolina':'UNC', 'N. Carolina':'UNC', 'NC State':'NC St',
  'Virginia Commonwealth':'VCU', 'Saint Louis':'St Louis', "Saint Mary's":'St Marys',
  'Prairie View':'Prairie View A&M', 'CA Baptist':'Cal Baptist',
  'California Baptist':'Cal Baptist', 'Vanderbilt':'Vandy', 'Wisconsin':'Wisc',
  'Miami':'Miami FL', 'Miami (OH)':'Miami OH', 'Iowa State':'Iowa St',
  'McNeese':'McNeese St', 'Kennesaw State':'Kennesaw St', 'Utah State':'Utah St',
  'Wright State':'Wright St', "St. John's":'St. John\'s',
};
function normSchool(name) { return SCHOOL_NAME_MAP_SRV[name] || name; }

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
// Completed-game pts for hardcoded players — persisted to file so server restarts don't lose data.
// Cleared manually via admin button between rounds after HARDCODED is updated.
// Load completed cache but discard any entries that predate today
let completedTodayCache = (() => {
  const saved = readJSON(COMPLETED_F, {});
  const meta  = readJSON(COMPLETED_F + '.meta', {});
  const todayStr = new Date().toDateString();
  if (meta.date && meta.date !== todayStr) {
    console.log('[Cache] completedTodayCache is from ' + meta.date + ' — clearing stale data');
    writeJSON(COMPLETED_F, {});
    writeJSON(COMPLETED_F + '.meta', { date: todayStr });
    return {};
  }
  writeJSON(COMPLETED_F + '.meta', { date: todayStr });
  return saved;
})();

// ── AUTO-TOTALS: persistent player pts — loaded from totals.json, seeded from HARDCODED ──
// Auto-updated by ESPN feed when games go final. Single source of truth for player pts.
let playerTotals = readJSON(TOTALS_F, {});
console.log('[Totals] Loaded ' + Object.keys(playerTotals).length + ' player totals');
function ensureTotals() {
  if (Object.keys(playerTotals).length === 0 && Object.keys(HARDCODED_OVERRIDES).length > 0) {
    console.log('[Totals] totals.json empty — seeding from HARDCODED_OVERRIDES (' + Object.keys(HARDCODED_OVERRIDES).length + ' players)');
    playerTotals = { ...HARDCODED_OVERRIDES };
    writeJSON(TOTALS_F, playerTotals);
  }
}

// Clear any stale completed.json entries that conflict with playerTotals
// This runs once on startup to prevent old cached R64/R32 data from poisoning scores
(function clearStaleOverrides() {
  const overrides = readJSON(OVERRIDE_F, {});
  const staleKeys = Object.keys(overrides).filter(name => playerTotals[name] !== undefined);
  if (staleKeys.length > 0) {
    staleKeys.forEach(k => delete overrides[k]);
    writeJSON(OVERRIDE_F, overrides);
    console.log('[Startup] Cleared ' + staleKeys.length + ' stale override entries that conflict with playerTotals');
  }
})();

// ── AUTO-GAMELOG: persistent game log — loaded from gamelog.json, seeded from GAME_LOG ──
// Auto-updated by ESPN feed when games go final.
// GAME_LOG is defined later in this file — seeding happens at first API call via ensureGameLog()
let playerGameLog = readJSON(GAMELOG_F, {});
console.log('[GameLog] Loaded ' + Object.keys(playerGameLog).length + ' player game logs');
function ensureGameLog() {
  if (Object.keys(playerGameLog).length === 0 && Object.keys(GAME_LOG).length > 0) {
    console.log('[GameLog] gamelog.json empty — seeding from GAME_LOG constant (' + Object.keys(GAME_LOG).length + ' players)');
    playerGameLog = JSON.parse(JSON.stringify(GAME_LOG));
    writeJSON(GAMELOG_F, playerGameLog);
  }
}

// Track which ESPN game IDs we've already fully processed (game went final + pts saved)
let processedGames = readJSON(PROCESSED_F, {});
// ════════════════════════════════════════════════════════
let scoreCache     = {};
let liveHalfCache  = new Set();
let minutesCache   = {}; // player name -> minutes played in current game
let scoreCacheTime = 0;
const SCORE_TTL    = 60_000;

async function fetchLiveScores() {
  try {
    const today = new Date();
    const dates = [];
    for (let i = -1; i <= 1; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      dates.push(d.toISOString().slice(0,10).replace(/-/g,''));
    }

    const scores    = {};
    const liveHalf  = new Set(); // schools currently in 1st half
    const allEvents = [];
    const seenIds   = new Set(); // FIX: deduplicate events across date queries

    for (const date of dates) {
      try {
        const data = await fetchURL(`https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?groups=100&limit=50&date=${date}`);
        for (const ev of (data.events || [])) {
          if (ev.id && seenIds.has(ev.id)) continue; // skip duplicate
          if (ev.id) seenIds.add(ev.id);
          allEvents.push(ev);
        }
      } catch(e) {}
    }

    for (const event of allEvents) {
      for (const comp of (event.competitions || [])) {
        // Patch bracket scores from live events
        if (bracketCache) {
          const comps = comp.competitors || [];
          if (comps.length >= 2) {
            const name1 = comps[0]?.team?.shortDisplayName || comps[0]?.team?.displayName || '';
            const name2 = comps[1]?.team?.shortDisplayName || comps[1]?.team?.displayName || '';
            const sc1 = comps[0]?.score !== undefined ? parseInt(comps[0].score) : null;
            const sc2 = comps[1]?.score !== undefined ? parseInt(comps[1].score) : null;
            const w1 = comps[0]?.winner === true;
            const w2 = comps[1]?.winner === true;
            const status = event.status?.type?.name || '';
            const isActive = status === 'STATUS_IN_PROGRESS' || status === 'STATUS_FINAL';
            if (isActive && sc1 !== null) {
              for (const ff of (bracketCache._firstFour || [])) {
                if (ff.status === 'STATUS_FINAL') continue;
                const n1 = (ff.t1?.name||'').toLowerCase(), n2 = (ff.t2?.name||'').toLowerCase();
                const e1 = name1.toLowerCase(), e2 = name2.toLowerCase();
                if ((n1.includes(e1)||e1.includes(n1)) && (n2.includes(e2)||e2.includes(n2))) {
                  ff.t1.score=sc1; ff.t2.score=sc2;
                  ff.t1.won=status==='STATUS_FINAL'?w1:null; ff.t2.won=status==='STATUS_FINAL'?w2:null;
                  ff.status=status; ff.clock=event.status?.displayClock||''; ff.period=event.status?.period||'';
                  ff.espnId=event.id||ff.id;
                } else if ((n1.includes(e2)||e2.includes(n1)) && (n2.includes(e1)||e1.includes(n2))) {
                  ff.t1.score=sc2; ff.t2.score=sc1;
                  ff.t1.won=status==='STATUS_FINAL'?w2:null; ff.t2.won=status==='STATUS_FINAL'?w1:null;
                  ff.status=status; ff.clock=event.status?.displayClock||''; ff.period=event.status?.period||'';
                  ff.espnId=event.id||ff.id;
                }
              }
              for (const region of ['east','west','south','midwest']) {
                for (const round of ['r64','r32','r16','r8']) {
                  for (const m of (bracketCache[region]?.[round] || [])) {
                    // Never overwrite a matchup already marked STATUS_FINAL in seed bracket
                    if (m.status === 'STATUS_FINAL') continue;
                    if (!m.t1?.name || !m.t2?.name) continue; // skip TBD slots
                    const n1 = (m.t1?.name||'').toLowerCase(), n2 = (m.t2?.name||'').toLowerCase();
                    const e1 = name1.toLowerCase(), e2 = name2.toLowerCase();
                    if ((n1.includes(e1)||e1.includes(n1)) && (n2.includes(e2)||e2.includes(n2))) {
                      m.t1.score=sc1; m.t2.score=sc2;
                      m.t1.won=status==='STATUS_FINAL'?w1:null; m.t2.won=status==='STATUS_FINAL'?w2:null;
                      m.status=status; m.clock=event.status?.displayClock||''; m.period=event.status?.period||'';
                      if(event.id) m.espnId=event.id;
                    } else if ((n1.includes(e2)||e2.includes(n1)) && (n2.includes(e1)||e1.includes(n2))) {
                      m.t1.score=sc2; m.t2.score=sc1;
                      m.t1.won=status==='STATUS_FINAL'?w2:null; m.t2.won=status==='STATUS_FINAL'?w1:null;
                      m.status=status; m.clock=event.status?.displayClock||''; m.period=event.status?.period||'';
                      if(event.id) m.espnId=event.id;
                    }
                  }
                }
              }
            }
          }
        }
        // Player points — use linescores/statistics for full box score data
        // Fall back to leaders array if detailed stats not available
        let gotDetailedStats = false;
        for (const team of (comp.competitors || [])) {
          // Try statistics array first (has every player, not just leaders)
          const teamStats = team.statistics || [];
          for (const statGroup of teamStats) {
            if (statGroup.name === 'scoring' || statGroup.abbreviation === 'PTS') {
              for (const athlete of (statGroup.athletes || [])) {
                const name = athlete.athlete?.displayName;
                const pts  = parseFloat(athlete.value) || 0;
                if (name && pts > 0) {
                  scores[name] = (scores[name] || 0) + pts;
                  gotDetailedStats = true;
                }
              }
            }
          }
          // Also check linescores
          for (const ls of (team.linescores || [])) {
            const name = ls.athlete?.displayName || ls.displayName;
            const pts  = parseFloat(ls.value) || 0;
            if (name && pts > 0) {
              scores[name] = (scores[name] || 0) + pts;
              gotDetailedStats = true;
            }
          }
        }
        // Track schools in 1st half for Option 2 trend suppression
        const evStatus = event.status?.type?.name || '';
        const evPeriod = parseInt(event.status?.period || 0);
        // Period 1 = first half in college basketball
        // Also catch halftime status
        const isFirstHalf = (evStatus === 'STATUS_IN_PROGRESS' && evPeriod <= 1) || evStatus === 'STATUS_HALFTIME';
        if (isFirstHalf) {
          for (const team of (comp.competitors || [])) {
            const name = (team.team?.shortDisplayName || team.team?.displayName || '').toLowerCase();
            if (name) liveHalf.add(name);
          }
        }

        // Fall back to leaders if no detailed stats found
        if (!gotDetailedStats) {
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
    }
    // Fetch full box scores for live AND recently completed games
    const savedOverrides = readJSON(OVERRIDE_F, {});
    const activeEvents = allEvents.filter(ev => {
      const s = ev.status?.type?.name || '';
      return s === 'STATUS_IN_PROGRESS' || s === 'STATUS_HALFTIME' || s === 'STATUS_FINAL';
    });
    const freshMinutes = {}; // player -> minutes played this game
    await Promise.all(activeEvents.slice(0, 15).map(async ev => {
      const evStatus = ev.status?.type?.name || '';
      const isFinal  = evStatus === 'STATUS_FINAL';

      // Determine round label and team names for game log
      const evTeams = (ev.competitions?.[0]?.competitors || []).map(c =>
        c.team?.shortDisplayName || c.team?.displayName || '');
      ev._slnjTeams = evTeams;

      // Determine NCAA tournament round from bracket cache
      ev._slnjRound = 'Unknown';
      ev._slnjOpp   = {};  // map: school -> opponent school
      if (bracketCache && evTeams.length >= 2) {
        const e1 = (evTeams[0]||'').toLowerCase(), e2 = (evTeams[1]||'').toLowerCase();
        const teamsMatch = (n1, n2) =>
          ((n1.includes(e1)||e1.includes(n1)) && (n2.includes(e2)||e2.includes(n2))) ||
          ((n1.includes(e2)||e2.includes(n1)) && (n2.includes(e1)||e1.includes(n2)));

        const roundLabels = { r64:'R64', r32:'R32', r16:'S16', r8:'E8', r4:'F4', rfinal:'NC' };
        for (const region of ['east','west','south','midwest']) {
          for (const [rkey, rlabel] of Object.entries(roundLabels)) {
            for (const m of (bracketCache[region]?.[rkey] || [])) {
              const n1 = (m.t1?.name||'').toLowerCase(), n2 = (m.t2?.name||'').toLowerCase();
              if (teamsMatch(n1, n2)) {
                ev._slnjRound = rlabel;
                ev._slnjOpp[evTeams[0]] = evTeams[1];
                ev._slnjOpp[evTeams[1]] = evTeams[0];
              }
            }
          }
        }
        for (const ff of (bracketCache._firstFour || [])) {
          const n1 = (ff.t1?.name||'').toLowerCase(), n2 = (ff.t2?.name||'').toLowerCase();
          if (teamsMatch(n1, n2)) {
            ev._slnjRound = 'FF';
            ev._slnjOpp[evTeams[0]] = evTeams[1];
            ev._slnjOpp[evTeams[1]] = evTeams[0];
          }
        }
      }

      try {
        const summary = await fetchURL(`https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${ev.id}`);
        // Get game clock for pace calculation
        const period = ev.status?.period || 0;
        const clock  = ev.status?.displayClock || '0:00';
        const [mm, ss] = clock.split(':').map(Number);
        const clockMins = mm + (ss || 0) / 60;
        // Minutes elapsed: each half is 20 mins
        // Period 1: 20 - clockMins elapsed. Period 2: 20 + (20 - clockMins) elapsed
        const minsElapsed = isFinal ? 40 :
          period === 1 ? Math.max(0, 20 - clockMins) :
          period === 2 ? Math.max(20, 40 - clockMins) :
          period > 2   ? 40 + (period - 2) * 5 : 0; // OT

        for (const teamData of (summary.boxscore?.players || [])) {
          for (const statGroup of (teamData.statistics || [])) {
            const labels = statGroup.labels || [];
            const iPts = labels.indexOf('PTS') >= 0 ? labels.indexOf('PTS') : 13;
            const iMin = labels.indexOf('MIN') >= 0 ? labels.indexOf('MIN') : 0;
            for (const athlete of (statGroup.athletes || [])) {
              if (athlete.didNotPlay) continue;
              const name = athlete.athlete?.displayName;
              const pts  = parseFloat((athlete.stats || [])[iPts]) || 0;
              const minRaw = (athlete.stats || [])[iMin] || '0';
              // MIN is stored as "MM:SS" or just a number
              const playerMins = typeof minRaw === 'string' && minRaw.includes(':')
                ? (() => { const [m,s] = minRaw.split(':').map(Number); return m + (s||0)/60; })()
                : parseFloat(minRaw) || 0;
              if (name) {
                if (pts > 0) scores[name] = pts;
                // Auto-save completed game scores — skip HARDCODED_OVERRIDES players only
                if (isFinal && pts > 0) {
                  // AUTO-ACCUMULATE: only process each game once using processedGames tracker
                  // This prevents double-counting if ESPN returns the same final game multiple times
                  if (!processedGames[ev.id]) {
                    const currentTotal = playerTotals[name] || 0;
                    playerTotals[name] = currentTotal + pts;

                    // Add game log entry
                    if (!playerGameLog[name]) playerGameLog[name] = [];
                    const roundLabel = ev._slnjRound || 'S16';
                    // Get this player's team to find their opponent
                    const playerTeamName = (() => {
                      for (const td of (summary.boxscore?.players || [])) {
                        for (const sg of (td.statistics || [])) {
                          for (const ath of (sg.athletes || [])) {
                            if (ath.athlete?.displayName === name) {
                              return td.team?.shortDisplayName || td.team?.displayName || '';
                            }
                          }
                        }
                      }
                      return '';
                    })();
                    const oppName = ev._slnjOpp?.[playerTeamName] || (ev._slnjTeams?.find(t => t !== playerTeamName)) || 'Unknown';
                    const alreadyHasEntry = playerGameLog[name].some(e => e.round === roundLabel && e.opp === oppName);
                    if (!alreadyHasEntry) {
                      playerGameLog[name].push({ round: roundLabel, opp: oppName, pts });
                    }
                  }
                  // Legacy: keep non-totals players in savedOverrides too
                  if (HARDCODED_OVERRIDES[name] === undefined && playerTotals[name] === undefined) {
                    savedOverrides[name] = pts;
                  }
                }
                // Only track minutes for LIVE games — final game players must NOT
                // appear in freshMinutes or the cache cleanup won't clear their stale minutes
                if (!isFinal) {
                  freshMinutes[name] = playerMins > 0 ? playerMins : minsElapsed;
                }
              }
            }
          }
        }
      } catch(e) {}
    }));
    // Mark fully processed games and persist all accumulated data
    for (const ev of activeEvents) {
      if ((ev.status?.type?.name || '') === 'STATUS_FINAL' && ev.id && !processedGames[ev.id]) {
        processedGames[ev.id] = { date: new Date().toISOString(), teams: ev._slnjTeams, round: ev._slnjRound };
        // Auto-eliminate losing school from rosters
        if (ev._slnjTeams && ev._slnjTeams.length >= 2) {
          const comps = (ev.competitions?.[0]?.competitors || []);
          const loser = comps.find(c => c.winner === false);
          if (loser) {
            const loserName = (loser.team?.shortDisplayName || loser.team?.displayName || '').toLowerCase();
            const rosters = readJSON(ROSTER_F, { teams: [] });
            let updated = false;
            for (const team of rosters.teams) {
              for (const p of team.players) {
                const school = (p.school || '').toLowerCase();
                // Strict match with abbreviation table — prevents Michigan/Michigan St confusion
                const normSchoolForElim = s => {
                  const abbrevMap = {
                    'mich st':'michigan state','mich':'michigan',
                    'uconn':'connecticut','conn':'connecticut',
                    'st johns':"st john's",'st. johns':"st john's",
                    'iowa st':'iowa state','tenn':'tennessee',
                    'tex tech':'texas tech','tex':'texas',
                    'so florida':'south florida','so fla':'south florida',
                    'n carolina':'north carolina','nc':'north carolina',
                    'n dakota st':'north dakota state',
                    'pr view':'prairie view','kennesaw st':'kennesaw state',
                    'mich st':'michigan state',
                  };
                  const clean = s.toLowerCase().replace(/\.$/,'').trim();
                  return (abbrevMap[clean] || clean).replace(/[^a-z]/g,'');
                };
                const schoolNorm = normSchoolForElim(school);
                const loserNorm  = normSchoolForElim(loserName);
                const exactMatch = schoolNorm === loserNorm;
                if (exactMatch && p.active !== false) {
                  p.active = false;
                  updated = true;
                }
              }
            }
            if (updated) {
              writeJSON(ROSTER_F, rosters);
              console.log('[AutoElim] Marked ' + loserName + ' players as eliminated');
            }
          }
        }
      }
    }
    writeJSON(PROCESSED_F, processedGames);
    writeJSON(TOTALS_F, playerTotals);
    writeJSON(GAMELOG_F, playerGameLog);
    // Persist auto-saved scores
    writeJSON(OVERRIDE_F, savedOverrides);
    // Update minutesCache — only keep players from currently LIVE games
    // Clear entries for players whose games have ended (prevents stale minutes causing false flames)
    const livePlayerNames = new Set(Object.keys(freshMinutes));
    for (const name of Object.keys(minutesCache)) {
      if (!livePlayerNames.has(name)) {
        delete minutesCache[name];
      }
    }
    Object.assign(minutesCache, freshMinutes);

    console.log(`[Scores] ${Object.keys(scores).length} players, ${allEvents.length} events, ${liveHalf.size} schools in 1st half`);
    return { scores, liveHalf };
  } catch (e) {
    console.error('[Scores] ESPN fetch failed:', e.message);
    return null;
  }
}

async function getLiveScores() {
  if (Date.now() - scoreCacheTime > SCORE_TTL) {
    const fresh = await fetchLiveScores();
    if (fresh !== null) {
      scoreCache     = fresh.scores;
      liveHalfCache  = fresh.liveHalf;
      scoreCacheTime = Date.now();
      console.log(`[${new Date().toISOString()}] Scores refreshed — ${Object.keys(scoreCache).length} players`);
    }
  }
  return { scores: scoreCache, liveHalf: liveHalfCache };
}

// ════════════════════════════════════════════════════════
//  ESPN SEASON AVERAGES CACHE
// ════════════════════════════════════════════════════════
let avgCache     = {};
let avgCacheTime = 0;
const AVG_TTL    = 6 * 60 * 60 * 1000;

async function fetchSeasonAverages() {
  const avgs = {};

  const TEAM_IDS = {
    'Duke':150,'Ohio St':194,'St. John\'s':2569,'Kansas':2305,'Louisville':97,
    'Mich St':127,'UCLA':26,'UConn':41,'Arizona':12,'Villanova':222,
    'Wisc':275,'Arkansas':8,'BYU':252,'Gonzaga':2250,'Miami FL':2390,
    'Purdue':2509,'Florida':57,'Clemson':228,'Vandy':238,'Nebraska':158,
    'UNC':153,'Illinois':356,'St Marys':2608,'Houston':248,'Michigan':130,
    'Georgia':61,'Tx Tech':2641,'Alabama':333,'Tenn':2633,'Virginia':258,
    'Kentucky':96,'Iowa St':66,'Texas':251,'NC St':152,'Howard':47,
    'Iowa':2294,'McNeese St':2377,'Troy':2653,'VCU':2670,'Penn':219,
    'Texas A&M':245,'Utah St':328,'High Point':2729,'Hawaii':62,
    'Kennesaw St':2908,'Missouri':142,'Akron':2006,'Hofstra':2206,
    'Wright St':2752,'Santa Clara':2616,'Tenn St':2634,'Furman':231,
    'Siena':2623,'So Florida':58,'TCU':2628,'Northern Iowa':2254,
    'Cal Baptist':2856,'SMU':2567,'Miami OH':193,'Prairie View A&M':2504,
    'Lehigh':2348,'UMBC':2413,'St Louis':139,'UCF':2116,
  };

  const seen = new Set();
  const entries = Object.entries(TEAM_IDS).filter(([,id]) => {
    if (seen.has(id)) return false;
    seen.add(id); return true;
  });

  let fetched = 0;
  for (let i = 0; i < entries.length; i += 5) {
    const batch = entries.slice(i, i + 5);
    await Promise.all(batch.map(async ([school, teamId]) => {
      try {
        // Primary: sports.core API — powers the ESPN stats page, returns all players with avgPoints
        const data = await fetchURL(
          `https://sports.core.api.espn.com/v2/sports/basketball/leagues/mens-college-basketball/seasons/2026/types/2/teams/${teamId}/athletes/statistics`
        );
        for (const entry of (data?.entries || data?.items || [])) {
          const name = entry.athlete?.displayName || entry.displayName;
          if (!name) continue;
          for (const cat of (entry.splits?.categories || entry.categories || [])) {
            for (const stat of (cat.stats || [])) {
              if (stat.abbreviation === 'PTS' || stat.name === 'avgPoints' || stat.displayName === 'Points Per Game') {
                const val = parseFloat(stat.value);
                if (val > 0) avgs[name] = val;
              }
            }
          }
        }

        // Fallback: site API statistics endpoint
        if (!Object.keys(avgs).length) {
          const d2 = await fetchURL(
            `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams/${teamId}/statistics`
          );
          for (const cat of (d2?.results?.stats?.categories || [])) {
            for (const leader of (cat.leaders || [])) {
              const name = leader.athlete?.displayName;
              const val  = parseFloat(leader.value);
              if (name && val > 0 && !avgs[name]) avgs[name] = val;
            }
          }
        }
        fetched++;
      } catch(e) {}
    }));
  }

  console.log(`[Averages] Got PPG for ${Object.keys(avgs).length} players from ${fetched} teams`);
  return avgs;
}

// Hardcoded season averages — fallback if file not found
const HARDCODED_AVERAGES = {
  "Cameron Boozer": 22.5,
  "Isaiah Evans": 14.9,
  "Patrick Ngongba": 10.7,
  "Cayden Boozer": 9.0,
  "Dame Sarr": 8.5,
  "Nikolas Khamenia": 7.3,
  "Maliq Brown": 7.0,
  "Maliq Brown": 18.2,
  "Caleb Foster": 8.5,
  "Brayden Burries": 15.9,
  "Koa Peat": 13.8,
  "Jaden Bradley": 13.4,
  "Motiejus Krivas": 10.8,
  "Tobe Awaka": 9.6,
  "Ivan Kharchenkov": 8.0,
  "Dwayne Aristode": 5.0,
  "Yaxel Lendeborg": 14.4,
  "Morez Johnson": 13.7,
  "Aday Mara": 11.3,
  "Elliot Cadeau": 9.9,
  "Nimari Burnett": 9.0,
  "Roddy Gayle Jr.": 7.0,
  "Will Tschetter": 5.0,
  "Thomas Haugh": 17.1,
  "Thomas Haugh": 17.1,
  "Alex Condon": 15.0,
  "Rueben Chinyelu": 12.0,
  "Xaivian Lee": 11.4,
  "Boogie Fland": 11.6,
  "Micah Handlogten": 5.5,
  "Urban Klavzar": 4.0,
  "Milan Momcilovic": 17.1,
  "Joshua Jefferson": 16.9,
  "Tamin Lipsey": 13.3,
  "Killyan Toure": 8.3,
  "Nate Heise": 4.0,
  "Jamarion Batemon": 3.5,
  "Keaton Wagler": 17.9,
  "Kylan Boswell": 13.0,
  "David Mirkovic": 13.4,
  "Tomislav Ivisic": 10.0,
  "Zvonimir Ivisic": 7.0,
  "Andrej Stojakovic": 13.4,
  "Kingston Flemings": 16.4,
  "Emanuel Sharp": 15.3,
  "Milos Uzan": 11.0,
  "Chris Cenac": 9.0,
  "Joseph Tugler": 7.0,
  "Isiah Harwell": 8.0,
  "Chase McCarty": 4.0,
  "Fletcher Loyer": 16.3,
  "Trey Kaufman-Renn": 15.0,
  "Braden Smith": 14.3,
  "Oscar Cluff": 12.0,
  "Daniel Jacobsen": 5.0,
  "Omer Mayer": 6.0,
  "C.J. Cox": 6.0,
  "Solo Ball": 15.6,
  "Tarris Reed Jr.": 13.9,
  "Alex Karaban": 13.2,
  "Silas Demary": 11.1,
  "Braylon Mullins": 9.9,
  "Eric Reibe": 5.0,
  "Labaron Philon": 21.7,
  "Labaron Philon Jr.": 21.5,
  "Aden Holloway": 16.8,
  "Latrell Wrightsell": 12.0,
  "Amari Allen": 9.0,
  "Aiden Sherrell": 7.0,
  "AJ Dybantsa": 25.3,
  "Robert Wright III": 18.2,
  "Kennard Davis": 9.0,
  "Graham Ike": 19.7,
  "Tyon Grant-Foster": 11.0,
  "Adam Miller": 10.0,
  "Braden Huff": 9.0,
  "Mario Saint-Supery": 8.0,
  "Darius Acuff": 22.9,
  "Trevon Brazile": 13.0,
  "D.J. Wagner": 12.0,
  "Meleek Thomas": 15.4,
  "Billy Richmond III": 11.0,
  "Malique Ewin": 9.6,
  "Nick Pringle": 6.0,
  "Otega Oweh": 18.2,
  "Mouhamed Dioubate": 11.6,
  "Collin Chandler": 9.0,
  "Denzel Aberdeen": 8.0,
  "Zuby Ejiofor": 16.3,
  "Oziyah Sellers": 13.0,
  "Ian Jackson": 11.0,
  "Dillon Mitchell": 8.7,
  "Bryce Hopkins": 8.0,
  "Joson Sanon": 6.0,
  "Thijs De Ridder": 15.5,
  "Seth Trimble": 11.8,
  "Jacari White": 10.4,
  "Devin McGlockton": 11.6,
  "Ugonna Onyenso": 9.8,
  "Braeden Carrington": 12.4,
  "Divine Ugochukwu": 11.2,
  "Dallin Hall": 13.6,
  "Jamarques Lawrence": 9.7,
  "Michael Cooper": 13.4,
  "Tramon Mark": 13.5,
  "Dailyn Swain": 17.7,
  "Jordan Pope": 12.6,
  "Matas Vokietaitis": 15.5,
  "Darrion Williams": 14.0,
  "Quadir Copeland": 14.8,
  "Paul McNeil Jr.": 11.2,
  "Ven-Allen Lubin": 8.4,
  "Matt Able": 6.2,
  "Jeremiah Wilkinson": 17.0,
  "Blue Cain": 12.0,
  "Kanon Catchings": 11.0,
  "Marcus Millender": 8.0,
  "Somtochukwu Cyril": 7.8,
  "Felix Okpara": 10.2,
  "Ja'Kobi Gillespie": 11.4,
  "Nate Ament": 17.5,
  "J.P. Estrella": 12.4,
  "Darryn Peterson": 15.2,
  "Jeremy Fears": 15.7,
  "Jaxon Kohler": 12.4,
  "Coen Carr": 13.8,
  "Jaron Pierre Jr.": 11.6,
  "MJ Collins": 17.6,
  "AK Okereke": 10.8,
  "David Punch": 14.3,
  "Rashaun Agee": 14.7,
  "Davis Fogle": 11.2,
  "Thomas Dowd": 14.8,
  "Marcus Hill": 9.8,
  "Joseph Omojafo": 12.6,
  "Duke Miles": 16.5,
  "Wes Enis": 16.8,
  "Paulius Murauskas": 14.2,
  "Simeon Cottle": 20.2,
  "Jaylen Petty": 13.6,
  "Cooper Koch": 11.2,
  "Cruz Davis": 20.2,
  "TJ Burch": 12.3,
  "Pop Isaacs": 14.6,
  "Malik Reneau": 18.8,
  "Flory Bidunga": 12.8,
  "Skyy Clark": 13.6,
  "Acaden Lewis": 11.4,
  "Braden Frager": 11.6,
  "Mason Falslev": 16.1,
  "Tavion Banks": 8.4,
  "Malik Thomas": 11.6,
  "Tavari Johnson": 12.6,
  "Austin Rapp": 9.2,
  "Bryson Tiller": 8.8,
  "Isaiah Brown": 12.4,
  "Xavier Booker": 10.2,
  "Chance Mallory": 8.6,
  "Boopie Miller": 13.8,
  "Ace Buckner": 11.4,
  "Kur Teng": 8.8,
  "Sam Hoiberg": 9.6,
  "Cedric Taylor": 12.2,
  "Donovan Atwell": 10.8,
  "Donovan Dent": 12.4,
  "Nolan Winter": 9.6,
  "Jayden Stone": 11.2,
  "Victor Valdes": 14.8,
  "Alex Wilkins": 17.7,
  "Eian Elmer": 12.6,
  "Micah Robinson": 9.4,
  "Tre Donaldson": 16.5,
  "Dominique Daniels": 23.2,
  "Devin Royal": 13.6,
  "Larry Johnson": 17.5,
  "Rob Martin": 15.3,
  "Tyshawn Archie": 14.3,
  "Shammah Scott": 9.8,
  "Travis Harper II": 17.3,
  "Tyler Tanner": 19.1,
  "Carson Cooper": 11.2,
  "Sam Lewis": 9.6,
  "Dontae Horne": 20.3,
  "Eric Dailey": 11.6,
  "Amani Lyles": 14.6,
  "Preston Edmead": 15.9,
  "Hank Alvey": 15.2,
  "Malachi Moreno": 8.0,
  "Tai Reon Joseph": 17.8,
  "Yaxel Lendeborg": 14.4,
  "Jordan Scott": 7.5,
  "Jalen Washington": 6.8,
  "Allen Graves": 5.4,
  "Tru Washington": 8.1,
  "Izaiyah Nelson": 15.7,
  "Blake Buchanan": 9.8,
  "Aaron Nkrumah": 17.6,
  "Henri Veesaar": 16.7,
  "Corey Washington": 13.8,
  "Christin Hammond": 14.6,
  "Themus Fulks": 14.1,
  "Terry Anderson": 16.0,
  "Samet Yigitoglu": 11.6,
  "RJ Godfrey": 13.4,
  "Bennett Stirtz": 20.0,
  "Tre White": 12.6,
  "J'Vonne Hadley": 11.8,
  "Ethan Roberts": 16.9,
  "Luka Bogavac": 9.8,
  "Ryan Conwell": 18.7,
  "Tyler Nickel": 13.3,
  "LeJuan Watts": 14.8,
  "Isaac McKneely": 13.4,
  "Jordan Burks": 10.8,
  "Tai Reon Joseph": 12.1,
  "Elijah Mahi": 12.6,
  "Gavin Doty": 17.9,
  "Nick Boyd": 20.6,
  "Melvin Council Jr.": 13.2,
  "Terrence Hill": 14.4,
  "B.J. Edwards": 12.4,
  "Tyler Perkins": 11.8,
  "Riley Kugel": 10.6,
  "Lazar Djokovic": 13.4,
  "TJ Power": 16.8,
  "Jadrian Tracey": 11.4,
  "Jayden Pierre": 10.5,
  "Cole Bowser": 14.0,
  "Pryce Sandfort": 17.8,
  "Tyler Bilodeau": 11.6,
  "John Mobley Jr.": 15.7,
  "Joshua Dent": 10.8,
  "Shelton Henderson": 13.6,
  "Amare Bynum": 11.2,
  "Joseph Pinion": 14.2,
  "Christoph Tilly": 9.8,
  "Brant Byers": 14.4,
  "Bryce Lindsay": 10.2,
  "Cam'Ron Fletcher": 12.7,
  "John Blackwell": 19.0,
  "Anthony Dell'Orso": 11.8,
  "Bruce Thornton": 20.2,
  "Mark Mitchell": 18.3,
  "Mikey Lewis": 14.2,
  "Trent Perry": 10.4,
  "Robbie Avila": 16.4,
  "Peter Suder": 14.4,
  "Jarin Stevenson": 12.6,
  "Dylan Darling": 11.4,
  "Liutauras Lelevicius": 8.4,
  "Javohn Garcia": 12.0,
  "Christian Anderson": 18.9,
  "Trey McKenney": 10.8,
  "Nasir Whitlock": 21.0,
  "Rienk Mast": 13.5,
  "Xavier Edmonds": 9.8,
  "Duke Brennan": 8.6,
  "Derek Dixon": 11.2,
  "Rylan Griffen": 10.4,
  "Rashaun Agee": 14.7,
  "Dre Bullock": 13.5
};

async function getSeasonAverages() {
  if (Date.now() - avgCacheTime > AVG_TTL || Object.keys(avgCache).length === 0) {
    // First load from hardcoded averages file
    const fileAvgs = readJSON(AVERAGES_F, {});
    if (Object.keys(fileAvgs).length > 0) {
      avgCache = fileAvgs;
      console.log(`[Averages] Loaded ${Object.keys(avgCache).length} player averages from file`);
    } else {
      // Fall back to hardcoded averages in server.js
      avgCache = {...HARDCODED_AVERAGES};
      console.log(`[Averages] Using hardcoded averages — ${Object.keys(avgCache).length} players`);
    }
    // Then try ESPN to supplement/update (non-blocking)
    fetchSeasonAverages().then(fresh => {
      if (Object.keys(fresh).length > 0) {
        // Merge — ESPN values take precedence over hardcoded
        avgCache = { ...avgCache, ...fresh };
        // Persist to averages.json so accurate values survive restarts
        writeJSON(AVERAGES_F, avgCache);
        console.log(`[Averages] ESPN supplemented with ${Object.keys(fresh).length} players — total: ${Object.keys(avgCache).length} — saved to file`);
      }
    }).catch(() => {});
    avgCacheTime = Date.now();
  }
  return avgCache;
}


// ════════════════════════════════════════════════════════
//  JERSEY NUMBERS
// ════════════════════════════════════════════════════════
const TOURNAMENT_TEAM_IDS_JERSEY = {
  150:'Duke',2509:'Purdue',2569:'St. John\'s',2305:'Kansas',97:'Louisville',
  127:'Mich St',26:'UCLA',41:'UConn',12:'Arizona',222:'Villanova',
  275:'Wisc',8:'Arkansas',252:'BYU',2250:'Gonzaga',2390:'Miami FL',
  57:'Florida',228:'Clemson',238:'Vandy',158:'Nebraska',153:'UNC',
  356:'Illinois',2608:'St Marys',248:'Houston',130:'Michigan',61:'Georgia',
  2641:'Tx Tech',333:'Alabama',2633:'Tenn',258:'Virginia',96:'Kentucky',
  251:'Texas',152:'NC St',47:'Howard',2294:'Iowa',2377:'McNeese St',
  2653:'Troy',2670:'VCU',219:'Penn',245:'Texas A&M',328:'Utah St',
  2729:'High Point',62:'Hawaii',2908:'Kennesaw St',142:'Missouri',
  2006:'Akron',2206:'Hofstra',2750:'Wright St',2607:'Santa Clara',
  2634:'Tenn St',231:'Furman',2561:'Siena',58:'So Florida',2116:'UCF',
  2628:'TCU',2567:'SMU',193:'Miami OH',2504:'Prairie View A&M',2348:'Lehigh',
  66:'Iowa St',194:'Ohio St',139:'St Louis',2856:'Cal Baptist',
};

async function fetchJerseyNumbers() {
  const existing = readJSON(JERSEY_F, {});
  // Only fetch if we have fewer than 200 jerseys cached
  if (Object.keys(existing).length >= 200) {
    console.log(`[Jerseys] Using cached ${Object.keys(existing).length} jersey numbers`);
    return existing;
  }
  console.log('[Jerseys] Fetching jersey numbers from ESPN...');
  const jerseys = { ...existing };
  const teamIds = Object.keys(TOURNAMENT_TEAM_IDS_JERSEY).map(Number);
  for (let i = 0; i < teamIds.length; i += 5) {
    const batch = teamIds.slice(i, i + 5);
    await Promise.all(batch.map(async teamId => {
      try {
        const data = await fetchURL(
          `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams/${teamId}/roster`
        );
        for (const athlete of (data.athletes || [])) {
          const name = athlete.displayName || athlete.fullName;
          const jersey = athlete.jersey || athlete.number;
          if (name && jersey) jerseys[name] = String(jersey);
        }
      } catch(e) {}
    }));
  }
  writeJSON(JERSEY_F, jerseys);
  console.log(`[Jerseys] Saved ${Object.keys(jerseys).length} jersey numbers`);
  return jerseys;
}

let jerseyCache = {};
async function getJerseys() {
  if (Object.keys(jerseyCache).length === 0) {
    jerseyCache = await fetchJerseyNumbers();
  }
  return jerseyCache;
}

// ════════════════════════════════════════════════════════
//  ESPN BRACKET CACHE
//  FIX: Probes multiple tournament IDs — ESPN uses a different
//  ID each year and hasn't confirmed 2026 yet. We try each in
//  order and use the first one that returns data. If all fail,
//  the seed bracket is used so the page is never blank.
// ════════════════════════════════════════════════════════
let bracketCache     = null;
let bracketCacheTime = 0;
const BRACKET_TTL    = 90_000;

const ESPN_TOURNAMENT_IDS = ['22', '23', '24', '20', '19'];

async function fetchESPNBracket() {
  try {
    const roundMap = { 1:'r64', 2:'r32', 3:'r16', 4:'r8', 5:'r4', 6:'rfinal' };

    for (const tid of ESPN_TOURNAMENT_IDS) {
      try {
        const data   = await fetchURL(
          `https://site.api.espn.com/apis/v2/sports/basketball/mens-college-basketball/tournaments/${tid}?region=us&lang=en&groups=100`
        );
        const groups = data?.bracket?.fullViewable?.groups || [];
        console.log(`[Bracket] Tournament ID ${tid} returned ${groups.length} groups`);
        if (groups.length === 0) continue;

        console.log('[Bracket] Group names:', groups.map(g => g.name).join(', '));

        const bracket = { east:{}, west:{}, south:{}, midwest:{}, final4:{ sf:[], final:[], champion:'TBD' } };

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
              const pt = (c) => c ? {
                seed:  c.seed || null,
                name:  c.team?.shortDisplayName || c.team?.displayName || 'TBD',
                score: c.score !== undefined ? parseInt(c.score) : null,
                won:   c.winner === true ? true : c.winner === false ? false : null,
              } : { seed:null, name:'TBD', score:null, won:null };
              matchups.push({ id: matchup.id || String(Math.random()), t1:pt(c1), t2:pt(c2) });
            }

            if (regionKey) {
              if (!bracket[regionKey][roundKey]) bracket[regionKey][roundKey] = [];
              bracket[regionKey][roundKey].push(...matchups);
            }
            if (round.number === 5) {
              for (const matchup of (round.matchups || [])) {
                const [c1,c2] = matchup.competitors || [];
                const pt = (c) => c ? { seed:c.seed||null, name:c.team?.shortDisplayName||'TBD', score:c.score!==undefined?parseInt(c.score):null, won:c.winner===true?true:c.winner===false?false:null } : {seed:null,name:'TBD',score:null,won:null};
                bracket.final4.sf.push({ id:matchup.id, t1:pt(c1), t2:pt(c2) });
              }
            }
            if (round.number === 6) {
              for (const matchup of (round.matchups || [])) {
                const [c1,c2] = matchup.competitors || [];
                const pt = (c) => c ? { seed:c.seed||null, name:c.team?.shortDisplayName||'TBD', score:c.score!==undefined?parseInt(c.score):null, won:c.winner===true?true:c.winner===false?false:null } : {seed:null,name:'TBD',score:null,won:null};
                bracket.final4.final.push({ id:matchup.id, t1:pt(c1), t2:pt(c2) });
                if (c1?.winner) bracket.final4.champion = c1.team?.shortDisplayName||'TBD';
                else if (c2?.winner) bracket.final4.champion = c2.team?.shortDisplayName||'TBD';
              }
            }
          }
        }
        return bracket; // success
      } catch(e) {
        console.log(`[Bracket] Tournament ID ${tid} error: ${e.message}`);
      }
    }

    console.log('[Bracket] ESPN returned 0 groups for all IDs — seed bracket will be used');
    return null;
  } catch (e) {
    console.error('[Bracket] ESPN fetch failed:', e.message);
    return null;
  }
}

async function updateFirstFourScores(bracket) {
  try {
    const today = new Date();
    const dates = [];
    for (let i = -1; i <= 1; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      dates.push(d.toISOString().slice(0,10).replace(/-/g,''));
    }
    for (const date of dates) {
      const data = await fetchURL(
        `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?date=${date}&groups=100&limit=20`
      );
      for (const ev of (data?.events || [])) {
        const comp  = ev.competitions?.[0];
        if (!comp) continue;
        const teams = comp.competitors || [];
        if (teams.length < 2) continue;
        const t1name  = teams[0]?.team?.shortDisplayName || teams[0]?.team?.displayName || '';
        const t2name  = teams[1]?.team?.shortDisplayName || teams[1]?.team?.displayName || '';
        const t1score = teams[0]?.score !== undefined ? parseInt(teams[0].score) : null;
        const t2score = teams[1]?.score !== undefined ? parseInt(teams[1].score) : null;
        const t1won   = teams[0]?.winner === true;
        const t2won   = teams[1]?.winner === true;
        const status  = ev.status?.type?.name || '';
        const isLive  = status === 'STATUS_IN_PROGRESS';
        const isFinal = status === 'STATUS_FINAL';
        if (!bracket._firstFour) continue;
        for (const ff of bracket._firstFour) {
          const ff1=(ff.t1?.name||'').toLowerCase(), ff2=(ff.t2?.name||'').toLowerCase();
          const e1=t1name.toLowerCase(), e2=t2name.toLowerCase();
          if ((ff1.includes(e1)||e1.includes(ff1)) && (ff2.includes(e2)||e2.includes(ff2))) {
            if (isLive||isFinal) {
              ff.t1.score=t1score; ff.t1.won=isFinal?t1won:null;
              ff.t2.score=t2score; ff.t2.won=isFinal?t2won:null;
              ff.status=status; ff.clock=ev.status?.displayClock||''; ff.period=ev.status?.period||'';
              ff.espnId=ev.id||ff.id;
            }
            break;
          }
          if ((ff1.includes(e2)||e2.includes(ff1)) && (ff2.includes(e1)||e1.includes(ff2))) {
            if (isLive||isFinal) {
              ff.t1.score=t2score; ff.t1.won=isFinal?t2won:null;
              ff.t2.score=t1score; ff.t2.won=isFinal?t1won:null;
              ff.status=status; ff.clock=ev.status?.displayClock||''; ff.period=ev.status?.period||'';
              ff.espnId=ev.id||ff.id;
            }
            break;
          }
        }
      }
    }
  } catch(e) {
    console.error('[FirstFour scores]', e.message);
  }
}

async function getLiveBracket() {
  if (Date.now() - bracketCacheTime > BRACKET_TTL || !bracketCache) {
    const fresh = await fetchESPNBracket();
    const seed  = buildBlankBracket();

    // Always start from seed so bracket is never empty.
    // Then overlay ESPN data on top where it exists.
    const merged = seed;

    // Preserve any STATUS_FINAL results from previous cache so they never flicker
    if (bracketCache) {
      for (const region of ['east','west','south','midwest']) {
        for (const round of ['firstfour','r64','r32','r16','r8']) {
          for (let i = 0; i < (bracketCache[region]?.[round] || []).length; i++) {
            const prev = bracketCache[region][round][i];
            const curr = merged[region]?.[round]?.[i];
            if (prev?.status === 'STATUS_FINAL' && curr) {
              merged[region][round][i] = prev;
            }
          }
        }
      }
    }
    if (fresh) {
      for (const region of ['east','west','south','midwest']) {
        if (fresh[region] && Object.keys(fresh[region]).length > 0) {
          for (const [roundKey, matchups] of Object.entries(fresh[region])) {
            if (matchups && matchups.length > 0) merged[region][roundKey] = matchups;
          }
        }
      }
      if (fresh.final4?.sf?.length   > 0) merged.final4.sf    = fresh.final4.sf;
      if (fresh.final4?.final?.length > 0) merged.final4.final = fresh.final4.final;
      if (fresh.final4?.champion && fresh.final4.champion !== 'TBD') merged.final4.champion = fresh.final4.champion;
    }

    // Auto-advance winners through all rounds within each region
    // Each pair of games feeds into the next round: [0,1]->slot[0], [2,3]->slot[1] etc.
    const advanceRound = (prevRound, nextRound) => {
      for (let i = 0; i < prevRound.length; i += 2) {
        const g1   = prevRound[i], g2 = prevRound[i+1];
        const slot = nextRound[i/2];
        if (!slot) continue;
        const winner = (g) => g ? (g.t1?.won ? g.t1 : g.t2?.won ? g.t2 : null) : null;
        const w1 = winner(g1), w2 = winner(g2);
        if (w1) slot.t1 = { seed: w1.seed, name: w1.name, score: null, won: null };
        if (w2) slot.t2 = { seed: w2.seed, name: w2.name, score: null, won: null };
      }
    };

    for (const region of ['east','west','south','midwest']) {
      const r = merged[region];
      if (!r) continue;
      advanceRound(r.r64  || [], r.r32  || []);  // R64    -> R32
      advanceRound(r.r32  || [], r.r16  || []);  // R32    -> Sweet 16
      advanceRound(r.r16  || [], r.r8   || []);  // Sweet 16 -> Elite 8
    }

    // Elite 8 winners -> Final Four
    // Order: east[0], west[0], south[0], midwest[0] -> sf[0].t1, sf[0].t2, sf[1].t1, sf[1].t2
    const e8Winners = ['east','west','south','midwest'].map(region => {
      const g = (merged[region]?.r8 || [])[0];
      return g ? (g.t1?.won ? g.t1 : g.t2?.won ? g.t2 : null) : null;
    });
    if (merged.final4?.sf?.length >= 2) {
      if (e8Winners[0]) merged.final4.sf[0].t1 = { seed: e8Winners[0].seed, name: e8Winners[0].name, score: null, won: null };
      if (e8Winners[1]) merged.final4.sf[0].t2 = { seed: e8Winners[1].seed, name: e8Winners[1].name, score: null, won: null };
      if (e8Winners[2]) merged.final4.sf[1].t1 = { seed: e8Winners[2].seed, name: e8Winners[2].name, score: null, won: null };
      if (e8Winners[3]) merged.final4.sf[1].t2 = { seed: e8Winners[3].seed, name: e8Winners[3].name, score: null, won: null };
    }

    const saved = readJSON(BRACKET_F, null);
    if (saved && saved._manualOverrides) {
      merged._manualOverrides = saved._manualOverrides;
      applyBracketOverrides(merged, saved._manualOverrides);
    }

    await updateFirstFourScores(merged);

    bracketCache     = merged;
    bracketCacheTime = Date.now();
    writeJSON(BRACKET_F, { ...merged, _cachedAt: new Date().toISOString() });
    console.log(`[${new Date().toISOString()}] Bracket refreshed from ESPN`);
  }
  return bracketCache;
}

function applyBracketOverrides(bracket, overrides) {
  for (const [id, ov] of Object.entries(overrides || {})) {
    for (const region of Object.values(bracket)) {
      if (typeof region !== 'object') continue;
      for (const matchups of Object.values(region)) {
        if (!Array.isArray(matchups)) continue;
        const m = matchups.find(x => x.id === id);
        if (m) {
          if (ov.score1 !== undefined) m.t1.score = ov.score1;
          if (ov.score2 !== undefined) m.t2.score = ov.score2;
          if (ov.winner === 't1') { m.t1.won = true;  m.t2.won = false; }
          if (ov.winner === 't2') { m.t1.won = false; m.t2.won = true;  }
        }
      }
    }
  }
}

function buildBlankBracket() {
  const tbd  = () => ({ seed:null, name:'TBD', score:null, won:null });
  const team = (seed, name) => ({ seed, name, score:null, won:null });
  return {
    _source: '2026-selection-sunday',
    _firstFour: [
      { id:'ff3', espnId:'401856435', region:'midwest', date:'Tue Mar 17', time:'6:40 PM ET', tv:'truTV', location:'UD Arena, Dayton, OH', status:'STATUS_FINAL', t1:{seed:16,name:'UMBC',score:83,won:false}, t2:{seed:16,name:'Howard',score:86,won:true} },
      { id:'ff1', espnId:'401856434', region:'west',    date:'Tue Mar 17', time:'9:15 PM ET', tv:'truTV', location:'UD Arena, Dayton, OH', status:'STATUS_FINAL', t1:{seed:11,name:'Texas',score:68,won:true}, t2:{seed:11,name:'NC State',score:66,won:false} },
      { id:'ff4', region:'south',   date:'Wed Mar 18', time:'6:40 PM ET', tv:'truTV', location:'UD Arena, Dayton, OH', status:'STATUS_FINAL', t1:{seed:16,name:'Prairie View A&M',score:null,won:true}, t2:{seed:16,name:'Lehigh',score:null,won:false} },
      { id:'ff2', region:'midwest', date:'Wed Mar 18', time:'9:15 PM ET', tv:'truTV', location:'UD Arena, Dayton, OH', status:'STATUS_FINAL', t1:{seed:11,name:'Miami OH',score:89,won:true}, t2:{seed:11,name:'SMU',score:79,won:false} }
    ],
    east: {
      r64: [
        { id:'e1', date:'Thu Mar 19', time:'2:50 PM ET',  location:'Bon Secours Wellness Arena, Greenville, SC', tv:'CBS', status:'STATUS_FINAL', t1:{seed:1,name:'Duke',score:71,won:true}, t2:{seed:16,name:'Siena',score:65,won:false} },
        { id:'e2', date:'Thu Mar 19', time:'12:15 PM ET', location:'Bon Secours Wellness Arena, Greenville, SC', tv:'CBS', status:'STATUS_FINAL', t1:{seed:8,name:'Ohio State',score:64,won:false}, t2:{seed:9,name:'TCU',score:66,won:true} },
        { id:'e3', espnId:'401856476', date:'Fri Mar 20', time:'7:10 PM ET',  location:'Viejas Arena, San Diego, CA',                tv:'CBS', status:'STATUS_FINAL', t1:{seed:5,name:"St. John's",score:79,won:true},  t2:{seed:12,name:'Northern Iowa',score:53,won:false} },
        { id:'e4', espnId:'401856477', date:'Fri Mar 20', time:'9:45 PM ET',  location:'Viejas Arena, San Diego, CA',                tv:'CBS', status:'STATUS_FINAL', t1:{seed:4,name:'Kansas',score:68,won:true},        t2:{seed:13,name:'Cal Baptist',score:60,won:false} },
        { id:'e5', date:'Thu Mar 19', time:'1:30 PM ET',  location:'KeyBank Center, Buffalo, NY',                tv:'TNT', status:'STATUS_FINAL', t1:{seed:6,name:'Louisville',score:83,won:true}, t2:{seed:11,name:'South Florida',score:79,won:false} },
        { id:'e6', date:'Thu Mar 19', time:'4:05 PM ET',  location:'KeyBank Center, Buffalo, NY',                tv:'TNT', status:'STATUS_FINAL', t1:{seed:3,name:'Michigan St',score:92,won:true}, t2:{seed:14,name:'N. Dakota St',score:67,won:false} },
        { id:'e7', espnId:'401856480', date:'Fri Mar 20', time:'7:25 PM ET',  location:'Wells Fargo Center, Philadelphia, PA',       tv:'TBS', status:'STATUS_FINAL', t1:{seed:7,name:'UCLA',score:75,won:true},          t2:{seed:10,name:'UCF',score:71,won:false} },
        { id:'e8', espnId:'401856481', date:'Fri Mar 20', time:'10:00 PM ET', location:'Wells Fargo Center, Philadelphia, PA',       tv:'TBS', status:'STATUS_FINAL', t1:{seed:2,name:'UConn',score:82,won:true},         t2:{seed:15,name:'Furman',score:71,won:false} }
      ],
      r32:  [
        { id:'e9',  date:'Sat Mar 22', status:'STATUS_FINAL', t1:{seed:1,name:'Duke',score:81,won:true},          t2:{seed:9,name:'TCU',score:58,won:false} },
        { id:'e10', date:'Sun Mar 23', status:'STATUS_FINAL', t1:{seed:5,name:"St. John's",score:67,won:true},     t2:{seed:4,name:'Kansas',score:65,won:false} },
        { id:'e11', date:'Sat Mar 22', status:'STATUS_FINAL', t1:{seed:6,name:'Louisville',score:69,won:false},    t2:{seed:3,name:'Michigan St',score:77,won:true} },
        { id:'e12', date:'Sun Mar 23', status:'STATUS_FINAL', t1:{seed:7,name:'UCLA',score:57,won:false},          t2:{seed:2,name:'UConn',score:73,won:true} }
      ],
      r16:  [
        { id:'e13', date:'Fri Mar 28', time:'7:10 PM ET', tv:'CBS',    status:'STATUS_FINAL', t1:{seed:5,name:"St. John's",score:58,won:false}, t2:{seed:1,name:'Duke',score:63,won:true} },
        { id:'e14', date:'Fri Mar 28', time:'9:45 PM ET', tv:'CBS',    status:'STATUS_FINAL', t1:{seed:3,name:'Michigan St',score:61,won:false}, t2:{seed:2,name:'UConn',score:77,won:true} }
      ],
      r8:   [{ id:'e15',t1:tbd(),t2:tbd() }]
    },
    west: {
      r64: [
        { id:'w1', espnId:'401856482', date:'Fri Mar 20', time:'1:35 PM ET', location:'Pechanga Arena, San Diego, CA', tv:'TNT', status:'STATUS_FINAL', t1:{seed:1,name:'Arizona',score:92,won:true},       t2:{seed:16,name:'LIU',score:58,won:false} },
        { id:'w2', espnId:'401856483', date:'Fri Mar 20', time:'4:10 PM ET', location:'Pechanga Arena, San Diego, CA', tv:'TNT', status:'STATUS_FINAL', t1:{seed:8,name:'Villanova',score:76,won:false},    t2:{seed:9,name:'Utah State',score:86,won:true} },
        { id:'w3', date:'Thu Mar 19', time:'1:50 PM ET', location:'Moda Center, Portland, OR',     tv:'TBS', status:'STATUS_FINAL', t1:{seed:5,name:'Wisconsin',score:82,won:false}, t2:{seed:12,name:'High Point',score:83,won:true} },
        { id:'w4', date:'Thu Mar 19', time:'4:25 PM ET', location:'Moda Center, Portland, OR',     tv:'TBS', status:'STATUS_FINAL', t1:{seed:4,name:'Arkansas',score:97,won:true}, t2:{seed:13,name:"Hawai'i",score:78,won:false} },
        { id:'w5', date:'Thu Mar 19', time:'9:50 PM ET', location:'Moda Center, Portland, OR',     tv:'TBS', status:'STATUS_FINAL', t1:{seed:6,name:'BYU',score:71,won:false}, t2:{seed:11,name:'Texas',score:79,won:true} },
        { id:'w6', date:'Thu Mar 19', time:'7:15 PM ET', location:'Moda Center, Portland, OR',     tv:'TBS', status:'STATUS_FINAL', t1:{seed:3,name:'Gonzaga',score:73,won:true}, t2:{seed:14,name:'Kennesaw State',score:64,won:false} },
        { id:'w7', espnId:'401856486', date:'Fri Mar 20', time:'6:50 PM ET', location:'Pechanga Arena, San Diego, CA', tv:'TNT', status:'STATUS_FINAL', t1:{seed:7,name:'Miami FL',score:80,won:true},      t2:{seed:10,name:'Missouri',score:66,won:false} },
        { id:'w8', espnId:'401856487', date:'Fri Mar 20', time:'9:25 PM ET', location:'Pechanga Arena, San Diego, CA', tv:'TNT', status:'STATUS_FINAL', t1:{seed:2,name:'Purdue',score:104,won:true},       t2:{seed:15,name:'Queens',score:71,won:false} }
      ],
      r32:  [
        { id:'w9',  date:'Sun Mar 23', status:'STATUS_FINAL', t1:{seed:1,name:'Arizona',score:78,won:true},       t2:{seed:9,name:'Utah State',score:66,won:false} },
        { id:'w10', date:'Sat Mar 22', status:'STATUS_FINAL', t1:{seed:12,name:'High Point',score:88,won:false},  t2:{seed:4,name:'Arkansas',score:94,won:true} },
        { id:'w11', date:'Sat Mar 22', status:'STATUS_FINAL', t1:{seed:11,name:'Texas',score:74,won:true},        t2:{seed:3,name:'Gonzaga',score:68,won:false} },
        { id:'w12', date:'Sun Mar 23', status:'STATUS_FINAL', t1:{seed:7,name:'Miami FL',score:69,won:false},     t2:{seed:2,name:'Purdue',score:79,won:true} }
      ],
      r16:  [
        { id:'w14', date:'Thu Mar 27', time:'9:45 PM ET', tv:'CBS',   status:'STATUS_FINAL', t1:{seed:4,name:'Arkansas',score:77,won:false}, t2:{seed:1,name:'Arizona',score:88,won:true} },
        { id:'w13', date:'Thu Mar 27', time:'7:10 PM ET', tv:'CBS',   status:'STATUS_FINAL', t1:{seed:11,name:'Texas',score:77,won:false},    t2:{seed:2,name:'Purdue',score:87,won:true} }
      ],
      r8:   [{ id:'w15',t1:tbd(),t2:tbd() }]
    },
    south: {
      r64: [
        { id:'s1', espnId:'401856488', date:'Fri Mar 20', time:'9:25 PM ET',  location:'Amalie Arena, Tampa, FL',                    tv:'TNT',   status:'STATUS_FINAL', t1:{seed:1,name:'Florida',score:114,won:true},     t2:{seed:16,name:'Prairie View A&M',score:55,won:false} },
        { id:'s2', espnId:'401856489', date:'Fri Mar 20', time:'6:50 PM ET',  location:'Amalie Arena, Tampa, FL',                    tv:'TNT',   status:'STATUS_FINAL', t1:{seed:8,name:'Clemson',score:61,won:false},     t2:{seed:9,name:'Iowa',score:67,won:true} },
        { id:'s3', date:'Thu Mar 19', time:'9:20 PM ET',  location:'Paycom Center, Oklahoma City, OK',           tv:'truTV', status:'STATUS_FINAL', t1:{seed:5,name:'Vanderbilt',score:78,won:true}, t2:{seed:12,name:'McNeese',score:68,won:false} },
        { id:'s4', date:'Thu Mar 19', time:'6:45 PM ET',  location:'Paycom Center, Oklahoma City, OK',           tv:'truTV', status:'STATUS_FINAL', t1:{seed:4,name:'Nebraska',score:76,won:true}, t2:{seed:13,name:'Troy',score:47,won:false} },
        { id:'s5', date:'Thu Mar 19', time:'12:10 PM ET', location:'Bon Secours Wellness Arena, Greenville, SC', tv:'TNT',   status:'STATUS_FINAL', t1:{seed:6,name:'N. Carolina',score:78,won:false}, t2:{seed:11,name:'VCU',score:82,won:true} },
        { id:'s6', date:'Thu Mar 19', time:'2:45 PM ET',  location:'Bon Secours Wellness Arena, Greenville, SC', tv:'TNT',   status:'STATUS_FINAL', t1:{seed:3,name:'Illinois',score:105,won:true}, t2:{seed:14,name:'Penn',score:70,won:false} },
        { id:'s7', date:'Thu Mar 19', time:'7:35 PM ET',  location:'Paycom Center, Oklahoma City, OK',           tv:'truTV', status:'STATUS_FINAL', t1:{seed:7,name:"Saint Mary's",score:50,won:false}, t2:{seed:10,name:'Texas A&M',score:63,won:true} },
        { id:'s8', date:'Thu Mar 19', time:'10:10 PM ET', location:'Paycom Center, Oklahoma City, OK',           tv:'truTV', status:'STATUS_FINAL', t1:{seed:2,name:'Houston',score:78,won:true}, t2:{seed:15,name:'Idaho',score:47,won:false} }
      ],
      r32:  [
        { id:'s9',  date:'Sun Mar 23', status:'STATUS_FINAL', t1:{seed:1,name:'Florida',score:72,won:false},     t2:{seed:9,name:'Iowa',score:73,won:true} },
        { id:'s10', date:'Sat Mar 22', status:'STATUS_FINAL', t1:{seed:5,name:'Vanderbilt',score:72,won:false},  t2:{seed:4,name:'Nebraska',score:74,won:true} },
        { id:'s11', date:'Sat Mar 22', status:'STATUS_FINAL', t1:{seed:11,name:'VCU',score:55,won:false},        t2:{seed:3,name:'Illinois',score:76,won:true} },
        { id:'s12', date:'Sat Mar 22', status:'STATUS_FINAL', t1:{seed:10,name:'Texas A&M',score:57,won:false},  t2:{seed:2,name:'Houston',score:88,won:true} }
      ],
      r16:  [
        { id:'s13', date:'Thu Mar 27', time:'7:30 PM ET', tv:'TBS, truTV', status:'STATUS_FINAL', t1:{seed:9,name:'Iowa',score:89,won:true},  t2:{seed:4,name:'Nebraska',score:72,won:false} },
        { id:'s14', date:'Thu Mar 27', time:'10:05 PM ET', tv:'TBS, truTV', status:'STATUS_FINAL', t1:{seed:3,name:'Illinois',score:65,won:true}, t2:{seed:2,name:'Houston',score:54,won:false} }
      ],
      r8:   [{ id:'s15',t1:tbd(),t2:tbd() }]
    },
    midwest: {
      r64: [
        { id:'m1', date:'Thu Mar 19', time:'7:10 PM ET',  location:'KeyBank Center, Buffalo, NY',          tv:'CBS',   status:'STATUS_FINAL', t1:{seed:1,name:'Michigan',score:101,won:true}, t2:{seed:16,name:'Howard',score:80,won:false} },
        { id:'m2', date:'Thu Mar 19', time:'9:45 PM ET',  location:'KeyBank Center, Buffalo, NY',          tv:'CBS',   status:'STATUS_FINAL', t1:{seed:8,name:'Georgia',score:77,won:false}, t2:{seed:9,name:'Saint Louis',score:102,won:true} },
        { id:'m3', espnId:'401856490', date:'Fri Mar 20', time:'12:40 PM ET', location:'Amalie Arena, Tampa, FL',              tv:'truTV', status:'STATUS_FINAL', t1:{seed:5,name:'Texas Tech',score:91,won:true},   t2:{seed:12,name:'Akron',score:71,won:false} },
        { id:'m4', espnId:'401856491', date:'Fri Mar 20', time:'3:15 PM ET',  location:'Amalie Arena, Tampa, FL',              tv:'truTV', status:'STATUS_FINAL', t1:{seed:4,name:'Alabama',score:90,won:true},      t2:{seed:13,name:'Hofstra',score:70,won:false} },
        { id:'m5', espnId:'401856492', date:'Fri Mar 20', time:'4:25 PM ET',  location:'Wells Fargo Center, Philadelphia, PA', tv:'TBS',   status:'STATUS_FINAL', t1:{seed:6,name:'Tennessee',score:78,won:true},    t2:{seed:11,name:'Miami OH',score:56,won:false} },
        { id:'m6', espnId:'401856493', date:'Fri Mar 20', time:'1:50 PM ET',  location:'Wells Fargo Center, Philadelphia, PA', tv:'TBS',   status:'STATUS_FINAL', t1:{seed:3,name:'Virginia',score:82,won:true},     t2:{seed:14,name:'Wright State',score:73,won:false} },
        { id:'m7', espnId:'401856494', date:'Fri Mar 20', time:'12:15 PM ET', location:'Enterprise Center, St. Louis, MO',     tv:'CBS',   status:'STATUS_FINAL', t1:{seed:7,name:'Kentucky',score:89,won:true},     t2:{seed:10,name:'Santa Clara',score:84,won:false} },
        { id:'m8', espnId:'401856495', date:'Fri Mar 20', time:'2:50 PM ET',  location:'Enterprise Center, St. Louis, MO',     tv:'CBS',   status:'STATUS_FINAL', t1:{seed:2,name:'Iowa State',score:108,won:true},  t2:{seed:15,name:'Tennessee St',score:74,won:false} }
      ],
      r32:  [
        { id:'m9',  date:'Sat Mar 22', status:'STATUS_FINAL', t1:{seed:1,name:'Michigan',score:95,won:true},      t2:{seed:9,name:'Saint Louis',score:72,won:false} },
        { id:'m10', date:'Sun Mar 23', status:'STATUS_FINAL', t1:{seed:5,name:'Texas Tech',score:65,won:false},   t2:{seed:4,name:'Alabama',score:90,won:true} },
        { id:'m11', date:'Sun Mar 23', status:'STATUS_FINAL', t1:{seed:6,name:'Tennessee',score:79,won:true},     t2:{seed:3,name:'Virginia',score:72,won:false} },
        { id:'m12', date:'Sun Mar 23', status:'STATUS_FINAL', t1:{seed:7,name:'Kentucky',score:63,won:false},     t2:{seed:2,name:'Iowa State',score:82,won:true} }
      ],
      r16:  [
        { id:'m13', date:'Fri Mar 28', time:'7:35 PM ET', tv:'TBS, truTV', status:'STATUS_FINAL', t1:{seed:4,name:'Alabama',score:68,won:false}, t2:{seed:1,name:'Michigan',score:72,won:true} },
        { id:'m14', date:'Fri Mar 28', time:'10:10 PM ET', tv:'TBS, truTV', status:'STATUS_FINAL', t1:{seed:6,name:'Tennessee',score:78,won:true}, t2:{seed:2,name:'Iowa State',score:70,won:false} }
      ],
      r8:   [{ id:'m15',t1:tbd(),t2:tbd() }]
    },
    final4: {
      sf: [
        { id:'f1', t1:team(null,'East Winner'),  t2:team(null,'South Winner')   },
        { id:'f2', t1:team(null,'West Winner'),  t2:team(null,'Midwest Winner') }
      ],
      final:    [{ id:'f3', t1:tbd(), t2:tbd() }],
      champion: 'TBD'
    }
  };
}

// ════════════════════════════════════════════════════════
//  MERGED SCORES
// ════════════════════════════════════════════════════════
// ─── Hardcoded score overrides ───────────────────────
// These survive Render redeploys (disk wipes on restart).
// Add any completed-game scores here that must persist.
// Admin UI overrides in overrides.json take highest priority.
// HARDCODED_OVERRIDES: cumulative pts through all completed games
// ALL completed game scores are locked in here for redeploy safety
// Auto-save + GitHub push handles any players NOT listed here
const HARDCODED_OVERRIDES = {
  // ── First Four eliminated ──
  "Nasir Whitlock":      5,   // Lehigh (FF elim)
  "Hank Alvey":         23,   // Lehigh (FF elim)
  "Jaron Pierre Jr.":   18,   // SMU (FF elim)
  "Boopie Miller":      15,   // SMU (FF elim)
  "Corey Washington":   13,   // SMU (FF elim)
  "Samet Yigitoglu":     8,   // SMU (FF elim)

  // ── R64 Thu Mar 19 — Duke 71, Siena 65 ──
  // ── R32 Sat Mar 22 — Duke 81, TCU 58 ──
  "Gavin Doty":            21,  // Siena (21 R64 vs Duke) ELIM
  "Cameron Boozer":    63,   // Duke  (22 R64 + 19 R32)
  "Cayden Boozer":     35,   // Duke  (19 R64 +  9 R32)
  "Isaiah Evans":      58,   // Duke  (16 R64 + 17 R32)
  "Nikolas Khamenia":   13,   // Duke (3 R64 vs Siena + 6 R32 vs TCU)
  "Dame Sarr":         21,   // Duke  ( 5 R64 + 14 R32)
  "Gavin Doty":        21,   // Siena (eliminated R64)
  // TCU eliminated in R32 — final totals:
  "Micah Robinson":    36,   // TCU (18 R64 + 18 R32) ELIM
  "Xavier Edmonds":    28,   // TCU (16 R64 + 12 R32) ELIM
  "David Punch":       20,   // TCU (16 R64 +  4 R32) ELIM
  "Jayden Pierre":      8,   // TCU ( 4 R64 +  4 R32) ELIM
  "Liutauras Lelevicius": 5, // TCU ( 4 R64 +  1 R32) ELIM
  "Devin Royal":       14,   // TCU (14 R64 +  0 R32) ELIM
  "Amare Bynum":       12,   // TCU (12 R64 +  0 R32) ELIM
  "John Mobley Jr.":   15,   // TCU (15 R64 +  0 R32) ELIM
  "Christoph Tilly":   10,   // TCU (10 R64 +  0 R32) ELIM
  "Bruce Thornton":    10,   // Ohio St (R64 elim)

  // ── R64 Thu Mar 19 — Nebraska 76, Troy 47 ──
  // ── R32 Sat Mar 22 — Nebraska 74, Vanderbilt 72 ──
  "Pryce Sandfort":    63,   // Nebraska (23 R64 + 15 R32)
  "Jamarques Lawrence":31,   // Nebraska (13 R64 +  9 R32)
  "Rienk Mast":        33,   // Nebraska (11 R64 + 13 R32)
  "Sam Hoiberg":       18,   // Nebraska ( 4 R64 +  8 R32)
  "Braden Frager":     44,   // Nebraska (13 R64 + 15 R32)
  "Thomas Dowd":        4,   // Nebraska ( 4 R64 +  0 R32)
  "Victor Valdes":     14,   // Troy (eliminated R64)
  // Vanderbilt eliminated in R32 — final totals:
  "Tyler Tanner":      53,   // Vandy (26 R64 + 27 R32) ELIM
  "Duke Miles":        22,   // Vandy (13 R64 +  9 R32) ELIM
  "Devin McGlockton":  15,   // Vandy (12 R64 +  3 R32) ELIM
  "Maliq Brown":          24,  // Louisville (6 R64 vs So Florida + 12 R32 vs Mich St) ELIM
  "Jalen Washington":     10,  // Vandy (4 R64 vs McNeese St + 6 R32 vs Nebraska) ELIM
  "AK Okereke":        16,   // Vandy ( 7 R64 +  9 R32) ELIM
  "Tyler Nickel":      28,   // Vandy (12 R64 + 16 R32) ELIM
  "Larry Johnson":     15,   // McNeese (eliminated R64)
  "Tyshawn Archie":    13,   // McNeese (eliminated R64)
  "Javohn Garcia":     10,   // McNeese (eliminated R64)

  // ── R64 Thu Mar 19 — Wisconsin 82, High Point 83 ──
  // ── R32 Sat Mar 22 — Arkansas 94, High Point 88 ──
  // High Point eliminated in R32 — final totals:
  "Rob Martin":        53,   // HP (23 R64 + 30 R32) ELIM
  "Cam'Ron Fletcher":  39,   // HP (25 R64 vs Wisconsin + 14 R32 vs Arkansas) ELIM
  "Terry Anderson":    30,   // HP (15 R64 + 15 R32) ELIM
  "Austin Rapp":       12,   // Wisc (12 R64 vs High Point) ELIM
  "Acaden Lewis":           7,  // Villanova (7 R64 vs Utah State) ELIM
  "Duke Brennan":          15,  // Villanova (15 R64 vs Utah State) ELIM
  "Bryce Lindsay":         25,  // Villanova (25 R64 vs Utah State) ELIM
  "Tyler Perkins":         15,  // Villanova (15 R64 vs Utah State) ELIM
  "Braeden Carrington":       5,  // Wisc (5 R64 vs High Point) ELIM,   // HP ( 5 R64 +  3 R32) ELIM
  "Nick Boyd":         27,   // HP (27 R64 +  0 R32) ELIM
  "John Blackwell":    22,   // HP (22 R64 +  0 R32) ELIM
  "Nolan Winter":       8,   // Wisconsin (R64 elim)

  // ── R64 Thu Mar 19 — Arkansas 97, Hawaii 78 ──
  // ── R32 Sat Mar 22 — Arkansas 94, High Point 88 ──
  "Dre Bullock":       21,   // Hawaii (eliminated R64)
  "Trevon Brazile":    34,   // Arkansas (19 R64 +  8 R32)
  "D.J. Wagner":        16,   // Arkansas ( 7 R64 +  2 R32)
  "Billy Richmond III":38,   // Arkansas (10 R64 + 15 R32)
  "Malique Ewin":      38,   // Arkansas (16 R64 + 14 R32)
  "Darius Acuff":      88,   // Arkansas (24 R64 + 36 R32)
  "Meleek Thomas":     57,   // Arkansas (21 R64 + 19 R32)

  // ── R64 Thu Mar 19 — Illinois 105, Penn 70 ──
  // ── R32 Sat Mar 22 — Illinois 76, VCU 55 ──
  "David Mirkovic":    50,   // Illinois (29 R64 +  7 R32)
  "Ben Humrichous":        18,  // Illinois (12 R64 vs Penn + 3 R32 vs VCU)
  "Keaton Wagler":     45,   // Illinois (18 R64 + 14 R32)
  "Kylan Boswell":     31,   // Illinois (13 R64 + 12 R32)
  "Tomislav Ivisic":   35,   // Illinois (14 R64 vs Penn + 12 R32 vs VCU)
  "Andrej Stojakovic": 43,   // Illinois (9 R64 vs Penn + 21 R32 vs VCU)
  "Zvonimir Ivisic":    10,   // Illinois ( 6 R64 +  2 R32)
  "TJ Power":           6,   // Penn (eliminated R64)
  // VCU eliminated in R32 — final totals:
  "Terrence Hill Jr.": 51,   // VCU (34 R64 + 17 R32) ELIM
  "Jadrian Tracey":         7,  // VCU (7 R32 vs Illinois) ELIM
  "B.J. Edwards":           0,  // SMU (0 pts FF vs Miami OH) ELIM
  "Terrence Hill":         51,  // VCU (17 R64 vs N Carolina + 34 R32 vs Illinois) ELIM
  "Lazar Djokovic":    17,   // VCU (15 R64 vs N Carolina + 2 R32 vs Illinois) ELIM
  "Henri Veesaar":     26,   // UNC (eliminated R64)
  "Seth Trimble":      15,   // UNC (eliminated R64)
  "Derek Dixon":       11,   // UNC (eliminated R64)
  "Jarin Stevenson":   11,   // UNC (eliminated R64)
  "Luka Bogavac":       8,   // UNC (eliminated R64)

  // ── R64 Thu Mar 19 — Michigan St 92, N. Dakota St 67 ──
  // ── R32 Sat Mar 22 — Michigan St 77, Louisville 69 ──
  "Carson Cooper":     43,   // Mich St (20 R64 +  9 R32)
  "Coen Carr":         51,   // Mich St (17 R64 + 21 R32)
  "Jaxon Kohler":      34,   // Mich St (12 R64 + 10 R32)
  "Jeremy Fears":      19,   // Mich St ( 7 R64 + 12 R32)
  "Jordan Scott":      15,   // Mich St ( 6 R64 +  4 R32)
  "Kur Teng":          10,   // Mich St ( 3 R64 +  7 R32)
  // Louisville eliminated in R32 — final totals:
  "Isaac McKneely":    32,   // Louisville (23 R64 +  9 R32) ELIM
  "Ryan Conwell":      39,   // Louisville (18 R64 + 21 R32) ELIM
  "J'Vonne Hadley":    12,   // Louisville (10 R64 +  2 R32) ELIM
  "Paulius Murauskas":  4,   // Louisville ( 4 R64 +  0 R32) ELIM
  "Joshua Dent":       18,   // Saint Marys (eliminated R64)
  "Mikey Lewis":        5,   // Saint Marys (eliminated R64)
  "Izaiyah Nelson":    22,   // So Florida (eliminated R64)
  "Joseph Pinion":     27,   // So Florida (eliminated R64)
  "Wes Enis":           4,   // So Florida (eliminated R64)
  "Joseph Omojafo":     6,   // So Florida (eliminated R64)

  // ── R64 Thu Mar 19 — Saint Louis 102, Georgia 77 ──
  // ── R32 Sat Mar 22 — Michigan 95, Saint Louis 72 ──
  // Saint Louis eliminated in R32 — final totals:
  "Robbie Avila":      21,   // St Louis (9 R64 vs Georgia + 12 R32 vs Michigan) ELIM
  "Jeremiah Wilkinson":30,   // Georgia (eliminated R64)
  "Marcus Millender":  13,   // Georgia (eliminated R64)
  "Blue Cain":          6,   // Georgia (eliminated R64)

  // ── R64 Thu Mar 19 — Michigan 101, Howard 80 ──
  // ── R32 Sat Mar 22 — Michigan 95, Saint Louis 72 ──
  "Yaxel Lendeborg":   57,   // Michigan
  "Morez Johnson":     36,   // Michigan (15 R64 vs Howard + 21 R32 vs St Louis)
  "Aday Mara":         43,   // Michigan (19 R64 vs Howard + 16 R32 vs St Louis)
  "Elliot Cadeau":     34,   // Michigan (5 R64 vs Howard + 12 R32 vs St Louis)
  "Nimari Burnett":    28,   // Michigan (11 R64 vs Howard + 15 R32 vs St Louis)
  "Will Tschetter":     8,   // Michigan (2 R64 vs Howard + 6 R32 vs St Louis)
  "Roddy Gayle Jr.":   17,   // Michigan (14 R64 vs Howard +  3 R32 vs St Louis)
  "Roddy Gale":          33,   // Michigan — alias for Roddy Gayle Jr. (roster spelling)
  "Trey McKenney":     35,   // Michigan (10 R64 vs Howard + 8 R32 vs St Louis)
  "Cedric Taylor":     19,   // Howard (eliminated R64)

  // ── R64 Thu Mar 19 — Houston 78, Idaho 47 ──
  // ── R32 Sat Mar 22 — Houston 88, Texas A&M 57 ──
  "Kingston Flemings": 38,   // Houston (18 R64 +  9 R32)
  "Emanuel Sharp":     51,   // Houston (16 R64 + 18 R32)
  "Joseph Tugler":     25,   // Houston (13 R64 +  6 R32)
  "Milos Uzan":        33,   // Houston (12 R64 + 15 R32)
  "Chris Cenac Jr.":   24,   // Houston ( 7 R64 + 17 R32)
  "Chris Cenac":       30,   // Houston — alias for Chris Cenac Jr. (roster spelling)
  "Chase McCarty":      17,   // Houston ( 2 R64 +  6 R32)
  "Mercy Miller":       22,  // Houston (10 R64 vs Idaho + 12 R32 vs Texas A&M)
  // Texas A&M eliminated in R32 — final totals:
  "Marcus Hill":         4,   // Texas A&M (4 R64 vs St Marys + 0 R32 vs Houston) ELIM
  "Pop Isaacs":         11,   // Texas A&M (3 R64 vs St Marys + 8 R32 vs Houston) ELIM
  "Rashaun Agee":      29,   // Texas A&M (22 R64 +  7 R32) ELIM
  "Rylan Griffen":     10,   // Texas A&M (4 R64 vs St Marys + 6 R32 vs Houston) ELIM

  // ── R64 Thu Mar 19 — Gonzaga 73, Kennesaw St 64 ──
  // ── R32 Sat Mar 22 — Texas 74, Gonzaga 68 ──
  // Gonzaga eliminated in R32 — final totals:
  "Graham Ike":        44,   // Gonzaga (19 R64 + 25 R32) ELIM
  "Davis Fogle":       23,   // Gonzaga (17 R64 +  6 R32) ELIM
  "Braden Huff":         0,  // Gonzaga (0 pts both games) ELIM
  "Tyon Grant-Foster": 16,   // Gonzaga ( 9 R64 +  7 R32) ELIM
  "Mario Saint-Supery":16,   // Gonzaga ( 7 R64 +  9 R32) ELIM
  "Adam Miller":        4,   // Gonzaga ( 2 R64 +  2 R32) ELIM

  // ── R64 Thu Mar 19 — Texas 79, BYU 71 ──
  // ── R32 Sat Mar 22 — Texas 74, Gonzaga 68 ──
  "AJ Dybantsa":       35,   // BYU (eliminated R64)
  "Robert Wright III": 14,   // BYU (eliminated R64)
  "Kennard Davis":      9,   // BYU (eliminated R64)
  // Texas: FF + R64 + R32 cumulative
  "Dailyn Swain":      53,   // Texas (13 FF + 14 R64 + 11 R32)
  "Tramon Mark":       71,   // Texas (17 FF + 19 R64 +  6 R32)
  "Jordan Pope":         45,   // Texas (FF=5 + R64=11 + R32=17)
  "Matas Vokietaitis":   64,   // Texas (FF=0 + R64=44 + R32=17)

  // ── FF + R64 Fri Mar 20 players ──
  "Dontae Horne":      37,   // Prairie View (25 FF + 12 R64 vs Florida) ELIM
  "Tai Reon Joseph":   21,   // Prairie View ( 5 FF + 16 R64 vs Florida) ELIM
  "Eian Elmer":        27,   // Miami OH (23 FF + 4 R64 vs Tennessee) ELIM
  "Brant Byers":       28,   // Miami OH (19 FF + 9 R64 vs Tennessee) ELIM
  "Peter Suder":       34,   // Miami OH ( 7 FF + 27 R64 vs Tennessee) ELIM

  // ══ R32 SUN Mar 23 — All confirmed stats ══
  // Overrides.json was empty (auto-save bug fixed now)
  // All entries below are R64 + R32 cumulative totals

  // ── Previously missing players — confirmed from session notes ──
  "Travis Harper II":      13,  // Tenn St (13 R64 vs Iowa State) ELIM
  "Aaron Nkrumah":         21,  // Tenn St (21 R64 vs Iowa St) ELIM — box score needed to verify
  "Tavari Johnson":        4,  // Akron (4 R64 vs Texas Tech) ELIM
  "Shammah Scott":         20,  // Akron (20 R64 vs Texas Tech) ELIM
  "Amani Lyles":           26,  // Akron (26 R64 vs Texas Tech) ELIM — from session recap
  // NOTE: Preston Edmead (Hofstra), J.P. Estrella (Tenn), Sam Lewis (Virginia)
  // need box scores — set to 0 until confirmed (auto-save would have missed them)

    // ── Sun Mar 23 — Arizona 78, Utah State 66 ── (Arizona advancing)
  "MJ Collins":           32,  // Utah St (20 R64 vs Villanova + 12 R32 vs Arizona) ELIM
  "Mason Falslev":        30,  // Utah St (22 R64 vs Villanova + 8 R32 vs Arizona) ELIM
  "Dwayne Aristode":        7,  // Arizona (4 R64 vs LIU + 3 R32 vs Utah State)
  "Anthony Dell'Orso":      19,  // Arizona (3 R64 vs LIU + 8 R32 vs Utah State)
  "Tobe Awaka":            29,  // Arizona (11 R64 vs LIU + 4 R32 vs Utah State)
  "Ivan Kharchenkov":     38,  // Arizona (14 R64 vs LIU + 9 R32 vs Utah State)
  "Themus Fulks":          10,  // UCF (10 R64 vs UCLA) ELIM
  "Riley Kugel":          13,  // UCF (13 R64 vs UCLA) ELIM
  "Jordan Burks":         22,  // UCF (22 R64 vs UCLA) ELIM
  "Koa Peat":              50,  // Arizona (15 R64 + 14 R32)
  "Brayden Burries":       57,  // Arizona (18 R64 + 16 R32)  [also in averages block, no conflict]
  "Jaden Bradley":         39,  // Arizona ( 7 R64 + 18 R32)
  "Motiejus Krivas":       34,  // Arizona ( 9 R64 + 11 R32)

  // ── Sun Mar 23 — Purdue 79, Miami FL 69 ── (Purdue advancing)
  "Braden Smith":         54,  // Purdue (26 R64 vs Queens + 12 R32 vs Miami FL)
  "Oscar Cluff":          28,  // Purdue (9 R64 vs Queens + 8 R32 vs Miami FL)
  "C.J. Cox":              32,  // Purdue (11 R64 vs Queens + 11 R32 vs Miami FL)
  "Omer Mayer":            11,  // Purdue (9 R64 vs Queens + 0 R32 vs Miami FL)
  "Daniel Jacobsen":       4,  // Purdue (4 R64 vs Queens + 0 R32 vs Miami FL)
  "Fletcher Loyer":        56,  // Purdue (14 R64 vs Queens + 24 R32 vs Miami FL)
  "Trey Kaufman-Renn":     64,  // Purdue (25 R64 vs Queens + 19 R32 vs Miami FL)
  "Malik Reneau":          40,  // Miami FL (24 R64 vs Missouri + 16 R32 vs Purdue) ELIM
  "Shelton Henderson":     33,  // Miami FL (18 R64 vs Missouri + 15 R32 vs Purdue) ELIM
  "Tre Donaldson":         30,  // Miami FL (17 R64 vs Missouri + 13 R32 vs Purdue) ELIM
  "Tru Washington":        20,  // Miami FL (9 R64 vs Missouri + 11 R32 vs Purdue) ELIM

  // ── Sun Mar 23 — St. John's 67, Kansas 65 ── (St Johns advancing)
  "Zuby Ejiofor":          49,  // St Johns (14 R64 vs N Iowa + 18 R32 vs Kansas)
  "Bryce Hopkins":         46,  // St Johns (18 R64 vs N Iowa + 13 R32 vs Kansas)
  "Ian Jackson":           24,  // St Johns (9 R64 vs N Iowa + 10 R32 vs Kansas)
  "Dillon Mitchell":       28,  // St Johns (7 R64 vs N Iowa + 8 R32 vs Kansas)
  "Oziyah Sellers":        19,  // St Johns (11 R64 vs N Iowa + 3 R32 vs Kansas) (11 R64 vs N Iowa + 0 R32 vs Kansas)
  "Joson Sanon":            9,  // St Johns (6 R64 vs N Iowa + 3 R32 vs Kansas)
  "Dylan Darling":          16,  // St Johns (6 R64 vs N Iowa + 2 R32 vs Kansas)
  // Kansas eliminated — final totals:
  "Darryn Peterson":       49,  // Kansas (28 R64 vs Cal Baptist + 21 R32) ELIM
  "Dominique Daniels":    25,  // Cal Baptist (25 R64 vs Kansas) ELIM
  "Melvin Council Jr.":    19,  // Kansas (4 R64 vs Cal Baptist + 15 R32 vs St John's) ELIM
  "Flory Bidunga":         18,  // Kansas (12 R64 vs Cal Baptist + 6 R32 vs St John's) ELIM
  "Tre White":             16,  // Kansas (4 R64 vs Cal Baptist + 12 R32 vs St John's) ELIM
  "Bryson Tiller":          6,  // Kansas (6 R64 vs Cal Baptist + 0 R32 vs St John's) ELIM (R64+R32 DNP/0) ELIM

  // ── Sun Mar 23 — UConn 73, UCLA 57 ── (UConn advancing)
  "Silas Demary":           2,  // UConn (2 R32 vs UCLA)
  "Braylon Mullins":      37,  // UConn (12 R64 vs Furman + 17 R32 vs UCLA)
  "Eric Reibe":            4,  // UConn (4 R32 vs UCLA)
  "Solo Ball":             21,  // UConn (9 R64 vs Furman + 0 R32 vs UCLA)
  "Tarris Reed Jr.":      61,  // UConn (31 R64 vs Furman + 10 R32 vs UCLA)
  "Alex Wilkins":          21,  // Furman (21 R64 vs UConn) ELIM
  "Cole Bowser":            9,  // Furman (9 R64 vs UConn) ELIM
  "Alex Karaban":          66,  // UConn (22 R64 vs Furman + 27 R32)
  // UCLA eliminated — final totals:
  "Eric Dailey":           32,  // UCLA (20 R64 vs UCF + 12 R32) ELIM
  "Skyy Clark":            19,  // UCLA (8 R64 vs UCF + 11 R32 vs UConn) ELIM
  "Donovan Dent":          21,  // UCLA (10 R64 vs UCF + 11 R32 vs UConn) ELIM
  "Tyler Bilodeau":         0,  // UCLA (out injury R32) ELIM
  "Trent Perry":           20,  // UCLA (15 R64 vs UCF + 5 R32 vs UConn) ELIM
  "Xavier Booker":         28,  // UCLA (15 R64 vs UCF + 13 R32 vs UConn) ELIM

  // ── Sun Mar 23 — Iowa State 82, Kentucky 63 ── (Iowa State advancing)
  "Jamarion Batemon":      13,  // Iowa St (8 R64 vs Tenn St + 3 R32 vs Kentucky)
  "Blake Buchanan":       28,  // Iowa St (11 R64 vs Tenn St + 9 R32 vs Kentucky)
  "Joshua Jefferson":      2,  // Iowa St (2 R64 vs Tenn St + 0 R32 vs Kentucky) ELIM
  "Ace Buckner":            5,  // Clemson (5 R64 vs Iowa) ELIM
  "RJ Godfrey":            15,  // Clemson (15 R64 vs Iowa) ELIM
  "Jayden Stone":          21,  // Missouri (21 R64 vs Miami FL) ELIM
  "Mark Mitchell":         19,  // Missouri (19 R64 vs Miami FL) ELIM
  "Tamin Lipsey":          47,  // Iowa St (3 R64 vs Tenn St + 26 R32 vs Kentucky)
  "Milan Momcilovic":      43,  // Iowa St (17 R64 vs Tenn St + 20 R32 vs Kentucky)
  "Nate Heise":            52,  // Iowa St (22 R64 + 12 R32)
  "Killyan Toure":         44,  // Iowa St (25 R64 + 10 R32)
  // Kentucky eliminated — final totals:
  "Christin Hammond":       9,  // Santa Clara (9 R64 vs Kentucky) ELIM
  "Otega Oweh":            53,  // Kentucky (35 R64 vs Santa Clara OT + 18 R32 vs Iowa St) ELIM
  "Elijah Mahi":           20,  // Santa Clara (20 R64 vs Kentucky) ELIM
  "Malachi Moreno":          7,  // Kentucky (3 R64 vs Santa Clara + 4 R32 vs Iowa St) ELIM (4 R64 vs Santa Clara + 0 R32) ELIM
  "Collin Chandler":       11,  // Kentucky (5 R64 vs Santa Clara + 6 R32 vs Iowa St) ELIM
  "Mouhamed Dioubate":     21,  // Kentucky (17 R64 vs Santa Clara + 4 R32 vs Iowa St) ELIM
  "Denzel Aberdeen":       36,  // Kentucky (16 R64 vs Santa Clara + 20 R32 vs Iowa St) ELIM

  // ── Sun Mar 23 — Tennessee 79, Virginia 72 ── (Tennessee advancing)
  "Nate Ament":            34,  // Tennessee (0 R64 vs Miami OH + 16 R32 vs Virginia)
  "Felix Okpara":          31,  // Tennessee (12 R64 vs Miami OH + 7 R32 vs Virginia)
  "Bishop Boswell":        18,  // Tennessee (5 R64 vs Miami OH + 13 R32 vs Virginia)
  "Jaylen Carey":          10,  // Tennessee (0 R64 vs Miami OH + 10 R32 vs Virginia)
  "Ja'Kobi Gillespie":     66,  // Tennessee (29 R64 vs Miami OH + 21 R32)
  // Virginia eliminated — final totals:
  "Tavion Banks":         28,  // Iowa (6 R64 vs Clemson + 20 R32 vs Florida)
  "Bennett Stirtz":       31,  // Iowa (16 R64 vs Clemson + 13 R32 vs Florida)
  "Cooper Koch":          31,  // Iowa (8 R64 vs Clemson + 12 R32 vs Florida)
  "Michael Cooper":       13,  // Wright St (13 R64 vs Virginia) ELIM
  "TJ Burch":             15,  // Wright St (15 R64 vs Virginia) ELIM
  "Sam Lewis":            17,  // Virginia (12 R64 vs Wright St + 5 R32 vs Tennessee) ELIM
  "Cruz Davis":           14,  // Hofstra (14 R64 vs Alabama) ELIM
  "Preston Edmead":       24,  // Hofstra (24 R64 vs Alabama) ELIM
  "J.P. Estrella":        30,  // Tennessee (14 R64 vs Miami OH + 10 R32 vs Virginia)
  "Thijs De Ridder":       32,  // Virginia (10 R64 vs Wright St + 22 R32 vs Tennessee) ELIM
  "Chance Mallory":        12,  // Virginia (2 R64 vs Wright St + 10 R32 vs Tennessee) ELIM
  "Malik Thomas":          23,  // Virginia (11 R64 vs Wright St + 12 R32 vs Tennessee) ELIM
  "Ugonna Onyenso":         6,  // Virginia (2 R64 vs Wright St + 4 R32 vs Tennessee) ELIM
  "Jacari White":          36,  // Virginia (26 R64 vs Wright St + 10 R32 vs Tennessee) ELIM
  "Dallin Hall":           15,  // Virginia (8 R64 vs Wright St + 7 R32 vs Tennessee) ELIM

  // ── Sun Mar 23 — Iowa 73, Florida 72 (UPSET) ── (Iowa advancing)
  // Florida eliminated — final totals (R64 + R32):
  "Alex Condon":           34,  // Florida (13 R64 vs Prairie View + 21 R32 vs Iowa) ELIM
  "Thomas Haugh":          33,  // Florida (14 R64 vs Prairie View + 19 R32 vs Iowa) ELIM
  "Xaivian Lee":           27,  // Florida (10 R64 vs Prairie View + 17 R32 vs Iowa) ELIM
  "Boogie Fland":          23,  // Florida (16 R64 vs Prairie View + 7 R32 vs Iowa) ELIM
  "Rueben Chinyelu":       14,  // Florida (14 R64 vs Prairie View + 0 R32 vs Iowa) ELIM
  "Urban Klavzar":         16,  // Florida (11 R64 vs Prairie View + 5 R32 vs Iowa) ELIM
  "Micah Handlogten":      10,  // Florida (10 R64 vs Prairie View + 0 R32 vs Iowa) ELIM
  "Isaiah Brown":          10,  // Florida ( 7 R64 vs Prairie View + 3 R32 vs Iowa) ELIM

  // ── Sun Mar 23 — Alabama 90, Texas Tech 65 ── (Alabama advancing)
  "Amari Allen":           27,  // Alabama (11 R64 vs Hofstra + 12 R32 vs Texas Tech)
  "Aiden Sherrell":        35,  // Alabama (15 R64 vs Hofstra + 10 R32 vs Texas Tech)
  "Labaron Philon":        38,  // Alabama (29 R64 vs Hofstra + 9 R32 vs Texas Tech)
  "Latrell Wrightsell":    50,  // Alabama (11 R64 vs Hofstra + 24 R32 vs Texas Tech)
  // Texas Tech eliminated:
  "Jaylen Petty":          33,  // Tx Tech (24 R64 vs Akron + 9 R32 vs Alabama) ELIM
  "Christian Anderson":    25,  // Tx Tech (18 R64 vs Akron + 7 R32 vs Alabama) ELIM
  "Donovan Atwell":        27,  // Tx Tech (15 R64 vs Akron + 12 R32 vs Alabama) ELIM
  "LeJuan Watts":          30,  // Tx Tech (14 R64 vs Akron + 16 R32 vs Alabama) ELIM
};

// ── VERIFIED CORRECT TOTALS (locked after R32, Mar 24 2026) ──
// Do NOT modify HARDCODED_OVERRIDES values below without updating this.
const VERIFIED_R32_TOTALS = {
  "Money Bross": 312,
  "Itchy Ron": 224,
  "Studio K": 270,
  "One Putt": 281,
  "Committee": 332,
  "One Legler Up": 346,
  "Team P": 255,
  "Super Suresh": 189,
  "Pit Bulls": 336,
  "Kelly Heroes": 304,
  "Team McCarty": 427,
  "Morley Brothers": 280,
  "The Prophecy": 254,
  "Shy Ballers": 393,
  "Old School": 324,
  "All World": 323,
  "Nutty Professor": 282,
};

const VERIFIED_R32_PLAYERS = {
  'Jeremy Fears': 19,
  'Darryn Peterson': 49,
  'Cayden Boozer': 28,
  'Jaxon Kohler': 22,
  'Coen Carr': 38,
  'Jaron Pierre Jr.': 18,
  'MJ Collins': 32,
  'AK Okereke': 16,
  'David Punch': 20,
  'Rashaun Agee': 29,
  'Davis Fogle': 23,
  'Thomas Dowd': 4,
  'Daniel Jacobsen': 4,
  'Marcus Hill': 4,
  'Joseph Omojafo': 6,
  'Cameron Boozer': 41,
  'Ivan Kharchenkov': 23,
  'Duke Miles': 22,
  'Oscar Cluff': 17,
  'Wes Enis': 4,
  'Paulius Murauskas': 4,
  'Blake Buchanan': 20,
  'Jaylen Petty': 33,
  'Cooper Koch': 20,
  'Cruz Davis': 14,
  'TJ Burch': 15,
  'Pop Isaacs': 11,
  'Zuby Ejiofor': 32,
  'Thijs De Ridder': 32,
  'Bryce Hopkins': 31,
  'Seth Trimble': 15,
  'Oziyah Sellers': 14,
  'Dillon Mitchell': 15,
  'Ian Jackson': 19,
  'Jacari White': 36,
  'Devin McGlockton': 15,
  'Ugonna Onyenso': 6,
  'Braeden Carrington': 5,
  'Dallin Hall': 15,
  'Jamarques Lawrence': 22,
  'Michael Cooper': 13,
  'Kingston Flemings': 27,
  'Boogie Fland': 23,
  'Trevon Brazile': 27,
  'Braylon Mullins': 29,
  'Latrell Wrightsell': 35,
  'D.J. Wagner': 9,
  'Izaiyah Nelson': 22,
  'Tru Washington': 20,
  'Tramon Mark': 42,
  'Jalen Washington': 10,
  'Chase McCarty': 8,
  'Jordan Scott': 10,
  'Felix Okpara': 19,
  'Alex Condon': 34,
  'Fletcher Loyer': 38,
  'Christian Anderson': 25,
  'Milos Uzan': 27,
  'Trey McKenney': 18,
  'C.J. Cox': 22,
  'Nasir Whitlock': 5,
  'Rienk Mast': 24,
  'Xavier Edmonds': 28,
  'Jordan Pope': 33,
  'Duke Brennan': 15,
  'Derek Dixon': 11,
  'Rylan Griffen': 10,
  'Mouhamed Dioubate': 21,
  'Dre Bullock': 21,
  'Yaxel Lendeborg': 34,
  'Solo Ball': 9,
  'Tarris Reed Jr.': 41,
  'Ja\'Kobi Gillespie': 50,
  'Malik Reneau': 40,
  'Flory Bidunga': 18,
  'Amari Allen': 23,
  'Mason Falslev': 30,
  'Blue Cain': 6,
  'Skyy Clark': 19,
  'Acaden Lewis': 7,
  'Braden Frager': 28,
  'Collin Chandler': 11,
  'Adam Miller': 4,
  'Tavion Banks': 26,
  'Thomas Haugh': 33,
  'Alex Karaban': 49,
  'Malik Thomas': 23,
  'Motiejus Krivas': 20,
  'Chris Cenac': 24,
  'Tavari Johnson': 4,
  'Nikolas Khamenia': 9,
  'Chance Mallory': 12,
  'Mario Saint-Supery': 16,
  'Austin Rapp': 12,
  'Bryson Tiller': 6,
  'Omer Mayer': 9,
  'Isaiah Brown': 10,
  'Xavier Booker': 28,
  'Brayden Burries': 34,
  'Xaivian Lee': 27,
  'Boopie Miller': 15,
  'Ace Buckner': 5,
  'Urban Klavzar': 16,
  'Aiden Sherrell': 25,
  'Kur Teng': 10,
  'Sam Hoiberg': 12,
  'Cedric Taylor': 19,
  'Kennard Davis': 9,
  'Dwayne Aristode': 7,
  'Micah Handlogten': 10,
  'Isaiah Evans': 33,
  'Trey Kaufman-Renn': 44,
  'Andrej Stojakovic': 30,
  'Nate Ament': 16,
  'Robert Wright III': 14,
  'Donovan Atwell': 27,
  'Donovan Dent': 21,
  'Nolan Winter': 8,
  'Jayden Stone': 21,
  'Marcus Millender': 13,
  'Jamarion Batemon': 11,
  'Victor Valdes': 14,
  'Alex Wilkins': 21,
  'Eian Elmer': 27,
  'Micah Robinson': 36,
  'Jaden Bradley': 25,
  'Elliot Cadeau': 17,
  'Rueben Chinyelu': 14,
  'Kylan Boswell': 25,
  'Tobe Awaka': 15,
  'Roddy Gale': 17,
  'Tre Donaldson': 30,
  'Dominique Daniels': 25,
  'Devin Royal': 14,
  'Larry Johnson': 15,
  'Rob Martin': 53,
  'Tyshawn Archie': 13,
  'Zvonimir Ivisic': 8,
  'Shammah Scott': 20,
  'Travis Harper II': 13,
  'Koa Peat': 29,
  'Tyler Tanner': 53,
  'David Mirkovic': 36,
  'Joseph Tugler': 19,
  'Carson Cooper': 29,
  'Sam Lewis': 17,
  'Dailyn Swain': 38,
  'Dontae Horne': 37,
  'Dame Sarr': 19,
  'Eric Dailey': 32,
  'Amani Lyles': 26,
  'Preston Edmead': 24,
  'J.P. Estrella': 24,
  'Hank Alvey': 23,
  'Aaron Nkrumah': 21,
  'Morez Johnson': 36,
  'Aday Mara': 35,
  'Billy Richmond III': 25,
  'Nimari Burnett': 26,
  'Henri Veesaar': 26,
  'Malique Ewin': 30,
  'Corey Washington': 13,
  'Joson Sanon': 9,
  'Christin Hammond': 9,
  'Themus Fulks': 10,
  'Terry Anderson': 30,
  'Samet Yigitoglu': 8,
  'RJ Godfrey': 15,
  'Will Tschetter': 8,
  'Darius Acuff': 60,
  'Braden Smith': 38,
  'Maliq Brown': 18,
  'Bennett Stirtz': 29,
  'Tre White': 16,
  'J\'Vonne Hadley': 12,
  'Killyan Toure': 35,
  'Eric Reibe': 4,
  'Luka Bogavac': 8,
  'Nate Heise': 34,
  'Milan Momcilovic': 37,
  'Graham Ike': 44,
  'Ryan Conwell': 39,
  'Silas Demary': 2,
  'Tyler Nickel': 28,
  'Tyon Grant-Foster': 16,
  'LeJuan Watts': 30,
  'Matas Vokietaitis': 55,
  'Tomislav Ivisic': 26,
  'Isaac McKneely': 32,
  'Jordan Burks': 22,
  'Tai Reon Joseph': 21,
  'Elijah Mahi': 20,
  'Gavin Doty': 21,
  'AJ Dybantsa': 35,
  'Emanuel Sharp': 34,
  'Nick Boyd': 27,
  'Jeremiah Wilkinson': 30,
  'Otega Oweh': 53,
  'Melvin Council Jr.': 19,
  'Terrence Hill': 51,
  'Tyler Perkins': 15,
  'Riley Kugel': 13,
  'Lazar Djokovic': 17,
  'TJ Power': 6,
  'Jadrian Tracey': 7,
  'Jayden Pierre': 8,
  'Cole Bowser': 9,
  'Joshua Jefferson': 2,
  'Tamin Lipsey': 29,
  'Meleek Thomas': 40,
  'Pryce Sandfort': 38,
  'Malachi Moreno': 7,
  'John Mobley Jr.': 15,
  'Joshua Dent': 18,
  'Shelton Henderson': 33,
  'Amare Bynum': 12,
  'Joseph Pinion': 27,
  'Christoph Tilly': 10,
  'Brant Byers': 28,
  'Bryce Lindsay': 25,
  'Cam\'Ron Fletcher': 39,
  'Keaton Wagler': 32,
  'Labaron Philon': 38,
  'John Blackwell': 22,
  'Anthony Dell\'Orso': 11,
  'Bruce Thornton': 10,
  'Mark Mitchell': 19,
  'Mikey Lewis': 5,
  'Trent Perry': 20,
  'Denzel Aberdeen': 36,
  'Robbie Avila': 21,
  'Peter Suder': 34,
  'Jarin Stevenson': 11,
  'Dylan Darling': 8,
  'Liutauras Lelevicius': 5,
  'Javohn Garcia': 10,
};


// ════════════════════════════════════════════════════════
//  GAME_LOG — per-player, per-game point history
//  Format: { "Player Name": [ {round, opp, pts}, ... ] }
//  Rounds: "FF"=First Four, "R64", "R32", "S16", "E8", "F4", "NC"
//  Updated manually after each round (box scores only)
// ════════════════════════════════════════════════════════
const GAME_LOG = {
  // ── FIRST FOUR ──
  "Dontae Horne":         [{ round:"FF",  opp:"SMU",         pts:25 }],
  "Tai Reon Joseph":      [{ round:"FF",  opp:"SMU",         pts:5  }],
  "Eian Elmer":           [{ round:"FF",  opp:"SMU",         pts:23 }],
  "Brant Byers":          [{ round:"FF",  opp:"SMU",         pts:19 }],
  "Peter Suder":          [{ round:"FF",  opp:"SMU",         pts:7  }],

  // ── ROUND OF 64 ──
  // Duke
  "Gavin Doty":           [{ round:"R64", opp:"Duke",        pts:21 }],
  "Cameron Boozer":       [{ round:"R64", opp:"Siena",       pts:22 }, { round:"R32", opp:"TCU",          pts:19 }],
  "Cayden Boozer":        [{ round:"R64", opp:"Siena",       pts:19 }, { round:"R32", opp:"TCU",          pts:9  }],
  "Isaiah Evans":         [{ round:"R64", opp:"Siena",       pts:16 }, { round:"R32", opp:"TCU",          pts:17 }],
  "Nikolas Khamenia":     [{ round:"R64", opp:"Siena",       pts:3  }, { round:"R32", opp:"TCU",          pts:6  }],
  "Dame Sarr":            [{ round:"R64", opp:"Siena",       pts:5  }, { round:"R32", opp:"TCU",          pts:14 }],
  // TCU (eliminated R32)
  "Micah Robinson":       [{ round:"R64", opp:"Ohio State",  pts:18 }, { round:"R32", opp:"Duke",         pts:18 }],
  "Xavier Edmonds":       [{ round:"R64", opp:"Ohio State",  pts:16 }, { round:"R32", opp:"Duke",         pts:12 }],
  "David Punch":          [{ round:"R64", opp:"Ohio State",  pts:16 }, { round:"R32", opp:"Duke",         pts:4  }],
  "Jayden Pierre":        [{ round:"R64", opp:"Ohio State",  pts:4  }, { round:"R32", opp:"Duke",         pts:4  }],
  "Liutauras Lelevicius": [{ round:"R64", opp:"Ohio State",  pts:4  }, { round:"R32", opp:"Duke",         pts:1  }],
  "RJ Royal":             [{ round:"R64", opp:"Ohio State",  pts:14 }],
  "Vasean Bynum":         [{ round:"R64", opp:"Ohio State",  pts:12 }],
  "Emanuel Mobley":       [{ round:"R64", opp:"Ohio State",  pts:15 }],
  "Tilly Teufel":         [{ round:"R64", opp:"Ohio State",  pts:10 }],
  "Bruce Thornton":       [{ round:"R64", opp:"Ohio State",  pts:10 }],
  // St John's
  "Zuby Ejiofor":         [{ round:"R64", opp:"N Iowa",      pts:14 }, { round:"R32", opp:"Kansas",       pts:18 }],
  "Bryce Hopkins":        [{ round:"R64", opp:"N Iowa",      pts:18 }, { round:"R32", opp:"Kansas",       pts:13 }],
  "Ian Jackson":          [{ round:"R64", opp:"N Iowa",      pts:9  }, { round:"R32", opp:"Kansas",       pts:10 }],
  "Oziyah Sellers":       [{ round:"R64", opp:"N Iowa",      pts:11 }, { round:"R32", opp:"Kansas",       pts:3  }],
  "Dillon Mitchell":      [{ round:"R64", opp:"N Iowa",      pts:7  }, { round:"R32", opp:"Kansas",       pts:8  }],
  "Joson Sanon":          [{ round:"R64", opp:"N Iowa",      pts:6  }, { round:"R32", opp:"Kansas",       pts:3  }],
  "Dylan Darling":        [{ round:"R64", opp:"N Iowa",      pts:6  }, { round:"R32", opp:"Kansas",       pts:2  }],
  // Kansas (eliminated R32)
  "Darryn Peterson":      [{ round:"R64", opp:"Cal Baptist", pts:28 }, { round:"R32", opp:"St John's",   pts:21 }],
  "Melvin Council Jr.":   [{ round:"R64", opp:"Cal Baptist", pts:4  }, { round:"R32", opp:"St John's",   pts:15 }],
  "Flory Bidunga":        [{ round:"R64", opp:"Cal Baptist", pts:12 }, { round:"R32", opp:"St John's",   pts:6  }],
  "Tre White":            [{ round:"R64", opp:"Cal Baptist", pts:4  }, { round:"R32", opp:"St John's",   pts:12 }],
  "Bryson Tiller":        [{ round:"R64", opp:"Cal Baptist", pts:6  }, { round:"R32", opp:"St John's",   pts:0  }],
  // Louisville (eliminated R32)
  "Isaac McKneely":       [{ round:"R64", opp:"So Florida",  pts:23 }, { round:"R32", opp:"Mich St",     pts:9  }],
  "Ryan Conwell":         [{ round:"R64", opp:"So Florida",  pts:16 }, { round:"R32", opp:"Mich St",     pts:23 }],
  "J'Vonne Hadley":       [{ round:"R64", opp:"So Florida",  pts:12 }, { round:"R32", opp:"Mich St",     pts:0  }],
  "Maliq Brown":          [{ round:"R64", opp:"So Florida",  pts:6  }, { round:"R32", opp:"Mich St",     pts:12 }],
  // Michigan St
  "Coen Carr":            [{ round:"R64", opp:"N Dakota St", pts:17 }, { round:"R32", opp:"Louisville",   pts:21 }],
  "Jeremy Fears":         [{ round:"R64", opp:"N Dakota St", pts:7  }, { round:"R32", opp:"Louisville",   pts:12 }],
  "Jaxon Kohler":         [{ round:"R64", opp:"N Dakota St", pts:12 }, { round:"R32", opp:"Louisville",   pts:10 }],
  "Gehrig Normand":       [{ round:"R64", opp:"N Dakota St", pts:6  }, { round:"R32", opp:"Louisville",   pts:4  }],
  "Frankie Fidler":       [{ round:"R64", opp:"N Dakota St", pts:13 }, { round:"R32", opp:"Louisville",   pts:10 }],
  // UCLA (eliminated R32)
  "Eric Dailey":           [{ round:"R64", opp:"UCF",         pts:20 }, { round:"R32", opp:"UConn",        pts:12 }],
  "Skyy Clark":           [{ round:"R64", opp:"UCF",         pts:8  }, { round:"R32", opp:"UConn",        pts:11 }],
  "Donovan Dent":         [{ round:"R64", opp:"UCF",         pts:10 }, { round:"R32", opp:"UConn",        pts:11 }],
  "Tyler Bilodeau":       [{ round:"R64", opp:"UCF",         pts:0  }, { round:"R32", opp:"UConn",        pts:0  }],
  "Trent Perry":          [{ round:"R64", opp:"UCF",         pts:15 }, { round:"R32", opp:"UConn",        pts:5  }],
  "Xavier Booker":        [{ round:"R64", opp:"UCF",         pts:15 }, { round:"R32", opp:"UConn",        pts:13 }],
  // UConn
  "Silas Demary":         [{ round:"R64", opp:"Furman",      pts:0  }, { round:"R32", opp:"UCLA",         pts:2  }],
  "Braylon Mullins":     [{ round:"R64", opp:"Furman",      pts:12 }, { round:"R32", opp:"UCLA",         pts:17 }],
  "Eric Reibe":          [{ round:"R64", opp:"Furman",      pts:0  }, { round:"R32", opp:"UCLA",         pts:4  }],
  "Tarris Reed Jr.":     [{ round:"R64", opp:"Furman",      pts:31 }, { round:"R32", opp:"UCLA",         pts:10 }],
  "Cole Bowser":          [{ round:"R64", opp:"UConn",       pts:9  }],
  "Alex Karaban":         [{ round:"R64", opp:"Furman",      pts:22 }, { round:"R32", opp:"UCLA",         pts:27 }],
  // Arizona
  "MJ Collins":           [{ round:"R64", opp:"Villanova",  pts:20 }, { round:"R32", opp:"Arizona",     pts:12 }],
  "Mason Falslev":        [{ round:"R64", opp:"Villanova",  pts:22 }, { round:"R32", opp:"Arizona",     pts:8  }],
  "Marcus Hill":          [{ round:"R64", opp:"St Mary's",  pts:4  }, { round:"R32", opp:"Houston",     pts:0  }],
  "Anthony Dell'Orso":    [{ round:"R64", opp:"LIU",         pts:3  }, { round:"R32", opp:"Utah State",   pts:8  }, { round:"S16", opp:"Arkansas",   pts:8  }],
  "Tobe Awaka":           [{ round:"R64", opp:"LIU",         pts:11 }, { round:"R32", opp:"Utah State",   pts:4  }, { round:"S16", opp:"Arkansas",   pts:14 }],
  "Dwayne Aristode":      [{ round:"R64", opp:"LIU",         pts:4  }, { round:"R32", opp:"Utah State",   pts:3  }, { round:"S16", opp:"Arkansas",   pts:0  }],
  "Ivan Kharchenkov":    [{ round:"R64", opp:"LIU",         pts:14 }, { round:"R32", opp:"Utah State",   pts:9  }, { round:"S16", opp:"Arkansas",   pts:15 }],
  "Riley Kugel":         [{ round:"R64", opp:"UCLA",        pts:13 }],
  "Jordan Burks":        [{ round:"R64", opp:"UCLA",        pts:22 }],
  "Koa Peat":             [{ round:"R64", opp:"LIU",         pts:15 }, { round:"R32", opp:"Utah State",   pts:14 }, { round:"S16", opp:"Arkansas",   pts:21 }],
  "Brayden Burries":      [{ round:"R64", opp:"LIU",         pts:18 }, { round:"R32", opp:"Utah State",   pts:16 }, { round:"S16", opp:"Arkansas",   pts:23 }],
  "Jaden Bradley":        [{ round:"R64", opp:"LIU",         pts:7  }, { round:"R32", opp:"Utah State",   pts:18 }, { round:"S16", opp:"Arkansas",   pts:14 }],
  "Motiejus Krivas":      [{ round:"R64", opp:"LIU",         pts:9  }, { round:"R32", opp:"Utah State",   pts:11 }, { round:"S16", opp:"Arkansas",   pts:14 }],
  // High Point (eliminated R32)
  "Austin Rapp":          [{ round:"R64", opp:"High Point",  pts:12 }],
  "Bryce Lindsay":        [{ round:"R64", opp:"Utah State",  pts:25 }],
  "Tyler Perkins":        [{ round:"R64", opp:"Utah State",  pts:15 }],
  "Braeden Carrington":   [{ round:"R64", opp:"High Point",  pts:5  }],
  "Rob Martin":           [{ round:"R64", opp:"Wisconsin",   pts:23 }, { round:"R32", opp:"Arkansas",     pts:30 }],
  "Cam'Ron Fletcher":     [{ round:"R64", opp:"Wisconsin",   pts:25 }, { round:"R32", opp:"Arkansas",     pts:14 }],
  "Terry Anderson":       [{ round:"R64", opp:"Wisconsin",   pts:30 }, { round:"R32", opp:"Arkansas",     pts:0  }],
  // Arkansas
  "Darius Acuff":         [{ round:"R64", opp:"Hawaii",      pts:26 }, { round:"R32", opp:"High Point",   pts:34 }, { round:"S16", opp:"Arizona",    pts:28 }],
  "Adou Thiero":          [{ round:"R64", opp:"Hawaii",      pts:15 }, { round:"R32", opp:"High Point",   pts:25 }],
  "Johnell Davis":        [{ round:"R64", opp:"Hawaii",      pts:35 }, { round:"R32", opp:"High Point",   pts:25 }],
  "Jonas Aidoo":          [{ round:"R64", opp:"Hawaii",      pts:0  }, { round:"R32", opp:"High Point",   pts:30 }],
  "Billy Richmond III":   [{ round:"R64", opp:"Hawaii",      pts:25 }, { round:"R32", opp:"High Point",   pts:0  }, { round:"S16", opp:"Arizona",    pts:13 }],
  // Texas
  "Tre Johnson":          [{ round:"FF",  opp:"NC State",    pts:0  }, { round:"R64", opp:"BYU",          pts:33 }, { round:"R32", opp:"Gonzaga",     pts:5  }],
  "Ze'Rik Onyema":        [{ round:"FF",  opp:"NC State",    pts:0  }, { round:"R64", opp:"BYU",          pts:42 }, { round:"R32", opp:"Gonzaga",     pts:0  }],
  "Jordan Pope":          [{ round:"FF",  opp:"NC State",    pts:5  }, { round:"R64", opp:"BYU",          pts:11 }, { round:"R32", opp:"Gonzaga",     pts:17 }, { round:"S16", opp:"Purdue",     pts:12 }],
  "Kolin Sheppard":       [{ round:"FF",  opp:"NC State",    pts:0  }, { round:"R64", opp:"BYU",          pts:55 }, { round:"R32", opp:"Gonzaga",     pts:0  }],
  // Gonzaga (eliminated R32)
  "Graham Ike":           [{ round:"R64", opp:"Kennesaw St", pts:19 }, { round:"R32", opp:"Texas",        pts:25 }],
  "Davis Fogle":          [{ round:"R64", opp:"Kennesaw St", pts:17 }, { round:"R32", opp:"Texas",        pts:6  }],
  "Adam Miller":          [{ round:"R64", opp:"Kennesaw St", pts:2  }, { round:"R32", opp:"Texas",        pts:2  }],
  "Tyon Grant-Foster":    [{ round:"R64", opp:"Kennesaw St", pts:9  }, { round:"R32", opp:"Texas",        pts:7  }],
  "Mario Saint-Supery":   [{ round:"R64", opp:"Kennesaw St", pts:7  }, { round:"R32", opp:"Texas",        pts:9  }],
  "Braden Huff":          [{ round:"R64", opp:"Kennesaw St", pts:0  }, { round:"R32", opp:"Texas",        pts:0  }],
  // Miami FL (eliminated R32)
  "Malik Reneau":         [{ round:"R64", opp:"Missouri",    pts:24 }, { round:"R32", opp:"Purdue",       pts:16 }],
  "Shelton Henderson":    [{ round:"R64", opp:"Missouri",    pts:15 }, { round:"R32", opp:"Purdue",       pts:18 }],
  "Tre Donaldson":        [{ round:"R64", opp:"Missouri",    pts:17 }, { round:"R32", opp:"Purdue",       pts:13 }],
  "Tru Washington":       [{ round:"R64", opp:"Missouri",    pts:9  }, { round:"R32", opp:"Purdue",       pts:11 }],
  // Purdue — R64 (vs Queens) box score not yet received; R32 confirmed
  "Trey Kaufman-Renn":    [{ round:"R64", opp:"Queens",      pts:25 }, { round:"R32", opp:"Miami FL",     pts:19 }, { round:"S16", opp:"Texas",      pts:20 }],
  "Fletcher Loyer":       [{ round:"R64", opp:"Queens",      pts:14 }, { round:"R32", opp:"Miami FL",     pts:24 }, { round:"S16", opp:"Texas",      pts:18 }],
  // NOTE: Loyer R64 vs Queens unknown — awaiting box score
  // Vanderbilt (eliminated R32)
  "Tyler Tanner":         [{ round:"R64", opp:"McNeese St",  pts:26 }, { round:"R32", opp:"Nebraska",     pts:27 }],
  "Duke Miles":           [{ round:"R64", opp:"McNeese St",  pts:22 }, { round:"R32", opp:"Nebraska",     pts:0  }],
  "Devin McGlockton":     [{ round:"R64", opp:"McNeese St",  pts:15 }, { round:"R32", opp:"Nebraska",     pts:0  }],
  "Jalen Washington":     [{ round:"R64", opp:"McNeese St",  pts:4  }, { round:"R32", opp:"Nebraska",     pts:6  }],
  "AK Okereke":           [{ round:"R64", opp:"McNeese St",  pts:16 }, { round:"R32", opp:"Nebraska",     pts:0  }],
  "Tyler Nickel":         [{ round:"R64", opp:"McNeese St",  pts:12 }, { round:"R32", opp:"Nebraska",     pts:16 }],
  // Nebraska
  "Pryce Sandfort":       [{ round:"R64", opp:"Troy",        pts:23 }, { round:"R32", opp:"Vanderbilt",   pts:15 }, { round:"S16", opp:"Iowa",       pts:25 }],
  "Brice Williams":       [{ round:"R64", opp:"Troy",        pts:22 }, { round:"R32", opp:"Vanderbilt",   pts:0  }],
  "Juwan Gary":           [{ round:"R64", opp:"Troy",        pts:24 }, { round:"R32", opp:"Vanderbilt",   pts:0  }],
  "Sam Hoiberg":          [{ round:"R64", opp:"Troy",        pts:12 }, { round:"R32", opp:"Vanderbilt",   pts:0  }, { round:"S16", opp:"Iowa",       pts:6  }],
  "Braden Frager":        [{ round:"R64", opp:"Troy",        pts:13 }, { round:"R32", opp:"Vanderbilt",   pts:15 }, { round:"S16", opp:"Iowa",       pts:16 }],
  // VCU (eliminated R32)
  "Terrence Hill Jr.":    [{ round:"R64", opp:"N Carolina",  pts:34 }, { round:"R32", opp:"Illinois",     pts:17 }],
  "Jadrian Tracey":       [{ round:"R64", opp:"N Carolina",  pts:0  }, { round:"R32", opp:"Illinois",     pts:7  }],
  "Terrence Hill":        [{ round:"R64", opp:"N Carolina",  pts:17 }, { round:"R32", opp:"Illinois",     pts:34 }],
  "Jarin Stevenson":      [{ round:"R64", opp:"VCU",         pts:11 }],
  "Lazar Djokovic":       [{ round:"R64", opp:"N Carolina",  pts:15 }, { round:"R32", opp:"Illinois",     pts:2  }],
  // Illinois
  "David Mirkovic":       [{ round:"R64", opp:"Penn",        pts:29 }, { round:"R32", opp:"VCU",          pts:7  }, { round:"S16", opp:"Houston",    pts:14 }],
  "Keaton Wagler":        [{ round:"R64", opp:"Penn",        pts:18 }, { round:"R32", opp:"VCU",          pts:14 }, { round:"S16", opp:"Houston",    pts:13 }],
  "Will Riley":           [{ round:"R64", opp:"Penn",        pts:7  }, { round:"R32", opp:"VCU",          pts:11 }],
  "Tomislav Ivisic":      [{ round:"R64", opp:"Penn",        pts:14 }, { round:"R32", opp:"VCU",          pts:12 }, { round:"S16", opp:"Houston",    pts:9  }],
  "Andrej Stojakovic":    [{ round:"R64", opp:"Penn",        pts:9  }, { round:"R32", opp:"VCU",          pts:21 }, { round:"S16", opp:"Houston",    pts:13 }],
  "Zvonimir Ivisic":      [{ round:"R64", opp:"Penn",        pts:8  }, { round:"R32", opp:"VCU",          pts:0  }, { round:"S16", opp:"Houston",    pts:2  }],
  "Ben Humrichous":       [{ round:"R64", opp:"Penn",        pts:12 }, { round:"R32", opp:"VCU",          pts:3  }, { round:"S16", opp:"Houston",    pts:3  }],
  // Texas A&M (eliminated R32)
  "Rashaun Agee":         [{ round:"R64", opp:"St Mary's",   pts:22 }, { round:"R32", opp:"Houston",      pts:7  }],
  "Rylan Griffen":        [{ round:"R64", opp:"St Mary's",   pts:4  }, { round:"R32", opp:"Houston",      pts:6  }],
  // Houston
  "Kingston Flemings":    [{ round:"R64", opp:"Idaho",       pts:18 }, { round:"R32", opp:"Texas A&M",    pts:9  }, { round:"S16", opp:"Illinois",   pts:11 }],
  "Emanuel Sharp":        [{ round:"R64", opp:"Idaho",       pts:16 }, { round:"R32", opp:"Texas A&M",    pts:18 }, { round:"S16", opp:"Illinois",   pts:17 }],
  "L.J. Cryer":           [{ round:"R64", opp:"Idaho",       pts:12 }, { round:"R32", opp:"Texas A&M",    pts:15 }],
  "Milos Uzan":           [{ round:"R64", opp:"Idaho",       pts:12 }, { round:"R32", opp:"Texas A&M",    pts:15 }, { round:"S16", opp:"Illinois",   pts:6  }],
  "Joseph Tugler":        [{ round:"R64", opp:"Idaho",       pts:13 }, { round:"R32", opp:"Texas A&M",    pts:6  }, { round:"S16", opp:"Illinois",   pts:6  }],
  "Chris Cenac Jr.":      [{ round:"R64", opp:"Idaho",       pts:7  }, { round:"R32", opp:"Texas A&M",    pts:17 }],
  "Chris Cenac":          [{ round:"R64", opp:"Idaho",       pts:7  }, { round:"R32", opp:"Texas A&M",    pts:17 }, { round:"S16", opp:"Illinois",   pts:6  }],
  // Michigan
  "Yaxel Lendeborg":      [{ round:"R64", opp:"Howard",      pts:9  }, { round:"R32", opp:"St Louis",     pts:25 }],
  "Elliot Cadeau":       [{ round:"R64", opp:"Howard",      pts:5  }, { round:"R32", opp:"St Louis",     pts:12 }],
  "Will Tschetter":      [{ round:"R64", opp:"Howard",      pts:2  }, { round:"R32", opp:"St Louis",     pts:6  }],
  "Trey McKenney":       [{ round:"R64", opp:"Howard",      pts:10 }, { round:"R32", opp:"St Louis",     pts:8  }],
  "Braden Smith":        [{ round:"R64", opp:"Queens",      pts:26 }, { round:"R32", opp:"Miami FL",     pts:12 }, { round:"S16", opp:"Texas",      pts:16 }],
  "Omer Mayer":           [{ round:"R64", opp:"Queens",      pts:9  }, { round:"R32", opp:"Miami FL",     pts:0  }, { round:"S16", opp:"Texas",      pts:2  }],
  "Daniel Jacobsen":     [{ round:"R64", opp:"Queens",      pts:4  }, { round:"R32", opp:"Miami FL",     pts:0  }, { round:"S16", opp:"Texas",      pts:0  }],
  "Oscar Cluff":         [{ round:"R64", opp:"Queens",      pts:9  }, { round:"R32", opp:"Miami FL",     pts:8  }, { round:"S16", opp:"Texas",      pts:11 }],
  "C.J. Cox":            [{ round:"R64", opp:"Queens",      pts:11 }, { round:"R32", opp:"Miami FL",     pts:11 }, { round:"S16", opp:"Texas",      pts:10 }],
  "Pop Isaacs":          [{ round:"R64", opp:"St Mary's",   pts:3  }, { round:"R32", opp:"Houston",      pts:8  }],
  "Morez Johnson":        [{ round:"R64", opp:"Howard",      pts:15 }, { round:"R32", opp:"St Louis",     pts:21 }],
  "Aday Mara":            [{ round:"R64", opp:"Howard",      pts:19 }, { round:"R32", opp:"St Louis",     pts:16 }],
  "Tre Donovan Mara":     [{ round:"R64", opp:"Howard",      pts:14 }, { round:"R32", opp:"St Louis",     pts:16 }],
  "Roddy Gayle Jr.":      [{ round:"R64", opp:"Howard",      pts:14 }, { round:"R32", opp:"St Louis",     pts:3  }],
  "Roddy Gale":           [{ round:"R64", opp:"Howard",      pts:14 }, { round:"R32", opp:"St Louis",     pts:3  }],
  "Nimari Burnett":       [{ round:"R64", opp:"Howard",      pts:11 }, { round:"R32", opp:"St Louis",     pts:15 }],
  "Danny Wolf":           [{ round:"R64", opp:"Howard",      pts:17 }, { round:"R32", opp:"St Louis",     pts:0  }],
  "Olivier Nkamhoua":     [{ round:"R64", opp:"Howard",      pts:0  }, { round:"R32", opp:"St Louis",     pts:0  }],
  "Aidan Hadaway":        [{ round:"R64", opp:"Howard",      pts:8  }, { round:"R32", opp:"St Louis",     pts:0  }],
  "Tschetter Brian":      [{ round:"R64", opp:"Howard",      pts:8  }, { round:"R32", opp:"St Louis",     pts:0  }],
  "Caris LeVert":         [{ round:"R64", opp:"Howard",      pts:10 }, { round:"R32", opp:"St Louis",     pts:0  }],
  // Saint Louis (eliminated R32)
  "Robbie Avila":         [{ round:"R64", opp:"Georgia",     pts:9  }, { round:"R32", opp:"Michigan",     pts:12 }],
  // Tennessee
  "Nate Ament":           [{ round:"R64", opp:"Miami OH",    pts:0  }, { round:"R32", opp:"Virginia",     pts:16 }],
  "Felix Okpara":         [{ round:"R64", opp:"Miami OH",    pts:12 }, { round:"R32", opp:"Virginia",     pts:7  }],
  "Bishop Boswell":       [{ round:"R64", opp:"Miami OH",    pts:5  }, { round:"R32", opp:"Virginia",     pts:13 }],
  "Jaylen Carey":         [{ round:"R64", opp:"Miami OH",    pts:0  }, { round:"R32", opp:"Virginia",     pts:10 }],
  "Jamarion Batemon":     [{ round:"R64", opp:"Tenn St",     pts:8  }, { round:"R32", opp:"Kentucky",     pts:3  }],
  "Tavion Banks":        [{ round:"R64", opp:"Clemson",     pts:6  }, { round:"R32", opp:"Florida",      pts:20 }, { round:"S16", opp:"Nebraska",   pts:2  }],
  "Bennett Stirtz":      [{ round:"R64", opp:"Clemson",     pts:16 }, { round:"R32", opp:"Florida",      pts:13 }, { round:"S16", opp:"Nebraska",   pts:2  }],
  "Cooper Koch":         [{ round:"R64", opp:"Clemson",     pts:8  }, { round:"R32", opp:"Florida",      pts:12 }, { round:"S16", opp:"Nebraska",   pts:11 }],
  "Ja'Kobi Gillespie":    [{ round:"R64", opp:"Miami OH",    pts:29 }, { round:"R32", opp:"Virginia",     pts:21 }],
  // Virginia (eliminated R32)
  "Thijs De Ridder":      [{ round:"R64", opp:"Wright St",   pts:10 }, { round:"R32", opp:"Tennessee",    pts:22 }],
  "Chance Mallory":       [{ round:"R64", opp:"Wright St",   pts:2  }, { round:"R32", opp:"Tennessee",    pts:10 }],
  "Malik Thomas":         [{ round:"R64", opp:"Wright St",   pts:11 }, { round:"R32", opp:"Tennessee",    pts:12 }],
  "Ugonna Onyenso":       [{ round:"R64", opp:"Wright St",   pts:2  }, { round:"R32", opp:"Tennessee",    pts:4  }],
  "Jacari White":         [{ round:"R64", opp:"Wright St",   pts:26 }, { round:"R32", opp:"Tennessee",    pts:10 }],
  "Dallin Hall":          [{ round:"R64", opp:"Wright St",   pts:8  }, { round:"R32", opp:"Tennessee",    pts:7  }],
  // Kentucky (eliminated R32)
  "Christin Hammond":     [{ round:"R64", opp:"Kentucky",   pts:9  }],
  "Otega Oweh":           [{ round:"R64", opp:"Santa Clara", pts:35 }, { round:"R32", opp:"Iowa State",   pts:18 }],
  "Elijah Mahi":          [{ round:"R64", opp:"Kentucky",   pts:20 }],
  "Malachi Moreno":       [{ round:"R64", opp:"Santa Clara", pts:3  }, { round:"R32", opp:"Iowa State",   pts:4  }],
  "Collin Chandler":      [{ round:"R64", opp:"Santa Clara", pts:5  }, { round:"R32", opp:"Iowa State",   pts:6  }],
  "Mouhamed Dioubate":    [{ round:"R64", opp:"Santa Clara", pts:17 }, { round:"R32", opp:"Iowa State",   pts:4  }],
  "Denzel Aberdeen":      [{ round:"R64", opp:"Santa Clara", pts:16 }, { round:"R32", opp:"Iowa State",   pts:20 }],
  // Iowa State
  "Blake Buchanan":      [{ round:"R64", opp:"Tenn St",     pts:11 }, { round:"R32", opp:"Kentucky",     pts:9  }],
  "Joshua Jefferson":    [{ round:"R64", opp:"Tenn St",     pts:2  }, { round:"R32", opp:"Kentucky",     pts:0  }],
  "Mark Mitchell":       [{ round:"R64", opp:"Miami FL",    pts:19 }],
  "Tamin Lipsey":         [{ round:"R64", opp:"Tenn St",     pts:3  }, { round:"R32", opp:"Kentucky",     pts:26 }],
  "Milan Momcilovic":     [{ round:"R64", opp:"Tenn St",     pts:17 }, { round:"R32", opp:"Kentucky",     pts:20 }],
  "Nate Heise":           [{ round:"R64", opp:"Tenn St",     pts:22 }, { round:"R32", opp:"Kentucky",     pts:12 }],
  "Killyan Toure":        [{ round:"R64", opp:"Tenn St",     pts:25 }, { round:"R32", opp:"Kentucky",     pts:10 }],
  // Florida (eliminated R32)
  "Alex Condon":          [{ round:"R64", opp:"Prairie View", pts:13 }, { round:"R32", opp:"Iowa",        pts:21 }],
  "Thomas Haugh":         [{ round:"R64", opp:"Prairie View", pts:14 }, { round:"R32", opp:"Iowa",        pts:19 }],
  "Xaivian Lee":          [{ round:"R64", opp:"Prairie View", pts:10 }, { round:"R32", opp:"Iowa",        pts:17 }],
  "Boogie Fland":         [{ round:"R64", opp:"Prairie View", pts:16 }, { round:"R32", opp:"Iowa",        pts:7  }],
  "Rueben Chinyelu":      [{ round:"R64", opp:"Prairie View", pts:14 }, { round:"R32", opp:"Iowa",        pts:0  }],
  "Urban Klavzar":        [{ round:"R64", opp:"Prairie View", pts:11 }, { round:"R32", opp:"Iowa",        pts:5  }],
  "Isaiah Brown":         [{ round:"R64", opp:"Prairie View", pts:7  }, { round:"R32", opp:"Iowa",        pts:3  }],
  "Micah Handlogten":     [{ round:"R64", opp:"Prairie View", pts:10 }, { round:"R32", opp:"Iowa",        pts:0  }],
  // NOTE: Florida R64 (Prairie View) box score not received — pts set to 0 pending
  // Texas Tech (eliminated R32)
  "Jaylen Petty":         [{ round:"R64", opp:"Akron",       pts:24 }, { round:"R32", opp:"Alabama",      pts:9  }],
  "Christian Anderson":   [{ round:"R64", opp:"Akron",       pts:18 }, { round:"R32", opp:"Alabama",      pts:7  }],
  "Donovan Atwell":       [{ round:"R64", opp:"Akron",       pts:15 }, { round:"R32", opp:"Alabama",      pts:12 }],
  "LeJuan Watts":         [{ round:"R64", opp:"Akron",       pts:14 }, { round:"R32", opp:"Alabama",      pts:16 }],
  // Alabama
  "Amari Allen":          [{ round:"R64", opp:"Hofstra",     pts:11 }, { round:"R32", opp:"Texas Tech",   pts:12 }],
  "Labaron Philon":       [{ round:"R64", opp:"Hofstra",     pts:29 }, { round:"R32", opp:"Texas Tech",   pts:9  }],
  "Aiden Sherrell":       [{ round:"R64", opp:"Hofstra",     pts:15 }, { round:"R32", opp:"Texas Tech",   pts:10 }],
  "Latrell Wrightsell":   [{ round:"R64", opp:"Hofstra",     pts:11 }, { round:"R32", opp:"Texas Tech",   pts:24 }],
  // Prairie View (eliminated R64)
  "Dontae Horne":         [{ round:"FF",  opp:"Lehigh",      pts:25 }, { round:"R64", opp:"Florida",      pts:12 }],
  "Tai Reon Joseph":      [{ round:"FF",  opp:"Lehigh",      pts:5  }, { round:"R64", opp:"Florida",      pts:16 }],
  // Miami OH (eliminated R64)
  "Eian Elmer":           [{ round:"FF",  opp:"SMU",         pts:23 }, { round:"R64", opp:"Tennessee",    pts:4  }],
  "Brant Byers":          [{ round:"FF",  opp:"SMU",         pts:19 }, { round:"R64", opp:"Tennessee",    pts:9  }],
  "Peter Suder":          [{ round:"FF",  opp:"SMU",         pts:7  }, { round:"R64", opp:"Tennessee",    pts:27 }],

  // ── Team McCarty missing players ──
  "Carson Cooper":         [{ round:"R64", opp:"N Dakota St", pts:20 }, { round:"R32", opp:"Louisville",  pts:9  }],
  "Tramon Mark":          [{ round:"FF",  opp:"NC State",    pts:17 }, { round:"R64", opp:"BYU",         pts:19 }, { round:"R32", opp:"Gonzaga",    pts:6  }, { round:"S16", opp:"Purdue",     pts:29 }],
  "Matas Vokietaitis":    [{ round:"FF",  opp:"NC State",    pts:23 }, { round:"R64", opp:"BYU",         pts:15 }, { round:"R32", opp:"Gonzaga",    pts:17 }, { round:"S16", opp:"Purdue",     pts:9  }],
  "Dailyn Swain":          [{ round:"FF",  opp:"NC State",    pts:13 }, { round:"R64", opp:"BYU",         pts:14 }, { round:"R32", opp:"Gonzaga",    pts:11 }, { round:"S16", opp:"Purdue",     pts:15 }],
  "Hank Alvey":            [{ round:"FF",  opp:"Prairie View",    pts:23 }],
  "Chase McCarty":         [{ round:"R64", opp:"Idaho",       pts:2  }, { round:"R32", opp:"Texas A&M",   pts:6  }, { round:"S16", opp:"Illinois",   pts:9  }],
  "Mercy Miller":          [{ round:"R64", opp:"Idaho",       pts:10 }, { round:"R32", opp:"Texas A&M",   pts:12 }],
  "Aaron Nkrumah":         [{ round:"R64", opp:"Tenn St",     pts:21 }],
  "Tavari Johnson":       [{ round:"R64", opp:"Texas Tech",  pts:4  }],
  "Amani Lyles":           [{ round:"R64", opp:"Texas Tech",  pts:26 }],
  "Sam Lewis":             [{ round:"R64", opp:"Wright St",   pts:12 }, { round:"R32", opp:"Tennessee",   pts:5  }],
  "Preston Edmead":        24,  // Hofstra (24 R64 vs Alabama) ELIM
  "J.P. Estrella":         24,  // Tennessee (14 R64 vs Miami OH + 10 R32 vs Virginia)
  "Preston Edmead":        [{ round:"R64", opp:"Alabama",     pts:24 }],
  "J.P. Estrella":         [{ round:"R64", opp:"Miami OH",    pts:14 }, { round:"R32", opp:"Virginia",    pts:10 }],
  "Matt Able":           [{ round:"R64", opp:"Iowa",        pts:4  }],

  "Paul McNeil Jr.":     [{ round:"R64", opp:"Iowa",        pts:11 }],

  "Nolan Winter":        [{ round:"R64", opp:"High Point",  pts:8  }],

  "Ven-Allen Lubin":     [{ round:"R64", opp:"Iowa",        pts:6  }],

  "Quadir Copeland":     [{ round:"R64", opp:"Iowa",        pts:16 }],

  "Ace Buckner":         [{ round:"R64", opp:"Iowa",        pts:5  }],

  "Solo Ball":           [{ round:"R64", opp:"Furman",      pts:9  }, { round:"R32", opp:"UCLA",         pts:0  }],

  "Acaden Lewis":        [{ round:"R64", opp:"Utah State",  pts:7  }],

  "Duke Brennan":        [{ round:"R64", opp:"Utah State",  pts:15 }],

  "RJ Godfrey":          [{ round:"R64", opp:"Iowa",        pts:15 }],

  "Dominique Daniels":   [{ round:"R64", opp:"Kansas",      pts:25 }],

  "Alex Wilkins":        [{ round:"R64", opp:"UConn",       pts:21 }],

  "Jayden Stone":        [{ round:"R64", opp:"Miami FL",    pts:21 }],

  "Themus Fulks":        [{ round:"R64", opp:"UCLA",        pts:10 }],

  "Travis Harper II":    [{ round:"R64", opp:"Iowa State",  pts:13 }],

  "Shammah Scott":       [{ round:"R64", opp:"Texas Tech",  pts:20 }],

  "Michael Cooper":      [{ round:"R64", opp:"Virginia",    pts:13 }],

  "TJ Burch":            [{ round:"R64", opp:"Virginia",    pts:15 }],

  "Cruz Davis":          [{ round:"R64", opp:"Alabama",     pts:14 }],

  "Blue Cain":            [{ round:"R64", opp:"St Louis",    pts:6  }],
  "Robert Wright III":    [{ round:"R64", opp:"Texas",       pts:14 }],
  "Marcus Millender":     [{ round:"R64", opp:"St Louis",    pts:13 }],
  "Victor Valdes":        [{ round:"R64", opp:"Nebraska",    pts:14 }],

  "Nasir Whitlock":       [{ round:"FF",  opp:"Prairie View", pts:5  }],
  "Derek Dixon":          [{ round:"R64", opp:"VCU",          pts:11 }],
  "AJ Dybantsa":          [{ round:"R64", opp:"Texas",        pts:35 }],
  "Nick Boyd":            [{ round:"R64", opp:"High Point",   pts:27 }],
  "Jeremiah Wilkinson":   [{ round:"R64", opp:"St Louis",     pts:30 }],
  "B.J. Edwards":         [{ round:"FF",  opp:"Miami OH",     pts:0  }],
  "TJ Power":             [{ round:"R64", opp:"Illinois",     pts:6  }],

  "Jaron Pierre Jr.":         [{ round:"FF", opp:"Miami OH",        pts:18 }],
  "Boopie Miller":            [{ round:"FF", opp:"Miami OH",        pts:15 }],
  "Corey Washington":         [{ round:"FF", opp:"Miami OH",        pts:13 }],
  "Samet Yigitoglu":          [{ round:"FF", opp:"Miami OH",        pts:8  }],
  "Thomas Dowd":              [{ round:"R64", opp:"Nebraska",        pts:4  }],
  "Joseph Omojafo":           [{ round:"R64", opp:"Louisville",      pts:6  }],
  "Wes Enis":                 [{ round:"R64", opp:"Louisville",      pts:4  }],
  "Izaiyah Nelson":           [{ round:"R64", opp:"Louisville",      pts:22 }],
  "Joseph Pinion":            [{ round:"R64", opp:"Louisville",      pts:27 }],
  "Paulius Murauskas":        [{ round:"R64", opp:"St Mary's",       pts:4  }],
  "Joshua Dent":              [{ round:"R64", opp:"St Mary's",       pts:18 }],
  "Mikey Lewis":              [{ round:"R64", opp:"St Mary's",       pts:5  }],
  "Simeon Cottle":            [{ round:"R64", opp:"Gonzaga",         pts:0  }],
  "Seth Trimble":             [{ round:"R64", opp:"VCU",             pts:15 }],
  "Henri Veesaar":            [{ round:"R64", opp:"VCU",             pts:26 }],
  "Luka Bogavac":             [{ round:"R64", opp:"VCU",             pts:8  }],
  "Jordan Scott":             [{ round:"R64", opp:"N Dakota St",     pts:6  }, { round:"R32", opp:"Louisville",      pts:4  }],
  "Kur Teng":                 [{ round:"R64", opp:"N Dakota St",     pts:3  }, { round:"R32", opp:"Louisville",      pts:7  }],
  "Divine Ugochukwu":         [{ round:"R64", opp:"N Dakota St",     pts:0  }, { round:"R32", opp:"Louisville",      pts:0  }],
  "Jamarques Lawrence":       [{ round:"R64", opp:"Troy",            pts:13 }, { round:"R32", opp:"Vanderbilt",      pts:9  }, { round:"S16", opp:"Iowa",       pts:9  }],
  "Trevon Brazile":           [{ round:"R64", opp:"Hawai'i",         pts:19 }, { round:"R32", opp:"High Point",      pts:8  }, { round:"S16", opp:"Arizona",    pts:7  }],
  "D.J. Wagner":              [{ round:"R64", opp:"Hawai'i",         pts:7  }, { round:"R32", opp:"High Point",      pts:2  }, { round:"S16", opp:"Arizona",    pts:7  }],
  "Malique Ewin":             [{ round:"R64", opp:"Hawai'i",         pts:16 }, { round:"R32", opp:"High Point",      pts:14 }, { round:"S16", opp:"Arizona",    pts:8  }],
  "Meleek Thomas":            [{ round:"R64", opp:"Hawai'i",         pts:21 }, { round:"R32", opp:"High Point",      pts:19 }, { round:"S16", opp:"Arizona",    pts:17 }],
  "Nick Pringle":             [{ round:"R64", opp:"Hawai'i",         pts:0  }, { round:"R32", opp:"High Point",      pts:0  }, { round:"S16", opp:"Arizona",    pts:6  }],
  "Kanon Catchings":          [{ round:"R64", opp:"St Louis",        pts:0  }],
  "Somtochukwu Cyril":        [{ round:"R64", opp:"St Louis",        pts:0  }],
  "Allen Graves":             [{ round:"R64", opp:"Kentucky",        pts:0  }],
  "Caleb Foster":             [{ round:"R64", opp:"Siena",           pts:0  }, { round:"R32", opp:"TCU",             pts:0  }],
  "Patrick Ngongba":          [{ round:"R64", opp:"Siena",           pts:0  }, { round:"R32", opp:"TCU",             pts:0  }],
  "Cedric Taylor":            [{ round:"R64", opp:"Michigan",        pts:19 }],
  "Kennard Davis":            [{ round:"R64", opp:"Texas",           pts:9  }],
  "Isiah Harwell":            [{ round:"R64", opp:"Idaho",           pts:0  }, { round:"R32", opp:"Texas A&M",       pts:0  }],
  "Kylan Boswell":            [{ round:"R64", opp:"Penn",            pts:13 }, { round:"R32", opp:"VCU",             pts:12 }, { round:"S16", opp:"Houston",    pts:6  }],
  "John Mobley Jr.":          [{ round:"R64", opp:"TCU",             pts:15 }],
  "Amare Bynum":              [{ round:"R64", opp:"TCU",             pts:12 }],
  "Christoph Tilly":          [{ round:"R64", opp:"TCU",             pts:10 }],
  "Devin Royal":              [{ round:"R64", opp:"TCU",             pts:14 }],
  "Larry Johnson":            [{ round:"R64", opp:"Vanderbilt",      pts:15 }],
  "Tyshawn Archie":           [{ round:"R64", opp:"Vanderbilt",      pts:13 }],
  "Javohn Garcia":            [{ round:"R64", opp:"Vanderbilt",      pts:10 }],
  "Aden Holloway":            [{ round:"R64", opp:"Hofstra",         pts:0  }, { round:"R32", opp:"Texas Tech",      pts:0  }],
  "Darrion Williams":         [{ round:"R64", opp:"Iowa",            pts:0  }],
  "Ethan Roberts":            [{ round:"R64", opp:"Illinois",        pts:0  }],
  "John Blackwell":           [{ round:"R64", opp:"High Point",      pts:22 }],
  "Jarin Stevenson":          [{ round:"R64", opp:"VCU",             pts:11 }],

};



async function getMergedScores() {
  ensureTotals();   // seed from HARDCODED_OVERRIDES if totals.json was empty
  const { scores: live } = await getLiveScores();
  const fileOverrides = readJSON(OVERRIDE_F, {});
  const rosters = readJSON(ROSTER_F, { teams: [] });

  // Build set of active player names (not eliminated)
  const activePlayers = new Set(
    (rosters.teams || []).flatMap(t => t.players.filter(p => p.active !== false).map(p => p.name))
  );

  // playerTotals is the single source of truth — accumulated automatically from ESPN
  // Falls back to HARDCODED_OVERRIDES for any player not yet in playerTotals
  const allTotals = { ...HARDCODED_OVERRIDES, ...playerTotals };

  const merged = {};

  // For every player with a known total, set their score
  for (const [name, basePts] of Object.entries(allTotals)) {
    const playingNow = activePlayers.has(name) && minutesCache[name] > 0;
    if (playingNow) {
      // Live right now — base total + current live pts from ESPN
      merged[name] = basePts + (live[name] || 0);
    } else {
      // Not live — show accumulated total
      merged[name] = basePts;
    }
  }

  // Non-roster players seen live (e.g. players not in our draft but ESPN returns them)
  for (const [name, pts] of Object.entries(live)) {
    if (merged[name] === undefined) merged[name] = pts;
  }

  // Manual admin overrides — only apply to players NOT already in allTotals
  // (prevents stale completed.json data from overwriting correct accumulated totals)
  for (const [name, pts] of Object.entries(fileOverrides)) {
    if (allTotals[name] === undefined) {
      merged[name] = pts;
    }
  }

  return merged;
}

// ════════════════════════════════════════════════════════
//  HISTORY DATA — hardcoded so it survives Render restarts
// ════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════
//  CHAMPION ROSTERS — hardcoded so they survive restarts
// ════════════════════════════════════════════════════════
const CHAMPION_ROSTERS = {
  2015: {
    team: 'Itchy Ron', draftPosition: 14,
    players: [
      { round:1,  name:'Sam Dekker',       school:'Wisconsin',     pts:115 },
      { round:2,  name:'Demetrius Jackson', school:'Notre Dame',    pts:44  },
      { round:3,  name:'Delon Wright',      school:'Utah',          pts:33  },
      { round:4,  name:'Jordan Siebert',    school:'Dayton',        pts:35  },
      { round:5,  name:'Aaron White',       school:'Iowa',          pts:45  },
      { round:6,  name:'Norman Powell',     school:'UCLA',          pts:50  },
      { round:7,  name:'Shannon Evans II',  school:'Buffalo',       pts:15  },
      { round:8,  name:'Dallas Moore',      school:'North Florida', pts:13  },
      { round:9,  name:'Tony Parker',       school:'UCLA',          pts:47  },
      { round:10, name:'LaDarius White',    school:'Ole Miss',      pts:21  },
      { round:11, name:'Nate Buss',         school:'Northern Iowa', pts:24  },
      { round:12, name:'Xavier Ford',       school:'Buffalo',       pts:16  },
      { round:13, name:'Isaac Hamilton',    school:'UCLA',          pts:27  },
      { round:14, name:'Jeremy Morgan',     school:'Northern Iowa', pts:0   },
      { round:15, name:'Jon Octeus',        school:'Purdue',        pts:9   },
    ]
  },
  2018: {
    team: 'Team McCarty', draftPosition: 2,
    players: [
      { round:1,  name:'Mikal Bridges',       school:'Villanova',         pts:93 },
      { round:2,  name:'Grant Williams',       school:'Tennessee',         pts:26 },
      { round:3,  name:'Mustapha Heron',       school:'Auburn',            pts:28 },
      { round:4,  name:'Jarrett Culver',       school:'Texas Tech',        pts:30 },
      { round:5,  name:'Matt Mobley',          school:'St. Bon',           pts:24 },
      { round:6,  name:'Demontrae Jefferson',  school:'Tx. Southern',      pts:20 },
      { round:7,  name:'Zavier Simpson',       school:'Michigan',          pts:39 },
      { round:8,  name:'Khadeen Carrington',   school:'Seton Hall',        pts:54 },
      { round:9,  name:'Marvin Smith',         school:'UNCG',              pts:4  },
      { round:10, name:'CJ Massinburg',        school:'Buffalo',           pts:37 },
      { round:11, name:'Kyle Allman Jr.',      school:'Cal St. Fullerton', pts:21 },
      { round:12, name:'A.J. Harris',          school:'New Mexico St',     pts:2  },
      { round:13, name:'Alex Robinson',        school:'TCU',               pts:7  },
      { round:14, name:'Xavier Sneed',         school:'Kansas St',         pts:55 },
      { round:15, name:'AJ Brodeur',           school:'Penn',              pts:14 },
    ]
  },
  2019: {
    team: 'One Putt Jackson', draftPosition: 17,
    players: [
      { round:1,  name:'Corey Davis Jr.',      school:'Houston',       pts:61  },
      { round:2,  name:'Jarrett Culver',        school:'Texas Tech',    pts:111 },
      { round:3,  name:'Jeremy Harris',         school:'Buffalo',       pts:30  },
      { round:4,  name:'Xavier Tillman',        school:'Michigan St',   pts:68  },
      { round:5,  name:'Payton Pritchard',      school:'Oregon',        pts:48  },
      { round:6,  name:'Jermaine Samuels Jr.',  school:'Villanova',     pts:23  },
      { round:7,  name:'Cody Martin',           school:'Nevada',        pts:23  },
      { round:8,  name:'Alex Copeland',         school:'Yale',          pts:24  },
      { round:9,  name:'Kristian Doolittle',    school:'Oklahoma',      pts:27  },
      { round:10, name:'Aaron Henry',           school:'Michigan St',   pts:52  },
      { round:11, name:'Xavier Green',          school:'ODU',           pts:7   },
      { round:12, name:'Ivan Aurrecoechea',     school:'New Mexico St', pts:13  },
      { round:13, name:'Michale Oguine',        school:'Montana',       pts:3   },
      { round:14, name:'Keyshawn Woods',        school:'Ohio St',       pts:29  },
      { round:15, name:'Randy Miller Jr.',      school:'NC Central',    pts:18  },
    ]
  },
  2022: {
    team: 'Team McCarty', draftPosition: 3,
    players: [
      { round:1,  name:'Drew Timme',          school:'Gonzaga',   pts:82 },
      { round:2,  name:'David McCormack',     school:'Kansas',    pts:79 },
      { round:3,  name:'Josiah Jordan James', school:'Tennessee', pts:30 },
      { round:4,  name:'Tyler Wahl',          school:'Wisconsin', pts:23 },
      { round:5,  name:'Stanley Umude',       school:'Arkansas',  pts:50 },
      { round:6,  name:'Taz Moore',           school:'Houston',   pts:48 },
      { round:7,  name:'Xavier Johnson',      school:'Indiana',   pts:21 },
      { round:8,  name:'Khalil Shabazz',      school:'San Fran',  pts:3  },
      { round:9,  name:'Keon Ellis',          school:'Alabama',   pts:16 },
      { round:10, name:'RJ Davis',            school:'UNC',       pts:88 },
      { round:11, name:'Joe Bryant',          school:'Norfolk St',pts:15 },
      { round:12, name:'Eric Hunter',         school:'Purdue',    pts:15 },
      { round:13, name:'Damion Baugh',        school:'TCU',       pts:20 },
      { round:14, name:'Michael Jones',       school:'Davidson',  pts:8  },
      { round:15, name:'Nate Laszewski',      school:'Nor Dame',  pts:31 },
    ]
  },
  2023: {
    team: 'Shy Ballers', draftPosition: 14,
    players: [
      { round:1,  name:'Mark Sears',         school:'Alabama',      pts:37 },
      { round:2,  name:'Keyontae Johnson',   school:'Kansas St',    pts:62 },
      { round:3,  name:'Colby Jones',        school:'Xavier',       pts:37 },
      { round:4,  name:'Blake Hinson',       school:'Pitt',         pts:35 },
      { round:5,  name:'Boogie Ellis',       school:'USC',          pts:6  },
      { round:6,  name:'Matt Bradley',       school:'San Diego St', pts:64 },
      { round:7,  name:'Kobe Brown',         school:'Missouri',     pts:31 },
      { round:8,  name:'Damion Baugh',       school:'TCU',          pts:26 },
      { round:9,  name:'Nelly Cummings',     school:'Pitt',         pts:37 },
      { round:10, name:'Darrion Trammell',   school:'San Diego St', pts:69 },
      { round:11, name:'Jaylin Williams',    school:'Auburn',       pts:25 },
      { round:12, name:'Wooga Poplar',       school:'Miami',        pts:40 },
      { round:13, name:'De Andre Gholston',  school:'Missouri',     pts:0  },
      { round:14, name:'Marques Warrick',    school:'N Kentucky',   pts:9  },
      { round:15, name:'John Walker',        school:'Tx Southern',  pts:22 },
    ]
  },
  2024: {
    team: 'Studio K', draftPosition: 8,
    players: [
      { round:1,  name:'Terrance Shannon',  school:'Illinois',  pts:93 },
      { round:2,  name:'Marcus Domask',     school:'Illinois',  pts:58 },
      { round:3,  name:'AJ Storr',          school:'Wisconsin', pts:13 },
      { round:4,  name:'DJ Horne',          school:'NC State',  pts:86 },
      { round:5,  name:'DJ Burns',          school:'NC State',  pts:81 },
      { round:6,  name:'Quincy Guerrier',   school:'Illinois',  pts:22 },
      { round:7,  name:'Keisei Tominaga',   school:'Nebraska',  pts:21 },
      { round:8,  name:'Jayden Taylor',     school:'NC State',  pts:28 },
      { round:9,  name:'Chucky Hepburn',    school:'Wisconsin', pts:8  },
      { round:10, name:'Brice Williams',    school:'Nebraska',  pts:24 },
      { round:11, name:'Casey Morsell',     school:'NC State',  pts:42 },
      { round:12, name:'Rienk Mast',        school:'Nebraska',  pts:7  },
      { round:13, name:"Michael O'Connell", school:'NC State',  pts:29 },
      { round:14, name:'Juwan Gary',        school:'Nebraska',  pts:9  },
      { round:15, name:'MO DIARRA',         school:'NC State',  pts:44 },
    ]
  },
  2025: {
    team: 'Nutty Professor', draftPosition: 1,
    players: [
      { round:1,  name:'Walter Clayton Jr', school:'Florida',   pts:134 },
      { round:2,  name:'John Blackwell',    school:'Wisconsin', pts:40  },
      { round:3,  name:'Richie Sanders',    school:'BYU',       pts:66  },
      { round:4,  name:'Tre Holloman',      school:'Mich St',   pts:40  },
      { round:5,  name:'Khalif Battle',     school:'Gonzaga',   pts:41  },
      { round:6,  name:'Dain Dainja',       school:'Memphis',   pts:22  },
      { round:7,  name:'Simeon Wilcher',    school:'St. John\'s',  pts:15  },
      { round:8,  name:'Jeremiah Fears',    school:'Oklahoma',  pts:20  },
      { round:9,  name:'Ven Allen Lubin',   school:'UNC',       pts:26  },
      { round:10, name:'Coen Carr',         school:'Mich St',   pts:45  },
      { round:11, name:'Ben Mbang',         school:'Yale',      pts:2   },
      { round:12, name:'Robert Wright',     school:'Baylor',    pts:30  },
      { round:13, name:'JaeLyn Withers',    school:'UNC',       pts:15  },
      { round:14, name:'Kaden Metheny',     school:'Liberty',   pts:9   },
      { round:15, name:'Johnell Davis',     school:'Arkansas',  pts:61  },
    ]
  }
};

// ════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════

app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    scoresCachedAt:  scoreCacheTime   ? new Date(scoreCacheTime).toISOString()   : null,
    bracketCachedAt: bracketCacheTime ? new Date(bracketCacheTime).toISOString() : null,
    livePlayerCount: Object.keys(scoreCache).length,
    ts: Date.now()
  });
});

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/teams', async (req, res) => {
  const rosters = readJSON(ROSTER_F, { teams: [] });
  const [scores, avgs, jerseys, bracket] = await Promise.all([getMergedScores(), getSeasonAverages(), getJerseys(), getLiveBracket()]);
  const liveHalf = liveHalfCache;

  // Build set of eliminated school names from bracket (won: false)
  const eliminatedSchools = new Set();
  if (bracket) {
    const allRegions = [bracket.east, bracket.west, bracket.south, bracket.midwest];
    const allRounds = ['firstfour', 'r64', 'r32', 'sweet16', 'elite8'];
    for (const region of allRegions) {
      if (!region) continue;
      for (const round of allRounds) {
        for (const m of (region[round] || [])) {
          if (m.t1?.won === false && m.t1?.name && m.t1.name !== 'TBD') eliminatedSchools.add(normSchool(m.t1.name));
          if (m.t2?.won === false && m.t2?.name && m.t2.name !== 'TBD') eliminatedSchools.add(normSchool(m.t2.name));
        }
      }
    }
  }

  const teams = (rosters.teams || []).map(team => {
    let total = 0;
    const players = (team.players || []).map(p => {
      // Fuzzy name match: try exact first, then normalized (strips Jr/Sr/II/periods)
      const normP = normalizeName(p.name);
      const fuzzyLookup = (obj) => obj[p.name] !== undefined ? obj[p.name]
        : Object.entries(obj).find(([k]) => normalizeName(k) === normP)?.[1];
      const pts      = fuzzyLookup(scores) ?? p.pts ?? 0;
      const avg      = fuzzyLookup(avgs) ?? null;
      let trend = null;

      // ── OPTION 1 (ACTIVE): Pace-adjusted trend ──
      const GAME_MINUTES = 40;
      const minsPlayed = fuzzyLookup(minutesCache) || 0;
      const liveNow = minsPlayed > 0;
      const livePts = liveNow ? (scores[p.name] || 0) : 0;

      // Today's live pts only (not cumulative) — for live/just-finished game comparison
      const livePtsOnly = (scores[p.name] !== undefined ? scores[p.name]
        : Object.entries(scores).find(([k]) => normalizeName(k) === normP)?.[1]) || 0;

      // Games played based on how deep in the bracket the player's school has gone
      // First Four teams get 1 game before R64, everyone else starts at R64
      const firstFourSchools = new Set(['Prairie View A&M','Miami OH','Texas','Howard']);
      const roundGames = { r64:1, r32:2, r16:3, r8:4, r4:5, rfinal:6 };
      let gamesPlayed = 0;
      if (bracket) {
        for (const region of ['east','west','south','midwest']) {
          for (const [round, gamesInRound] of Object.entries(roundGames)) {
            const matchups = bracket[region]?.[round] || [];
            for (const m of matchups) {
              const schoolNorm = normSchool(p.school).toLowerCase();
              const t1 = (m.t1?.name||'').toLowerCase();
              const t2 = (m.t2?.name||'').toLowerCase();
              if ((t1.includes(schoolNorm)||schoolNorm.includes(t1)||t2.includes(schoolNorm)||schoolNorm.includes(t2)) && m.status === 'STATUS_FINAL') {
                gamesPlayed = Math.max(gamesPlayed, gamesInRound);
              }
            }
          }
        }
        // Add 1 extra game for First Four teams
        let playedFirstFour = false;
        for (const ff of (bracket._firstFour || [])) {
          const schoolNorm = normSchool(p.school).toLowerCase();
          const t1 = (ff.t1?.name||'').toLowerCase();
          const t2 = (ff.t2?.name||'').toLowerCase();
          if ((t1.includes(schoolNorm)||schoolNorm.includes(t1)||t2.includes(schoolNorm)||schoolNorm.includes(t2)) && ff.status === 'STATUS_FINAL') {
            playedFirstFour = true;
          }
        }
        if (playedFirstFour) gamesPlayed += 1;
      }
      // Fallback: at least 1 game if they have any pts
      if (gamesPlayed === 0 && pts > 0) gamesPlayed = 1;

      if (avg && avg > 0 && minsPlayed >= 8) {
        // LIVE right now: project today's pts vs single-game avg
        if (livePtsOnly > 0) {
          const projectedFinal = livePtsOnly / (minsPlayed / GAME_MINUTES);
          const ratio = projectedFinal / avg;
          if      (ratio >= 1.5) trend = 'hot3';
          else if (ratio >= 1.3) trend = 'hot2';
          else if (ratio >= 1.2) trend = 'hot1';
          else if (ratio <= 0.5) trend = 'cold3';
          else if (ratio <= 0.7) trend = 'cold2';
          else if (ratio <= 0.8) trend = 'cold1';
        }
      } else if (avg && avg > 0 && minsPlayed === 0 && pts > 0) {
        // Not live: compare cumulative pts vs (avg * gamesPlayed)
        const expectedTotal = avg * gamesPlayed;
        const ratio = pts / expectedTotal;
        if      (ratio >= 1.5) trend = 'hot3';
        else if (ratio >= 1.3) trend = 'hot2';
        else if (ratio >= 1.2) trend = 'hot1';
        else if (ratio <= 0.5) trend = 'cold3';
        else if (ratio <= 0.7) trend = 'cold2';
        else if (ratio <= 0.8) trend = 'cold1';
      }

      // ── OPTION 2 (SAVED): No animations during 1st half ──
      // To reactivate: replace above block with this
      // const schoolLower = (p.school || '').toLowerCase();
      // const inFirstHalf = [...liveHalf].some(s => s.includes(schoolLower) || schoolLower.includes(s));
      // if (avg && avg > 0 && pts > 0 && !inFirstHalf) {
      //   const ratio = pts / avg;
      //   if (ratio >= 1.5) trend = 'hot3'; ...etc
      // }

      total += pts;
      const jersey = fuzzyLookup(jerseys) || null;
      const active = eliminatedSchools.has(normSchool(p.school)) ? false : (p.active !== false);
      const isLive = p.active !== false && (minutesCache[p.name] > 0 || Object.entries(minutesCache).some(([k,v]) => v > 0 && normalizeName(k) === normP));
      return { ...p, pts, seasonAvg: avg, trend, jersey, active, isLive };
    });
    return { ...team, players, totalPts: total };
  });
  teams.sort((a, b) => b.totalPts - a.totalPts);
  res.json({ teams, lastFetch: new Date(scoreCacheTime || Date.now()).toISOString(), livePlayerCount: Object.keys(scores).length });
});

app.get('/api/averages', async (req, res) => {
  const avgs = await getSeasonAverages();
  res.json({ averages: avgs, count: Object.keys(avgs).length, cachedAt: new Date(avgCacheTime || Date.now()).toISOString() });
});

app.get('/api/boxscore/:gameId', async (req, res) => {
  try {
    const data = await fetchURL(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${req.params.gameId}`
    );
    const comp = data.boxscore?.players || [];
    const teams = [];
    for (const teamData of comp) {
      const teamName = teamData.team?.displayName || 'Unknown';
      const players  = [];
      for (const statGroup of (teamData.statistics || [])) {
        // Use labels array to find correct stat positions — ESPN order can vary
        const labels = statGroup.labels || [];
        const idx = (name) => {
          const i = labels.indexOf(name);
          return i >= 0 ? i : null;
        };
        // Fallback positions if labels missing (standard ESPN order)
        const iMin = idx('MIN') ?? 0;
        const iFg  = idx('FG')  ?? 1;
        const i3pt = idx('3PT') ?? 2;
        const iFt  = idx('FT')  ?? 3;
        const iReb = idx('REB') ?? 6;
        const iAst = idx('AST') ?? 7;
        const iStl = idx('STL') ?? 8;
        const iBlk = idx('BLK') ?? 9;
        const iTo  = idx('TO')  ?? 10;
        const iPts = idx('PTS') ?? 13;

        for (const athlete of (statGroup.athletes || [])) {
          const stats = athlete.stats || [];
          players.push({
            name: athlete.athlete?.displayName || '—',
            starter: athlete.starter || false,
            dnp:     athlete.didNotPlay || false,
            min:    stats[iMin] || '0',
            fg:     stats[iFg]  || '0-0',
            threeP: stats[i3pt] || '0-0',
            ft:     stats[iFt]  || '0-0',
            reb:    stats[iReb] || '0',
            ast:    stats[iAst] || '0',
            stl:    stats[iStl] || '0',
            blk:    stats[iBlk] || '0',
            to:     stats[iTo]  || '0',
            pts:    stats[iPts] || '0',
          });
        }
      }
      teams.push({ teamName, players });
    }
    const header      = data.header || {};
    const competition = (header.competitions || [])[0] || {};
    const gameStatus  = competition.status?.type?.description || 'Unknown';
    const competitors = (competition.competitors || []).map(c => ({
      name:   c.team?.displayName || '—',
      score:  c.score || '0',
      winner: c.winner || false,
      record: c.record?.[0]?.summary || ''
    }));
    res.json({ ok: true, gameStatus, competitors, teams });
  } catch (e) {
    console.error('[BoxScore] fetch failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/bracket', async (req, res) => {
  const bracket = await getLiveBracket();
  res.json({ bracket, cachedAt: new Date(bracketCacheTime || Date.now()).toISOString() });
});


// Verify HARDCODED totals match checkpoint on startup
(function verifyCheckpoint() {
  const rosters = readJSON(ROSTER_F, { teams: [] });
  let allOk = true;
  for (const team of (rosters.teams || [])) {
    const expected = VERIFIED_R32_TOTALS[team.name];
    if (expected === undefined) continue;
    const actual = team.players.reduce((s, p) => s + (HARDCODED_OVERRIDES[p.name] || 0), 0);
    if (actual !== expected) {
      console.warn(`[CHECKPOINT] ⚠ ${team.name}: expected ${expected}, got ${actual} (diff ${actual-expected})`);
      allOk = false;
    }
  }
  if (allOk) console.log('[CHECKPOINT] ✓ All R32 team totals verified correct');
})();

app.get('/api/scores', async (req, res) => {
  const { scores: live } = await getLiveScores();
  const fileOverrides = readJSON(OVERRIDE_F, {});
  const merged = await getMergedScores();
  res.json({ live, overrides: fileOverrides, merged, liveCount: Object.keys(live).length,
             minutesCache, processedGames: Object.keys(processedGames).length });
});

// Game log — auto-accumulated from ESPN, used by player drawer
app.get('/api/gamelog', (req, res) => {
  ensureGameLog(); // seed from GAME_LOG constant if gamelog.json was empty
  // Merge static GAME_LOG (base) with auto-accumulated playerGameLog (takes priority)
  const merged = { ...GAME_LOG };
  for (const [name, entries] of Object.entries(playerGameLog)) {
    merged[name] = entries;
  }
  res.json(merged);
});

// History — always returns data even after restarts
app.get('/api/history', (req, res) => {
  const saved = readJSON(HISTORY_F, null);
  res.json(saved && saved.winners && saved.winners.length ? saved : HISTORY_DATA);
});

app.get('/api/champion-roster/:year', (req, res) => {
  const year  = parseInt(req.params.year);
  const saved = readJSON(path.join(DATA, 'champion_rosters.json'), {});
  const roster = saved[year] || CHAMPION_ROSTERS[year] || null;
  res.json({ year, roster });
});

app.get('/api/champion-rosters', (req, res) => {
  const saved = readJSON(path.join(DATA, 'champion_rosters.json'), {});
  res.json({ rosters: { ...CHAMPION_ROSTERS, ...saved } });
});

app.get('/api/all-time-seasons', (req, res) => {
  const saved = readJSON(path.join(DATA, 'all_time_seasons.json'), {});
  res.json({ seasons: saved });
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === ADMIN_PASS) res.json({ token: ADMIN_TOKEN });
  else res.status(401).json({ error: 'Wrong password' });
});

app.post('/api/admin/roster', requireAdmin, (req, res) => {
  const { teams } = req.body;
  if (!Array.isArray(teams)) return res.status(400).json({ error: 'Expected { teams: [...] }' });
  writeJSON(ROSTER_F, { teams, updatedAt: new Date().toISOString() });
  res.json({ ok: true, teamCount: teams.length });
});

app.post('/api/admin/roster/csv', requireAdmin, (req, res) => {
  const { csv } = req.body;
  if (!csv) return res.status(400).json({ error: 'No CSV provided' });
  console.log('[CSV] Raw length:', csv.length);
  const lines     = csv.trim().replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n').filter(l=>l.trim());
  const dataLines = lines[0].toLowerCase().includes('teamname') ? lines.slice(1) : lines;
  const teamMap   = {};
  let playerCount = 0;
  for (const line of dataLines) {
    if (!line.trim()) continue;
    const delim = line.includes('\t') ? '\t' : ',';
    const parts = line.split(delim).map(s => s.trim().replace(/^"|"$/g,'').trim());
    const [teamName, playerName, school] = parts;
    if (!teamName || !playerName) continue;
    if (!teamMap[teamName]) teamMap[teamName] = { name: teamName, players: [] };
    teamMap[teamName].players.push({ name: playerName, school: school||'—', pts: 0, active: true });
    playerCount++;
  }
  const teams = Object.values(teamMap);
  writeJSON(ROSTER_F, { teams, updatedAt: new Date().toISOString() });
  res.json({ ok: true, teamCount: teams.length, playerCount });
});

app.post('/api/admin/override', requireAdmin, (req, res) => {
  const { playerName, pts } = req.body;
  if (!playerName || pts === undefined) return res.status(400).json({ error: 'playerName + pts required' });
  const overrides = readJSON(OVERRIDE_F, {});
  overrides[playerName] = Number(pts);
  writeJSON(OVERRIDE_F, overrides);
  scoreCacheTime = 0;
  res.json({ ok: true, playerName, pts: overrides[playerName] });
});

app.post('/api/admin/clear-overrides', requireAdmin, (req, res) => {
  writeJSON(OVERRIDE_F, {});
  writeJSON(COMPLETED_F, {});
  completedTodayCache = {};
  // Note: we do NOT clear totals.json or gamelog.json — those are cumulative all season
  // We DO clear processedGames so the next round's game IDs get processed fresh
  processedGames = {};
  writeJSON(PROCESSED_F, {});
  res.json({ ok: true, message: 'Round data cleared — ready for next round' });
});

app.delete('/api/admin/override/:playerName', requireAdmin, (req, res) => {
  const overrides = readJSON(OVERRIDE_F, {});
  delete overrides[decodeURIComponent(req.params.playerName)];
  writeJSON(OVERRIDE_F, overrides);
  scoreCacheTime = 0;
  res.json({ ok: true });
});

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
  bracketCacheTime = 0;
  res.json({ ok: true });
});

app.post('/api/admin/refresh', requireAdmin, async (req, res) => {
  scoreCacheTime   = 0;
  bracketCacheTime = 0;
  avgCacheTime     = 0; // Force refresh averages too
  await Promise.all([getLiveScores(), getLiveBracket(), getSeasonAverages()]);
  res.json({ ok: true, message: 'ESPN data force-refreshed' });
});

// FIX: was `scoresCache?.merged` (undefined variable) — now uses `scoreCache`
app.post('/api/admin/archive-season', requireAdmin, (req, res) => {
  try {
    const year      = new Date().getFullYear();
    const overrides = readJSON(OVERRIDE_F, {});
    // For archive: accumulate hardcoded base + final scores
    const merged = { ...scoreCache };
    for (const [name, basePts] of Object.entries(HARDCODED_OVERRIDES)) {
      merged[name] = (scoreCache[name] || 0) + basePts;
    }
    for (const [name, pts] of Object.entries(overrides)) { merged[name] = pts; }
    const roster    = readJSON(ROSTER_F, { teams: [] });
    const teams     = roster.teams || [];
    if (!teams.length) return res.json({ ok:false, error:'No roster data found — upload roster first' });

    const history  = readJSON(HISTORY_F, HISTORY_DATA);
    const thisYear = history.winners?.find(w => w.year === year);
    const champion = thisYear?.winner || null;

    const allTeams = teams.map((t, ti) => ({
      name:          t.name,
      draftPosition: ti + 1,
      isChampion:    champion ? t.name === champion : false,
      totalPts:      t.players.reduce((s, p) => s + (merged[p.name] ?? p.pts ?? 0), 0),
      players:       t.players.map((p, pi) => ({
        round:  pi + 1,
        name:   p.name,
        school: p.school || '—',
        pts:    merged[p.name] ?? p.pts ?? null,
      }))
    }));

    const allTime = readJSON(path.join(DATA, 'all_time_seasons.json'), {});
    allTime[year] = { year, champion, teams: allTeams, archivedAt: new Date().toISOString() };
    writeJSON(path.join(DATA, 'all_time_seasons.json'), allTime);

    const champTeam    = allTeams.find(t => t.isChampion) || allTeams[0];
    const champRosters = readJSON(path.join(DATA, 'champion_rosters.json'), {});
    champRosters[year] = { team: champTeam.name, draftPosition: champTeam.draftPosition, players: champTeam.players };
    writeJSON(path.join(DATA, 'champion_rosters.json'), champRosters);

    const totalPlayers = allTeams.reduce((s,t) => s + t.players.length, 0);
    console.log(`[Archive] Saved ${year}: ${allTeams.length} teams, ${totalPlayers} players. Champion: ${champion}`);
    res.json({ ok:true, year, teams: allTeams.length, players: totalPlayers, champion });
  } catch(e) {
    console.error('[Archive]', e);
    res.json({ ok:false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════
//  INIT DATA FILES
// ════════════════════════════════════════════════════════
if (!fs.existsSync(ROSTER_F))   writeJSON(ROSTER_F,   { teams: [] });
if (!fs.existsSync(OVERRIDE_F)) writeJSON(OVERRIDE_F, {});
if (!fs.existsSync(BRACKET_F))  writeJSON(BRACKET_F,  buildBlankBracket());
if (!fs.existsSync(HISTORY_F))  writeJSON(HISTORY_F,  HISTORY_DATA);

// ════════════════════════════════════════════════════════
//  START + WARM CACHE
// ════════════════════════════════════════════════════════
app.listen(PORT, async () => {
  console.log(`\n🏀 SLAM-N-JAM server running → http://localhost:${PORT}`);
  console.log('📡 Warming ESPN cache...');
  await Promise.all([getLiveBracket(), getSeasonAverages()]);
  await getLiveScores();
  fetchJerseyNumbers().then(j => { jerseyCache = j; }).catch(() => {});
  console.log('✅ Ready.\n');
  setInterval(getLiveScores,     SCORE_TTL);
  setInterval(getLiveBracket,    BRACKET_TTL);
  setInterval(getSeasonAverages, AVG_TTL);
});
