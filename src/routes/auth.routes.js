import { Router } from "express";
import { pool } from "../db.js";
import { z } from "zod";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import { authRequired } from "../middleware/auth.js";
import {
  resolveUploadedMediaUrl,
  toPublicUploadUrl,
  uploadUserPhoto,
  USER_PROFILE_UPLOAD_SUBFOLDER
} from "../middleware/upload.js";

export const authRouter = Router();

async function ensureUserProfileRow(userId) {
  await pool.query(
    `INSERT INTO user_profiles(user_id, display_name)
     SELECT u.id, split_part(u.email, '@', 1)
     FROM users u
     WHERE u.id=$1
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
}

const registerSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
  displayName: z.string().min(2).max(80)
});

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const { email, password, displayName } = parsed.data;
  const emailLc = email.toLowerCase();

  const existing = await pool.query("SELECT id FROM users WHERE email=$1", [emailLc]);
  if (existing.rowCount) return res.status(409).json({ error: "Email already used" });

  const passwordHash = await argon2.hash(password);

  // role USER
  const role = await pool.query("SELECT id FROM roles WHERE name='USER'");
  const roleId = role.rows[0].id;

  const created = await pool.query(
    `INSERT INTO users(email, password_hash, role_id)
     VALUES($1,$2,$3)
     RETURNING id, email`,
    [emailLc, passwordHash, roleId]
  );

  const userId = created.rows[0].id;

  await pool.query(
    `INSERT INTO user_profiles(user_id, display_name)
     VALUES($1,$2)`,
    [userId, displayName]
  );

  const token = jwt.sign({ userId, role: "USER" }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.json({
    token,
    user: {
      id: userId,
      email: emailLc,
      role: "USER",
      displayName,
      avatarUrl: null
    }
  });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(parsed.error.flatten());

  const { email, password } = parsed.data;
  const emailLc = email.toLowerCase();

  const q = await pool.query(
    `SELECT u.id, u.email, u.password_hash, u.status, r.name AS role,
            up.display_name, up.avatar_url
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN user_profiles up ON up.user_id = u.id
     WHERE u.email=$1`,
    [emailLc]
  );

  if (!q.rowCount) return res.status(401).json({ error: "Invalid credentials" });

  const user = q.rows[0];
  if (user.status === "BLOCKED") return res.status(403).json({ error: "Blocked" });

  const ok = await argon2.verify(user.password_hash, password);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      displayName: user.display_name,
      avatarUrl: resolveUploadedMediaUrl(req, user.avatar_url)
    }
  });
});

authRouter.get("/me", authRequired, async (req, res, next) => {
  try {
    const userId = req.user.userId;
    await ensureUserProfileRow(userId);

    const q = await pool.query(
      `SELECT u.id, u.email, u.status, r.name AS role,
              up.display_name, up.bio, up.city_id, up.budget_min, up.budget_max, up.avatar_url
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN user_profiles up ON up.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );

    if (!q.rowCount) return res.status(404).json({ error: "User not found" });

    const row = q.rows[0];
    res.json({
      user: {
        id: row.id,
        email: row.email,
        role: row.role,
        status: row.status,
        displayName: row.display_name,
        avatarUrl: resolveUploadedMediaUrl(req, row.avatar_url)
      },
      profile: {
        displayName: row.display_name,
        bio: row.bio,
        cityId: row.city_id,
        budgetMin: row.budget_min,
        budgetMax: row.budget_max,
        avatarUrl: resolveUploadedMediaUrl(req, row.avatar_url)
      }
    });
  } catch (e) {
    next(e);
  }
});

const updateProfileSchema = z
  .object({
    displayName: z.string().min(2).max(80).optional(),
    bio: z.string().max(1200).nullable().optional(),
    cityId: z.number().int().positive().nullable().optional(),
    budgetMin: z.number().int().nonnegative().nullable().optional(),
    budgetMax: z.number().int().nonnegative().nullable().optional()
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required"
  });

authRouter.patch("/me/profile", authRequired, async (req, res, next) => {
  try {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const userId = req.user.userId;
    await ensureUserProfileRow(userId);
    const data = parsed.data;

    const fields = [];
    const values = [];
    let i = 1;

    const mapping = {
      displayName: "display_name",
      bio: "bio",
      cityId: "city_id",
      budgetMin: "budget_min",
      budgetMax: "budget_max"
    };

    for (const [key, column] of Object.entries(mapping)) {
      if (data[key] !== undefined) {
        fields.push(`${column}=$${i++}`);
        values.push(data[key]);
      }
    }

    values.push(userId);

    const q = await pool.query(
      `UPDATE user_profiles
       SET ${fields.join(", ")}, updated_at=now()
       WHERE user_id=$${i}
       RETURNING user_id, display_name, bio, city_id, budget_min, budget_max, avatar_url`,
      values
    );

    if (!q.rowCount) return res.status(404).json({ error: "Profile not found" });

    const row = q.rows[0];
    res.json({
      ok: true,
      profile: {
        userId: row.user_id,
        displayName: row.display_name,
        bio: row.bio,
        cityId: row.city_id,
        budgetMin: row.budget_min,
        budgetMax: row.budget_max,
        avatarUrl: resolveUploadedMediaUrl(req, row.avatar_url)
      }
    });
  } catch (e) {
    next(e);
  }
});

authRouter.post("/me/photo", authRequired, uploadUserPhoto.single("photo"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Photo file is required" });

    const userId = req.user.userId;
    await ensureUserProfileRow(userId);
    const avatarUrl = toPublicUploadUrl(req, USER_PROFILE_UPLOAD_SUBFOLDER, req.file.filename);

    const q = await pool.query(
      `UPDATE user_profiles
       SET avatar_url=$2, updated_at=now()
       WHERE user_id=$1
       RETURNING user_id, avatar_url`,
      [userId, avatarUrl]
    );

    if (!q.rowCount) return res.status(404).json({ error: "Profile not found" });

    res.json({ ok: true, avatarUrl: resolveUploadedMediaUrl(req, q.rows[0].avatar_url) });
  } catch (e) {
    next(e);
  }
});
