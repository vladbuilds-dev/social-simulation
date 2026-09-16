// Проверка паритета JS-модели с Python: те же эксперименты, 30 прогонов.
// Запуск: node tools/parity.mjs   (сравнить с results/summary.md)
import { DEFAULT_SCENARIO as base, runMany, mean } from "../web/sim.js";

const pct = (x) => (x * 100).toFixed(1) + "%";
const reach = (ch) => mean(runMany(base, 30, ch).summaries.map((s) => s.rumorReachFrac));
const t0 = performance.now();

console.log("1. Сценарии");
console.log("  без ботов              ", pct(reach({})));
console.log("  5% ботов               ", pct(reach({ botFraction: 0.05 })));
console.log("  5% ботов + 3% ФЧ хабы  ", pct(reach({ botFraction: 0.05, factcheckFraction: 0.03, factcheckPlacement: "hubs" })));

console.log("2. Порог (P каскада ≥ 0.5)");
for (const network of ["scale_free", "small_world", "random"]) {
  let found = null;
  for (let p = 0.05; p <= 0.6001 && found === null; p += 0.025) {
    const { summaries } = runMany(base, 30, { network, pShare: p, initialSpreaders: 3 });
    if (mean(summaries.map((s) => (s.cascade ? 1 : 0))) >= 0.5) found = p;
  }
  console.log("  ", network.padEnd(12), found?.toFixed(3));
}

console.log("4. Размещение 3% ботов");
for (const botPlacement of ["random", "hubs", "periphery"]) {
  const { summaries } = runMany(base, 30, { botFraction: 0.03, botPlacement });
  console.log("  ", botPlacement.padEnd(10), pct(mean(summaries.map((s) => s.rumorReachFrac))),
    "каскад", pct(mean(summaries.map((s) => (s.cascade ? 1 : 0)))));
}

console.log("5. ФЧ в хабах 5%, шаг 1 / шаг 6:",
  pct(reach({ botFraction: 0.05, factcheckFraction: 0.05, factcheckPlacement: "hubs", factcheckDelay: 1 })),
  pct(reach({ botFraction: 0.05, factcheckFraction: 0.05, factcheckPlacement: "hubs", factcheckDelay: 6 })));
console.log("6. Скептики при p=0.3: 0% / 30% / 50%:",
  [0, 0.3, 0.5].map((s) => pct(reach({ skepticFraction: s, pShare: 0.3, initialSpreaders: 3 }))).join(" / "));
console.log(`\n${(performance.now() - t0).toFixed(0)} мс`);
