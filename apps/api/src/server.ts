import "dotenv/config";
import cors from "@fastify/cors";
import Fastify from "fastify";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import { ensureUserByToken, initSchema, pool, type UserContext } from "./db.js";

const app = Fastify({ logger: true });
const port = Number(process.env.PORT ?? 4000);
const defaultToken = process.env.APP_TOKEN ?? "hydrateme-dev-token";
const sseClients = new Map<string, Set<ServerResponse>>();

const SSE_EVENT = "hydrate-update";

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
    pool.query<{ daily_goal_ml: number }>("SELECT daily_goal_ml FROM settings WHERE user_id = $1", [request.user.id]),
    pool.query<{ id: number; name: string; color: string }>(
      "SELECT id, name, color FROM fluids WHERE user_id = $1 ORDER BY id",
      [request.user.id]
    ),
    pool.query<{ id: number; name: string; volume_ml: number }>(
      "SELECT id, name, volume_ml FROM cup_presets WHERE user_id = $1 ORDER BY volume_ml",
      [request.user.id]
    )
  ]);

  return {
    userId: request.user.id,
    settings: settings.rows[0] ?? { daily_goal_ml: 2000 },
    fluids: fluids.rows,
    cups: cups.rows
  };
});

app.put("/api/settings", async (request, reply) => {
  const bodySchema = z.object({
    dailyGoalMl: z.number().int().min(500).max(10000)
  });
  const parsed = bodySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  await pool.query(
    "UPDATE settings SET daily_goal_ml = $1 WHERE user_id = $2",
    [parsed.data.dailyGoalMl, request.user.id]
  );
  broadcastUserUpdate(request.user.id, "settings-updated");
  return { ok: true };
});

app.post("/api/fluids", async (request, reply) => {
  const bodySchema = z.object({
    name: z.string().min(1).max(30),
    color: z.string().min(4).max(20)
  });
  const parsed = bodySchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: parsed.error.flatten() });
  }

  const created = await pool.query<{ id: number; name: string; color: string }>(
    "INSERT INTO fluids (user_id, name, color) VALUES ($1, $2, $3) RETURNING id, name, color",
    [request.user.id, parsed.data.name, parsed.data.color]
  );
  broadcastUserUpdate(request.user.id, "fluid-added");
  return created.rows[0];
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
  }>(
    `SELECT i.id, i.fluid_id, f.name AS fluid_name, f.color AS fluid_color, i.volume_ml, i.occurred_at
     FROM intake_entries i
     JOIN fluids f ON i.fluid_id = f.id
     WHERE i.user_id = $1 AND DATE(i.occurred_at AT TIME ZONE 'UTC') = $2
     ORDER BY i.occurred_at DESC`,
    [request.user.id, date]
  );
  return rows.rows;
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

  const fluidExists = await pool.query<{ id: number }>(
    "SELECT id FROM fluids WHERE user_id = $1 AND id = $2 LIMIT 1",
    [request.user.id, parsed.data.fluidId]
  );
  if (!fluidExists.rowCount) {
    return reply.code(400).send({ error: "Selected fluid does not exist" });
  }

  try {
    const created = await pool.query<{ id: string }>(
      `INSERT INTO intake_entries (user_id, fluid_id, volume_ml, occurred_at, client_entry_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [request.user.id, parsed.data.fluidId, parsed.data.volumeMl, parsed.data.occurredAt, parsed.data.clientEntryId ?? null]
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

  const rows = await pool.query<{ fluid_name: string; fluid_color: string; total_ml: number }>(
    `SELECT f.name AS fluid_name, f.color AS fluid_color, SUM(i.volume_ml)::int AS total_ml
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

  const daily = await pool.query<{ day: string; total_ml: number }>(
    `SELECT DATE(occurred_at AT TIME ZONE 'UTC')::text AS day, SUM(volume_ml)::int AS total_ml
     FROM intake_entries
     WHERE user_id = $1 AND occurred_at >= NOW() - ($2::text || ' days')::interval
     GROUP BY day
     ORDER BY day ASC`,
    [request.user.id, days]
  );

  const composition = await pool.query<{ fluid_name: string; total_ml: number }>(
    `SELECT f.name AS fluid_name, SUM(i.volume_ml)::int AS total_ml
     FROM intake_entries i
     JOIN fluids f ON i.fluid_id = f.id
     WHERE i.user_id = $1 AND i.occurred_at >= NOW() - ($2::text || ' days')::interval
     GROUP BY f.name
     ORDER BY total_ml DESC`,
    [request.user.id, days]
  );

  return {
    days,
    daily: daily.rows,
    composition: composition.rows
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
