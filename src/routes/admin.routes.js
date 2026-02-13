import { Router } from "express";
import { pool } from "../db.js";
import { authRequired, requireAdmin } from "../middleware/auth.js";
import { z } from "zod";

export const adminRouter = Router();
adminRouter.use(authRequired, requireAdmin);

adminRouter.get("/pending-listings", async (_req, res) => {
  const r = await pool.query(
    `SELECT l.*, c.name AS city
     FROM listings l
     JOIN cities c ON c.id=l.city_id
     WHERE l.status='PENDING'
     ORDER BY l.created_at ASC`
  );
  res.json(r.rows);
});

const noteSchema = z.object({ note: z.string().min(2).max(300) });

adminRouter.post("/listings/:id/approve", async (req, res) => {
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
});

adminRouter.post("/listings/:id/reject", async (req, res) => {
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
});
