import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";

import { authRouter } from "./routes/auth.routes.js";
import { listingsRouter } from "./routes/listings.routes.js";
import { adminRouter } from "./routes/admin.routes.js";
import { metaRouter } from "./routes/meta.routes.js";
import { messagesRouter } from "./routes/messages.routes.js";

import { pool } from "./db.js";


dotenv.config();
console.log("DATABASE_URL =", process.env.DATABASE_URL);
const app = express();
app.use(helmet());
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));
app.use(cors({ origin: process.env.CORS_ORIGIN, credentials: true }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/listings", listingsRouter);
app.use("/admin", adminRouter);

//meta data for ease of use
app.use("/meta", metaRouter);

//Message API
app.use("/", messagesRouter);

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => console.log(`API running http://localhost:${PORT}`));


app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Internal Server Error" });
});


