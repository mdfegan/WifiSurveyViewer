# WiFi Survey Viewer

Open `index.html` through a local static server, for example `python -m http.server 8000 --bind 127.0.0.1`, and open the local URL in a browser. Choose an Android survey GeoJSON export. Leaflet and map tiles use the Internet; the app itself needs no production build or npm dependencies.

## Reading measurements

- **Probe endpoint** selects the primary target, optional local target, or both. Their rolling windows are independent.
- **TCP connect time** and **DNS resolution time** are separate metrics. **Probe failure rate** is the failed-attempt percentage, not measured packet loss. The selected records' overall failures/attempts and unavailable/skipped counts are also shown. The per-point percentage belongs to that endpoint/network's preceding 60-second window.
- **Tested transport** and cellular filtering use the network pinned for the probe in version 2 exports. The observed default route can differ. VPN labels describe Android's logical network capabilities, not a packet capture of its underlying path.
- GPS-less, stale, and inaccurate measurements remain in timelines and summaries. Only usable positions are plotted, and route lines break at missing positions or long sampling gaps. Raw fix diagnostics remain in point details.
- Red baseline dots mark failed/unavailable/skipped probes, even when no successful TCP duration exists. Shaded intervals describe observed probe interruptions. Select an interval or event-log entry to inspect failure counts, timing resolution, and censored start/end observations. A gap between successful probes is not an exact handoff duration.
- Confirmed AP changes are distinct from reassociations and unverified legacy changes. Legacy changes are hidden by default and can be included explicitly; the heatmap uses only confirmed changes. Scan-inferred BSSIDs never become connected APs or inputs to AP estimates. Estimates are heuristics, not surveyed AP coordinates.
- **Survey setup** shows device, mode, endpoints, route, pace, notes, and recording segments. **Event log** separates network events from samples; it shows the latest 100 matching events.

## Compatibility

The viewer accepts the original GeoJSON exports and the version 2 format. Version 2 is a FeatureCollection with top-level `schema_version: 2`, `survey` metadata, and features containing `record_type: sample|hop|event`. Each feature has its own `schema_version`; a new container can include migrated legacy rows. Geometry may be null. `event_data` is an object (a JSON string is also accepted for compatibility).

New fields include `tcp_connect_ms`, `dns_ms`, `probe_status`, `probe_role`, `probe_mode`, `probe_network_id`, `probe_transports`, `probe_failure_percent`, attempt/failure counts, probe/RF timestamps, location quality/age/raw coordinates, and BSSID provenance. Legacy `latency_ms`/`packet_loss_percent` are adapted with a visible warning: their original semantics, route certainty, and fix freshness cannot be improved retrospectively. Legacy latency can include DNS time.

Unknown or malformed numeric values remain missing rather than becoming zero. Network events never inflate sample counts. IDs are namespaced by record type and source position to avoid collisions across SQLite tables.

## Validation

```text
npm ci
npm test
npx playwright-core install chromium
npm run test:browser -- test/fixtures/monitoring-export.json
```

The fixture is synthetic data exported by the Android instrumentation test, containing new and legacy rows plus an unlocated event. Browser checks serve the app locally, intercept its Leaflet CDN requests using the installed matching Leaflet package, and block map tiles for deterministic tests. They cover modern/legacy/GPS-less data, actual-path and endpoint filtering, failure markers, interruptions, confidence, metadata escaping, and mobile layout. Screenshots are written to ignored `test-results/`.
