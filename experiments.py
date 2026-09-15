"""Серии экспериментов с повторными прогонами.

Запуск:
    python experiments.py            # все эксперименты, 30 прогонов на точку
    python experiments.py --runs 10  # быстрее
    python experiments.py --only threshold placement

Результаты: results/*.png и results/*.csv, сводка — results/summary.md
"""

from __future__ import annotations

import argparse
import time
from dataclasses import replace
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from model import NETWORKS, Scenario, run_scenario
from visualization import plot_bars, plot_heatmap, plot_mean_curves, plot_threshold

RESULTS = Path(__file__).parent / "results"
CASCADE_THRESHOLD = 0.20   # «массовый каскад» — слуху поверили больше 20% людей


def run_many(base: Scenario, n_runs: int, **changes) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Прогнать сценарий n_runs раз с разными seed.

    Возвращает (summary: одна строка на прогон, curves: метрики по шагам для всех прогонов).
    """
    rows, curves = [], []
    for run in range(n_runs):
        sc = replace(base, seed=1000 + run, **changes)
        sim = run_scenario(sc)
        s = sim.summary()
        s.update(changes)
        s["run"] = run
        s["cascade"] = s["rumor_reach_frac"] > CASCADE_THRESHOLD
        rows.append(s)
        df = sim.dataframe()
        df["run"] = run
        curves.append(df)
    return pd.DataFrame(rows), pd.concat(curves, ignore_index=True)


def md_table(df: pd.DataFrame, index: bool = True) -> str:
    """Markdown-таблица без внешних зависимостей."""
    if index:
        df = df.reset_index()
    cols = [str(c) for c in df.columns]
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    lines += ["| " + " | ".join(str(v) for v in row) + " |" for row in df.itertuples(index=False)]
    return "\n".join(lines)


def save(fig, name: str) -> None:
    fig.savefig(RESULTS / f"{name}.png", dpi=150, bbox_inches="tight")
    plt.close(fig)


def pct(x: float) -> str:
    return f"{x:.1%}"


# ---------------------------------------------------------------- эксперименты

def exp_scenarios(base: Scenario, n_runs: int) -> str:
    """Три базовых сценария: без ботов / боты / боты + фактчекеры."""
    variants = {
        "Без ботов": dict(bot_fraction=0.0, factcheck_fraction=0.0),
        "5% ботов-усилителей": dict(bot_fraction=0.05, factcheck_fraction=0.0),
        "5% ботов + 3% фактчекеров в хабах": dict(bot_fraction=0.05, factcheck_fraction=0.03, factcheck_placement="hubs"),
    }
    curves, table = {}, []
    for label, ch in variants.items():
        summary, c = run_many(base, n_runs, **ch)
        curves[label] = c
        table.append({"Сценарий": label,
                      "Охват слуха": pct(summary["rumor_reach_frac"].mean()),
                      "Приняли опровержение": pct(summary["final_correction_frac"].mean()),
                      "Пик активных": f"{summary['peak_rumor_active'].mean():.1f}",
                      "Шаг пика": f"{summary['time_to_peak'].mean():.1f}"})
        summary.assign(scenario=label).to_csv(RESULTS / f"scenario_{len(table)}.csv", index=False)
    save(plot_mean_curves(curves, title=f"Сравнение сценариев · среднее ± σ по {n_runs} прогонам"), "scenarios_dynamics")
    save(plot_mean_curves(curves, metric="correction_frac", ylabel="Доля принявших опровержение",
                          title="Опровержение в тех же сценариях"), "scenarios_correction")
    return "## 1. Базовые сценарии\n\n" + md_table(pd.DataFrame(table), index=False)


def exp_threshold(base: Scenario, n_runs: int) -> str:
    """Главный график: переломная точка по p_share для трёх типов сетей."""
    p_values = np.round(np.arange(0.05, 0.61, 0.025), 3)
    parts = []
    for net in NETWORKS:
        for p in p_values:
            summary, _ = run_many(base, n_runs, network=net, p_share=float(p),
                                  bot_fraction=0.0, factcheck_fraction=0.0, initial_spreaders=3)
            parts.append(summary)
    df = pd.concat(parts, ignore_index=True)
    df.to_csv(RESULTS / "threshold.csv", index=False)
    save(plot_threshold(df), "threshold_curve")

    lines = ["## 2. Переломная точка (p_share)", "",
             "Первое значение p_share, при котором массовый каскад (> 20% людей) случается в половине прогонов:", ""]
    for net, sub in df.groupby("network", sort=False):
        prob = sub.groupby("p_share")["cascade"].mean()
        crossing = prob[prob >= 0.5]
        lines.append(f"- **{net}**: p_share ≈ {crossing.index[0]:.3f}" if len(crossing) else f"- **{net}**: не достигнут")
    return "\n".join(lines)


def exp_bot_fraction(base: Scenario, n_runs: int) -> str:
    fractions = [0.0, 0.01, 0.03, 0.05, 0.10]
    parts = []
    for fc in (0.0, 0.03):
        for bf in fractions:
            summary, _ = run_many(base, n_runs, bot_fraction=bf, factcheck_fraction=fc, factcheck_placement="hubs")
            summary["bots"] = f"{bf:.0%}"
            summary["factcheck"] = "без фактчекеров" if fc == 0 else "3% фактчекеров в хабах"
            parts.append(summary)
    df = pd.concat(parts, ignore_index=True)
    df.to_csv(RESULTS / "bot_fraction.csv", index=False)
    save(plot_bars(df, x="bots", hue="factcheck",
                   title="Доля ботов-усилителей → охват слуха",
                   ylabel="Итоговая доля поверивших слуху"), "bot_fraction")
    table = df.groupby(["factcheck", "bots"], sort=False)["rumor_reach_frac"].mean().unstack("bots").map(pct)
    return "## 3. Доля ботов-усилителей\n\n" + md_table(table)


def exp_placement(base: Scenario, n_runs: int) -> str:
    labels = {"random": "Случайно", "hubs": "В хабах", "periphery": "На периферии"}
    parts = []
    for placement in labels:
        summary, _ = run_many(base, n_runs, bot_fraction=0.03, bot_placement=placement, factcheck_fraction=0.0)
        parts.append(summary)
    df = pd.concat(parts, ignore_index=True)
    df.to_csv(RESULTS / "bot_placement.csv", index=False)
    save(plot_bars(df, x="bot_placement", x_labels=labels,
                   title="Одинаковые 3% ботов, разное положение в сети"), "bot_placement")
    g = df.groupby("bot_placement", sort=False)
    table = pd.DataFrame({"Охват слуха": g["rumor_reach_frac"].mean().map(pct),
                          "Пик активных": g["peak_rumor_active"].mean().round(1),
                          "Вероятность каскада": g["cascade"].mean().map(pct)}).rename(index=labels)
    return "## 4. Размещение ботов (3%)\n\n" + md_table(table)


def exp_factcheck(base: Scenario, n_runs: int) -> str:
    labels = {"random": "Фактчекеры случайно", "hubs": "Фактчекеры в хабах"}
    parts = []
    for placement in labels:
        for fc in [0.0, 0.01, 0.02, 0.03, 0.05]:
            for delay in (1, 6):  # сразу или с опозданием
                summary, _ = run_many(base, n_runs, bot_fraction=0.05, factcheck_fraction=fc,
                                      factcheck_placement=placement, factcheck_delay=delay)
                summary["fc"] = f"{fc:.0%}"
                summary["delay_label"] = f"{placement}, задержка {delay}"
                parts.append(summary)
    df = pd.concat(parts, ignore_index=True)
    df.to_csv(RESULTS / "factcheck.csv", index=False)
    hue_labels = {f"{p}, задержка {d}": f"{labels[p]} · включаются на шаге {d}" for p in labels for d in (1, 6)}
    save(plot_bars(df, x="fc", hue="delay_label", hue_labels=hue_labels,
                   title="5% ботов-усилителей против ботов-фактчекеров",
                   palette=["#3e63dd", "#a9baf2", "#2f9e63", "#a6dcbd"]), "factcheck")
    table = (df.groupby(["delay_label", "fc"], sort=False)["rumor_reach_frac"].mean()
               .unstack("fc").map(pct).rename(index=hue_labels))
    return "## 5. Боты-фактчекеры\n\n" + md_table(table)


def exp_heatmap(base: Scenario, n_runs: int) -> str:
    parts = []
    for sk in [0.0, 0.1, 0.2, 0.3, 0.4, 0.5]:
        for p in [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5]:
            summary, _ = run_many(base, n_runs, skeptic_fraction=sk, p_share=p,
                                  bot_fraction=0.0, factcheck_fraction=0.0, initial_spreaders=3)
            parts.append(summary)
    df = pd.concat(parts, ignore_index=True)
    df.to_csv(RESULTS / "heatmap.csv", index=False)
    save(plot_heatmap(df, x="p_share", y="skeptic_fraction",
                      xlabel="Вероятность репоста, p_share", ylabel="Доля скептиков",
                      title="Скептики × склонность к репосту"), "heatmap_skeptics")
    return "## 6. Скептики × p_share\n\nСм. `heatmap_skeptics.png`."


EXPERIMENTS = {
    "scenarios": exp_scenarios,
    "threshold": exp_threshold,
    "bots": exp_bot_fraction,
    "placement": exp_placement,
    "factcheck": exp_factcheck,
    "heatmap": exp_heatmap,
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--runs", type=int, default=30, help="прогонов на каждую точку (по умолчанию 30)")
    parser.add_argument("--nodes", type=int, default=300)
    parser.add_argument("--only", nargs="*", choices=list(EXPERIMENTS), help="запустить только выбранные")
    args = parser.parse_args()

    RESULTS.mkdir(exist_ok=True)
    base = Scenario(n_nodes=args.nodes)
    chosen = args.only or list(EXPERIMENTS)
    report = ["# Результаты экспериментов", "",
              f"Сеть: {args.nodes} узлов, прогонов на точку: {args.runs}. "
              f"Массовый каскад — слуху поверили > {CASCADE_THRESHOLD:.0%} людей.", ""]
    for name in chosen:
        t0 = time.time()
        print(f"▶ {name} ...", end=" ", flush=True)
        report += [EXPERIMENTS[name](base, args.runs), ""]
        print(f"{time.time() - t0:.1f} c")

    (RESULTS / "summary.md").write_text("\n".join(report), encoding="utf-8")
    print("\n".join(report))
    print(f"\nГотово: {RESULTS}")


if __name__ == "__main__":
    main()
