// ==================== Predictive Dashboard JS ====================
// Demo forecasts from trends & rules on synthetic data.
// - Loads data/projects.csv and data/change_orders.csv
// - KPIs: next-year avg cost (forecast), portfolio overrun probability,
//         count of at-risk projects (rule-based)
// - Charts: avg cost forecast, schedule variance forecast, overrun probabilities,
//           risk score histogram, pipeline cost forecast
// =================================================================

window.addEventListener("DOMContentLoaded", () => {
  const $ = (id) => document.getElementById(id);
  const money = (n) => (isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "N/A");
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  const el = {
    horizon: $("horizonSelect"),

    kNextCost: $("kpiNextYearCost"),
    kOverrunProb: $("kpiOverrunProb"),
    kAtRisk: $("kpiAtRiskCount"),

    cAvgCostForecast: $("avgCostForecast"),
    cSchedVarForecast: $("schedVarForecast"),
    cOverrunProb: $("overrunProbabilities"),
    cRiskHist: $("riskScoreHistogram"),
    cPipeline: $("pipelineForecast"),
  };

  const charts = { avgCost: null, schedVar: null, prob: null, risk: null, pipe: null };
  let projects = [], cos = [];

  Promise.all([
    d3.csv("../data/projects.csv"),
    d3.csv("../data/change_orders.csv"),
  ]).then(([pr, co]) => {
    projects = pr.map(d => ({
      project_id: d.project_id,
      start_date: d.start_date,
      planned_end: d.planned_end,
      actual_end: d.actual_end || "",
      planned_budget: +d.planned_budget,
      actual_cost: +d.actual_cost
    }));
    cos = co.map(d => ({
      project_id: d.project_id,
      co_cost: +d.co_cost,
      date: d.date
    }));

    render();
    el.horizon.addEventListener("change", render);
  });

  // ---------- derived ----------
  const parseDate = (s) => (s ? new Date(s) : null);
  const mean = (arr) => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;

  function avgActualCostByYear(rows) {
    const sums = {}, cnts = {};
    rows.forEach(r => {
      const y = new Date(r.start_date).getFullYear();
      if (!isFinite(r.actual_cost)) return;
      sums[y] = (sums[y]||0) + r.actual_cost;
      cnts[y] = (cnts[y]||0) + 1;
    });
    const out = {};
    Object.keys(sums).forEach(y => out[y] = sums[y]/cnts[y]);
    return out;
  }

  function avgScheduleVarianceByYear(rows) {
    const sums = {}, cnts = {};
    rows.forEach(r => {
      const pe = parseDate(r.planned_end);
      const ae = parseDate(r.actual_end);
      if (!pe || !ae || isNaN(pe) || isNaN(ae)) return;
      const y = new Date(r.start_date).getFullYear();
      const days = (ae - pe)/(1000*60*60*24);
      sums[y] = (sums[y]||0) + days;
      cnts[y] = (cnts[y]||0) + 1;
    });
    const out = {};
    Object.keys(sums).forEach(y => out[y] = sums[y]/cnts[y]);
    return out;
  }

  // simple linear regression y = a + b*x over year numbers
  function linReg(seriesObj) {
    const xs = Object.keys(seriesObj).map(Number).sort((a,b)=>a-b);
    const ys = xs.map(x => seriesObj[x]);
    if (xs.length < 2) return {a: ys[0]||0, b: 0, xs, ys};
    const n = xs.length;
    const sx = xs.reduce((a,b)=>a+b,0);
    const sy = ys.reduce((a,b)=>a+b,0);
    const sxx = xs.reduce((a,b)=>a+b*b,0);
    const sxy = xs.reduce((a,_,i)=>a+xs[i]*ys[i],0);
    const b = (n*sxy - sx*sy) / Math.max(1,(n*sxx - sx*sx));
    const a = (sy - b*sx) / n;
    return {a,b,xs,ys};
  }

  function forecastNextYears(a, b, lastYear, horizon) {
    const labels = [];
    const vals = [];
    for (let i=1; i<=horizon; i++) {
      const y = lastYear + i;
      labels.push(y);
      vals.push(a + b*y);
    }
    return {labels, vals};
  }

  function portfolioOverrunProbability(rows) {
    // baseline: share of projects with actual > planned
    const elig = rows.filter(r => isFinite(r.planned_budget) && r.planned_budget>0 && isFinite(r.actual_cost));
    const over = elig.filter(r => r.actual_cost > r.planned_budget).length;
    const base = elig.length ? over/elig.length : 0;

    // a crude "adjusted" probability: bump up by +5% if avg schedule variance > 0
    const schedVar = mean(rows.map(r => {
      const pe=parseDate(r.planned_end), ae=parseDate(r.actual_end);
      return (pe&&ae)? (ae-pe)/(1000*60*60*24) : NaN;
    }).filter(v=>isFinite(v)));
    const adj = Math.min(1, Math.max(0, base + (schedVar>0 ? 0.05 : -0.02)));
    return {base, adj};
  }

  function ruleRiskScore(row, coMap) {
    // Heuristic: weight by size, schedule slip, and CO magnitude
    const size = Math.log10(Math.max(1, row.planned_budget)); // 0..?
    const pe=parseDate(row.planned_end), ae=parseDate(row.actual_end);
    const slipDays = (pe&&ae)? Math.max(0,(ae-pe)/(1000*60*60*24)) : 0;
    const coTotal = coMap[row.project_id] || 0;
    // Scale to ~0..100
    const score = 20*size + 0.05*slipDays + 0.000005*coTotal;
    return Math.min(100, Math.round(score));
  }

  function changeOrderTotalsByProject(cos) {
    const m = {};
    cos.forEach(r => {
      const k = r.project_id || "__missing__";
      const c = isFinite(r.co_cost) ? r.co_cost : 0;
      m[k] = (m[k]||0) + c;
    });
    return m;
  }

  function render() {
    const horizon = parseInt(el.horizon.value, 10) || 3;

    // --- build series ---
    const avgCostByYear = avgActualCostByYear(projects);
    const costReg = linReg(avgCostByYear);
    const costForecast = forecastNextYears(costReg.a, costReg.b, Math.max(...costReg.xs), horizon);

    const schedByYear = avgScheduleVarianceByYear(projects);
    const schedReg = linReg(schedByYear);
    const schedForecast = forecastNextYears(schedReg.a, schedReg.b, Math.max(...Object.keys(schedByYear).map(Number)), horizon);

    const {base, adj} = portfolioOverrunProbability(projects);

    // risk scores
    const coTotals = changeOrderTotalsByProject(cos);
    const scores = projects.map(p => ruleRiskScore(p, coTotals));
    const atRiskCount = scores.filter(s => s>=70).length;

    // pipeline forecast: naive = count of projects per year * mean actual cost trend extended
    const yrs = costReg.xs;
    const counts = {};
    projects.forEach(r => {
      const y = new Date(r.start_date).getFullYear();
      counts[y] = (counts[y]||0)+1;
    });
    const lastYear = Math.max(...yrs);
    const avgCount = mean(Object.values(counts));
    const pipeYears = [];
    const pipeVals = [];
    for (let i=1;i<=3;i++){
      const y = lastYear+i;
      pipeYears.push(y);
      const avgCost = costReg.a + costReg.b*y;
      pipeVals.push(Math.max(0, avgCount*avgCost));
    }

    // --- KPIs ---
    if (el.kNextCost) el.kNextCost.textContent = money(costReg.a + costReg.b*(lastYear+1));
    if (el.kOverrunProb) el.kOverrunProb.textContent = `${Math.round(adj*100)}%`;
    if (el.kAtRisk) el.kAtRisk.textContent = atRiskCount.toString();

    // --- Charts ---
    charts.avgCost = drawOrUpdate(charts.avgCost, el.cAvgCostForecast, {
      type: "line",
      data: {
        labels: [...costReg.xs, ...costForecast.labels],
        datasets: [
          { label: "Avg Actual Cost (history)", data: costReg.xs.map(x => avgCostByYear[x]), tension: 0.25, pointRadius: 3 },
          { label: "Forecast", data: [...Array(costReg.xs.length).fill(null), ...costForecast.vals], borderDash: [6,6], tension: 0.25, pointRadius: 3 },
        ]
      },
      options: moneyAxis()
    });

    charts.schedVar = drawOrUpdate(charts.schedVar, el.cSchedVarForecast, {
      type: "line",
      data: {
        labels: [...Object.keys(schedByYear).map(Number).sort((a,b)=>a-b), ...schedForecast.labels],
        datasets: [
          { label: "Avg Schedule Var (days)", data: Object.keys(schedByYear).map(Number).sort((a,b)=>a-b).map(y => schedByYear[y]), tension: 0.25, pointRadius: 3 },
          { label: "Forecast", data: [...Array(Object.keys(schedByYear).length).fill(null), ...schedForecast.vals], borderDash: [6,6], tension: 0.25, pointRadius: 3 },
        ]
      },
      options: numberAxis("days")
    });

    charts.prob = drawOrUpdate(charts.prob, el.cOverrunProb, {
      type: "bar",
      data: { labels: ["Baseline", "Adjusted"], datasets: [{ label: "Probability", data: [base, adj] }] },
      options: percentAxis()
    });

    // risk histogram
    const bins = [0,20,40,60,80,100];
    const labels = ["0–20","21–40","41–60","61–80","81–100"];
    const hist = Array(labels.length).fill(0);
    scores.forEach(s => {
      if (s<=20) hist[0]++; else if (s<=40) hist[1]++; else if (s<=60) hist[2]++; else if (s<=80) hist[3]++; else hist[4]++;
    });
    charts.risk = drawOrUpdate(charts.risk, el.cRiskHist, {
      type: "bar",
      data: { labels, datasets: [{ label: "Projects", data: hist, categoryPercentage: 0.9, barPercentage: 0.9 }] },
      options: countAxis()
    });

    charts.pipe = drawOrUpdate(charts.pipe, el.cPipeline, {
      type: "bar",
      data: {
        labels: pipeYears,
        datasets: [{ label: "Projected Pipeline Cost", data: pipeVals }]
      },
      options: moneyAxis()
    });
  }

  // ---------- chart helpers ----------
  function drawOrUpdate(existing, canvas, config){
    if (!canvas) return existing;
    if (existing){ existing.data=config.data; existing.options=config.options; existing.update(); return existing; }
    return new Chart(canvas.getContext("2d"), config);
  }
  function baseAxis(){ return {responsive:true, maintainAspectRatio:false, plugins:{legend:{position:"top"}}}; }
  function moneyAxis(){ return { ...baseAxis(), scales:{y:{beginAtZero:true, ticks:{callback:(v)=>"$"+Number(v).toLocaleString()}}}}; }
  function numberAxis(suffix){ return { ...baseAxis(), scales:{y:{beginAtZero:true, ticks:{callback:(v)=>`${Math.round(v)} ${suffix||""}`}}}}; }
  function percentAxis(){ return { ...baseAxis(), scales:{y:{beginAtZero:true, ticks:{callback:(v)=>`${Math.round(v*100)}%`}}}, plugins:{legend:{position:"top"}, tooltip:{callbacks:{label:(ctx)=>`${(ctx.parsed.y*100).toFixed(1)}%`}}}}; }
  function countAxis(){ return { ...baseAxis(), scales:{y:{beginAtZero:true}}}; }
});
