import { Router } from "express";
import { pool } from "../db.js";

export const metaRouter = Router();

// GET /meta/countries
metaRouter.get("/countries", async (_req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT code, name
       FROM countries
       ORDER BY name ASC`
    );
    res.json({ items: r.rows });
  } catch (e) {
    next(e);
  }
});

// GET /meta/cities?countryCode=LB
metaRouter.get("/cities", async (req, res, next) => {
  try {
    const countryCode = (req.query.countryCode || "").toString().trim().toUpperCase();

    if (countryCode) {
      const r = await pool.query(
        `SELECT id, country_code, name
         FROM cities
         WHERE country_code = $1
         ORDER BY name ASC`,
        [countryCode]
      );
      return res.json({ items: r.rows });
    }

    const r = await pool.query(
      `SELECT id, country_code, name
       FROM cities
       ORDER BY country_code ASC, name ASC`
    );
    res.json({ items: r.rows });
  } catch (e) {
    next(e);
  }
});
