import { randomUUID } from "node:crypto";
import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

export type UserContext = {
  id: string;
  token: string;
};

export async function initSchema() {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      daily_goal_ml INTEGER NOT NULL DEFAULT 2000
    );

    CREATE TABLE IF NOT EXISTS fluids (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS cup_presets (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      volume_ml INTEGER NOT NULL CHECK (volume_ml > 0)
    );

    CREATE TABLE IF NOT EXISTS intake_entries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fluid_id INTEGER NOT NULL REFERENCES fluids(id) ON DELETE RESTRICT,
      volume_ml INTEGER NOT NULL CHECK (volume_ml > 0),
      occurred_at TIMESTAMPTZ NOT NULL,
      client_entry_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, client_entry_id)
    );
  `);
}

export async function ensureUserByToken(token: string): Promise<UserContext> {
  const existing = await pool.query<{ id: string; token: string }>(
    "SELECT id, token FROM users WHERE token = $1 LIMIT 1",
    [token]
  );

  if (existing.rowCount && existing.rows[0]) {
    return existing.rows[0];
  }

  const id = randomUUID();
  await pool.query("INSERT INTO users (id, token) VALUES ($1, $2)", [id, token]);
  await pool.query("INSERT INTO settings (user_id, daily_goal_ml) VALUES ($1, 2000)", [id]);

  await pool.query(
    `INSERT INTO fluids (user_id, name, color, is_default)
     VALUES
      ($1, 'Water', '#3b82f6', TRUE),
      ($1, 'Coffee', '#7c4a2d', TRUE),
      ($1, 'Tea', '#16a34a', TRUE)`,
    [id]
  );

  await pool.query(
    `INSERT INTO cup_presets (user_id, name, volume_ml)
     VALUES
      ($1, 'Small Cup', 250),
      ($1, 'Medium Cup', 300),
      ($1, 'Large Bottle', 500)`,
    [id]
  );

  return { id, token };
}
