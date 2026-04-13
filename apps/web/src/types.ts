export type Fluid = {
  id: number;
  name: string;
  color: string;
  default_hydration_factor: number;
  caffeine_mg_per_100ml: number | null;
  sodium_mg_per_100ml: number;
  potassium_mg_per_100ml: number;
  magnesium_mg_per_100ml: number;
  is_user_editable_factor: boolean;
};

export type HydrationMode = "standard" | "keto";
export type CaffeineHabituation = "regular" | "occasional" | "rare";

export type Settings = {
  daily_goal_ml: number;
  hydration_mode: HydrationMode;
  caffeine_habituation: CaffeineHabituation;
  use_hydration_factors: boolean;
  electrolyte_targets_enabled: boolean;
};

export type CupPreset = {
  id: number;
  name: string;
  volume_ml: number;
};

export type IntakeEntry = {
  id: string;
  fluid_id: number;
  fluid_name: string;
  fluid_color: string;
  volume_ml: number;
  occurred_at: string;
  applied_hydration_factor: number;
  applied_caffeine_penalty_pct: number;
  credited_hydration_ml: number;
  caffeine_mg: number;
  sodium_mg: number;
  potassium_mg: number;
  magnesium_mg: number;
};

export type BreakdownRow = {
  fluid_name: string;
  fluid_color: string;
  total_ml: number;
  credited_total_ml: number;
};

export type StatsResponse = {
  days: number;
  daily: { day: string; total_ml: number; credited_hydration_ml: number }[];
  composition: { fluid_name: string; total_ml: number; credited_hydration_ml: number }[];
  today: {
    total_ml: number;
    credited_hydration_ml: number;
    caffeine_mg: number;
    sodium_mg: number;
    potassium_mg: number;
    magnesium_mg: number;
    goal_ml: number;
    goal_progress_pct: number;
    hydration_mode: HydrationMode;
    caffeine_habituation: CaffeineHabituation;
    use_hydration_factors: boolean;
    electrolyte_targets_enabled: boolean;
    electrolyte_targets: {
      sodium_mg: { min: number; max: number };
      potassium_mg: { min: number; max: number };
      magnesium_mg: { min: number; max: number };
    };
  };
};
