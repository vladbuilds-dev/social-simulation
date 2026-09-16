// Уровни игры. scenario — параметры модели (см. sim.js), tools — сколько действий у игрока,
// stars — пороги доли поверивших слуху для 1, 2 и 3 звёзд (меньше — лучше).
export const LEVELS = [
  {
    id: "quiet",
    title: "Тихий квартал",
    brief: "Пара ботов пустила слух, что в городе закроют рынок. Жители пока спокойны.",
    tip: "Фактчекер на площади слышен дальше, чем в переулке.",
    scenario: { nNodes: 140, network: "scale_free", avgDegree: 6, pShare: 0.25, botFraction: 0.03, botPlacement: "random", nSteps: 40 },
    tools: { factchecker: 4, ban: 1 },
    stars: [0.2, 0.14, 0.09],
  },
  {
    id: "hubs",
    title: "Захват площадей",
    brief: "Боты заняли самые людные места города. Слух разойдётся быстро.",
    tip: "Сначала заглуши бота на самой большой площади.",
    scenario: { nNodes: 150, network: "scale_free", avgDegree: 6, pShare: 0.22, botFraction: 0.03, botPlacement: "hubs", nSteps: 40 },
    tools: { factchecker: 5, ban: 3 },
    stars: [0.2, 0.14, 0.1],
  },
  {
    id: "storm",
    title: "Шторм",
    brief: "Ботов много, а жители охотно репостят. Всех не спасти — удержи слух ниже 20%.",
    tip: "Действуй в первые часы: чем позже, тем меньше толку.",
    scenario: { nNodes: 170, network: "scale_free", avgDegree: 6, pShare: 0.3, botFraction: 0.07, botPlacement: "random", skepticFraction: 0.1, nSteps: 40 },
    tools: { factchecker: 6, ban: 3 },
    stars: [0.2, 0.15, 0.11],
  },
];
