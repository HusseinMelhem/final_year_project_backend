import "dotenv/config";
import pg from "pg";
const { Pool } = pg;

const cs = process.env.DATABASE_URL;
console.log("PG CONNECT =", cs);

export const pool = new Pool({ connectionString: cs });

// Log connection errors clearly
pool.on("error", (err) => {
  console.error("PG POOL ERROR:", err.code, err.message);
});

export async function ensureSchemaMigrations() {
  const statements = [
    `ALTER TABLE IF EXISTS user_profiles
       ADD COLUMN IF NOT EXISTS avatar_url TEXT NULL`,
    `ALTER TABLE IF EXISTS listings
       ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION NULL`,
    `ALTER TABLE IF EXISTS listings
       ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION NULL`,
    `ALTER TABLE IF EXISTS listings
       ADD COLUMN IF NOT EXISTS google_maps_place_id VARCHAR(200) NULL`,
    `ALTER TABLE IF EXISTS listings
       ADD COLUMN IF NOT EXISTS google_maps_url TEXT NULL`
  ];

  for (const sql of statements) {
    await pool.query(sql);
  }
}
