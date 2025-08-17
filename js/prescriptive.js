// ==================== Prescriptive Dashboard JS (improved) ====================
// Rule-based recommendations on synthetic data with diversified categories,
// realistic risk spread, and clearer priority/savings signals.
// ==============================================================================

window.addEventListener("DOMContentLoaded", () => {
  const $ = (id) => document.getElementById(id);
  const money = (n) => (isFinite(n) ? `$${Math.round(n).toLocaleString()}` : "N/A");
  const parseDate = (s) => (s ? new Date(s) : null);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const randJitter = (amt) => (Math.random() * 2 - 1) * amt;

  const el = {
    topN: $("topN"),
    kRec: $("kpiRecCount"),
    kHigh: $("kpiHighRisk"),
    kSave: $("kpiSavings"),
    cMix: $("actionMix"),
    cMatrix: $("priorityMatrix"),
    recTable: $("recTable"),
  };

  const charts = { mix: null, matrix: null };
  let projects = [], cos = [];

  Promise.all([
    d3.csv("../data/projects.csv"),
    d3.csv("../data/change_orders.csv"),
  ]).then(([pr, co]) => {
    projects = pr.map(d => ({
      project_id: d.project_id,
      project_name: d.project_name || `Project ${d.project_id}`,
      start_date: d.start_date,
      planned_end: d.planned_end,
      actual_end: d.actual_end || "",
      planned_budget: +d.planned_budget,
      actual_cost: +d.actual_cost
    }));
    cos = co.map(d => ({ project_id: d.project_id, co_cost: +d.co_cost, date: d.date }));

    render();
    el.topN.addEventListener("change", render);
  });

  // ---------- helpers ----------
  function changeOrderTotals() {
    const m = {};
    cos.forEach(r => {
      const k = r.project_id || "__missing__";
      const c = isFinite(r.co_cost) ? r.co_cost : 0;
      m[k] = (m[k]||0) + c;
    });
    return m;
  }
  function scheduleSlipDays(p){
    const pe=parseDate(p.planned_end), ae=parseDate(p.actual_end);
    if (!pe || !ae || isNaN(pe) || isNaN(ae)) return 0;
    return (ae-pe)/(1000*60*60*24);
  }
  function costOverrun(p){
    if (!isFinite(p.planned_budget) || !isFinite(p.actual_cost)) return 0;
    return p.actual_cost - p.planned_budget;
  }

  // --- produce a spread of 0..100 risks across the portfolio ---
  function computeRiskScores(ps, coMap){
    // raw components
    const raws = ps.map(p => {
      const size = Math.log10(Math.max(1, p.planned_budget));           // ~5–8 for big jobs
      const slip = Math.max(0, scheduleSlipDays(p));                     // days late (0+)
      const over = Math.max(0, costOverrun(p));                          // $
      const co   = Math.max(0, coMap[p.project_id] || 0);                // $

      // Softer weights to avoid saturation; add log scaling
      const coTerm   = Math.log10(1 + co / Math.max(1, p.planned_budget)); // 0..~something small
      const overTerm = Math.log10(1 + over / Math.max(1, p.planned_budget));
      const slipTerm = slip / 60;  // 60 days ~ 1.0
      const sizeTerm = (size - 4.5); // normalize around ~0

      // Raw composite (unbounded)
      const raw = 18*sizeTerm + 15*slipTerm + 22*coTerm + 18*overTerm;
      return { id: p.project_id, raw, parts:{sizeTerm, slipTerm, coTerm, overTerm} };
    });

    // min–max normalize to 0..100
    const mn = d3.min(raws, r => r.raw);
    const mx = d3.max(raws, r => r.raw);
    const span = mx - mn || 1;
    return raws.reduce((acc, r) => {
      acc[r.id] = clamp( ((r.raw - mn)/span) * 100 + randJitter(2), 0, 100 );
      return acc;
    }, {});
  }

  // --- action selection uses drivers: CO share, slip, overrun relative to plan ---
  function chooseAction(p, coTot, slip, over){
    const plan = Math.max(1, p.planned_budget);
    const coShare = coTot / Math.max(1, (over + coTot));    // share of “pain” due to COs
    const overPct = over / plan;                            // overrun intensity

    // decision rules to diversify categories
    if (coShare >= 0.55 && overPct >= 0.03) {
      // COs dominate + noticeable overrun
      return Math.random() < 0.6 ? "Scope alignment" : "Design clarification";
    }
    if (slip >= 45 && overPct < 0.05) {
      // Schedule slip large but overrun modest
      return "Schedule tune-up";
    }
    if (plan >= 5_000_000 && (overPct >= 0.02 || coShare >= 0.35)) {
      // larger projects with moderate pressure
      return "Supplier/subcontractor review";
    }
    // default: mix clarifications & tune-up
    return Math.random() < 0.5 ? "Design clarification" : "Schedule tune-up";
  }

  // effort/impact templates by category (with light randomness)
  const CAT_PROFILE = {
    "Scope alignment":             { impact: [0.75, 0.95], effort: [0.45, 0.7]  },
    "Design clarification":        { impact: [0.55, 0.8],  effort: [0.35, 0.55] },
    "Supplier/subcontractor review":{impact: [0.45, 0.7],  effort: [0.45, 0.65] },
    "Schedule tune-up":            { impact: [0.35, 0.55], effort: [0.25, 0.45] },
  };
  function sampleRange([lo,hi]){ return clamp(lo + Math.random()*(hi-lo) + randJitter(0.02), 0, 1); }

  // savings estimate tied to driver + capped by % of plan
  function estimateSavings(p, cat, over, coTot){
    const plan = Math.max(1, p.planned_budget);
    let pct;
    switch(cat){
      case "Scope alignment":              pct = 0.10 + Math.min(0.06, coTot/plan); break;
      case "Design clarification":         pct = 0.07; break;
      case "Supplier/subcontractor review":pct = 0.05; break;
      case "Schedule tune-up":             pct = 0.03 + Math.min(0.02, Math.max(0, scheduleSlipDays(p))/180); break;
      default: pct = 0.04;
    }
    const base = over + coTot;           // where savings can come from
    const capped = Math.min(0.07*plan, pct * base);  // cap at 7% of plan
    return Math.max(0, capped);
  }

  function render(){
    const topN = parseInt(el.topN.value,10) || 10;
    const coMap = changeOrderTotals();

    // compute risks with spread
    const riskById = computeRiskScores(projects, coMap);

    // build recommendations
    const recs = projects.map(p => {
      const slip = Math.max(0, scheduleSlipDays(p));
      const over = Math.max(0, costOverrun(p));
      const coTot = Math.max(0, coMap[p.project_id] || 0);

      const category = chooseAction(p, coTot, slip, over);
      const profile = CAT_PROFILE[category];
      const impact = sampleRange(profile.impact);
      const effort = sampleRange(profile.effort);
      const savings = estimateSavings(p, category, over, coTot);

      return {
        id: p.project_id,
        name: p.project_name,
        category,
        impact,
        effort,
        savings,
        risk: Math.round(riskById[p.project_id] ?? 0),
        overrun: over,
        co_total: coTot,
        plan: p.planned_budget
      };
    }).sort((a,b)=> b.risk - a.risk || b.savings - a.savings);

    const highRisk = recs.filter(r => r.risk >= 80).length;
    const totalSavings = recs.reduce((a,b)=>a+b.savings,0);

    // KPIs
    if (el.kRec)  el.kRec.textContent = recs.length.toString();
    if (el.kHigh) el.kHigh.textContent = highRisk.toString();
    if (el.kSave) el.kSave.textContent = money(totalSavings);

    // Action mix
    const mixCounts = {};
    recs.forEach(r => { mixCounts[r.category]=(mixCounts[r.category]||0)+1; });
    const mixLabels = Object.keys(CAT_PROFILE); // fixed order for consistency
    const mixVals = mixLabels.map(k => mixCounts[k] || 0);
    charts.mix = drawOrUpdate(charts.mix, el.cMix, {
      type: "bar",
      data: { labels: mixLabels, datasets: [{ label: "Count", data: mixVals, categoryPercentage: 0.9, barPercentage: 0.9 }] },
      options: axisBase()
    });

    // Priority matrix bubble (impact vs effort, radius ~ savings)
    const pts = recs.map(r => ({ x: r.effort, y: r.impact, r: Math.max(3, Math.sqrt(r.savings)/250) }));
    charts.matrix = drawOrUpdate(charts.matrix, el.cMatrix, {
      type: "bubble",
      data: { datasets: [{ label: "Recommendations", data: pts }] },
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{position:"top"},
          tooltip:{ callbacks:{ label:(ctx)=> {
            const p = recs[ctx.dataIndex];
            return `${p.name} — ${p.category}\nRisk ${p.risk} | Impact ${p.impact.toFixed(2)} | Effort ${p.effort.toFixed(2)} | Savings ${money(p.savings)}`;
          }}}},
        scales:{
          x:{ min:0, max:1, title:{display:true, text:"Effort (0–1)"}, grid:{display:false}},
          y:{ min:0, max:1, title:{display:true, text:"Impact (0–1)"}, beginAtZero:true}
        }
      }
    });

    // Table (top N)
    if (el.recTable){
      const rows = recs.slice(0, topN)
        .map(r => `<tr>
          <td style="white-space:nowrap">${r.name}</td>
          <td>${r.category}</td>
          <td style="text-align:right">${r.risk}</td>
          <td style="text-align:right">${money(r.savings)}</td>
        </tr>`).join("");
      el.recTable.innerHTML = `
        <div class="table-wrap" style="overflow:auto;">
          <table class="simple-table">
            <thead><tr>
              <th>Project</th><th>Recommended Action</th><th>Risk</th><th>Est. Savings</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    }
  }

  // ---------- chart helpers ----------
  function drawOrUpdate(existing, canvas, config){
    if (!canvas) return existing;
    if (existing){ existing.data=config.data; existing.options=config.options; existing.update(); return existing; }
    return new Chart(canvas.getContext("2d"), config);
  }
  function axisBase(){ return {responsive:true, maintainAspectRatio:false, plugins:{legend:{position:"top"}}}; }
});
