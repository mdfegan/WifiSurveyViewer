const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const D = require('../survey-data.js');
const root = path.resolve(__dirname, '..');
const at = 1700000000000;
function sample(id, extra = {}, geometry = { type: 'Point', coordinates: [-122 + id * .00001, 37] }) {
  return { type: 'Feature', geometry, properties: { _id: id, record_type: 'sample', schema_version: 2,
    captured_at: at + id * 2000, location_quality: 'fresh', location_age_ms: 250, probe_status: 'success',
    probe_success: 1, tcp_connect_ms: 12, dns_ms: 0, probe_role: 'internet', probe_transports: 'Wi-Fi',
    default_transports: 'Cellular', probe_mode: 'wifi_only', probe_network_id: '42', probe_failure_percent: 0,
    probe_window_attempts: 3, probe_window_failures: 0, rssi_dbm: -60, connected: 1,
    bssid: 'aa:bb:cc:dd:ee:01', bssid_source: 'connected', band: '5 GHz', ...extra } };
}
const fixture = { type: 'FeatureCollection', schema_version: 2, survey: { name: 'Browser fixture',
  device_model: 'test handset', probe_mode: 'wifi_only', notes: '<img src=x onerror="window.bad=1">' }, features: [
  sample(1), sample(2, { location_quality: 'stale', probe_status: 'failure', probe_success: 0, probe_error: 'timeout' }, null),
  sample(3, { probe_status: 'unavailable', probe_success: 0, probe_error: 'network_unavailable', probe_transports: 'Unavailable', location_quality: 'missing' }, null),
  sample(4, { probe_role: 'local' }), sample(5, { probe_transports: 'Cellular', probe_mode: 'normal' }),
  { type: 'Feature', geometry: null, properties: { captured_at: at + 6000, schema_version: 2, record_type: 'event', event_type: 'network_lost' } },
  { type: 'Feature', geometry: null, properties: { captured_at: at + 10000, schema_version: 2, record_type: 'event', event_type: 'interruption',
    event_data: { first_failure_at: at + 4000, recovered_at: at + 10000, failed_probe_count: 2, timing_resolution_ms: 900,
      left_censored: false, right_censored: false, gap_between_successes_ms: 8000, probe_role: 'internet' } } },
  { type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 37] }, properties: { _id: 1, captured_at: at + 6000, record_type: 'hop',
    event_type: 'hop', schema_version: 2, location_quality: 'fresh', event_confidence: 'confirmed', from_bssid: 'aa', to_bssid: 'bb',
    observation_start_at: at + 5500, observation_end_at: at + 6000 } }
] };
const legacy = { type: 'FeatureCollection', features: [
  { ...sample(1), properties: { captured_at: at, _id: 1, latency_ms: 40, packet_loss_percent: 3, probe_success: 1, rssi_dbm: -65 } },
  { ...sample(2), properties: { captured_at: at + 2000, _id: 2, latency_ms: 35, probe_success: 1, rssi_dbm: -60 } },
  { ...sample(3), properties: { captured_at: at + 1000, event_type: 'hop', from_bssid: 'aa', to_bssid: 'bb' } },
  { ...sample(4), properties: { captured_at: at + 1000, event_type: 'network_lost' } }
] };

(async () => {
  const server = http.createServer((req, res) => {
    const target = path.resolve(root, '.' + decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', target.endsWith('.js') ? 'text/javascript' : target.endsWith('.css') ? 'text/css' : 'text/html');
    fs.createReadStream(target).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('https://unpkg.com/leaflet@1.9.4/dist/**', route => {
      const asset = new URL(route.request().url()).pathname.split('/').pop();
      const target = path.join(root, 'node_modules/leaflet/dist', asset);
      return fs.existsSync(target) ? route.fulfill({ path: target, contentType: asset.endsWith('.js') ? 'text/javascript' : 'text/css' }) : route.abort();
    });
    await page.route('**/*.tile.openstreetmap.org/**', route => route.abort());
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded' });
    async function load(data, name) {
      await page.locator('#fileInput').setInputFiles({ name, mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(data)) });
      await page.waitForFunction(name => document.querySelector('#datasetName').textContent === name, name);
    }
    await load(fixture, 'modern.geojson');
    assert.equal(await page.locator('.ping-marker').count(), 2);
    assert.match(await page.locator('#summary').innerText(), /Measurements\s*4/i);
    assert.match(await page.locator('#dataQuality').innerText(), /2 measurements have no usable GPS/);
    assert.equal(await page.locator('.timeline-interruption').count(), 1);
    assert.equal(await page.locator('.hop-marker').count(), 1);
    await page.selectOption('#timelineMetric', 'latency');
    assert.equal(await page.locator('.timeline-failure').count(), 2);
    await page.locator('.timeline-failure').first().click();
    assert.match(await page.locator('#hoverCard').innerText(), /stale/);
    await page.click('#clearSelection');
    await page.selectOption('#mapMetric', 'transport');
    await page.selectOption('#cellularFilter', 'only');
    assert.equal(await page.locator('.ping-marker').count(), 1);
    await page.selectOption('#cellularFilter', 'all');
    await page.selectOption('#probeRole', 'local');
    assert.match(await page.locator('#summary').innerText(), /Measurements\s*1/i);
    await page.selectOption('#probeRole', 'internet');
    await page.locator('details').filter({ has: page.locator('#eventLog') }).locator('summary').click();
    await page.getByRole('button', { name: /Probe interruption/ }).click();
    assert.match(await page.locator('#hoverCard').innerText(), /900 ms/);
    assert.equal(await page.evaluate(() => window.bad), undefined);
    fs.mkdirSync(path.join(root, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(root, 'test-results/viewer-modern.png') });

    await load(legacy, 'legacy.geojson');
    assert.match(await page.locator('#summary').innerText(), /Measurements\s*2/i);
    assert.match(await page.locator('#dataQuality').innerText(), /legacy measurements/);
    assert.equal(await page.locator('.hop-marker').count(), 0);
    await page.check('#includeLegacyHops'); assert.equal(await page.locator('.hop-marker').count(), 1);
    await load({ type: 'FeatureCollection', features: [sample(1, { location_quality: 'missing' }, null)] }, 'unlocated.geojson');
    assert.equal(await page.locator('.ping-marker').count(), 0);
    assert.ok(await page.locator('.timeline-dot').count() > 0);

    if (process.argv[2]) {
      const exported = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
      await load(exported, 'android-export.geojson');
      assert.ok(D.read(exported).samples.length > 0);
      assert.match(await page.locator('#summary').innerText(), /Measurements/i);
      await page.screenshot({ path: path.join(root, 'test-results/viewer-android-export.png') });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(root, 'test-results/viewer-mobile.png') });
    assert.deepEqual(errors, [], 'no browser runtime errors');
    console.log('PASS: modern/legacy/unlocated files, correct map counts, path and endpoint filters, failures, interruptions, AP confidence, metadata escaping, and mobile layout.');
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
