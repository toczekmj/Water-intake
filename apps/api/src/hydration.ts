export type CaffeineHabituation = "regular" | "occasional" | "rare";

export type HydrationComputationInput = {
  volumeMl: number;
  defaultHydrationFactor: number;
  caffeineMgPer100ml: number | null;
  sodiumMgPer100ml: number;
  potassiumMgPer100ml: number;
  magnesiumMgPer100ml: number;
  useHydrationFactors: boolean;
  caffeineHabituation: CaffeineHabituation;
  dailyCaffeineBeforeMg: number;
};

export type HydrationComputationResult = {
  appliedHydrationFactor: number;
  appliedCaffeinePenaltyPct: number;
  creditedHydrationMl: number;
  caffeineMg: number;
  sodiumMg: number;
  potassiumMg: number;
  magnesiumMg: number;
};

const CAFFEINE_PENALTY_RULES: Record<CaffeineHabituation, Array<{ minDailyCaffeineMg: number; penaltyPct: number }>> = {
  regular: [
    { minDailyCaffeineMg: 400, penaltyPct: 10 }
  ],
  occasional: [
    { minDailyCaffeineMg: 200, penaltyPct: 10 },
    { minDailyCaffeineMg: 400, penaltyPct: 20 }
  ],
  rare: [
    { minDailyCaffeineMg: 100, penaltyPct: 15 },
    { minDailyCaffeineMg: 300, penaltyPct: 25 }
  ]
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals = 2) {
  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}

export function getCaffeinePenaltyPct(
  habituation: CaffeineHabituation,
  dailyCaffeineAfterEntryMg: number,
  entryCaffeineMg: number
) {
  if (entryCaffeineMg <= 0) {
    return 0;
  }
  let penalty = 0;
  for (const rule of CAFFEINE_PENALTY_RULES[habituation]) {
    if (dailyCaffeineAfterEntryMg >= rule.minDailyCaffeineMg) {
      penalty = rule.penaltyPct;
    }
  }
  return penalty;
}

export function computeHydrationForEntry(input: HydrationComputationInput): HydrationComputationResult {
  const appliedHydrationFactor = clamp(input.useHydrationFactors ? input.defaultHydrationFactor : 1, 0, 1.2);
  const baseHydrationMl = input.volumeMl * appliedHydrationFactor;
  const caffeineMg = Math.round(input.volumeMl * ((input.caffeineMgPer100ml ?? 0) / 100));
  const caffeineAfterEntryMg = input.dailyCaffeineBeforeMg + caffeineMg;
  const appliedCaffeinePenaltyPct = getCaffeinePenaltyPct(input.caffeineHabituation, caffeineAfterEntryMg, caffeineMg);
  const hydrationAfterPenalty = baseHydrationMl * (1 - appliedCaffeinePenaltyPct / 100);
  const creditedHydrationMl = Math.round(clamp(hydrationAfterPenalty, 0, input.volumeMl));

  return {
    appliedHydrationFactor: round(appliedHydrationFactor),
    appliedCaffeinePenaltyPct,
    creditedHydrationMl,
    caffeineMg,
    sodiumMg: Math.round(input.volumeMl * (input.sodiumMgPer100ml / 100)),
    potassiumMg: Math.round(input.volumeMl * (input.potassiumMgPer100ml / 100)),
    magnesiumMg: Math.round(input.volumeMl * (input.magnesiumMgPer100ml / 100))
  };
}
