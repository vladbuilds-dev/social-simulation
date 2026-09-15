import {
  CASCADE_THRESHOLD, DEFAULT_SCENARIO, Opinion, T, TYPE_LABELS,
  mean, meanCurve, runMany, Simulation,
} from "./sim.js";
import { forceLayout } from "./layout.js";
import { lineChart, pctFmt, rerender } from "./charts.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const STEPS_PER_SEC = 4;
const P_MAX = 0.8;
const PLACE = { random: "случайно", hubs: "в хабах", periphery: "на периферии" };
const NET_LABEL = { scale_free: "С хабами", small_world: "Small-world", random: "Случайная" };

const PRESETS = [
  { id: "none", label: "Без ботов", sc: { botFraction: 0, factcheckFraction: 0 },
    b: { botFraction: 0.05 } },
  { id: "bots", label: "5% ботов", sc: { botFraction: 0.05 },
    b: { factcheckFraction: 0.03, factcheckPlacement: "hubs" } },
  { id: "hubs", label: "Боты в хабах", sc: { botFraction: 0.03, botPlacement: "hubs" },
    b: { botPlacement: "random" } },
  { id: "defense", label: "Боты против фактчекеров", sc: { botFraction: 0.05, factcheckFraction: 0.05, factcheckPlacement: "hubs", factcheckDelay: 1 },
    b: { factcheckPlacement: "random" } },
  { id: "edge", label: "На грани", sc: { pShare: 0.28, initialSpreaders: 3 },
    b: { skepticFraction: 0.3 } },
];
const B_KEYS = ["botFraction", "botPlacement", "factcheckFraction", "factcheckPlacement", "skepticFraction"];

const state = {
  sc: null,
  b: null,
  sim: null,
  layoutKey: "",
  pos: null,
  step: 0,
  endStep: 0,
  playing: false,
  progress: 0,
  speed: 1,
  hover: -1,
  colors: {},
  riskKey: "",
  sweepKey: "",
};

// ------------------------------------------------------------ утилиты

function plural(n, forms) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
const pct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
const nextFrame = () => new Promise((r) => setTimeout(r, 0));
const scenarioKey = (sc, omit = []) =>
  JSON.stringify(Object.keys(sc).filter((k) => !omit.includes(k)).sort().map((k) => [k, sc[k]]));

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const name of ["ink", "muted", "surface", "edge", "unaware", "seen", "rumor", "rumor-soft", "corr", "corr-soft"]) {
    state.colors[name] = cs.getPropertyValue(`--${name}`).trim();
  }
}

function fractionsInvalid(sc) {
  return sc.skepticFraction + sc.influencerFraction + sc.botFraction + sc.factcheckFraction > 1 + 1e-9;
}

// ------------------------------------------------------------ сценарий

function applyPreset(preset) {
  state.sc = { ...DEFAULT_SCENARIO, ...preset.sc };
  state.b = Object.fromEntries(B_KEYS.map((k) => [k, state.sc[k]]));
  Object.assign(state.b, preset.b);
  syncControls();
  rebuild({ restart: true });
}

function currentPresetLabel() {
  const key = scenarioKey(state.sc, ["seed"]);
  const p = PRESETS.find((pr) => scenarioKey({ ...DEFAULT_SCENARIO, ...pr.sc }, ["seed"]) === key);
  $$("#presets .chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.id === p?.id)));
  return p ? `Сценарий: ${p.label.toLowerCase()}` : "Свой сценарий";
}

function formatValue(input, v) {
  return input.hasAttribute("data-pct") ? pct(v) : String(v);
}

function bindRange(input, get, set) {
  const out = input.closest("label")?.querySelector("output");
  const show = () => out && (out.textContent = formatValue(input, Number(input.value)));
  input.addEventListener("input", () => {
    set(Number(input.value));
    show();
  });
  input._sync = () => {
    input.value = get();
    show();
  };
}

function bindSeg(seg, get, set) {
  const buttons = $$("button", seg);
  buttons.forEach((btn) => {
    btn.setAttribute("role", "radio");
    btn.addEventListener("click", () => {
      set(btn.dataset.value);
      seg._sync();
    });
  });
  seg._sync = () => {
    buttons.forEach((btn) => {
      const on = btn.dataset.value === get();
      btn.setAttribute("aria-checked", String(on));
      btn.tabIndex = on ? 0 : -1;
    });
  };
  seg.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const i = buttons.findIndex((b) => b.dataset.value === get());
    const d = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
    const next = buttons[(i + d + buttons.length) % buttons.length];
    next.click();
    next.focus();
  });
}

function syncControls() {
  $$("[data-param], [data-b]").forEach((el) => el._sync?.());
  $("#p-share").value = state.sc.pShare;
  $("#p-share-out").textContent = state.sc.pShare.toFixed(2);
  $("#seed-out").textContent = state.sc.seed;
}

function initControls() {
  const presets = $("#presets");
  for (const p of PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.dataset.id = p.id;
    b.textContent = p.label;
    b.addEventListener("click", () => applyPreset(p));
    presets.append(b);
  }

  const onScenarioChange = () => rebuild({ restart: true });

  $$("input[data-param]").forEach((input) =>
    bindRange(input, () => state.sc[input.dataset.param], (v) => {
      state.sc[input.dataset.param] = v;
      onScenarioChange();
    }));
  $$(".seg[data-param]").forEach((seg) =>
    bindSeg(seg, () => state.sc[seg.dataset.param], (v) => {
      state.sc[seg.dataset.param] = v;
      onScenarioChange();
    }));
  $$("input[data-b]").forEach((input) =>
    bindRange(input, () => state.b[input.dataset.b], (v) => {
      state.b[input.dataset.b] = v;
      scheduleCompare();
    }));
  $$(".seg[data-b]").forEach((seg) =>
    bindSeg(seg, () => state.b[seg.dataset.b], (v) => {
      state.b[seg.dataset.b] = v;
      scheduleCompare();
    }));

  const pShare = $("#p-share");
  pShare.addEventListener("input", () => {
    state.sc.pShare = Number(pShare.value);
    $("#p-share-out").textContent = state.sc.pShare.toFixed(2);
    onScenarioChange();
  });

  $("#reseed").addEventListener("click", () => {
    state.sc.seed = 1 + Math.floor(Math.random() * 9999);
    $("#seed-out").textContent = state.sc.seed;
    rebuild({ restart: true });
  });

  $("#play").addEventListener("click", () => {
    if (!state.sim) return;
    if (state.playing) return setPlaying(false);
    if (state.step >= state.sim.t) setStep(0);
    setPlaying(true);
  });
  $("#restart").addEventListener("click", () => {
    setStep(0);
    setPlaying(true);
  });
  $("#scrub").addEventListener("input", (e) => {
    setPlaying(false);
    setStep(Number(e.target.value));
  });
  $("#speed").addEventListener("change", (e) => (state.speed = Number(e.target.value)));
  $("#sweep").addEventListener("click", runSweep);
}

// ------------------------------------------------------------ перестройка модели

let rebuildQueued = false;
function rebuild({ restart }) {
  if (rebuildQueued) return;
  rebuildQueued = true;
  // Микрозадача, а не requestAnimationFrame: в фоновой вкладке rAF не срабатывает.
  queueMicrotask(() => {
    rebuildQueued = false;
    const sc = state.sc;
    const err = $("#error");
    if (fractionsInvalid(sc)) {
      err.hidden = false;
      err.textContent = "Скептики, инфлюенсеры, боты и фактчекеры вместе больше 100% сети. Уменьшите какую-нибудь долю.";
      return;
    }
    err.hidden = true;

    state.sim = new Simulation(sc).run();
    const layoutKey = `${sc.network}|${sc.nNodes}|${sc.avgDegree}|${sc.seed}`;
    if (layoutKey !== state.layoutKey) {
      state.pos = forceLayout(state.sim.net, { seed: sc.seed });
      state.layoutKey = layoutKey;
      state.drawOrder = null;
      drawEdgeLayer();
    }

    // Где динамика заканчивается: дальше проигрывать неподвижную картинку незачем.
    const hist = state.sim.history;
    let last = 0;
    for (let i = 1; i < hist.length; i++) {
      const a = hist[i], b = hist[i - 1];
      if (a.rumorReach !== b.rumorReach || a.correction !== b.correction || a.exposed !== b.exposed ||
          a.rumorActive !== b.rumorActive || a.correctionActive !== b.correctionActive) last = i;
    }
    state.endStep = Math.min(state.sim.t, last + 2);

    const scrub = $("#scrub");
    scrub.max = state.sim.t;
    $("#preset-name").textContent = currentPresetLabel();
    $(".lede").textContent = `${sc.nNodes} ${plural(sc.nNodes, ["аккаунт", "аккаунта", "аккаунтов"])}, связанных как в соцсети. На каждом шаге активные аккаунты показывают пост соседям, а те решают: поверить, проверить или пройти мимо.`;

    if (restart && !reduceMotion.matches) {
      setStep(0);
      setPlaying(true);
    } else {
      setPlaying(false);
      setStep(state.sim.t);
    }

    scheduleRisk();
    scheduleCompare();
    markSweepStale();
  });
}

// ------------------------------------------------------------ проигрывание

function setPlaying(on) {
  state.playing = on;
  state.progress = 0;
  const btn = $("#play");
  btn.textContent = on ? "Пауза" : "Смотреть";
  btn.setAttribute("aria-label", on ? "Пауза" : "Смотреть распространение");
  if (on) kick();
}

function setStep(s) {
  const sim = state.sim;
  if (!sim) return;
  state.step = Math.max(0, Math.min(s, sim.t));
  $("#scrub").value = state.step;
  $("#step-label").textContent = `${state.step} / ${sim.t}`;
  updateReadout();
  updateDynamicsChart();
  kick();
}

function updateReadout() {
  const sim = state.sim;
  const row = sim.history[state.step];
  const num = $("#readout-num");
  num.textContent = pct(row.rumorReachFrac);
  num.classList.toggle("is-cascade", row.rumorReachFrac > CASCADE_THRESHOLD);

  const verdict = $("#verdict");
  const atEnd = state.step >= state.endStep || state.step === sim.t;
  if (!atEnd) {
    verdict.innerHTML = `Шаг <b>${state.step}</b> из ${sim.t} · репостят слух: <b>${row.rumorActive}</b> · опровержение: <b>${row.correction}</b>`;
    return;
  }
  const s = sim.summary();
  const crossed = sim.history.find((r) => r.rumorReachFrac > CASCADE_THRESHOLD);
  const peak = `пик — ${s.peakRumorActive} ${plural(s.peakRumorActive, ["репост", "репоста", "репостов"])} на шаге ${s.timeToPeak}`;
  verdict.innerHTML = s.cascade
    ? `<span class="tag tag-cascade">Массовый каскад</span>порог 20% пройден на шаге ${crossed.step}, ${peak}`
    : `<span class="tag tag-fade">Слух затух</span>${peak}, видели слух ${pct(s.exposedFrac)}`;
}

function updateDynamicsChart() {
  const sim = state.sim;
  const hist = sim.history;
  const humans = Math.max(1, sim.humans.length);
  lineChart($("#dyn-chart"), {
    xs: hist.map((r) => r.step),
    series: [
      { label: "поверили слуху", color: "var(--rumor)", values: hist.map((r) => r.rumorReachFrac) },
      { label: "репостят слух сейчас", color: "var(--rumor)", dashed: true, width: 1.6, values: hist.map((r) => r.rumorActive / humans) },
      { label: "приняли опровержение", color: "var(--corr)", values: hist.map((r) => r.correctionFrac) },
      { label: "видели слух", color: "var(--seen)", width: 1.6, values: hist.map((r) => r.exposedFrac) },
    ],
    yFormat: pctFmt(),
    xLabel: "шаг",
    cursor: state.step,
    height: 220,
    ariaLabel: "Доли людей по шагам симуляции",
  });
}

// ------------------------------------------------------------ сеть на canvas

const canvas = $("#net");
const ctx = canvas.getContext("2d");
const edgeLayer = document.createElement("canvas");
let geom = { w: 0, h: 0, dpr: 1, pad: 18, scale: 1 };

function resizeCanvas() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  geom = { w: rect.width, h: rect.height, dpr, pad: Math.max(14, rect.width * 0.035), scale: Math.max(0.6, Math.min(rect.width, rect.height) / 620) };
  for (const c of [canvas, edgeLayer]) {
    c.width = Math.round(rect.width * dpr);
    c.height = Math.round(rect.height * dpr);
  }
  drawEdgeLayer();
  kick();
}

const px = (i) => [geom.pad + state.pos[i][0] * (geom.w - 2 * geom.pad), geom.pad + state.pos[i][1] * (geom.h - 2 * geom.pad)];

function nodeRadius(i) {
  const net = state.sim.net;
  const maxDeg = state.maxDeg || (state.maxDeg = Math.max(...net.degree));
  const r = (2.6 + 9 * (net.degree[i] / maxDeg) ** 0.8) * geom.scale;
  const t = state.sim.type[i];
  return t === T.AMP_BOT || t === T.FC_BOT ? Math.max(r, 4.8 * geom.scale) : r;
}

function drawEdgeLayer() {
  if (!state.pos || !geom.w) return;
  state.maxDeg = 0;
  const g = edgeLayer.getContext("2d");
  g.setTransform(geom.dpr, 0, 0, geom.dpr, 0, 0);
  g.clearRect(0, 0, geom.w, geom.h);
  g.strokeStyle = state.colors.edge;
  g.globalAlpha = 0.16;
  g.lineWidth = 0.7;
  g.beginPath();
  for (const [u, v] of state.sim.net.edges) {
    const [x1, y1] = px(u);
    const [x2, y2] = px(v);
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
  }
  g.stroke();
}

function nodeColor(snap, i) {
  const c = state.colors;
  const m = snap.message[i];
  if (m === Opinion.RUMOR) return snap.active[i] ? c.rumor : c["rumor-soft"];
  if (m === Opinion.CORRECTION) return snap.active[i] ? c.corr : c["corr-soft"];
  return snap.exposed[i] ? c.seen : c.unaware;
}

function drawShape(g, type, x, y, r) {
  g.beginPath();
  if (type === T.AMP_BOT) g.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
  else if (type === T.FC_BOT) {
    const d = r * 1.2;
    g.moveTo(x, y - d); g.lineTo(x + d, y); g.lineTo(x, y + d); g.lineTo(x - d, y); g.closePath();
  } else g.arc(x, y, r, 0, Math.PI * 2);
}

function drawNetwork() {
  const sim = state.sim;
  if (!sim || !state.pos || !geom.w) return;
  const { dpr, w, h } = geom;
  const c = state.colors;
  const snap = sim.snapshots[state.step];
  const prev = sim.snapshots[Math.max(0, state.step - 1)];
  const n = sim.net.n;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(edgeLayer, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Каналы, по которым прямо сейчас идут посты.
  for (const [msg, color] of [[Opinion.RUMOR, c.rumor], [Opinion.CORRECTION, c.corr]]) {
    ctx.beginPath();
    for (let v = 0; v < n; v++) {
      if (!snap.active[v] || snap.message[v] !== msg) continue;
      const [x1, y1] = px(v);
      for (const u of sim.net.adj[v]) {
        if (sim.isBot[u]) continue;
        const [x2, y2] = px(u);
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
    }
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.22;
    ctx.lineWidth = 0.9;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Сначала мелкие узлы, потом крупные — хабы остаются видны.
  const order = state.drawOrder?.length === n ? state.drawOrder
    : (state.drawOrder = [...Array(n).keys()].sort((a, b) => sim.net.degree[a] - sim.net.degree[b]));
  for (const i of order) {
    const [x, y] = px(i);
    const r = nodeRadius(i);
    const type = sim.type[i];
    drawShape(ctx, type, x, y, r);
    ctx.fillStyle = nodeColor(snap, i);
    ctx.fill();
    if (type === T.AMP_BOT || type === T.FC_BOT || type === T.INFLUENCER) {
      ctx.lineWidth = 1.4 * Math.max(0.8, geom.scale);
      ctx.strokeStyle = c.ink;
      ctx.stroke();
    }
  }

  // Вспышка у тех, кто изменил мнение на этом шаге.
  if (!reduceMotion.matches && state.step > 0) {
    const p = state.playing ? Math.min(1, state.progress * 1.4) : 1;
    if (p < 1) {
      ctx.lineWidth = 1.5;
      for (let i = 0; i < n; i++) {
        if (snap.message[i] === prev.message[i]) continue;
        const [x, y] = px(i);
        ctx.beginPath();
        ctx.arc(x, y, nodeRadius(i) + 2 + 12 * p, 0, Math.PI * 2);
        ctx.strokeStyle = snap.message[i] === Opinion.RUMOR ? c.rumor : c.corr;
        ctx.globalAlpha = 0.75 * (1 - p);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  if (state.hover >= 0) {
    const [x, y] = px(state.hover);
    ctx.beginPath();
    ctx.arc(x, y, nodeRadius(state.hover) + 4, 0, Math.PI * 2);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

let rafId = 0;
let lastTs = 0;
function kick() {
  if (!rafId) {
    lastTs = performance.now();
    rafId = requestAnimationFrame(frame);
  }
}

function frame(ts) {
  rafId = 0;
  const dt = Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;
  if (state.playing) {
    state.progress += dt * STEPS_PER_SEC * state.speed;
    if (state.progress >= 1) {
      state.progress = 0;
      if (state.step + 1 >= state.endStep) {
        setStep(state.sim.t);
        setPlaying(false);
      } else {
        setStep(state.step + 1);
      }
    }
  }
  drawNetwork();
  if (state.playing) rafId = requestAnimationFrame(frame);
}

function stateText(snap, i) {
  const type = state.sim.type[i];
  if (type === T.FC_BOT && !snap.active[i]) return "ещё не включился";
  const m = snap.message[i];
  if (m === Opinion.RUMOR) return snap.active[i] ? "репостит слух" : "верит слуху";
  if (m === Opinion.CORRECTION) return snap.active[i] ? "публикует опровержение" : "принял опровержение";
  return snap.exposed[i] ? "видел слух, не поверил" : "ничего не видел";
}

function initHover() {
  const tip = $("#tip");
  canvas.addEventListener("pointermove", (e) => {
    if (!state.sim) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < state.sim.net.n; i++) {
      const [x, y] = px(i);
      const d = (x - mx) ** 2 + (y - my) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    const hit = best >= 0 && Math.sqrt(bestD) < nodeRadius(best) + 6 ? best : -1;
    if (hit !== state.hover) {
      state.hover = hit;
      kick();
    }
    if (hit < 0) {
      tip.hidden = true;
      return;
    }
    const deg = state.sim.net.degree[hit];
    tip.innerHTML = `<b>${TYPE_LABELS[state.sim.type[hit]]}</b>${deg} ${plural(deg, ["связь", "связи", "связей"])} · ${stateText(state.sim.snapshots[state.step], hit)}`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    tip.style.left = `${Math.min(rect.width - tw - 8, Math.max(8, mx + 14))}px`;
    tip.style.top = `${my + 14 + th > rect.height ? my - th - 12 : my + 14}px`;
  });
  canvas.addEventListener("pointerleave", () => {
    state.hover = -1;
    $("#tip").hidden = true;
    kick();
  });
}

// ------------------------------------------------------------ полоса риска на регуляторе

let riskTimer = 0;
let riskToken = 0;
function scheduleRisk() {
  const key = scenarioKey(state.sc, ["pShare", "seed", "nSteps"]);
  if (key === state.riskKey) return;
  state.riskKey = key;
  clearTimeout(riskTimer);
  riskTimer = setTimeout(computeRisk, 180);
}

async function computeRisk() {
  const token = ++riskToken;
  const sc = { ...state.sc };
  const ps = [];
  for (let p = 0; p <= P_MAX + 1e-9; p += 0.05) ps.push(+p.toFixed(2));
  const probs = [];
  for (const p of ps) {
    const { summaries } = runMany(sc, 16, { pShare: p });
    probs.push(mean(summaries.map((s) => (s.cascade ? 1 : 0))));
    await nextFrame();
    if (token !== riskToken) return;
  }

  const stops = ps.map((p, i) => `color-mix(in oklab, var(--rumor) ${Math.round(probs[i] * 100)}%, var(--track)) ${((p / P_MAX) * 100).toFixed(1)}%`);
  $("#risk-track").style.background = `linear-gradient(90deg, ${stops.join(", ")})`;

  const marker = $("#risk-marker");
  const caption = $("#risk-caption");
  let crossing = null;
  for (let i = 0; i < ps.length; i++) {
    if (probs[i] >= 0.5) {
      crossing = i === 0 ? ps[0] : ps[i - 1] + ((0.5 - probs[i - 1]) / (probs[i] - probs[i - 1])) * (ps[i] - ps[i - 1]);
      break;
    }
  }
  if (crossing === null) {
    marker.hidden = true;
    caption.textContent = "При этих настройках массовый каскад маловероятен на всей шкале: даже при высокой склонности к репосту он случается реже чем в половине прогонов.";
  } else if (crossing <= 0) {
    marker.hidden = true;
    caption.textContent = "При этих настройках каскад случается больше чем в половине прогонов почти при любой склонности к репосту: слух держат боты.";
  } else {
    const f = crossing / P_MAX;
    marker.hidden = false;
    marker.style.left = `calc(12px + (100% - 24px) * ${f.toFixed(4)})`;
    marker.classList.toggle("edge-left", f < 0.08);
    marker.classList.toggle("edge-right", f > 0.92);
    $("#risk-marker-label").textContent = `порог ≈ ${crossing.toFixed(2)}`;
    caption.textContent = `Цвет шкалы — как часто слух превращается в массовый каскад при текущих настройках. Правее ${crossing.toFixed(2)} каскад случается больше чем в половине прогонов.`;
  }
}

// ------------------------------------------------------------ сравнение A/B

let compareTimer = 0;
function scheduleCompare() {
  clearTimeout(compareTimer);
  compareTimer = setTimeout(runCompare, 220);
}

function runCompare() {
  const a = state.sc;
  const bSc = { ...a, ...state.b };
  const sc = state.sc;
  $("#a-desc").textContent =
    `ботов ${pct(sc.botFraction)} ${PLACE[sc.botPlacement]}, фактчекеров ${pct(sc.factcheckFraction)} ${PLACE[sc.factcheckPlacement]}, скептиков ${pct(sc.skepticFraction)}`;

  const table = $("#ab-table");
  if (fractionsInvalid(bSc)) {
    table.innerHTML = `<tbody><tr><td>В сценарии B специальных агентов больше 100% сети. Уменьшите какую-нибудь долю.</td></tr></tbody>`;
    return;
  }
  const RUNS = 30;
  const A = runMany(a, RUNS);
  const B = runMany(bSc, RUNS);
  const ca = meanCurve(A.curves, "rumorReachFrac");
  const cb = meanCurve(B.curves, "rumorReachFrac");
  const band = (c) => ({ lo: c.mean.map((v, i) => v - c.std[i]), hi: c.mean.map((v, i) => v + c.std[i]) });

  lineChart($("#ab-chart"), {
    xs: A.curves[0].map((r) => r.step),
    series: [
      { label: "A · поверили слуху", color: "var(--muted)", values: ca.mean, band: band(ca) },
      { label: "B · поверили слуху", color: "var(--rumor)", values: cb.mean, band: band(cb) },
    ],
    yFormat: pctFmt(),
    xLabel: "шаг · среднее по 30 прогонам ± σ",
    height: 260,
    ariaLabel: "Доля поверивших слуху в сценариях A и B",
  });

  const agg = (runs) => ({
    reach: mean(runs.summaries.map((s) => s.rumorReachFrac)),
    cascade: mean(runs.summaries.map((s) => (s.cascade ? 1 : 0))),
    corr: mean(runs.summaries.map((s) => s.finalCorrectionFrac)),
    peak: mean(runs.summaries.map((s) => s.peakRumorActive)),
    peakStep: mean(runs.summaries.map((s) => s.timeToPeak)),
  });
  const sa = agg(A);
  const sb = agg(B);
  const rows = [
    ["Поверили слуху", "reach", (v) => pct(v, 1), (d) => `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)} п.п.`, true],
    ["Вероятность каскада", "cascade", (v) => pct(v), (d) => `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(0)} п.п.`, true],
    ["Приняли опровержение", "corr", (v) => pct(v, 1), (d) => `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)} п.п.`, false],
    ["Пик активных репостов", "peak", (v) => v.toFixed(1), (d) => `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}`, true],
    ["Шаг пика", "peakStep", (v) => v.toFixed(1), (d) => `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}`, null],
  ];
  table.innerHTML = `<thead><tr><th scope="col">Метрика</th><th scope="col">A</th><th scope="col">B</th><th scope="col">B − A</th></tr></thead><tbody>${rows
    .map(([label, key, fmt, dfmt, higherIsWorse]) => {
      const d = sb[key] - sa[key];
      const small = Math.abs(d) < (key === "peak" || key === "peakStep" ? 0.5 : 0.005);
      const cls = small || higherIsWorse === null ? "" : (d > 0) === higherIsWorse ? "delta-up" : "delta-down";
      return `<tr><th scope="row">${label}</th><td>${fmt(sa[key])}</td><td>${fmt(sb[key])}</td><td class="${cls}">${small ? "≈ 0" : dfmt(d)}</td></tr>`;
    })
    .join("")}</tbody>`;
}

// ------------------------------------------------------------ переломная точка

function markSweepStale() {
  if (!state.sweepKey) return;
  const stale = scenarioKey(state.sc, ["pShare", "seed", "network", "nSteps"]) !== state.sweepKey;
  $("#sweep").textContent = stale ? "Пересчитать для нового сценария" : "Построить кривые";
}

async function runSweep() {
  const btn = $("#sweep");
  const progress = $("#sweep-progress");
  if (fractionsInvalid(state.sc)) return;
  btn.disabled = true;
  const base = { ...state.sc };
  const RUNS = 20;
  const ps = [];
  for (let p = 0; p <= P_MAX + 1e-9; p += 0.05) ps.push(+p.toFixed(2));
  const nets = ["scale_free", "small_world", "random"];
  const results = {};
  let done = 0;
  const total = nets.length * ps.length;
  for (const network of nets) {
    results[network] = { reach: [], prob: [] };
    for (const p of ps) {
      const { summaries } = runMany(base, RUNS, { network, pShare: p });
      results[network].reach.push(mean(summaries.map((s) => s.rumorReachFrac)));
      results[network].prob.push(mean(summaries.map((s) => (s.cascade ? 1 : 0))));
      done++;
      progress.textContent = `считаю ${Math.round((done / total) * 100)}%`;
      await nextFrame();
    }
  }
  btn.disabled = false;
  progress.textContent = `${total * RUNS} прогонов`;
  state.sweepKey = scenarioKey(base, ["pShare", "seed", "network", "nSteps"]);
  btn.textContent = "Построить кривые";

  const colors = { scale_free: "var(--rumor)", small_world: "var(--ink)", random: "var(--muted)" };
  const marker = [{ x: base.pShare, color: "var(--muted)", label: `сейчас ${base.pShare.toFixed(2)}` }];
  $("#sweep-charts").hidden = false;
  lineChart($("#sweep-reach"), {
    xs: ps,
    series: nets.map((nk) => ({ label: NET_LABEL[nk], color: colors[nk], values: results[nk].reach, dots: true })),
    yFormat: pctFmt(),
    xFormat: (v) => v.toFixed(1),
    xTicks: [0, 0.2, 0.4, 0.6, 0.8],
    xLabel: "склонность к репосту",
    markers: marker,
    height: 250,
    ariaLabel: "Средний охват слуха в зависимости от склонности к репосту",
  });
  lineChart($("#sweep-prob"), {
    xs: ps,
    series: nets.map((nk) => ({ label: NET_LABEL[nk], color: colors[nk], values: results[nk].prob, dots: true })),
    yMax: 1,
    yFormat: pctFmt(),
    xFormat: (v) => v.toFixed(1),
    xTicks: [0, 0.2, 0.4, 0.6, 0.8],
    xLabel: "склонность к репосту",
    markers: marker,
    height: 250,
    ariaLabel: "Вероятность массового каскада в зависимости от склонности к репосту",
  });

  const parts = nets.map((nk) => {
    const i = results[nk].prob.findIndex((v) => v >= 0.5);
    if (i < 0) return `${NET_LABEL[nk].toLowerCase()} — не достигнут`;
    return `${NET_LABEL[nk].toLowerCase()} — <b>${ps[i].toFixed(2)}</b>`;
  });
  $("#sweep-summary").innerHTML = `Первая точка, где каскад случается хотя бы в половине прогонов: ${parts.join(", ")}.`;
}

// ------------------------------------------------------------ старт

function init() {
  readColors();
  initControls();
  initHover();

  new ResizeObserver(() => resizeCanvas()).observe($("#canvas-wrap"));
  let chartTimer = 0;
  const charts = $$(".chart");
  const ro = new ResizeObserver((entries) => {
    // Перерисовываем только при смене ширины, иначе новая высота снова вызовет observer.
    const changed = entries.filter((e) => Math.round(e.contentRect.width) !== e.target._w);
    changed.forEach((e) => (e.target._w = Math.round(e.contentRect.width)));
    if (!changed.length) return;
    clearTimeout(chartTimer);
    chartTimer = setTimeout(() => charts.forEach(rerender), 120);
  });
  charts.forEach((c) => ro.observe(c));

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    readColors();
    drawEdgeLayer();
    kick();
  });

  applyPreset(PRESETS[1]);
}

init();
