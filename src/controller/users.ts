import { Router } from "express";
import { ResultSetHeader, RowDataPacket } from "mysql2";

import { asyncHandler } from "../middleware/asyncHandler";
import { hashPassword, verifyPassword } from "../utils/password";
import { uploadMedia, buildUploadTarget, saveBufferToFile, safeUnlink, } from "../utils/upload";
import { conn } from "../lib/db";

const router = Router();
export default router;

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;

router.post(
    "/members",
    uploadMedia.single("avatarFile"),
    asyncHandler(async (req, res) => {
        const body = req.body as any;
        const {
            username,
            password,
            role,
            name,
            phone,
            placeName,
            address,
            lat,
            lng,
        } = body;

        if (role !== "MEMBER") {
            return res
                .status(400)
                .json({ error: { code: "BAD_ROLE", message: "role ต้องเป็น MEMBER สำหรับ endpoint นี้" } });
        }
        if (!username || !password || !name || !phone || !address || !placeName) {
            return res.status(400).json({
                error: { code: "MISSING", message: "ต้องมี username, password, name, phone, placeName, address" },
            });
        }
        if (!USERNAME_RE.test(username)) {
            return res.status(400).json({
                error: { code: "BAD_USERNAME", message: "username ต้องเป็น a-z, 0-9, _ ความยาว 3–30 ตัวอักษร" },
            });
        }

        const latNum = Number(lat);
        const lngNum = Number(lng);
        if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
            return res.status(400).json({
                error: { code: "BAD_COORDS", message: "lat/lng ต้องเป็นตัวเลข" },
            });
        }

        if (!req.file) {
            return res
                .status(400)
                .json({ error: { code: "MISSING_AVATAR", message: "ต้องอัปโหลดรูปโปรไฟล์" } });
        }

        const { diskPath: avatarDiskPath, publicPath: avatarPublicPath } =
            buildUploadTarget("avatar", username, req.file.originalname);


        const password_hash = await hashPassword(password);
        const connTx = await conn.getConnection();
        let avatarWritten = false;

        try {
            await connTx.beginTransaction();

            const [r] = await connTx.execute<ResultSetHeader>(
                `INSERT INTO users(role, phone, username, password_hash, name, avatar_path)
         VALUES(?,?,?,?,?,?)`,
                ["MEMBER", phone, username, password_hash, name, avatarPublicPath]
            );
            const userId = r.insertId;

            await connTx.execute<ResultSetHeader>(
                `INSERT INTO addresses(user_id, label, address_text, lat, lng, is_default)
         VALUES(?,?,?,?,?,1)`,
                [userId, placeName, address, latNum, lngNum]
            );

            // เขียนไฟล์จริงหลัง INSERT ผ่าน (ก่อน commit)
            await saveBufferToFile(avatarDiskPath, req.file.buffer);
            avatarWritten = true;

            const [rows] = await connTx.query<RowDataPacket[]>(
                `SELECT id, role, phone, username, name, avatar_path, created_at, updated_at
         FROM users WHERE id=?`,
                [userId]
            );

            await connTx.commit();

            return res.status(201).json({
                ...rows[0],
                default_address: {
                    label: placeName,
                    address_text: address,
                    lat: latNum,
                    lng: lngNum,
                    is_default: 1,
                },
            });
        } catch (err: any) {
            await connTx.rollback();

            if (avatarWritten) await safeUnlink(avatarDiskPath);

            if (err?.code === "ER_DUP_ENTRY") {
                const msg = (err.sqlMessage || "");
                const human =
                    msg.includes("uniq_users_username") || msg.includes("username")
                        ? { code: "USERNAME_TAKEN", message: "username นี้ถูกใช้แล้ว" }
                        : { code: "PHONE_TAKEN", message: "เบอร์นี้ถูกใช้แล้ว" };
                return res.status(409).json({ error: human });
            }
            throw err;
        } finally {
            connTx.release();
        }
    })
);

router.post(
    "/riders",
    uploadMedia.fields([
        { name: "avatarFile", maxCount: 1 },
        { name: "vehiclePhotoFile", maxCount: 1 },
    ]),
    asyncHandler(async (req, res) => {
        const {
            username,
            password,
            role,
            name,
            phone,
            vehicle_plate,
            vehicle_model,
            vehicle_photo_path,
        } = req.body as Record<string, string>;

        if (role !== "RIDER") {
            return res
                .status(400)
                .json({ error: { code: "BAD_ROLE", message: "role ต้องเป็น RIDER" } });
        }
        if (!username || !password || !name || !phone || !vehicle_plate) {
            return res.status(400).json({
                error: { code: "MISSING", message: "ต้องมี username, password, name, phone, vehicle_plate อย่างน้อย" },
            });
        }
        if (!USERNAME_RE.test(username)) {
            return res.status(400).json({
                error: { code: "BAD_USERNAME", message: "username ต้องเป็น a-z, 0-9, _ ความยาว 3–30 ตัวอักษร" },
            });
        }

        const avatarFile = (req.files as any)?.avatarFile?.[0] || null;
        const vehicleFile = (req.files as any)?.vehiclePhotoFile?.[0] || null;

        const avatarTarget = avatarFile ? buildUploadTarget("avatar", username, avatarFile.originalname) : null;
        const vehicleTarget = vehicleFile ? buildUploadTarget("vehicle", username, vehicleFile.originalname) : null;

        const avatarPublicPath = avatarTarget?.publicPath || null;
        const vehiclePublicPath = vehicleTarget?.publicPath || vehicle_photo_path || null;

        const password_hash = await hashPassword(password);

        const tx = await conn.getConnection();
        let wroteAvatar = false;
        let wroteVehicle = false;

        try {
            await tx.beginTransaction();

            const [u] = await tx.execute<ResultSetHeader>(
                `INSERT INTO users (role, phone, username, password_hash, name, avatar_path)
         VALUES (?,?,?,?,?,?)`,
                ["RIDER", phone.trim(), username.trim(), password_hash, name.trim(), avatarPublicPath]
            );
            const userId = u.insertId;

            await tx.execute<ResultSetHeader>(
                `INSERT INTO rider_profiles (user_id, vehicle_plate, vehicle_model, vehicle_photo_path, is_active)
         VALUES (?,?,?,?,1)`,
                [
                    userId,
                    vehicle_plate.trim(),
                    (vehicle_model || null)?.toString().trim() || null,
                    vehiclePublicPath,
                ]
            );

            if (avatarFile && avatarTarget) {
                await saveBufferToFile(avatarTarget.diskPath, avatarFile.buffer);
                wroteAvatar = true;
            }
            if (vehicleFile && vehicleTarget) {
                await saveBufferToFile(vehicleTarget.diskPath, vehicleFile.buffer);
                wroteVehicle = true;
            }

            const [[user]]: any = await tx.query<RowDataPacket[]>(
                `SELECT id, role, phone, username, name, avatar_path, created_at, updated_at
         FROM users WHERE id = ?`,
                [userId]
            );
            const [[profile]]: any = await tx.query<RowDataPacket[]>(
                `SELECT user_id, vehicle_plate, vehicle_model, vehicle_photo_path, is_active
         FROM rider_profiles WHERE user_id = ?`,
                [userId]
            );

            await tx.commit();
            return res.status(201).json({ ...user, rider_profile: profile });
        } catch (err: any) {
            await tx.rollback();

            if (wroteAvatar && avatarTarget) await safeUnlink(avatarTarget.diskPath);
            if (wroteVehicle && vehicleTarget) await safeUnlink(vehicleTarget.diskPath);

            if (err?.code === "ER_DUP_ENTRY") {
                const msg = (err.sqlMessage || "");
                if (msg.includes("uniq_users_username") || msg.includes("username")) {
                    return res
                        .status(409)
                        .json({ error: { code: "USERNAME_TAKEN", message: "username นี้ถูกใช้แล้ว" } });
                }
                if (msg.includes("uniq_users_phone") || msg.includes("phone")) {
                    return res
                        .status(409)
                        .json({ error: { code: "PHONE_TAKEN", message: "เบอร์นี้ถูกใช้แล้ว" } });
                }
                if (msg.includes("uniq_vehicle_plate") || msg.includes("vehicle_plate")) {
                    return res
                        .status(409)
                        .json({ error: { code: "VEHICLE_PLATE_TAKEN", message: "ทะเบียนรถนี้ถูกใช้แล้ว" } });
                }
            }
            throw err;
        } finally {
            tx.release();
        }
    })
);

router.post(
    "/login",
    asyncHandler(async (req, res) => {
        const { identifier, password } = req.body as {
            identifier: string;
            password: string;
        };

        if (!identifier || !password) {
            return res.status(400).json({
                error: {
                    code: "MISSING",
                    message: "ต้องมี identifier (username หรือ phone), password",
                },
            });
        }

        const isUsernameLike = USERNAME_RE.test(identifier);

        let rows: RowDataPacket[];
        if (isUsernameLike) {
            [rows] = await conn.query<RowDataPacket[]>(
                `SELECT * FROM users WHERE username = ? LIMIT 1`,
                [identifier]
            );
            if (rows.length === 0) {
                [rows] = await conn.query<RowDataPacket[]>(
                    `SELECT * FROM users WHERE phone = ? LIMIT 1`,
                    [identifier]
                );
            }
        } else {
            [rows] = await conn.query<RowDataPacket[]>(
                `SELECT * FROM users WHERE phone = ? LIMIT 1`,
                [identifier]
            );
            if (rows.length === 0) {
                [rows] = await conn.query<RowDataPacket[]>(
                    `SELECT * FROM users WHERE username = ? LIMIT 1`,
                    [identifier]
                );
            }
        }

        const user: any = rows[0];
        if (!user) {
            return res.status(401).json({
                error: {
                    code: "INVALID_CREDENTIALS",
                    message: "ชื่อผู้ใช้หรือเบอร์ ไม่ถูกต้อง",
                },
            });
        }

        const ok = await verifyPassword(password, user.password_hash);
        if (!ok) {
            return res.status(401).json({
                error: {
                    code: "INVALID_CREDENTIALS",
                    message: "รหัสผ่านไม่ถูกต้อง",
                },
            });
        }

        delete user.password_hash;
        res.json({
            id: user.id,
            role: user.role,
            phone: user.phone,
            username: user.username,
            name: user.name,
            avatar_path: user.avatar_path,
            created_at: user.created_at,
            updated_at: user.updated_at,
        });
    })
);

router.get(
    "/:id",
    asyncHandler(async (req, res) => {
        const [rows] = await conn.query<RowDataPacket[]>(
            `SELECT id, role, phone, username, name, avatar_path, created_at, updated_at
         FROM users WHERE id=?`,
            [req.params.id]
        );
        if ((rows as any).length === 0) {
            return res
                .status(404)
                .json({ error: { code: "NOT_FOUND", message: "ไม่พบผู้ใช้" } });
        }
        res.json((rows as any)[0]);
    })
);