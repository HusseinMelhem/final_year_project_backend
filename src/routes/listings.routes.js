// import { Router } from "express";
// import { pool } from "../db.js";
// import { z } from "zod";
// import { authRequired } from "../middleware/auth.js";

// export const listingsRouter = Router();

// const createSchema = z.object({
//   cityId: z.number().int(),
//   title: z.string().min(5).max(80),
//   description: z.string().min(20).max(4000),
//   roomType: z.enum(["WHOLE_APT","PRIVATE_ROOM","SHARED_ROOM","STUDIO"]),
//   priceMonthly: z.number().int().positive(),
//   currency: z.enum(["USD","LBP","EUR"]).optional(),
//   genderPreference: z.enum(["ANY","MALE_ONLY","FEMALE_ONLY","SAME_AS_ME"]).optional()
// });

// listingsRouter.post("/", authRequired, async (req, res) => {
//   const parsed = createSchema.safeParse(req.body);
//   if (!parsed.success) return res.status(400).json(parsed.error.flatten());

//   const u = req.user;
//   const d = parsed.data;

//   const r = await pool.query(
//     `INSERT INTO listings(owner_user_id, city_id, title, description, room_type, price_monthly, currency, gender_preference, status)
//      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT')
//      RETURNING *`,
//     [u.userId, d.cityId, d.title, d.description, d.roomType, d.priceMonthly, d.currency ?? "USD", d.genderPreference ?? "ANY"]
//   );

//   res.json(r.rows[0]);
// });

// listingsRouter.post("/:id/submit", authRequired, async (req, res) => {
//   const { id } = req.params;
//   const u = req.user;

//   const own = await pool.query("SELECT owner_user_id, status FROM listings WHERE id=$1", [id]);
//   if (!own.rowCount) return res.status(404).json({ error: "Not found" });
//   if (own.rows[0].owner_user_id !== u.userId) return res.status(403).json({ error: "Not yours" });

//   const updated = await pool.query(
//     `UPDATE listings
//      SET status='PENDING', updated_at=now(), review_note=NULL, reviewed_by_admin_id=NULL
//      WHERE id=$1 AND status IN ('DRAFT','REJECTED')
//      RETURNING *`,
//     [id]
//   );

//   if (!updated.rowCount) return res.status(400).json({ error: "Cannot submit from current status" });
//   res.json(updated.rows[0]);
// });

// listingsRouter.get("/search", async (req, res) => {
//   const cityId = req.query.cityId ? Number(req.query.cityId) : null;
//   const minPrice = req.query.minPrice ? Number(req.query.minPrice) : null;
//   const maxPrice = req.query.maxPrice ? Number(req.query.maxPrice) : null;

//   const where = [];
//   const vals = [];
//   let i = 1;

//   where.push(`l.status='APPROVED'`);

//   if (cityId) { where.push(`l.city_id=$${i++}`); vals.push(cityId); }
//   if (minPrice != null) { where.push(`l.price_monthly >= $${i++}`); vals.push(minPrice); }
//   if (maxPrice != null) { where.push(`l.price_monthly <= $${i++}`); vals.push(maxPrice); }

//   const sql = `
//     SELECT l.id, l.title, l.price_monthly, l.currency, l.room_type, c.name AS city
//     FROM listings l
//     JOIN cities c ON c.id=l.city_id
//     WHERE ${where.join(" AND ")}
//     ORDER BY l.created_at DESC
//     LIMIT 20
//   `;

//   const r = await pool.query(sql, vals);
//   res.json({ items: r.rows });
// });
import { Router } from "express";
import { pool } from "../db.js";
import { z } from "zod";
import { authRequired } from "../middleware/auth.js";

export const listingsRouter = Router();

/** =========================
 * Create listing (DRAFT)
 * ========================= */
const createSchema = z.object({
  cityId: z.number().int(),
  title: z.string().min(5).max(80),
  description: z.string().min(20).max(4000),
  roomType: z.enum(["WHOLE_APT", "PRIVATE_ROOM", "SHARED_ROOM", "STUDIO"]),
  priceMonthly: z.number().int().positive(),
  currency: z.enum(["USD", "LBP", "EUR"]).optional(),
  genderPreference: z.enum(["ANY", "MALE_ONLY", "FEMALE_ONLY", "SAME_AS_ME"]).optional(),
  addressText: z.string().max(300).optional(),
  approxLocation: z.string().max(200).optional(),
  availableFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() // YYYY-MM-DD
});

listingsRouter.post("/", authRequired, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const u = req.user;
    const d = parsed.data;

    const r = await pool.query(
      `INSERT INTO listings(
        owner_user_id, city_id, title, description, room_type,
        price_monthly, currency, gender_preference,
        address_text, approx_location, available_from, status
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'DRAFT')
      RETURNING *`,
      [
        u.userId,
        d.cityId,
        d.title,
        d.description,
        d.roomType,
        d.priceMonthly,
        d.currency ?? "USD",
        d.genderPreference ?? "ANY",
        d.addressText ?? null,
        d.approxLocation ?? null,
        d.availableFrom ?? null
      ]
    );

    res.json(r.rows[0]);
  } catch (e) {
    next(e);
  }
});

/** =========================
 * Submit listing (DRAFT/REJECTED -> PENDING)
 * ========================= */
listingsRouter.post("/:id/submit", authRequired, async (req, res, next) => {
  try {
    const { id } = req.params;
    const u = req.user;

    const own = await pool.query("SELECT owner_user_id, status FROM listings WHERE id=$1", [id]);
    if (!own.rowCount) return res.status(404).json({ error: "Not found" });
    if (own.rows[0].owner_user_id !== u.userId) return res.status(403).json({ error: "Not yours" });

    const updated = await pool.query(
      `UPDATE listings
       SET status='PENDING', updated_at=now(), review_note=NULL, reviewed_by_admin_id=NULL
       WHERE id=$1 AND status IN ('DRAFT','REJECTED')
       RETURNING *`,
      [id]
    );

    if (!updated.rowCount) return res.status(400).json({ error: "Cannot submit from current status" });
    res.json(updated.rows[0]);
  } catch (e) {
    next(e);
  }
});

/** =========================
 * Public search (approved only)
 * ========================= */
listingsRouter.get("/search", async (req, res, next) => {
  try {
    const cityId = req.query.cityId ? Number(req.query.cityId) : null;
    const minPrice = req.query.minPrice ? Number(req.query.minPrice) : null;
    const maxPrice = req.query.maxPrice ? Number(req.query.maxPrice) : null;

    const where = [`l.status='APPROVED'`];
    const vals = [];
    let i = 1;

    if (cityId) { where.push(`l.city_id=$${i++}`); vals.push(cityId); }
    if (minPrice != null) { where.push(`l.price_monthly >= $${i++}`); vals.push(minPrice); }
    if (maxPrice != null) { where.push(`l.price_monthly <= $${i++}`); vals.push(maxPrice); }

    const sql = `
      SELECT l.id, l.title, l.price_monthly, l.currency, l.room_type,
             c.name AS city, c.country_code
      FROM listings l
      JOIN cities c ON c.id=l.city_id
      WHERE ${where.join(" AND ")}
      ORDER BY l.created_at DESC
      LIMIT 20
    `;

    const r = await pool.query(sql, vals);
    res.json({ items: r.rows });
  } catch (e) {
    next(e);
  }
});

/** =========================
 * GET /listings/:id (public details + photos)
 * - Only returns if status is APPROVED
 * ========================= */
listingsRouter.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;

    const listingQ = await pool.query(
      `SELECT l.id, l.title, l.description, l.room_type, l.price_monthly, l.currency,
              l.gender_preference, l.address_text, l.approx_location, l.available_from,
              l.created_at,
              c.id AS city_id, c.name AS city, c.country_code
       FROM listings l
       JOIN cities c ON c.id=l.city_id
       WHERE l.id=$1 AND l.status='APPROVED'`,
      [id]
    );

    if (!listingQ.rowCount) return res.status(404).json({ error: "Listing not found" });

    const photosQ = await pool.query(
      `SELECT id, url, position
       FROM listing_photos
       WHERE listing_id=$1
       ORDER BY position ASC, created_at ASC`,
      [id]
    );

    res.json({ ...listingQ.rows[0], photos: photosQ.rows });
  } catch (e) {
    next(e);
  }
});

/** =========================
 * GET /listings/me (owner: all my listings)
 * ========================= */
listingsRouter.get("/me/all", authRequired, async (req, res, next) => {
  try {
    const u = req.user;

    const r = await pool.query(
      `SELECT l.*, c.name AS city, c.country_code
       FROM listings l
       JOIN cities c ON c.id=l.city_id
       WHERE l.owner_user_id=$1 AND l.status <> 'DELETED'
       ORDER BY l.created_at DESC`,
      [u.userId]
    );

    res.json({ items: r.rows });
  } catch (e) {
    next(e);
  }
});

/** =========================
 * PATCH /listings/:id (owner edits)
 * - Only allowed when status is DRAFT or REJECTED
 * ========================= */
const patchSchema = z.object({
  cityId: z.number().int().optional(),
  title: z.string().min(5).max(80).optional(),
  description: z.string().min(20).max(4000).optional(),
  roomType: z.enum(["WHOLE_APT", "PRIVATE_ROOM", "SHARED_ROOM", "STUDIO"]).optional(),
  priceMonthly: z.number().int().positive().optional(),
  currency: z.enum(["USD", "LBP", "EUR"]).optional(),
  genderPreference: z.enum(["ANY", "MALE_ONLY", "FEMALE_ONLY", "SAME_AS_ME"]).optional(),
  addressText: z.string().max(300).nullable().optional(),
  approxLocation: z.string().max(200).nullable().optional(),
  availableFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
});

listingsRouter.patch("/:id", authRequired, async (req, res, next) => {
  try {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const { id } = req.params;
    const u = req.user;
    const d = parsed.data;

    const base = await pool.query(
      `SELECT owner_user_id, status
       FROM listings
       WHERE id=$1`,
      [id]
    );

    if (!base.rowCount) return res.status(404).json({ error: "Not found" });
    if (base.rows[0].owner_user_id !== u.userId) return res.status(403).json({ error: "Not yours" });
    if (!["DRAFT", "REJECTED"].includes(base.rows[0].status)) {
      return res.status(400).json({ error: "Can only edit DRAFT or REJECTED listings" });
    }

    const fields = [];
    const vals = [];
    let i = 1;

    const map = {
      cityId: "city_id",
      title: "title",
      description: "description",
      roomType: "room_type",
      priceMonthly: "price_monthly",
      currency: "currency",
      genderPreference: "gender_preference",
      addressText: "address_text",
      approxLocation: "approx_location",
      availableFrom: "available_from"
    };

    for (const [k, col] of Object.entries(map)) {
      if (d[k] !== undefined) {
        fields.push(`${col}=$${i++}`);
        vals.push(d[k]);
      }
    }

    if (fields.length === 0) return res.json({ ok: true, message: "No changes" });

    vals.push(id);

    const q = await pool.query(
      `UPDATE listings
       SET ${fields.join(", ")}, updated_at=now()
       WHERE id=$${i}
       RETURNING *`,
      vals
    );

    res.json(q.rows[0]);
  } catch (e) {
    next(e);
  }
});

/** =========================
 * DELETE /listings/:id (soft delete)
 * ========================= */
listingsRouter.delete("/:id", authRequired, async (req, res, next) => {
  try {
    const { id } = req.params;
    const u = req.user;

    const base = await pool.query(`SELECT owner_user_id FROM listings WHERE id=$1`, [id]);
    if (!base.rowCount) return res.status(404).json({ error: "Not found" });
    if (base.rows[0].owner_user_id !== u.userId) return res.status(403).json({ error: "Not yours" });

    const q = await pool.query(
      `UPDATE listings
       SET status='DELETED', updated_at=now()
       WHERE id=$1
       RETURNING id, status`,
      [id]
    );

    res.json(q.rows[0]);
  } catch (e) {
    next(e);
  }
});

/** =========================
 * POST /listings/:id/archive (set ARCHIVED)
 * - only owner
 * ========================= */
listingsRouter.post("/:id/archive", authRequired, async (req, res, next) => {
  try {
    const { id } = req.params;
    const u = req.user;

    const base = await pool.query(`SELECT owner_user_id, status FROM listings WHERE id=$1`, [id]);
    if (!base.rowCount) return res.status(404).json({ error: "Not found" });
    if (base.rows[0].owner_user_id !== u.userId) return res.status(403).json({ error: "Not yours" });

    const q = await pool.query(
      `UPDATE listings
       SET status='ARCHIVED', updated_at=now()
       WHERE id=$1 AND status IN ('APPROVED','PENDING','DRAFT','REJECTED')
       RETURNING id, status`,
      [id]
    );

    if (!q.rowCount) return res.status(400).json({ error: "Cannot archive from current status" });
    res.json(q.rows[0]);
  } catch (e) {
    next(e);
  }
});

/** =========================
 * Photos
 * POST /listings/:id/photos
 * DELETE /listings/:id/photos/:photoId
 * ========================= */
const photoSchema = z.object({
  url: z.string().min(5),
  position: z.number().int().min(0).optional()
});

listingsRouter.post("/:id/photos", authRequired, async (req, res, next) => {
  try {
    const parsed = photoSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const { id } = req.params;
    const u = req.user;
    const { url, position } = parsed.data;

    const base = await pool.query(`SELECT owner_user_id, status FROM listings WHERE id=$1`, [id]);
    if (!base.rowCount) return res.status(404).json({ error: "Not found" });
    if (base.rows[0].owner_user_id !== u.userId) return res.status(403).json({ error: "Not yours" });
    if (base.rows[0].status === "DELETED") return res.status(400).json({ error: "Listing deleted" });

    const q = await pool.query(
      `INSERT INTO listing_photos(listing_id, url, position)
       VALUES($1,$2,$3)
       RETURNING *`,
      [id, url, position ?? 0]
    );

    res.json(q.rows[0]);
  } catch (e) {
    next(e);
  }
});

listingsRouter.delete("/:id/photos/:photoId", authRequired, async (req, res, next) => {
  try {
    const { id, photoId } = req.params;
    const u = req.user;

    const base = await pool.query(`SELECT owner_user_id FROM listings WHERE id=$1`, [id]);
    if (!base.rowCount) return res.status(404).json({ error: "Not found" });
    if (base.rows[0].owner_user_id !== u.userId) return res.status(403).json({ error: "Not yours" });

    const q = await pool.query(
      `DELETE FROM listing_photos
       WHERE id=$1 AND listing_id=$2
       RETURNING id`,
      [photoId, id]
    );

    if (!q.rowCount) return res.status(404).json({ error: "Photo not found" });
    res.json({ ok: true, deletedPhotoId: q.rows[0].id });
  } catch (e) {
    next(e);
  }
});
