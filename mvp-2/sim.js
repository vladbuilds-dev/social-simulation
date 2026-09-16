// Агентная модель распространения слуха и опровержения.
// Та же модель, что в mvp-1 (порт model.py), плюс две вещи для игры:
//   * events — кто кому передал сообщение на каждом шаге (чтобы летали письма);
//   * вмешательства игрока: нанять фактчекера, заблокировать бота.
// Модуль без DOM — работает и в браузере, и в Node (для проверки паритета).

export const Opinion = { NONE: 0, RUMOR: 1, CORRECTION: 2 };

export const EVENT = { SEEN: 0, RUMOR: 1, CORRECTION: 2 };

export const T = { HUMAN: 0, SKEPTIC: 1, INFLUENCER: 2, AMP_BOT: 3, FC_BOT: 4 };

export const TYPE_LABELS = [
  "Обычный пользователь",
  "Скептик",
  "Инфлюенсер",
  "Бот-усилитель",
  "Бот-фактчекер",
];

const BASE_PROFILE = [
  { pExposure: 0.35, pShare: 0.18, pVerify: 0.04, lifetime: 3 },
  { pExposure: 0.3, pShare: 0.03, pVerify: 0.45, lifetime: 2 },
  { pExposure: 0.45, pShare: 0.25, pVerify: 0.05, lifetime: 4 },
  { pExposure: 0, pShare: 1, pVerify: 0, lifetime: Infinity },
  { pExposure: 0, pShare: 1, pVerify: 1, lifetime: Infinity },
];

// Опровержения репостят реже, чем сенсационный слух.
export const CORRECTION_SHARE_FACTOR = 0.5;
// «Массовый каскад» — слуху поверили больше 20% людей.
export const CASCADE_THRESHOLD = 0.2;

export const DEFAULT_SCENARIO = Object.freeze({
  nNodes: 300,
  network: "scale_free", // scale_free | small_world | random
  avgDegree: 6,
  pShare: 0.18,
  skepticFraction: 0.15,
  influencerFraction: 0.03,
  botFraction: 0,
  botPlacement: "random", // random | hubs | periphery
  factcheckFraction: 0,
  factcheckPlacement: "random",
  factcheckDelay: 3,
  initialSpreaders: 1,
  seedPlacement: "random", // random | hubs
  nSteps: 50,
  seed: 42,
});

// ------------------------------------------------------------ случайность

export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function mulberry32() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng, n) => Math.floor(rng() * n);

function sample(rng, arr, count) {
  const a = arr.slice();
  const k = Math.min(count, a.length);
  for (let i = 0; i < k; i++) {
    const j = i + randInt(rng, a.length - i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, k);
}

// ------------------------------------------------------------ графы

function emptyGraph(n) {
  return { n, adj: Array.from({ length: n }, () => new Set()) };
}

function addEdge(g, u, v) {
  if (u === v) return false;
  if (g.adj[u].has(v)) return false;
  g.adj[u].add(v);
  g.adj[v].add(u);
  return true;
}

// Barabási–Albert: новые узлы чаще цепляются к популярным — появляются хабы.
function barabasiAlbert(n, m, rng) {
  const g = emptyGraph(n);
  for (let i = 1; i <= m; i++) addEdge(g, 0, i);
  const repeated = [];
  for (let i = 1; i <= m; i++) repeated.push(0, i);
  for (let src = m + 1; src < n; src++) {
    const targets = new Set();
    while (targets.size < m) targets.add(repeated[randInt(rng, repeated.length)]);
    for (const t of targets) {
      addEdge(g, src, t);
      repeated.push(t, src);
    }
  }
  return g;
}

function isConnected(g) {
  const seen = new Uint8Array(g.n);
  const stack = [0];
  seen[0] = 1;
  let count = 1;
  while (stack.length) {
    const v = stack.pop();
    for (const u of g.adj[v]) {
      if (!seen[u]) {
        seen[u] = 1;
        count++;
        stack.push(u);
      }
    }
  }
  return count === g.n;
}

// Watts–Strogatz: кольцо с ближайшими соседями + немного случайных «дальних» связей.
function wattsStrogatz(n, k, p, rng) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const g = emptyGraph(n);
    const half = Math.floor(k / 2);
    for (let v = 0; v < n; v++) for (let j = 1; j <= half; j++) addEdge(g, v, (v + j) % n);
    for (let j = 1; j <= half; j++) {
      for (let u = 0; u < n; u++) {
        const v = (u + j) % n;
        if (rng() < p && g.adj[u].has(v)) {
          let w = randInt(rng, n);
          let guard = 0;
          while ((w === u || g.adj[u].has(w)) && guard++ < n) w = randInt(rng, n);
          if (g.adj[u].size >= n - 1 || w === u || g.adj[u].has(w)) continue;
          g.adj[u].delete(v);
          g.adj[v].delete(u);
          addEdge(g, u, w);
        }
      }
    }
    if (isConnected(g)) return g;
  }
  throw new Error("Не удалось построить связную small-world сеть");
}

// Erdős–Rényi G(n, m): связи совсем случайные.
function gnm(n, m, rng) {
  const g = emptyGraph(n);
  const maxEdges = (n * (n - 1)) / 2;
  let edges = 0;
  m = Math.min(m, maxEdges);
  while (edges < m) if (addEdge(g, randInt(rng, n), randInt(rng, n))) edges++;
  return g;
}

export function buildNetwork(sc, rng) {
  const n = sc.nNodes;
  const k = Math.max(2, sc.avgDegree);
  let g;
  if (sc.network === "scale_free") g = barabasiAlbert(n, Math.max(1, Math.floor(k / 2)), rng);
  else if (sc.network === "small_world") g = wattsStrogatz(n, k % 2 === 0 ? k : k + 1, 0.12, rng);
  else if (sc.network === "random") g = gnm(n, Math.floor((n * k) / 2), rng);
  else throw new Error(`Неизвестный тип сети: ${sc.network}`);
  const adj = g.adj.map((s) => Uint32Array.from([...s].sort((a, b) => a - b)));
  const edges = [];
  adj.forEach((nb, v) => nb.forEach((u) => v < u && edges.push([v, u])));
  return { n, adj, edges, degree: adj.map((a) => a.length) };
}

// ------------------------------------------------------------ агенты

function pick(byDegree, pool, count, placement, rng) {
  count = Math.min(count, pool.size);
  if (count <= 0) return [];
  if (placement === "random") return sample(rng, [...pool].sort((a, b) => a - b), count);
  const ordered = placement === "hubs" ? byDegree : byDegree.slice().reverse();
  const out = [];
  for (const v of ordered) {
    if (pool.has(v)) out.push(v);
    if (out.length === count) break;
  }
  return out;
}

function nodesByDegree(net) {
  return [...Array(net.n).keys()].sort((a, b) => net.degree[b] - net.degree[a] || a - b);
}

export function assignAgentTypes(net, sc, rng) {
  const total = sc.skepticFraction + sc.influencerFraction + sc.botFraction + sc.factcheckFraction;
  if (total > 1 + 1e-9) throw new Error("Сумма долей специальных агентов больше 100%");
  const n = net.n;
  const byDegree = nodesByDegree(net);
  const type = new Uint8Array(n); // всё HUMAN
  const free = new Set(byDegree);

  const take = (kind, fraction, placement, atLeastOne = false) => {
    let count = Math.round(n * fraction);
    if (atLeastOne && fraction > 0) count = Math.max(1, count);
    for (const v of pick(byDegree, free, count, placement, rng)) {
      type[v] = kind;
      free.delete(v);
    }
  };

  // Если боты занимают хабы — они забирают их раньше инфлюенсеров.
  if (sc.botPlacement === "hubs") {
    take(T.AMP_BOT, sc.botFraction, "hubs", true);
    take(T.INFLUENCER, sc.influencerFraction, "hubs");
  } else {
    take(T.INFLUENCER, sc.influencerFraction, "hubs");
    take(T.AMP_BOT, sc.botFraction, sc.botPlacement, true);
  }
  take(T.FC_BOT, sc.factcheckFraction, sc.factcheckPlacement, true);
  take(T.SKEPTIC, sc.skepticFraction, "random");
  return { type, byDegree };
}

export function buildProfiles(sc) {
  const prof = BASE_PROFILE.map((p) => ({ ...p }));
  const p = Math.min(Math.max(sc.pShare, 0), 1);
  prof[T.HUMAN].pShare = p;
  prof[T.INFLUENCER].pShare = Math.min(1, p * 1.4);
  prof[T.SKEPTIC].pShare = p * 0.15;
  return prof;
}

// ------------------------------------------------------------ симуляция

export class Simulation {
  constructor(scenario, { record = true, network = null } = {}) {
    const sc = { ...DEFAULT_SCENARIO, ...scenario };
    this.sc = sc;
    this.record = record;
    this.rng = makeRng(sc.seed);
    this.net = network ?? buildNetwork(sc, this.rng);
    const { type, byDegree } = assignAgentTypes(this.net, sc, this.rng);
    this.type = type;

    const n = this.net.n;
    const prof = buildProfiles(sc);
    this.pExposure = new Float64Array(n);
    this.pShare = new Float64Array(n);
    this.pVerify = new Float64Array(n);
    this.lifetime = new Float64Array(n);
    this.isBot = new Uint8Array(n);
    for (let v = 0; v < n; v++) {
      const p = prof[type[v]];
      this.pExposure[v] = p.pExposure;
      this.pShare[v] = p.pShare;
      this.pVerify[v] = p.pVerify;
      this.lifetime[v] = p.lifetime;
      this.isBot[v] = type[v] === T.AMP_BOT || type[v] === T.FC_BOT ? 1 : 0;
    }
    this.humans = [];
    for (let v = 0; v < n; v++) if (!this.isBot[v]) this.humans.push(v);

    this.message = new Uint8Array(n);
    this.active = new Uint8Array(n);
    this.age = new Float64Array(n);
    this.everRumor = new Uint8Array(n);
    this.exposed = new Uint8Array(n);
    this.t = 0;

    for (let v = 0; v < n; v++) {
      if (type[v] === T.AMP_BOT) {
        this.message[v] = Opinion.RUMOR;
        this.active[v] = 1;
      } else if (type[v] === T.FC_BOT) {
        this.message[v] = Opinion.CORRECTION;
        this.active[v] = sc.factcheckDelay <= 0 ? 1 : 0;
      }
    }

    // Нулевые пациенты — люди (не скептики), которые запускают слух.
    const candidates = new Set(this.humans.filter((v) => type[v] !== T.SKEPTIC));
    for (const v of pick(byDegree, candidates, sc.initialSpreaders, sc.seedPlacement, this.rng)) {
      this.adoptRumor(v);
    }

    this.history = [this.metrics()];
    this.events = [[]];
    this.snapshots = record ? [this.snapshot()] : null;
  }

  // ---- вмешательства игрока (действуют с текущего шага)

  // Нанять жителя фактчекером: он сразу и навсегда публикует опровержение.
  hireFactchecker(v) {
    if (this.isBot[v]) return false;
    this.type[v] = T.FC_BOT;
    this.isBot[v] = 1;
    this.message[v] = Opinion.CORRECTION;
    this.active[v] = 1;
    this.lifetime[v] = Infinity;
    this.refreshLast();
    return true;
  }

  // Заблокировать бота-усилителя: он замолкает.
  banBot(v) {
    if (this.type[v] !== T.AMP_BOT || !this.active[v]) return false;
    this.active[v] = 0;
    this.refreshLast();
    return true;
  }

  refreshLast() {
    this.history[this.history.length - 1] = this.metrics();
    if (this.record) this.snapshots[this.snapshots.length - 1] = this.snapshot();
  }

  adoptRumor(v) {
    this.message[v] = Opinion.RUMOR;
    this.active[v] = 1;
    this.age[v] = 0;
    this.everRumor[v] = 1;
    this.exposed[v] = 1;
  }

  adoptCorrection(v, spreads) {
    this.message[v] = Opinion.CORRECTION;
    this.active[v] = spreads ? 1 : 0;
    this.age[v] = 0;
  }

  snapshot() {
    return { message: this.message.slice(), active: this.active.slice(), exposed: this.exposed.slice() };
  }

  step() {
    const { rng, net, sc } = this;
    const n = net.n;
    // Храним sender + 1, чтобы 0 значил «ничего не пришло».
    const newRumor = new Int32Array(n);
    const newCorr = new Int32Array(n);
    const corrSpread = new Uint8Array(n);
    const seenFrom = new Int32Array(n);

    if (this.t + 1 === sc.factcheckDelay) {
      for (let v = 0; v < n; v++) if (this.type[v] === T.FC_BOT) this.active[v] = 1;
    }

    const senders = [];
    for (let v = 0; v < n; v++) if (this.active[v]) senders.push(v);

    for (const s of senders) {
      const msg = this.message[s];
      for (const r of net.adj[s]) {
        if (this.isBot[r] || this.message[r] === Opinion.CORRECTION) continue;
        if (rng() >= this.pExposure[r]) continue;
        if (msg === Opinion.CORRECTION) {
          // Опровержение интересно только тем, кто уже видел слух.
          if (!this.exposed[r]) continue;
          if (!newCorr[r]) newCorr[r] = s + 1;
          if (rng() < this.pShare[r] * CORRECTION_SHARE_FACTOR) corrSpread[r] = 1;
        } else if (this.message[r] === Opinion.NONE) {
          if (!this.exposed[r] && !seenFrom[r]) seenFrom[r] = s + 1;
          this.exposed[r] = 1;
          if (rng() < this.pVerify[r]) {
            if (!newCorr[r]) newCorr[r] = s + 1;
            corrSpread[r] = 1; // проверил и сам публикует опровержение
          } else if (rng() < this.pShare[r]) {
            if (!newRumor[r]) newRumor[r] = s + 1;
          }
        }
      }
    }

    // Выгорание тех, кто был активен в начале шага.
    for (const s of senders) {
      if (this.isBot[s]) continue;
      this.age[s] += 1;
      if (this.age[s] >= this.lifetime[s]) this.active[s] = 0;
    }

    // Одновременное применение: опровержение приоритетнее слуха.
    // events: [отправитель, получатель, что произошло]
    const events = [];
    for (let v = 0; v < n; v++) {
      if (newCorr[v]) {
        this.adoptCorrection(v, corrSpread[v]);
        events.push([newCorr[v] - 1, v, EVENT.CORRECTION]);
      } else if (newRumor[v] && this.message[v] === Opinion.NONE) {
        this.adoptRumor(v);
        events.push([newRumor[v] - 1, v, EVENT.RUMOR]);
      } else if (seenFrom[v]) {
        events.push([seenFrom[v] - 1, v, EVENT.SEEN]);
      }
    }

    this.t += 1;
    this.history.push(this.metrics());
    this.events.push(events);
    if (this.record) this.snapshots.push(this.snapshot());
  }

  run() {
    const { nSteps } = this.sc;
    while (this.t < nSteps) {
      this.step();
      if (!this.active.some((a) => a)) {
        // Никто больше ничего не публикует — дальше ничего не изменится.
        const last = this.history[this.history.length - 1];
        const lastSnap = this.record ? this.snapshots[this.snapshots.length - 1] : null;
        while (this.t < nSteps) {
          this.t += 1;
          this.history.push({ ...last, step: this.t });
          this.events.push([]);
          if (this.record) this.snapshots.push(lastSnap);
        }
      }
    }
    return this;
  }

  metrics() {
    const h = this.humans;
    const total = Math.max(1, h.length);
    let unaware = 0, rumor = 0, corr = 0, rumorActive = 0, corrActive = 0, reach = 0, exposed = 0;
    for (const v of h) {
      const m = this.message[v];
      if (m === Opinion.NONE && !this.exposed[v]) unaware++;
      if (m === Opinion.RUMOR) {
        rumor++;
        if (this.active[v]) rumorActive++;
      } else if (m === Opinion.CORRECTION) {
        corr++;
        if (this.active[v]) corrActive++;
      }
      if (this.everRumor[v]) reach++;
      if (this.exposed[v]) exposed++;
    }
    return {
      step: this.t,
      unaware,
      rumorBelievers: rumor,
      correction: corr,
      rumorActive,
      correctionActive: corrActive,
      rumorReach: reach,
      exposed,
      rumorReachFrac: reach / total,
      correctionFrac: corr / total,
      exposedFrac: exposed / total,
    };
  }

  summary() {
    const hist = this.history;
    let peakIdx = 0;
    hist.forEach((r, i) => {
      if (r.rumorActive > hist[peakIdx].rumorActive) peakIdx = i;
    });
    const last = hist[hist.length - 1];
    return {
      humans: this.humans.length,
      rumorReachFrac: last.rumorReachFrac,
      exposedFrac: last.exposedFrac,
      finalCorrectionFrac: last.correctionFrac,
      peakRumorActive: hist[peakIdx].rumorActive,
      timeToPeak: hist[peakIdx].step,
      cascade: last.rumorReachFrac > CASCADE_THRESHOLD,
    };
  }
}

export function runScenario(scenario, opts) {
  return new Simulation(scenario, opts).run();
}

// ------------------------------------------------------------ серии прогонов

// Прогнать сценарий nRuns раз с разными seed (1000 + run, как в experiments.py).
export function runMany(base, nRuns, changes = {}) {
  const summaries = [];
  const curves = [];
  for (let run = 0; run < nRuns; run++) {
    const sim = runScenario({ ...base, ...changes, seed: 1000 + run }, { record: false });
    summaries.push(sim.summary());
    curves.push(sim.history);
  }
  return { summaries, curves };
}

export function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function std(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

// Среднее и σ метрики по шагам для набора прогонов.
export function meanCurve(curves, key) {
  const steps = curves[0].length;
  const m = new Array(steps);
  const s = new Array(steps);
  for (let i = 0; i < steps; i++) {
    const col = curves.map((c) => c[i][key]);
    m[i] = mean(col);
    s[i] = std(col);
  }
  return { mean: m, std: s };
}
