import multer from "multer";
import fs from "fs";
import path from "path";

type UploadKind = "avatar" | "vehicle" | "shipment";

export function ensureDir(p: string) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

export async function saveBufferToFile(fullPath: string, buf: Buffer) {
    ensureDir(path.dirname(fullPath));
    await fs.promises.writeFile(fullPath, buf);
}

export async function safeUnlink(fullPath: string) {
    try { await fs.promises.unlink(fullPath); } catch { }
}

export function buildUploadTarget(kind: UploadKind, ref: string, originalname?: string) {
    const ts = Date.now();
    const ext = (originalname && path.extname(originalname)) || ".jpg";

    let base = "file";
    let dir = path.join("uploads");

    if (kind === "avatar") {
        base = "avatar";
        dir = path.join("uploads", "avatars");
    } else if (kind === "vehicle") {
        base = "vehicle";
        dir = path.join("uploads", "vehicles");
    } else if (kind === "shipment") {
        base = "shipment";
        dir = path.join("uploads", "shipments", ref);
    }

    const filename = `${base}_${ref}_${ts}${ext}`;
    const diskPath = path.join(dir, filename);
    const publicPath = `/${dir.replace(/\\/g, "/")}/${filename}`;
    return { filename, dir, diskPath, publicPath };
}


// --- NEW: ยืดหยุ่น mimetype / extension ---
const allowedExt = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif"]);

function fileFilter(_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) {
    const mt = (file.mimetype || "").toLowerCase();

    // 1) อนุญาตรูปทั้งหมดแบบกว้าง
    if (mt.startsWith("image/")) return cb(null, true);

    // 2) mimetype เพี้ยน → ใช้นามสกุลไฟล์ช่วยตัดสิน
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (allowedExt.has(ext)) return cb(null, true);

    // 3) กรณีพิเศษ: บางเคสได้ application/octet-stream แต่ไฟล์เป็นรูปจริงจากนามสกุล
    if (mt === "application/octet-stream" && allowedExt.has(ext)) {
        return cb(null, true);
    }

    return cb(new Error("INVALID_FILE_TYPE"));
}

export const uploadMedia = multer({
    storage: multer.memoryStorage(),
    fileFilter,
    limits: { fileSize: 64 * 1024 * 1024 },
});