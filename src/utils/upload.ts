import multer from "multer";
import fs from "fs";
import path from "path";

type UploadKind = "avatar" | "vehicle";

export function ensureDir(p: string) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export async function saveBufferToFile(fullPath: string, buf: Buffer) {
    ensureDir(path.dirname(fullPath));
    await fs.promises.writeFile(fullPath, buf);
}

export async function safeUnlink(fullPath: string) {
    try {
        await fs.promises.unlink(fullPath);
    } catch { }
}

export function buildUploadTarget(kind: "avatar" | "vehicle", userRef: string, originalname?: string) {
    const ts = Date.now();
    const ext = (originalname && path.extname(originalname)) || ".jpg";
    const base = kind === "vehicle" ? "vehicle" : "avatar";
    const filename = `${base}_${userRef}_${ts}${ext}`;
    const dir = kind === "vehicle" ? path.join("uploads", "vehicles") : path.join("uploads", "avatars");
    const diskPath = path.join(dir, filename);
    const publicPath = `/${dir.replace(/\\/g, "/")}/${filename}`;
    return { filename, dir, diskPath, publicPath };
}


const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function fileFilter(_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) {
    if (allowed.has(file.mimetype)) return cb(null, true);
    cb(new Error("INVALID_FILE_TYPE"));
}

export const uploadMedia = multer({
    storage: multer.memoryStorage(),
    fileFilter,
    limits: { fileSize: 64 * 1024 * 1024 },
});
