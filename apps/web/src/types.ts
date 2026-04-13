export type Fluid = {
  id: number;
  name: string;
  color: string;
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
};

export type BreakdownRow = {
  fluid_name: string;
  fluid_color: string;
  total_ml: number;
};

export type StatsResponse = {
  days: number;
  daily: { day: string; total_ml: number }[];
  composition: { fluid_name: string; total_ml: number }[];
};
