import fs from "node:fs/promises";
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { authRequired } from "../middleware/auth.js";
import {
  LISTING_UPLOAD_SUBFOLDER,
  resolveUploadedMediaUrl,
  toAbsoluteUploadPath,
  toPublicUploadUrl,
  uploadListingPhoto
} from "../middleware/upload.js";

export const listingsRouter = Router();

function hasValue(v) {
  return v !== undefined && v !== null;
}

function coordinatesPairIsValid(payload) {
  const hasLat = hasValue(payload.latitude);
  const hasLng = hasValue(payload.longitude);
  return hasLat === hasLng;
}

function mapListingRowMedia(req, row) {
  return {
    ...row,
    photo_url: resolveUploadedMediaUrl(req, row?.photo_url),
    owner_avatar_url: resolveUploadedMediaUrl(req, row?.owner_avatar_url),
    owner: row?.owner_user_id && (row?.owner_display_name || row?.owner_avatar_url)
      ? {
          id: row.owner_user_id,
          displayName: row.owner_display_name,
          avatarUrl: resolveUploadedMediaUrl(req, row.owner_avatar_url)
        }
      : null
  };
}

function mapListingPhotoRowMedia(req, row) {
  return { ...row, url: resolveUploadedMediaUrl(req, row?.url) };
}

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
  availableFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  googleMapsPlaceId: z.string().max(200).nullable().optional(),
  googleMapsUrl: z.string().max(1000).nullable().optional()
});

listingsRouter.post("/", authRequired, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const u = req.user;
    const d = parsed.data;

    if (!coordinatesPairIsValid(d)) {
      return res.status(400).json({ error: "Latitude and longitude must be provided together" });
    }

    const r = await pool.query(
      `INSERT INTO listings(
        owner_user_id, city_id, title, description, room_type,
        price_monthly, currency, gender_preference,
        address_text, approx_location, available_from,
        latitude, longitude, google_maps_place_id, google_maps_url,
        status
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'DRAFT')
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
        d.availableFrom ?? null,
        d.latitude ?? null,
        d.longitude ?? null,
        d.googleMapsPlaceId ?? null,
        d.googleMapsUrl ?? null
      ]
    );

    res.json(r.rows[0]);
  } catch (e) {
    next(e);
  }
});

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

listingsRouter.get("/search", async (req, res, next) => {
  try {
    const q = String(req.query.q || "").trim();
    const cityIdRaw = req.query.cityId ? Number(req.query.cityId) : null;
    const minPriceRaw = req.query.minPrice ? Number(req.query.minPrice) : null;
    const maxPriceRaw = req.query.maxPrice ? Number(req.query.maxPrice) : null;
    const cityId = Number.isFinite(cityIdRaw) ? cityIdRaw : null;
    const minPrice = Number.isFinite(minPriceRaw) ? minPriceRaw : null;
    const maxPrice = Number.isFinite(maxPriceRaw) ? maxPriceRaw : null;
    const roomTypeRaw = String(req.query.roomType || "").trim();
    const roomType = ["WHOLE_APT", "PRIVATE_ROOM", "SHARED_ROOM", "STUDIO"].includes(roomTypeRaw)
      ? roomTypeRaw
      : null;
    const sort = String(req.query.sort || "newest");
    const limitRaw = Number(req.query.limit || 40);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 40;

    const where = [`l.status='APPROVED'`];
    const vals = [];
    let i = 1;

    if (q) {
      where.push(
        `(l.title ILIKE $${i} OR l.description ILIKE $${i} OR COALESCE(l.address_text,'') ILIKE $${i}
          OR COALESCE(l.approx_location,'') ILIKE $${i} OR c.name ILIKE $${i})`
      );
      vals.push(`%${q}%`);
      i += 1;
    }
    if (cityId) {
      where.push(`l.city_id=$${i++}`);
      vals.push(cityId);
    }
    if (roomType) {
      where.push(`l.room_type=$${i++}`);
      vals.push(roomType);
    }
    if (minPrice != null) {
      where.push(`l.price_monthly >= $${i++}`);
      vals.push(minPrice);
    }
    if (maxPrice != null) {
      where.push(`l.price_monthly <= $${i++}`);
      vals.push(maxPrice);
    }

    let orderBy = "l.created_at DESC";
    if (sort === "price_asc") orderBy = "l.price_monthly ASC, l.created_at DESC";
    if (sort === "price_desc") orderBy = "l.price_monthly DESC, l.created_at DESC";

    const sql = `
      SELECT l.id, l.title, l.price_monthly, l.currency, l.room_type, l.created_at,
             l.latitude, l.longitude, l.google_maps_url,
             c.name AS city, c.country_code,
             p.url AS photo_url,
             owner.id AS owner_user_id,
             COALESCE(owner_profile.display_name, split_part(owner.email, '@', 1)) AS owner_display_name,
             owner_profile.avatar_url AS owner_avatar_url
      FROM listings l
      JOIN cities c ON c.id = l.city_id
      JOIN users owner ON owner.id = l.owner_user_id
      LEFT JOIN user_profiles owner_profile ON owner_profile.user_id = owner.id
      LEFT JOIN LATERAL (
        SELECT url
        FROM listing_photos
        WHERE listing_id=l.id
        ORDER BY position ASC, created_at ASC
        LIMIT 1
      ) p ON true
      WHERE ${where.join(" AND ")}
      ORDER BY ${orderBy}
      LIMIT ${limit}
    `;

    const r = await pool.query(sql, vals);
    res.json({ items: r.rows.map((row) => mapListingRowMedia(req, row)) });
  } catch (e) {
    next(e);
  }
});

listingsRouter.get("/me/all", authRequired, async (req, res, next) => {
  try {
    const u = req.user;

    const r = await pool.query(
      `SELECT l.*, c.name AS city, c.country_code,
              p.url AS photo_url
       FROM listings l
       JOIN cities c ON c.id=l.city_id
       LEFT JOIN LATERAL (
         SELECT url
         FROM listing_photos
         WHERE listing_id=l.id
         ORDER BY position ASC, created_at ASC
         LIMIT 1
       ) p ON true
       WHERE l.owner_user_id=$1 AND l.status <> 'DELETED'
       ORDER BY l.created_at DESC`,
      [u.userId]
    );

    res.json({ items: r.rows.map((row) => mapListingRowMedia(req, row)) });
  } catch (e) {
    next(e);
  }
});

listingsRouter.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;

    const listingQ = await pool.query(
      `SELECT l.id, l.title, l.description, l.room_type, l.price_monthly, l.currency,
              l.gender_preference, l.address_text, l.approx_location, l.available_from,
              l.latitude, l.longitude, l.google_maps_place_id, l.google_maps_url,
              l.created_at, l.owner_user_id,
              c.id AS city_id, c.name AS city, c.country_code,
              owner.email AS owner_email,
              COALESCE(owner_profile.display_name, split_part(owner.email, '@', 1)) AS owner_display_name,
              split_part(owner.email, '@', 1) AS owner_username,
              owner_profile.avatar_url AS owner_avatar_url,
              owner_profile.bio AS owner_bio
       FROM listings l
       JOIN cities c ON c.id=l.city_id
       JOIN users owner ON owner.id=l.owner_user_id
       LEFT JOIN user_profiles owner_profile ON owner_profile.user_id=owner.id
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

    const row = listingQ.rows[0];

    res.json({
      id: row.id,
      title: row.title,
      description: row.description,
      room_type: row.room_type,
      price_monthly: row.price_monthly,
      currency: row.currency,
      gender_preference: row.gender_preference,
      address_text: row.address_text,
      approx_location: row.approx_location,
      available_from: row.available_from,
      latitude: row.latitude,
      longitude: row.longitude,
      google_maps_place_id: row.google_maps_place_id,
      google_maps_url: row.google_maps_url,
      created_at: row.created_at,
      city_id: row.city_id,
      city: row.city,
      country_code: row.country_code,
      owner: {
        id: row.owner_user_id,
        email: row.owner_email,
        displayName: row.owner_display_name,
        username: row.owner_username,
        avatarUrl: resolveUploadedMediaUrl(req, row.owner_avatar_url),
        bio: row.owner_bio
      },
      photos: photosQ.rows.map((row) => mapListingPhotoRowMedia(req, row))
    });
  } catch (e) {
    next(e);
  }
});

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
  availableFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  googleMapsPlaceId: z.string().max(200).nullable().optional(),
  googleMapsUrl: z.string().max(1000).nullable().optional()
});

listingsRouter.patch("/:id", authRequired, async (req, res, next) => {
  try {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const { id } = req.params;
    const u = req.user;
    const d = parsed.data;

    if (!coordinatesPairIsValid(d)) {
      return res.status(400).json({ error: "Latitude and longitude must be provided together" });
    }

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
      availableFrom: "available_from",
      latitude: "latitude",
      longitude: "longitude",
      googleMapsPlaceId: "google_maps_place_id",
      googleMapsUrl: "google_maps_url"
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

    res.json(mapListingPhotoRowMedia(req, q.rows[0]));
  } catch (e) {
    next(e);
  }
});

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

listingsRouter.post(
  "/:id/photos/upload",
  authRequired,
  uploadListingPhoto.single("photo"),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: "Photo file is required" });

      const { id } = req.params;
      const u = req.user;

      const base = await pool.query(`SELECT owner_user_id, status FROM listings WHERE id=$1`, [id]);
      if (!base.rowCount) return res.status(404).json({ error: "Not found" });
      if (base.rows[0].owner_user_id !== u.userId) return res.status(403).json({ error: "Not yours" });
      if (base.rows[0].status === "DELETED") return res.status(400).json({ error: "Listing deleted" });

      const requestedPos = Number(req.body.position);
      const position = Number.isFinite(requestedPos) && requestedPos >= 0 ? requestedPos : 0;
      const url = toPublicUploadUrl(req, LISTING_UPLOAD_SUBFOLDER, req.file.filename);

      const q = await pool.query(
        `INSERT INTO listing_photos(listing_id, url, position)
         VALUES($1,$2,$3)
         RETURNING *`,
        [id, url, position]
      );

      res.json(mapListingPhotoRowMedia(req, q.rows[0]));
    } catch (e) {
      next(e);
    }
  }
);

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
       RETURNING id, url`,
      [photoId, id]
    );

    if (!q.rowCount) return res.status(404).json({ error: "Photo not found" });

    const removed = q.rows[0];
    const absPath = toAbsoluteUploadPath(removed.url);
    if (absPath) {
      await fs.unlink(absPath).catch(() => {});
    }

    res.json({ ok: true, deletedPhotoId: removed.id });
  } catch (e) {
    next(e);
  }
});
