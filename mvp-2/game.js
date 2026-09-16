import { DEFAULT_SCENARIO, EVENT, Opinion, Simulation, T, TYPE_LABELS } from "./sim.js";
import { LEVELS } from "./levels.js";
import {
  H, PAL, STATE_COLOR, W,
  agentSprite, bubbleSprite, buildTown, envelopeSprite, hitTest, nightFactor,
} from "./town.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const STEP_MS = 900;
const START_HOUR = 20;
const METER_MAX = 0.5;
const STORE_KEY = "rumor-town-stars";

const state = {
  mode: "menu",       // menu | game | sandbox
  level: null,
  levelIndex: 0,
  sim: null,
  town: null,
  townKey: "",
  step: 0,            // показанный час
  stepStart: 0,       // когда начался показ этого часа
  playing: false,
  started: false,
  finished: false,
  speed: 1,
  charges: { factchecker: 0, ban: 0 },
  actions: [],
  landAt: new Map(),  // житель → когда долетит его письмо
  flights: [],
  pops: [],
  hover: -1,
  showEdges: false,
  sandbox: { ...DEFAULT_SCENARIO, nNodes: 140, nSteps: 40, pShare: 0.22, botFraction: 0.05, seed: 7 },
};

// ------------------------------------------------------------ утилиты

const pct = (v) => `${Math.round(v * 100)}%`;
function plural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
const hourOf = (step) => (START_HOUR + step) % 24;
const clockText = (step) => `День ${1 + Math.floor((START_HOUR + step) / 24)} · ${String(hourOf(step)).padStart(2, "0")}:00`;
const stepMs = () => STEP_MS / state.speed;

function loadStars() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function saveStars(id, stars) {
  try {
    const all = loadStars();
    all[id] = Math.max(all[id] || 0, stars);
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch { /* хранилище недоступно — просто не запоминаем */ }
}
const starText = (n) => "★".repeat(n) + `<span class="off">${"★".repeat(3 - n)}</span>`;

let toastTimer = 0;
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}

// ------------------------------------------------------------ экраны

function showOverlay(id) {
  for (const o of ["menu", "brief", "result"]) $(`#${o}`).hidden = o !== id;
}

function openMenu() {
  state.mode = "menu";
  state.playing = false;
  const stars = loadStars();
  $("#levels").innerHTML = LEVELS.map((l, i) => `
    <li><button type="button" class="level" data-index="${i}">
      <span class="level-num">${i + 1}</span>
      <span class="level-name">${l.title}</span>
      <span class="level-stars" aria-label="${stars[l.id] || 0} из 3 звёзд">${starText(stars[l.id] || 0)}</span>
      <span class="level-brief">${l.brief}</span>
    </button></li>`).join("");
  $$("#levels .level").forEach((b) => b.addEventListener("click", () => openBrief(Number(b.dataset.index))));
  showOverlay("menu");
  $("#hud").hidden = true;
  $("#controls").hidden = true;
  $("#sandbox").hidden = true;
  // Фоном — живой город из песочницы, чтобы меню не висело на пустом экране.
  loadScenario({ ...state.sandbox }, { full: true });
  state.playing = !reduceMotion.matches;
}

function openBrief(index) {
  state.levelIndex = index;
  const level = LEVELS[index];
  $("#brief-level").textContent = `Уровень ${index + 1} из ${LEVELS.length}`;
  $("#brief-title").textContent = level.title;
  $("#brief-text").textContent = level.brief;
  showOverlay("brief");
}

function startLevel(index) {
  const level = LEVELS[index];
  state.mode = "game";
  state.level = level;
  state.levelIndex = index;
  state.charges = { ...level.tools };
  state.actions = [];
  state.started = false;
  state.finished = false;
  loadScenario({ ...DEFAULT_SCENARIO, ...level.scenario }, { full: false });
  state.playing = false;

  showOverlay(null);
  $("#hud").hidden = false;
  $("#tools").hidden = false;
  $("#meter-stars").hidden = false;
  $("#hud-title").textContent = level.title;
  $("#controls").hidden = false;
  $("#sandbox").hidden = true;
  $("#scrub").hidden = true;
  $("#skip").hidden = false;
  $("#restart").textContent = "Заново";
  $("#play").textContent = "Старт";

  const ticks = level.stars.map((g, i) => `<span style="left:${(g / METER_MAX) * 100}%">${"★".repeat(i + 1)}</span>`);
  $("#meter-stars").innerHTML = ticks.join("");
  $$(".meter-tick").forEach((t) => t.remove());
  for (const g of level.stars.slice(1)) {
    const t = document.createElement("div");
    t.className = "meter-tick";
    t.style.left = `${(g / METER_MAX) * 100}%`;
    $("#meter-bar").append(t);
  }
  updateHud();
  toast("Время стоит. Осмотрись, нажимай на жителей и роботов, потом жми «Старт»");
}

function startSandbox() {
  state.mode = "sandbox";
  showOverlay(null);
  $("#hud").hidden = false;
  $("#tools").hidden = true;
  $("#meter-stars").hidden = true;
  $$(".meter-tick").forEach((t) => t.remove());
  $("#hud-title").textContent = "Песочница";
  $("#controls").hidden = false;
  $("#sandbox").hidden = false;
  $("#scrub").hidden = false;
  $("#skip").hidden = false;
  $("#restart").textContent = "С начала";
  syncSandbox();
  rebuildSandbox();
}

// ------------------------------------------------------------ сценарий

function loadScenario(sc, { full }) {
  const sim = new Simulation(sc);
  if (full) sim.run();
  const key = `${sc.network}|${sc.nNodes}|${sc.avgDegree}|${sc.seed}`;
  if (key !== state.townKey) {
    state.town = buildTown(sim);
    state.townKey = key;
  }
  state.sim = sim;
  state.step = 0;
  state.stepStart = performance.now();
  state.flights = [];
  state.pops = [];
  state.landAt.clear();
  state.hover = -1;
  $("#tip").hidden = true;
  const scrub = $("#scrub");
  scrub.max = sc.nSteps;
  scrub.value = 0;
  updateHud();
}

function lastStep() {
  return state.sim.sc.nSteps;
}

function advance(now) {
  const sim = state.sim;
  if (state.step >= lastStep()) return false;
  if (state.step === sim.t) sim.step(); // в игре считаем по ходу, в песочнице уже посчитано
  state.step += 1;
  state.stepStart = now;
  launchFlights(now);
  $("#scrub").value = state.step;
  updateHud();
  return true;
}

function launchFlights(now) {
  if (reduceMotion.matches) return;
  const events = state.sim.events[state.step] || [];
  const dur = stepMs();
  for (const [from, to, kind] of events) {
    const delay = Math.random() * dur * 0.25;
    const fly = dur * (kind === EVENT.SEEN ? 0.45 : 0.6);
    state.flights.push({ from, to, kind, t0: now + delay, t1: now + delay + fly });
    state.landAt.set(to, now + delay + fly);
  }
}

function jumpTo(step) {
  state.step = Math.max(0, Math.min(step, state.sim.t));
  state.flights = [];
  state.landAt.clear();
  state.stepStart = performance.now();
  $("#scrub").value = state.step;
  updateHud();
}

// ------------------------------------------------------------ HUD

function reachAt(step) {
  return state.sim.history[step].rumorReachFrac;
}

function updateHud() {
  if (!state.sim) return;
  const reach = reachAt(state.step);
  $("#hud-clock").textContent = `${clockText(state.step)} · час ${state.step} из ${lastStep()}`;
  const val = $("#meter-value");
  val.textContent = pct(reach);
  val.classList.toggle("is-bad", reach >= 0.2);
  $("#meter-fill").style.width = `${Math.min(1, reach / METER_MAX) * 100}%`;
  if (state.mode === "game") {
    for (const [k, v] of Object.entries(state.charges)) {
      $(`[data-count="${k}"]`).textContent = `× ${v}`;
      $(`.tool[data-tool="${k}"]`).classList.toggle("is-empty", v === 0);
    }
  }
}

function setPlaying(on) {
  if (state.mode === "game" && state.finished) return;
  state.playing = on;
  if (on) {
    state.started = true;
    if (state.mode === "sandbox" && state.step >= lastStep()) jumpTo(0);
    state.stepStart = performance.now();
  }
  $("#play").textContent = on ? "Пауза" : state.started ? "Дальше" : "Старт";
}

// ------------------------------------------------------------ действия игрока

function act(v) {
  if (state.mode !== "game" || state.finished) return;
  const sim = state.sim;
  const a = state.town.agents[v];
  if (sim.type[v] === T.AMP_BOT) {
    if (sim.banned.has(v)) return toast("Этот бот уже молчит");
    if (state.charges.ban <= 0) return toast("Глушилки закончились");
    sim.banBot(v);
    state.charges.ban--;
    burst(a, PAL.yellow);
    toast(`Бот заглушён. Осталось глушилок: ${state.charges.ban}`);
  } else if (sim.type[v] === T.FC_BOT) {
    return toast(`${a.name} уже фактчекер`);
  } else {
    if (state.charges.factchecker <= 0) return toast("Фактчекеры закончились");
    sim.hireFactchecker(v);
    state.charges.factchecker--;
    burst(a, PAL.lime);
    toast(`${a.name} теперь фактчекер. Осталось: ${state.charges.factchecker}`);
  }
  state.actions.push({ v, step: state.step });
  state.landAt.delete(v);
  updateHud();
}

function burst(a, color) {
  if (reduceMotion.matches) return;
  const now = performance.now();
  for (let i = 0; i < 10; i++) {
    const ang = (i / 10) * Math.PI * 2;
    state.pops.push({ x: a.x + 3, y: a.y + 4, vx: Math.cos(ang) * 22, vy: Math.sin(ang) * 22 - 10, color, t0: now, life: 520 });
  }
}

// ------------------------------------------------------------ итог

// Совет по тому, что игрок сделал не так. Порядок — по силе эффекта в модели.
function advice(sim, top, bots) {
  const level = state.level;
  const hubBotsLeft = bots.filter((v) => top.has(v) && !sim.banned.has(v));
  if (hubBotsLeft.length && sim.banned.size < level.tools.ban) return "на площадях остались боты — глушилки лучше тратить на них.";
  const hired = [...sim.hired];
  if (hired.length < level.tools.factchecker) return "ты использовал не всех фактчекеров, а неиспользованные в конце не помогают.";
  if (hired.filter((v) => top.has(v)).length < hired.length / 2) return "фактчекер у площади слышен куда дальше, чем в переулке. Наведи на жителя — видно, сколько у него знакомых.";
  const first = Math.min(...state.actions.map((a) => a.step));
  if (first > 1) return "действуй в первые часы: к третьему слух уже расходится сам.";
  if (hubBotsLeft.length) return "фактчекеры рядом с оставшимися ботами перехватывают их слушателей — нажми «Показать знакомства» и найди соседей бота.";
  return level.tip;
}

function finish() {
  state.finished = true;
  state.playing = false;
  state.hover = -1;
  $("#tip").hidden = true;
  const level = state.level;
  const sim = state.sim;
  const you = sim.summary().rumorReachFrac;
  const base = new Simulation({ ...DEFAULT_SCENARIO, ...level.scenario }, { record: false }).run().summary().rumorReachFrac;
  const stars = level.stars.filter((g) => you < g).length;
  saveStars(level.id, stars);

  $("#result-stars").innerHTML = starText(stars);
  $("#result-stars").setAttribute("aria-label", `${stars} из 3 звёзд`);
  $("#result-title").textContent = stars ? "Город устоял" : "Слух захватил город";
  $("#cmp-you-val").textContent = pct(you);
  $("#cmp-base-val").textContent = pct(base);
  $("#cmp-you").style.width = "0";
  $("#cmp-base").style.width = "0";
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $("#cmp-you").style.width = `${Math.min(1, you / METER_MAX) * 100}%`;
    $("#cmp-base").style.width = `${Math.min(1, base / METER_MAX) * 100}%`;
  }));

  const humans = sim.humans.length;
  const saved = Math.round((base - you) * humans);
  $("#result-saved").textContent = saved > 0
    ? `Ты уберёг от слуха ${saved} ${plural(saved, ["жителя", "жителей", "жителей"])} из ${humans}.`
    : saved < 0
      ? `Без тебя вышло бы даже лучше — на ${-saved} ${plural(-saved, ["жителя", "жителей", "жителей"])}. Случайность бывает жестокой, попробуй ещё раз.`
      : "Твои действия почти не изменили итог.";

  const notes = [];
  const byDeg = [...Array(sim.net.n).keys()].sort((a, b) => sim.net.degree[b] - sim.net.degree[a]);
  const top = new Set(byDeg.slice(0, Math.ceil(sim.net.n * 0.1)));
  const hired = [...sim.hired];
  const bots = [...Array(sim.net.n).keys()].filter((v) => sim.type[v] === T.AMP_BOT);
  if (hired.length) notes.push(`Фактчекеров среди самых общительных жителей: ${hired.filter((v) => top.has(v)).length} из ${hired.length}.`);
  if (bots.length) {
    const hubBots = bots.filter((v) => top.has(v));
    notes.push(`Заглушено ботов: ${sim.banned.size} из ${bots.length}` + (hubBots.length ? `, из них на площадях: ${hubBots.filter((v) => sim.banned.has(v)).length} из ${hubBots.length}.` : "."));
  }
  if (state.actions.length) {
    const first = Math.min(...state.actions.map((a) => a.step));
    notes.push(first === 0 ? "Ты начал действовать до первого часа — это лучший момент." : `Первое действие — на ${first}-м часу. К этому времени слух уже поверили ${pct(reachAt(first))} жителей.`);
  } else {
    notes.push("Ты ни во что не вмешался — это и есть сценарий «без тебя».");
  }
  if (stars < 3) notes.push(`Подсказка: ${advice(sim, top, bots)}`);
  $("#result-notes").innerHTML = notes.map((n) => `<li>${n}</li>`).join("");

  const hasNext = state.levelIndex < LEVELS.length - 1;
  $("#res-next").hidden = !hasNext;
  showOverlay("result");
  $("#play").textContent = "Готово";
  (hasNext ? $("#res-next") : $("#res-retry")).focus();
}

// ------------------------------------------------------------ песочница

function syncSandbox() {
  const sc = state.sandbox;
  $$("#sandbox input[data-param]").forEach((i) => {
    i.value = sc[i.dataset.param];
    showField(i);
  });
  $$("#sandbox .seg").forEach((seg) => $$("button", seg).forEach((b) => b.setAttribute("aria-checked", String(b.dataset.value === sc[seg.dataset.param]))));
}

function showField(input) {
  const v = Number(input.value);
  input.closest("label").querySelector("output").textContent =
    input.hasAttribute("data-pct") ? pct(v) : input.dataset.fixed ? v.toFixed(Number(input.dataset.fixed)) : String(v);
}

let sandboxTimer = 0;
function rebuildSandbox() {
  clearTimeout(sandboxTimer);
  sandboxTimer = setTimeout(() => {
    const sc = state.sandbox;
    const err = $("#sb-error");
    if (sc.skepticFraction + sc.influencerFraction + sc.botFraction + sc.factcheckFraction > 1) {
      err.hidden = false;
      err.textContent = "Скептиков, ботов и фактчекеров вместе больше, чем жителей. Уменьши какую-нибудь долю.";
      return;
    }
    err.hidden = true;
    loadScenario({ ...sc }, { full: true });
    state.started = false;
    setPlaying(!reduceMotion.matches);
    if (reduceMotion.matches) jumpTo(lastStep());
  }, 120);
}

// ------------------------------------------------------------ отрисовка

const view = $("#view");
const vctx = view.getContext("2d");
const frame = document.createElement("canvas");
frame.width = W;
frame.height = H;
const g = frame.getContext("2d");

function resize() {
  const rect = view.getBoundingClientRect();
  const k = Math.max(1, Math.ceil((rect.width * (window.devicePixelRatio || 1)) / W));
  view.width = W * k;
  view.height = H * k;
}

function colorOf(snap, v) {
  if (state.sim.banned.has(v) && snap === state.sim.snapshots[state.step]) return STATE_COLOR.banned;
  const m = snap.message[v];
  if (m === Opinion.RUMOR) return snap.active[v] ? STATE_COLOR.rumor : STATE_COLOR.rumorSoft;
  if (m === Opinion.CORRECTION) return snap.active[v] ? STATE_COLOR.corr : STATE_COLOR.corrSoft;
  return snap.exposed[v] ? STATE_COLOR.seen : STATE_COLOR.unaware;
}

function draw(now) {
  const { sim, town } = state;
  if (!sim || !town) return;
  const snap = sim.snapshots[state.step];
  const prev = sim.snapshots[Math.max(0, state.step - 1)];
  const progress = Math.min(1, (now - state.stepStart) / stepMs());
  const hourNow = hourOf(state.step) + (state.playing ? progress : 0);
  const night = nightFactor(Math.floor(hourNow) % 24) * (1 - progress) + nightFactor(Math.ceil(hourNow) % 24) * progress;

  g.drawImage(town.terrain, 0, 0);
  if (night > 0) {
    g.fillStyle = `rgba(10, 11, 24, ${0.42 * night})`;
    g.fillRect(0, 0, W, H);
    // Горящие окна: весь город сидит в телефонах.
    for (let i = 0; i < town.windows.length; i++) {
      const [x, y] = town.windows[i];
      const flick = Math.sin(now / 900 + i * 1.7) > -0.6;
      if (!flick) continue;
      g.fillStyle = `rgba(115, 239, 247, ${0.75 * night})`;
      g.fillRect(x, y, 2, 2);
    }
    for (const [x, y] of town.lamps) {
      g.fillStyle = `rgba(255, 205, 117, ${0.13 * night})`;
      g.fillRect(x - 3, y - 3, 7, 5);
      g.fillRect(x - 2, y - 4, 5, 7);
      g.fillRect(x - 4, y + 8, 9, 2);
      g.fillStyle = `rgba(255, 240, 200, ${0.9 * night})`;
      g.fillRect(x - 1, y - 1, 3, 1);
    }
  }

  // Знакомства.
  const center = (v) => [town.agents[v].x + 3.5, town.agents[v].y + 6];
  if (state.showEdges) {
    g.strokeStyle = "rgba(115, 239, 247, 0.13)";
    g.lineWidth = 1;
    g.beginPath();
    for (const [u, v] of sim.net.edges) {
      const [x1, y1] = center(u);
      const [x2, y2] = center(v);
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
    }
    g.stroke();
  }
  if (state.hover >= 0) {
    g.strokeStyle = "rgba(115, 239, 247, 0.6)";
    g.lineWidth = 1;
    g.beginPath();
    const [x1, y1] = center(state.hover);
    for (const u of sim.net.adj[state.hover]) {
      const [x2, y2] = center(u);
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
    }
    g.stroke();
  }

  // Жители — сверху вниз, чтобы ближние перекрывали дальних.
  const order = state.drawOrder?.length === town.agents.length && state.drawOrderTown === town
    ? state.drawOrder
    : (state.drawOrderTown = town, state.drawOrder = town.agents.map((a) => a.id).sort((p, q) => town.agents[p].y - town.agents[q].y));
  const bubbles = [];
  for (const v of order) {
    const a = town.agents[v];
    const landed = !(state.landAt.get(v) > now);
    const s = landed ? snap : prev;
    const color = colorOf(s, v);
    const banned = sim.banned.has(v);
    const talking = s.active[v] && !banned && Math.sin(now / 160 + a.phase) > 0;
    const bob = reduceMotion.matches || banned ? 0 : Math.round((Math.sin(now / 420 + a.phase) + 1) * 0.5);
    g.drawImage(agentSprite(town, sim, v, color, talking, banned), a.x, a.y - bob);
    if (s.active[v] && !banned && !sim.isBot[v] || sim.hired.has(v)) {
      if (Math.sin(now / 500 + a.phase * 3) > 0.1) bubbles.push([a, s.message[v] === Opinion.RUMOR ? "rumor" : "ok"]);
    }
    if (banned) {
      const z = Math.floor(now / 600 + a.phase) % 3;
      g.fillStyle = PAL.mist;
      g.fillRect(a.x + 7 + z, a.y - 2 - z * 2, 2, 1);
      g.fillRect(a.x + 8 + z, a.y - 1 - z * 2, 1, 1);
      g.fillRect(a.x + 7 + z, a.y - z * 2, 2, 1);
    }
  }
  for (const [a, kind] of bubbles) g.drawImage(bubbleSprite(kind), a.x + 1, a.y - 8);

  // Письма.
  state.flights = state.flights.filter((f) => now < f.t1 + 30);
  for (const f of state.flights) {
    if (now < f.t0) continue;
    const t = Math.min(1, (now - f.t0) / (f.t1 - f.t0));
    const [x1, y1] = center(f.from);
    const [x2, y2] = center(f.to);
    const dist = Math.hypot(x2 - x1, y2 - y1);
    const x = x1 + (x2 - x1) * t;
    const y = y1 + (y2 - y1) * t - Math.sin(t * Math.PI) * Math.min(22, 4 + dist * 0.35);
    if (f.kind === EVENT.SEEN) {
      g.fillStyle = PAL.yellow;
      g.fillRect(Math.round(x) - 1, Math.round(y) - 1, 2, 2);
    } else {
      g.drawImage(envelopeSprite(f.kind === EVENT.RUMOR ? PAL.redHot : PAL.green), Math.round(x) - 2, Math.round(y) - 2);
    }
    if (t >= 1 && !f.popped) {
      f.popped = true;
      if (f.kind !== EVENT.SEEN) {
        const color = f.kind === EVENT.RUMOR ? PAL.redHot : PAL.lime;
        for (let i = 0; i < 5; i++) {
          state.pops.push({ x: x2, y: y2 - 4, vx: (Math.random() - 0.5) * 40, vy: -20 - Math.random() * 20, color, t0: now, life: 360 });
        }
      }
    }
  }

  state.pops = state.pops.filter((p) => now - p.t0 < p.life);
  for (const p of state.pops) {
    const dt = (now - p.t0) / 1000;
    g.fillStyle = p.color;
    g.fillRect(Math.round(p.x + p.vx * dt), Math.round(p.y + p.vy * dt + 60 * dt * dt), 1, 1);
  }

  // Курсор-рамка над жителем.
  if (state.hover >= 0) {
    const a = town.agents[state.hover];
    const blink = Math.floor(now / 250) % 2;
    g.fillStyle = state.mode === "game" && !state.finished ? PAL.yellow : PAL.cyan;
    const x0 = a.x - 2 - blink, y0 = a.y - 2 - blink, x1 = a.x + 8 + blink, y1 = a.y + 11 + blink;
    for (const [x, y, w, h] of [[x0, y0, 3, 1], [x0, y0, 1, 3], [x1 - 2, y0, 3, 1], [x1, y0, 1, 3], [x0, y1, 3, 1], [x0, y1 - 2, 1, 3], [x1 - 2, y1, 3, 1], [x1, y1 - 2, 1, 3]]) {
      g.fillRect(x, y, w, h);
    }
  }

  vctx.imageSmoothingEnabled = false;
  vctx.drawImage(frame, 0, 0, view.width, view.height);
}

function loop(now) {
  if (state.playing && now - state.stepStart >= stepMs()) {
    const moved = advance(now);
    if (!moved) {
      if (state.mode === "game") {
        // Даём последним письмам долететь.
        state.playing = false;
        setTimeout(finish, reduceMotion.matches ? 0 : 700);
      } else if (state.mode === "menu") {
        loadScenario({ ...state.sandbox, seed: 1 + Math.floor(Math.random() * 999) }, { full: true });
      } else {
        setPlaying(false);
      }
    }
  }
  draw(now);
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------ указатель

function stateText(v) {
  const sim = state.sim;
  if (sim.banned.has(v)) return "заглушён";
  const s = sim.snapshots[state.step];
  const m = s.message[v];
  if (m === Opinion.RUMOR) return s.active[v] ? "пересылает слух" : "верит слуху";
  if (m === Opinion.CORRECTION) return s.active[v] ? "рассылает опровержение" : "знает правду";
  return s.exposed[v] ? "слышал слух, не поверил" : "ничего не слышал";
}

function hint(v) {
  if (state.mode !== "game" || state.finished) return "";
  const sim = state.sim;
  if (sim.type[v] === T.AMP_BOT) {
    if (sim.banned.has(v)) return "";
    return state.charges.ban ? "<em>Нажми, чтобы заглушить</em>" : "<em>Глушилки закончились</em>";
  }
  if (sim.type[v] === T.FC_BOT) return "";
  return state.charges.factchecker ? "<em>Нажми, чтобы нанять фактчекером</em>" : "<em>Фактчекеры закончились</em>";
}

function logical(e) {
  const r = view.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H, r];
}

function onMove(e) {
  if (state.mode === "menu" || !state.town) return;
  const [lx, ly, r] = logical(e);
  const v = hitTest(state.town, lx, ly, e.pointerType === "touch" ? 14 : 9);
  state.hover = v;
  const tip = $("#tip");
  if (v < 0) {
    tip.hidden = true;
    return;
  }
  const sim = state.sim;
  const a = state.town.agents[v];
  const who = sim.type[v] === T.AMP_BOT ? "Бот" : sim.hired.has(v) ? `${a.name}, фактчекер` : `${a.name}, ${TYPE_LABELS[sim.type[v]].toLowerCase()}`;
  const deg = sim.net.degree[v];
  tip.innerHTML = `<b>${who}</b><br>${deg} ${plural(deg, ["знакомый", "знакомых", "знакомых"])} · ${stateText(v)}${hint(v) ? "<br>" + hint(v) : ""}`;
  tip.hidden = false;
  const px = ((a.x + 3.5) / W) * r.width;
  const py = (a.y / H) * r.height;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = `${Math.max(4, Math.min(r.width - tw - 4, px - tw / 2))}px`;
  tip.style.top = `${py - th - 10 < 4 ? py + (14 / H) * r.height + 8 : py - th - 10}px`;
}

// ------------------------------------------------------------ старт

function init() {
  $("#brief-go").addEventListener("click", () => startLevel(state.levelIndex));
  $("#brief-back").addEventListener("click", openMenu);
  $("#to-sandbox").addEventListener("click", startSandbox);
  $("#res-retry").addEventListener("click", () => startLevel(state.levelIndex));
  $("#res-next").addEventListener("click", () => openBrief(state.levelIndex + 1));
  $("#res-menu").addEventListener("click", openMenu);
  $("#back").addEventListener("click", openMenu);

  $("#play").addEventListener("click", () => {
    if (state.mode === "game" && state.finished) return showOverlay("result");
    setPlaying(!state.playing);
  });
  $("#restart").addEventListener("click", () => {
    if (state.mode === "game") startLevel(state.levelIndex);
    else { jumpTo(0); setPlaying(true); }
  });
  $("#skip").addEventListener("click", () => {
    if (state.mode === "game") {
      if (state.finished) return;
      state.playing = false;
      while (state.step < lastStep()) advance(performance.now());
      state.flights = [];
      state.landAt.clear();
      finish();
    } else {
      setPlaying(false);
      jumpTo(lastStep());
    }
  });
  $("#scrub").addEventListener("input", (e) => {
    setPlaying(false);
    jumpTo(Number(e.target.value));
  });
  $$(".speed button").forEach((b) => b.addEventListener("click", () => {
    state.speed = Number(b.dataset.speed);
    $$(".speed button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }));
  $("#edges").addEventListener("change", (e) => (state.showEdges = e.target.checked));

  $$("#sandbox input[data-param]").forEach((i) => i.addEventListener("input", () => {
    state.sandbox[i.dataset.param] = Number(i.value);
    showField(i);
    rebuildSandbox();
  }));
  $$("#sandbox .seg").forEach((seg) => $$("button", seg).forEach((b) => b.addEventListener("click", () => {
    state.sandbox[seg.dataset.param] = b.dataset.value;
    syncSandbox();
    rebuildSandbox();
  })));
  $("#new-town").addEventListener("click", () => {
    state.sandbox.seed = 1 + Math.floor(Math.random() * 9999);
    rebuildSandbox();
  });

  view.addEventListener("pointermove", onMove);
  view.addEventListener("pointerleave", () => {
    state.hover = -1;
    $("#tip").hidden = true;
  });
  view.addEventListener("pointerdown", (e) => {
    if (state.mode !== "game") return;
    onMove(e);
    if (state.hover >= 0) act(state.hover);
    onMove(e);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== " " || state.mode === "menu" || e.target.closest("input, button, select")) return;
    e.preventDefault();
    $("#play").click();
  });

  new ResizeObserver(resize).observe(view);
  resize();
  openMenu();
  requestAnimationFrame(loop);
}

init();
if (new URLSearchParams(location.search).has("debug")) window.__game = { state, act, advance, finish };
