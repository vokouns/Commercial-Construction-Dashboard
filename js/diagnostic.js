// ==================== Diagnostic Dashboard JS ====================
// Works with dashboards/diagnostic.html and data/{projects.csv, change_orders.csv}
//
// KPIs (diagnostic):
//   - Overrun Rate (% projects where actual_cost > planned_budget)
//   - Avg Cost Variance ((actual - planned) / planned)
//   - Avg Schedule Variance (days: actual_end - planned_end)
//
// Charts:
//   - Cost Variance — by YEAR (or by MONTH when a single year is selected)
//   - Schedule Variance — by YEAR (or by MONTH when a single year is selected)
//   - Change Orders — Top Reasons (horizontal bar)
//   - Change Orders — Frequency by Project (histogram of #COs per project)
//   - Overrun Attribution — CO vs Other (stacked bar by YEAR or MONTH)
//   - Variance vs Duration (scatter: duration days vs. cost variance %)
//
// If canvases are not present, the renderer skips them gracefully.
// ==================================================================

window.addEventListener("DOMContentLoaded", () => {
  // ---------- DOM helpers ----------
  const $ = (id) => document.getElementById(id);
  const parseDate = (s) => (s ? new Date(s) : null);

  const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  function abbrNumber(n) {
    if (!isFinite(n)) return "0";
    const abs = Math.abs(n);
    if (abs >= 1e12) return (n / 1e12).toFixed(1) + "T";
    if (abs >= 1e9 ) return (n / 1e9 ).toFixed(1) + "B";
    if (abs >= 1e6 ) return (n / 1e6 ).toFixed(1) + "M";
    if (abs >= 1e3 ) return (n / 1e3 ).toFixed(1) + "K";
    return String(Math.round(n));
  }
  const pctStr  = (x) => isFinite(x) ? `${(x*100).toFixed(1)}%` : "N/A";
  const daysStr = (d) => (d != null && isFinite(d)) ? `${Math.round(d)} days` : "N/A";

  // ---------- Elements ----------
  const el = {
    yearFilter: $("yearFilter"),

    // KPIs
    kOverrunRate: $("kpiOverrunRate"),
    kAvgCostVar:  $("kpiAvgCostVariance"),
    kAvgSchedVar: $("kpiAvgScheduleVariance"),

    // Charts
    cCostVar: $("costVarianceByYear"),
    cSchedVar: $("scheduleVarianceByYear"),
    cReasons: $("coReasons"),
    cCOFreq:  $("coFrequencyByProject"),
    cAttrib:  $("overrunAttribution"),
    cScatter: $("varianceVsDuration"),
  };

  Object.entries(el).forEach(([k, v]) => {
    if (!v) console.debug(`[DIAGNOSTIC] Optional/missing element: ${k}`);
  });

  // ---------- State ----------
  let allProjects = [];
  let allCOs = [];
  const charts = {
    costVar: null,
    schedVar: null,
    reasons: null,
    coFreq: null,
    attrib: null,
    scatter: null,
  };

  // ---------- Reason mapping ----------
  // 0 = scope change, 1 = client request, 2 = unforeseen conditions, 3 = design revision
  const REASON_MAP = {
    "0": "Scope Change",
    "1": "Client Request",
    "2": "Unforeseen Conditions",
    "3": "Design Revision",
  };

  // ---------- Load CSVs ----------
  Promise.all([
    d3.csv("../data/projects.csv"),
    d3.csv("../data/change_orders.csv"),
  ])
    .then(([projectRows, coRows]) => {
      // Normalize projects
      allProjects = projectRows.map((d) => ({
        project_id: d.project_id,
        project_name: d.project_name,
        start_date: d.start_date,
        planned_end: d.planned_end,
        actual_end: d.actual_end || "",
        planned_budget: +d.planned_budget,
        actual_cost: +d.actual_cost,
        completion_pct: +d.completion_pct,
      }));

      // Normalize change orders (apply robust reason mapping)
      allCOs = coRows.map((d) => {
        // trim/normalize raw value so " 0", "0 ", "0.0" still map
        const raw = (d.co_reason ?? "").toString().trim();
        const numericish = raw.replace(/\.0+$/, ""); // e.g., "0.0" -> "0"
        const mapped = REASON_MAP[raw] || REASON_MAP[numericish];
        return {
          project_id: d.project_id,
          phase_id: d.phase_id,
          co_id: d.co_id,
          co_cost: +d.co_cost,
          co_reason: mapped || (raw || "Unspecified"),
          date: d.date,
        };
      });

      populateYearFilter(allProjects);
      updateView();

      el.yearFilter.addEventListener("change", updateView);
    })
    .catch((err) => console.error("[DIAGNOSTIC] CSV load error:", err));

  // ---------- UI builders ----------
  function populateYearFilter(projects) {
    const years = Array.from(
      new Set(projects.map((r) => new Date(r.start_date).getFullYear()))
    ).sort((a, b) => a - b);
    years.forEach((y) => {
      const opt = document.createElement("option");
      opt.value = y;
      opt.textContent = y;
      el.yearFilter.appendChild(opt);
    });
  }

  function updateView() {
    const sel = el.yearFilter.value; // "all" or "YYYY"

    const projSlice =
      sel === "all"
        ? allProjects
        : allProjects.filter(
            (r) => new Date(r.start_date).getFullYear().toString() === sel
          );

    const coSlice =
      sel === "all"
        ? allCOs
        : allCOs.filter((r) => {
            const d = new Date(r.date);
            return !isNaN(d) && d.getFullYear().toString() === sel;
          });

    updateKPIs(projSlice);
    renderCharts(projSlice, coSlice, sel);
  }

  // ---------- KPIs ----------
  function updateKPIs(rows) {
    // Cost variance ratio (actual - planned)/planned, ignore rows without both
    const vars = rows
      .map((r) => {
        const p = r.planned_budget;
        const a = r.actual_cost;
        if (!isFinite(p) || p <= 0 || !isFinite(a)) return NaN;
        return (a - p) / p;
      })
      .filter((v) => isFinite(v));

    // Overrun rate
    const overruns = vars.filter((v) => v > 0).length;
    const overrunRate = vars.length ? overruns / vars.length : NaN;

    // Schedule variance in days: (actual_end - planned_end)
    const scheds = rows
      .map((r) => {
        const pe = parseDate(r.planned_end);
        const ae = parseDate(r.actual_end);
        if (!pe || !ae || isNaN(pe) || isNaN(ae)) return NaN;
        return (ae - pe) / (1000 * 60 * 60 * 24);
      })
      .filter((v) => isFinite(v));

    const avgCostVar = d3.mean(vars);
    const avgSchedVar = d3.mean(scheds);

    if (el.kOverrunRate) el.kOverrunRate.textContent = pctStr(overrunRate);
    if (el.kAvgCostVar)  el.kAvgCostVar.textContent  = pctStr(avgCostVar);
    if (el.kAvgSchedVar) el.kAvgSchedVar.textContent = daysStr(avgSchedVar);
  }

  // ---------- Derived metrics ----------
  function projectDurationDays(r) {
    // Prefer actual duration if possible; else planned
    const s = parseDate(r.start_date);
    const e = parseDate(r.actual_end) || parseDate(r.planned_end);
    if (!s || !e || isNaN(s) || isNaN(e)) return NaN;
    return (e - s) / (1000 * 60 * 60 * 24);
  }

  function projectCostVarianceRatio(r) {
    const p = r.planned_budget;
    const a = r.actual_cost;
    if (!isFinite(p) || p <= 0 || !isFinite(a)) return NaN;
    return (a - p) / p;
  }

  // rollups by year / month for a given accessor (e.g., variance ratio, schedule variance)
  function rollupAvgByYear(rows, accessor) {
    const sums = {};
    const counts = {};
    rows.forEach((r) => {
      const v = accessor(r);
      if (!isFinite(v)) return;
      const y = new Date(r.start_date).getFullYear();
      sums[y] = (sums[y] || 0) + v;
      counts[y] = (counts[y] || 0) + 1;
    });
    const out = {};
    Object.keys(sums).forEach((y) => (out[y] = sums[y] / counts[y]));
    return out;
  }

  function rollupAvgByMonth(rows, year, accessor) {
    const sums = Array(12).fill(0);
    const counts = Array(12).fill(0);
    rows.forEach((r) => {
      const d = new Date(r.start_date);
      if (isNaN(d) || d.getFullYear() !== year) return;
      const v = accessor(r);
      if (!isFinite(v)) return;
      const m = d.getMonth();
      sums[m] += v;
      counts[m] += 1;
    });
    return sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
  }

  function coCountsPerProject(coRows) {
    // returns map { project_id -> count }
    const m = {};
    coRows.forEach((r) => {
      const k = r.project_id || "__missing__";
      m[k] = (m[k] || 0) + 1;
    });
    return m;
  }

  function coTotalsPerProject(coRows) {
    // returns map { project_id -> total co_cost }
    const m = {};
    coRows.forEach((r) => {
      const k = r.project_id || "__missing__";
      const c = isFinite(r.co_cost) ? r.co_cost : 0;
      m[k] = (m[k] || 0) + c;
    });
    return m;
  }

  function topReasons(coRows, topN = 7) {
    const counts = {};
    coRows.forEach((r) => {
      const k = (r.co_reason || "Unspecified").trim() || "Unspecified";
      counts[k] = (counts[k] || 0) + 1;
    });
    const pairs = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, topN);
    return { labels: pairs.map(p => p[0]), values: pairs.map(p => p[1]) };
  }

  function overrunAttributionByTime(projects, coRows, isAll, yearInt) {
    // For each project, compute:
    // overrun = max(actual - planned, 0)
    // co_total = sum COs for that project (in the current slice)
    // attributed_to_CO = min(overrun, co_total)
    // other = overrun - attributed_to_CO
    const coTotals = coTotalsPerProject(coRows);

    const bucketer = (r) => {
      const d = new Date(r.start_date);
      return isAll ? d.getFullYear() : d.getMonth(); // year or month index
    };

    const out = {};
    projects.forEach((r) => {
      const p = r.planned_budget;
      const a = r.actual_cost;
      if (!isFinite(p) || !isFinite(a)) return;
      const overrun = Math.max(a - p, 0);
      if (overrun <= 0) return;

      const coSum = coTotals[r.project_id] || 0;
      const attrCO = Math.min(overrun, coSum);
      const attrOther = Math.max(overrun - attrCO, 0);

      const key = bucketer(r);
      if (!out[key]) out[key] = { co: 0, other: 0 };
      out[key].co += attrCO;
      out[key].other += attrOther;
    });

    // labels as year numbers or month names
    let labels, coVals, otherVals;
    if (isAll) {
      labels = Object.keys(out).map(Number).sort((a, b) => a - b);
      coVals = labels.map((k) => out[k]?.co || 0);
      otherVals = labels.map((k) => out[k]?.other || 0);
    } else {
      labels = MONTH_LABELS.slice();
      coVals = Array(12).fill(0);
      otherVals = Array(12).fill(0);
      Object.keys(out).forEach((mStr) => {
        const m = +mStr;
        coVals[m] = out[m].co;
        otherVals[m] = out[m].other;
      });
    }
    return { labels, coVals, otherVals };
  }

  // ---------- Rendering ----------
  function renderCharts(projects, coRows, selected) {
    const isAll = selected === "all";
    const yearInt = isAll ? null : parseInt(selected, 10);

    // Titles
    const setTitle = (canvas, allTxt, yrTxtFn) => {
      if (!canvas) return;
      const t = canvas.previousElementSibling;
      if (!t) return;
      t.textContent = isAll ? allTxt : yrTxtFn(yearInt);
    };

    // --- Cost variance (avg) ---
    setTitle(el.cCostVar, "Cost Variance — by Year", (y) => `Cost Variance — by Month (${y})`);
    if (el.cCostVar) {
      let labels, values, rotateX;
      if (isAll) {
        const m = rollupAvgByYear(projects, projectCostVarianceRatio);
        labels = Object.keys(m).map(Number).sort((a, b) => a - b);
        values = labels.map((y) => m[y]);
        rotateX = labels.length > 12;
      } else {
        labels = MONTH_LABELS.slice();
        values = rollupAvgByMonth(projects, yearInt, projectCostVarianceRatio);
        rotateX = false;
      }
      charts.costVar = drawOrUpdateChart(
        charts.costVar,
        el.cCostVar,
        {
          type: "bar",
          data: {
            labels,
            datasets: [{ label: "Avg Cost Variance", data: values, categoryPercentage: 0.9, barPercentage: 0.9 }],
          },
          options: axisOptions({
            money: false,
            rotateX,
            yTickFmt: (v) => `${(v*100).toFixed(0)}%`,
            tooltipFmt: (v) => `${(v*100).toFixed(1)}%`,
          }),
        }
      );
    }

    // --- Schedule variance (avg days) ---
    setTitle(el.cSchedVar, "Schedule Variance — by Year", (y) => `Schedule Variance — by Month (${y})`);
    if (el.cSchedVar) {
      const schedVarAccessor = (r) => {
        const pe = parseDate(r.planned_end);
        const ae = parseDate(r.actual_end);
        if (!pe || !ae || isNaN(pe) || isNaN(ae)) return NaN;
        return (ae - pe) / (1000 * 60 * 60 * 24);
      };

      let labels, values, rotateX;
      if (isAll) {
        const m = rollupAvgByYear(projects, schedVarAccessor);
        labels = Object.keys(m).map(Number).sort((a, b) => a - b);
        values = labels.map((y) => m[y]);
        rotateX = labels.length > 12;
      } else {
        labels = MONTH_LABELS.slice();
        values = rollupAvgByMonth(projects, yearInt, schedVarAccessor);
        rotateX = false;
      }

      charts.schedVar = drawOrUpdateChart(
        charts.schedVar,
        el.cSchedVar,
        {
          type: "line",
          data: {
            labels,
            datasets: [{ label: "Avg Schedule Variance (days)", data: values, tension: 0.25, pointRadius: 3 }],
          },
          options: axisOptions({
            money: false,
            rotateX,
            yTickFmt: (v) => `${Math.round(v)}`,
            tooltipFmt: (v) => `${Math.round(v)} days`,
          }),
        }
      );
    }

    // --- CO Top Reasons (now uses mapped labels) ---
    setTitle(el.cReasons, "Change Orders — Top Reasons", (y) => `Change Orders — Top Reasons (${y})`);
    if (el.cReasons) {
      const { labels, values } = topReasons(coRows, 7);
      charts.reasons = drawOrUpdateChart(
        charts.reasons,
        el.cReasons,
        {
          type: "bar",
          data: { labels, datasets: [{ label: "Count", data: values }] },
          options: { 
            ...axisOptions({ money: false }),
            indexAxis: "y"
          },
        }
      );
    }

    // --- CO Frequency by Project (histogram bins) ---
    setTitle(el.cCOFreq, "Change Orders — Frequency by Project", (y) => `Change Orders — Frequency (${y})`);
    if (el.cCOFreq) {
      const countsMap = coCountsPerProject(coRows);
      // Represent all projects in the slice (even 0 COs)
      const counts = projects.map((p) => countsMap[p.project_id] || 0);
      const labels = ["0","1","2","3","4","5+"];   // bin labels
      const hist = Array(labels.length).fill(0);
      counts.forEach((c) => {
        if (c >= 5) hist[5] += 1;
        else hist[c] += 1;
      });

      charts.coFreq = drawOrUpdateChart(
        charts.coFreq,
        el.cCOFreq,
        {
          type: "bar",
          data: { labels, datasets: [{ label: "Projects", data: hist, categoryPercentage: 0.9, barPercentage: 0.9 }] },
          options: axisOptions({ money: false }),
        }
      );
    }

    // --- Overrun Attribution (stacked) ---
    setTitle(el.cAttrib, "Overrun Attribution — CO vs Other", (y) => `Overrun Attribution — CO vs Other (${y})`);
    if (el.cAttrib) {
      const { labels, coVals, otherVals } = overrunAttributionByTime(projects, coRows, isAll, yearInt);
      charts.attrib = drawOrUpdateChart(
        charts.attrib,
        el.cAttrib,
        {
          type: "bar",
          data: {
            labels,
            datasets: [
              { label: "CO-driven", data: coVals, stack: "s1" },
              { label: "Other",     data: otherVals, stack: "s1" },
            ],
          },
          options: axisOptions({
            money: true,
            stacked: true,
          }),
        }
      );
    }

    // --- Scatter: duration vs cost variance ---
    setTitle(el.cScatter, "Variance vs Duration (Correlation)", (y) => `Variance vs Duration (${y})`);
    if (el.cScatter) {
      const pts = projects
        .map((r) => {
          const x = projectDurationDays(r);
          const y = projectCostVarianceRatio(r);
          if (!isFinite(x) || !isFinite(y)) return null;
          return { x, y };
        })
        .filter(Boolean);

      charts.scatter = drawOrUpdateChart(
        charts.scatter,
        el.cScatter,
        {
          type: "scatter",
          data: {
            datasets: [
              {
                label: "Project",
                data: pts,
                pointRadius: 3,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { position: "top" },
              tooltip: {
                callbacks: {
                  label: (ctx) => {
                    const { x, y } = ctx.raw || {};
                    return `Duration: ${Math.round(x)} days, Var: ${(y*100).toFixed(1)}%`;
                  },
                },
              },
            },
            scales: {
              x: { title: { display: true, text: "Duration (days)" }, grid: { display: false } },
              y: { title: { display: true, text: "Cost Variance (%)" },
                   ticks: { callback: (v) => `${(v*100).toFixed(0)}%` },
                   beginAtZero: true },
            },
          },
        }
      );
    }
  }

  // ---------- Chart helpers ----------
  function axisOptions({ money, rotateX = false, yTickFmt, tooltipFmt, stacked = false }) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "top" },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              let v = ctx.parsed.y ?? ctx.parsed;
              if (tooltipFmt) return `${ctx.dataset.label}: ${tooltipFmt(v)}`;
              if (money) return `${ctx.dataset.label}: $${abbrNumber(v)}`;
              return `${ctx.dataset.label}: ${abbrNumber(v)}`;
            },
          },
        },
      },
      scales: {
        x: {
          stacked,
          grid: { display: false },
          ticks: { maxRotation: rotateX ? 45 : 0, minRotation: rotateX ? 45 : 0 },
        },
        y: {
          stacked,
          beginAtZero: true,
          ticks: {
            callback: (v) => {
              if (yTickFmt) return yTickFmt(v);
              return money ? `$${abbrNumber(v)}` : abbrNumber(v);
            },
          },
        },
      },
    };
  }

  function drawOrUpdateChart(existing, canvasEl, config) {
    if (!canvasEl) return existing;
    if (existing) {
      existing.data = config.data;
      existing.options = config.options;
      existing.update();
      return existing;
    }
    const ctx = canvasEl.getContext("2d");
    return new Chart(ctx, config);
  }
});
