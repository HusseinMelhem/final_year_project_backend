import { Router } from "express";
import { pool } from "../db.js";
import { z } from "zod";
import argon2 from "argon2";
import jwt from "jsonwebtoken";

export const authRouter = Router();

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
  res.json({ token, user: { id: userId, email: emailLc, role: "USER" } });
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
    `SELECT u.id, u.email, u.password_hash, u.status, r.name AS role
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.email=$1`,
    [emailLc]
  );

  if (!q.rowCount) return res.status(401).json({ error: "Invalid credentials" });

  const user = q.rows[0];
  if (user.status === "BLOCKED") return res.status(403).json({ error: "Blocked" });

  const ok = await argon2.verify(user.password_hash, password);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
});
