"""Графики динамики, картинки сети и анимация."""

from __future__ import annotations

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import matplotlib.ticker
import networkx as nx
import numpy as np
import pandas as pd
from matplotlib.animation import FuncAnimation, PillowWriter
from matplotlib.lines import Line2D

from model import AgentType, Opinion, Simulation, TYPE_LABELS

# Цвета состояний
C_UNAWARE = "#d5dae1"
C_SEEN = "#f2c94c"
C_RUMOR = "#e5484d"
C_RUMOR_PASSIVE = "#f3a6a8"
C_CORR = "#2f9e63"
C_CORR_PASSIVE = "#9fd8b7"
C_TEXT = "#2b2f36"

SHAPES = {
    AgentType.HUMAN: "o",
    AgentType.SKEPTIC: "o",
    AgentType.INFLUENCER: "o",
    AgentType.AMPLIFIER_BOT: "s",
    AgentType.FACTCHECK_BOT: "D",
}

plt.rcParams.update({
    "figure.dpi": 110,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "axes.grid": True,
    "grid.alpha": 0.25,
    "axes.titleweight": "bold",
    "axes.titlesize": 12,
    "font.size": 10,
})


# ---------------------------------------------------------------- динамика

def plot_dynamics(df: pd.DataFrame, title: str = "Динамика распространения слуха и опровержения"):
    fig, ax = plt.subplots(figsize=(9, 5))
    ax.plot(df["step"], df["rumor_reach"], color=C_RUMOR, lw=2.2, label="Поверили слуху (накопительно)")
    ax.plot(df["step"], df["rumor_active"], color=C_RUMOR, lw=1.6, ls="--", label="Активно репостят слух")
    ax.plot(df["step"], df["correction"], color=C_CORR, lw=2.2, label="Приняли опровержение")
    ax.plot(df["step"], df["exposed"], color=C_SEEN, lw=1.6, label="Видели слух")
    ax.plot(df["step"], df["unaware"], color="#8a94a3", lw=1.4, ls=":", label="Ничего не видели")
    ax.set_xlabel("Шаг симуляции")
    ax.set_ylabel("Число пользователей (люди, без ботов)")
    ax.set_title(title)
    ax.legend(loc="upper left", bbox_to_anchor=(1.01, 1), frameon=False)
    fig.tight_layout()
    return fig


def plot_mean_curves(curves: dict[str, pd.DataFrame], metric: str = "rumor_reach_frac",
                     ylabel: str = "Доля поверивших слуху", title: str = ""):
    """curves: подпись → DataFrame со столбцами step, run, <metric>. Среднее ± 1 ст. откл."""
    fig, ax = plt.subplots(figsize=(9, 5))
    palette = ["#8a94a3", C_RUMOR, C_CORR, "#3e63dd", "#f59e0b", "#8e4ec6"]
    for (label, df), color in zip(curves.items(), palette):
        g = df.groupby("step")[metric]
        mean, std = g.mean(), g.std().fillna(0)
        ax.plot(mean.index, mean.values, color=color, lw=2.2, label=label)
        ax.fill_between(mean.index, (mean - std).clip(lower=0), mean + std, color=color, alpha=0.15, lw=0)
    ax.set_xlabel("Шаг симуляции")
    ax.set_ylabel(ylabel)
    ax.set_title(title)
    ax.legend(frameon=False)
    fig.tight_layout()
    return fig


def plot_threshold(df: pd.DataFrame, x: str = "p_share", group: str = "network",
                   title: str = "Переломная точка: охват слуха vs вероятность репоста"):
    """df: одна строка на прогон. Слева — средний охват, справа — вероятность массового каскада."""
    labels = {"scale_free": "Scale-free (хабы)", "small_world": "Small-world", "random": "Случайная"}
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(12, 4.6))
    palette = [C_RUMOR, "#3e63dd", "#8a94a3", C_CORR]
    for (name, sub), color in zip(df.groupby(group, sort=False), palette):
        g = sub.groupby(x)
        mean = g["rumor_reach_frac"].mean()
        q1, q3 = g["rumor_reach_frac"].quantile(0.25), g["rumor_reach_frac"].quantile(0.75)
        a1.plot(mean.index, mean.values, "-o", ms=3.5, color=color, lw=2, label=labels.get(name, name))
        a1.fill_between(mean.index, q1, q3, color=color, alpha=0.13, lw=0)
        a2.plot(mean.index, g["cascade"].mean().values, "-o", ms=3.5, color=color, lw=2, label=labels.get(name, name))
    a1.set_xlabel("Вероятность репоста обычного пользователя, p_share")
    a1.set_ylabel("Итоговая доля поверивших слуху")
    a1.set_title("Средний охват (полоса — 25–75%)")
    a2.set_xlabel("Вероятность репоста обычного пользователя, p_share")
    a2.set_ylabel("Доля прогонов с массовым каскадом")
    a2.set_title("Вероятность каскада (охват > 20%)")
    a2.set_ylim(-0.03, 1.03)
    for a in (a1, a2):
        a.legend(frameon=False)
    fig.suptitle(title, fontweight="bold")
    fig.tight_layout()
    return fig


def plot_bars(df: pd.DataFrame, x: str, x_labels: dict | None = None, hue: str | None = None,
              hue_labels: dict | None = None, metric: str = "rumor_reach_frac",
              ylabel: str = "Итоговая доля поверивших слуху", title: str = "",
              palette: list[str] | None = None):
    fig, ax = plt.subplots(figsize=(9, 5))
    xs = list(dict.fromkeys(df[x]))
    hues = list(dict.fromkeys(df[hue])) if hue else [None]
    width = 0.8 / len(hues)
    palette = palette or [C_RUMOR, C_CORR, "#3e63dd", "#8a94a3"]
    for i, h in enumerate(hues):
        sub = df if h is None else df[df[hue] == h]
        g = sub.groupby(x)[metric]
        means = [g.mean().get(v, np.nan) for v in xs]
        errs = [g.std().get(v, 0) for v in xs]
        pos = np.arange(len(xs)) + (i - (len(hues) - 1) / 2) * width
        label = None if h is None else (hue_labels or {}).get(h, h)
        bars = ax.bar(pos, means, width * 0.92, yerr=errs, capsize=3, color=palette[i % len(palette)],
                      alpha=0.9, label=label, error_kw={"elinewidth": 1, "alpha": 0.6})
        for b, m in zip(bars, means):
            ax.text(b.get_x() + b.get_width() / 2, m + 0.01, f"{m:.0%}", ha="center", va="bottom", fontsize=9, color=C_TEXT)
    ax.set_xticks(np.arange(len(xs)))
    ax.set_xticklabels([(x_labels or {}).get(v, v) for v in xs])
    ax.set_ylabel(ylabel)
    ax.set_title(title)
    ax.yaxis.set_major_formatter(matplotlib.ticker.PercentFormatter(1.0))
    ax.grid(axis="x", visible=False)
    if hue:
        ax.legend(frameon=False, loc="upper center", bbox_to_anchor=(0.5, -0.1), ncol=min(len(hues), 2))
    fig.tight_layout()
    return fig


def plot_heatmap(df: pd.DataFrame, x: str, y: str, metric: str = "rumor_reach_frac",
                 xlabel: str = "", ylabel: str = "", title: str = ""):
    table = df.groupby([y, x])[metric].mean().unstack(x).sort_index(ascending=False)
    fig, ax = plt.subplots(figsize=(9, 5.5))
    im = ax.imshow(table.values, cmap="Reds", vmin=0, vmax=max(0.01, table.values.max()), aspect="auto")
    ax.set_xticks(range(len(table.columns)))
    ax.set_xticklabels([f"{v:g}" for v in table.columns])
    ax.set_yticks(range(len(table.index)))
    ax.set_yticklabels([f"{v:.0%}" for v in table.index])
    for i in range(table.shape[0]):
        for j in range(table.shape[1]):
            v = table.values[i, j]
            ax.text(j, i, f"{v:.0%}", ha="center", va="center", fontsize=8,
                    color="white" if v > table.values.max() * 0.55 else C_TEXT)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    ax.set_title(title)
    ax.grid(False)
    fig.colorbar(im, ax=ax, label="Доля поверивших слуху", format=matplotlib.ticker.PercentFormatter(1.0))
    fig.tight_layout()
    return fig


# ---------------------------------------------------------------- сеть

def layout(sim: Simulation) -> dict:
    if not hasattr(sim, "_pos"):
        sim._pos = nx.spring_layout(sim.G, seed=sim.sc.seed, k=1.6 / np.sqrt(sim.G.number_of_nodes()), iterations=80)
    return sim._pos


def node_colors(sim: Simulation, step: int) -> list[str]:
    msg = sim.snapshots[step]
    act = sim.active_snapshots[step]
    seen = sim.exposed_snapshots[step]
    colors = []
    for v in range(len(msg)):
        if msg[v] == Opinion.RUMOR:
            colors.append(C_RUMOR if act[v] else C_RUMOR_PASSIVE)
        elif msg[v] == Opinion.CORRECTION:
            colors.append(C_CORR if act[v] else C_CORR_PASSIVE)
        else:
            colors.append(C_SEEN if seen[v] else C_UNAWARE)
    return colors


def draw_network(sim: Simulation, step: int, ax=None, show_legend: bool = True, title: str | None = None):
    own_fig = ax is None
    if own_fig:
        fig, ax = plt.subplots(figsize=(8, 7))
    pos = layout(sim)
    G = sim.G
    colors = node_colors(sim, step)
    deg = dict(G.degree)
    max_deg = max(deg.values())

    nx.draw_networkx_edges(G, pos, ax=ax, alpha=0.08, width=0.5, edge_color="#5b6472")
    for kind, shape in SHAPES.items():
        nodes = [v for v in G.nodes() if sim.agent_type[v] == kind]
        if not nodes:
            continue
        sizes = [18 + 260 * (deg[v] / max_deg) ** 1.2 for v in nodes]
        if kind in AgentType.BOTS:
            sizes = [max(s, 60) for s in sizes]
        edge = "#1f2328" if kind in (*AgentType.BOTS, AgentType.INFLUENCER) else "white"
        nx.draw_networkx_nodes(G, pos, nodelist=nodes, ax=ax, node_shape=shape, node_size=sizes,
                               node_color=[colors[v] for v in nodes], edgecolors=edge,
                               linewidths=1.1 if edge != "white" else 0.3)
    ax.set_axis_off()
    ax.set_title(title if title is not None else f"Шаг {step}", fontweight="bold")

    if show_legend:
        handles = [
            Line2D([], [], marker="o", ls="", color=C_UNAWARE, ms=8, label="Ничего не видел"),
            Line2D([], [], marker="o", ls="", color=C_SEEN, ms=8, label="Видел, не поверил"),
            Line2D([], [], marker="o", ls="", color=C_RUMOR, ms=8, label="Репостит слух"),
            Line2D([], [], marker="o", ls="", color=C_RUMOR_PASSIVE, ms=8, label="Верит слуху"),
            Line2D([], [], marker="o", ls="", color=C_CORR, ms=8, label="Публикует опровержение"),
            Line2D([], [], marker="o", ls="", color=C_CORR_PASSIVE, ms=8, label="Принял опровержение"),
            Line2D([], [], marker="s", ls="", mfc="white", mec="#1f2328", ms=8, label=TYPE_LABELS[AgentType.AMPLIFIER_BOT]),
            Line2D([], [], marker="D", ls="", mfc="white", mec="#1f2328", ms=7, label=TYPE_LABELS[AgentType.FACTCHECK_BOT]),
            Line2D([], [], marker="o", ls="", mfc="white", mec="#1f2328", ms=11, label="Инфлюенсер (крупный узел)"),
        ]
        ax.legend(handles=handles, loc="lower left", fontsize=8, frameon=True, framealpha=0.9, ncol=2)
    if own_fig:
        fig.tight_layout()
        return fig
    return ax.figure


def network_snapshots(sim: Simulation, steps: list[int] | None = None):
    df = sim.dataframe()
    if steps is None:
        peak = int(df["rumor_active"].idxmax())
        steps = [0, max(1, peak), sim.t]
    names = ["Старт", "Пик распространения", "Итог"]
    fig, axes = plt.subplots(1, len(steps), figsize=(6 * len(steps), 6))
    for i, (ax, st) in enumerate(zip(axes, steps)):
        label = names[i] if len(steps) == 3 else "Шаг"
        draw_network(sim, st, ax=ax, show_legend=(i == 0), title=f"{label} · шаг {st}")
    fig.tight_layout()
    return fig


def save_gif(sim: Simulation, path: str, fps: int = 4, max_frames: int = 40) -> None:
    last = sim.t
    df = sim.dataframe()
    # Обрезаем «хвост», где уже ничего не меняется.
    changes = df.drop(columns="step").diff().abs().sum(axis=1)
    moving = changes[changes > 0].index
    if len(moving):
        last = min(sim.t, int(moving.max()) + 3)
    frames = list(range(0, last + 1))[:max_frames]

    fig, ax = plt.subplots(figsize=(7, 6.4))

    def update(i):
        ax.clear()
        row = df.iloc[frames[i]]
        draw_network(sim, frames[i], ax=ax, show_legend=False,
                     title=f"Шаг {frames[i]}  ·  поверили слуху: {int(row['rumor_reach'])}  ·  опровержение: {int(row['correction'])}")
        return []

    anim = FuncAnimation(fig, update, frames=len(frames), blit=False)
    anim.save(path, writer=PillowWriter(fps=fps))
    plt.close(fig)
