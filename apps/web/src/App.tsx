import { useEffect, useMemo, useState } from "react";
import { ApiRequestError, api, eventsUrl } from "./api";
import { clearQueue, enqueueIntake, flushQueue, getQueueSize } from "./offlineQueue";
import type { BreakdownRow, CupPreset, Fluid, IntakeEntry, StatsResponse } from "./types";
import "./App.css";

type Tab = "today" | "stats" | "settings";
type ToastKind = "error" | "success" | "info";
type Toast = { id: number; message: string; kind: ToastKind };

const todayIso = () => new Date().toISOString().slice(0, 10);
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
  const [dailyGoalMl, setDailyGoalMl] = useState(2000);
  const [fluids, setFluids] = useState<Fluid[]>([]);
  const [cups, setCups] = useState<CupPreset[]>([]);
  const [selectedFluidId, setSelectedFluidId] = useState<number | null>(null);
  const [entries, setEntries] = useState<IntakeEntry[]>([]);
  const [breakdown, setBreakdown] = useState<BreakdownRow[]>([]);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [status, setStatus] = useState("Loading...");
  const [queueSize, setQueueSize] = useState(0);
  const [newFluidName, setNewFluidName] = useState("");
  const [newFluidColor, setNewFluidColor] = useState("#22c55e");
  const [newCupName, setNewCupName] = useState("");
  const [newCupVolume, setNewCupVolume] = useState(250);
  const [refreshingStats, setRefreshingStats] = useState(false);
  const [sseConnected, setSseConnected] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const totalTodayMl = useMemo(
    () => entries.reduce((acc, entry) => acc + entry.volume_ml, 0),
    [entries]
  );

  const progressPercent = Math.min(100, Math.round((totalTodayMl / dailyGoalMl) * 100));

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

  async function refreshQueueStatus() {
    setQueueSize(await getQueueSize());
  }

  async function loadConfigAndToday() {
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
      api.getStats(30)
    ]);
    setDailyGoalMl(config.settings.daily_goal_ml);
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
    localStorage.setItem(
      "hydrateme-cache",
      JSON.stringify({ config, dayEntries, dayBreakdown, statsData })
    );
  }

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
            config: { userId: string; settings: { daily_goal_ml: number }; fluids: Fluid[]; cups: CupPreset[] };
            dayEntries: IntakeEntry[];
            dayBreakdown: BreakdownRow[];
            statsData: StatsResponse;
          };
          setDailyGoalMl(parsed.config.settings.daily_goal_ml);
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
    bootstrap();
  }, []);

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
  }, []);

  async function refreshTodayPanels() {
    const [dayEntries, dayBreakdown, statsData] = await Promise.all([
      api.listIntakes(todayIso()),
      api.getBreakdown(todayIso()),
      api.getStats(30)
    ]);
    setEntries(dayEntries);
    setBreakdown(dayBreakdown);
    setStats(statsData);
  }

  async function refreshLiveData() {
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
  }

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
      await api.saveSettings(dailyGoalMl);
      setStatus("Goal updated");
      pushToast("Daily goal updated.", "success");
    } catch (error) {
      pushToast(getErrorMessage(error, "Could not update goal"));
    }
  }

  async function createFluid() {
    if (!newFluidName.trim()) return;
    try {
      const fluid = await api.addFluid(newFluidName.trim(), newFluidColor);
      setFluids((old) => [...old, fluid]);
      setNewFluidName("");
      pushToast("Fluid added.", "success");
    } catch (error) {
      pushToast(getErrorMessage(error, "Could not add fluid"));
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
  }, []);

  useEffect(() => {
    if (activeTab === "settings") {
      return;
    }
    if (sseConnected) {
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
  }, [activeTab, sseConnected]);

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
        <div className="tabs">
          <button className={activeTab === "today" ? "active" : ""} onClick={() => setActiveTab("today")}>
            Today
          </button>
          <button className={activeTab === "stats" ? "active" : ""} onClick={() => setActiveTab("stats")}>
            Stats
          </button>
          <button className={activeTab === "settings" ? "active" : ""} onClick={() => setActiveTab("settings")}>
            Settings
          </button>
        </div>
      </section>

      {activeTab === "today" && (
        <>
          <section className="card">
            <div className="row">
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
            </div>

            <h3>
              {totalTodayMl}ml / {dailyGoalMl}ml
            </h3>
            <div className="progressWrap">
              <div className="progressFill" style={{ width: `${progressPercent}%` }} />
            </div>

            <div className="row">
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

          <section className="card">
            <h3>Daily breakdown</h3>
            <div className="list">
              {breakdown.map((row) => (
                <div className="listItem" key={row.fluid_name}>
                  <span>
                    <span className="dot" style={{ background: row.fluid_color, marginRight: 8 }} />
                    {row.fluid_name}
                  </span>
                  <strong>{row.total_ml}ml</strong>
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
                    {entry.fluid_name} - {entry.volume_ml}ml
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
          <div className="row" style={{ justifyContent: "flex-end", marginBottom: "0.75rem" }}>
            <button className="primary" onClick={forceRefreshStats} disabled={refreshingStats}>
              {refreshingStats ? "Refreshing..." : "Force refresh stats"}
            </button>
          </div>
          <h3>Last {stats?.days ?? 30} days</h3>
          <div className="list">
            {stats?.daily.map((d) => (
              <div key={d.day} className="listItem">
                <span>{d.day}</span>
                <strong>{d.total_ml}ml</strong>
              </div>
            ))}
          </div>
          <h3>Fluid composition</h3>
          <div className="list">
            {stats?.composition.map((d) => (
              <div key={d.fluid_name} className="listItem">
                <span>{d.fluid_name}</span>
                <strong>{d.total_ml}ml</strong>
              </div>
            ))}
          </div>
        </section>
      )}

      {activeTab === "settings" && (
        <>
          <section className="card">
            <h3>Daily goal</h3>
            <div className="row">
              <input
                type="number"
                value={dailyGoalMl}
                onChange={(event) => setDailyGoalMl(Number(event.target.value))}
              />
              <button className="primary" onClick={saveGoal}>
                Save
              </button>
            </div>
          </section>

          <section className="card">
            <h3>Fluids</h3>
            <div className="row">
              <input
                placeholder="Fluid name"
                value={newFluidName}
                onChange={(event) => setNewFluidName(event.target.value)}
              />
              <input
                type="color"
                value={newFluidColor}
                onChange={(event) => setNewFluidColor(event.target.value)}
              />
              <button className="primary" onClick={createFluid}>
                Add fluid
              </button>
            </div>
            <div className="list">
              {fluids.map((fluid) => (
                <div className="listItem" key={fluid.id}>
                  <span>
                    <span className="dot" style={{ background: fluid.color, marginRight: 8 }} />
                    {fluid.name}
                  </span>
                  <button onClick={() => removeFluid(fluid.id)}>Delete</button>
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
        </>
      )}

      <div className="toastContainer" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.kind}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </main>
  );
}

export default App;
