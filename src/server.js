import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";

import { authRouter } from "./routes/auth.routes.js";
import { listingsRouter } from "./routes/listings.routes.js";
import { adminRouter } from "./routes/admin.routes.js";
import { metaRouter } from "./routes/meta.routes.js";
import { messagesRouter } from "./routes/messages.routes.js";
import { initChatSocket } from "./socket/chat.socket.js";
import { ensureSchemaMigrations } from "./db.js";


dotenv.config();
console.log("DATABASE_URL =", process.env.DATABASE_URL);
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsRoot = path.resolve(__dirname, "../uploads");

app.use(
  helmet({
    // Allow images/files from /uploads to render when frontend runs on a different origin (e.g. localhost:5173)
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "img-src": ["'self'", "data:", "blob:", "http:", "https:"],
        "upgrade-insecure-requests": null
      }
    }
  })
);
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));
app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));
app.use(
  "/uploads",
  (_req, res, next) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    next();
  },
  express.static(uploadsRoot)
);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/listings", listingsRouter);
app.use("/admin", adminRouter);

//meta data for ease of use
app.use("/meta", metaRouter);

//Message API
app.use("/", messagesRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Internal Server Error" });
});

const PORT = Number(process.env.PORT || 4000);
const httpServer = createServer(app);
initChatSocket(httpServer);

async function start() {
  await ensureSchemaMigrations();
  httpServer.listen(PORT, () => console.log(`API + WebSocket running http://localhost:${PORT}`));
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});


