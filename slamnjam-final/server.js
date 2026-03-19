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
const OVERRIDE_F = path.join(DATA, 'overrides.json');
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
                for (const m of (bracketCache[region]?.r64 || [])) {
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
    // Fetch full box scores for active/final games — gets ALL players not just leaders
    const activeEvents = allEvents.filter(ev => {
      const s = ev.status?.type?.name || '';
      // Only fetch live box scores — NOT completed games
      // Completed game scores come from overrides or the leaders feed
      return s === 'STATUS_IN_PROGRESS' || s === 'STATUS_HALFTIME';
    });
    const freshMinutes = {}; // player -> minutes played this game
    await Promise.all(activeEvents.slice(0, 10).map(async ev => {
      const evStatus = ev.status?.type?.name || '';
      const isFinal  = evStatus === 'STATUS_FINAL';
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
                // Use player's actual minutes if available, else use game clock
                freshMinutes[name] = playerMins > 0 ? playerMins : minsElapsed;
              }
            }
          }
        }
      } catch(e) {}
    }));
    // Update minutesCache with latest data
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

  // ESPN team IDs for all 68 tournament teams (2026)
  // Keyed by school abbreviation used in our roster
  const TOURNAMENT_TEAM_IDS = {
    'Duke': 150, 'Ohio State': 194, 'St Johns': 2569, 'Kansas': 2305,
    'Louisville': 97, 'Michigan St': 127, 'UCLA': 26, 'UConn': 41,
    'Arizona': 12, 'Villanova': 222, 'Wisconsin': 275, 'Arkansas': 8,
    'BYU': 252, 'Gonzaga': 2250, 'Miami FL': 2390, 'Purdue': 2509,
    'Florida': 57, 'Clemson': 228, 'Vanderbilt': 238, 'Nebraska': 158,
    'N. Carolina': 153, 'Illinois': 356, 'Saint Marys': 2608, 'Houston': 248,
    'Michigan': 130, 'Georgia': 61, 'Texas Tech': 2641, 'Alabama': 333,
    'Tennessee': 2633, 'Virginia': 258, 'Kentucky': 96, 'Iowa State': 66,
    'Texas': 251, 'NC St': 152, 'Howard': 47, 'Iowa': 2294,
    'McNeese St': 2377, 'Troy': 2653, 'VCU': 2670, 'Penn': 219,
    'Texas A&M': 245, 'Idaho': 70, 'Utah St': 328, 'High Point': 2729,
    'Hawaii': 62, 'Kennesaw St': 2908, 'Missouri': 142, 'Queens': 2455,
    'Akron': 2006, 'Hofstra': 2206, 'Wright St': 2750, 'Santa Clara': 2607,
    'Tenn St': 2634, 'Furman': 231, 'LIU': 2934, 'Siena': 2561,
    'So Florida': 58, 'N. Dakota St': 2449, 'UCF': 2116, 'TCU': 2628,
    'Northern Iowa': 2254, 'CA Baptist': 2856, 'South Florida': 58,
    'SMU': 2567, 'Miami OH': 193, 'Prairie View': 2504, 'Lehigh': 2348,
    'UMBC': 2413, 'St Marys': 2608, 'St Johns': 2569, 'Mich St': 127,
    'Tx Tech': 2641, 'Wisc': 275, 'Tenn': 2633, 'Vandy': 238,
    'UNC': 153, 'Ohio St': 194, 'Prairie View A&M': 2504, 'Pr View': 2504
  };

  const seen = new Set();
  const teamIds = Object.values(TOURNAMENT_TEAM_IDS).filter(id => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  console.log(`[Averages] Fetching rosters for ${teamIds.length} tournament teams...`);
  let fetched = 0;

  // Fetch in batches of 5 to avoid overwhelming ESPN
  for (let i = 0; i < teamIds.length; i += 5) {
    const batch = teamIds.slice(i, i + 5);
    await Promise.all(batch.map(async (teamId) => {
      try {
        // Try the statistics endpoint first — has season averages
        const statsData = await fetchURL(
          `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams/${teamId}/statistics`
        );
        // Parse team statistics leaders for PPG
        for (const cat of (statsData.results?.stats?.categories || [])) {
          if ((cat.name||'').toLowerCase().includes('scoring') || (cat.abbreviation||'') === 'PTS') {
            for (const leader of (cat.leaders || [])) {
              const name = leader.athlete?.displayName;
              const val  = parseFloat(leader.value) || 0;
              if (name && val > 0) avgs[name] = val;
            }
          }
        }
        // Also try roster endpoint as fallback
        const rData = await fetchURL(
          `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams/${teamId}/roster`
        );
        for (const athlete of (rData.athletes || [])) {
          const name = athlete.displayName || athlete.fullName;
          if (!name) continue;
          // Check statistics array
          for (const stat of (athlete.statistics || [])) {
            if (stat.name === 'ppg' || stat.abbreviation === 'PPG' ||
                stat.name === 'points' || stat.displayName === 'Points Per Game') {
              const val = parseFloat(stat.value) || 0;
              if (val > 0) avgs[name] = val;
            }
          }
          // Check averages array
          for (const avg of (athlete.averages || [])) {
            if (avg.abbreviation === 'PPG' || avg.name === 'ppg') {
              const val = parseFloat(avg.value) || 0;
              if (val > 0) avgs[name] = val;
            }
          }
          // Check splits — some endpoints nest stats here
          for (const split of (athlete.splits?.categories || [])) {
            for (const stat of (split.stats || [])) {
              if (stat.abbreviation === 'PTS' || stat.name === 'points') {
                const val = parseFloat(stat.value) || 0;
                if (val > 0 && !avgs[name]) avgs[name] = val;
              }
            }
          }
        }
        fetched++;
      } catch(e) {
        // Skip teams that fail — non-critical
      }
    }));
  }

  console.log(`[Averages] Got PPG for ${Object.keys(avgs).length} players from ${fetched} teams`);
  return avgs;
}

// Hardcoded season averages — fallback if file not found
const HARDCODED_AVERAGES = {
  "Cameron Boozer": 22.5,
  "Isaiah Evans": 14.7,
  "Patrick Ngongba": 10.7,
  "Cayden Boozer": 9.0,
  "Dame Sarr": 8.5,
  "Nikolas Khamenia": 7.3,
  "Maliq Brown": 7.0,
  "Mikel Brown": 18.2,
  "Caleb Foster": 8.5,
  "Brayden Burries": 16.0,
  "Koa Peat": 13.8,
  "Jaden Bradley": 13.4,
  "Motiejus Krivas": 10.8,
  "Tobe Awaka": 9.6,
  "Ivan Kharchenkov": 8.0,
  "Dwayne Aristode": 5.0,
  "Yaxel Lendeberg": 14.7,
  "Morez Johnson": 13.7,
  "Aday Mara": 11.3,
  "Elliot Cadeau": 9.9,
  "Nimari Burnett": 9.0,
  "Roddy Gale": 7.0,
  "Will Tschetter": 5.0,
  "Thomas Haugh": 16.9,
  "Thomsa Haugh": 16.9,
  "Alex Condon": 14.1,
  "Rueben Chinyelu": 12.0,
  "Xaivian Lee": 11.4,
  "Boogie Fland": 11.6,
  "Micah Handlogten": 5.5,
  "Urban Klavzar": 4.0,
  "Milan Momcilovic": 17.0,
  "Joshua Jefferson": 16.6,
  "Tamin Lipsey": 13.3,
  "Killyan Toure": 8.3,
  "Nate Heise": 4.0,
  "Jamarion Batemon": 3.5,
  "Keaton Wagler": 17.9,
  "Kylan Boswell": 13.0,
  "David Mirkovic": 10.0,
  "Tomislav Ivisic": 9.0,
  "Zvonimir Ivisic": 8.0,
  "Andrej Stojakovic": 7.0,
  "Kingston Flemings": 14.0,
  "Emanuel Sharp": 13.0,
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
  "Tarris Reed Jr": 13.9,
  "Alex Karaban": 13.2,
  "Silas Demary": 11.1,
  "Braylon Mullins": 9.9,
  "Eric Reibe": 5.0,
  "Labaron Philon": 21.5,
  "Labaron Philon Jr.": 21.5,
  "Aden Holloway": 16.8,
  "Latrell Wrightsell": 12.0,
  "Amari Allen": 9.0,
  "Aiden Sherrell": 7.0,
  "AJ Dybantsa": 21.3,
  "Robert Wright III": 13.0,
  "Kennard Davis": 9.0,
  "Graham Ike": 17.2,
  "Tyon Grant-Foster": 11.0,
  "Adam Miller": 10.0,
  "Braden Huff": 9.0,
  "Mario Saint-Supery": 8.0,
  "Darius Acuff": 15.0,
  "Trevon Brazile": 13.0,
  "D.J. Wagner": 12.0,
  "Meleek Thomas": 11.0,
  "Billy Richmond III": 8.0,
  "Malique Ewin": 7.0,
  "Nick Pringle": 6.0,
  "Otega Oweh": 15.0,
  "Mouhamed Dioubate": 10.0,
  "Collin Chandler": 9.0,
  "Denzel Aberdeen": 8.0,
  "Zuby Ejiofor": 17.4,
  "Oziyah Sellers": 13.0,
  "Ian Jackson": 11.0,
  "Dillion Mitchell": 10.0,
  "Bryce Hopkins": 8.0,
  "Joson Sanon": 6.0,
  "Thijs De Ridder": 14.2,
  "Seth Trimble": 11.8,
  "Jacari White": 10.4,
  "Devin McGlockton": 11.6,
  "Ugonna Onyenso": 9.8,
  "Braeden Carrington": 12.4,
  "Divine Ugochukwu": 11.2,
  "Dallin Hall": 13.6,
  "Jamarques Lawrence": 10.8,
  "Michael Cooper": 13.4,
  "Tramon Mark": 13.5,
  "Dailyn Swain": 17.8,
  "Jordan Pope": 12.6,
  "Matas Vokietaitis": 11.4,
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
  "Nate Ament": 11.4,
  "J.P. Estrella": 12.4,
  "Darryn Peterson": 15.2,
  "Jeremy Fears": 12.8,
  "Jaxon Kohler": 12.4,
  "Coen Carr": 13.8,
  "Jaron Pierre Jr.": 17.6,
  "MJ Collins": 14.2,
  "AK Okereke": 10.8,
  "David Punch": 9.6,
  "Rashaun Agee": 12.4,
  "Davis Fogle": 11.2,
  "Thomas Dowd": 10.6,
  "Marcus Hill": 9.8,
  "Joseph Omojafo": 12.6,
  "Duke Miles": 13.4,
  "Wes Enis": 12.6,
  "Paulius Muraukas": 14.2,
  "Simeon Cottle": 20.2,
  "Jaylen Petty": 13.6,
  "Cooper Koch": 11.2,
  "Cruz Davis": 20.2,
  "TJ Burch": 12.3,
  "Pop Isaacs": 14.6,
  "Malik Reneau": 15.6,
  "Flory Bidunga": 12.8,
  "Skyy Clark": 13.6,
  "Acaden Lewis": 11.4,
  "Braden Frager": 7.8,
  "Mason Falslev": 10.2,
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
  "Sam Hoiberg": 10.4,
  "Cedric Taylor": 12.2,
  "Donovan Atwell": 10.8,
  "Donovan Dent": 12.4,
  "Nolan Winter": 9.6,
  "Jayden Stone": 11.2,
  "Victor Valdes": 8.6,
  "Alex Wilkins": 17.7,
  "Eian Elmer": 12.6,
  "Micah Robinson": 9.4,
  "Tre Donaldson": 12.4,
  "Dominique Daniels": 23.2,
  "Devin Royal": 13.6,
  "Larry Johnson": 17.5,
  "Rob Martin": 15.3,
  "Tyshawn Archie": 14.3,
  "Shammah Scott": 9.8,
  "Travis Harper II": 17.3,
  "Tyler Tanner": 10.8,
  "Carson Cooper": 11.2,
  "Sam Lewis": 9.6,
  "Dontae Horne": 20.2,
  "Eric Dailey": 11.6,
  "Amani Lyles": 9.2,
  "Preston Edmead": 15.9,
  "Hank Alvey": 8.6,
  "Aaron Nkrumah": 17.6,
  "Henri Veesaar": 10.8,
  "Corey Washington": 13.8,
  "Christin Hammond": 14.6,
  "Themus Fulks": 10.4,
  "Terry Anderson": 16.0,
  "Samet Yigitoglu": 11.6,
  "RJ Godfrey": 13.4,
  "Bennett Stirtz": 11.8,
  "Tre White": 12.6,
  "J'Vonne Hadley": 11.8,
  "Ethan Roberts": 11.6,
  "Luka Bogavac": 9.8,
  "Ryan Conwell": 18.7,
  "Tyler Nickels": 13.6,
  "LeJuan Watts": 14.8,
  "Isaac McKneely": 13.4,
  "Jordan Burks": 10.8,
  "Tai'Reon Joseph": 18.2,
  "Tai'Reon Joseph": 18.2,
  "Elijah Mahi": 12.6,
  "Gavin Doty": 17.9,
  "Nick Boyd": 10.8,
  "Melvin Council Jr.": 13.2,
  "Terrence Hill": 14.6,
  "B.J. Edwards": 12.4,
  "Tyler Perkins": 11.8,
  "Riley Kugel": 10.6,
  "Lazar Djokovic": 13.4,
  "TJ Power": 12.8,
  "Jadrian Tracey": 11.4,
  "Jayden Pierre": 10.5,
  "Cole Bowser": 14.0,
  "Pryce Sandfort": 13.2,
  "Tyler Bilodeau": 11.6,
  "John Mobley Jr.": 12.4,
  "Joshua Dent": 10.8,
  "Shelton Henderson": 13.6,
  "Amare Bynum": 11.2,
  "Joseph Pinion": 10.6,
  "Christoph Tilly": 9.8,
  "Brant Byers": 14.2,
  "Bryce Lindsay": 10.2,
  "Cam'Ron Fletcher": 12.7,
  "John Blackwell": 13.4,
  "Anthony Dell'Orso": 11.8,
  "Bruce Thornton": 19.8,
  "Mark Mitchell": 12.6,
  "Mikey Lewis": 14.2,
  "Trent Perry": 10.4,
  "Robbie Avila": 16.4,
  "Peter Suder": 14.6,
  "Jarin Stevenson": 12.6,
  "Dylan Darling": 11.4,
  "Liutauras Lelevicius": 8.4,
  "Javohn Garcia": 12.0,
  "Christian Anderson": 14.6,
  "Trey McKenney": 10.8,
  "Nasir Whitlock": 21.0,
  "Rienk Mast": 10.6,
  "Xavier Edmonds": 9.8,
  "Duke Brennan": 8.6,
  "Derek Dixon": 11.2,
  "Rylan Griffen": 10.4,
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
        console.log(`[Averages] ESPN supplemented with ${Object.keys(fresh).length} players — total: ${Object.keys(avgCache).length}`);
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
  150:'Duke',2509:'Purdue',2569:'St Johns',2305:'Kansas',97:'Louisville',
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
      { id:'ff2', region:'midwest', date:'Wed Mar 18', time:'9:15 PM ET', tv:'truTV', location:'UD Arena, Dayton, OH', t1:team(11,'Miami OH'),     t2:team(11,'SMU')         }
    ],
    east: {
      r64: [
        { id:'e1', date:'Thu Mar 19', time:'2:50 PM ET',  location:'Bon Secours Wellness Arena, Greenville, SC', tv:'CBS', t1:team(1,'Duke'),        t2:team(16,'Siena')         },
        { id:'e2', date:'Thu Mar 19', time:'12:15 PM ET', location:'Bon Secours Wellness Arena, Greenville, SC', tv:'CBS', t1:team(8,'Ohio State'),  t2:team(9,'TCU')            },
        { id:'e3', date:'Fri Mar 20', time:'7:10 PM ET',  location:'Viejas Arena, San Diego, CA',                tv:'CBS', t1:team(5,"St. John's"), t2:team(12,'Northern Iowa') },
        { id:'e4', date:'Fri Mar 20', time:'9:45 PM ET',  location:'Viejas Arena, San Diego, CA',                tv:'CBS', t1:team(4,'Kansas'),     t2:team(13,'CA Baptist')    },
        { id:'e5', date:'Thu Mar 19', time:'1:30 PM ET',  location:'KeyBank Center, Buffalo, NY',                tv:'TNT', t1:team(6,'Louisville'), t2:team(11,'South Florida') },
        { id:'e6', date:'Thu Mar 19', time:'4:05 PM ET',  location:'KeyBank Center, Buffalo, NY',                tv:'TNT', t1:team(3,'Michigan St'),t2:team(14,'N. Dakota St')  },
        { id:'e7', date:'Fri Mar 20', time:'7:25 PM ET',  location:'Wells Fargo Center, Philadelphia, PA',       tv:'TBS', t1:team(7,'UCLA'),       t2:team(10,'UCF')           },
        { id:'e8', date:'Fri Mar 20', time:'10:00 PM ET', location:'Wells Fargo Center, Philadelphia, PA',       tv:'TBS', t1:team(2,'UConn'),      t2:team(15,'Furman')        }
      ],
      r32:  [{ id:'e9',t1:tbd(),t2:tbd() },{ id:'e10',t1:tbd(),t2:tbd() },{ id:'e11',t1:tbd(),t2:tbd() },{ id:'e12',t1:tbd(),t2:tbd() }],
      r16:  [{ id:'e13',t1:tbd(),t2:tbd() },{ id:'e14',t1:tbd(),t2:tbd() }],
      r8:   [{ id:'e15',t1:tbd(),t2:tbd() }]
    },
    west: {
      r64: [
        { id:'w1', date:'Fri Mar 20', time:'1:35 PM ET', location:'Pechanga Arena, San Diego, CA', tv:'TNT', t1:team(1,'Arizona'),   t2:team(16,'LIU')            },
        { id:'w2', date:'Fri Mar 20', time:'4:10 PM ET', location:'Pechanga Arena, San Diego, CA', tv:'TNT', t1:team(8,'Villanova'), t2:team(9,'Utah State')      },
        { id:'w3', date:'Thu Mar 19', time:'1:50 PM ET', location:'Moda Center, Portland, OR',     tv:'TBS', t1:team(5,'Wisconsin'), t2:team(12,'High Point')     },
        { id:'w4', date:'Thu Mar 19', time:'4:25 PM ET', location:'Moda Center, Portland, OR',     tv:'TBS', t1:team(4,'Arkansas'),  t2:team(13,"Hawai'i")        },
        { id:'w5', date:'Thu Mar 19', time:'9:50 PM ET', location:'Moda Center, Portland, OR',     tv:'TBS', t1:team(6,'BYU'),       t2:team(11,'Texas')   },
        { id:'w6', date:'Thu Mar 19', time:'7:15 PM ET', location:'Moda Center, Portland, OR',     tv:'TBS', t1:team(3,'Gonzaga'),   t2:team(14,'Kennesaw State') },
        { id:'w7', date:'Fri Mar 20', time:'6:50 PM ET', location:'Pechanga Arena, San Diego, CA', tv:'TNT', t1:team(7,'Miami FL'),  t2:team(10,'Missouri')       },
        { id:'w8', date:'Fri Mar 20', time:'9:25 PM ET', location:'Pechanga Arena, San Diego, CA', tv:'TNT', t1:team(2,'Purdue'),    t2:team(15,'Queens')         }
      ],
      r32:  [{ id:'w9',t1:tbd(),t2:tbd() },{ id:'w10',t1:tbd(),t2:tbd() },{ id:'w11',t1:tbd(),t2:tbd() },{ id:'w12',t1:tbd(),t2:tbd() }],
      r16:  [{ id:'w13',t1:tbd(),t2:tbd() },{ id:'w14',t1:tbd(),t2:tbd() }],
      r8:   [{ id:'w15',t1:tbd(),t2:tbd() }]
    },
    south: {
      r64: [
        { id:'s1', date:'Fri Mar 20', time:'9:25 PM ET',  location:'Amalie Arena, Tampa, FL',                    tv:'TNT',   t1:team(1,'Florida'),     t2:team(16,'Prairie View A&M') },
        { id:'s2', date:'Fri Mar 20', time:'6:50 PM ET',  location:'Amalie Arena, Tampa, FL',                    tv:'TNT',   t1:team(8,'Clemson'),     t2:team(9,'Iowa')           },
        { id:'s3', date:'Thu Mar 19', time:'9:20 PM ET',  location:'Paycom Center, Oklahoma City, OK',           tv:'truTV', t1:team(5,'Vanderbilt'),  t2:team(12,'McNeese')       },
        { id:'s4', date:'Thu Mar 19', time:'6:45 PM ET',  location:'Paycom Center, Oklahoma City, OK',           tv:'truTV', t1:team(4,'Nebraska'),    t2:team(13,'Troy')          },
        { id:'s5', date:'Thu Mar 19', time:'12:10 PM ET', location:'Bon Secours Wellness Arena, Greenville, SC', tv:'TNT',   t1:team(6,'N. Carolina'), t2:team(11,'VCU')           },
        { id:'s6', date:'Thu Mar 19', time:'2:45 PM ET',  location:'Bon Secours Wellness Arena, Greenville, SC', tv:'TNT',   t1:team(3,'Illinois'),    t2:team(14,'Penn')          },
        { id:'s7', date:'Thu Mar 19', time:'7:35 PM ET',  location:'Paycom Center, Oklahoma City, OK',           tv:'truTV', t1:team(7,"Saint Mary's"),t2:team(10,'Texas A&M')     },
        { id:'s8', date:'Thu Mar 19', time:'10:10 PM ET', location:'Paycom Center, Oklahoma City, OK',           tv:'truTV', t1:team(2,'Houston'),     t2:team(15,'Idaho')         }
      ],
      r32:  [{ id:'s9',t1:tbd(),t2:tbd() },{ id:'s10',t1:tbd(),t2:tbd() },{ id:'s11',t1:tbd(),t2:tbd() },{ id:'s12',t1:tbd(),t2:tbd() }],
      r16:  [{ id:'s13',t1:tbd(),t2:tbd() },{ id:'s14',t1:tbd(),t2:tbd() }],
      r8:   [{ id:'s15',t1:tbd(),t2:tbd() }]
    },
    midwest: {
      r64: [
        { id:'m1', date:'Thu Mar 19', time:'7:10 PM ET',  location:'KeyBank Center, Buffalo, NY',          tv:'CBS',   t1:team(1,'Michigan'),   t2:team(16,'Howard') },
        { id:'m2', date:'Thu Mar 19', time:'9:45 PM ET',  location:'KeyBank Center, Buffalo, NY',          tv:'CBS',   t1:team(8,'Georgia'),    t2:team(9,'Saint Louis')      },
        { id:'m3', date:'Fri Mar 20', time:'12:40 PM ET', location:'Amalie Arena, Tampa, FL',              tv:'truTV', t1:team(5,'Texas Tech'), t2:team(12,'Akron')           },
        { id:'m4', date:'Fri Mar 20', time:'3:15 PM ET',  location:'Amalie Arena, Tampa, FL',              tv:'truTV', t1:team(4,'Alabama'),    t2:team(13,'Hofstra')         },
        { id:'m5', date:'Fri Mar 20', time:'4:25 PM ET',  location:'Wells Fargo Center, Philadelphia, PA', tv:'TBS',   t1:team(6,'Tennessee'),  t2:team(11,'MIA/SMU (TBD)')   },
        { id:'m6', date:'Fri Mar 20', time:'1:50 PM ET',  location:'Wells Fargo Center, Philadelphia, PA', tv:'TBS',   t1:team(3,'Virginia'),   t2:team(14,'Wright State')    },
        { id:'m7', date:'Fri Mar 20', time:'12:15 PM ET', location:'Enterprise Center, St. Louis, MO',     tv:'CBS',   t1:team(7,'Kentucky'),   t2:team(10,'Santa Clara')     },
        { id:'m8', date:'Fri Mar 20', time:'2:50 PM ET',  location:'Enterprise Center, St. Louis, MO',     tv:'CBS',   t1:team(2,'Iowa State'), t2:team(15,'Tennessee St')    }
      ],
      r32:  [{ id:'m9',t1:tbd(),t2:tbd() },{ id:'m10',t1:tbd(),t2:tbd() },{ id:'m11',t1:tbd(),t2:tbd() },{ id:'m12',t1:tbd(),t2:tbd() }],
      r16:  [{ id:'m13',t1:tbd(),t2:tbd() },{ id:'m14',t1:tbd(),t2:tbd() }],
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
async function getMergedScores() {
  const { scores: live } = await getLiveScores();
  const overrides = readJSON(OVERRIDE_F, {});
  return { ...live, ...overrides };
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
      { round:7,  name:'Simeon Wilcher',    school:'St Johns',  pts:15  },
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
  const [scores, avgs, jerseys] = await Promise.all([getMergedScores(), getSeasonAverages(), getJerseys()]);
  const liveHalf = liveHalfCache;
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

      // ── OPTION 1 (ACTIVE): Pace-adjusted trend — mimics DraftKings style ──
      // Uses player's actual minutes played to project final score
      // No animation until 8+ minutes played to avoid noise at game start
      const GAME_MINUTES = 40;
      const minsPlayed = fuzzyLookup(minutesCache) || 0;

      if (avg && avg > 0 && pts > 0 && minsPlayed >= 8) {
        // Project what player will score by end of game at current pace
        const projectedFinal = pts / (minsPlayed / GAME_MINUTES);
        const ratio = projectedFinal / avg;
        if      (ratio >= 1.5) trend = 'hot3';
        else if (ratio >= 1.3) trend = 'hot2';
        else if (ratio >= 1.2) trend = 'hot1';
        else if (ratio <= 0.5) trend = 'cold3';
        else if (ratio <= 0.7) trend = 'cold2';
        else if (ratio <= 0.8) trend = 'cold1';
      } else if (avg && avg > 0 && pts > 0 && minsPlayed === 0) {
        // Game is over (no live minutes tracked) — compare final score to avg directly
        const ratio = pts / avg;
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
      return { ...p, pts, seasonAvg: avg, trend, jersey };
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

app.get('/api/scores', async (req, res) => {
  const { scores: live } = await getLiveScores();
  const overrides = readJSON(OVERRIDE_F, {});
  res.json({ live, overrides, merged: { ...live, ...overrides }, liveCount: Object.keys(live).length });
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
  await Promise.all([getLiveScores(), getLiveBracket()]);
  res.json({ ok: true, message: 'ESPN data force-refreshed' });
});

// FIX: was `scoresCache?.merged` (undefined variable) — now uses `scoreCache`
app.post('/api/admin/archive-season', requireAdmin, (req, res) => {
  try {
    const year      = new Date().getFullYear();
    const overrides = readJSON(OVERRIDE_F, {});
    const merged    = { ...scoreCache, ...overrides };
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
