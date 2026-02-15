# RentMate Backend

Express + PostgreSQL API for authentication, listings, admin moderation, media uploads, and real-time chat.

## Features

- JWT-based authentication
- User profile management (including avatar uploads)
- Listing CRUD + photo uploads
- Listings search/filter API
- Admin review and moderation routes
- Conversations/messages API
- Real-time messaging and presence via Socket.IO
- Media serving from `/uploads`

## Tech Stack

- Node.js (ES Modules)
- Express 5
- PostgreSQL (`pg`)
- Socket.IO
- Zod validation
- Multer for uploads
- Argon2 password hashing

## Prerequisites

- Node.js 18+
- npm 9+
- PostgreSQL 14+

## Environment Variables

Create `server/.env`:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/rentmate
JWT_SECRET=replace_with_a_secure_secret
CORS_ORIGIN=http://localhost:5173
PORT=4000
PUBLIC_BASE_URL=http://localhost:4000
```

### Variable Notes

- `DATABASE_URL`: PostgreSQL connection string.
- `JWT_SECRET`: used for JWT signing/verification.
- `CORS_ORIGIN`: frontend origin allowed to call API/socket.
- `PORT`: API/socket port (default `4000`).
- `PUBLIC_BASE_URL`: optional absolute base URL for media links.

## Installation

```bash
cd server
npm install
```

## Database Setup

Run schema SQL on your target database before first run:

```bash
psql "$DATABASE_URL" -f src/sql/001_init.sql
psql "$DATABASE_URL" -f src/sql/002_media_location.sql
```

## Run (Development)

```bash
npm run dev
```

API + WebSocket run on `http://localhost:4000` by default.

## Health Check

```http
GET /health
```

Response:

```json
{ "ok": true }
```

## Main Route Groups

- `POST /auth/*` and `GET /auth/me`
- `GET/POST/PATCH/DELETE /listings/*`
- `GET /meta/*`
- `GET/POST /conversations/*` and `GET/PATCH/DELETE /messages/*`
- `GET/POST /admin/*`

## Uploads

- Stored on disk under `server/uploads/`
- Publicly served via `/uploads/...`
- `uploads/` is ignored by git

## Project Structure

```text
src/
  middleware/     # auth + upload middleware
  routes/         # REST route modules
  socket/         # Socket.IO handlers/events
  sql/            # SQL initialization/migration scripts
  db.js           # PostgreSQL pool + migration helper
  server.js       # App bootstrap
```

## Notes

- `ensureSchemaMigrations()` runs on startup for additive DB changes.
- For production, run behind HTTPS and use strong secrets.
- Configure reverse proxy headers if deploying behind a load balancer.