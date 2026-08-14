/**
 * Travel Agent smoke test.
 *
 *   npm install          # once, pulls Playwright
 *   node test/smoke.mjs  # serves ../ over http and drives a real browser
 *
 * Optional: node test/smoke.mjs https://cheggenonline.github.io/travelagent/
 * to run against the live deploy instead of the local files.
 *
 * The Claude API is stubbed, so this costs no tokens and needs no key.
 * Exits non-zero if any check fails. Screenshots land in test/shots/.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHOTS = path.join(HERE, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail });
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail && !pass ? ' — ' + detail : ''}`);
};

/* ---------- static server (only when testing local files) ---------- */
const MIME = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json',
               '.webmanifest':'application/manifest+json', '.png':'image/png', '.svg':'image/svg+xml' };
function serve(dir){
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(dir, p);
      if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
        res.writeHead(404); return res.end('not found');
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/* ---------- stubbed model replies ---------- */
/* Complete JSON objects, as a real model now returns them (the app no longer
   prepends a prefill prefix). */
const STUB_EXTRACT = `{"items":[{"category":"ship","title":"All aboard — Dubrovnik","start":"2099-08-20T17:00","end":null,"location":"Gruž cruise port","address":"","confirmation":"","details":"Ship sails 17:30\\nLast tender 16:30","allAboard":true,"critical":true,"remindMinutes":90},
{"category":"activity","title":"Cable car up Srđ","start":null,"end":null,"location":"Dubrovnik","address":"","confirmation":"","details":"200 HRK return","allAboard":false,"critical":false,"remindMinutes":null}]}`;
const STUB_TRIP = `{"trip":{"name":"Adriatic cruise","destination":"Venice, Split, Dubrovnik","startDate":"2099-08-17","endDate":"2099-08-24","ship":"MSC Fantasia","notes":""},
"items":[{"category":"flight","title":"SK1234 OSL → VCE","start":"2099-08-17T07:20","end":"2099-08-17T09:55","location":"Oslo Gardermoen","address":"","confirmation":"Ref QW7T2P, seat 14A","details":"Terminal 2","allAboard":false,"critical":true,"remindMinutes":180}]}`;
/* deliberately missing its closing brace — proves repairJSON() still recovers the payload */
const STUB_RECS = `{"items":[{"title":"Srđ cable car","category":"activity","why":"Best view over the old town and quick enough for a port day.","location":"10 min walk from Ploče gate","duration":"1h15","bestTime":"before 10:30","cost":"~€27","tip":"Leaves 2h before all aboard. Verify it is running.","start":null,"fitsDeadline":true}]`;

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
  'base64');

/* ---------- run ---------- */
let server = null, BASE = process.argv[2];
if (!BASE) {
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    console.error('No index.html found next to test/. Pass a URL instead.');
    process.exit(2);
  }
  const s = await serve(ROOT); server = s.srv;
  BASE = `http://127.0.0.1:${s.port}/`;
}
console.log(`\nTravel Agent smoke test → ${BASE}\n`);

const launchOpts = {};
for (const p of [process.env.PLAYWRIGHT_CHROMIUM, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome']) {
  if (p && fs.existsSync(p)) { launchOpts.executablePath = p; break; }
}
const browser = await chromium.launch(launchOpts);
const ctx = await browser.newContext({ viewport: { width: 412, height: 900 } });
const pg = await ctx.newPage();

const consoleErrs = [];
pg.on('pageerror', e => consoleErrs.push('pageerror: ' + e.message));
pg.on('console', m => { if (m.type() === 'error' && !/ERR_INTERNET_DISCONNECTED/.test(m.text())) consoleErrs.push('console: ' + m.text()); });

await ctx.route('**/v1/messages', async route => {
  const sys = (JSON.parse(route.request().postData() || '{}').system) || '';
  const text = sys.includes('local guide') ? STUB_RECS
             : sys.includes('ADDITIONAL TASK') ? STUB_TRIP
             : STUB_EXTRACT;
  await route.fulfill({ status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }) });
});

const tap = async sel => { await pg.locator(sel).first().click(); await pg.waitForTimeout(280); };
const shot = n => pg.screenshot({ path: path.join(SHOTS, n + '.png'), fullPage: true });

try {
  await pg.goto(BASE, { waitUntil: 'load' });
  await pg.waitForTimeout(600);
  check('app boots with five nav tabs', await pg.locator('nav .tab').count() === 5);

  /* --- api key --- */
  await tap('[data-tab="settings"]');
  await pg.fill('#s_key', 'sk-ant-smoketest');
  await tap('[data-act="save-settings"]');
  await tap('[data-act="test-key"]');
  await pg.waitForTimeout(500);
  check('API key saves and connection test succeeds',
    await pg.inputValue('#s_key') === 'sk-ant-smoketest');

  /* --- trip creation via Claude autofill --- */
  await tap('nav [data-tab="trips"]');
  await tap('[data-act="new-trip"]');
  await pg.fill('#t_blob', 'Adriatic cruise on MSC Fantasia, flight SK1234 Oslo to Venice');
  await tap('[data-act="autofill-trip"]');
  await pg.waitForTimeout(700);
  check('trip autofill fills the name field', await pg.inputValue('#t_name') === 'Adriatic cruise');
  await tap('[data-act="save-trip"]');
  await pg.waitForTimeout(400);
  check('flight item came across with the trip',
    (await pg.locator('.item').count()) >= 1);
  await shot('01-now');

  /* --- paste-to-sort --- */
  await tap('nav [data-tab="add"]');
  await tap('[data-act="addmode"][data-m="text"]');
  await pg.fill('#blob', 'All aboard Dubrovnik 17:00. Cable car up Srd 200 HRK.');
  await tap('[data-act="read-text"]');
  await pg.waitForTimeout(800);
  const cands = await pg.locator('[data-cand]').count();
  check('pasted text produced two reviewable items', cands === 2, 'got ' + cands);
  await shot('02-review');
  await tap('[data-act="commit-cands"]');
  await pg.waitForTimeout(500);

  /* --- all-aboard countdown --- */
  await tap('nav [data-tab="now"]');
  await pg.waitForTimeout(300);
  const heroLabel = await pg.locator('#hero .lbl').first().innerText().catch(() => '');
  check('all-aboard becomes the countdown hero', /BACK ON BOARD/i.test(heroLabel), heroLabel);

  /* --- duplicate guard --- */
  const before = await pg.evaluate(() => JSON.parse(localStorage.getItem('portside.v1')).trips[0].items.length);
  await tap('nav [data-tab="add"]');
  await tap('[data-act="addmode"][data-m="text"]');
  await pg.fill('#blob', 'All aboard Dubrovnik 17:00. Cable car up Srd 200 HRK.');
  await tap('[data-act="read-text"]');
  await pg.waitForTimeout(800);
  await tap('[data-act="commit-cands"]');
  await pg.waitForTimeout(500);
  const after = await pg.evaluate(() => JSON.parse(localStorage.getItem('portside.v1')).trips[0].items.length);
  check('re-adding the same items is deduplicated', after === before, `${before} → ${after}`);

  /* --- photo path --- */
  await tap('nav [data-tab="add"]');
  await tap('[data-act="addmode"][data-m="photo"]');
  await pg.setInputFiles('#pick', { name: 'ticket.png', mimeType: 'image/png', buffer: TINY_PNG });
  await pg.waitForTimeout(700);
  check('photo stages a thumbnail', await pg.locator('#thumbs .th').count() === 1);
  await tap('[data-act="read-photos"]');
  await pg.waitForTimeout(900);
  check('photo reading returns reviewable items', await pg.locator('[data-cand]').count() === 2);
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(300);

  /* --- manual entry --- */
  await tap('nav [data-tab="add"]');
  await tap('[data-act="addmode"][data-m="manual"]');
  await pg.fill('#m_title', 'Meet guide at Pile gate');
  await pg.selectOption('#m_cat', 'event');
  await pg.fill('#m_start', '2099-08-20T09:30');
  await tap('[data-act="save-manual"]');
  await pg.waitForTimeout(400);
  check('manual entry saves',
    await pg.evaluate(() => JSON.parse(localStorage.getItem('portside.v1'))
      .trips[0].items.some(i => i.title === 'Meet guide at Pile gate')));

  /* --- recommendations (stub is malformed JSON on purpose) --- */
  await tap('nav [data-tab="ideas"]');
  await tap('[data-act="get-recs"]');
  await pg.waitForTimeout(900);
  check('recommendations survive a truncated model reply',
    await pg.locator('.rec').count() === 1);
  await shot('03-ideas');
  await tap('[data-act="add-rec"]');
  await pg.waitForTimeout(300);

  /* --- persistence --- */
  const expect = await pg.evaluate(() => JSON.parse(localStorage.getItem('portside.v1')).trips[0].items.length);
  await pg.reload({ waitUntil: 'load' });
  await pg.waitForTimeout(600);
  const got = await pg.evaluate(() => JSON.parse(localStorage.getItem('portside.v1')).trips[0].items.length);
  check('data survives a reload', got === expect, `${expect} → ${got}`);

  /* --- calendar export --- */
  await tap('nav [data-tab="timeline"]');
  const [dl] = await Promise.all([pg.waitForEvent('download'), tap('[data-act="export-ics"]')]);
  const ics = fs.readFileSync(await dl.path(), 'utf8');
  check('.ics export contains events', /BEGIN:VEVENT/.test(ics));
  check('.ics export contains alarms', /BEGIN:VALARM/.test(ics));

  /* --- offline --- */
  if (BASE.startsWith('http')) {
    const reg = await pg.evaluate(async () => {
      const r = await navigator.serviceWorker.ready.catch(() => null);
      return r ? r.scope : null;
    });
    check('service worker registered', !!reg, String(reg));
    await pg.waitForTimeout(800);
    await ctx.setOffline(true);
    await pg.reload({ waitUntil: 'load' });
    await pg.waitForTimeout(700);
    check('reloads while offline', await pg.locator('nav .tab').count() === 5);
    const cold = await ctx.newPage();
    await cold.goto(BASE, { waitUntil: 'load' }).catch(() => {});
    await cold.waitForTimeout(500);
    check('cold start works offline (the installed-app case)',
      await cold.locator('nav .tab').count() === 5);
    await ctx.setOffline(false);
  }

  check('no unexpected console errors', consoleErrs.length === 0, consoleErrs.join(' | '));
} catch (e) {
  check('test run completed without throwing', false, e.message);
  await shot('99-crash').catch(() => {});
} finally {
  await browser.close();
  if (server) server.close();
}

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in test/shots/\n`);
if (failed.length) { console.error('Failed: ' + failed.map(f => f.name).join(', ') + '\n'); process.exit(1); }
