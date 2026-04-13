import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiRequestError, api, eventsUrl } from "./api";
import { clearQueue, enqueueIntake, flushQueue, getQueueSize } from "./offlineQueue";
import type { BreakdownRow, CupPreset, Fluid, IntakeEntry, Settings, StatsResponse } from "./types";
import "./App.css";

type Tab = "today" | "stats" | "settings";
type ToastKind = "error" | "success" | "info";
type Toast = { id: number; message: string; kind: ToastKind };
type StatsWindowDays = 7 | 30 | 90 | 180;
type TourStep = { title: string; description: string; tab: Tab; selector: string };

const TOUR_STORAGE_KEY = "hydrateme-tour-completed";
const tourSteps: TourStep[] = [
  {
    title: "Today tab and quick logging",
    description:
      "Start here daily. Pick a drink and log your intake with one tap from cup presets.",
    tab: "today",
    selector: '[data-tour="tab-today"]'
  },
  {
    title: "Choose the drink for this entry",
    description: "Use this selector to switch between water, coffee, tea, and your custom drinks.",
    tab: "today",
    selector: '[data-tour="today-fluid-picker"]'
  },
  {
    title: "Log faster with preset buttons",
    description: "Cup buttons add hydration quickly without typing a volume each time.",
    tab: "today",
    selector: '[data-tour="today-cups"]'
  },
  {
    title: "Open Stats for long-term trends",
    description:
      "Use Stats to review previous days, spot consistency, and monitor your hydration pattern.",
    tab: "stats",
    selector: '[data-tour="tab-stats"]'
  },
  {
    title: "Filter your history range",
    description: "Switch between 7, 30, 90, and 180 day windows.",
    tab: "stats",
    selector: '[data-tour="stats-range"]'
  },
  {
    title: "Interactive history chart",
    description: "Hover chart points to inspect exact day totals and credited hydration values.",
    tab: "stats",
    selector: '[data-tour="stats-chart"]'
  },
  {
    title: "Personalize hydration behavior",
    description:
      "In Settings, adjust hydration factors, caffeine profile, and keto/electrolyte behavior.",
    tab: "settings",
    selector: '[data-tour="settings-core"]'
  },
  {
    title: "Customize your drinks",
    description:
      "Add and edit drinks here. Expand Advanced hydration data for caffeine and electrolyte values.",
    tab: "settings",
    selector: '[data-tour="settings-fluids"]'
  },
  {
    title: "Run this tour anytime",
    description:
      "Use this button whenever you want a guided refresher of the app.",
    tab: "settings",
    selector: '[data-tour="settings-retake-tour"]'
  }
];

const todayIso = () => new Date().toISOString().slice(0, 10);
const defaultSettings: Settings = {
  daily_goal_ml: 2000,
  hydration_mode: "standard",
  caffeine_habituation: "regular",
  use_hydration_factors: true,
  electrolyte_targets_enabled: false
};

const createClientId = () => {
  const maybeCrypto = globalThis.crypto;
  if (maybeCrypto?.randomUUID) {
    return maybeCrypto.randomUUID();
  }
  if (maybeCrypto?.getRandomValues) {
    const bytes = maybeCrypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
  }
  return `offline-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("today");
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [fluids, setFluids] = useState<Fluid[]>([]);
  const [cups, setCups] = useState<CupPreset[]>([]);
  const [selectedFluidId, setSelectedFluidId] = useState<number | null>(null);
  const [entries, setEntries] = useState<IntakeEntry[]>([]);
  const [breakdown, setBreakdown] = useState<BreakdownRow[]>([]);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [status, setStatus] = useState("Loading...");
  const [queueSize, setQueueSize] = useState(0);
  const [newFluid, setNewFluid] = useState({
    name: "",
    color: "#22c55e",
    default_hydration_factor: 1,
    caffeine_mg_per_100ml: "",
    sodium_mg_per_100ml: 0,
    potassium_mg_per_100ml: 0,
    magnesium_mg_per_100ml: 0
  });
  const [newCupName, setNewCupName] = useState("");
  const [newCupVolume, setNewCupVolume] = useState(250);
  const [refreshingStats, setRefreshingStats] = useState(false);
  const [statsWindowDays, setStatsWindowDays] = useState<StatsWindowDays>(30);
  const [hoveredHistoryDay, setHoveredHistoryDay] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [isTourOpen, setIsTourOpen] = useState(false);
  const [tourStepIndex, setTourStepIndex] = useState(0);
  const [tourTargetRect, setTourTargetRect] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);

  const currentTourStep = tourSteps[tourStepIndex];

  const totalTodayMl = useMemo(() => entries.reduce((acc, entry) => acc + entry.volume_ml, 0), [entries]);
  const creditedTodayMl = useMemo(() => entries.reduce((acc, entry) => acc + entry.credited_hydration_ml, 0), [entries]);
  const caffeineTodayMg = stats?.today.caffeine_mg ?? entries.reduce((acc, entry) => acc + entry.caffeine_mg, 0);
  const sodiumTodayMg = stats?.today.sodium_mg ?? entries.reduce((acc, entry) => acc + entry.sodium_mg, 0);
  const potassiumTodayMg = stats?.today.potassium_mg ?? entries.reduce((acc, entry) => acc + entry.potassium_mg, 0);
  const magnesiumTodayMg = stats?.today.magnesium_mg ?? entries.reduce((acc, entry) => acc + entry.magnesium_mg, 0);
  const progressPercent = Math.min(100, Math.round((creditedTodayMl / settings.daily_goal_ml) * 100));
  const dailyHistory = useMemo(
    () => (stats?.daily ?? []).slice().sort((a, b) => a.day.localeCompare(b.day)),
    [stats]
  );
  const latestDaysFirstHistory = useMemo(() => [...dailyHistory].reverse(), [dailyHistory]);
  const maxDailyChartMl = useMemo(
    () =>
      Math.max(
        1000,
        ...dailyHistory.map((day) => Math.max(day.total_ml, day.credited_hydration_ml))
      ),
    [dailyHistory]
  );

  const chartData = useMemo(() => {
    const width = 680;
    const height = 240;
    const paddingX = 34;
    const paddingY = 20;
    const plotWidth = width - paddingX * 2;
    const plotHeight = height - paddingY * 2;
    const pointCount = Math.max(1, dailyHistory.length - 1);
    const toY = (value: number) => height - paddingY - (value / maxDailyChartMl) * plotHeight;

    return {
      width,
      height,
      points: dailyHistory.map((day, index) => ({
        day: day.day,
        total_ml: day.total_ml,
        credited_hydration_ml: day.credited_hydration_ml,
        x: paddingX + (index / pointCount) * plotWidth,
        yTotal: toY(day.total_ml),
        yCredited: toY(day.credited_hydration_ml)
      }))
    };
  }, [dailyHistory, maxDailyChartMl]);

  const selectedHistoryDay =
    dailyHistory.find((day) => day.day === hoveredHistoryDay) ??
    dailyHistory[dailyHistory.length - 1] ??
    null;

  const avgCreditedMl = useMemo(() => {
    if (!dailyHistory.length) {
      return 0;
    }
    return Math.round(
      dailyHistory.reduce((acc, day) => acc + day.credited_hydration_ml, 0) / dailyHistory.length
    );
  }, [dailyHistory]);

  const bestDay = useMemo(() => {
    if (!dailyHistory.length) {
      return null;
    }
    return dailyHistory.reduce((best, day) =>
      day.credited_hydration_ml > best.credited_hydration_ml ? day : best
    );
  }, [dailyHistory]);

  const activeDaysCount = useMemo(
    () => dailyHistory.filter((day) => day.total_ml > 0).length,
    [dailyHistory]
  );

  function getErrorMessage(error: unknown, fallback: string) {
    if (error instanceof ApiRequestError) {
      try {
        const parsed = JSON.parse(error.body) as { error?: string; message?: string };
        return parsed.error ?? parsed.message ?? fallback;
      } catch {
        return error.body || fallback;
      }
    }
    if (error instanceof Error) {
      return error.message || fallback;
    }
    return fallback;
  }

  function pushToast(message: string, kind: ToastKind = "error") {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((old) => [...old, { id, message, kind }]);
    window.setTimeout(() => {
      setToasts((old) => old.filter((toast) => toast.id !== id));
    }, 3800);
  }

  function progressToTarget(value: number, target: number) {
    if (target <= 0) {
      return 0;
    }
    return Math.min(100, Math.round((value / target) * 100));
  }

  const refreshQueueStatus = useCallback(async () => {
    setQueueSize(await getQueueSize());
  }, []);

  const loadConfigAndToday = useCallback(async () => {
    const config = await api.getConfig();
    const lastUserId = localStorage.getItem("hydrateme-user-id");
    if (lastUserId && lastUserId !== config.userId) {
      await clearQueue();
      localStorage.removeItem("hydrateme-cache");
      setStatus("Detected reset. Cleared stale offline data.");
    }
    localStorage.setItem("hydrateme-user-id", config.userId);

    const [dayEntries, dayBreakdown, statsData] = await Promise.all([
      api.listIntakes(todayIso()),
      api.getBreakdown(todayIso()),
      api.getStats(statsWindowDays)
    ]);
    setSettings(config.settings);
    setFluids(config.fluids);
    setCups(config.cups);
    setSelectedFluidId((old) => {
      if (old && config.fluids.some((fluid) => fluid.id === old)) {
        return old;
      }
      return config.fluids[0]?.id ?? null;
    });
    setEntries(dayEntries);
    setBreakdown(dayBreakdown);
    setStats(statsData);
    localStorage.setItem("hydrateme-cache", JSON.stringify({ config, dayEntries, dayBreakdown, statsData }));
  }, [statsWindowDays]);

  useEffect(() => {
    const bootstrap = async () => {
      try {
        await flushQueue();
        await loadConfigAndToday();
        await refreshQueueStatus();
        setStatus(navigator.onLine ? "Synced" : "Offline mode");
      } catch {
        pushToast("Could not reach server, showing cached data.", "info");
        const cache = localStorage.getItem("hydrateme-cache");
        if (cache) {
          const parsed = JSON.parse(cache) as {
            config: { userId: string; settings: Settings; fluids: Fluid[]; cups: CupPreset[] };
            dayEntries: IntakeEntry[];
            dayBreakdown: BreakdownRow[];
            statsData: StatsResponse;
          };
          setSettings(parsed.config.settings);
          setFluids(parsed.config.fluids);
          setCups(parsed.config.cups);
          setEntries(parsed.dayEntries);
          setBreakdown(parsed.dayBreakdown);
          setStats(parsed.statsData);
          setSelectedFluidId(parsed.config.fluids[0]?.id ?? null);
          setStatus("Offline (cached data)");
        } else {
          setStatus("Could not load data");
        }
      }
    };
    void bootstrap();
  }, [refreshQueueStatus, loadConfigAndToday]);

  useEffect(() => {
    const hasCompletedTour = localStorage.getItem(TOUR_STORAGE_KEY) === "true";
    if (!hasCompletedTour) {
      setTourStepIndex(0);
      setActiveTab(tourSteps[0].tab);
      setIsTourOpen(true);
    }
  }, []);

  useEffect(() => {
    if (!isTourOpen) {
      setTourTargetRect(null);
      return;
    }

    const updateTargetRect = () => {
      const element = document.querySelector(currentTourStep.selector) as HTMLElement | null;
      if (!element) {
        setTourTargetRect(null);
        return;
      }
      const rect = element.getBoundingClientRect();
      setTourTargetRect({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height
      });
    };

    const timer = window.setTimeout(() => {
      const target = document.querySelector(currentTourStep.selector) as HTMLElement | null;
      target?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      updateTargetRect();
    }, 120);

    window.addEventListener("resize", updateTargetRect);
    window.addEventListener("scroll", updateTargetRect, true);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", updateTargetRect);
      window.removeEventListener("scroll", updateTargetRect, true);
    };
  }, [isTourOpen, currentTourStep]);

  useEffect(() => {
    const onlineHandler = async () => {
      try {
        await flushQueue();
        await loadConfigAndToday();
        setStatus("Back online and synced");
      } catch {
        setStatus("Online, sync pending");
      }
      await refreshQueueStatus();
    };
    window.addEventListener("online", onlineHandler);
    return () => window.removeEventListener("online", onlineHandler);
  }, [refreshQueueStatus, loadConfigAndToday]);

  const refreshTodayPanels = useCallback(async () => {
    const [dayEntries, dayBreakdown, statsData] = await Promise.all([
      api.listIntakes(todayIso()),
      api.getBreakdown(todayIso()),
      api.getStats(statsWindowDays)
    ]);
    setEntries(dayEntries);
    setBreakdown(dayBreakdown);
    setStats(statsData);
  }, [statsWindowDays]);

  useEffect(() => {
    if (!navigator.onLine) {
      return;
    }
    const refreshStatsWindow = async () => {
      try {
        const statsData = await api.getStats(statsWindowDays);
        setStats(statsData);
      } catch {
        // Keep existing stats if refresh fails.
      }
    };
    void refreshStatsWindow();
  }, [statsWindowDays]);

  const refreshLiveData = useCallback(async () => {
    if (!navigator.onLine) {
      return;
    }
    try {
      await flushQueue();
      await refreshTodayPanels();
      await refreshQueueStatus();
      setStatus("Synced");
    } catch {
      setStatus("Sync check failed");
    }
  }, [refreshQueueStatus, refreshTodayPanels]);

  async function addIntake(volumeMl: number) {
    if (!selectedFluidId) {
      setStatus("Pick a fluid first");
      return;
    }
    if (fluids.length === 0) {
      setStatus("Add a fluid in Settings first");
      return;
    }
    if (!fluids.some((fluid) => fluid.id === selectedFluidId)) {
      setStatus("Selected fluid is outdated. Pick fluid again.");
      setSelectedFluidId(fluids[0]?.id ?? null);
      return;
    }
    const operationId = createClientId();
    const payload = {
      fluidId: selectedFluidId,
      volumeMl,
      occurredAt: new Date().toISOString(),
      clientEntryId: operationId
    };
    try {
      await api.addIntake(payload);
      await refreshTodayPanels();
      setStatus("Intake saved");
    } catch (error) {
      if (error instanceof ApiRequestError) {
        if (error.body.includes("23503") || error.body.includes("Selected fluid does not exist")) {
          await loadConfigAndToday();
          setStatus("Selected fluid is invalid. Choose a fluid and try again.");
          pushToast("Selected fluid is invalid. Choose a fluid and try again.");
        } else {
          setStatus("Could not save intake");
          pushToast(getErrorMessage(error, "Could not save intake"));
        }
      } else {
        await enqueueIntake({
          id: operationId,
          fluidId: payload.fluidId,
          volumeMl: payload.volumeMl,
          occurredAt: payload.occurredAt
        });
        setStatus("Saved offline, sync pending");
        pushToast("Saved offline. It will sync when back online.", "info");
      }
    }
    await refreshQueueStatus();
  }

  async function deleteEntry(id: string) {
    try {
      await api.deleteIntake(id);
      await refreshTodayPanels();
      pushToast("Entry deleted.", "success");
    } catch (error) {
      pushToast(getErrorMessage(error, "Could not delete entry"));
    }
  }

  async function saveGoal() {
    try {
      await api.saveSettings({
        dailyGoalMl: settings.daily_goal_ml,
        hydrationMode: settings.hydration_mode,
        caffeineHabituation: settings.caffeine_habituation,
        useHydrationFactors: settings.use_hydration_factors,
        electrolyteTargetsEnabled: settings.electrolyte_targets_enabled
      });
      setStatus("Settings updated");
      pushToast("Settings updated.", "success");
      await refreshTodayPanels();
    } catch (error) {
      pushToast(getErrorMessage(error, "Could not update settings"));
    }
  }

  async function createFluid() {
    if (!newFluid.name.trim()) {
      return;
    }
    try {
      const fluid = await api.addFluid({
        name: newFluid.name.trim(),
        color: newFluid.color,
        defaultHydrationFactor: Number(newFluid.default_hydration_factor),
        caffeineMgPer100ml: newFluid.caffeine_mg_per_100ml === "" ? null : Number(newFluid.caffeine_mg_per_100ml),
        sodiumMgPer100ml: Number(newFluid.sodium_mg_per_100ml),
        potassiumMgPer100ml: Number(newFluid.potassium_mg_per_100ml),
        magnesiumMgPer100ml: Number(newFluid.magnesium_mg_per_100ml),
        isUserEditableFactor: true
      });
      setFluids((old) => [...old, fluid]);
      setNewFluid({
        name: "",
        color: "#22c55e",
        default_hydration_factor: 1,
        caffeine_mg_per_100ml: "",
        sodium_mg_per_100ml: 0,
        potassium_mg_per_100ml: 0,
        magnesium_mg_per_100ml: 0
      });
      pushToast("Fluid added.", "success");
    } catch (error) {
      pushToast(getErrorMessage(error, "Could not add fluid"));
    }
  }

  async function saveFluid(fluid: Fluid) {
    try {
      await api.updateFluid(fluid.id, {
        name: fluid.name,
        color: fluid.color,
        defaultHydrationFactor: fluid.default_hydration_factor,
        caffeineMgPer100ml: fluid.caffeine_mg_per_100ml,
        sodiumMgPer100ml: fluid.sodium_mg_per_100ml,
        potassiumMgPer100ml: fluid.potassium_mg_per_100ml,
        magnesiumMgPer100ml: fluid.magnesium_mg_per_100ml,
        isUserEditableFactor: fluid.is_user_editable_factor
      });
      pushToast("Fluid updated.", "success");
      await refreshTodayPanels();
    } catch (error) {
      pushToast(getErrorMessage(error, "Could not update fluid"));
    }
  }

  async function removeFluid(id: number) {
    try {
      await api.deleteFluid(id);
      setFluids((old) => {
        const next = old.filter((f) => f.id !== id);
        setSelectedFluidId((current) => {
          if (current && next.some((fluid) => fluid.id === current)) {
            return current;
          }
          return next[0]?.id ?? null;
        });
        return next;
      });
      pushToast("Fluid deleted.", "success");
    } catch (error) {
      pushToast(getErrorMessage(error, "Could not delete fluid"));
    }
  }

  async function createCup() {
    if (!newCupName.trim()) return;
    try {
      const cup = await api.addCup(newCupName.trim(), newCupVolume);
      setCups((old) => [...old, cup].sort((a, b) => a.volume_ml - b.volume_ml));
      setNewCupName("");
      pushToast("Cup preset added.", "success");
    } catch (error) {
      pushToast(getErrorMessage(error, "Could not add cup preset"));
    }
  }

  async function removeCup(id: number) {
    try {
      await api.deleteCup(id);
      setCups((old) => old.filter((c) => c.id !== id));
      pushToast("Cup preset deleted.", "success");
    } catch (error) {
      pushToast(getErrorMessage(error, "Could not delete cup preset"));
    }
  }

  async function forceRefreshStats() {
    setRefreshingStats(true);
    try {
      await refreshLiveData();
      setStatus("Stats refreshed");
    } catch {
      setStatus("Could not refresh stats");
    } finally {
      setRefreshingStats(false);
    }
  }

  function startTour() {
    setTourStepIndex(0);
    setActiveTab(tourSteps[0].tab);
    setIsTourOpen(true);
  }

  function closeTour(markCompleted: boolean) {
    if (markCompleted) {
      localStorage.setItem(TOUR_STORAGE_KEY, "true");
    }
    setIsTourOpen(false);
  }

  function goToTourStep(index: number) {
    const clamped = Math.max(0, Math.min(tourSteps.length - 1, index));
    setTourStepIndex(clamped);
    setActiveTab(tourSteps[clamped].tab);
  }

  function nextTourStep() {
    if (tourStepIndex >= tourSteps.length - 1) {
      closeTour(true);
      return;
    }
    goToTourStep(tourStepIndex + 1);
  }

  const tourSpotlightStyle = useMemo(() => {
    if (!tourTargetRect) {
      return undefined;
    }
    const padding = 8;
    return {
      top: Math.max(0, tourTargetRect.top - padding),
      left: Math.max(0, tourTargetRect.left - padding),
      width: tourTargetRect.width + padding * 2,
      height: tourTargetRect.height + padding * 2
    };
  }, [tourTargetRect]);

  const tourCardStyle = useMemo(() => {
    if (typeof window === "undefined") {
      return undefined;
    }
    const cardWidth = Math.min(460, window.innerWidth - 24);
    if (!tourTargetRect) {
      return { width: `${cardWidth}px`, top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
    }
    const preferredLeft = Math.max(12, Math.min(tourTargetRect.left, window.innerWidth - cardWidth - 12));
    const spaceBelow = window.innerHeight - tourTargetRect.top - tourTargetRect.height;
    const top = spaceBelow > 260 ? tourTargetRect.top + tourTargetRect.height + 16 : Math.max(12, tourTargetRect.top - 240);
    return { width: `${cardWidth}px`, left: `${preferredLeft}px`, top: `${top}px` };
  }, [tourTargetRect]);

  useEffect(() => {
    if (!("EventSource" in window)) {
      return;
    }

    const stream = new EventSource(eventsUrl);
    stream.onopen = () => {
      setSseConnected(true);
      setStatus("Live sync connected");
    };
    stream.onerror = () => {
      setSseConnected(false);
      setStatus("Live sync disconnected");
    };
    stream.addEventListener("hydrate-update", () => {
      void refreshLiveData();
    });

    return () => {
      stream.close();
      setSseConnected(false);
    };
  }, [refreshLiveData]);

  useEffect(() => {
    if (activeTab === "settings" || sseConnected) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshLiveData();
      }
    }, 15000);

    const onFocus = () => {
      void refreshLiveData();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
    };
  }, [activeTab, sseConnected, refreshLiveData]);

  return (
    <main className="app">
      <section className="card">
        <div className="header">
          <div>
            <h1 className="title">HydrateMe</h1>
            <div className="muted">{status}</div>
          </div>
          <span className="pill">Queued: {queueSize}</span>
        </div>
      </section>

      {activeTab === "today" && (
        <>
          <section className="card">
            <div className="row" data-tour="today-fluid-picker">
              <select
                value={selectedFluidId ?? ""}
                onChange={(event) => setSelectedFluidId(Number(event.target.value))}
              >
                {fluids.length === 0 && <option value="">No fluids configured</option>}
                {fluids.map((fluid) => (
                  <option key={fluid.id} value={fluid.id}>
                    {fluid.name}
                  </option>
                ))}
              </select>
              <span className="pill">Caffeine: {caffeineTodayMg} mg</span>
            </div>

            <h3>Total fluid: {totalTodayMl}ml</h3>
            <h3>
              Hydration credited: {creditedTodayMl}ml / {settings.daily_goal_ml}ml
            </h3>
            <div className="progressWrap">
              <div className="progressFill" style={{ width: `${progressPercent}%` }} />
            </div>

            <div className="row" data-tour="today-cups">
              {cups.map((cup) => (
                <button
                  className="primary"
                  key={cup.id}
                  onClick={() => addIntake(cup.volume_ml)}
                  disabled={!selectedFluidId || fluids.length === 0}
                >
                  +{cup.volume_ml}ml
                </button>
              ))}
            </div>
          </section>

          {settings.hydration_mode === "keto" && (
            <section className="card">
              <h3>Keto electrolytes</h3>
              <div className="list">
                <div className="listItem">
                  <span>Sodium</span>
                  <strong>
                    {sodiumTodayMg}mg / {stats?.today.electrolyte_targets.sodium_mg.min ?? 3000}mg
                  </strong>
                </div>
                <div className="progressWrap">
                  <div
                    className="progressFill"
                    style={{ width: `${progressToTarget(sodiumTodayMg, stats?.today.electrolyte_targets.sodium_mg.min ?? 3000)}%` }}
                  />
                </div>
                <div className="listItem">
                  <span>Potassium</span>
                  <strong>
                    {potassiumTodayMg}mg / {stats?.today.electrolyte_targets.potassium_mg.min ?? 3000}mg
                  </strong>
                </div>
                <div className="progressWrap">
                  <div
                    className="progressFill"
                    style={{
                      width: `${progressToTarget(potassiumTodayMg, stats?.today.electrolyte_targets.potassium_mg.min ?? 3000)}%`
                    }}
                  />
                </div>
                <div className="listItem">
                  <span>Magnesium</span>
                  <strong>
                    {magnesiumTodayMg}mg / {stats?.today.electrolyte_targets.magnesium_mg.min ?? 300}mg
                  </strong>
                </div>
                <div className="progressWrap">
                  <div
                    className="progressFill"
                    style={{
                      width: `${progressToTarget(magnesiumTodayMg, stats?.today.electrolyte_targets.magnesium_mg.min ?? 300)}%`
                    }}
                  />
                </div>
              </div>
            </section>
          )}

          <section className="card">
            <h3>Daily breakdown</h3>
            <div className="list">
              {breakdown.map((row) => (
                <div className="listItem" key={row.fluid_name}>
                  <span>
                    <span className="dot" style={{ background: row.fluid_color, marginRight: 8 }} />
                    {row.fluid_name}
                  </span>
                  <strong>
                    {row.total_ml}ml ({row.credited_total_ml}ml credited)
                  </strong>
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <h3>Entries</h3>
            <div className="list">
              {entries.map((entry) => (
                <div className="listItem" key={entry.id}>
                  <span>
                    {entry.fluid_name} - {entry.volume_ml}ml ({entry.credited_hydration_ml}ml credited)
                  </span>
                  <button onClick={() => deleteEntry(entry.id)}>Delete</button>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {activeTab === "stats" && (
        <section className="card">
          <div className="statsToolbar">
            <div className="statsRangePills" data-tour="stats-range">
              {([7, 30, 90, 180] as const).map((days) => (
                <button
                  key={days}
                  className={statsWindowDays === days ? "active" : ""}
                  onClick={() => setStatsWindowDays(days)}
                >
                  {days}d
                </button>
              ))}
            </div>
            <button className="primary" onClick={forceRefreshStats} disabled={refreshingStats}>
              {refreshingStats ? "Refreshing..." : "Force refresh stats"}
            </button>
          </div>
          <h3>History ({statsWindowDays} days)</h3>

          <div className="statsCards">
            <div className="statsCard">
              <div className="muted">Average credited/day</div>
              <strong>{avgCreditedMl} ml</strong>
            </div>
            <div className="statsCard">
              <div className="muted">Active logging days</div>
              <strong>
                {activeDaysCount} / {statsWindowDays}
              </strong>
            </div>
            <div className="statsCard">
              <div className="muted">Best day</div>
              <strong>
                {bestDay ? `${bestDay.day} (${bestDay.credited_hydration_ml} ml)` : "-"}
              </strong>
            </div>
          </div>

          <div className="chartWrap" data-tour="stats-chart">
            <svg viewBox={`0 0 ${chartData.width} ${chartData.height}`} className="historyChart" role="img">
              <line x1="34" y1="220" x2="646" y2="220" stroke="#cbd5e1" strokeWidth="1" />
              <line x1="34" y1="20" x2="34" y2="220" stroke="#cbd5e1" strokeWidth="1" />
              <line x1="34" y1="120" x2="646" y2="120" stroke="#e2e8f0" strokeDasharray="4 4" />

              <polyline
                fill="none"
                stroke="#0ea5e9"
                strokeWidth="3"
                points={chartData.points.map((point) => `${point.x},${point.yTotal}`).join(" ")}
              />
              <polyline
                fill="none"
                stroke="#6366f1"
                strokeWidth="3"
                points={chartData.points.map((point) => `${point.x},${point.yCredited}`).join(" ")}
              />

              {chartData.points.map((point) => (
                <g key={point.day}>
                  <circle
                    cx={point.x}
                    cy={point.yTotal}
                    r={hoveredHistoryDay === point.day ? 5 : 3.5}
                    fill="#0284c7"
                    onMouseEnter={() => setHoveredHistoryDay(point.day)}
                  />
                  <circle
                    cx={point.x}
                    cy={point.yCredited}
                    r={hoveredHistoryDay === point.day ? 5 : 3.5}
                    fill="#4338ca"
                    onMouseEnter={() => setHoveredHistoryDay(point.day)}
                  />
                </g>
              ))}
            </svg>
            <div className="chartLegend">
              <span><span className="chartDot chartDotTotal" />Total fluid</span>
              <span><span className="chartDot chartDotCredited" />Hydration credited</span>
            </div>
            {selectedHistoryDay && (
              <div className="chartHint">
                <strong>{selectedHistoryDay.day}</strong>: {selectedHistoryDay.total_ml}ml total /{" "}
                {selectedHistoryDay.credited_hydration_ml}ml credited
              </div>
            )}
          </div>

          <h3>Previous days</h3>
          <div className="list">
            {latestDaysFirstHistory.map((d) => (
              <button
                key={d.day}
                className={`historyRowButton ${hoveredHistoryDay === d.day ? "active" : ""}`}
                onMouseEnter={() => setHoveredHistoryDay(d.day)}
                onFocus={() => setHoveredHistoryDay(d.day)}
              >
                <span>{d.day}</span>
                <strong>{d.total_ml}ml / {d.credited_hydration_ml}ml</strong>
              </button>
            ))}
          </div>

          <h3>Fluid composition</h3>
          <div className="list">
            {stats?.composition.map((d) => (
              <div key={d.fluid_name} className="listItem">
                <div style={{ width: "100%" }}>
                  <div className="listItem" style={{ border: "none", padding: 0 }}>
                    <span>{d.fluid_name}</span>
                    <strong>
                      {d.total_ml}ml ({d.credited_hydration_ml} credited)
                    </strong>
                  </div>
                  <div className="progressWrap" style={{ marginBottom: 0 }}>
                    <div
                      className="progressFill"
                      style={{
                        width: `${Math.min(
                          100,
                          Math.round(
                            (d.credited_hydration_ml /
                              Math.max(...(stats?.composition.map((x) => x.credited_hydration_ml) ?? [1]))) *
                              100
                          )
                        )}%`
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {activeTab === "settings" && (
        <>
          <section className="card" data-tour="settings-core">
            <h3>Hydration settings</h3>
            <div className="settingsGrid">
              <div className="settingsField">
                <label className="muted" htmlFor="daily-goal-input">Daily goal (ml)</label>
                <input
                  id="daily-goal-input"
                  type="number"
                  value={settings.daily_goal_ml}
                  onChange={(event) =>
                    setSettings((old) => ({ ...old, daily_goal_ml: Number(event.target.value) }))
                  }
                />
              </div>
              <div className="settingsField">
                <label className="muted" htmlFor="caffeine-profile-select">Caffeine profile</label>
                <select
                  id="caffeine-profile-select"
                  value={settings.caffeine_habituation}
                  onChange={(event) =>
                    setSettings((old) => ({
                      ...old,
                      caffeine_habituation: event.target.value as Settings["caffeine_habituation"]
                    }))
                  }
                >
                  <option value="regular">Regular caffeine user</option>
                  <option value="occasional">Occasional caffeine user</option>
                  <option value="rare">Rare caffeine user</option>
                </select>
              </div>
              <label className="switchRow">
                <span>Use drink hydration factors</span>
                <input
                  type="checkbox"
                  checked={settings.use_hydration_factors}
                  onChange={(event) =>
                    setSettings((old) => ({ ...old, use_hydration_factors: event.target.checked }))
                  }
                />
              </label>
              <label className="switchRow">
                <span>Keto mode</span>
                <input
                  type="checkbox"
                  checked={settings.hydration_mode === "keto"}
                  onChange={(event) =>
                    setSettings((old) => ({
                      ...old,
                      hydration_mode: event.target.checked ? "keto" : "standard",
                      electrolyte_targets_enabled: event.target.checked ? true : old.electrolyte_targets_enabled
                    }))
                  }
                />
              </label>
              <label className="switchRow">
                <span>Electrolyte targets</span>
                <input
                  type="checkbox"
                  checked={settings.electrolyte_targets_enabled}
                  onChange={(event) =>
                    setSettings((old) => ({ ...old, electrolyte_targets_enabled: event.target.checked }))
                  }
                />
              </label>
            </div>
            <button className="primary" onClick={saveGoal}>
              Save settings
            </button>
          </section>

          <section className="card" data-tour="settings-fluids">
            <h3>Fluids</h3>
            <div className="fluidEditorCard">
              <div className="row">
                <label className="fieldLabel">
                  <span className="muted">Fluid name</span>
                  <input
                    placeholder="Fluid name"
                    value={newFluid.name}
                    onChange={(event) => setNewFluid((old) => ({ ...old, name: event.target.value }))}
                  />
                </label>
                <label className="fieldLabel fieldLabelColor">
                  <span className="muted">Color</span>
                  <input
                    type="color"
                    value={newFluid.color}
                    onChange={(event) => setNewFluid((old) => ({ ...old, color: event.target.value }))}
                  />
                </label>
              </div>
              <details className="fluidAdvancedDetails">
                <summary>Advanced hydration data</summary>
                <div className="fluidAdvancedGrid">
                  <label className="fieldLabel">
                    <span className="muted">Hydration factor</span>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1.2"
                      value={newFluid.default_hydration_factor}
                      onChange={(event) =>
                        setNewFluid((old) => ({ ...old, default_hydration_factor: Number(event.target.value) }))
                      }
                    />
                  </label>
                  <label className="fieldLabel">
                    <span className="muted">Caffeine (mg/100ml)</span>
                    <input
                      type="number"
                      min="0"
                      value={newFluid.caffeine_mg_per_100ml}
                      onChange={(event) =>
                        setNewFluid((old) => ({ ...old, caffeine_mg_per_100ml: event.target.value }))
                      }
                    />
                  </label>
                  <label className="fieldLabel">
                    <span className="muted">Sodium (mg/100ml)</span>
                    <input
                      type="number"
                      min="0"
                      value={newFluid.sodium_mg_per_100ml}
                      onChange={(event) =>
                        setNewFluid((old) => ({ ...old, sodium_mg_per_100ml: Number(event.target.value) }))
                      }
                    />
                  </label>
                  <label className="fieldLabel">
                    <span className="muted">Potassium (mg/100ml)</span>
                    <input
                      type="number"
                      min="0"
                      value={newFluid.potassium_mg_per_100ml}
                      onChange={(event) =>
                        setNewFluid((old) => ({ ...old, potassium_mg_per_100ml: Number(event.target.value) }))
                      }
                    />
                  </label>
                  <label className="fieldLabel">
                    <span className="muted">Magnesium (mg/100ml)</span>
                    <input
                      type="number"
                      min="0"
                      value={newFluid.magnesium_mg_per_100ml}
                      onChange={(event) =>
                        setNewFluid((old) => ({ ...old, magnesium_mg_per_100ml: Number(event.target.value) }))
                      }
                    />
                  </label>
                </div>
              </details>
              <div className="row">
                <button className="primary" onClick={createFluid}>
                  Add fluid
                </button>
              </div>
            </div>
            <div className="list">
              {fluids.map((fluid) => (
                <div className="listItem fluidListItem" key={fluid.id}>
                  <div className="fluidHeaderRow">
                    <label className="fieldLabel">
                      <span className="muted">Fluid name</span>
                      <input
                        value={fluid.name}
                        onChange={(event) =>
                          setFluids((old) =>
                            old.map((item) => (item.id === fluid.id ? { ...item, name: event.target.value } : item))
                          )
                        }
                      />
                    </label>
                    <label className="fieldLabel fieldLabelColor">
                      <span className="muted">Color</span>
                      <input
                        type="color"
                        value={fluid.color}
                        onChange={(event) =>
                          setFluids((old) =>
                            old.map((item) => (item.id === fluid.id ? { ...item, color: event.target.value } : item))
                          )
                        }
                      />
                    </label>
                    <div className="fluidActions">
                      <button className="primary" onClick={() => saveFluid(fluid)}>
                        Save
                      </button>
                      <button onClick={() => removeFluid(fluid.id)}>Delete</button>
                    </div>
                  </div>
                  <details className="fluidAdvancedDetails">
                    <summary>Advanced hydration data</summary>
                    <div className="fluidAdvancedGrid">
                      <label className="fieldLabel">
                        <span className="muted">Hydration factor</span>
                        <input
                          type="number"
                          step="0.05"
                          min="0"
                          max="1.2"
                          value={fluid.default_hydration_factor}
                          onChange={(event) =>
                            setFluids((old) =>
                              old.map((item) =>
                                item.id === fluid.id ? { ...item, default_hydration_factor: Number(event.target.value) } : item
                              )
                            )
                          }
                        />
                      </label>
                      <label className="fieldLabel">
                        <span className="muted">Caffeine (mg/100ml)</span>
                        <input
                          type="number"
                          min="0"
                          value={fluid.caffeine_mg_per_100ml ?? ""}
                          onChange={(event) =>
                            setFluids((old) =>
                              old.map((item) =>
                                item.id === fluid.id
                                  ? { ...item, caffeine_mg_per_100ml: event.target.value === "" ? null : Number(event.target.value) }
                                  : item
                              )
                            )
                          }
                        />
                      </label>
                      <label className="fieldLabel">
                        <span className="muted">Sodium (mg/100ml)</span>
                        <input
                          type="number"
                          min="0"
                          value={fluid.sodium_mg_per_100ml}
                          onChange={(event) =>
                            setFluids((old) =>
                              old.map((item) =>
                                item.id === fluid.id ? { ...item, sodium_mg_per_100ml: Number(event.target.value) } : item
                              )
                            )
                          }
                        />
                      </label>
                      <label className="fieldLabel">
                        <span className="muted">Potassium (mg/100ml)</span>
                        <input
                          type="number"
                          min="0"
                          value={fluid.potassium_mg_per_100ml}
                          onChange={(event) =>
                            setFluids((old) =>
                              old.map((item) =>
                                item.id === fluid.id ? { ...item, potassium_mg_per_100ml: Number(event.target.value) } : item
                              )
                            )
                          }
                        />
                      </label>
                      <label className="fieldLabel">
                        <span className="muted">Magnesium (mg/100ml)</span>
                        <input
                          type="number"
                          min="0"
                          value={fluid.magnesium_mg_per_100ml}
                          onChange={(event) =>
                            setFluids((old) =>
                              old.map((item) =>
                                item.id === fluid.id ? { ...item, magnesium_mg_per_100ml: Number(event.target.value) } : item
                              )
                            )
                          }
                        />
                      </label>
                    </div>
                  </details>
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <h3>Cup presets</h3>
            <div className="row">
              <input
                placeholder="Preset name"
                value={newCupName}
                onChange={(event) => setNewCupName(event.target.value)}
              />
              <input
                type="number"
                value={newCupVolume}
                onChange={(event) => setNewCupVolume(Number(event.target.value))}
              />
              <button className="primary" onClick={createCup}>
                Add cup
              </button>
            </div>
            <div className="list">
              {cups.map((cup) => (
                <div className="listItem" key={cup.id}>
                  <span>
                    {cup.name} <span className="muted">({cup.volume_ml}ml)</span>
                  </span>
                  <button onClick={() => removeCup(cup.id)}>Delete</button>
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <h3>Help</h3>
            <button data-tour="settings-retake-tour" onClick={startTour}>Take app tour again</button>
          </section>
        </>
      )}

      <div className="toastContainer" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.kind}`}>
            {toast.message}
          </div>
        ))}
      </div>

      {isTourOpen && (
        <div className="tourOverlay" role="dialog" aria-modal="true" aria-label="HydrateMe onboarding tour">
          {tourSpotlightStyle && <div className="tourSpotlight" style={tourSpotlightStyle} />}
          <div className="tourCard" style={tourCardStyle}>
            <div className="tourHeader">
              <strong>
                Tour step {tourStepIndex + 1} of {tourSteps.length}
              </strong>
              <button onClick={() => closeTour(true)}>Skip</button>
            </div>
            <h3>{currentTourStep.title}</h3>
            <p className="muted">{currentTourStep.description}</p>
            <div className="tourActions">
              <button onClick={() => goToTourStep(tourStepIndex - 1)} disabled={tourStepIndex === 0}>
                Back
              </button>
              <button className="primary" onClick={nextTourStep}>
                {tourStepIndex === tourSteps.length - 1 ? "Finish tour" : "Next"}
              </button>
            </div>
          </div>
        </div>
      )}

      <nav className="bottomNav" aria-label="Primary">
        <button
          data-tour="tab-today"
          className={activeTab === "today" ? "active" : ""}
          onClick={() => setActiveTab("today")}
        >
          Today
        </button>
        <button
          data-tour="tab-stats"
          className={activeTab === "stats" ? "active" : ""}
          onClick={() => setActiveTab("stats")}
        >
          Stats
        </button>
        <button
          data-tour="tab-settings"
          className={activeTab === "settings" ? "active" : ""}
          onClick={() => setActiveTab("settings")}
        >
          Settings
        </button>
      </nav>
    </main>
  );
}

export default App;
