import "dotenv/config";
import cors from "@fastify/cors";
import Fastify from "fastify";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import { ensureUserByToken, initSchema, pool, type UserContext } from "./db.js";
import { computeHydrationForEntry, type CaffeineHabituation } from "./hydration.js";

const app = Fastify({ logger: true });
const port = Number(process.env.PORT ?? 4000);
const defaultToken = process.env.APP_TOKEN ?? "hydrateme-dev-token";
const sseClients = new Map<string, Set<ServerResponse>>();

const SSE_EVENT = "hydrate-update";
const HYDRATION_MODES = ["standard", "keto"] as const;
const CAFFEINE_HABITUATION_MODES = ["regular", "occasional", "rare"] as const;

function addSseClient(userId: string, response: ServerResponse) {
  const userClients = sseClients.get(userId) ?? new Set<ServerResponse>();
  userClients.add(response);
  sseClients.set(userId, userClients);
}

function removeSseClient(userId: string, response: ServerResponse) {
  const userClients = sseClients.get(userId);
  if (!userClients) {
    return;
  }
  userClients.delete(response);
  if (userClients.size === 0) {
    sseClients.delete(userId);
  }
}

function broadcastUserUpdate(userId: string, reason: string) {
  const userClients = sseClients.get(userId);
  if (!userClients?.size) {
    return;
  }

  const payload = JSON.stringify({ event: SSE_EVENT, reason, at: new Date().toISOString() });
  for (const client of userClients) {
    client.write(`event: ${SSE_EVENT}\n`);
    client.write(`data: ${payload}\n\n`);
  }
}

declare module "fastify" {
  interface FastifyRequest {
    user: UserContext;
  }
}

await app.register(cors, {
  origin: true,
  credentials: true
});

app.addHook("onRequest", async (request) => {
  if (request.url.startsWith("/health")) {
    return;
  }

  const queryToken =
    request.query &&
    typeof request.query === "object" &&
    "token" in request.query &&
    typeof request.query.token === "string"
      ? request.query.token
      : undefined;
  const authHeader = request.headers.authorization;
  const token = authHeader?.replace("Bearer ", "").trim() || queryToken || defaultToken;
  request.user = await ensureUserByToken(token);
});

app.get("/health", async () => ({ ok: true }));

app.get("/api/events", async (request, reply) => {
  reply.hijack();
  const response = reply.raw;
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders?.();

  addSseClient(request.user.id, response);
  response.write(`event: ready\ndata: {"ok":true}\n\n`);

  const heartbeat = setInterval(() => {
    response.write(": keepalive\n\n");
  }, 25000);

  const cleanup = () => {
    clearInterval(heartbeat);
    removeSseClient(request.user.id, response);
  };

  request.raw.on("close", cleanup);
  request.raw.on("error", cleanup);
});

app.get("/api/config", async (request) => {
  const [settings, fluids, cups] = await Promise.all([
    pool.query<{
      daily_goal_ml: number;
      hydration_mode: "standard" | "keto";
      caffeine_habituation: CaffeineHabituation;
      use_hydration_factors: boolean;
      electrolyte_targets_enabled: boolean;
    }>(
      `SELECT
        daily_goal_ml,
        hydration_mode,
        caffeine_habituation,
        use_hydration_factors,
        electrolyte_targets_enabled
       FROM settings
       WHERE user_id = $1`,
      [request.user.id]
    ),
    pool.query<{
      id: number;
      name: string;
      color: string;
      default_hydration_factor: number;
      caffeine_mg_per_100ml: number | null;
      sodium_mg_per_100ml: number;
      potassium_mg_per_100ml: number;
      magnesium_mg_per_100ml: number;
      is_user_editable_factor: boolean;
    }>(
      `SELECT
        id,
        name,
        color,
        default_hydration_factor::float8,
        caffeine_mg_per_100ml::float8,
        sodium_mg_per_100ml::float8,
        potassium_mg_per_100ml::float8,
        magnesium_mg_per_100ml::float8,
        is_user_editable_factor
       FROM fluids
       WHERE user_id = $1
       ORDER BY id`,
      [request.user.id]
    ),
    pool.query<{ id: number; name: string; volume_ml: number }>(
      "SELECT id, name, volume_ml FROM cup_presets WHERE user_id = $1 ORDER BY volume_ml",
      [request.user.id]
    )
  ]);

  return {
    userId: request.user.id,
    settings: settings.rows[0] ?? {
      daily_goal_ml: 2000,
      hydration_mode: "standard",
      caffeine_habituation: "regular",
      use_hydration_factors: true,
      electrolyte_targets_enabled: false
    },
    fluids: fluids.rows,
    cups: cups.rows
  };
});

app.put("/api/settings", async (request, reply) => {
  const bodySchema = z.object({
    dailyGoalMl: z.number().int().min(500).max(10000),
    hydrationMode: z.enum(HYDRATION_MODES),
    caffeineHabituation: z.enum(CAFFEINE_HABITUATION_MODES),
    useHydrationFactors: z.boolean(),
    electrolyteTargetsEnabled: z.boolean()
  });
  const parsed = bodySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  await pool.query(
    `UPDATE settings
     SET
      daily_goal_ml = $1,
      hydration_mode = $2,
      caffeine_habituation = $3,
      use_hydration_factors = $4,
      electrolyte_targets_enabled = $5
     WHERE user_id = $6`,
    [
      parsed.data.dailyGoalMl,
      parsed.data.hydrationMode,
      parsed.data.caffeineHabituation,
      parsed.data.useHydrationFactors,
      parsed.data.hydrationMode === "keto" ? true : parsed.data.electrolyteTargetsEnabled,
      request.user.id
    ]
  );
  broadcastUserUpdate(request.user.id, "settings-updated");
  return { ok: true };
});

app.post("/api/fluids", async (request, reply) => {
  const bodySchema = z.object({
    name: z.string().min(1).max(30),
    color: z.string().min(4).max(20),
    defaultHydrationFactor: z.number().min(0).max(1.2).default(1),
    caffeineMgPer100ml: z.number().min(0).max(500).nullable().default(null),
    sodiumMgPer100ml: z.number().min(0).max(10000).default(0),
    potassiumMgPer100ml: z.number().min(0).max(10000).default(0),
    magnesiumMgPer100ml: z.number().min(0).max(10000).default(0),
    isUserEditableFactor: z.boolean().default(true)
  });
  const parsed = bodySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const created = await pool.query<{
    id: number;
    name: string;
    color: string;
    default_hydration_factor: number;
    caffeine_mg_per_100ml: number | null;
    sodium_mg_per_100ml: number;
    potassium_mg_per_100ml: number;
    magnesium_mg_per_100ml: number;
    is_user_editable_factor: boolean;
  }>(
    `INSERT INTO fluids (
      user_id,
      name,
      color,
      default_hydration_factor,
      caffeine_mg_per_100ml,
      sodium_mg_per_100ml,
      potassium_mg_per_100ml,
      magnesium_mg_per_100ml,
      is_user_editable_factor
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING
      id,
      name,
      color,
      default_hydration_factor::float8,
      caffeine_mg_per_100ml::float8,
      sodium_mg_per_100ml::float8,
      potassium_mg_per_100ml::float8,
      magnesium_mg_per_100ml::float8,
      is_user_editable_factor`,
    [
      request.user.id,
      parsed.data.name,
      parsed.data.color,
      parsed.data.defaultHydrationFactor,
      parsed.data.caffeineMgPer100ml,
      parsed.data.sodiumMgPer100ml,
      parsed.data.potassiumMgPer100ml,
      parsed.data.magnesiumMgPer100ml,
      parsed.data.isUserEditableFactor
    ]
  );
  broadcastUserUpdate(request.user.id, "fluid-added");
  return created.rows[0];
});

app.put("/api/fluids/:id", async (request, reply) => {
  const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
  if (!params.success) {
    return reply.code(400).send({ error: "Invalid id" });
  }
  const bodySchema = z.object({
    name: z.string().min(1).max(30),
    color: z.string().min(4).max(20),
    defaultHydrationFactor: z.number().min(0).max(1.2),
    caffeineMgPer100ml: z.number().min(0).max(500).nullable(),
    sodiumMgPer100ml: z.number().min(0).max(10000),
    potassiumMgPer100ml: z.number().min(0).max(10000),
    magnesiumMgPer100ml: z.number().min(0).max(10000),
    isUserEditableFactor: z.boolean()
  });
  const parsed = bodySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const updated = await pool.query(
    `UPDATE fluids
     SET
      name = $1,
      color = $2,
      default_hydration_factor = $3,
      caffeine_mg_per_100ml = $4,
      sodium_mg_per_100ml = $5,
      potassium_mg_per_100ml = $6,
      magnesium_mg_per_100ml = $7,
      is_user_editable_factor = $8
     WHERE user_id = $9 AND id = $10`,
    [
      parsed.data.name,
      parsed.data.color,
      parsed.data.defaultHydrationFactor,
      parsed.data.caffeineMgPer100ml,
      parsed.data.sodiumMgPer100ml,
      parsed.data.potassiumMgPer100ml,
      parsed.data.magnesiumMgPer100ml,
      parsed.data.isUserEditableFactor,
      request.user.id,
      params.data.id
    ]
  );
  if (!updated.rowCount) {
    return reply.code(404).send({ error: "Fluid not found" });
  }
  broadcastUserUpdate(request.user.id, "fluid-updated");
  return { ok: true };
});

app.delete("/api/fluids/:id", async (request, reply) => {
  const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
  if (!params.success) {
    return reply.code(400).send({ error: "Invalid id" });
  }

  const fluidCount = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM fluids WHERE user_id = $1",
    [request.user.id]
  );
  if (Number(fluidCount.rows[0]?.count ?? "0") <= 1) {
    return reply.code(409).send({ error: "At least one fluid must remain" });
  }

  const usage = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM intake_entries WHERE user_id = $1 AND fluid_id = $2",
    [request.user.id, params.data.id]
  );
  if (Number(usage.rows[0]?.count ?? "0") > 0) {
    return reply.code(409).send({ error: "Fluid already used in entries and cannot be deleted" });
  }

  await pool.query("DELETE FROM fluids WHERE user_id = $1 AND id = $2", [request.user.id, params.data.id]);
  broadcastUserUpdate(request.user.id, "fluid-deleted");
  return { ok: true };
});

app.post("/api/cups", async (request, reply) => {
  const bodySchema = z.object({
    name: z.string().min(1).max(30),
    volumeMl: z.number().int().min(50).max(2000)
  });
  const parsed = bodySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const created = await pool.query<{ id: number; name: string; volume_ml: number }>(
    "INSERT INTO cup_presets (user_id, name, volume_ml) VALUES ($1, $2, $3) RETURNING id, name, volume_ml",
    [request.user.id, parsed.data.name, parsed.data.volumeMl]
  );
  broadcastUserUpdate(request.user.id, "cup-added");
  return created.rows[0];
});

app.delete("/api/cups/:id", async (request, reply) => {
  const params = z.object({ id: z.coerce.number().int().positive() }).safeParse(request.params);
  if (!params.success) {
    return reply.code(400).send({ error: "Invalid id" });
  }
  await pool.query("DELETE FROM cup_presets WHERE user_id = $1 AND id = $2", [request.user.id, params.data.id]);
  broadcastUserUpdate(request.user.id, "cup-deleted");
  return { ok: true };
});

app.get("/api/intakes", async (request, reply) => {
  const querySchema = z.object({ date: z.string().optional() });
  const parsed = querySchema.safeParse(request.query);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Invalid query" });
  }
  const date = parsed.data.date ?? new Date().toISOString().slice(0, 10);

  const rows = await pool.query<{
    id: string;
    fluid_id: number;
    fluid_name: string;
    fluid_color: string;
    volume_ml: number;
    occurred_at: string;
    applied_hydration_factor: number | null;
    applied_caffeine_penalty_pct: number | null;
    credited_hydration_ml: number | null;
    caffeine_mg: number | null;
    sodium_mg: number | null;
    potassium_mg: number | null;
    magnesium_mg: number | null;
  }>(
    `SELECT
      i.id,
      i.fluid_id,
      f.name AS fluid_name,
      f.color AS fluid_color,
      i.volume_ml,
      i.occurred_at,
      i.applied_hydration_factor::float8,
      i.applied_caffeine_penalty_pct::float8,
      i.credited_hydration_ml,
      i.caffeine_mg,
      i.sodium_mg,
      i.potassium_mg,
      i.magnesium_mg
     FROM intake_entries i
     JOIN fluids f ON i.fluid_id = f.id
     WHERE i.user_id = $1 AND DATE(i.occurred_at AT TIME ZONE 'UTC') = $2
     ORDER BY i.occurred_at DESC`,
    [request.user.id, date]
  );
  return rows.rows.map((row) => {
    const fallbackHydrationFactor = 1;
    const appliedHydrationFactor = row.applied_hydration_factor ?? fallbackHydrationFactor;
    const fallbackCreditedHydrationMl = Math.round(Math.min(row.volume_ml, Math.max(0, row.volume_ml * appliedHydrationFactor)));
    return {
      ...row,
      applied_hydration_factor: appliedHydrationFactor,
      applied_caffeine_penalty_pct: row.applied_caffeine_penalty_pct ?? 0,
      credited_hydration_ml: row.credited_hydration_ml ?? fallbackCreditedHydrationMl,
      caffeine_mg: row.caffeine_mg ?? 0,
      sodium_mg: row.sodium_mg ?? 0,
      potassium_mg: row.potassium_mg ?? 0,
      magnesium_mg: row.magnesium_mg ?? 0
    };
  });
});

app.post("/api/intakes", async (request, reply) => {
  const bodySchema = z.object({
    fluidId: z.number().int().positive(),
    volumeMl: z.number().int().min(10).max(3000),
    occurredAt: z.string().datetime(),
    clientEntryId: z.string().max(80).optional()
  });
  const parsed = bodySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const fluidResult = await pool.query<{
    id: number;
    default_hydration_factor: number;
    caffeine_mg_per_100ml: number | null;
    sodium_mg_per_100ml: number;
    potassium_mg_per_100ml: number;
    magnesium_mg_per_100ml: number;
  }>(
    `SELECT
      id,
      default_hydration_factor::float8,
      caffeine_mg_per_100ml::float8,
      sodium_mg_per_100ml::float8,
      potassium_mg_per_100ml::float8,
      magnesium_mg_per_100ml::float8
     FROM fluids
     WHERE user_id = $1 AND id = $2
     LIMIT 1`,
    [request.user.id, parsed.data.fluidId]
  );
  if (!fluidResult.rowCount) {
    return reply.code(400).send({ error: "Selected fluid does not exist" });
  }
  const fluid = fluidResult.rows[0];

  const [settingsResult, caffeineBeforeResult] = await Promise.all([
    pool.query<{ use_hydration_factors: boolean; caffeine_habituation: CaffeineHabituation }>(
      `SELECT use_hydration_factors, caffeine_habituation
       FROM settings
       WHERE user_id = $1`,
      [request.user.id]
    ),
    pool.query<{ total: number }>(
      `SELECT COALESCE(SUM(
        COALESCE(
          i.caffeine_mg,
          ROUND(i.volume_ml * COALESCE(f.caffeine_mg_per_100ml, 0) / 100)::int
        )
      ), 0)::int AS total
      FROM intake_entries i
      JOIN fluids f ON i.fluid_id = f.id
      WHERE i.user_id = $1
        AND DATE(i.occurred_at AT TIME ZONE 'UTC') = DATE($2::timestamptz AT TIME ZONE 'UTC')
        AND i.occurred_at < $2`,
      [request.user.id, parsed.data.occurredAt]
    )
  ]);

  const settings = settingsResult.rows[0] ?? {
    use_hydration_factors: true,
    caffeine_habituation: "regular" as CaffeineHabituation
  };

  const computed = computeHydrationForEntry({
    volumeMl: parsed.data.volumeMl,
    defaultHydrationFactor: fluid.default_hydration_factor,
    caffeineMgPer100ml: fluid.caffeine_mg_per_100ml,
    sodiumMgPer100ml: fluid.sodium_mg_per_100ml,
    potassiumMgPer100ml: fluid.potassium_mg_per_100ml,
    magnesiumMgPer100ml: fluid.magnesium_mg_per_100ml,
    useHydrationFactors: settings.use_hydration_factors,
    caffeineHabituation: settings.caffeine_habituation,
    dailyCaffeineBeforeMg: Number(caffeineBeforeResult.rows[0]?.total ?? 0)
  });

  try {
    const created = await pool.query<{ id: string }>(
      `INSERT INTO intake_entries (
        user_id,
        fluid_id,
        volume_ml,
        occurred_at,
        client_entry_id,
        applied_hydration_factor,
        applied_caffeine_penalty_pct,
        credited_hydration_ml,
        caffeine_mg,
        sodium_mg,
        potassium_mg,
        magnesium_mg
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        request.user.id,
        parsed.data.fluidId,
        parsed.data.volumeMl,
        parsed.data.occurredAt,
        parsed.data.clientEntryId ?? null,
        computed.appliedHydrationFactor,
        computed.appliedCaffeinePenaltyPct,
        computed.creditedHydrationMl,
        computed.caffeineMg,
        computed.sodiumMg,
        computed.potassiumMg,
        computed.magnesiumMg
      ]
    );
    broadcastUserUpdate(request.user.id, "intake-added");
    return { id: created.rows[0]?.id };
  } catch (error) {
    // Duplicate offline replay should be treated as success.
    if (parsed.data.clientEntryId) {
      const existing = await pool.query<{ id: string }>(
        "SELECT id FROM intake_entries WHERE user_id = $1 AND client_entry_id = $2 LIMIT 1",
        [request.user.id, parsed.data.clientEntryId]
      );
      if (existing.rowCount) {
        return { id: existing.rows[0].id };
      }
    }
    throw error;
  }
});

app.delete("/api/intakes/:id", async (request, reply) => {
  const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
  if (!params.success) {
    return reply.code(400).send({ error: "Invalid id" });
  }
  await pool.query("DELETE FROM intake_entries WHERE user_id = $1 AND id = $2", [request.user.id, params.data.id]);
  broadcastUserUpdate(request.user.id, "intake-deleted");
  return { ok: true };
});

app.get("/api/daily-breakdown", async (request, reply) => {
  const querySchema = z.object({ date: z.string().optional() });
  const parsed = querySchema.safeParse(request.query);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Invalid query" });
  }
  const date = parsed.data.date ?? new Date().toISOString().slice(0, 10);

  const rows = await pool.query<{
    fluid_name: string;
    fluid_color: string;
    total_ml: number;
    credited_total_ml: number;
  }>(
    `SELECT
      f.name AS fluid_name,
      f.color AS fluid_color,
      SUM(i.volume_ml)::int AS total_ml,
      SUM(
        COALESCE(
          i.credited_hydration_ml,
          ROUND(i.volume_ml * COALESCE(i.applied_hydration_factor, f.default_hydration_factor, 1.0))::int
        )
      )::int AS credited_total_ml
     FROM intake_entries i
     JOIN fluids f ON i.fluid_id = f.id
     WHERE i.user_id = $1 AND DATE(i.occurred_at AT TIME ZONE 'UTC') = $2
     GROUP BY f.name, f.color
     ORDER BY total_ml DESC`,
    [request.user.id, date]
  );
  return rows.rows;
});

app.get("/api/stats", async (request, reply) => {
  const querySchema = z.object({
    days: z.coerce.number().int().min(7).max(365).optional()
  });
  const parsed = querySchema.safeParse(request.query);
  if (!parsed.success) {
    return reply.code(400).send({ error: "Invalid query" });
  }
  const days = parsed.data.days ?? 30;

  const [daily, composition, todayTotals, settingsResult] = await Promise.all([
    pool.query<{ day: string; total_ml: number; credited_hydration_ml: number }>(
      `SELECT
        DATE(i.occurred_at AT TIME ZONE 'UTC')::text AS day,
        SUM(i.volume_ml)::int AS total_ml,
        SUM(
          COALESCE(
            i.credited_hydration_ml,
            ROUND(i.volume_ml * COALESCE(i.applied_hydration_factor, f.default_hydration_factor, 1.0))::int
          )
        )::int AS credited_hydration_ml
       FROM intake_entries i
       JOIN fluids f ON i.fluid_id = f.id
       WHERE i.user_id = $1 AND i.occurred_at >= NOW() - ($2::text || ' days')::interval
       GROUP BY day
       ORDER BY day ASC`,
      [request.user.id, days]
    ),
    pool.query<{ fluid_name: string; total_ml: number; credited_hydration_ml: number }>(
      `SELECT
        f.name AS fluid_name,
        SUM(i.volume_ml)::int AS total_ml,
        SUM(
          COALESCE(
            i.credited_hydration_ml,
            ROUND(i.volume_ml * COALESCE(i.applied_hydration_factor, f.default_hydration_factor, 1.0))::int
          )
        )::int AS credited_hydration_ml
      FROM intake_entries i
      JOIN fluids f ON i.fluid_id = f.id
      WHERE i.user_id = $1 AND i.occurred_at >= NOW() - ($2::text || ' days')::interval
      GROUP BY f.name
      ORDER BY total_ml DESC`,
      [request.user.id, days]
    ),
    pool.query<{
      total_ml: number;
      credited_hydration_ml: number;
      caffeine_mg: number;
      sodium_mg: number;
      potassium_mg: number;
      magnesium_mg: number;
    }>(
      `SELECT
        COALESCE(SUM(i.volume_ml), 0)::int AS total_ml,
        COALESCE(SUM(
          COALESCE(
            i.credited_hydration_ml,
            ROUND(i.volume_ml * COALESCE(i.applied_hydration_factor, f.default_hydration_factor, 1.0))::int
          )
        ), 0)::int AS credited_hydration_ml,
        COALESCE(SUM(
          COALESCE(i.caffeine_mg, ROUND(i.volume_ml * COALESCE(f.caffeine_mg_per_100ml, 0) / 100)::int)
        ), 0)::int AS caffeine_mg,
        COALESCE(SUM(
          COALESCE(i.sodium_mg, ROUND(i.volume_ml * COALESCE(f.sodium_mg_per_100ml, 0) / 100)::int)
        ), 0)::int AS sodium_mg,
        COALESCE(SUM(
          COALESCE(i.potassium_mg, ROUND(i.volume_ml * COALESCE(f.potassium_mg_per_100ml, 0) / 100)::int)
        ), 0)::int AS potassium_mg,
        COALESCE(SUM(
          COALESCE(i.magnesium_mg, ROUND(i.volume_ml * COALESCE(f.magnesium_mg_per_100ml, 0) / 100)::int)
        ), 0)::int AS magnesium_mg
       FROM intake_entries i
       JOIN fluids f ON i.fluid_id = f.id
       WHERE i.user_id = $1
         AND DATE(i.occurred_at AT TIME ZONE 'UTC') = CURRENT_DATE`,
      [request.user.id]
    ),
    pool.query<{
      daily_goal_ml: number;
      hydration_mode: "standard" | "keto";
      caffeine_habituation: CaffeineHabituation;
      use_hydration_factors: boolean;
      electrolyte_targets_enabled: boolean;
    }>(
      `SELECT
        daily_goal_ml,
        hydration_mode,
        caffeine_habituation,
        use_hydration_factors,
        electrolyte_targets_enabled
       FROM settings
       WHERE user_id = $1`,
      [request.user.id]
    )
  ]);

  const today = todayTotals.rows[0] ?? {
    total_ml: 0,
    credited_hydration_ml: 0,
    caffeine_mg: 0,
    sodium_mg: 0,
    potassium_mg: 0,
    magnesium_mg: 0
  };
  const settings = settingsResult.rows[0] ?? {
    daily_goal_ml: 2000,
    hydration_mode: "standard" as const,
    caffeine_habituation: "regular" as CaffeineHabituation,
    use_hydration_factors: true,
    electrolyte_targets_enabled: false
  };

  const goalProgressPct =
    settings.daily_goal_ml > 0 ? Math.min(100, Math.round((today.credited_hydration_ml / settings.daily_goal_ml) * 100)) : 0;

  return {
    days,
    daily: daily.rows,
    composition: composition.rows,
    today: {
      total_ml: today.total_ml,
      credited_hydration_ml: today.credited_hydration_ml,
      caffeine_mg: today.caffeine_mg,
      sodium_mg: today.sodium_mg,
      potassium_mg: today.potassium_mg,
      magnesium_mg: today.magnesium_mg,
      goal_ml: settings.daily_goal_ml,
      goal_progress_pct: goalProgressPct,
      hydration_mode: settings.hydration_mode,
      caffeine_habituation: settings.caffeine_habituation,
      use_hydration_factors: settings.use_hydration_factors,
      electrolyte_targets_enabled: settings.electrolyte_targets_enabled,
      electrolyte_targets: {
        sodium_mg: { min: 3000, max: 5000 },
        potassium_mg: { min: 3000, max: 4000 },
        magnesium_mg: { min: 300, max: 500 }
      }
    }
  };
});

const start = async () => {
  await initSchema();
  await app.listen({ port, host: "0.0.0.0" });
};

start().catch((error) => {
  app.log.error(error);
  process.exit(1);
});
