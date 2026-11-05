const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../survey-data.js');

const feature = (properties = {}, geometry = { type: 'Point', coordinates: [-122, 37] }) =>
  ({ type: 'Feature', geometry, properties: { captured_at: 1000, ...properties } });
const dataset = (...features) => ({ type: 'FeatureCollection', features });
const modern = (p = {}, geometry) => feature({ schema_version: 2, record_type: 'sample', location_quality: 'fresh',
  probe_status: 'success', probe_success: 1, tcp_connect_ms: 12, ...p }, geometry);

test('modern and legacy event types never become measurements', () => {
  const d = D.read(dataset(modern(), feature({ event_type: 'network_lost' }),
    feature({ event_type: 'hop' }), modern({ record_type: 'event', event_type: 'interruption' }, null)));
  assert.equal(d.samples.length, 1); assert.equal(d.hops.length, 1); assert.equal(d.events.length, 2);
  assert.notEqual(d.samples[0].id, d.hops[0].id);
});
test('missing and stale locations remain samples but cannot be mapped', () => {
  const d = D.read(dataset(modern({}, null), modern({ location_quality: 'stale' }),
    modern({}, { type: 'Point', coordinates: [null, null] }), modern({}, { type: 'Point', coordinates: [181, 91] })));
  assert.equal(d.samples.length, 4); assert.ok(d.samples.every(s => !s.mapped && s.lat === null));
});
test('inferred identities are not connected APs', () => {
  for (const source of ['scan', 'inferred']) {
    const s = D.read(dataset(modern({ bssid: 'aa', bssid_source: source }))).samples[0];
    assert.equal(s.props.bssid, null); assert.equal(s.props.inferred_bssid, 'aa'); assert.equal(s.apConfirmed, false);
  }
  assert.equal(D.read(dataset(modern({ bssid: 'aa', bssid_source: 'connected' }))).samples[0].apConfirmed, true);
});
test('actual probe path takes precedence over the default network', () => {
  const s = D.read(dataset(modern({ default_transports: 'Cellular', probe_transports: 'Wi-Fi', transport_cellular: 1 }))).samples[0];
  assert.equal(D.transport(s), 'Wi-Fi');
  assert.equal(D.transport(D.read(dataset(modern())).samples[0]), 'Unavailable');
});
test('legacy metrics remain usable and do not invent DNS or route certainty', () => {
  const s = D.read(dataset(feature({ latency_ms: 23, packet_loss_percent: 3, probe_success: 1 }))).samples[0];
  assert.equal(s.version, 1); assert.equal(s.props.tcp_connect_ms, 23); assert.equal(s.props.probe_failure_percent, 3);
  assert.equal(s.props.dns_ms, null); assert.equal(D.transport(s), 'Unknown');
});
test('failed, unavailable and skipped probes have no successful TCP duration', () => {
  const d = D.read(dataset(modern(), modern({ probe_status: 'failure' }), modern({ probe_status: 'unavailable' }), modern({ probe_status: 'skipped' })));
  assert.ok(d.samples.slice(1).every(s => s.props.tcp_connect_ms === null));
  assert.deepEqual(D.summarize(d.samples), { count: 4, mapped: 4, attempts: 2, failures: 1,
    failurePercent: 50, unavailable: 1, skipped: 1, legacy: 0 });
});
test('null percentages and times do not become zero', () => {
  const s = D.read(dataset(modern({ probe_failure_percent: null, tcp_connect_ms: null, dns_ms: null }))).samples[0];
  assert.equal(s.props.probe_failure_percent, null); assert.equal(s.props.tcp_connect_ms, null); assert.equal(s.props.dns_ms, null);
  assert.equal(D.number(null), null); assert.equal(D.number(''), null); assert.equal(D.number(false), null);
});
test('route segments break at missing positions and sampling gaps', () => {
  const d = D.read(dataset(modern({ captured_at: 1000 }), modern({ captured_at: 2000 }, null),
    modern({ captured_at: 3000 }), modern({ captured_at: 20000 })));
  assert.equal(D.segments(d.samples).length, 3);
  assert.equal(D.segments(d.samples.filter(s => s.mapped)).length, 3, 'filtering must not bridge a missing fix');
});
test('legacy AP changes cannot be counted as confirmed events', () => {
  const d = D.read(dataset(feature({ event_type: 'hop' }), modern({ record_type: 'hop', event_confidence: 'confirmed' })));
  assert.equal(D.confirmedHop(d.hops[0]), false); assert.equal(D.confirmedHop(d.hops[1]), true);
});
test('censored interruptions describe uncertainty rather than an exact roam time', () => {
  const event = D.read(dataset(modern({ record_type: 'event', event_type: 'interruption', event_data: JSON.stringify({
    failed_probe_count: 3, timing_resolution_ms: 900, left_censored: true, right_censored: true
  }) }, null))).events[0];
  const rows = D.eventRows(event);
  assert.ok(rows.some(([k, v]) => k === 'Gap between successful probes' && v === 'Not bounded by two successes'));
  assert.ok(rows.some(([, v]) => String(v).includes('still interrupted')));
});
test('metadata is retained; malformed records are rejected without losing valid ones', () => {
  const data = dataset(modern(), feature({ captured_at: 'bad' }), null);
  data.survey = { name: '<test>', pace: 'walking' };
  const d = D.read(data); assert.equal(d.samples.length, 1); assert.equal(d.rejected, 2); assert.equal(d.metadata.name, '<test>');
  assert.throws(() => D.read({}), /FeatureCollection/);
});

test('disconnected cached WiFi data cannot become a valid RF/AP observation', () => {
  const s = D.read(dataset(modern({ connected: 0, bssid: 'cached', bssid_source: 'connected', rssi_dbm: -50 }))).samples[0];
  assert.equal(s.props.rssi_dbm, null); assert.equal(s.props.bssid, null); assert.equal(s.apConfirmed, false);
});

test('synthetic Android export retains row versions, raw stale fixes and structured events', () => {
  const fs = require('node:fs');
  const raw = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, 'fixtures/monitoring-export.json'), 'utf8'));
  const d = D.read(raw);
  assert.equal(d.samples.length, 3); assert.equal(d.events.length, 1); assert.equal(d.rejected, 0);
  assert.equal(d.samples.filter(s => s.version === 1).length, 1);
  const stale = d.samples.find(s => s.props.location_quality === 'stale');
  assert.ok(stale && !stale.mapped && stale.props.raw_latitude != null);
  assert.equal(d.events[0].props.event_type, 'interruption');
  assert.equal(d.events[0].props.event_data.failed_probe_count, 1);
  assert.equal(d.metadata.name, 'Methodology integration fixture');
});
