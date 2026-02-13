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
