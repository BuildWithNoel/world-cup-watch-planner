/**
 * scripts/sync-fixtures.js
 *
 * Fetches FIFA World Cup 2026 knockout fixture participants from
 * football-data.org (free tier, 10 req/min) and updates latest-fixtures.json
 * only when confirmed team names actually change.
 *
 * Called by GitHub Actions once per day. Never runs in the browser.
 *
 * Setup:
 *   1. Register free at https://www.football-data.org/
 *   2. Add your token as a GitHub secret: API_FOOTBALL_DATA_KEY
 *   3. Push this file + the workflow YAML to your repo.
 *
 * Exit codes:
 *   0  success (with or without changes)
 *   1  hard failure — existing data NOT overwritten
 */

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ── CONFIG ────────────────────────────────────────────────────────────────────

const FIXTURES_PATH = path.join(__dirname, '..', 'latest-fixtures.json');

// football-data.org competition code for FIFA World Cup
// Use 'WC' code — more reliable than numeric ID which changes per edition
const COMPETITION_CODE = 'WC';

// Knockout rounds as returned by football-data.org
const KNOCKOUT_ROUNDS = [
  'ROUND_OF_32',
  'ROUND_OF_16',
  'QUARTER_FINALS',
  'SEMI_FINALS',
  'THIRD_PLACE',
  'FINAL',
];

// Our internal kickoff UTC timestamps for matches 73–104.
// Used to match API fixtures to internal IDs by timestamp (±5 min tolerance).
// These never change — only team names are dynamic.
const STATIC_KICKOFFS = {
  73:  '2026-06-28T19:00:00Z',
  74:  '2026-06-29T17:00:00Z',
  75:  '2026-06-29T20:30:00Z',
  76:  '2026-06-30T01:00:00Z',
  77:  '2026-06-30T17:00:00Z',
  78:  '2026-06-30T21:00:00Z',
  79:  '2026-07-01T01:00:00Z',
  80:  '2026-07-01T16:00:00Z',
  81:  '2026-07-01T20:00:00Z',
  82:  '2026-07-02T00:00:00Z',
  83:  '2026-07-02T19:00:00Z',
  84:  '2026-07-02T23:00:00Z',
  85:  '2026-07-03T03:00:00Z',
  86:  '2026-07-03T18:00:00Z',
  87:  '2026-07-03T22:00:00Z',
  88:  '2026-07-04T01:30:00Z',
  89:  '2026-07-04T17:00:00Z',
  90:  '2026-07-04T21:00:00Z',
  91:  '2026-07-05T20:00:00Z',
  92:  '2026-07-06T00:00:00Z',
  93:  '2026-07-06T19:00:00Z',
  94:  '2026-07-07T00:00:00Z',
  95:  '2026-07-07T16:00:00Z',
  96:  '2026-07-07T20:00:00Z',
  97:  '2026-07-09T20:00:00Z',
  98:  '2026-07-10T19:00:00Z',
  99:  '2026-07-11T21:00:00Z',
  100: '2026-07-12T01:00:00Z',
  101: '2026-07-14T19:00:00Z',
  102: '2026-07-15T19:00:00Z',
  103: '2026-07-18T21:00:00Z',
  104: '2026-07-19T19:00:00Z',
};

// Normalise API team names to match our dataset.
// Add entries here if the API uses different spellings.
const NAME_MAP = {
  "Côte d'Ivoire":        'Ivory Coast',
  "Cote d'Ivoire":        'Ivory Coast',
  'Bosnia & Herzegovina': 'Bosnia and Herzegovina',
  'Bosnia-Herzegovina':   'Bosnia and Herzegovina',
  'United States':        'USA',
  'Cabo Verde':           'Cape Verde',
  'Czech Republic':       'Czechia',
  'Congo DR':             'DR Congo',
  'Congo, DR':            'DR Congo',
  'Dem. Rep. Congo':      'DR Congo',
  'IR Iran':              'Iran',
  'Korea Republic':       'South Korea',
};

// ── UTILS ─────────────────────────────────────────────────────────────────────

function get(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

const log  = msg => process.stdout.write('[sync] ' + msg + '\n');
const fail = msg => { process.stderr.write('[sync] FAIL: ' + msg + '\n'); process.exit(1); };

// ── LOAD EXISTING ─────────────────────────────────────────────────────────────

function loadExisting() {
  try {
    return JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
  } catch (e) {
    fail('Could not read ' + FIXTURES_PATH + ': ' + e.message);
  }
}

// ── FETCH ─────────────────────────────────────────────────────────────────────

async function fetchMatches(apiKey) {
  // Fetch all matches for the competition — filtering by stage server-side
  // is unreliable on football-data.org for tournaments mid-flight.
  // We filter to knockout stages locally below.
  const url = `https://api.football-data.org/v4/competitions/${COMPETITION_CODE}/matches`;
  log('Fetching: ' + url);
  let data;
  try {
    data = await get(url, { 'X-Auth-Token': apiKey });
  } catch (e) {
    fail('API request failed: ' + e.message);
  }
  if (!data.matches || !Array.isArray(data.matches)) {
    fail('Unexpected response shape — missing matches array');
  }
  log('API returned ' + data.matches.length + ' total matches');

  // Filter to knockout rounds only
  // football-data.org stage names for WC 2026 — log all unique stages first for debugging
  const allStages = [...new Set(data.matches.map(m => m.stage))];
  log('All stages in API response: ' + allStages.join(', '));

  const knockoutStages = new Set([
    // football-data.org uses these stage names for World Cup knockout rounds
    'ROUND_OF_32',
    'LAST_32',
    'ROUND_OF_16',
    'LAST_16',
    'QUARTER_FINALS',
    'SEMI_FINALS',
    'THIRD_PLACE',
    'PLAY_OFF_FOR_THIRD_PLACE',
    'FINAL',
  ]);
  const knockout = data.matches.filter(m => knockoutStages.has(m.stage));
  log('Knockout matches found: ' + knockout.length);
  return knockout;
}

// ── VALIDATE ──────────────────────────────────────────────────────────────────

function validate(matches) {
  // Accept any number ≥ 1 — we log all stages above so we can debug further if needed.
  // The real protection is the diff check: we only write if teams actually changed.
  if (matches.length < 1) {
    fail(`0 knockout fixtures returned. Aborting to protect existing data.`);
  }
  const ok = matches.every(m => m.utcDate && m.homeTeam && m.awayTeam);
  if (!ok) fail('One or more fixtures missing required fields (utcDate, homeTeam, awayTeam)');
  log('Validation passed — ' + matches.length + ' knockout fixtures to process');
}

// ── MATCH API → INTERNAL ID ───────────────────────────────────────────────────

const TOLERANCE_MS = 5 * 60 * 1000; // 5 minutes

function findInternalId(apiUtcDate) {
  const apiMs = new Date(apiUtcDate).getTime();
  for (const [id, iso] of Object.entries(STATIC_KICKOFFS)) {
    if (Math.abs(new Date(iso).getTime() - apiMs) <= TOLERANCE_MS) {
      return Number(id);
    }
  }
  return null;
}

function normalise(name) {
  if (!name) return 'TBD';
  return NAME_MAP[name] || name;
}

function isConfirmed(name) {
  if (!name || name === 'TBD') return false;
  // football-data.org uses phrases like "Winner Match 73" for unconfirmed slots
  if (/^(winner|loser|runner|tbd)/i.test(name)) return false;
  return true;
}

// ── BUILD UPDATED LIST ────────────────────────────────────────────────────────

function applyUpdates(existing, apiMatches) {
  const updated = existing.fixtures.map(f => ({ ...f }));
  const byId = Object.fromEntries(updated.map(f => [f.id, f]));
  let changes = 0;

  for (const m of apiMatches) {
    const internalId = findInternalId(m.utcDate);
    if (!internalId) {
      log('  No internal ID for API fixture at ' + m.utcDate);
      continue;
    }

    const rec = byId[internalId];
    if (!rec) continue;

    const apiHome = normalise(m.homeTeam?.name);
    const apiAway = normalise(m.awayTeam?.name);
    const newHome = isConfirmed(apiHome) ? apiHome : rec.home;
    const newAway = isConfirmed(apiAway) ? apiAway : rec.away;

    if (newHome !== rec.home || newAway !== rec.away) {
      log(`  M${internalId}: "${rec.home} vs ${rec.away}" → "${newHome} vs ${newAway}"`);
      rec.home = newHome;
      rec.away = newAway;
      changes++;
    }
  }

  log(`${changes} fixture(s) updated`);
  return { fixtures: updated, changes };
}

// ── WRITE ─────────────────────────────────────────────────────────────────────

function write(existing, fixtures) {
  const out = {
    _meta: { ...existing._meta, lastSynced: new Date().toISOString() },
    fixtures,
  };
  fs.writeFileSync(FIXTURES_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
  log('Wrote ' + FIXTURES_PATH);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.API_FOOTBALL_DATA_KEY;
  if (!apiKey) fail('API_FOOTBALL_DATA_KEY is not set');

  const existing = loadExisting();
  log('Loaded ' + existing.fixtures.length + ' existing records');

  const apiMatches = await fetchMatches(apiKey);
  validate(apiMatches);

  const { fixtures, changes } = applyUpdates(existing, apiMatches);

  if (changes === 0) {
    log('No changes — nothing to write');
    process.exit(0);
  }

  write(existing, fixtures);
  log('Done');
}

main().catch(e => fail(String(e)));
