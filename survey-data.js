(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SurveyData = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  const number = value => value == null || value === "" || typeof value === "boolean" ? null
    : Number.isFinite(Number(value)) ? Number(value) : null;
  const truth = value => value === true || value === 1 || value === "1";
  function read(input) {
    if (!input || input.type !== "FeatureCollection" || !Array.isArray(input.features)) {
      throw new Error("Expected a GeoJSON FeatureCollection.");
    }
    const samples = [], hops = [], events = [];
    let rejected = 0;
    input.features.forEach((feature, index) => {
      if (!feature || feature.type !== "Feature") { rejected++; return; }
      const p = { ...(feature.properties || {}) };
      const at = number(p.captured_at);
      if (at == null || Math.abs(at) > 8.64e15) { rejected++; return; }
      const version = number(p.schema_version) || 1;
      const type = p.record_type || (p.event_type === "hop" ? "hop" : p.event_type && p.event_type !== "sample" ? "event" : "sample");
      const coords = feature.geometry?.type === "Point" ? feature.geometry.coordinates : null;
      const lon = Array.isArray(coords) ? number(coords[0]) : null;
      const lat = Array.isArray(coords) ? number(coords[1]) : null;
      const mapped = lon != null && lat != null && Math.abs(lon) <= 180 && Math.abs(lat) <= 90
        && (version < 2 || p.location_quality === "fresh");
      const inferred = p.bssid_source === "scan" || p.bssid_source === "inferred";
      if (inferred) { p.inferred_bssid = p.inferred_bssid || p.bssid; p.bssid = null; }
      p.tcp_connect_ms = number(version >= 2 ? p.tcp_connect_ms : p.latency_ms);
      p.dns_ms = number(p.dns_ms);
      p.probe_failure_percent = number(version >= 2 ? p.probe_failure_percent : p.packet_loss_percent);
      p.probe_role = p.probe_role || "internet";
      p.probe_status = p.probe_status || (p.probe_success == null ? "unknown" : truth(p.probe_success) ? "success" : "failure");
      p.rssi_dbm = number(p.rssi_dbm);
      if (p.rssi_dbm == null || p.rssi_dbm <= -126 || p.rssi_dbm >= 0 || p.connected != null && !truth(p.connected)) p.rssi_dbm = null;
      if (p.connected != null && !truth(p.connected)) p.bssid = null;
      if (p.probe_status !== "success") p.tcp_connect_ms = null;
      let data = p.event_data;
      if (typeof data === "string") { try { data = JSON.parse(data); } catch (_) { data = {}; } }
      p.event_data = data && typeof data === "object" && !Array.isArray(data) ? data : {};
      const item = { id: `${type}:${p._id ?? index}:${index}`, capturedAt: at, lon: mapped ? lon : null,
        lat: mapped ? lat : null, mapped, version, props: p,
        apConfirmed: !inferred && p.bssid != null && (p.bssid_source === "connected" || p.bssid_source === "confirmed") };
      if (type === "sample") samples.push(item);
      else if (type === "hop" || p.event_type === "hop") hops.push(item);
      else events.push(item);
    });
    const sort = list => list.sort((a, b) => a.capturedAt - b.capturedAt);
    sort(samples);
    let segment = 0, previous = null;
    for (const sample of samples) {
      if (!sample.mapped || previous && sample.capturedAt - previous.capturedAt > Math.max(5000, (number(sample.props.probe_interval_ms) || 2000) * 3)) segment++;
      sample.routeSegment = segment; previous = sample;
    }
    return { samples, hops: sort(hops), events: sort(events),
      metadata: input.survey && typeof input.survey === "object" ? input.survey : {}, rejected };
  }
  function transport(sample) {
    const p = sample.props;
    if (sample.version >= 2) return p.probe_transports || "Unavailable";
    return p.default_transports || (p.band === "Cellular" ? "Cellular" : "Unknown");
  }
  function confirmedHop(hop) { return hop.version >= 2 && hop.props.event_confidence === "confirmed"; }
  function segments(samples) {
    const result = []; let current = [], previous = null;
    for (const sample of samples) {
      const changedSegment = previous && sample.routeSegment != null && sample.routeSegment !== previous.routeSegment;
      const gap = previous && sample.capturedAt - previous.capturedAt > Math.max(5000, (number(sample.props.probe_interval_ms) || 2000) * 3);
      if (!sample.mapped || gap || changedSegment) { if (current.length) result.push(current); current = []; }
      if (sample.mapped) current.push([sample.lat, sample.lon]);
      previous = sample;
    }
    if (current.length) result.push(current);
    return result;
  }
  function summarize(samples) {
    const attempts = samples.filter(s => ["success", "failure"].includes(s.props.probe_status));
    const failures = attempts.filter(s => s.props.probe_status === "failure").length;
    return { count: samples.length, mapped: samples.filter(s => s.mapped).length, attempts: attempts.length,
      failures, failurePercent: attempts.length ? 100 * failures / attempts.length : null,
      unavailable: samples.filter(s => s.props.probe_status === "unavailable").length,
      skipped: samples.filter(s => s.props.probe_status === "skipped").length,
      legacy: samples.filter(s => s.version < 2).length };
  }
  function eventLabel(event) {
    if (event.props.event_type === "hop" || event.id.startsWith("hop:")) {
      return confirmedHop(event) ? "Confirmed AP change" : "Unverified legacy AP change";
    }
    const type = event.props.event_type || "event";
    return ({ interruption: "Probe interruption", reassociation: "Reassociation after an observation gap",
      network_lost: "Default network lost", network_available: "Default network available",
      collector_error: "Collection error", survey_started: "Survey segment started", survey_stopped: "Survey segment stopped"
    })[type] || type.replaceAll("_", " ");
  }
  function eventRows(event) {
    const p = event.props, data = p.event_data || {};
    const rows = [["Event", eventLabel(event)], ["Location", event.mapped ? "Mapped" : p.location_quality || "Not available"]];
    if (p.from_bssid || data.from_bssid) rows.push(["From AP", p.from_bssid || data.from_bssid]);
    if (p.to_bssid || data.to_bssid) rows.push(["To AP", p.to_bssid || data.to_bssid]);
    if (p.observation_start_at != null && p.observation_end_at != null) {
      rows.push(["AP observation interval", `${p.observation_end_at - p.observation_start_at} ms (not exact roam duration)`]);
    }
    if (p.event_type === "interruption") {
      rows.push(["Failed / unavailable probes", data.failed_probe_count ?? "unknown"],
        ["Gap between successful probes", data.gap_between_successes_ms == null ? "Not bounded by two successes" : `${data.gap_between_successes_ms} ms`],
        ["Timing resolution", data.timing_resolution_ms == null ? "unknown" : `${data.timing_resolution_ms} ms`],
        ["Start / end", `${data.left_censored ? "Started without a prior success" : "Prior success observed"}; ${data.right_censored ? "still interrupted when recording stopped" : "recovery observed"}`]);
    }
    for (const [key, value] of Object.entries(data)) if (value != null) rows.push([key, typeof value === "object" ? JSON.stringify(value) : value]);
    if (p.details) rows.push(["Details", p.details]);
    return rows;
  }
  return { number, truth, read, transport, confirmedHop, segments, summarize, eventLabel, eventRows };
});
