import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsRoot = path.resolve(__dirname, "../../uploads");
export const USER_PROFILE_UPLOAD_SUBFOLDER = "userprofiles";
export const LISTING_UPLOAD_SUBFOLDER = "listings photos";

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function buildStorage(subFolder) {
  return multer.diskStorage({
    destination: (_req, _file, cb) => {
      const targetDir = path.join(uploadsRoot, subFolder);
      ensureDir(targetDir);
      cb(null, targetDir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      cb(null, `${unique}${ext}`);
    }
  });
}

function imageFileFilter(_req, file, cb) {
  if (!file.mimetype || !file.mimetype.startsWith("image/")) {
    return cb(new Error("Only image files are allowed"));
  }
  return cb(null, true);
}

const baseUploadOptions = {
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: imageFileFilter
};

export const uploadListingPhoto = multer({
  storage: buildStorage(LISTING_UPLOAD_SUBFOLDER),
  ...baseUploadOptions
});

export const uploadUserPhoto = multer({
  storage: buildStorage(USER_PROFILE_UPLOAD_SUBFOLDER),
  ...baseUploadOptions
});

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function getServerBaseUrl(req) {
  const configured = normalizeBaseUrl(process.env.PUBLIC_BASE_URL);
  if (configured) return configured;

  if (!req) return "";

  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();

  const protocol = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.get("host");
  if (!host) return "";

  return `${protocol}://${host}`;
}

function buildRelativeUploadUrl(subFolder, filename) {
  const safeFolder = String(subFolder || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const safeFile = encodeURIComponent(String(filename || ""));
  return `/uploads/${safeFolder}/${safeFile}`;
}

export function toPublicUploadUrl(req, subFolder, filename) {
  const relativeUrl = buildRelativeUploadUrl(subFolder, filename);
  const baseUrl = getServerBaseUrl(req);
  if (!baseUrl) return relativeUrl;
  return `${baseUrl}${relativeUrl}`;
}

export function resolveUploadedMediaUrl(req, maybeUrl) {
  if (!maybeUrl || typeof maybeUrl !== "string") return maybeUrl;
  if (/^https?:\/\//i.test(maybeUrl)) return maybeUrl;

  const baseUrl = getServerBaseUrl(req);
  if (!baseUrl) return maybeUrl;

  if (maybeUrl.startsWith("/")) return `${baseUrl}${maybeUrl}`;
  return `${baseUrl}/${maybeUrl}`;
}

export function toAbsoluteUploadPath(publicUrl) {
  if (!publicUrl || typeof publicUrl !== "string") return null;
  let pathName = publicUrl;
  if (/^https?:\/\//i.test(publicUrl)) {
    try {
      pathName = new URL(publicUrl).pathname;
    } catch {
      return null;
    }
  }

  let decodedPath = pathName;
  try {
    decodedPath = decodeURIComponent(pathName);
  } catch {
    decodedPath = pathName;
  }

  if (!decodedPath.startsWith("/uploads/")) return null;

  const clean = decodedPath.replace(/^\/uploads\//, "");
  const safe = clean.replace(/\.\./g, "");
  return path.join(uploadsRoot, safe);
}

export { uploadsRoot };
