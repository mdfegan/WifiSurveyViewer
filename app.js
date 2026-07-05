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
    ap: {
      label: "Connected AP",
      field: "bssid"
    }
  };

  const timelineMetricKeys = ["rssi", "packetLoss", "linkSpeed", "latency"];
  const mapMetricKeys = ["rssi", "packetLoss", "linkSpeed", "latency", "ap"];
  const categoricalColors = [
    "#0f766e", "#2563eb", "#a21caf", "#e11d48", "#ca8a04", "#16a34a",
    "#7c3aed", "#ea580c", "#0891b2", "#be123c", "#4d7c0f", "#4338ca",
    "#b45309", "#0e7490", "#9f1239", "#15803d", "#6d28d9", "#c2410c",
    "#0369a1", "#854d0e", "#047857", "#7e22ce", "#dc2626", "#1d4ed8"
  ];

  const state = {
    map: null,
    samples: [],
    hops: [],
    apColors: new Map(),
    markers: new Map(),
    timelineDots: new Map(),
    route: null,
    hopLayer: null,
    selectedId: null,
    activeId: null,
    datasetLabel: DEFAULT_GEOJSON,
    timelineZoom: 1
  };

  const els = {
    datasetName: document.getElementById("datasetName"),
    fileInput: document.getElementById("fileInput"),
    mapMetric: document.getElementById("mapMetric"),
    timelineMetric: document.getElementById("timelineMetric"),
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
    els.fileInput.addEventListener("change", handleFilePick);
    els.clearSelection.addEventListener("click", clearSelection);
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
    buildApColors();
    renderAll();
  }

  function renderAll() {
    els.datasetName.textContent = state.datasetLabel;
    renderMap();
    renderSummary();
    renderLegend();
    renderTimeline();
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
    if (state.route) state.route.remove();
    if (state.hopLayer) state.hopLayer.remove();
    for (const marker of state.markers.values()) marker.remove();
    state.markers.clear();

    if (!state.samples.length) {
      showEmpty("No point samples found in this GeoJSON.");
      return;
    }

    const latLngs = state.samples.map((sample) => [sample.lat, sample.lon]);
    state.route = L.polyline(latLngs, { className: "route-line" }).addTo(state.map);

    for (const sample of state.samples) {
      const marker = L.circleMarker([sample.lat, sample.lon], markerStyle(sample))
        .bindPopup(samplePopup(sample))
        .on("mouseover", () => setActive(sample.id, true))
        .on("mouseout", () => setActive(null, true))
        .on("click", () => selectSample(sample.id));
      marker.addTo(state.map);
      state.markers.set(String(sample.id), marker);
    }

    state.hopLayer = L.layerGroup();
    for (const hop of state.hops) {
      L.marker([hop.lat, hop.lon], { icon: hopIcon(hop) })
        .bindPopup(hopPopup(hop))
        .on("mouseover", () => showHopCard(hop))
        .on("mouseout", hideHoverCard)
        .addTo(state.hopLayer);
    }
    state.hopLayer.addTo(state.map);
    state.map.fitBounds(state.route.getBounds().pad(0.18));
  }

  function renderMapColors() {
    for (const sample of state.samples) {
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
    if (metricKey === "ap") return state.apColors.get(sample.props.bssid) || "#64748b";
    const metric = metricOptions[metricKey];
    const value = metricNumber(sample, metric);
    if (value == null) return "#94a3b8";
    const [min, max] = metric.domain(state.samples);
    const ratio = clamp((value - min) / (max - min), 0, 1);
    return metric.goodHigh ? rampRedYellowGreen(ratio) : rampGreenYellowRed(ratio);
  }

  function renderSummary() {
    const durationMs = state.samples.length ? state.samples[state.samples.length - 1].capturedAt - state.samples[0].capturedAt : 0;
    const ssids = unique(state.samples.map((sample) => sample.props.ssid).filter(Boolean));
    const apCount = unique(state.samples.map((sample) => sample.props.bssid).filter(Boolean)).length;
    const items = [
      ["Points", state.samples.length.toLocaleString()],
      ["AP hops", state.hops.length.toLocaleString()],
      ["Duration", formatDuration(durationMs)],
      ["SSID", ssids.length === 1 ? ssids[0] : `${ssids.length} SSIDs`],
      ["Unique APs", apCount.toLocaleString()],
      ["Started", state.samples.length ? formatTime(state.samples[0].capturedAt) : "n/a"]
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

  function renderLegend() {
    const metricKey = els.mapMetric.value;
    const metric = metricOptions[metricKey];
    els.legend.innerHTML = "";
    const title = document.createElement("div");
    title.className = "legend-title";
    title.textContent = metric.label;
    els.legend.append(title);

    if (metricKey === "ap") {
      const list = document.createElement("div");
      list.className = "category-list";
      const counts = groupCounts(state.samples.map((sample) => sample.props.bssid || "Unknown"));
      for (const [bssid, count] of counts) {
        const item = document.createElement("div");
        item.className = "category-item";
        const swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.background = state.apColors.get(bssid) || "#64748b";
        const code = document.createElement("code");
        code.textContent = bssid;
        const number = document.createElement("span");
        number.textContent = count;
        item.append(swatch, code, number);
        list.append(item);
      }
      els.legend.append(list);
      return;
    }

    const bar = document.createElement("div");
    bar.className = "gradient-bar";
    bar.style.background = metric.goodHigh
      ? "linear-gradient(90deg, #dc2626, #facc15, #16a34a)"
      : "linear-gradient(90deg, #16a34a, #facc15, #dc2626)";
    const scale = document.createElement("div");
    scale.className = "legend-scale";
    const maxLabel = typeof metric.legendMax === "function" ? metric.legendMax(state.samples) : metric.legendMax;
    scale.innerHTML = `<span>${metric.legendMin}</span><span>${maxLabel}</span>`;
    els.legend.append(bar, scale);
  }

  function renderTimeline() {
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
    els.timelineSubtitle.textContent = `${state.hops.length} AP changes marked across ${formatDuration(state.samples[state.samples.length - 1].capturedAt - state.samples[0].capturedAt)}.`;

    const margin = { top: 18, right: 22, bottom: 28, left: 54 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const tMin = state.samples[0].capturedAt;
    const tMax = state.samples[state.samples.length - 1].capturedAt;
    const [yMin, yMax] = metric.domain(state.samples);
    const x = (time) => margin.left + ((time - tMin) / Math.max(1, tMax - tMin)) * plotW;
    const y = (value) => margin.top + (1 - clamp((value - yMin) / Math.max(1, yMax - yMin), 0, 1)) * plotH;
    const baseline = margin.top + plotH;

    drawGrid(svg, width, height, margin, yMin, yMax, metric);
    drawHops(svg, x, margin, plotH);

    const valid = state.samples
      .map((sample) => ({ sample, value: metricNumber(sample, metric) }))
      .filter((point) => point.value != null);

    if (!valid.length) {
      drawText(svg, width / 2, height / 2, "No values available for this metric", "empty-state", "middle");
      return;
    }

    const lineParts = [];
    let current = [];
    for (const sample of state.samples) {
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
      dot.setAttribute("class", timelineDotClass(point.sample.id));
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

  function drawGrid(svg, width, height, margin, yMin, yMax, metric) {
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
    drawText(svg, margin.left, height - 8, formatTime(state.samples[0].capturedAt), "timeline-axis", "start");
    drawText(svg, width - margin.right, height - 8, formatTime(state.samples[state.samples.length - 1].capturedAt), "timeline-axis", "end");
  }

  function drawHops(svg, x, margin, plotH) {
    state.hops.forEach((hop, index) => {
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
      const sample = state.samples.find((item) => String(item.id) === String(id));
      if (sample) {
        state.map.panTo([sample.lat, sample.lon], { animate: true, duration: 0.25 });
        showSampleCard(sample, true);
        scrollTimelineToSample(sample.id, true);
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
      const sample = state.samples.find((item) => String(item.id) === String(id));
      if (sample) showSampleCard(sample, false);
    } else if (!state.selectedId) {
      hideHoverCard();
    }
    applyHighlightClasses();
  }

  function applyHighlightClasses() {
    renderMapColors();
    for (const [id, dot] of state.timelineDots) {
      dot.setAttribute("class", timelineDotClass(id));
      dot.setAttribute("r", id === String(state.selectedId) ? "6" : id === String(state.activeId) ? "5.5" : "4");
    }
  }

  function timelineDotClass(id) {
    const classes = ["timeline-dot"];
    if (String(id) === String(state.activeId)) classes.push("is-active");
    if (String(id) === String(state.selectedId)) classes.push("is-selected");
    return classes.join(" ");
  }

  function samplePopup(sample) {
    return `${sampleDetailTitle(sample)}${sampleDetails(sample, true)}`;
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
    els.hoverCard.innerHTML = `${sampleDetailTitle(sample)}${sampleDetails(sample, allFields)}`;
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

  function buildApColors() {
    state.apColors.clear();
    const bssids = groupCounts(state.samples.map((sample) => sample.props.bssid || "Unknown")).map(([bssid]) => bssid);
    bssids.forEach((bssid, index) => state.apColors.set(bssid, categoricalColors[index % categoricalColors.length]));
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
