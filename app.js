(function () {
  const DEFAULT_GEOJSON = "ramp-wifi-20260705-012256.geojson";

  const metricOptions = {
    rssi: {
      label: "RSSI",
      unit: "dBm",
      field: "rssi_dbm",
      domain: () => [-95, -45],
      goodHigh: true,
      missing: (value) => value == null,
      format: (value) => value == null ? "n/a" : `${Math.round(value)} dBm`,
      legendMin: "-95 dBm",
      legendMax: "-45 dBm"
    },
    packetLoss: {
      label: "Packet loss",
      unit: "%",
      field: "packet_loss_percent",
      domain: () => [0, 10],
      goodHigh: false,
      missing: (value) => value == null,
      format: (value) => value == null ? "n/a" : `${Number(value).toFixed(value % 1 ? 1 : 0)}%`,
      legendMin: "0%",
      legendMax: "10%+"
    },
    linkSpeed: {
      label: "Link speed",
      unit: "Mbps",
      field: "link_speed_mbps",
      domain: (samples) => [0, Math.max(600, maxMetric(samples, "link_speed_mbps"))],
      goodHigh: true,
      missing: (value) => value == null || Number(value) < 0,
      format: (value) => value == null || Number(value) < 0 ? "n/a" : `${Math.round(value)} Mbps`,
      legendMin: "0 Mbps",
      legendMax: (samples) => `${Math.max(600, maxMetric(samples, "link_speed_mbps"))} Mbps`
    },
    latency: {
      label: "Latency",
      unit: "ms",
      field: "latency_ms",
      domain: (samples) => [0, Math.max(50, percentile(metricValues(samples, "latency_ms"), 0.95))],
      goodHigh: false,
      missing: (value) => value == null,
      format: (value) => value == null ? "timeout" : `${Math.round(value)} ms`,
      legendMin: "0 ms",
      legendMax: (samples) => `${Math.round(Math.max(50, percentile(metricValues(samples, "latency_ms"), 0.95)))} ms p95`
    },
    band: {
      label: "Band / cellular"
    },
    ap: {
      label: "Connected AP",
      field: "bssid"
    }
  };

  const timelineMetricKeys = ["rssi", "packetLoss", "linkSpeed", "latency"];
  const mapMetricKeys = ["rssi", "packetLoss", "linkSpeed", "latency", "band", "ap"];
  const categoricalColors = [
    "#0f766e", "#2563eb", "#a21caf", "#e11d48", "#ca8a04", "#16a34a",
    "#7c3aed", "#ea580c", "#0891b2", "#be123c", "#4d7c0f", "#4338ca",
    "#b45309", "#0e7490", "#9f1239", "#15803d", "#6d28d9", "#c2410c",
    "#0369a1", "#854d0e", "#047857", "#7e22ce", "#dc2626", "#1d4ed8"
  ];
  const bandColors = {
    "Cellular": "#e11d48",
    "2.4 GHz": "#2563eb",
    "5 GHz": "#16a34a",
    "6 GHz": "#7c3aed",
    "Other": "#64748b"
  };
  const ADJACENT_AP_COLOR = "#f97316";
  const AP_ESTIMATE_COLOR = "#111827";

  const state = {
    map: null,
    samples: [],
    hops: [],
    apColors: new Map(),
    markers: new Map(),
    timelineDots: new Map(),
    route: null,
    hopLayer: null,
    hopHeatLayer: null,
    apEstimateLayer: null,
    selectedId: null,
    activeId: null,
    datasetLabel: DEFAULT_GEOJSON,
    timelineZoom: 1,
    cellularFilter: "all",
    apFilter: null,
    apFilterAnchorAt: null,
    showAdjacentAps: false,
    showApEstimates: false,
    showMapHops: true,
    showHopHeatmap: false,
    apContext: null
  };

  const els = {
    datasetName: document.getElementById("datasetName"),
    fileInput: document.getElementById("fileInput"),
    mapMetric: document.getElementById("mapMetric"),
    timelineMetric: document.getElementById("timelineMetric"),
    cellularFilter: document.getElementById("cellularFilter"),
    showApEstimates: document.getElementById("showApEstimates"),
    showMapHops: document.getElementById("showMapHops"),
    showHopHeatmap: document.getElementById("showHopHeatmap"),
    previousApFilter: document.getElementById("previousApFilter"),
    clearApFilter: document.getElementById("clearApFilter"),
    nextApFilter: document.getElementById("nextApFilter"),
    showAdjacentAps: document.getElementById("showAdjacentAps"),
    legend: document.getElementById("legend"),
    summary: document.getElementById("summary"),
    hoverCard: document.getElementById("hoverCard"),
    timelineSvg: document.getElementById("timelineSvg"),
    timelineWrap: document.getElementById("timelineWrap"),
    timelineTitle: document.getElementById("timelineTitle"),
    timelineSubtitle: document.getElementById("timelineSubtitle"),
    timelineZoomOut: document.getElementById("timelineZoomOut"),
    timelineZoomIn: document.getElementById("timelineZoomIn"),
    timelineZoomReset: document.getElementById("timelineZoomReset"),
    timelineZoomLabel: document.getElementById("timelineZoomLabel"),
    clearSelection: document.getElementById("clearSelection")
  };

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    populateMetricControls();
    state.map = L.map("map", {
      maxZoom: 22,
      zoomControl: true
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxNativeZoom: 19,
      maxZoom: 22,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(state.map);

    els.mapMetric.value = "rssi";
    els.timelineMetric.value = "rssi";
    els.mapMetric.addEventListener("change", () => {
      renderMapColors();
      renderLegend();
    });
    els.timelineMetric.addEventListener("change", renderTimeline);
    els.cellularFilter.addEventListener("change", handleCellularFilterChange);
    els.showApEstimates.addEventListener("change", handleApEstimatesChange);
    els.showMapHops.addEventListener("change", handleMapHopDisplayChange);
    els.showHopHeatmap.addEventListener("change", handleMapHopDisplayChange);
    els.fileInput.addEventListener("change", handleFilePick);
    els.clearSelection.addEventListener("click", clearSelection);
    els.previousApFilter.addEventListener("click", () => stepApFilter(-1));
    els.clearApFilter.addEventListener("click", clearApFilter);
    els.nextApFilter.addEventListener("click", () => stepApFilter(1));
    els.showAdjacentAps.addEventListener("change", handleAdjacentApsChange);
    document.addEventListener("click", handleSampleActionClick);
    els.timelineZoomOut.addEventListener("click", () => setTimelineZoom(state.timelineZoom / 1.5));
    els.timelineZoomIn.addEventListener("click", () => setTimelineZoom(state.timelineZoom * 1.5));
    els.timelineZoomReset.addEventListener("click", () => setTimelineZoom(1));
    els.timelineWrap.addEventListener("wheel", handleTimelineWheel, { passive: false });
    window.addEventListener("resize", debounce(handleResize, 120));

    loadDefaultSurvey();
  }

  function populateMetricControls() {
    for (const key of mapMetricKeys) {
      els.mapMetric.append(new Option(metricOptions[key].label, key));
    }
    for (const key of timelineMetricKeys) {
      els.timelineMetric.append(new Option(metricOptions[key].label, key));
    }
  }

  async function loadDefaultSurvey() {
    try {
      const response = await fetch(DEFAULT_GEOJSON);
      if (response.status === 404) {
        showEmptyStart();
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const geojson = await response.json();
      loadSurvey(geojson, DEFAULT_GEOJSON);
    } catch (error) {
      showEmptyStart();
      console.error(error);
    }
  }

  function handleFilePick(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        loadSurvey(JSON.parse(reader.result), file.name);
      } catch (error) {
        showEmpty("That file could not be parsed as GeoJSON.");
        console.error(error);
      }
    };
    reader.readAsText(file);
  }

  function loadSurvey(geojson, label) {
    const features = Array.isArray(geojson.features) ? geojson.features : [];
    const samples = [];
    const hops = [];

    for (const feature of features) {
      if (!feature || !feature.geometry || feature.geometry.type !== "Point") continue;
      const props = feature.properties || {};
      const coords = feature.geometry.coordinates || [];
      const item = {
        id: props._id ?? `${samples.length}-${props.captured_at ?? ""}`,
        lon: Number(coords[0]),
        lat: Number(coords[1]),
        capturedAt: Number(props.captured_at),
        props
      };
      if (!Number.isFinite(item.lon) || !Number.isFinite(item.lat) || !Number.isFinite(item.capturedAt)) continue;
      if (props.event_type === "hop") hops.push(item);
      else samples.push(item);
    }

    state.samples = samples.sort((a, b) => a.capturedAt - b.capturedAt);
    state.hops = hops.sort((a, b) => a.capturedAt - b.capturedAt);
    state.datasetLabel = label;
    state.selectedId = null;
    state.activeId = null;
    state.timelineZoom = 1;
    state.cellularFilter = "all";
    state.apFilter = null;
    state.apFilterAnchorAt = null;
    state.showAdjacentAps = false;
    state.showApEstimates = false;
    state.showMapHops = true;
    state.showHopHeatmap = false;
    els.cellularFilter.value = state.cellularFilter;
    els.showAdjacentAps.checked = state.showAdjacentAps;
    els.showApEstimates.checked = state.showApEstimates;
    els.showMapHops.checked = state.showMapHops;
    els.showHopHeatmap.checked = state.showHopHeatmap;
    buildApColors();
    renderAll();
  }

  function handleCellularFilterChange() {
    state.cellularFilter = els.cellularFilter.value;
    invalidateApContext();
    reconcileSelectionWithVisibleSamples();
    renderAll();
  }

  function handleSampleActionClick(event) {
    const button = event.target.closest("[data-sample-action]");
    if (!button) return;
    const action = button.dataset.sampleAction;
    if (action === "filter-ap") {
      applyApFilter(button.dataset.bssid, Number(button.dataset.capturedAt));
    } else if (action === "clear-ap-filter") {
      clearApFilter();
    }
  }

  function applyApFilter(bssid, anchorAt) {
    if (!bssid) return;
    state.apFilter = bssid;
    invalidateApContext();
    state.apFilterAnchorAt = Number.isFinite(anchorAt) ? anchorAt : firstSampleForAp(bssid)?.capturedAt ?? null;
    invalidateApContext();
    reconcileSelectionWithVisibleSamples();
    renderAll();
  }

  function clearApFilter() {
    state.apFilter = null;
    state.apFilterAnchorAt = null;
    state.showAdjacentAps = false;
    els.showAdjacentAps.checked = false;
    invalidateApContext();
    reconcileSelectionWithVisibleSamples();
    renderAll();
  }

  function handleAdjacentApsChange() {
    state.showAdjacentAps = els.showAdjacentAps.checked;
    invalidateApContext();
    reconcileSelectionWithVisibleSamples();
    renderAll();
  }

  function handleApEstimatesChange() {
    state.showApEstimates = els.showApEstimates.checked;
    renderMap();
    renderSummary();
    renderLegend();
  }

  function handleMapHopDisplayChange() {
    state.showMapHops = els.showMapHops.checked;
    state.showHopHeatmap = els.showHopHeatmap.checked;
    renderMap();
    renderLegend();
  }

  function stepApFilter(direction) {
    if (!state.apFilter) return;
    const runs = apRuns();
    const currentIndex = focusedApRunIndex(runs);
    const nextIndex = currentIndex + direction;
    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= runs.length) return;
    state.apFilter = runs[nextIndex].bssid;
    state.apFilterAnchorAt = runs[nextIndex].startAt;
    state.selectedId = runs[nextIndex].startId;
    state.activeId = null;
    invalidateApContext();
    renderAll();
  }

  function reconcileSelectionWithVisibleSamples() {
    const samples = visibleSamples();
    if (!samples.some((sample) => String(sample.id) === String(state.selectedId))) {
      state.selectedId = null;
      hideHoverCard();
    }
    if (!samples.some((sample) => String(sample.id) === String(state.activeId))) {
      state.activeId = null;
    }
  }

  function renderAll() {
    invalidateApContext();
    els.datasetName.textContent = state.datasetLabel;
    renderMap();
    renderSummary();
    renderApFilterControl();
    renderLegend();
    renderTimeline();
    refreshVisibleSampleCard();
    refreshMapSize();
  }

  function handleResize() {
    refreshMapSize();
    renderTimeline();
  }

  function refreshMapSize() {
    state.map.invalidateSize();
    window.setTimeout(() => state.map.invalidateSize(), 100);
    window.setTimeout(() => state.map.invalidateSize(), 350);
  }

  function renderMap() {
    const samples = visibleSamples();
    const hops = visibleHops(samples);
    const apEstimates = state.showApEstimates ? estimateApLocations(samples) : [];
    if (state.route) state.route.remove();
    if (state.hopLayer) state.hopLayer.remove();
    if (state.hopHeatLayer) state.hopHeatLayer.remove();
    if (state.apEstimateLayer) state.apEstimateLayer.remove();
    for (const marker of state.markers.values()) marker.remove();
    state.markers.clear();

    if (!state.samples.length) {
      showEmpty("No point samples found in this GeoJSON.");
      return;
    }

    if (!samples.length) {
      els.datasetName.textContent = state.datasetLabel;
      state.hopLayer = L.layerGroup().addTo(state.map);
      state.hopHeatLayer = L.layerGroup().addTo(state.map);
      state.apEstimateLayer = L.layerGroup().addTo(state.map);
      return;
    }

    const latLngs = samples.map((sample) => [sample.lat, sample.lon]);
    state.route = L.polyline(latLngs, { className: "route-line" }).addTo(state.map);

    for (const sample of samples) {
      const marker = L.circleMarker([sample.lat, sample.lon], markerStyle(sample))
        .bindPopup(samplePopup(sample))
        .on("mouseover", () => setActive(sample.id, true))
        .on("mouseout", () => setActive(null, true))
        .on("click", () => selectSample(sample.id));
      marker.addTo(state.map);
      state.markers.set(String(sample.id), marker);
    }

    state.hopLayer = L.layerGroup();
    if (state.showMapHops) {
      for (const hop of hops) {
        L.marker([hop.lat, hop.lon], { icon: hopIcon(hop) })
          .bindPopup(hopPopup(hop))
          .on("mouseover", () => showHopCard(hop))
          .on("mouseout", hideHoverCard)
          .addTo(state.hopLayer);
      }
    }
    state.hopLayer.addTo(state.map);

    state.hopHeatLayer = L.layerGroup();
    if (state.showHopHeatmap) {
      for (const heatPoint of hopHeatPoints(hops)) {
        L.circleMarker([heatPoint.lat, heatPoint.lon], hopHeatStyle(heatPoint))
          .bindPopup(hopHeatPopup(heatPoint))
          .addTo(state.hopHeatLayer);
      }
    }
    state.hopHeatLayer.addTo(state.map);

    state.apEstimateLayer = L.layerGroup();
    for (const estimate of apEstimates) {
      L.circleMarker([estimate.lat, estimate.lon], apEstimateStyle(estimate))
        .bindPopup(apEstimatePopup(estimate))
        .addTo(state.apEstimateLayer);
    }
    state.apEstimateLayer.addTo(state.map);
    state.map.fitBounds(state.route.getBounds().pad(0.18));
  }

  function renderMapColors() {
    for (const sample of visibleSamples()) {
      const marker = state.markers.get(String(sample.id));
      if (!marker) continue;
      marker.setStyle(markerStyle(sample));
      marker._path.classList.toggle("is-selected", String(sample.id) === String(state.selectedId));
      marker._path.classList.toggle("is-active", String(sample.id) === String(state.activeId));
    }
  }

  function markerStyle(sample) {
    const selected = String(sample.id) === String(state.selectedId);
    const active = String(sample.id) === String(state.activeId);
    return {
      radius: selected ? 9 : active ? 8 : 6,
      fillColor: colorForSample(sample, els.mapMetric.value),
      fillOpacity: 0.86,
      color: selected || active ? "#0b1720" : "#ffffff",
      weight: selected || active ? 3 : 1.25,
      opacity: 1,
      className: "ping-marker"
    };
  }

  function colorForSample(sample, metricKey) {
    if (isAdjacentApSample(sample)) return ADJACENT_AP_COLOR;
    if (metricKey === "band") return bandColors[connectionBandCategory(sample)] || bandColors.Other;
    if (metricKey === "ap") return state.apColors.get(sample.props.bssid) || "#64748b";
    const metric = metricOptions[metricKey];
    const value = metricNumber(sample, metric);
    if (value == null) return "#94a3b8";
    const [min, max] = metric.domain(visibleSamples());
    const ratio = clamp((value - min) / (max - min), 0, 1);
    return metric.goodHigh ? rampRedYellowGreen(ratio) : rampGreenYellowRed(ratio);
  }

  function apEstimateStyle(estimate) {
    return {
      radius: estimate.confidence === "high" ? 10 : estimate.confidence === "medium" ? 8 : 7,
      fillColor: AP_ESTIMATE_COLOR,
      fillOpacity: 0.88,
      color: "#ffffff",
      weight: 2,
      opacity: 1,
      className: `ap-estimate-marker confidence-${estimate.confidence}`
    };
  }

  function apEstimatePopup(estimate) {
    const rows = [
      ["BSSID", estimate.bssid],
      ["SSID", estimate.ssid || "n/a"],
      ["Samples", estimate.sampleCount],
      ["Strongest RSSI", metricOptions.rssi.format(estimate.maxRssi)],
      ["Mean RSSI", metricOptions.rssi.format(estimate.meanRssi)],
      ["Scatter radius", `${Math.round(estimate.scatterM)} m`],
      ["Confidence", estimate.confidence],
      ["Latitude", estimate.lat.toFixed(7)],
      ["Longitude", estimate.lon.toFixed(7)]
    ];
    return `<strong>Estimated AP location</strong><dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join("")}</dl>`;
  }

  function renderSummary() {
    const samples = visibleSamples();
    const hops = visibleHops(samples);
    const apEstimateCount = state.showApEstimates ? estimateApLocations(samples).length : 0;
    const durationMs = samples.length ? samples[samples.length - 1].capturedAt - samples[0].capturedAt : 0;
    const ssids = unique(samples.map((sample) => sample.props.ssid).filter(Boolean));
    const apCount = unique(samples.map((sample) => sample.props.bssid).filter(Boolean)).length;
    const items = [
      ["Points", samples.length.toLocaleString()],
      ["Cellular", state.samples.filter(isCellularSample).length.toLocaleString()],
      ["AP filter", state.apFilter || "All"],
      ["Adjacent", state.apFilter && state.showAdjacentAps ? "Shown" : "Hidden"],
      ["AP estimates", state.showApEstimates ? apEstimateCount.toLocaleString() : "Hidden"],
      ["AP hops", hops.length.toLocaleString()],
      ["Duration", formatDuration(durationMs)],
      ["SSID", ssids.length === 1 ? ssids[0] : `${ssids.length} SSIDs`],
      ["Unique APs", apCount.toLocaleString()],
      ["Started", samples.length ? formatTime(samples[0].capturedAt) : "n/a"]
    ];
    els.summary.replaceChildren(...items.map(([term, value]) => {
      const wrapper = document.createElement("div");
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = term;
      dd.textContent = value;
      wrapper.append(dt, dd);
      return wrapper;
    }));
  }

  function renderApFilterControl() {
    const runs = apRuns();
    const currentIndex = focusedApRunIndex(runs);
    els.clearApFilter.textContent = state.apFilter || "All APs";
    els.clearApFilter.disabled = !state.apFilter;
    els.previousApFilter.disabled = !state.apFilter || currentIndex <= 0;
    els.nextApFilter.disabled = !state.apFilter || currentIndex < 0 || currentIndex >= runs.length - 1;
    els.showAdjacentAps.disabled = !state.apFilter;
    els.showAdjacentAps.checked = Boolean(state.apFilter && state.showAdjacentAps);
  }

  function renderLegend() {
    const samples = visibleSamples();
    const metricKey = els.mapMetric.value;
    const metric = metricOptions[metricKey];
    els.legend.innerHTML = "";
    const title = document.createElement("div");
    title.className = "legend-title";
    title.textContent = metric.label;
    els.legend.append(title);
    if (state.apFilter && state.showAdjacentAps) {
      els.legend.append(adjacentApLegendItem());
    }
    if (state.showHopHeatmap) {
      els.legend.append(hopHeatLegendItem());
    }

    if (metricKey === "band") {
      renderCategoryLegend(groupCounts(samples.map(connectionBandCategory)), (category) => bandColors[category] || bandColors.Other);
      return;
    }

    if (metricKey === "ap") {
      renderCategoryLegend(groupCounts(samples.map((sample) => sample.props.bssid || "Unknown")), (bssid) => state.apColors.get(bssid) || "#64748b", true);
      return;
    }

    const bar = document.createElement("div");
    bar.className = "gradient-bar";
    bar.style.background = metric.goodHigh
      ? "linear-gradient(90deg, #dc2626, #facc15, #16a34a)"
      : "linear-gradient(90deg, #16a34a, #facc15, #dc2626)";
    const scale = document.createElement("div");
    scale.className = "legend-scale";
    const maxLabel = typeof metric.legendMax === "function" ? metric.legendMax(samples) : metric.legendMax;
    scale.innerHTML = `<span>${metric.legendMin}</span><span>${maxLabel}</span>`;
    els.legend.append(bar, scale);
  }

  function renderCategoryLegend(counts, colorForValue, useCode) {
    const list = document.createElement("div");
    list.className = "category-list";
    for (const [value, count] of counts) {
      const item = document.createElement("div");
      item.className = "category-item";
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = colorForValue(value);
      const label = document.createElement(useCode ? "code" : "span");
      label.textContent = value;
      const number = document.createElement("span");
      number.textContent = count;
      item.append(swatch, label, number);
      list.append(item);
    }
    els.legend.append(list);
  }

  function adjacentApLegendItem() {
    const item = document.createElement("div");
    item.className = "adjacent-ap-legend";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = ADJACENT_AP_COLOR;
    const label = document.createElement("span");
    label.textContent = "Adjacent AP pings";
    item.append(swatch, label);
    return item;
  }

  function hopHeatLegendItem() {
    const item = document.createElement("div");
    item.className = "hop-heat-legend";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = "#dc2626";
    const label = document.createElement("span");
    label.textContent = "AP hop heat";
    item.append(swatch, label);
    return item;
  }

  function renderTimeline() {
    const samples = visibleSamples();
    const hops = visibleHops(samples);
    const svg = els.timelineSvg;
    svg.replaceChildren();
    if (!state.samples.length) return;

    const wrapStyle = window.getComputedStyle(els.timelineWrap);
    const horizontalPadding = parseFloat(wrapStyle.paddingLeft) + parseFloat(wrapStyle.paddingRight);
    const viewportWidth = Math.max(360, Math.floor(els.timelineWrap.clientWidth - horizontalPadding));
    const width = Math.max(viewportWidth, Math.floor(viewportWidth * state.timelineZoom));
    const height = Math.max(160, Math.floor(els.timelineWrap.clientHeight));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.style.width = `${width}px`;
    updateTimelineZoomLabel();

    const metricKey = els.timelineMetric.value;
    const metric = metricOptions[metricKey];
    els.timelineTitle.textContent = `${metric.label} Timeline`;
    if (!samples.length) {
      els.timelineSubtitle.textContent = "No pings match the current cellular filter.";
      drawText(svg, width / 2, height / 2, "No matching pings", "empty-state", "middle");
      state.timelineDots.clear();
      return;
    }
    els.timelineSubtitle.textContent = `${hops.length} AP changes marked across ${formatDuration(samples[samples.length - 1].capturedAt - samples[0].capturedAt)}.`;

    const margin = { top: 18, right: 22, bottom: 28, left: 54 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const tMin = samples[0].capturedAt;
    const tMax = samples[samples.length - 1].capturedAt;
    const [yMin, yMax] = metric.domain(samples);
    const x = (time) => margin.left + ((time - tMin) / Math.max(1, tMax - tMin)) * plotW;
    const y = (value) => margin.top + (1 - clamp((value - yMin) / Math.max(1, yMax - yMin), 0, 1)) * plotH;
    const baseline = margin.top + plotH;

    drawGrid(svg, width, height, margin, yMin, yMax, metric, samples);
    drawHops(svg, x, margin, plotH, hops);

    const valid = samples
      .map((sample) => ({ sample, value: metricNumber(sample, metric) }))
      .filter((point) => point.value != null);

    if (!valid.length) {
      drawText(svg, width / 2, height / 2, "No values available for this metric", "empty-state", "middle");
      return;
    }

    const lineParts = [];
    let current = [];
    for (const sample of samples) {
      const value = metricNumber(sample, metric);
      if (value == null) {
        if (current.length) lineParts.push(current);
        current = [];
      } else {
        current.push({ sample, value });
      }
    }
    if (current.length) lineParts.push(current);

    for (const part of lineParts) {
      const linePath = part.map((point, index) => `${index ? "L" : "M"} ${x(point.sample.capturedAt).toFixed(2)} ${y(point.value).toFixed(2)}`).join(" ");
      const areaPath = `${linePath} L ${x(part[part.length - 1].sample.capturedAt).toFixed(2)} ${baseline} L ${x(part[0].sample.capturedAt).toFixed(2)} ${baseline} Z`;
      drawPath(svg, areaPath, "timeline-area");
      drawPath(svg, linePath, "timeline-line");
    }

    state.timelineDots.clear();
    for (const point of valid) {
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", x(point.sample.capturedAt));
      dot.setAttribute("cy", y(point.value));
      dot.setAttribute("r", "4");
      dot.setAttribute("class", timelineDotClass(point.sample));
      dot.addEventListener("mouseenter", () => setActive(point.sample.id, true));
      dot.addEventListener("mouseleave", () => setActive(null, true));
      dot.addEventListener("click", () => selectSample(point.sample.id));
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = `${formatTime(point.sample.capturedAt)} - ${metric.format(point.value)} - ${point.sample.props.bssid || "Unknown AP"}`;
      dot.append(title);
      svg.append(dot);
      state.timelineDots.set(String(point.sample.id), dot);
    }
    applyHighlightClasses();
    if (state.selectedId) scrollTimelineToSample(state.selectedId, false);
  }

  function drawGrid(svg, width, height, margin, yMin, yMax, metric, samples) {
    const plotH = height - margin.top - margin.bottom;
    const plotW = width - margin.left - margin.right;
    for (let i = 0; i <= 4; i++) {
      const yPos = margin.top + (plotH * i) / 4;
      const value = yMax - ((yMax - yMin) * i) / 4;
      drawLine(svg, margin.left, yPos, width - margin.right, yPos, "timeline-grid");
      drawText(svg, margin.left - 8, yPos + 4, metric.format(value), "timeline-axis", "end");
    }
    drawLine(svg, margin.left, margin.top, margin.left, height - margin.bottom, "timeline-grid");
    drawLine(svg, margin.left, height - margin.bottom, margin.left + plotW, height - margin.bottom, "timeline-grid");
    drawText(svg, margin.left, height - 8, formatTime(samples[0].capturedAt), "timeline-axis", "start");
    drawText(svg, width - margin.right, height - 8, formatTime(samples[samples.length - 1].capturedAt), "timeline-axis", "end");
  }

  function drawHops(svg, x, margin, plotH, hops) {
    hops.forEach((hop, index) => {
      const xPos = x(hop.capturedAt);
      drawLine(svg, xPos, margin.top, xPos, margin.top + plotH, "timeline-hop");
      const hit = drawLine(svg, xPos, margin.top, xPos, margin.top + plotH, "timeline-hop-hit");
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = hopTitle(hop);
      hit.append(title);
      hit.addEventListener("mouseenter", () => showHopCard(hop));
      hit.addEventListener("mouseleave", hideHoverCard);
      if (index % 2 === 0) drawText(svg, xPos + 4, margin.top + 12, "AP", "timeline-hop-label", "start");
    });
  }

  function selectSample(id) {
    state.selectedId = String(state.selectedId) === String(id) ? null : String(id);
    if (state.selectedId) {
      const sample = visibleSamples().find((item) => String(item.id) === String(id));
      if (sample) {
        state.map.panTo([sample.lat, sample.lon], { animate: true, duration: 0.25 });
        showSampleCard(sample, true);
        scrollTimelineToSample(sample.id, true);
      } else {
        state.selectedId = null;
      }
    } else {
      hideHoverCard();
    }
    applyHighlightClasses();
  }

  function clearSelection() {
    state.selectedId = null;
    state.activeId = null;
    hideHoverCard();
    applyHighlightClasses();
  }

  function setActive(id, showCard) {
    state.activeId = id == null ? null : String(id);
    if (showCard && id != null) {
      const sample = visibleSamples().find((item) => String(item.id) === String(id));
      if (sample) showSampleCard(sample, false);
    } else if (!state.selectedId) {
      hideHoverCard();
    }
    applyHighlightClasses();
  }

  function applyHighlightClasses() {
    renderMapColors();
    const samplesById = new Map(visibleSamples().map((sample) => [String(sample.id), sample]));
    for (const [id, dot] of state.timelineDots) {
      dot.setAttribute("class", timelineDotClass(samplesById.get(String(id)) || id));
      dot.setAttribute("r", id === String(state.selectedId) ? "6" : id === String(state.activeId) ? "5.5" : "4");
    }
  }

  function timelineDotClass(sampleOrId) {
    const id = typeof sampleOrId === "object" && sampleOrId ? sampleOrId.id : sampleOrId;
    const classes = ["timeline-dot"];
    if (typeof sampleOrId === "object" && isAdjacentApSample(sampleOrId)) classes.push("is-adjacent-ap");
    if (String(id) === String(state.activeId)) classes.push("is-active");
    if (String(id) === String(state.selectedId)) classes.push("is-selected");
    return classes.join(" ");
  }

  function samplePopup(sample) {
    return `${sampleDetailTitle(sample)}${sampleActions(sample)}${sampleDetails(sample, true)}`;
  }

  function sampleDetailTitle(sample) {
    return `<div class="detail-title"><strong>${escapeHtml(formatTime(sample.capturedAt))}</strong><span>Ping ${escapeHtml(String(sample.id))}</span></div>`;
  }

  function sampleDetails(sample, allFields) {
    const p = sample.props;
    const rows = allFields ? fullSampleRows(sample) : [
      ["SSID", p.ssid || "n/a"],
      ["BSSID", p.bssid || "n/a"],
      ["RSSI", metricOptions.rssi.format(p.rssi_dbm)],
      ["Packet loss", metricOptions.packetLoss.format(p.packet_loss_percent)],
      ["Link speed", metricOptions.linkSpeed.format(p.link_speed_mbps)],
      ["Latency", metricOptions.latency.format(p.latency_ms)],
      ["Standard", p.wifi_standard || "n/a"],
      ["Band", p.band || "n/a"],
      ["Probe", p.probe_success ? "success" : (p.probe_error || "failed")]
    ];
    return `<dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`).join("")}</dl>`;
  }

  function sampleActions(sample) {
    const bssid = sample.props.bssid;
    if (!bssid) return "";
    const isActiveFilter = state.apFilter === bssid;
    const primary = isActiveFilter
      ? `<button type="button" data-sample-action="clear-ap-filter">Show all APs</button>`
      : `<button type="button" data-sample-action="filter-ap" data-bssid="${escapeHtml(bssid)}" data-captured-at="${escapeHtml(sample.capturedAt)}">Only this AP</button>`;
    return `<div class="sample-actions">${primary}</div>`;
  }

  function fullSampleRows(sample) {
    const metricLabel = metricOptions[els.timelineMetric.value].label;
    const timelineValue = metricNumber(sample, metricOptions[els.timelineMetric.value]);
    const baseRows = [
      ["Timeline metric", `${metricLabel}: ${timelineValue == null ? "n/a" : metricOptions[els.timelineMetric.value].format(timelineValue)}`],
      ["Latitude", sample.lat],
      ["Longitude", sample.lon],
      ["Captured", formatTime(sample.capturedAt)]
    ];
    const propRows = Object.entries(sample.props)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, value == null || value === "" ? "n/a" : value]);
    return baseRows.concat(propRows);
  }

  function hopPopup(hop) {
    return `<strong>AP hop</strong><dl><dt>Time</dt><dd>${escapeHtml(formatTime(hop.capturedAt))}</dd><dt>From</dt><dd>${escapeHtml(hop.props.from_bssid || "n/a")}</dd><dt>To</dt><dd>${escapeHtml(hop.props.to_bssid || "n/a")}</dd><dt>SSID</dt><dd>${escapeHtml(hop.props.ssid || "n/a")}</dd></dl>`;
  }

  function showSampleCard(sample, allFields) {
    els.hoverCard.hidden = false;
    els.hoverCard.innerHTML = `${sampleDetailTitle(sample)}${sampleActions(sample)}${sampleDetails(sample, allFields)}`;
  }

  function refreshVisibleSampleCard() {
    const id = state.selectedId || state.activeId;
    if (!id) return;
    const sample = visibleSamples().find((item) => String(item.id) === String(id));
    if (sample) showSampleCard(sample, Boolean(state.selectedId));
  }

  function showHopCard(hop) {
    els.hoverCard.hidden = false;
    els.hoverCard.innerHTML = `<strong>${escapeHtml(hopTitle(hop))}</strong><dl><dt>Time</dt><dd>${escapeHtml(formatTime(hop.capturedAt))}</dd><dt>SSID</dt><dd>${escapeHtml(hop.props.ssid || "n/a")}</dd><dt>RSSI change</dt><dd>${escapeHtml(`${hop.props.from_rssi_dbm ?? "n/a"} to ${hop.props.to_rssi_dbm ?? "n/a"} dBm`)}</dd></dl>`;
  }

  function hideHoverCard() {
    if (!state.selectedId) els.hoverCard.hidden = true;
  }

  function setTimelineZoom(nextZoom) {
    const previousZoom = state.timelineZoom;
    const next = clamp(nextZoom, 1, 12);
    if (Math.abs(next - previousZoom) < 0.01) return;
    const wrap = els.timelineWrap;
    const centerRatio = (wrap.scrollLeft + wrap.clientWidth / 2) / Math.max(1, wrap.scrollWidth);
    state.timelineZoom = next;
    renderTimeline();
    window.requestAnimationFrame(() => {
      wrap.scrollLeft = Math.max(0, centerRatio * wrap.scrollWidth - wrap.clientWidth / 2);
      if (state.selectedId) scrollTimelineToSample(state.selectedId, false);
    });
  }

  function handleTimelineWheel(event) {
    if (event.ctrlKey || event.altKey) {
      event.preventDefault();
      setTimelineZoom(state.timelineZoom * (event.deltaY < 0 ? 1.2 : 1 / 1.2));
      return;
    }
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
      event.preventDefault();
      els.timelineWrap.scrollLeft += event.deltaY;
    }
  }

  function updateTimelineZoomLabel() {
    els.timelineZoomLabel.textContent = `${Number(state.timelineZoom.toFixed(1))}x`;
  }

  function scrollTimelineToSample(id, smooth) {
    const dot = state.timelineDots.get(String(id));
    if (!dot) return;
    const cx = Number(dot.getAttribute("cx"));
    if (!Number.isFinite(cx)) return;
    const target = Math.max(0, cx - els.timelineWrap.clientWidth / 2);
    els.timelineWrap.scrollTo({ left: target, behavior: smooth ? "smooth" : "auto" });
  }

  function hopTitle(hop) {
    return `${hop.props.from_bssid || "Unknown"} -> ${hop.props.to_bssid || "Unknown"}`;
  }

  function hopIcon(hop) {
    const color = state.apColors.get(hop.props.to_bssid) || "#8b1e3f";
    return L.divIcon({
      className: "hop-marker",
      html: `<span style="display:grid;place-items:center;width:26px;height:26px;border-radius:50%;border:2px solid #fff;background:${color};box-shadow:0 2px 8px rgba(0,0,0,.35);font-size:15px;font-weight:900;color:#fff;">H</span>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });
  }

  function hopHeatPoints(hops) {
    const cells = new Map();
    const cellSize = 0.00008;
    for (const hop of hops) {
      const key = `${Math.round(hop.lat / cellSize)}:${Math.round(hop.lon / cellSize)}`;
      if (!cells.has(key)) {
        cells.set(key, {
          latSum: 0,
          lonSum: 0,
          count: 0
        });
      }
      const cell = cells.get(key);
      cell.latSum += hop.lat;
      cell.lonSum += hop.lon;
      cell.count += 1;
    }

    return [...cells.values()].map((cell) => ({
      lat: cell.latSum / cell.count,
      lon: cell.lonSum / cell.count,
      count: cell.count
    }));
  }

  function hopHeatStyle(point) {
    const intensity = clamp(point.count, 1, 8);
    return {
      radius: 14 + intensity * 4,
      fillColor: "#dc2626",
      fillOpacity: clamp(0.13 + intensity * 0.035, 0.16, 0.42),
      color: "#991b1b",
      weight: 0,
      opacity: 0,
      className: "hop-heat-point"
    };
  }

  function hopHeatPopup(point) {
    return `<strong>AP hop heat</strong><dl><dt>Hops</dt><dd>${escapeHtml(String(point.count))}</dd><dt>Latitude</dt><dd>${escapeHtml(point.lat.toFixed(7))}</dd><dt>Longitude</dt><dd>${escapeHtml(point.lon.toFixed(7))}</dd></dl>`;
  }

  function buildApColors() {
    state.apColors.clear();
    const bssids = groupCounts(state.samples.map((sample) => sample.props.bssid || "Unknown")).map(([bssid]) => bssid);
    bssids.forEach((bssid, index) => state.apColors.set(bssid, categoricalColors[index % categoricalColors.length]));
  }

  function visibleSamples() {
    return apContext().visibleSamples;
  }

  function samplesWithoutApFilter() {
    return apContext().baseSamples;
  }

  function apRuns() {
    return apContext().runs;
  }

  function buildApRuns(samples) {
    const runs = [];
    for (const sample of samples) {
      const bssid = sample.props.bssid;
      if (!bssid) continue;
      const last = runs[runs.length - 1];
      if (last && last.bssid === bssid) {
        last.endAt = sample.capturedAt;
        last.count += 1;
        last.sampleIds.add(String(sample.id));
      } else {
        runs.push({
          bssid,
          startAt: sample.capturedAt,
          endAt: sample.capturedAt,
          startId: sample.id,
          count: 1,
          sampleIds: new Set([String(sample.id)])
        });
      }
    }
    return runs;
  }

  function focusedApRunIndex(runs) {
    if (!state.apFilter) return -1;
    const anchorAt = Number(state.apFilterAnchorAt);
    if (Number.isFinite(anchorAt)) {
      const anchoredIndex = runs.findIndex((run) => run.bssid === state.apFilter && anchorAt >= run.startAt && anchorAt <= run.endAt);
      if (anchoredIndex >= 0) return anchoredIndex;
    }
    return runs.findIndex((run) => run.bssid === state.apFilter);
  }

  function firstSampleForAp(bssid) {
    return samplesWithoutApFilter().find((sample) => sample.props.bssid === bssid);
  }

  function adjacentApRuns() {
    return apContext().adjacentRuns;
  }

  function isAdjacentApSample(sample) {
    return apContext().adjacentSampleIds.has(String(sample.id));
  }

  function apContext() {
    if (state.apContext) return state.apContext;

    const baseSamples = samplesWithTransportFilter();
    const runs = buildApRuns(baseSamples);
    const focusedRunIndex = focusedApRunIndex(runs);
    const adjacentRuns = state.apFilter && state.showAdjacentAps && focusedRunIndex >= 0
      ? [runs[focusedRunIndex - 1], runs[focusedRunIndex + 1]].filter(Boolean)
      : [];
    const adjacentSampleIds = new Set();
    for (const run of adjacentRuns) {
      for (const id of run.sampleIds) adjacentSampleIds.add(id);
    }
    const visibleSamples = state.apFilter
      ? baseSamples.filter((sample) => sample.props.bssid === state.apFilter || adjacentSampleIds.has(String(sample.id)))
      : baseSamples;

    state.apContext = {
      baseSamples,
      runs,
      focusedRunIndex,
      adjacentRuns,
      adjacentSampleIds,
      visibleSamples
    };
    return state.apContext;
  }

  function invalidateApContext() {
    state.apContext = null;
  }

  function samplesWithTransportFilter() {
    if (state.cellularFilter === "hide") {
      return state.samples.filter((sample) => !isCellularSample(sample));
    }
    if (state.cellularFilter === "only") {
      return state.samples.filter(isCellularSample);
    }
    return state.samples;
  }

  function visibleHops(samples) {
    if (!samples.length) return [];
    const first = samples[0].capturedAt;
    const last = samples[samples.length - 1].capturedAt;
    return state.hops.filter((hop) => {
      if (hop.capturedAt < first || hop.capturedAt > last) return false;
      if (!state.apFilter) return true;
      return hop.props.from_bssid === state.apFilter || hop.props.to_bssid === state.apFilter;
    });
  }

  function estimateApLocations(samples) {
    const groups = new Map();
    for (const sample of samples) {
      const bssid = sample.props.bssid;
      const rssi = Number(sample.props.rssi_dbm);
      if (!bssid || !Number.isFinite(rssi)) continue;
      if (!groups.has(bssid)) groups.set(bssid, []);
      groups.get(bssid).push(sample);
    }

    const estimates = [];
    for (const [bssid, group] of groups) {
      const usable = group
        .map((sample) => ({ sample, rssi: Number(sample.props.rssi_dbm), accuracy: Number(sample.props.accuracy_m) }))
        .filter((item) => Number.isFinite(item.rssi) && Number.isFinite(item.sample.lat) && Number.isFinite(item.sample.lon));
      if (usable.length < 3) continue;

      let weightSum = 0;
      let latSum = 0;
      let lonSum = 0;
      let rssiSum = 0;
      let strongest = -Infinity;
      for (const item of usable) {
        const weight = apEstimateWeight(item.rssi, item.accuracy);
        weightSum += weight;
        latSum += item.sample.lat * weight;
        lonSum += item.sample.lon * weight;
        rssiSum += item.rssi;
        strongest = Math.max(strongest, item.rssi);
      }
      if (weightSum <= 0) continue;

      const lat = latSum / weightSum;
      const lon = lonSum / weightSum;
      const distances = usable.map((item) => distanceMeters(lat, lon, item.sample.lat, item.sample.lon));
      const scatterM = percentile(distances, 0.7);
      estimates.push({
        bssid,
        ssid: mostCommon(usable.map((item) => item.sample.props.ssid).filter(Boolean)),
        lat,
        lon,
        sampleCount: usable.length,
        maxRssi: strongest,
        meanRssi: rssiSum / usable.length,
        scatterM,
        confidence: apEstimateConfidence(usable.length, strongest, scatterM)
      });
    }

    return estimates.sort((a, b) => b.sampleCount - a.sampleCount || a.bssid.localeCompare(b.bssid));
  }

  function apEstimateWeight(rssi, accuracy) {
    const boundedRssi = clamp(rssi, -95, -35);
    const signalWeight = Math.pow(10, (boundedRssi + 95) / 18);
    const boundedAccuracy = Number.isFinite(accuracy) && accuracy > 0 ? clamp(accuracy, 4, 80) : 25;
    const accuracyWeight = 1 / Math.pow(boundedAccuracy, 1.15);
    return signalWeight * accuracyWeight;
  }

  function apEstimateConfidence(sampleCount, maxRssi, scatterM) {
    if (sampleCount >= 12 && maxRssi >= -62 && scatterM <= 35) return "high";
    if (sampleCount >= 6 && maxRssi >= -75 && scatterM <= 85) return "medium";
    return "low";
  }

  function isCellularSample(sample) {
    const props = sample.props || {};
    const cellular = props.transport_cellular;
    if (cellular === true || cellular === 1 || cellular === "1") return true;
    if (typeof cellular === "string" && cellular.toLowerCase() === "true") return true;
    return String(props.default_transports || "").toLowerCase().includes("cellular");
  }

  function connectionBandCategory(sample) {
    if (isCellularSample(sample)) return "Cellular";

    const band = String(sample.props.band || "").toLowerCase();
    if (band.includes("2.4")) return "2.4 GHz";
    if (band.includes("5")) return "5 GHz";
    if (band.includes("6")) return "6 GHz";

    const frequency = Number(sample.props.frequency_mhz);
    if (Number.isFinite(frequency)) {
      if (frequency >= 2400 && frequency < 2500) return "2.4 GHz";
      if (frequency >= 4900 && frequency < 5900) return "5 GHz";
      if (frequency >= 5925 && frequency < 7125) return "6 GHz";
    }

    return "Other";
  }

  function showEmpty(message) {
    els.datasetName.textContent = message;
    els.timelineSvg.replaceChildren();
    els.legend.textContent = "";
    els.summary.textContent = "";
  }

  function showEmptyStart() {
    showEmpty("Upload a GeoJSON survey file to start.");
    els.timelineTitle.textContent = "Timeline";
    els.timelineSubtitle.textContent = "Open a survey export to view AP changes and metric history.";
    drawText(els.timelineSvg, 180, 85, "Upload a GeoJSON survey file to start", "empty-state", "middle");
  }

  function metricValues(samples, field) {
    return samples
      .map((sample) => Number(sample.props[field]))
      .filter((value) => Number.isFinite(value) && value >= 0);
  }

  function metricNumber(sample, metric) {
    const raw = sample.props[metric.field];
    if (metric.missing(raw)) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  function maxMetric(samples, field) {
    const values = metricValues(samples, field);
    return values.length ? Math.max(...values) : 0;
  }

  function percentile(values, p) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
    return sorted[index];
  }

  function groupCounts(values) {
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  }

  function mostCommon(values) {
    return groupCounts(values)[0]?.[0] || "";
  }

  function unique(values) {
    return [...new Set(values)];
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function rampRedYellowGreen(ratio) {
    return ratio < 0.5 ? mixColor("#dc2626", "#facc15", ratio * 2) : mixColor("#facc15", "#16a34a", (ratio - 0.5) * 2);
  }

  function rampGreenYellowRed(ratio) {
    return ratio < 0.5 ? mixColor("#16a34a", "#facc15", ratio * 2) : mixColor("#facc15", "#dc2626", (ratio - 0.5) * 2);
  }

  function mixColor(a, b, ratio) {
    const ca = hexToRgb(a);
    const cb = hexToRgb(b);
    const mixed = ca.map((value, index) => Math.round(value + (cb[index] - value) * ratio));
    return `rgb(${mixed[0]}, ${mixed[1]}, ${mixed[2]})`;
  }

  function hexToRgb(hex) {
    const value = hex.replace("#", "");
    return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  }

  function formatTime(ms) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(Number(ms)));
  }

  function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  function distanceMeters(latA, lonA, latB, lonB) {
    const earthRadiusM = 6371008.8;
    const phi1 = toRadians(latA);
    const phi2 = toRadians(latB);
    const deltaPhi = toRadians(latB - latA);
    const deltaLambda = toRadians(lonB - lonA);
    const a = Math.sin(deltaPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
    return 2 * earthRadiusM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function toRadians(value) {
    return (Number(value) * Math.PI) / 180;
  }

  function drawLine(svg, x1, y1, x2, y2, className) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    line.setAttribute("class", className);
    svg.append(line);
    return line;
  }

  function drawPath(svg, d, className) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("class", className);
    svg.append(path);
    return path;
  }

  function drawText(svg, x, y, text, className, anchor) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "text");
    node.setAttribute("x", x);
    node.setAttribute("y", y);
    node.setAttribute("class", className);
    node.setAttribute("text-anchor", anchor);
    node.textContent = text;
    svg.append(node);
    return node;
  }

  function debounce(fn, delay) {
    let timer = null;
    return () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(fn, delay);
    };
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
