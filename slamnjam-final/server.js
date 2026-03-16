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
//  ESPN SEASON AVERAGES CACHE
//  Fetches each player's regular-season PPG for hot/cold calc
//  Refreshes every 6 hours (averages don't change mid-tourney)
// ════════════════════════════════════════════════════════
let avgCache     = {};
let avgCacheTime = 0;
const AVG_TTL    = 6 * 60 * 60 * 1000; // 6 hours

async function fetchSeasonAverages() {
  const avgs = {};
  try {
    const data = await fetchURL(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?groups=100&limit=50'
    );
    for (const event of (data.events || [])) {
      for (const comp of (event.competitions || [])) {
        for (const team of (comp.competitors || [])) {
          const teamId = team.team?.id;
          if (!teamId) continue;
          try {
            const rData = await fetchURL(
              `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams/${teamId}/roster`
            );
            for (const athlete of (rData.athletes || [])) {
              const name = athlete.displayName || athlete.fullName;
              if (!name) continue;
              for (const stat of (athlete.statistics || [])) {
                if (stat.name === 'ppg' || stat.abbreviation === 'PPG') {
                  avgs[name] = parseFloat(stat.value) || 0;
                }
              }
            }
          } catch { /* skip if roster unavailable */ }
        }
      }
    }
  } catch (e) {
    console.error('[Averages] fetch failed:', e.message);
  }
  return avgs;
}

async function getSeasonAverages() {
  if (Date.now() - avgCacheTime > AVG_TTL || Object.keys(avgCache).length === 0) {
    const fresh = await fetchSeasonAverages();
    if (Object.keys(fresh).length > 0) {
      avgCache     = fresh;
      avgCacheTime = Date.now();
      console.log(`[${new Date().toISOString()}] Season averages refreshed — ${Object.keys(avgCache).length} players`);
    }
  }
  return avgCache;
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
      // If ESPN returned empty Final Four sf, use our hardcoded placeholder names
      const seed = buildBlankBracket();
      if (!fresh.final4.sf || fresh.final4.sf.length === 0) {
        fresh.final4.sf    = seed.final4.sf;
        fresh.final4.final = seed.final4.final;
      }
      // Preserve First Four data from seed
      if (!fresh._firstFour) fresh._firstFour = seed._firstFour;
      bracketCache     = fresh;
      bracketCacheTime = Date.now();
      writeJSON(BRACKET_F, { ...fresh, _cachedAt: new Date().toISOString() });
      console.log(`[${new Date().toISOString()}] Bracket refreshed from ESPN`);
    } else if (!bracketCache) {
      // ESPN returned empty or failed — use hardcoded 2026 bracket
      bracketCache = buildBlankBracket();
      bracketCacheTime = Date.now();
      console.log('[Bracket] Using hardcoded 2026 seed bracket');
    }
    // If ESPN returned an empty bracket (all regions {}), fall back to seed
    if (bracketCache && bracketCache.east && Object.keys(bracketCache.east).length === 0) {
      console.log('[Bracket] ESPN returned empty bracket — using hardcoded seed');
      bracketCache = buildBlankBracket();
      bracketCacheTime = Date.now();
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
  // Full 2026 bracket hardcoded — never depends on disk file
  // ESPN API will override this automatically once tournament games begin
  const tbd = () => ({ seed: null, name: 'TBD', score: null, won: null });
  const team = (seed, name) => ({ seed, name, score: null, won: null });
  return {
    _source: '2026-selection-sunday',
    _firstFour: [
      { id:'ff1', region:'west',    date:'Mar 17', t1: team(11,'Texas'),       t2: team(11,'NC State')    },
      { id:'ff2', region:'midwest', date:'Mar 18', t1: team(11,'Miami OH'),    t2: team(11,'SMU')         },
      { id:'ff3', region:'midwest', date:'Mar 17', t1: team(16,'UMBC'),        t2: team(16,'Howard')      },
      { id:'ff4', region:'south',   date:'Mar 18', t1: team(16,'Prairie View'),t2: team(16,'Lehigh')      }
    ],
    east: {
      r64: [
        { id:'e1', date:'Thu Mar 19', time:'2:50 PM ET', location:'Bon Secours Wellness Arena, Greenville, SC', tv:'CBS', t1: team(1,'Duke'),        t2: team(16,'Siena')         },
        { id:'e2', date:'Thu Mar 19', time:'12:15 PM ET',location:'Bon Secours Wellness Arena, Greenville, SC', tv:'CBS', t1: team(8,'Ohio State'),  t2: team(9,'TCU')            },
        { id:'e3', date:'Fri Mar 20', time:'7:10 PM ET', location:'Viejas Arena, San Diego, CA',                tv:'CBS', t1: team(5,"St. John's"),  t2: team(12,'Northern Iowa') },
        { id:'e4', date:'Fri Mar 20', time:'9:45 PM ET', location:'Viejas Arena, San Diego, CA',                tv:'CBS', t1: team(4,'Kansas'),      t2: team(13,'CA Baptist')    },
        { id:'e5', date:'Thu Mar 19', time:'1:30 PM ET', location:'KeyBank Center, Buffalo, NY',                tv:'TNT', t1: team(6,'Louisville'),  t2: team(11,'South Florida') },
        { id:'e6', date:'Thu Mar 19', time:'4:05 PM ET', location:'KeyBank Center, Buffalo, NY',                tv:'TNT', t1: team(3,'Michigan St'), t2: team(14,'N. Dakota St')  },
        { id:'e7', date:'Fri Mar 20', time:'7:25 PM ET', location:'Wells Fargo Center, Philadelphia, PA',       tv:'TBS', t1: team(7,'UCLA'),        t2: team(10,'UCF')           },
        { id:'e8', date:'Fri Mar 20', time:'10:00 PM ET',location:'Wells Fargo Center, Philadelphia, PA',       tv:'TBS', t1: team(2,'UConn'),       t2: team(15,'Furman')        }
      ],
      r32:  [{ id:'e9',  t1:tbd(),t2:tbd() },{ id:'e10', t1:tbd(),t2:tbd() },{ id:'e11', t1:tbd(),t2:tbd() },{ id:'e12', t1:tbd(),t2:tbd() }],
      r16:  [{ id:'e13', t1:tbd(),t2:tbd() },{ id:'e14', t1:tbd(),t2:tbd() }],
      r8:   [{ id:'e15', t1:tbd(),t2:tbd() }]
    },
    west: {
      r64: [
        { id:'w1', date:'Fri Mar 20', time:'1:35 PM ET', location:'Pechanga Arena, San Diego, CA', tv:'TNT', t1: team(1,'Arizona'),    t2: team(16,'LIU')              },
        { id:'w2', date:'Fri Mar 20', time:'4:10 PM ET', location:'Pechanga Arena, San Diego, CA', tv:'TNT', t1: team(8,'Villanova'),  t2: team(9,'Utah State')        },
        { id:'w3', date:'Thu Mar 19', time:'1:50 PM ET', location:'Moda Center, Portland, OR',     tv:'TBS', t1: team(5,'Wisconsin'),  t2: team(12,'High Point')       },
        { id:'w4', date:'Thu Mar 19', time:'4:25 PM ET', location:'Moda Center, Portland, OR',     tv:'TBS', t1: team(4,'Arkansas'),   t2: team(13,"Hawai'i")          },
        { id:'w5', date:'Thu Mar 19', time:'9:50 PM ET', location:'Moda Center, Portland, OR',     tv:'TBS', t1: team(6,'BYU'),        t2: team(11,'TX/NCS (TBD)')     },
        { id:'w6', date:'Thu Mar 19', time:'7:15 PM ET', location:'Moda Center, Portland, OR',     tv:'TBS', t1: team(3,'Gonzaga'),    t2: team(14,'Kennesaw State')   },
        { id:'w7', date:'Fri Mar 20', time:'6:50 PM ET', location:'Pechanga Arena, San Diego, CA', tv:'TNT', t1: team(7,'Miami FL'),   t2: team(10,'Missouri')         },
        { id:'w8', date:'Fri Mar 20', time:'9:25 PM ET', location:'Pechanga Arena, San Diego, CA', tv:'TNT', t1: team(2,'Purdue'),     t2: team(15,'Queens')           }
      ],
      r32:  [{ id:'w9',  t1:tbd(),t2:tbd() },{ id:'w10', t1:tbd(),t2:tbd() },{ id:'w11', t1:tbd(),t2:tbd() },{ id:'w12', t1:tbd(),t2:tbd() }],
      r16:  [{ id:'w13', t1:tbd(),t2:tbd() },{ id:'w14', t1:tbd(),t2:tbd() }],
      r8:   [{ id:'w15', t1:tbd(),t2:tbd() }]
    },
    south: {
      r64: [
        { id:'s1', date:'Fri Mar 20', time:'9:25 PM ET', location:'Amalie Arena, Tampa, FL',                    tv:'TNT',   t1: team(1,'Florida'),      t2: team(16,'PV/LEH (TBD)')  },
        { id:'s2', date:'Fri Mar 20', time:'6:50 PM ET', location:'Amalie Arena, Tampa, FL',                    tv:'TNT',   t1: team(8,'Clemson'),      t2: team(9,'Iowa')            },
        { id:'s3', date:'Thu Mar 19', time:'9:20 PM ET', location:'Paycom Center, Oklahoma City, OK',           tv:'truTV', t1: team(5,'Vanderbilt'),   t2: team(12,'McNeese')        },
        { id:'s4', date:'Thu Mar 19', time:'6:45 PM ET', location:'Paycom Center, Oklahoma City, OK',           tv:'truTV', t1: team(4,'Nebraska'),     t2: team(13,'Troy')           },
        { id:'s5', date:'Thu Mar 19', time:'12:10 PM ET',location:'Bon Secours Wellness Arena, Greenville, SC', tv:'TNT',   t1: team(6,'N. Carolina'),  t2: team(11,'VCU')            },
        { id:'s6', date:'Thu Mar 19', time:'2:45 PM ET', location:'Bon Secours Wellness Arena, Greenville, SC', tv:'TNT',   t1: team(3,'Illinois'),     t2: team(14,'Penn')           },
        { id:'s7', date:'Thu Mar 19', time:'7:35 PM ET', location:'Paycom Center, Oklahoma City, OK',           tv:'truTV', t1: team(7,"Saint Mary's"), t2: team(10,'Texas A&M')      },
        { id:'s8', date:'Thu Mar 19', time:'10:10 PM ET',location:'Paycom Center, Oklahoma City, OK',           tv:'truTV', t1: team(2,'Houston'),      t2: team(15,'Idaho')          }
      ],
      r32:  [{ id:'s9',  t1:tbd(),t2:tbd() },{ id:'s10', t1:tbd(),t2:tbd() },{ id:'s11', t1:tbd(),t2:tbd() },{ id:'s12', t1:tbd(),t2:tbd() }],
      r16:  [{ id:'s13', t1:tbd(),t2:tbd() },{ id:'s14', t1:tbd(),t2:tbd() }],
      r8:   [{ id:'s15', t1:tbd(),t2:tbd() }]
    },
    midwest: {
      r64: [
        { id:'m1', date:'Thu Mar 19', time:'7:10 PM ET', location:'KeyBank Center, Buffalo, NY',          tv:'CBS',   t1: team(1,'Michigan'),    t2: team(16,'UMBC/HOW (TBD)') },
        { id:'m2', date:'Thu Mar 19', time:'9:45 PM ET', location:'KeyBank Center, Buffalo, NY',          tv:'CBS',   t1: team(8,'Georgia'),     t2: team(9,'Saint Louis')      },
        { id:'m3', date:'Fri Mar 20', time:'12:40 PM ET',location:'Amalie Arena, Tampa, FL',              tv:'truTV', t1: team(5,'Texas Tech'),  t2: team(12,'Akron')           },
        { id:'m4', date:'Fri Mar 20', time:'3:15 PM ET', location:'Amalie Arena, Tampa, FL',              tv:'truTV', t1: team(4,'Alabama'),     t2: team(13,'Hofstra')         },
        { id:'m5', date:'Fri Mar 20', time:'4:25 PM ET', location:'Wells Fargo Center, Philadelphia, PA', tv:'TBS',   t1: team(6,'Tennessee'),   t2: team(11,'MIA/SMU (TBD)')   },
        { id:'m6', date:'Fri Mar 20', time:'1:50 PM ET', location:'Wells Fargo Center, Philadelphia, PA', tv:'TBS',   t1: team(3,'Virginia'),    t2: team(14,'Wright State')    },
        { id:'m7', date:'Fri Mar 20', time:'12:15 PM ET',location:'Enterprise Center, St. Louis, MO',    tv:'CBS',   t1: team(7,'Kentucky'),    t2: team(10,'Santa Clara')     },
        { id:'m8', date:'Fri Mar 20', time:'2:50 PM ET', location:'Enterprise Center, St. Louis, MO',    tv:'CBS',   t1: team(2,'Iowa State'),  t2: team(15,'Tennessee St')    }
      ],
      r32:  [{ id:'m9',  t1:tbd(),t2:tbd() },{ id:'m10', t1:tbd(),t2:tbd() },{ id:'m11', t1:tbd(),t2:tbd() },{ id:'m12', t1:tbd(),t2:tbd() }],
      r16:  [{ id:'m13', t1:tbd(),t2:tbd() },{ id:'m14', t1:tbd(),t2:tbd() }],
      r8:   [{ id:'m15', t1:tbd(),t2:tbd() }]
    },
    final4: {
      sf: [
        { id:'f1', t1: team(null,'East Winner'),  t2: team(null,'South Winner')   },
        { id:'f2', t1: team(null,'West Winner'),  t2: team(null,'Midwest Winner') }
      ],
      final:    [{ id:'f3', t1:tbd(), t2:tbd() }],
      champion: 'TBD'
    }
  };
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

// Teams + real-time point totals + hot/cold trend
app.get('/api/teams', async (req, res) => {
  const rosters = readJSON(ROSTER_F, { teams: [] });
  const [scores, avgs] = await Promise.all([getMergedScores(), getSeasonAverages()]);

  const teams = (rosters.teams || []).map(team => {
    let total = 0;
    const players = (team.players || []).map(p => {
      const pts = scores[p.name] ?? p.pts ?? 0;
      const avg = avgs[p.name] ?? null;
      // Tiered hot/cold based on % vs season average
      // Hot:  1 flame = 20-29%, 2 flames = 30-49%, 3 flames = 50%+
      // Cold: 1 flake = 20-29% below, 2 flakes = 30-49% below, 3 flakes = 50%+ below
      let trend = null;
      if (avg && avg > 0 && pts > 0) {
        const ratio = pts / avg;
        if      (ratio >= 1.5)  trend = 'hot3';
        else if (ratio >= 1.3)  trend = 'hot2';
        else if (ratio >= 1.2)  trend = 'hot1';
        else if (ratio <= 0.5)  trend = 'cold3';
        else if (ratio <= 0.7)  trend = 'cold2';
        else if (ratio <= 0.8)  trend = 'cold1';
      }
      total += pts;
      return { ...p, pts, seasonAvg: avg, trend };
    });
    return { ...team, players, totalPts: total };
  });

  teams.sort((a, b) => b.totalPts - a.totalPts);
  res.json({ teams, lastFetch: new Date(scoreCacheTime).toISOString(), livePlayerCount: Object.keys(scores).length });
});

// Season averages endpoint
app.get('/api/averages', async (req, res) => {
  const avgs = await getSeasonAverages();
  res.json({ averages: avgs, count: Object.keys(avgs).length, cachedAt: new Date(avgCacheTime).toISOString() });
});

// Box score for a specific game (used by bracket pop-up)
app.get('/api/boxscore/:gameId', async (req, res) => {
  try {
    const data = await fetchURL(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${req.params.gameId}`
    );
    const comp = data.boxscore?.players || [];
    const teams = [];
    for (const teamData of comp) {
      const teamName = teamData.team?.displayName || 'Unknown';
      const players = [];
      for (const statGroup of (teamData.statistics || [])) {
        for (const athlete of (statGroup.athletes || [])) {
          const stats = athlete.stats || [];
          // ESPN box score stat order: min, fg, 3pt, ft, oreb, dreb, reb, ast, stl, blk, to, pf, +/-, pts
          players.push({
            name:    athlete.athlete?.displayName || '—',
            starter: athlete.starter || false,
            dnp:     athlete.didNotPlay || false,
            min:  stats[0]  || '0',
            fg:   stats[1]  || '0-0',
            threeP: stats[2]|| '0-0',
            ft:   stats[3]  || '0-0',
            reb:  stats[6]  || '0',
            ast:  stats[7]  || '0',
            stl:  stats[8]  || '0',
            blk:  stats[9]  || '0',
            to:   stats[10] || '0',
            pts:  stats[13] || '0',
          });
        }
      }
      // Team totals
      const totals = [];
      for (const statGroup of (teamData.statistics || [])) {
        if (statGroup.totals) totals.push(...statGroup.totals);
      }
      teams.push({ teamName, players, totals });
    }

    // Game header info
    const header = data.header || {};
    const competition = (header.competitions || [])[0] || {};
    const gameStatus = competition.status?.type?.description || 'Unknown';
    const gameTime   = competition.date || null;
    const competitors = (competition.competitors || []).map(c => ({
      name:  c.team?.displayName || '—',
      score: c.score || '0',
      winner: c.winner || false,
      logo:  c.team?.logo || null,
      record: c.record?.[0]?.summary || ''
    }));

    res.json({ ok: true, gameStatus, gameTime, competitors, teams });
  } catch (e) {
    console.error('[BoxScore] fetch failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
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
  await Promise.all([getLiveScores(), getLiveBracket(), getSeasonAverages()]);
  console.log('✅ Ready.\n');

  // Keep refreshing in background
  setInterval(getLiveScores,    SCORE_TTL);
  setInterval(getLiveBracket,   BRACKET_TTL);
  setInterval(getSeasonAverages, AVG_TTL);
});
