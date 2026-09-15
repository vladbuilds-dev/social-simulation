// Силовая раскладка графа (Fruchterman–Reingold) с сеткой для отталкивания.
// Возвращает координаты узлов в квадрате [0, 1] × [0, 1].

import { makeRng } from "./sim.js";

export function forceLayout(net, { seed = 1, iterations = 260 } = {}) {
  const n = net.n;
  const rng = makeRng(seed * 7919 + 17);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * 0.5;
    x[i] = Math.cos(a) * r;
    y[i] = Math.sin(a) * r;
  }

  const k = 1 / Math.sqrt(n);          // «идеальная» длина ребра
  const k2 = k * k;
  const cell = 2.5 * k;                // дальше этого отталкивание не считаем
  const dx = new Float64Array(n);
  const dy = new Float64Array(n);
  const buckets = new Map();

  for (let it = 0; it < iterations; it++) {
    const temp = 0.08 * (1 - it / iterations) + 0.002;
    dx.fill(0);
    dy.fill(0);

    buckets.clear();
    for (let i = 0; i < n; i++) {
      const key = Math.floor(x[i] / cell) * 100003 + Math.floor(y[i] / cell);
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = []));
      b.push(i);
    }

    for (let i = 0; i < n; i++) {
      const cx = Math.floor(x[i] / cell);
      const cy = Math.floor(y[i] / cell);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const b = buckets.get((cx + ox) * 100003 + (cy + oy));
          if (!b) continue;
          for (const j of b) {
            if (j <= i) continue;
            let ddx = x[i] - x[j];
            let ddy = y[i] - y[j];
            let d2 = ddx * ddx + ddy * ddy;
            if (d2 < 1e-9) {
              ddx = (rng() - 0.5) * 1e-3;
              ddy = (rng() - 0.5) * 1e-3;
              d2 = ddx * ddx + ddy * ddy;
            }
            if (d2 > cell * cell) continue;
            const f = k2 / d2;
            dx[i] += ddx * f; dy[i] += ddy * f;
            dx[j] -= ddx * f; dy[j] -= ddy * f;
          }
        }
      }
    }

    for (const [u, v] of net.edges) {
      const ddx = x[u] - x[v];
      const ddy = y[u] - y[v];
      const d = Math.sqrt(ddx * ddx + ddy * ddy) || 1e-6;
      const f = d / k;
      dx[u] -= ddx * f; dy[u] -= ddy * f;
      dx[v] += ddx * f; dy[v] += ddy * f;
    }

    for (let i = 0; i < n; i++) {
      // Мягкая гравитация к центру, чтобы не разлетались мелкие компоненты.
      dx[i] -= x[i] * 0.9;
      dy[i] -= y[i] * 0.9;
      const len = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1e-9;
      const step = Math.min(len, temp);
      x[i] += (dx[i] / len) * step;
      y[i] += (dy[i] / len) * step;
    }
  }

  // Нормируем в [0, 1] с сохранением пропорций; выбросы по краям обрезаем по перцентилю.
  const q = (arr, p) => Float64Array.from(arr).sort()[Math.floor(p * (arr.length - 1))];
  const minX = q(x, 0.005), maxX = q(x, 0.995), minY = q(y, 0.005), maxY = q(y, 0.995);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const offX = (span - (maxX - minX)) / 2;
  const offY = (span - (maxY - minY)) / 2;
  const pos = new Array(n);
  for (let i = 0; i < n; i++) {
    pos[i] = [
      Math.min(1, Math.max(0, (x[i] - minX + offX) / span)),
      Math.min(1, Math.max(0, (y[i] - minY + offY) / span)),
    ];
  }
  return pos;
}
