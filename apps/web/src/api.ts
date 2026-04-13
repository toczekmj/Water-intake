import type { BreakdownRow, CupPreset, Fluid, IntakeEntry, Settings, StatsResponse } from "./types";

const baseUrl = import.meta.env.VITE_API_URL ?? "http://localhost:4000/api";
const token = import.meta.env.VITE_APP_TOKEN ?? "hydrateme-dev-token";
export const eventsUrl = `${baseUrl}/events?token=${encodeURIComponent(token)}`;

export class ApiRequestError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string) {
    super(body || `Request failed: ${status}`);
    this.name = "ApiRequestError";
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(init?.headers as Record<string, string> | undefined)
  };

  if (init?.body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers
  });

  if (!response.ok) {
    const body = await response.text();
    throw new ApiRequestError(response.status, body);
  }
  return (await response.json()) as T;
}

export const api = {
  getConfig: () =>
    request<{ userId: string; settings: Settings; fluids: Fluid[]; cups: CupPreset[] }>("/config"),
  saveSettings: (payload: {
    dailyGoalMl: number;
    hydrationMode: Settings["hydration_mode"];
    caffeineHabituation: Settings["caffeine_habituation"];
    useHydrationFactors: boolean;
    electrolyteTargetsEnabled: boolean;
  }) =>
    request<{ ok: boolean }>("/settings", {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  addFluid: (payload: {
    name: string;
    color: string;
    defaultHydrationFactor: number;
    caffeineMgPer100ml: number | null;
    sodiumMgPer100ml: number;
    potassiumMgPer100ml: number;
    magnesiumMgPer100ml: number;
    isUserEditableFactor: boolean;
  }) =>
    request<Fluid>("/fluids", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  updateFluid: (
    id: number,
    payload: {
      name: string;
      color: string;
      defaultHydrationFactor: number;
      caffeineMgPer100ml: number | null;
      sodiumMgPer100ml: number;
      potassiumMgPer100ml: number;
      magnesiumMgPer100ml: number;
      isUserEditableFactor: boolean;
    }
  ) =>
    request<{ ok: boolean }>(`/fluids/${id}`, {
      method: "PUT",
      body: JSON.stringify(payload)
    }),
  deleteFluid: (id: number) => request<{ ok: boolean }>(`/fluids/${id}`, { method: "DELETE" }),
  addCup: (name: string, volumeMl: number) =>
    request<CupPreset>("/cups", {
      method: "POST",
      body: JSON.stringify({ name, volumeMl })
    }),
  deleteCup: (id: number) => request<{ ok: boolean }>(`/cups/${id}`, { method: "DELETE" }),
  listIntakes: (date: string) => request<IntakeEntry[]>(`/intakes?date=${date}`),
  addIntake: (payload: {
    fluidId: number;
    volumeMl: number;
    occurredAt: string;
    clientEntryId: string;
  }) =>
    request<{ id: string }>("/intakes", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  deleteIntake: (id: string) => request<{ ok: boolean }>(`/intakes/${id}`, { method: "DELETE" }),
  getBreakdown: (date: string) => request<BreakdownRow[]>(`/daily-breakdown?date=${date}`),
  getStats: (days = 30) => request<StatsResponse>(`/stats?days=${days}`)
};
