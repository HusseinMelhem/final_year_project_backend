import { Router } from "express";
import { pool } from "../db.js";
import { z } from "zod";
import { authRequired } from "../middleware/auth.js";

export const messagesRouter = Router();
messagesRouter.use(authRequired);

/**
 * Helper: check conversation access
 */
async function ensureConversationAccess(conversationId, userId) {
  const r = await pool.query(
    `SELECT 1
     FROM conversation_participants
     WHERE conversation_id=$1 AND user_id=$2`,
    [conversationId, userId]
  );
  return r.rowCount > 0;
}

/**
 * =========================
 * POST /conversations
 * Create (or reuse) conversation for a listing between requester and listing owner
 * Body: { listingId: uuid }
 * - Adds participants (OWNER + INQUIRER)
 * =========================
 */
const createConversationSchema = z.object({
  listingId: z.string().uuid()
});

messagesRouter.post("/conversations", async (req, res, next) => {
  try {
    const parsed = createConversationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const { listingId } = parsed.data;
    const userId = req.user.userId;

    // Get listing + owner
    const listingQ = await pool.query(
      `SELECT id, owner_user_id, status
       FROM listings
       WHERE id=$1 AND status <> 'DELETED'`,
      [listingId]
    );
    if (!listingQ.rowCount) return res.status(404).json({ error: "Listing not found" });

    const listing = listingQ.rows[0];
    const ownerId = listing.owner_user_id;

    // Don't allow messaging yourself
    if (ownerId === userId) return res.status(400).json({ error: "Cannot message your own listing" });

    // Reuse existing conversation for same listing between these two users if exists
    const existingQ = await pool.query(
      `
      SELECT c.id
      FROM conversations c
      JOIN conversation_participants p1 ON p1.conversation_id=c.id AND p1.user_id=$1
      JOIN conversation_participants p2 ON p2.conversation_id=c.id AND p2.user_id=$2
      WHERE c.listing_id=$3 AND c.status IN ('OPEN','CLOSED')
      ORDER BY c.created_at DESC
      LIMIT 1
      `,
      [userId, ownerId, listingId]
    );

    if (existingQ.rowCount) {
      return res.json({ conversationId: existingQ.rows[0].id, reused: true });
    }

    // Create conversation
    const convQ = await pool.query(
      `INSERT INTO conversations(listing_id, created_by_user_id, status)
       VALUES($1,$2,'OPEN')
       RETURNING id`,
      [listingId, userId]
    );

    const conversationId = convQ.rows[0].id;

    // Add participants
    await pool.query(
      `INSERT INTO conversation_participants(conversation_id, user_id, participant_role)
       VALUES ($1,$2,'INQUIRER'), ($1,$3,'OWNER')`,
      [conversationId, userId, ownerId]
    );

    res.json({ conversationId, reused: false });
  } catch (e) {
    next(e);
  }
});

/**
 * =========================
 * GET /conversations/me
 * List my conversations with listing info + last message
 * =========================
 */
messagesRouter.get("/conversations/me", async (req, res, next) => {
  try {
    const userId = req.user.userId;

    const r = await pool.query(
      `
      SELECT
        c.id AS conversation_id,
        c.status AS conversation_status,
        c.created_at AS conversation_created_at,

        l.id AS listing_id,
        l.title AS listing_title,
        l.price_monthly,
        l.currency,
        l.room_type,
        l.status AS listing_status,

        ci.name AS city,
        ci.country_code,

        -- last message preview
        m.body AS last_message_body,
        m.created_at AS last_message_at,
        m.sender_user_id AS last_message_sender,

        -- unread indicator
        cp.last_read_at
      FROM conversations c
      JOIN conversation_participants cp
        ON cp.conversation_id = c.id AND cp.user_id = $1
      JOIN listings l ON l.id = c.listing_id
      JOIN cities ci ON ci.id = l.city_id
      LEFT JOIN LATERAL (
        SELECT body, created_at, sender_user_id
        FROM messages
        WHERE conversation_id = c.id AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      ) m ON true
      ORDER BY COALESCE(m.created_at, c.created_at) DESC
      `,
      [userId]
    );

    // simple unread flag computed in JS
    const items = r.rows.map((row) => {
      const lastAt = row.last_message_at ? new Date(row.last_message_at) : null;
      const lastRead = row.last_read_at ? new Date(row.last_read_at) : null;
      const unread = lastAt && (!lastRead || lastAt > lastRead);

      return {
        conversationId: row.conversation_id,
        status: row.conversation_status,
        createdAt: row.conversation_created_at,
        listing: {
          id: row.listing_id,
          title: row.listing_title,
          priceMonthly: row.price_monthly,
          currency: row.currency,
          roomType: row.room_type,
          status: row.listing_status,
          city: row.city,
          countryCode: row.country_code
        },
        lastMessage: row.last_message_body
          ? {
              body: row.last_message_body,
              at: row.last_message_at,
              senderUserId: row.last_message_sender
            }
          : null,
        unread
      };
    });

    res.json({ items });
  } catch (e) {
    next(e);
  }
});

/**
 * =========================
 * GET /conversations/:id/messages?limit=50&before=ISO_DATE
 * Pagination:
 *  - before = fetch messages older than this timestamp
 * =========================
 */
messagesRouter.get("/conversations/:id/messages", async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { id: conversationId } = req.params;

    const ok = await ensureConversationAccess(conversationId, userId);
    if (!ok) return res.status(403).json({ error: "No access to conversation" });

    const limit = Math.min(Number(req.query.limit || 50), 100);
    const before = req.query.before ? new Date(req.query.before) : null;

    const params = [conversationId];
    let where = `conversation_id = $1`;

    if (before && !Number.isNaN(before.getTime())) {
      params.push(before.toISOString());
      where += ` AND created_at < $2`;
    }

    const q = await pool.query(
      `
      SELECT id, conversation_id, sender_user_id, body, created_at, edited_at, deleted_at
      FROM messages
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ${limit}
      `,
      params
    );

    // Return newest->oldest (client can reverse if wanted)
    res.json({ items: q.rows });
  } catch (e) {
    next(e);
  }
});

/**
 * =========================
 * POST /conversations/:id/messages
 * Body: { body: string }
 * =========================
 */
const sendMessageSchema = z.object({
  body: z.string().min(1).max(3000)
});

messagesRouter.post("/conversations/:id/messages", async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { id: conversationId } = req.params;

    const ok = await ensureConversationAccess(conversationId, userId);
    if (!ok) return res.status(403).json({ error: "No access to conversation" });

    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const r = await pool.query(
      `
      INSERT INTO messages(conversation_id, sender_user_id, body)
      VALUES($1,$2,$3)
      RETURNING *
      `,
      [conversationId, userId, parsed.data.body]
    );

    res.json(r.rows[0]);
  } catch (e) {
    next(e);
  }
});

/**
 * =========================
 * POST /conversations/:id/read
 * Marks conversation as read (updates last_read_at)
 * =========================
 */
messagesRouter.post("/conversations/:id/read", async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { id: conversationId } = req.params;

    const ok = await ensureConversationAccess(conversationId, userId);
    if (!ok) return res.status(403).json({ error: "No access to conversation" });

    await pool.query(
      `
      UPDATE conversation_participants
      SET last_read_at = now()
      WHERE conversation_id=$1 AND user_id=$2
      `,
      [conversationId, userId]
    );

    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/**
 * =========================
 * PATCH /messages/:id
 * Edit your own message (stores history in message_edits)
 * Body: { body: string }
 * =========================
 */
const editSchema = z.object({
  body: z.string().min(1).max(3000)
});

messagesRouter.patch("/messages/:id", async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { id: messageId } = req.params;

    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    // Load message
    const mQ = await pool.query(
      `SELECT id, conversation_id, sender_user_id, body, deleted_at
       FROM messages
       WHERE id=$1`,
      [messageId]
    );
    if (!mQ.rowCount) return res.status(404).json({ error: "Message not found" });

    const msg = mQ.rows[0];
    if (msg.deleted_at) return res.status(400).json({ error: "Message is deleted" });
    if (msg.sender_user_id !== userId) return res.status(403).json({ error: "Not your message" });

    // Ensure still participant
    const ok = await ensureConversationAccess(msg.conversation_id, userId);
    if (!ok) return res.status(403).json({ error: "No access to conversation" });

    // Compute next version
    const vQ = await pool.query(
      `SELECT COALESCE(MAX(version), 0) AS v
       FROM message_edits
       WHERE message_id=$1`,
      [messageId]
    );
    const nextVersion = Number(vQ.rows[0].v) + 1;

    // Store old body as history
    await pool.query(
      `INSERT INTO message_edits(message_id, version, body, edited_by_user_id)
       VALUES($1,$2,$3,$4)`,
      [messageId, nextVersion, msg.body, userId]
    );

    // Update message body
    const upd = await pool.query(
      `UPDATE messages
       SET body=$2, edited_at=now()
       WHERE id=$1
       RETURNING id, conversation_id, sender_user_id, body, created_at, edited_at`,
      [messageId, parsed.data.body]
    );

    res.json(upd.rows[0]);
  } catch (e) {
    next(e);
  }
});

/**
 * =========================
 * DELETE /messages/:id
 * Soft delete your own message
 * =========================
 */
messagesRouter.delete("/messages/:id", async (req, res, next) => {
  try {
    const userId = req.user.userId;
    const { id: messageId } = req.params;

    const mQ = await pool.query(
      `SELECT id, conversation_id, sender_user_id, deleted_at
       FROM messages
       WHERE id=$1`,
      [messageId]
    );
    if (!mQ.rowCount) return res.status(404).json({ error: "Message not found" });

    const msg = mQ.rows[0];
    if (msg.deleted_at) return res.json({ ok: true }); // already deleted

    if (msg.sender_user_id !== userId) return res.status(403).json({ error: "Not your message" });

    const ok = await ensureConversationAccess(msg.conversation_id, userId);
    if (!ok) return res.status(403).json({ error: "No access to conversation" });

    const upd = await pool.query(
      `UPDATE messages
       SET deleted_at=now()
       WHERE id=$1
       RETURNING id, deleted_at`,
      [messageId]
    );

    res.json({ ok: true, ...upd.rows[0] });
  } catch (e) {
    next(e);
  }
});
