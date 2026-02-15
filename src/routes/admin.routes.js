import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";
import { authRequired, requireAdmin } from "../middleware/auth.js";
import { resolveUploadedMediaUrl } from "../middleware/upload.js";

export const adminRouter = Router();
adminRouter.use(authRequired, requireAdmin);

function mapListingRow(req, row) {
  return {
    ...row,
    photo_url: resolveUploadedMediaUrl(req, row.photo_url)
  };
}

const noteSchema = z.object({ note: z.string().min(2).max(300) });
const listingStatusSchema = z.object({
  status: z.enum(["DRAFT", "PENDING", "APPROVED", "REJECTED", "ARCHIVED", "DELETED"]),
  note: z.string().min(2).max(300).optional()
});
const userStatusSchema = z.object({
  status: z.enum(["ACTIVE", "BLOCKED"]),
  reason: z.string().max(400).optional()
});

adminRouter.get("/dashboard", async (_req, res, next) => {
  try {
    const statsQ = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM listings WHERE status <> 'DELETED') AS total_listings,
         (SELECT COUNT(*)::int FROM reports WHERE status IN ('OPEN', 'IN_REVIEW')) AS pending_reports,
         (SELECT COUNT(*)::int FROM messages WHERE deleted_at IS NULL AND created_at >= now() - interval '24 hours') AS new_messages,
         (SELECT COUNT(*)::int FROM users WHERE status='ACTIVE') AS verified_users`
    );

    const row = statsQ.rows[0] || {};
    res.json({
      totalListings: Number(row.total_listings || 0),
      pendingReports: Number(row.pending_reports || 0),
      newMessages: Number(row.new_messages || 0),
      verifiedUsers: Number(row.verified_users || 0)
    });
  } catch (e) {
    next(e);
  }
});

adminRouter.get("/listings", async (req, res, next) => {
  try {
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;
    const offsetRaw = Number(req.query.offset ?? 0);
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
    const includeDeleted = String(req.query.includeDeleted || "") === "true";

    const q = await pool.query(
      `SELECT l.id, l.title, l.status, l.price_monthly, l.currency, l.created_at, l.updated_at,
              c.name AS city, c.country_code,
              owner.id AS owner_user_id,
              owner.email AS owner_email,
              COALESCE(owner_profile.display_name, split_part(owner.email, '@', 1)) AS owner_name,
              p.url AS photo_url
       FROM listings l
       JOIN cities c ON c.id=l.city_id
       JOIN users owner ON owner.id=l.owner_user_id
       LEFT JOIN user_profiles owner_profile ON owner_profile.user_id=owner.id
       LEFT JOIN LATERAL (
         SELECT url
         FROM listing_photos
         WHERE listing_id=l.id
         ORDER BY position ASC, created_at ASC
         LIMIT 1
       ) p ON true
       WHERE ($3::boolean = true OR l.status <> 'DELETED')
       ORDER BY l.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset, includeDeleted]
    );

    res.json({ items: q.rows.map((row) => mapListingRow(req, row)) });
  } catch (e) {
    next(e);
  }
});

adminRouter.get("/pending-listings", async (req, res, next) => {
  try {
    const r = await pool.query(
      `SELECT l.id, l.title, l.status, l.price_monthly, l.currency, l.created_at, l.updated_at,
              c.name AS city, c.country_code,
              owner.id AS owner_user_id,
              owner.email AS owner_email,
              COALESCE(owner_profile.display_name, split_part(owner.email, '@', 1)) AS owner_name,
              p.url AS photo_url
       FROM listings l
       JOIN cities c ON c.id=l.city_id
       JOIN users owner ON owner.id=l.owner_user_id
       LEFT JOIN user_profiles owner_profile ON owner_profile.user_id=owner.id
       LEFT JOIN LATERAL (
         SELECT url
         FROM listing_photos
         WHERE listing_id=l.id
         ORDER BY position ASC, created_at ASC
         LIMIT 1
       ) p ON true
       WHERE l.status='PENDING'
       ORDER BY l.created_at ASC`
    );

    res.json({ items: r.rows.map((row) => mapListingRow(req, row)) });
  } catch (e) {
    next(e);
  }
});

adminRouter.patch("/listings/:id/status", async (req, res, next) => {
  try {
    const parsed = listingStatusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const { id } = req.params;
    const adminId = req.user.userId;
    const { status, note } = parsed.data;

    const q = await pool.query(
      `UPDATE listings
       SET status=$2,
           review_note=$3,
           reviewed_by_admin_id=$4,
           updated_at=now()
       WHERE id=$1
       RETURNING *`,
      [id, status, note ?? null, ["APPROVED", "REJECTED"].includes(status) ? adminId : null]
    );

    if (!q.rowCount) return res.status(404).json({ error: "Listing not found" });

    await pool.query(
      `INSERT INTO audit_log(actor_user_id, action_type, target_table, target_id, details)
       VALUES($1,'ADMIN_SET_LISTING_STATUS','listings',$2,$3::jsonb)`,
      [adminId, id, JSON.stringify({ status, note: note ?? null })]
    );

    res.json(q.rows[0]);
  } catch (e) {
    next(e);
  }
});

adminRouter.get("/users", async (req, res, next) => {
  try {
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 50;
    const offsetRaw = Number(req.query.offset ?? 0);
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;

    const q = await pool.query(
      `SELECT u.id, u.email, u.status, u.blocked_reason, u.created_at,
              r.name AS role,
              COALESCE(up.display_name, split_part(u.email, '@', 1)) AS display_name
       FROM users u
       JOIN roles r ON r.id=u.role_id
       LEFT JOIN user_profiles up ON up.user_id=u.id
       WHERE u.status <> 'DELETED'
       ORDER BY u.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({ items: q.rows });
  } catch (e) {
    next(e);
  }
});

adminRouter.patch("/users/:id/status", async (req, res, next) => {
  try {
    const parsed = userStatusSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const { id } = req.params;
    const adminId = req.user.userId;
    const { status, reason } = parsed.data;

    if (id === adminId && status === "BLOCKED") {
      return res.status(400).json({ error: "You cannot block your own admin account" });
    }

    const q = await pool.query(
      `UPDATE users
       SET status=$2,
           blocked_reason=$3,
           updated_at=now()
       WHERE id=$1
       RETURNING id, email, status, blocked_reason`,
      [id, status, status === "BLOCKED" ? reason ?? null : null]
    );

    if (!q.rowCount) return res.status(404).json({ error: "User not found" });

    await pool.query(
      `INSERT INTO audit_log(actor_user_id, action_type, target_table, target_id, details)
       VALUES($1,'ADMIN_SET_USER_STATUS','users',$2,$3::jsonb)`,
      [adminId, id, JSON.stringify({ status, reason: reason ?? null })]
    );

    res.json(q.rows[0]);
  } catch (e) {
    next(e);
  }
});

adminRouter.post("/listings/:id/approve", async (req, res, next) => {
  try {
    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const { id } = req.params;
    const adminId = req.user.userId;

    const r = await pool.query(
      `UPDATE listings
       SET status='APPROVED', reviewed_by_admin_id=$2, review_note=$3, updated_at=now()
       WHERE id=$1 AND status='PENDING'
       RETURNING *`,
      [id, adminId, parsed.data.note]
    );

    if (!r.rowCount) return res.status(404).json({ error: "Listing not found or not pending" });

    await pool.query(
      `INSERT INTO audit_log(actor_user_id, action_type, target_table, target_id, details)
       VALUES($1,'APPROVE_LISTING','listings',$2,$3::jsonb)`,
      [adminId, id, JSON.stringify({ note: parsed.data.note })]
    );

    res.json(r.rows[0]);
  } catch (e) {
    next(e);
  }
});

adminRouter.post("/listings/:id/reject", async (req, res, next) => {
  try {
    const parsed = noteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const { id } = req.params;
    const adminId = req.user.userId;

    const r = await pool.query(
      `UPDATE listings
       SET status='REJECTED', reviewed_by_admin_id=$2, review_note=$3, updated_at=now()
       WHERE id=$1 AND status='PENDING'
       RETURNING *`,
      [id, adminId, parsed.data.note]
    );

    if (!r.rowCount) return res.status(404).json({ error: "Listing not found or not pending" });

    await pool.query(
      `INSERT INTO audit_log(actor_user_id, action_type, target_table, target_id, details)
       VALUES($1,'REJECT_LISTING','listings',$2,$3::jsonb)`,
      [adminId, id, JSON.stringify({ note: parsed.data.note })]
    );

    res.json(r.rows[0]);
  } catch (e) {
    next(e);
  }
});
