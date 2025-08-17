// ==================== Descriptive Dashboard JS ====================
// Works with dashboards/descriptive.html and data/projects.csv
// KPIs: Total Projects, Average Cost, Average Duration
// Charts:
//   - All years: Projects by YEAR, Avg Actual Cost by YEAR
//   - Specific year: Projects by MONTH, Avg Actual Cost by MONTH
// Totals (Planned vs Actual) always reflect the current filter slice
// ==================================================================

window.addEventListener("DOMContentLoaded", () => {
  // ---------- DOM helpers ----------
  const $ = (id) => document.getElementById(id);
  const moneyStr = (n) =>
    n == null || isNaN(n) ? "N/A" : `$${Math.round(n).toLocaleString()}`;
  const parseDate = (s) => (s ? new Date(s) : null);

  // Compact number formatting for axes/tooltips
  function abbrNumber(n) {
    if (!isFinite(n)) return "0";
    const abs = Math.abs(n);
    if (abs >= 1e12) return (n / 1e12).toFixed(1) + "T";
    if (abs >= 1e9)  return (n / 1e9 ).toFixed(1) + "B";
    if (abs >= 1e6)  return (n / 1e6 ).toFixed(1) + "M";
    if (abs >= 1e3)  return (n / 1e3 ).toFixed(1) + "K";
    return String(Math.round(n));
  }
  const moneyAbbr = (n) => `$${abbrNumber(n)}`;
  const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // ---------- Elements ----------
  const el = {
    yearFilter: $("yearFilter"),
    total: $("totalProjects"),
    avgCost: $("averageCost"),
    avgDur: $("averageDuration"),
    cProjectsByYear: $("projectsByYear"),
    cTotalsBar: $("totalsBar"),
    cAvgCostByYear: $("avgCostByYear"),
  };

  // Warn if any element is missing
  Object.entries(el).forEach(([k, v]) => {
    if (!v) console.warn(`[DESCRIPTIVE] Missing element: ${k}`);
  });

  // ---------- Data & charts ----------
  let allProjects = [];
  const charts = { projectsByYear: null, totalsBar: null, avgCostByYear: null };

  // Load CSV (path is relative to the PAGE URL: /dashboards/descriptive.html)
  d3.csv("../data/projects.csv")
    .then((rows) => {
      // Coerce numeric fields and keep date strings (parse on use)
      allProjects = rows.map((d) => ({
        ...d,
        planned_budget: +d.planned_budget,
        actual_cost: +d.actual_cost,
        completion_pct: +d.completion_pct,
        start_date: d.start_date,
        planned_end: d.planned_end,
        actual_end: d.actual_end || "", // may be empty for in-flight projects
      }));

      populateYearFilter(allProjects);
      update(allProjects); // initial render

      el.yearFilter.addEventListener("change", () => {
        const y = el.yearFilter.value;
        const filtered =
          y === "all"
            ? allProjects
            : allProjects.filter(
                (r) => new Date(r.start_date).getFullYear().toString() === y
              );
        update(filtered);
      });
    })
    .catch((err) => {
      console.error("[DESCRIPTIVE] Failed to load ../data/projects.csv:", err);
    });

  // ---------- UI builders ----------
  function populateYearFilter(data) {
    const years = Array.from(
      new Set(data.map((r) => new Date(r.start_date).getFullYear()))
    ).sort((a, b) => a - b);

    years.forEach((y) => {
      const opt = document.createElement("option");
      opt.value = y;
      opt.textContent = y;
      el.yearFilter.appendChild(opt);
    });
  }

  function update(data) {
    updateKPIs(data);
    const selected = el.yearFilter.value; // "all" or "YYYY"
    renderCharts(data, selected);
  }

  // ---------- KPIs ----------
  function updateKPIs(data) {
    // Total projects
    el.total.textContent = data.length;

    // Average actual cost
    const avgCost = d3.mean(
      data,
      (r) => (isFinite(r.actual_cost) ? r.actual_cost : NaN)
    );
    el.avgCost.textContent = moneyStr(avgCost);

    // Average duration (days) using actual_end if present else planned_end
    const durations = data
      .map((r) => {
        const s = parseDate(r.start_date);
        const e = parseDate(r.actual_end) || parseDate(r.planned_end);
        return s && e ? (e - s) / (1000 * 60 * 60 * 24) : NaN;
      })
      .filter((v) => isFinite(v));
    const avgDuration = d3.mean(durations);
    el.avgDur.textContent =
      avgDuration != null && isFinite(avgDuration)
        ? `${Math.round(avgDuration)} days`
        : "N/A";
  }

  // ---------- Rollups ----------
  // by year
  function rollupCountByYear(rows) {
    const out = {};
    rows.forEach((r) => {
      const y = new Date(r.start_date).getFullYear();
      out[y] = (out[y] || 0) + 1;
    });
    return out;
  }
  function rollupAvgActualCostByYear(rows) {
    const sums = {};
    const counts = {};
    rows.forEach((r) => {
      const y = new Date(r.start_date).getFullYear();
      if (isFinite(r.actual_cost)) {
        sums[y] = (sums[y] || 0) + r.actual_cost;
        counts[y] = (counts[y] || 0) + 1;
      }
    });
    const out = {};
    Object.keys(sums).forEach((y) => (out[y] = sums[y] / counts[y]));
    return out;
  }
  // by month in a given year
  function rollupCountByMonth(rows, year) {
    const counts = Array(12).fill(0);
    rows.forEach((r) => {
      const d = new Date(r.start_date);
      if (!isNaN(d) && d.getFullYear() === year) counts[d.getMonth()] += 1;
    });
    return counts;
  }
  function rollupAvgActualCostByMonth(rows, year) {
    const sums = Array(12).fill(0);
    const counts = Array(12).fill(0);
    rows.forEach((r) => {
      const d = new Date(r.start_date);
      if (!isNaN(d) && d.getFullYear() === year && isFinite(r.actual_cost)) {
        const m = d.getMonth();
        sums[m] += r.actual_cost;
        counts[m] += 1;
      }
    });
    return sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
  }

  // ---------- Charts ----------
  function renderCharts(data, selectedYearValue) {
    const isAll = selectedYearValue === "all";
    const yearInt = isAll ? null : parseInt(selectedYearValue, 10);

    // Update titles to reflect mode
    const projectsTitle = el.cProjectsByYear?.previousElementSibling;
    const totalsTitle   = el.cTotalsBar?.previousElementSibling; // unchanged
    const costTitle     = el.cAvgCostByYear?.previousElementSibling;
    if (projectsTitle) projectsTitle.textContent = isAll ? "Projects by Year" : `Projects by Month (${yearInt})`;
    if (costTitle)     costTitle.textContent     = isAll ? "Avg Actual Cost by Year" : `Avg Actual Cost by Month (${yearInt})`;

    // ----- 1) Projects: by year OR by month -----
    let labels, values, rotateX;
    if (isAll) {
      const countsByYear = rollupCountByYear(data);
      labels = Object.keys(countsByYear).map(Number).sort((a, b) => a - b);
      values = labels.map((y) => countsByYear[y] || 0);
      rotateX = labels.length > 12;
    } else {
      labels = MONTH_LABELS.slice();
      values = rollupCountByMonth(data, yearInt);
      rotateX = false;
    }

    charts.projectsByYear = drawOrUpdateChart(
      charts.projectsByYear,
      el.cProjectsByYear,
      {
        type: "bar",
        data: {
          labels,
          datasets: [
            {
              label: isAll ? "Projects" : `Projects in ${yearInt}`,
              data: values,
              categoryPercentage: 0.9,
              barPercentage: 0.9,
            },
          ],
        },
        options: axisOptions({ money: false, rotateX }),
      }
    );

    // ----- 2) Totals planned vs actual (always current slice) -----
    const totalPlanned = sumSafe(data.map((r) => r.planned_budget));
    const totalActual  = sumSafe(data.map((r) => r.actual_cost));

    charts.totalsBar = drawOrUpdateChart(
      charts.totalsBar,
      el.cTotalsBar,
      {
        type: "bar",
        data: {
          labels: ["Totals"],
          datasets: [
            { label: "Planned", data: [totalPlanned] },
            { label: "Actual",  data: [totalActual]  },
          ],
        },
        options: axisOptions({ money: true }),
      }
    );

    // ----- 3) Avg actual cost: by year OR by month -----
    let costLabels, costValues, costRotateX;
    if (isAll) {
      const avgCostByYear = rollupAvgActualCostByYear(data);
      costLabels = Object.keys(avgCostByYear).map(Number).sort((a, b) => a - b);
      costValues = costLabels.map((y) => avgCostByYear[y]);
      costRotateX = costLabels.length > 12;
    } else {
      costLabels = MONTH_LABELS.slice();
      costValues = rollupAvgActualCostByMonth(data, yearInt);
      costRotateX = false;
    }

    charts.avgCostByYear = drawOrUpdateChart(
      charts.avgCostByYear,
      el.cAvgCostByYear,
      {
        type: "line",
        data: {
          labels: costLabels,
          datasets: [
            {
              label: isAll ? "Avg Actual Cost" : `Avg Actual Cost (${yearInt})`,
              data: costValues,
              tension: 0.25,
              pointRadius: 3,
            },
          ],
        },
        options: axisOptions({ money: true, rotateX: costRotateX }),
      }
    );
  }

  // ---------- Chart helpers ----------
  function axisOptions({ money, rotateX = false }) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "top" },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y ?? ctx.parsed;
              const val = money ? moneyAbbr(v) : abbrNumber(v);
              return `${ctx.dataset.label}: ${val}`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxRotation: rotateX ? 45 : 0, minRotation: rotateX ? 45 : 0 },
        },
        y: {
          beginAtZero: true,
          ticks: {
            callback: (v) => (money ? moneyAbbr(v) : abbrNumber(v)),
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

  // ---------- utils ----------
  function sumSafe(arr) {
    return arr.reduce((acc, v) => (isFinite(v) ? acc + v : acc), 0);
  }
});
