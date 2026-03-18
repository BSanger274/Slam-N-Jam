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
    const allEvents = [];

    for (const date of dates) {
      try {
        const data = await fetchURL(`https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?groups=100&limit=50&date=${date}`);
        allEvents.push(...(data.events || []));
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
        // Player points
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
    console.log(`[Scores] ${Object.keys(scores).length} players, ${allEvents.length} events`);
    return scores;
  } catch (e) {
    console.error('[Scores] ESPN fetch failed:', e.message);
    return null;
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
// ════════════════════════════════════════════════════════
let avgCache     = {};
let avgCacheTime = 0;
const AVG_TTL    = 6 * 60 * 60 * 1000;

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
          } catch { }
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
      { id:'ff3', region:'midwest', date:'Tue Mar 17', time:'6:40 PM ET', tv:'truTV', location:'UD Arena, Dayton, OH', t1:team(16,'UMBC'),        t2:team(16,'Howard')      },
      { id:'ff1', region:'west',    date:'Tue Mar 17', time:'9:15 PM ET', tv:'truTV', location:'UD Arena, Dayton, OH', t1:team(11,'Texas'),        t2:team(11,'NC State')    },
      { id:'ff4', region:'south',   date:'Wed Mar 18', time:'6:40 PM ET', tv:'truTV', location:'UD Arena, Dayton, OH', t1:team(16,'Prairie View'), t2:team(16,'Lehigh')      },
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
        { id:'w5', date:'Thu Mar 19', time:'9:50 PM ET', location:'Moda Center, Portland, OR',     tv:'TBS', t1:team(6,'BYU'),       t2:team(11,'TX/NCS (TBD)')   },
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
        { id:'s1', date:'Fri Mar 20', time:'9:25 PM ET',  location:'Amalie Arena, Tampa, FL',                    tv:'TNT',   t1:team(1,'Florida'),     t2:team(16,'PV/LEH (TBD)') },
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
        { id:'m1', date:'Thu Mar 19', time:'7:10 PM ET',  location:'KeyBank Center, Buffalo, NY',          tv:'CBS',   t1:team(1,'Michigan'),   t2:team(16,'UMBC/HOW (TBD)') },
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
  const live      = await getLiveScores();
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
  const [scores, avgs] = await Promise.all([getMergedScores(), getSeasonAverages()]);
  const teams = (rosters.teams || []).map(team => {
    let total = 0;
    const players = (team.players || []).map(p => {
      const pts = scores[p.name] ?? p.pts ?? 0;
      const avg = avgs[p.name] ?? null;
      let trend = null;
      if (avg && avg > 0 && pts > 0) {
        const ratio = pts / avg;
        if      (ratio >= 1.5) trend = 'hot3';
        else if (ratio >= 1.3) trend = 'hot2';
        else if (ratio >= 1.2) trend = 'hot1';
        else if (ratio <= 0.5) trend = 'cold3';
        else if (ratio <= 0.7) trend = 'cold2';
        else if (ratio <= 0.8) trend = 'cold1';
      }
      total += pts;
      return { ...p, pts, seasonAvg: avg, trend };
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
  const live      = await getLiveScores();
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
  console.log('✅ Ready.\n');
  setInterval(getLiveScores,     SCORE_TTL);
  setInterval(getLiveBracket,    BRACKET_TTL);
  setInterval(getSeasonAverages, AVG_TTL);
});
