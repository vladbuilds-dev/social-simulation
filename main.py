"""Один прогон сценария: график динамики, кадры сети и GIF.

Примеры:
    python main.py
    python main.py --bots 0.05 --placement hubs
    python main.py --bots 0.05 --factcheck 0.03 --factcheck-placement hubs --gif
"""

from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib.pyplot as plt

from model import NETWORKS, PLACEMENTS, Scenario, run_scenario
from visualization import network_snapshots, plot_dynamics, save_gif

RESULTS = Path(__file__).parent / "results"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--nodes", type=int, default=300)
    ap.add_argument("--network", choices=NETWORKS, default="scale_free")
    ap.add_argument("--p-share", type=float, default=0.18, help="вероятность репоста обычного пользователя")
    ap.add_argument("--skeptics", type=float, default=0.15, help="доля скептиков")
    ap.add_argument("--bots", type=float, default=0.05, help="доля ботов-усилителей")
    ap.add_argument("--placement", choices=PLACEMENTS, default="random", help="где стоят боты")
    ap.add_argument("--factcheck", type=float, default=0.02, help="доля ботов-фактчекеров")
    ap.add_argument("--factcheck-placement", choices=PLACEMENTS, default="random")
    ap.add_argument("--delay", type=int, default=3, help="через сколько шагов включаются фактчекеры")
    ap.add_argument("--steps", type=int, default=50)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--gif", action="store_true", help="сохранить анимацию results/spread.gif")
    args = ap.parse_args()

    sc = Scenario(
        n_nodes=args.nodes, network=args.network, p_share=args.p_share,
        skeptic_fraction=args.skeptics, bot_fraction=args.bots, bot_placement=args.placement,
        factcheck_fraction=args.factcheck, factcheck_placement=args.factcheck_placement,
        factcheck_delay=args.delay, n_steps=args.steps, seed=args.seed,
    )
    sim = run_scenario(sc)
    RESULTS.mkdir(exist_ok=True)

    df = sim.dataframe()
    df.to_csv(RESULTS / "single_run.csv", index=False)

    fig = plot_dynamics(df)
    fig.savefig(RESULTS / "dynamics.png", dpi=150, bbox_inches="tight")
    plt.close(fig)

    fig = network_snapshots(sim)
    fig.savefig(RESULTS / "network_before_after.png", dpi=130, bbox_inches="tight")
    plt.close(fig)

    if args.gif:
        save_gif(sim, str(RESULTS / "spread.gif"))

    s = sim.summary()
    print("Сценарий:", sc.to_dict())
    print(f"Людей в сети:             {s['humans']}")
    print(f"Поверили слуху:           {s['rumor_reach_frac']:.1%}")
    print(f"Видели слух:              {s['exposed_frac']:.1%}")
    print(f"Приняли опровержение:     {s['final_correction_frac']:.1%}")
    print(f"Пик активных репостов:    {s['peak_rumor_active']} (шаг {s['time_to_peak']})")
    print(f"Файлы сохранены в {RESULTS}")


if __name__ == "__main__":
    main()
