import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { z } from "zod";
import { pool } from "../db.js";

const conversationSchema = z.object({
  conversationId: z.string().uuid()
});

const sendMessageSchema = conversationSchema.extend({
  body: z.string().trim().min(1).max(3000)
});

const editMessageSchema = z.object({
  messageId: z.string().uuid(),
  body: z.string().trim().min(1).max(3000)
});

const deleteMessageSchema = z.object({
  messageId: z.string().uuid()
});

const presenceBatchSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(200)
});

const onlineSocketsByUser = new Map();

function safeAck(ack, payload) {
  if (typeof ack === "function") ack(payload);
}

function conversationRoom(conversationId) {
  return `conversation:${conversationId}`;
}

function userRoom(userId) {
  return `user:${userId}`;
}

function addOnlineSocket(userId, socketId) {
  const key = String(userId);
  const existing = onlineSocketsByUser.get(key) ?? new Set();
  const wasOffline = existing.size === 0;
  existing.add(socketId);
  onlineSocketsByUser.set(key, existing);
  return wasOffline;
}

function removeOnlineSocket(userId, socketId) {
  const key = String(userId);
  const existing = onlineSocketsByUser.get(key);
  if (!existing) return false;

  existing.delete(socketId);
  if (existing.size === 0) {
    onlineSocketsByUser.delete(key);
    return true;
  }

  onlineSocketsByUser.set(key, existing);
  return false;
}

function isUserOnline(userId) {
  const key = String(userId);
  const existing = onlineSocketsByUser.get(key);
  return Boolean(existing && existing.size > 0);
}

function normalizeToken(value) {
  if (!value || typeof value !== "string") return null;
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length) : value;
}

function tokenFromHandshake(socket) {
  const authToken = normalizeToken(socket.handshake.auth?.token);
  if (authToken) return authToken;

  const headerToken = normalizeToken(socket.handshake.headers?.authorization);
  return headerToken || null;
}

function socketError(message, details) {
  return { ok: false, error: message, details: details ?? null };
}

function socketOk(payload = {}) {
  return { ok: true, ...payload };
}

function socketCorsOrigin(rawValue) {
  if (!rawValue) return true;
  const origins = rawValue
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (origins.length === 0) return true;
  return origins.length === 1 ? origins[0] : origins;
}

async function ensureConversationAccess(conversationId, userId) {
  const r = await pool.query(
    `SELECT 1
     FROM conversation_participants
     WHERE conversation_id=$1 AND user_id=$2`,
    [conversationId, userId]
  );
  return r.rowCount > 0;
}

async function joinAllUserConversationRooms(socket, userId) {
  const r = await pool.query(
    `SELECT conversation_id
     FROM conversation_participants
     WHERE user_id=$1`,
    [userId]
  );

  const conversationIds = [];
  for (const row of r.rows) {
    conversationIds.push(row.conversation_id);
    socket.join(conversationRoom(row.conversation_id));
  }

  return conversationIds;
}

async function emitPresenceForUser(io, userId, isOnline) {
  const r = await pool.query(
    `SELECT conversation_id
     FROM conversation_participants
     WHERE user_id=$1`,
    [userId]
  );

  const payload = {
    userId,
    isOnline: Boolean(isOnline),
    updatedAt: new Date().toISOString()
  };

  for (const row of r.rows) {
    io.to(conversationRoom(row.conversation_id)).emit("presence:update", payload);
  }
}

export function initChatSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: socketCorsOrigin(process.env.CORS_ORIGIN),
      credentials: true
    }
  });

  io.use((socket, next) => {
    try {
      const token = tokenFromHandshake(socket);
      if (!token) return next(new Error("Missing token"));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (!decoded || typeof decoded !== "object" || !decoded.userId) {
        return next(new Error("Invalid token payload"));
      }

      socket.data.user = {
        userId: decoded.userId,
        role: decoded.role ?? "USER"
      };

      return next();
    } catch {
      return next(new Error("Invalid token"));
    }
  });

  io.on("connection", (socket) => {
    const { userId } = socket.data.user;
    const becameOnline = addOnlineSocket(userId, socket.id);

    socket.join(userRoom(userId));
    joinAllUserConversationRooms(socket, userId).catch((err) => {
      console.error("Failed to auto-join conversation rooms:", err.message);
    });

    if (becameOnline) {
      emitPresenceForUser(io, userId, true).catch((err) => {
        console.error("Failed to emit online presence:", err.message);
      });
    }

    socket.emit("chat:ready", { userId });

    socket.on("disconnect", () => {
      const becameOffline = removeOnlineSocket(userId, socket.id);
      if (becameOffline) {
        emitPresenceForUser(io, userId, false).catch((err) => {
          console.error("Failed to emit offline presence:", err.message);
        });
      }
    });

    socket.on("presence:batch", (payload, ack) => {
      try {
        const parsed = presenceBatchSchema.safeParse(payload);
        if (!parsed.success) {
          return safeAck(ack, socketError("Invalid payload", parsed.error.flatten()));
        }

        const uniqueIds = [...new Set(parsed.data.userIds.map((id) => String(id)))];
        const items = uniqueIds.map((id) => ({
          userId: id,
          isOnline: isUserOnline(id)
        }));

        return safeAck(ack, socketOk({ items }));
      } catch (err) {
        return safeAck(ack, socketError(err.message || "Failed to load presence"));
      }
    });

    socket.on("conversation:join", async (payload, ack) => {
      try {
        const parsed = conversationSchema.safeParse(payload);
        if (!parsed.success) {
          return safeAck(ack, socketError("Invalid payload", parsed.error.flatten()));
        }

        const { conversationId } = parsed.data;
        const ok = await ensureConversationAccess(conversationId, userId);
        if (!ok) return safeAck(ack, socketError("No access to conversation"));

        socket.join(conversationRoom(conversationId));
        return safeAck(ack, socketOk({ conversationId }));
      } catch (err) {
        return safeAck(ack, socketError(err.message || "Failed to join conversation"));
      }
    });

    socket.on("conversation:leave", (payload, ack) => {
      try {
        const parsed = conversationSchema.safeParse(payload);
        if (!parsed.success) {
          return safeAck(ack, socketError("Invalid payload", parsed.error.flatten()));
        }

        socket.leave(conversationRoom(parsed.data.conversationId));
        return safeAck(ack, socketOk({ conversationId: parsed.data.conversationId }));
      } catch (err) {
        return safeAck(ack, socketError(err.message || "Failed to leave conversation"));
      }
    });

    socket.on("message:send", async (payload, ack) => {
      try {
        const parsed = sendMessageSchema.safeParse(payload);
        if (!parsed.success) {
          return safeAck(ack, socketError("Invalid payload", parsed.error.flatten()));
        }

        const { conversationId, body } = parsed.data;
        const ok = await ensureConversationAccess(conversationId, userId);
        if (!ok) return safeAck(ack, socketError("No access to conversation"));

        const inserted = await pool.query(
          `INSERT INTO messages(conversation_id, sender_user_id, body)
           VALUES($1,$2,$3)
           RETURNING id, conversation_id, sender_user_id, body, created_at, edited_at, deleted_at`,
          [conversationId, userId, body]
        );

        await pool.query(
          `UPDATE conversation_participants
           SET last_read_at=now()
           WHERE conversation_id=$1 AND user_id=$2`,
          [conversationId, userId]
        );

        const message = inserted.rows[0];
        io.to(conversationRoom(conversationId)).emit("message:new", { message });
        return safeAck(ack, socketOk({ message }));
      } catch (err) {
        return safeAck(ack, socketError(err.message || "Failed to send message"));
      }
    });

    socket.on("message:edit", async (payload, ack) => {
      try {
        const parsed = editMessageSchema.safeParse(payload);
        if (!parsed.success) {
          return safeAck(ack, socketError("Invalid payload", parsed.error.flatten()));
        }

        const { messageId, body } = parsed.data;

        const messageQ = await pool.query(
          `SELECT id, conversation_id, sender_user_id, body, deleted_at
           FROM messages
           WHERE id=$1`,
          [messageId]
        );

        if (!messageQ.rowCount) return safeAck(ack, socketError("Message not found"));

        const existing = messageQ.rows[0];
        if (existing.deleted_at) return safeAck(ack, socketError("Message is deleted"));
        if (existing.sender_user_id !== userId) return safeAck(ack, socketError("Not your message"));

        const ok = await ensureConversationAccess(existing.conversation_id, userId);
        if (!ok) return safeAck(ack, socketError("No access to conversation"));

        const versionQ = await pool.query(
          `SELECT COALESCE(MAX(version), 0) AS v
           FROM message_edits
           WHERE message_id=$1`,
          [messageId]
        );
        const nextVersion = Number(versionQ.rows[0].v) + 1;

        await pool.query(
          `INSERT INTO message_edits(message_id, version, body, edited_by_user_id)
           VALUES($1,$2,$3,$4)`,
          [messageId, nextVersion, existing.body, userId]
        );

        const updated = await pool.query(
          `UPDATE messages
           SET body=$2, edited_at=now()
           WHERE id=$1
           RETURNING id, conversation_id, sender_user_id, body, created_at, edited_at, deleted_at`,
          [messageId, body]
        );

        const message = updated.rows[0];
        io.to(conversationRoom(message.conversation_id)).emit("message:updated", { message });
        return safeAck(ack, socketOk({ message }));
      } catch (err) {
        return safeAck(ack, socketError(err.message || "Failed to edit message"));
      }
    });

    socket.on("message:delete", async (payload, ack) => {
      try {
        const parsed = deleteMessageSchema.safeParse(payload);
        if (!parsed.success) {
          return safeAck(ack, socketError("Invalid payload", parsed.error.flatten()));
        }

        const { messageId } = parsed.data;

        const messageQ = await pool.query(
          `SELECT id, conversation_id, sender_user_id, deleted_at
           FROM messages
           WHERE id=$1`,
          [messageId]
        );

        if (!messageQ.rowCount) return safeAck(ack, socketError("Message not found"));

        const existing = messageQ.rows[0];
        if (existing.deleted_at) return safeAck(ack, socketOk({ messageId, alreadyDeleted: true }));
        if (existing.sender_user_id !== userId) return safeAck(ack, socketError("Not your message"));

        const ok = await ensureConversationAccess(existing.conversation_id, userId);
        if (!ok) return safeAck(ack, socketError("No access to conversation"));

        const deleted = await pool.query(
          `UPDATE messages
           SET deleted_at=now()
           WHERE id=$1
           RETURNING id, conversation_id, deleted_at`,
          [messageId]
        );

        const message = deleted.rows[0];
        io.to(conversationRoom(message.conversation_id)).emit("message:deleted", {
          messageId: message.id,
          conversationId: message.conversation_id,
          deletedAt: message.deleted_at,
          deletedByUserId: userId
        });

        return safeAck(ack, socketOk({ message }));
      } catch (err) {
        return safeAck(ack, socketError(err.message || "Failed to delete message"));
      }
    });

    socket.on("conversation:read", async (payload, ack) => {
      try {
        const parsed = conversationSchema.safeParse(payload);
        if (!parsed.success) {
          return safeAck(ack, socketError("Invalid payload", parsed.error.flatten()));
        }

        const { conversationId } = parsed.data;
        const ok = await ensureConversationAccess(conversationId, userId);
        if (!ok) return safeAck(ack, socketError("No access to conversation"));

        const updated = await pool.query(
          `UPDATE conversation_participants
           SET last_read_at=now()
           WHERE conversation_id=$1 AND user_id=$2
           RETURNING last_read_at`,
          [conversationId, userId]
        );

        const readAt = updated.rows[0]?.last_read_at ?? null;

        io.to(conversationRoom(conversationId)).emit("conversation:read", {
          conversationId,
          userId,
          readAt
        });

        return safeAck(ack, socketOk({ conversationId, readAt }));
      } catch (err) {
        return safeAck(ack, socketError(err.message || "Failed to mark conversation as read"));
      }
    });
  });

  return io;
}
