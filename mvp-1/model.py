"""Агентная модель распространения слуха и опровержения в социальной сети.

Каждый узел графа — агент. У агента есть:
  * тип (обычный пользователь, скептик, инфлюенсер, бот-усилитель, бот-фактчекер);
  * сообщение, которое он принял (NONE / RUMOR / CORRECTION);
  * флаг активности (распространяет ли он сейчас своё сообщение) и возраст активности.

Правила шага (все изменения применяются одновременно, порядок обхода не влияет):
  1. Каждый активный агент показывает своё сообщение соседям.
  2. Сосед замечает пост с вероятностью p_exposure.
  3. Слух: не видевший ничего сосед сначала может проверить его (p_verify) —
     тогда он принимает опровержение и сам начинает его публиковать;
     иначе с вероятностью p_share верит и начинает репостить слух.
  4. Опровержение: сосед, который уже видел слух, принимает опровержение и
     репостит его с вероятностью p_share × 0.5 (опровержения менее «вирусные»).
     Если в одном шаге пришли и слух, и опровержение — побеждает опровержение.
  5. Люди «выгорают» через lifetime шагов активности. Боты не выгорают и
     не меняют позицию. Фактчекеры включаются с задержкой factcheck_delay.

Модель иллюстративная: она сравнивает механизмы, а не прогнозирует реальную платформу.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, asdict, field
from enum import IntEnum

import networkx as nx
import pandas as pd


class Opinion(IntEnum):
    NONE = 0
    RUMOR = 1
    CORRECTION = 2


class AgentType:
    HUMAN = "human"
    SKEPTIC = "skeptic"
    INFLUENCER = "influencer"
    AMPLIFIER_BOT = "amplifier_bot"
    FACTCHECK_BOT = "factcheck_bot"

    ALL = (HUMAN, SKEPTIC, INFLUENCER, AMPLIFIER_BOT, FACTCHECK_BOT)
    BOTS = (AMPLIFIER_BOT, FACTCHECK_BOT)


TYPE_LABELS = {
    AgentType.HUMAN: "Обычный пользователь",
    AgentType.SKEPTIC: "Скептик",
    AgentType.INFLUENCER: "Инфлюенсер",
    AgentType.AMPLIFIER_BOT: "Бот-усилитель",
    AgentType.FACTCHECK_BOT: "Бот-фактчекер",
}

# Базовые профили поведения. p_share обычного пользователя переопределяется
# параметром сценария, остальные типы считаются относительно него.
BASE_PROFILE = {
    AgentType.HUMAN: {"p_exposure": 0.35, "p_share": 0.18, "p_verify": 0.04, "lifetime": 3},
    AgentType.SKEPTIC: {"p_exposure": 0.30, "p_share": 0.03, "p_verify": 0.45, "lifetime": 2},
    AgentType.INFLUENCER: {"p_exposure": 0.45, "p_share": 0.25, "p_verify": 0.05, "lifetime": 4},
    AgentType.AMPLIFIER_BOT: {"p_exposure": 0.0, "p_share": 1.0, "p_verify": 0.0, "lifetime": 10**9},
    AgentType.FACTCHECK_BOT: {"p_exposure": 0.0, "p_share": 1.0, "p_verify": 1.0, "lifetime": 10**9},
}

# Опровержения репостят реже, чем сенсационный слух.
CORRECTION_SHARE_FACTOR = 0.5

NETWORKS = ("scale_free", "small_world", "random")
PLACEMENTS = ("random", "hubs", "periphery")


@dataclass
class Scenario:
    """Все параметры одного прогона в одном месте."""

    n_nodes: int = 300
    network: str = "scale_free"          # scale_free | small_world | random
    avg_degree: int = 6                  # средняя степень узла (≈ 2m для Barabási–Albert)

    p_share: float = 0.18                # склонность обычного пользователя к репосту
    skeptic_fraction: float = 0.15
    influencer_fraction: float = 0.03

    bot_fraction: float = 0.0            # боты-усилители
    bot_placement: str = "random"        # random | hubs | periphery
    factcheck_fraction: float = 0.0      # боты-фактчекеры
    factcheck_placement: str = "random"  # random | hubs | periphery
    factcheck_delay: int = 3             # через сколько шагов включаются фактчекеры

    initial_spreaders: int = 1           # «нулевые пациенты» среди людей
    seed_placement: str = "random"       # random | hubs

    n_steps: int = 50
    seed: int = 42

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------- сеть и агенты

def build_network(sc: Scenario) -> nx.Graph:
    n, k, seed = sc.n_nodes, max(2, sc.avg_degree), sc.seed
    if sc.network == "scale_free":
        G = nx.barabasi_albert_graph(n, max(1, k // 2), seed=seed)
    elif sc.network == "small_world":
        G = nx.connected_watts_strogatz_graph(n, k if k % 2 == 0 else k + 1, 0.12, seed=seed)
    elif sc.network == "random":
        G = nx.gnm_random_graph(n, n * k // 2, seed=seed)
    else:
        raise ValueError(f"Неизвестный тип сети: {sc.network}")
    return G


def _pick(nodes_by_degree: list[int], pool: set[int], count: int, placement: str, rng: random.Random) -> list[int]:
    """Выбрать count узлов из pool: случайно, среди хабов или на периферии."""
    count = min(count, len(pool))
    if count <= 0:
        return []
    if placement == "random":
        return rng.sample(sorted(pool), count)
    ordered = nodes_by_degree if placement == "hubs" else list(reversed(nodes_by_degree))
    return [v for v in ordered if v in pool][:count]


def assign_agent_types(G: nx.Graph, sc: Scenario, rng: random.Random) -> dict[int, str]:
    total = sc.skeptic_fraction + sc.influencer_fraction + sc.bot_fraction + sc.factcheck_fraction
    if total > 1:
        raise ValueError("Сумма долей специальных агентов больше 100%")

    n = G.number_of_nodes()
    # Сортировка по степени; при равенстве — по номеру, чтобы результат был детерминирован.
    by_degree = [v for v, _ in sorted(G.degree, key=lambda item: (-item[1], item[0]))]
    agent_type = {v: AgentType.HUMAN for v in G.nodes()}
    free = set(G.nodes())

    def take(kind: str, fraction: float, placement: str, at_least_one: bool = False) -> None:
        count = int(round(n * fraction))
        if at_least_one and fraction > 0:
            count = max(1, count)
        for v in _pick(by_degree, free, count, placement, rng):
            agent_type[v] = kind
            free.discard(v)

    # Порядок важен: инфлюенсеры — это самые связные «люди»; если боты
    # размещаются в хабах, они захватывают хабы первыми.
    if sc.bot_placement == "hubs":
        take(AgentType.AMPLIFIER_BOT, sc.bot_fraction, "hubs", at_least_one=True)
        take(AgentType.INFLUENCER, sc.influencer_fraction, "hubs")
    else:
        take(AgentType.INFLUENCER, sc.influencer_fraction, "hubs")
        take(AgentType.AMPLIFIER_BOT, sc.bot_fraction, sc.bot_placement, at_least_one=True)
    take(AgentType.FACTCHECK_BOT, sc.factcheck_fraction, sc.factcheck_placement, at_least_one=True)
    take(AgentType.SKEPTIC, sc.skeptic_fraction, "random")
    return agent_type


def build_profiles(sc: Scenario) -> dict[str, dict]:
    prof = {k: dict(v) for k, v in BASE_PROFILE.items()}
    p = min(max(sc.p_share, 0.0), 1.0)
    prof[AgentType.HUMAN]["p_share"] = p
    prof[AgentType.INFLUENCER]["p_share"] = min(1.0, p * 1.4)
    prof[AgentType.SKEPTIC]["p_share"] = p * 0.15
    return prof


# ---------------------------------------------------------------- симуляция

@dataclass
class Simulation:
    sc: Scenario
    G: nx.Graph = field(init=False)
    agent_type: dict[int, str] = field(init=False)
    t: int = field(init=False, default=0)

    def __post_init__(self) -> None:
        self.rng = random.Random(self.sc.seed)
        self.G = build_network(self.sc)
        self.agent_type = assign_agent_types(self.G, self.sc, self.rng)
        self.profile = build_profiles(self.sc)

        n = self.G.number_of_nodes()
        self.adj = [list(self.G.neighbors(v)) for v in range(n)]
        self.is_bot = [self.agent_type[v] in AgentType.BOTS for v in range(n)]
        self.humans = [v for v in range(n) if not self.is_bot[v]]

        prof = [self.profile[self.agent_type[v]] for v in range(n)]
        self.p_exposure = [p["p_exposure"] for p in prof]
        self.p_share = [p["p_share"] for p in prof]
        self.p_verify = [p["p_verify"] for p in prof]
        self.lifetime = [p["lifetime"] for p in prof]

        self.message = [Opinion.NONE] * n
        self.active = [False] * n
        self.age = [0] * n
        self.ever_rumor = [False] * n       # когда-либо поверил слуху
        self.exposed = [False] * n          # когда-либо видел слух

        for v in range(n):
            kind = self.agent_type[v]
            if kind == AgentType.AMPLIFIER_BOT:
                self.message[v] = Opinion.RUMOR
                self.active[v] = True
            elif kind == AgentType.FACTCHECK_BOT:
                self.message[v] = Opinion.CORRECTION
                self.active[v] = self.sc.factcheck_delay <= 0

        # Нулевые пациенты — обычные люди/инфлюенсеры, которые запускают слух.
        candidates = {v for v in self.humans if self.agent_type[v] != AgentType.SKEPTIC}
        by_degree = [v for v, _ in sorted(self.G.degree, key=lambda item: (-item[1], item[0]))]
        for v in _pick(by_degree, candidates, self.sc.initial_spreaders, self.sc.seed_placement, self.rng):
            self._adopt_rumor(v)

        self.history: list[dict] = [self.metrics()]
        self.snapshots: list[list[int]] = [list(self.message)]
        self.active_snapshots: list[list[bool]] = [list(self.active)]
        self.exposed_snapshots: list[list[bool]] = [list(self.exposed)]

    # -- переходы
    def _adopt_rumor(self, v: int) -> None:
        self.message[v] = Opinion.RUMOR
        self.active[v] = True
        self.age[v] = 0
        self.ever_rumor[v] = True
        self.exposed[v] = True

    def _adopt_correction(self, v: int, spreads: bool) -> None:
        self.message[v] = Opinion.CORRECTION
        self.active[v] = spreads
        self.age[v] = 0

    def step(self) -> None:
        rng = self.rng
        n = len(self.adj)
        new_rumor = [False] * n
        new_corr = [False] * n       # приняли опровержение
        corr_spread = [False] * n    # и будут его публиковать

        if self.t + 1 == self.sc.factcheck_delay:
            for v in range(n):
                if self.agent_type[v] == AgentType.FACTCHECK_BOT:
                    self.active[v] = True

        senders = [v for v in range(n) if self.active[v]]
        for s in senders:
            msg = self.message[s]
            for r in self.adj[s]:
                if self.is_bot[r] or self.message[r] == Opinion.CORRECTION:
                    continue
                if rng.random() >= self.p_exposure[r]:
                    continue
                if msg == Opinion.CORRECTION:
                    # Опровержение интересно только тем, кто уже видел слух.
                    if not self.exposed[r]:
                        continue
                    new_corr[r] = True
                    if rng.random() < self.p_share[r] * CORRECTION_SHARE_FACTOR:
                        corr_spread[r] = True
                elif self.message[r] == Opinion.NONE:
                    self.exposed[r] = True
                    if rng.random() < self.p_verify[r]:
                        new_corr[r] = True
                        corr_spread[r] = True   # проверил и сам публикует опровержение
                    elif rng.random() < self.p_share[r]:
                        new_rumor[r] = True

        # Выгорание тех, кто был активен в начале шага.
        for s in senders:
            if self.is_bot[s]:
                continue
            self.age[s] += 1
            if self.age[s] >= self.lifetime[s]:
                self.active[s] = False

        # Одновременное применение: опровержение приоритетнее слуха.
        for v in range(n):
            if new_corr[v]:
                self._adopt_correction(v, corr_spread[v])
            elif new_rumor[v] and self.message[v] == Opinion.NONE:
                self._adopt_rumor(v)

        self.t += 1
        self.history.append(self.metrics())
        self.snapshots.append(list(self.message))
        self.active_snapshots.append(list(self.active))
        self.exposed_snapshots.append(list(self.exposed))

    def run(self) -> "Simulation":
        for _ in range(self.sc.n_steps):
            self.step()
            if not any(self.active):
                # Никто больше ничего не публикует — дальше ничего не изменится.
                for _ in range(self.sc.n_steps - self.t):
                    self.t += 1
                    self.history.append({**self.history[-1], "step": self.t})
                    self.snapshots.append(self.snapshots[-1])
                    self.active_snapshots.append(self.active_snapshots[-1])
                    self.exposed_snapshots.append(self.exposed_snapshots[-1])
                break
        return self

    # -- метрики
    def metrics(self) -> dict:
        h = self.humans
        total = max(1, len(h))
        rumor = sum(self.message[v] == Opinion.RUMOR for v in h)
        corr = sum(self.message[v] == Opinion.CORRECTION for v in h)
        return {
            "step": self.t,
            "unaware": sum(self.message[v] == Opinion.NONE and not self.exposed[v] for v in h),
            "rumor_believers": rumor,
            "correction": corr,
            "rumor_active": sum(self.message[v] == Opinion.RUMOR and self.active[v] for v in h),
            "correction_active": sum(self.message[v] == Opinion.CORRECTION and self.active[v] for v in h),
            "rumor_reach": sum(self.ever_rumor[v] for v in h),
            "exposed": sum(self.exposed[v] for v in h),
            "rumor_reach_frac": sum(self.ever_rumor[v] for v in h) / total,
            "correction_frac": corr / total,
        }

    def dataframe(self) -> pd.DataFrame:
        return pd.DataFrame(self.history)

    def summary(self) -> dict:
        df = self.dataframe()
        peak_idx = int(df["rumor_active"].idxmax())
        return {
            "humans": len(self.humans),
            "rumor_reach_frac": float(df["rumor_reach_frac"].iloc[-1]),
            "exposed_frac": float(df["exposed"].iloc[-1] / max(1, len(self.humans))),
            "final_rumor_frac": float(df["rumor_believers"].iloc[-1] / max(1, len(self.humans))),
            "final_correction_frac": float(df["correction_frac"].iloc[-1]),
            "peak_rumor_active": int(df["rumor_active"].max()),
            "time_to_peak": int(df["step"].iloc[peak_idx]),
        }


def run_scenario(sc: Scenario) -> Simulation:
    return Simulation(sc).run()
