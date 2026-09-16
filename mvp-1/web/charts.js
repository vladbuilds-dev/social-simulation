// Лёгкие SVG-графики без зависимостей. Цвета — CSS-переменные, так что тема подхватывается сама.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function niceTicks(max, count = 4) {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks = [0];
  while (ticks[ticks.length - 1] < max - step * 1e-6) ticks.push(+(ticks.length * step).toFixed(10));
  return ticks;
}

/**
 * series: [{ label, color, values: number[], band?: {lo: number[], hi: number[]}, dashed?, width? }]
 * xs: значения по оси X (одинаковые для всех серий)
 */
export function lineChart(el, opts) {
  el._chart = opts;
  const {
    series, xs, yMax: yMaxOpt, yFormat = (v) => v, xFormat = (v) => v,
    xLabel = "", cursor = null, height = 250, xTicks = null, markers = [], legend = true,
  } = opts;

  const width = Math.max(260, el.clientWidth || 600);
  const m = { top: 12, right: 14, bottom: xLabel ? 42 : 26, left: 46 };
  const w = width - m.left - m.right;
  const h = height - m.top - m.bottom;

  const dataMax = Math.max(1e-9, ...series.flatMap((s) => (s.band ? s.band.hi : s.values)));
  const yTicks = niceTicks(yMaxOpt ?? dataMax, 4);
  const yMax = yMaxOpt ?? yTicks[yTicks.length - 1];
  const x0 = xs[0];
  const x1 = xs[xs.length - 1];
  const sx = (v) => m.left + ((v - x0) / (x1 - x0 || 1)) * w;
  const sy = (v) => m.top + h - (Math.min(v, yMax) / yMax) * h;

  const path = (vals) => vals.map((v, i) => `${i ? "L" : "M"}${sx(xs[i]).toFixed(1)},${sy(v).toFixed(1)}`).join("");

  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(opts.ariaLabel ?? "График")}">`;

  svg += `<g class="grid">`;
  for (const t of yTicks) svg += `<line x1="${m.left}" x2="${m.left + w}" y1="${sy(t)}" y2="${sy(t)}" />`;
  svg += `</g><g class="axis">`;
  for (const t of yTicks) svg += `<text x="${m.left - 8}" y="${sy(t) + 3.5}" text-anchor="end">${esc(yFormat(t))}</text>`;
  const xt = xTicks ?? niceTicks(x1 - x0, Math.max(3, Math.floor(w / 90))).map((v) => v + x0).filter((v) => v <= x1 + 1e-9);
  for (const t of xt) svg += `<text x="${sx(t)}" y="${m.top + h + 17}" text-anchor="middle">${esc(xFormat(t))}</text>`;
  svg += `<line x1="${m.left}" x2="${m.left + w}" y1="${m.top + h}" y2="${m.top + h}" />`;
  svg += `</g>`;
  if (xLabel) svg += `<text class="axis-title" x="${m.left + w / 2}" y="${height - 6}" text-anchor="middle">${esc(xLabel)}</text>`;

  for (const mk of markers) {
    const x = sx(mk.x);
    svg += `<line x1="${x}" x2="${x}" y1="${m.top}" y2="${m.top + h}" style="stroke:${mk.color};stroke-dasharray:3 3;stroke-width:1" />`;
    if (mk.label) svg += `<text x="${x + 5}" y="${m.top + h - 6}" style="fill:${mk.color};font:500 11px var(--mono)">${esc(mk.label)}</text>`;
  }

  for (const s of series) {
    if (!s.band) continue;
    const up = s.band.hi.map((v, i) => `${i ? "L" : "M"}${sx(xs[i]).toFixed(1)},${sy(v).toFixed(1)}`).join("");
    const down = s.band.lo
      .map((v, i) => [sx(xs[i]), sy(Math.max(0, v))])
      .reverse()
      .map(([a, b]) => `L${a.toFixed(1)},${b.toFixed(1)}`)
      .join("");
    svg += `<path d="${up}${down}Z" style="fill:${s.color};opacity:0.12" />`;
  }
  for (const s of series) {
    svg += `<path d="${path(s.values)}" style="fill:none;stroke:${s.color};stroke-width:${s.width ?? 2.2};stroke-linejoin:round;stroke-linecap:round${s.dashed ? ";stroke-dasharray:5 4" : ""}" />`;
    if (s.dots) for (let i = 0; i < xs.length; i++) svg += `<circle cx="${sx(xs[i])}" cy="${sy(s.values[i])}" r="2.6" style="fill:${s.color}" />`;
  }

  if (cursor !== null && cursor !== undefined) {
    const x = sx(cursor);
    svg += `<line x1="${x}" x2="${x}" y1="${m.top}" y2="${m.top + h}" style="stroke:var(--ink);stroke-width:1;opacity:0.45" />`;
    for (const s of series) {
      const i = xs.indexOf(cursor);
      if (i >= 0) svg += `<circle cx="${x}" cy="${sy(s.values[i])}" r="3.6" style="fill:var(--surface);stroke:${s.color};stroke-width:2" />`;
    }
  }
  svg += `</svg>`;

  if (legend) {
    svg += `<ul class="chart-legend">${series
      .map((s) => `<li><i class="${s.dashed ? "dashed" : ""}" style="border-color:${s.color}"></i>${esc(s.label)}</li>`)
      .join("")}</ul>`;
  }
  el.innerHTML = svg;
}

export function rerender(el) {
  if (el._chart) lineChart(el, el._chart);
}

export const pctFmt = (digits = 0) => (v) => `${(v * 100).toFixed(digits)}%`;
