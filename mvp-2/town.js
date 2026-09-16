// Пиксельный город: раскладка жителей по клеткам, фон, спрайты и отрисовка кадра.
// Всё рисуется в маленький холст W×H, а потом растягивается без сглаживания.

import { makeRng, T } from "./sim.js";
import { forceLayout } from "./layout.js";

export const W = 480;
export const H = 272;
const CW = 12; // клетка по горизонтали
const CH = 16; // клетка по вертикали
const COLS = W / CW;
const ROWS = H / CH;

export const PAL = {
  night: "#1a1c2c",
  plum: "#5d275d",
  red: "#b13e53",
  redHot: "#e43b44",
  orange: "#ef7d57",
  yellow: "#ffcd75",
  lime: "#a7f070",
  green: "#38b764",
  teal: "#257179",
  navy: "#29366f",
  blue: "#3b5dc9",
  sky: "#41a6f6",
  cyan: "#73eff7",
  white: "#f4f4f4",
  mist: "#94b0c2",
  slate: "#566c86",
  ink: "#333c57",
};

// Цвет «рубашки» = что житель думает о слухе.
export const STATE_COLOR = {
  unaware: PAL.mist,
  seen: PAL.yellow,
  rumor: PAL.redHot,
  rumorSoft: PAL.red,
  corr: PAL.lime,
  corrSoft: PAL.green,
  banned: PAL.slate,
};

const NAMES = [
  "Аня", "Борис", "Вера", "Гоша", "Даша", "Егор", "Женя", "Зоя", "Игорь", "Катя",
  "Лёва", "Маша", "Никита", "Оля", "Паша", "Рита", "Саша", "Таня", "Уля", "Федя",
  "Хасан", "Юля", "Яна", "Миша", "Лиза", "Тимур", "Нина", "Костя", "Алиса", "Семён",
  "Галина", "Роман", "Дина", "Артём", "Соня", "Глеб", "Полина", "Марат", "Ева", "Денис",
];

// ------------------------------------------------------------ спрайты 7×10

const SPR = {
  person: [
    "..hhh..",
    ".hkkkh.",
    "..kkk..",
    ".sssss.",
    "s.sss.s",
    "k.sss.k",
    "..SSS..",
    "..p.p..",
    "..p.p..",
    ".ff.ff.",
  ],
  personTalk: [
    "..hhh..",
    ".hkkkh.",
    "..kkk.k",
    ".ssssss",
    "s.sss..",
    "k.sss..",
    "..SSS..",
    "..p.p..",
    "..p.p..",
    ".ff.ff.",
  ],
  skeptic: [
    "..hhh..",
    ".hgggh.",
    "..kkk..",
    ".sssss.",
    "s.sss.s",
    "k.sss.k",
    "..SSS..",
    "..p.p..",
    "..p.p..",
    ".ff.ff.",
  ],
  influencer: [
    "..hhh..",
    ".hkkkhw",
    "..kkkww",
    ".sssssw",
    "s.sss..",
    "k.sss..",
    "..SSS..",
    "..p.p..",
    "..p.p..",
    ".ff.ff.",
  ],
  factchecker: [
    "..ccc..",
    ".ccccc.",
    "..kkk..",
    ".sssss.",
    "s.sbs.s",
    "k.sss.k",
    "..SSS..",
    "..p.p..",
    "..p.p..",
    ".ff.ff.",
  ],
  robot: [
    "...r...",
    "...a...",
    ".mmmmm.",
    ".memem.",
    ".mmmmm.",
    "sssssss",
    "s.sss.s",
    "..SSS..",
    "..M.M..",
    ".MM.MM.",
  ],
  robotOff: [
    ".......",
    "...a...",
    ".mmmmm.",
    ".mxmxm.",
    ".mmmmm.",
    ".sssss.",
    "s.sss.s",
    "..SSS..",
    "..M.M..",
    ".MM.MM.",
  ],
};

const ENVELOPE = ["kkkkk", "kwkwk", "kkwkk", "kkkkk"];
const BUBBLE_BANG = [".www.", "wwkww", "wwkww", "wwwww", ".www.", "..w.."];
const BUBBLE_OK = [".www.", "wwwkw", "wkwkw", "wwkww", ".www.", "..w.."];

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const spriteCache = new Map();
function sprite(rows, colors) {
  const key = rows.join("") + JSON.stringify(colors);
  let c = spriteCache.get(key);
  if (c) return c;
  c = document.createElement("canvas");
  c.width = rows[0].length;
  c.height = rows.length;
  const g = c.getContext("2d");
  rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const col = colors[ch];
      if (!col) return;
      g.fillStyle = col;
      g.fillRect(x, y, 1, 1);
    });
  });
  spriteCache.set(key, c);
  return c;
}

// ------------------------------------------------------------ город

export function buildTown(sim) {
  const rng = makeRng(sim.sc.seed * 31 + 7);
  const net = sim.net;
  const n = net.n;
  const pos = forceLayout(net, { seed: sim.sc.seed });

  // Жители раскладываются по клеткам рядом со своим местом в графе:
  // знакомые живут недалеко друг от друга, письма летят недалеко.
  const occupied = new Int32Array(COLS * ROWS).fill(-1);
  const cell = new Array(n);
  const order = [...Array(n).keys()].sort((a, b) => net.degree[b] - net.degree[a]);
  for (const v of order) {
    const tc = 1 + Math.round(pos[v][0] * (COLS - 3));
    const tr = 1 + Math.round(pos[v][1] * (ROWS - 2));
    let best = null;
    for (let rad = 0; rad < Math.max(COLS, ROWS) && !best; rad++) {
      let bestD = Infinity;
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
          const c = tc + dc;
          const r = tr + dr;
          if (c < 1 || c > COLS - 2 || r < 1 || r > ROWS - 1) continue;
          if (occupied[r * COLS + c] >= 0) continue;
          const d = dc * dc * 1.8 + dr * dr + rng() * 0.3;
          if (d < bestD) { bestD = d; best = [c, r]; }
        }
      }
    }
    occupied[best[1] * COLS + best[0]] = v;
    cell[v] = best;
  }

  const maxDeg = Math.max(...net.degree);
  const agents = [];
  for (let v = 0; v < n; v++) {
    const [c, r] = cell[v];
    agents.push({
      id: v,
      x: c * CW + 2 + Math.round((rng() - 0.5) * 2),
      y: r * CH + CH - 11,
      name: NAMES[Math.floor(rng() * NAMES.length)],
      hair: [PAL.night, PAL.plum, PAL.orange, PAL.white, PAL.navy][Math.floor(rng() * 5)],
      skin: ["#f0c8a0", "#c98b62", "#8d5a3b", "#e3a987"][Math.floor(rng() * 4)],
      phase: rng() * Math.PI * 2,
      plaza: net.degree[v] >= Math.max(10, maxDeg * 0.45),
    });
  }

  const terrain = document.createElement("canvas");
  terrain.width = W;
  terrain.height = H;
  const windows = [];
  const lamps = [];
  drawTerrain(terrain.getContext("2d"), rng, occupied, agents, net, maxDeg, windows, lamps);
  return { agents, terrain, windows, lamps };
}

function drawTerrain(g, rng, occupied, agents, net, maxDeg, windows, lamps) {
  // Земля: тёмная брусчатка с пиксельным шумом.
  g.fillStyle = PAL.ink;
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < W * H * 0.08; i++) {
    g.fillStyle = rng() < 0.5 ? "#2e3550" : "#39425f";
    g.fillRect(Math.floor(rng() * W), Math.floor(rng() * H), 1, 1);
  }

  // Улицы.
  g.fillStyle = PAL.navy;
  for (let r = 4; r < ROWS; r += 5) g.fillRect(0, r * CH - 3, W, 3);
  for (let c = 7; c < COLS; c += 9) g.fillRect(c * CW - 2, 0, 3, H);
  g.fillStyle = "#3a4a86";
  for (let r = 4; r < ROWS; r += 5) for (let x = 2; x < W; x += 8) g.fillRect(x, r * CH - 2, 3, 1);

  // Площади под самыми связными жителями — это хабы сети.
  for (const a of agents) {
    if (!a.plaza) continue;
    const cx = a.x + 3;
    const cy = a.y + 9;
    const rad = 8 + Math.round((net.degree[a.id] / maxDeg) * 9);
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const d2 = dx * dx + dy * dy * 2.2;
        if (d2 > rad * rad) continue;
        const ring = d2 > (rad - 2) * (rad - 2);
        g.fillStyle = ring ? PAL.slate : (dx + dy) & 1 ? "#4b5a78" : "#44526e";
        g.fillRect(cx + dx, cy + dy, 1, 1);
      }
    }
  }

  // Пустые клетки — дома, деревья, фонари.
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (occupied[r * COLS + c] >= 0) continue;
      const nearPlaza = agents.some((a) => a.plaza && Math.abs(a.x - c * CW) < 20 && Math.abs(a.y - r * CH) < 16);
      if (nearPlaza) continue;
      const x = c * CW;
      const y = r * CH;
      const roll = rng();
      if (roll < 0.34) drawHouse(g, rng, x + 1, y + 4, windows);
      else if (roll < 0.52) drawTree(g, rng, x + 2, y + 3);
      else if (roll < 0.57) {
        g.fillStyle = PAL.slate;
        g.fillRect(x + 6, y + 5, 1, 9);
        g.fillStyle = PAL.mist;
        g.fillRect(x + 5, y + 4, 3, 1);
        lamps.push([x + 6, y + 5]);
      } else if (roll < 0.62) {
        g.fillStyle = rng() < 0.5 ? PAL.plum : PAL.teal;
        g.fillRect(x + 3 + Math.floor(rng() * 5), y + 12, 1, 1);
        g.fillRect(x + 2 + Math.floor(rng() * 7), y + 10, 1, 1);
      }
    }
  }
}

function drawHouse(g, rng, x, y, windows) {
  const w = 10;
  const wall = rng() < 0.5 ? PAL.navy : "#2c2f4a";
  const roof = [PAL.plum, PAL.teal, "#4a2a4f"][Math.floor(rng() * 3)];
  for (let i = 0; i < 4; i++) {
    g.fillStyle = roof;
    g.fillRect(x + 3 - i + 1, y + i, 2 * i + 2 + 2, 1);
  }
  g.fillStyle = wall;
  g.fillRect(x, y + 4, w, 8);
  g.fillStyle = PAL.night;
  g.fillRect(x + 4, y + 8, 2, 4);
  g.fillStyle = "#20243a";
  g.fillRect(x + 1, y + 6, 2, 2);
  g.fillRect(x + 7, y + 6, 2, 2);
  windows.push([x + 1, y + 6], [x + 7, y + 6]);
}

function drawTree(g, rng, x, y) {
  g.fillStyle = PAL.night;
  g.fillRect(x + 3, y + 8, 2, 4);
  g.fillStyle = PAL.teal;
  g.fillRect(x + 1, y + 2, 6, 6);
  g.fillRect(x + 2, y + 1, 4, 8);
  g.fillStyle = "#1d5a62";
  g.fillRect(x + 1, y + 6, 6, 2);
  g.fillStyle = "#2f8a93";
  g.fillRect(x + 2, y + 2, 2, 1);
}

// ------------------------------------------------------------ кадр

export function agentSprite(town, sim, v, color, talking, banned) {
  const a = town.agents[v];
  const type = sim.type[v];
  const base = { h: a.hair, k: a.skin, s: color, S: shade(color.startsWith("#") ? color : PAL.mist, 0.72), p: PAL.navy, f: PAL.night, g: PAL.night, w: PAL.white, b: PAL.white, c: PAL.teal };
  if (type === T.AMP_BOT) {
    const robot = { m: PAL.mist, M: PAL.slate, a: PAL.mist, r: PAL.redHot, e: PAL.redHot, x: PAL.ink, s: color, S: shade(color, 0.72) };
    return sprite(banned ? SPR.robotOff : SPR.robot, robot);
  }
  if (type === T.FC_BOT) {
    if (sim.hired?.has(v)) return sprite(SPR.factchecker, base);
    return sprite(SPR.robot, { m: PAL.mist, M: PAL.slate, a: PAL.mist, r: PAL.lime, e: PAL.lime, s: color, S: shade(color, 0.72) });
  }
  if (type === T.INFLUENCER) return sprite(SPR.influencer, base);
  if (type === T.SKEPTIC) return sprite(SPR.skeptic, base);
  return sprite(talking ? SPR.personTalk : SPR.person, base);
}

export function envelopeSprite(color) {
  return sprite(ENVELOPE, { k: color, w: PAL.white });
}

export function bubbleSprite(kind) {
  return kind === "rumor"
    ? sprite(BUBBLE_BANG, { w: PAL.white, k: PAL.redHot })
    : sprite(BUBBLE_OK, { w: PAL.white, k: PAL.green });
}

export function nightFactor(hour) {
  if (hour >= 22 || hour < 5) return 1;
  if (hour >= 19) return (hour - 18) / 4;
  if (hour < 8) return (8 - hour) / 3;
  return 0;
}

export function hitTest(town, lx, ly, radius = 9) {
  let best = -1;
  let bestD = radius * radius;
  for (const a of town.agents) {
    const dx = a.x + 3.5 - lx;
    const dy = a.y + 5 - ly;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = a.id; }
  }
  return best;
}
