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
      daily_goal_ml INTEGER NOT NULL DEFAULT 2000,
      hydration_mode TEXT NOT NULL DEFAULT 'standard',
      caffeine_habituation TEXT NOT NULL DEFAULT 'regular',
      use_hydration_factors BOOLEAN NOT NULL DEFAULT TRUE,
      electrolyte_targets_enabled BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS fluids (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      default_hydration_factor NUMERIC(4, 2) NOT NULL DEFAULT 1.00,
      caffeine_mg_per_100ml NUMERIC(6, 2),
      sodium_mg_per_100ml NUMERIC(7, 2) NOT NULL DEFAULT 0,
      potassium_mg_per_100ml NUMERIC(7, 2) NOT NULL DEFAULT 0,
      magnesium_mg_per_100ml NUMERIC(7, 2) NOT NULL DEFAULT 0,
      is_user_editable_factor BOOLEAN NOT NULL DEFAULT TRUE
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
      applied_hydration_factor NUMERIC(4, 2),
      applied_caffeine_penalty_pct NUMERIC(4, 2),
      credited_hydration_ml INTEGER,
      caffeine_mg INTEGER,
      sodium_mg INTEGER,
      potassium_mg INTEGER,
      magnesium_mg INTEGER,
      client_entry_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, client_entry_id)
    );
  `);

  await pool.query(`
    ALTER TABLE settings
      ADD COLUMN IF NOT EXISTS hydration_mode TEXT NOT NULL DEFAULT 'standard',
      ADD COLUMN IF NOT EXISTS caffeine_habituation TEXT NOT NULL DEFAULT 'regular',
      ADD COLUMN IF NOT EXISTS use_hydration_factors BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS electrolyte_targets_enabled BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE fluids
      ADD COLUMN IF NOT EXISTS default_hydration_factor NUMERIC(4, 2) NOT NULL DEFAULT 1.00,
      ADD COLUMN IF NOT EXISTS caffeine_mg_per_100ml NUMERIC(6, 2),
      ADD COLUMN IF NOT EXISTS sodium_mg_per_100ml NUMERIC(7, 2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS potassium_mg_per_100ml NUMERIC(7, 2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS magnesium_mg_per_100ml NUMERIC(7, 2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS is_user_editable_factor BOOLEAN NOT NULL DEFAULT TRUE;

    ALTER TABLE intake_entries
      ADD COLUMN IF NOT EXISTS applied_hydration_factor NUMERIC(4, 2),
      ADD COLUMN IF NOT EXISTS applied_caffeine_penalty_pct NUMERIC(4, 2),
      ADD COLUMN IF NOT EXISTS credited_hydration_ml INTEGER,
      ADD COLUMN IF NOT EXISTS caffeine_mg INTEGER,
      ADD COLUMN IF NOT EXISTS sodium_mg INTEGER,
      ADD COLUMN IF NOT EXISTS potassium_mg INTEGER,
      ADD COLUMN IF NOT EXISTS magnesium_mg INTEGER;
  `);

  await pool.query(`
    UPDATE settings
    SET hydration_mode = COALESCE(hydration_mode, 'standard'),
        caffeine_habituation = COALESCE(caffeine_habituation, 'regular'),
        use_hydration_factors = COALESCE(use_hydration_factors, TRUE),
        electrolyte_targets_enabled = COALESCE(electrolyte_targets_enabled, FALSE);

    UPDATE fluids
    SET default_hydration_factor = CASE
      WHEN LOWER(name) LIKE '%water%' THEN 1.00
      WHEN LOWER(name) LIKE '%coffee%' THEN 0.90
      WHEN LOWER(name) LIKE '%tea%' THEN 0.90
      WHEN LOWER(name) LIKE '%milk%' THEN 0.85
      WHEN LOWER(name) LIKE '%electrolyte%' OR LOWER(name) LIKE '%sport%' THEN 0.95
      WHEN LOWER(name) LIKE '%juice%' THEN 0.80
      WHEN LOWER(name) LIKE '%soda%' THEN 0.75
      WHEN LOWER(name) LIKE '%beer%' OR LOWER(name) LIKE '%wine%' OR LOWER(name) LIKE '%alcohol%' THEN 0.40
      ELSE 1.00
    END
    WHERE is_default = TRUE AND is_user_editable_factor = FALSE;
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
  await pool.query(
    `INSERT INTO settings (
      user_id,
      daily_goal_ml,
      hydration_mode,
      caffeine_habituation,
      use_hydration_factors,
      electrolyte_targets_enabled
    ) VALUES ($1, 2000, 'standard', 'regular', TRUE, FALSE)`,
    [id]
  );

  await pool.query(
    `INSERT INTO fluids (
      user_id,
      name,
      color,
      is_default,
      default_hydration_factor,
      caffeine_mg_per_100ml,
      sodium_mg_per_100ml,
      potassium_mg_per_100ml,
      magnesium_mg_per_100ml,
      is_user_editable_factor
    )
     VALUES
      ($1, 'Water', '#3b82f6', TRUE, 1.00, NULL, 0, 0, 0, FALSE),
      ($1, 'Coffee', '#7c4a2d', TRUE, 0.90, 40.00, 2, 49, 3, FALSE),
      ($1, 'Tea', '#16a34a', TRUE, 0.90, 20.00, 1, 8, 1, FALSE)`,
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
