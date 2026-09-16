// Баланс уровней: сколько людей поверит слуху без игрока и при разных стратегиях.
// Запуск: node tools/balance.mjs
import { Simulation, T, mean } from "../sim.js";
import { LEVELS } from "../levels.js";

const RUNS = 60;
const pct = (x) => (x * 100).toFixed(1).padStart(5) + "%";

function play(level, seed, strategy) {
  const sim = new Simulation({ ...level.scenario, seed }, { record: false }); // seed перекрывает сид уровня
  const n = sim.net.n;
  const byDeg = [...Array(n).keys()].sort((a, b) => sim.net.degree[b] - sim.net.degree[a]);
  let fc = level.tools.factchecker;
  let ban = level.tools.ban;
  const act = () => {
    if (strategy === "hubs") {
      for (const v of byDeg) if (fc > 0 && sim.hireFactchecker(v)) fc--;
    } else if (strategy === "random") {
      const humans = sim.humans.filter((v) => !sim.isBot[v]);
      for (let i = 0; i < humans.length && fc > 0; i += Math.floor(humans.length / 6)) if (sim.hireFactchecker(humans[i])) fc--;
    } else if (strategy === "ban+hubs") {
      for (const v of byDeg) if (ban > 0 && sim.type[v] === T.AMP_BOT && sim.banBot(v)) ban--;
      for (const v of byDeg) if (fc > 0 && sim.hireFactchecker(v)) fc--;
    } else if (strategy === "late-hubs" && sim.t === 6) {
      for (const v of byDeg) if (fc > 0 && sim.hireFactchecker(v)) fc--;
    }
  };
  if (strategy !== "late-hubs") act();
  while (sim.t < level.scenario.nSteps) {
    if (strategy === "late-hubs") act();
    sim.step();
  }
  return sim.summary().rumorReachFrac;
}

for (const level of LEVELS) {
  console.log(`\n${level.title}  (цели: ${level.stars.map(pct).join(" / ")})`);
  for (const strategy of ["none", "random", "late-hubs", "hubs", "ban+hubs"]) {
    const res = Array.from({ length: RUNS }, (_, i) => play(level, 500 + i, strategy));
    const stars = level.stars.map((g) => mean(res.map((r) => (r < g ? 1 : 0))));
    console.log(`  ${strategy.padEnd(10)} охват ${pct(mean(res))}   ⭐≥1 ${pct(stars[0])}  ⭐≥2 ${pct(stars[1])}  ⭐3 ${pct(stars[2])}`);
  }
}
