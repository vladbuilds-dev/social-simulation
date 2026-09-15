"""Интерактивный симулятор: streamlit run app.py"""

from __future__ import annotations

from dataclasses import replace

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import streamlit as st

from experiments import CASCADE_THRESHOLD, run_many
from model import NETWORKS, TYPE_LABELS, Scenario, run_scenario
from visualization import draw_network, plot_dynamics, plot_mean_curves, plot_threshold

st.set_page_config(page_title="Симулятор слухов", page_icon="🕸️", layout="wide")

NET_LABELS = {"scale_free": "Scale-free (с хабами)", "small_world": "Small-world", "random": "Случайная"}
PLACE_LABELS = {"random": "Случайно", "hubs": "В хабах", "periphery": "На периферии"}


# ---------------------------------------------------------------- параметры

def scenario_controls() -> Scenario:
    sb = st.sidebar
    sb.title("🕸️ Параметры")

    sb.subheader("Сеть")
    n_nodes = sb.slider("Пользователей", 100, 800, 300, 50)
    network = sb.selectbox("Тип сети", NETWORKS, format_func=NET_LABELS.get)
    avg_degree = sb.slider("Среднее число связей", 2, 12, 6, 2)

    sb.subheader("Люди")
    p_share = sb.slider("Вероятность репоста (p_share)", 0.0, 0.8, 0.18, 0.01,
                        help="Насколько охотно обычный пользователь репостит увиденный слух")
    skeptics = sb.slider("Доля скептиков", 0.0, 0.6, 0.15, 0.01)
    influencers = sb.slider("Доля инфлюенсеров", 0.0, 0.1, 0.03, 0.01)

    sb.subheader("Боты-усилители")
    bots = sb.slider("Доля ботов", 0.0, 0.2, 0.05, 0.01)
    bot_placement = sb.radio("Где боты", list(PLACE_LABELS), format_func=PLACE_LABELS.get, horizontal=True)

    sb.subheader("Боты-фактчекеры")
    factcheck = sb.slider("Доля фактчекеров", 0.0, 0.15, 0.02, 0.01)
    fc_placement = sb.radio("Где фактчекеры", list(PLACE_LABELS), format_func=PLACE_LABELS.get, horizontal=True)
    delay = sb.slider("Включаются на шаге", 0, 20, 3)

    sb.subheader("Запуск")
    initial = sb.slider("Первых распространителей среди людей", 0, 10, 1)
    seed_placement = sb.radio("Кто запускает слух", ["random", "hubs"],
                              format_func={"random": "Случайные люди", "hubs": "Самые популярные"}.get, horizontal=True)
    steps = sb.slider("Шагов", 10, 150, 50, 5)
    seed = sb.number_input("Seed (случайность)", 0, 10_000, 42)

    if skeptics + influencers + bots + factcheck > 1:
        sb.error("Сумма долей больше 100%")
        st.stop()

    return Scenario(n_nodes=n_nodes, network=network, avg_degree=avg_degree, p_share=p_share,
                    skeptic_fraction=skeptics, influencer_fraction=influencers,
                    bot_fraction=bots, bot_placement=bot_placement,
                    factcheck_fraction=factcheck, factcheck_placement=fc_placement, factcheck_delay=delay,
                    initial_spreaders=initial, seed_placement=seed_placement, n_steps=steps, seed=int(seed))


# ---------------------------------------------------------------- кэш

@st.cache_resource(max_entries=16, show_spinner="Симулирую…")
def cached_sim(sc: Scenario):
    return run_scenario(sc)


@st.cache_data(max_entries=32, show_spinner="Прогоняю серию…")
def cached_many(sc: Scenario, n_runs: int, **changes):
    return run_many(sc, n_runs, **changes)


@st.cache_data(max_entries=8, show_spinner="Ищу переломную точку…")
def cached_sweep(sc: Scenario, networks: tuple[str, ...], p_min: float, p_max: float, n_points: int, n_runs: int):
    parts = []
    for net in networks:
        for p in np.round(np.linspace(p_min, p_max, n_points), 3):
            summary, _ = run_many(sc, n_runs, network=net, p_share=float(p))
            parts.append(summary)
    return pd.concat(parts, ignore_index=True)


def show(fig) -> None:
    st.pyplot(fig, clear_figure=True)
    plt.close(fig)


# ---------------------------------------------------------------- вкладки

def tab_single(sc: Scenario) -> None:
    sim = cached_sim(sc)
    s = sim.summary()
    df = sim.dataframe()

    c = st.columns(5)
    c[0].metric("Поверили слуху", f"{s['rumor_reach_frac']:.0%}")
    c[1].metric("Видели слух", f"{s['exposed_frac']:.0%}")
    c[2].metric("Приняли опровержение", f"{s['final_correction_frac']:.0%}")
    c[3].metric("Пик активных репостов", s["peak_rumor_active"])
    c[4].metric("Шаг пика", s["time_to_peak"])

    if s["rumor_reach_frac"] > CASCADE_THRESHOLD:
        st.error(f"Массовый каскад: слуху поверили больше {CASCADE_THRESHOLD:.0%} людей.")
    else:
        st.success("Слух затух, массового каскада не случилось.")

    left, right = st.columns([1, 1])
    with left:
        step = st.slider("Шаг для картинки сети", 0, sim.t, min(sim.t, int(df["rumor_active"].idxmax()) or 1))
        show(draw_network(sim, step))
    with right:
        show(plot_dynamics(df))
        types = pd.Series(sim.agent_type).map(TYPE_LABELS).value_counts().rename("агентов")
        st.caption("Состав сети")
        st.dataframe(types, width="stretch")
        st.download_button("Скачать метрики CSV", df.to_csv(index=False).encode("utf-8"),
                           "simulation.csv", "text/csv")


def tab_compare(sc: Scenario) -> None:
    st.markdown("**A** — параметры из боковой панели. **B** — те же параметры, кроме изменённых ниже. "
                "Каждый сценарий прогоняется несколько раз с разными seed, показано среднее ± σ.")
    c = st.columns(5)
    bots = c[0].slider("B: доля ботов", 0.0, 0.2, sc.bot_fraction, 0.01)
    placement = c[1].selectbox("B: где боты", list(PLACE_LABELS), index=list(PLACE_LABELS).index(sc.bot_placement),
                               format_func=PLACE_LABELS.get)
    fc = c[2].slider("B: доля фактчекеров", 0.0, 0.15, min(0.15, sc.factcheck_fraction + 0.03), 0.01)
    sk = c[3].slider("B: доля скептиков", 0.0, 0.6, sc.skeptic_fraction, 0.01)
    n_runs = c[4].slider("Прогонов", 5, 60, 20, 5)

    changes_b = dict(bot_fraction=bots, bot_placement=placement, factcheck_fraction=fc, skeptic_fraction=sk)
    base = replace(sc, seed=0)
    sum_a, cur_a = cached_many(base, n_runs)
    sum_b, cur_b = cached_many(base, n_runs, **changes_b)

    col1, col2 = st.columns(2)
    with col1:
        show(plot_mean_curves({"A": cur_a, "B": cur_b}, title="Доля поверивших слуху"))
    with col2:
        show(plot_mean_curves({"A": cur_a, "B": cur_b}, metric="correction_frac",
                              ylabel="Доля принявших опровержение", title="Опровержение"))

    def row(summary):
        return {"Охват слуха": f"{summary['rumor_reach_frac'].mean():.1%}",
                "Вероятность каскада": f"{(summary['rumor_reach_frac'] > CASCADE_THRESHOLD).mean():.0%}",
                "Опровержение": f"{summary['final_correction_frac'].mean():.1%}",
                "Пик активных": f"{summary['peak_rumor_active'].mean():.1f}"}

    st.table(pd.DataFrame({"A": row(sum_a), "B": row(sum_b)}).T)


def tab_threshold(sc: Scenario) -> None:
    st.markdown("Меняем только вероятность репоста и смотрим, где слух перестаёт затухать. "
                "Остальные параметры — из боковой панели.")
    c = st.columns(4)
    nets = c[0].multiselect("Сети", NETWORKS, default=list(NETWORKS), format_func=NET_LABELS.get)
    p_range = c[1].slider("Диапазон p_share", 0.0, 0.8, (0.05, 0.6), 0.05)
    n_points = c[2].slider("Точек", 5, 25, 12)
    n_runs = c[3].slider("Прогонов на точку", 5, 40, 15, 5)
    if not nets:
        st.info("Выбери хотя бы одну сеть.")
        return
    if st.button("Построить кривую", type="primary"):
        st.session_state["sweep_ready"] = True
    if st.session_state.get("sweep_ready"):
        df = cached_sweep(replace(sc, seed=0), tuple(nets), p_range[0], p_range[1], n_points, n_runs)
        show(plot_threshold(df))


def tab_about() -> None:
    st.markdown("""
### Что происходит
Сеть пользователей, у каждого есть **тип** и **состояние**. На каждом шаге активные агенты показывают своё сообщение соседям.

| Тип | Поведение |
|---|---|
| Обычный пользователь | видит пост (p_exposure 0.35), иногда проверяет (4%), репостит с вероятностью p_share, выгорает через 3 шага |
| Скептик | часто проверяет (45%) и публикует опровержение, репостит слух в 7 раз реже |
| Инфлюенсер | самые связные люди, репостят в 1.4 раза охотнее и дольше активны |
| Бот-усилитель | всегда публикует слух, не выгорает, не меняет позицию |
| Бот-фактчекер | всегда публикует опровержение, включается с задержкой |

**Правила:** опровержение принимают только те, кто уже видел слух, и репостят его вдвое реже, чем слух.
Если в одном шаге пришли и слух, и опровержение, побеждает опровержение. Все изменения применяются одновременно.

**Метрики:** охват слуха — доля людей (без ботов), которые хоть раз поверили слуху; массовый каскад — охват > 20%.

### Ограничения
Модель иллюстративная. Она не прогнозирует поведение конкретной соцсети или людей, а сравнивает механизмы:
как структура связей, боты, скептики и фактчекинг меняют коллективный итог.
""")


def main() -> None:
    sc = scenario_controls()
    st.title("Симулятор распространения слухов")
    st.caption("Агентная модель: пользователи, скептики, инфлюенсеры, боты-усилители и боты-фактчекеры в социальной сети")
    t1, t2, t3, t4 = st.tabs(["▶ Прогон", "⚖ Сравнение A/B", "📈 Переломная точка", "ℹ О модели"])
    with t1:
        tab_single(sc)
    with t2:
        tab_compare(sc)
    with t3:
        tab_threshold(sc)
    with t4:
        tab_about()


main()
