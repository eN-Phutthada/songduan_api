import { Router, Request, Response } from "express";
import { conn } from "../lib/db"; // expect mysql2/promise pool
import { asyncHandler } from "../middleware/asyncHandler";

const router = Router();
export default router;

// ---------- tiny validators ----------

function toNumber(v: any): number | null {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
}

function toBool(v: any, fallback = false): boolean {
    if (typeof v === "boolean") return v;
    if (v === 1 || v === "1" || v === "true" || v === "TRUE") return true;
    if (v === 0 || v === "0" || v === "false" || v === "FALSE") return false;
    return fallback;
}

function nonEmptyString(v: any): v is string {
    return typeof v === "string" && v.trim().length > 0;
}

function assertLatLng(lat: number | null, lng: number | null) {
    if (lat === null || lng === null) throw badRequest("lat/lng is required");
    if (lat < -90 || lat > 90) throw badRequest("lat must be between -90 and 90");
    if (lng < -180 || lng > 180) throw badRequest("lng must be between -180 and 180");
}

function badRequest(message: string, extra?: any) {
    const err: any = new Error(message);
    err.status = 400;
    if (extra) err.extra = extra;
    return err;
}

// ---------- helpers ----------
async function ensureUserExists(userId: number) {
    const [rows] = await conn.query("SELECT id FROM users WHERE id = ?", [userId]);
    const arr = rows as Array<{ id: number }>;
    if (!arr.length) throw badRequest("user not found");
}

async function setDefaultWithinTx(tx: any, userId: number, addressId: number) {
    // unset other defaults for this user, then set this one
    await tx.query("UPDATE addresses SET is_default = 0 WHERE user_id = ?", [userId]);
    await tx.query("UPDATE addresses SET is_default = 1 WHERE id = ? AND user_id = ?", [addressId, userId]);
}

function parsePagination(req: Request) {
    const page = Math.max(1, Number(req.query.page ?? 1));
    const pageSize = Math.max(1, Math.min(100, Number(req.query.pageSize ?? 20)));
    const offset = (page - 1) * pageSize;
    return { page, pageSize, offset };
}

// ---------- routes ----------

// List addresses by user
router.get(
    "/users/:userId/addresses",
    asyncHandler(async (req: Request, res: Response) => {
        const userId = Number(req.params.userId);
        if (!Number.isInteger(userId) || userId <= 0) throw badRequest("invalid userId");

        const { page, pageSize, offset } = parsePagination(req);

        const [rows] = await conn.query(
            "SELECT SQL_CALC_FOUND_ROWS id, user_id, label, address_text, lat, lng, is_default, default_owner, created_at FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC LIMIT ? OFFSET ?",
            [userId, pageSize, offset]
        );
        const data = rows as any[];

        const [totalRows] = await conn.query("SELECT FOUND_ROWS() AS total");
        const total = (totalRows as any[])[0]?.total ?? 0;

        res.json({ data, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
    })
);

// Get one address by id
router.get(
    "/addresses/:id",
    asyncHandler(async (req: Request, res: Response) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) throw badRequest("invalid id");

        const [rows] = await conn.query(
            "SELECT id, user_id, label, address_text, lat, lng, is_default, default_owner, created_at FROM addresses WHERE id = ?",
            [id]
        );
        const data = (rows as any[])[0];
        if (!data) return res.status(404).json({ error: "not found" });
        res.json({ data });
    })
);

// Create address for a user
router.post(
    "/users/:userId/addresses",
    asyncHandler(async (req: Request, res: Response) => {
        const userId = Number(req.params.userId);
        if (!Number.isInteger(userId) || userId <= 0) throw badRequest("invalid userId");

        await ensureUserExists(userId);

        const labelRaw = req.body?.label;
        const addressTextRaw = req.body?.address_text;
        const lat = toNumber(req.body?.lat);
        const lng = toNumber(req.body?.lng);
        const isDefault = toBool(req.body?.is_default, false);

        if (!nonEmptyString(addressTextRaw)) throw badRequest("address_text is required");
        assertLatLng(lat, lng);

        const label = nonEmptyString(labelRaw) ? String(labelRaw).trim() : null;

        const tx = await conn.getConnection();
        try {
            await tx.beginTransaction();

            const [result] = await tx.query(
                "INSERT INTO addresses (user_id, label, address_text, lat, lng, is_default) VALUES (?, ?, ?, ?, ?, ?)",
                [userId, label, addressTextRaw.trim(), lat, lng, isDefault ? 1 : 0]
            );

            const insertId = (result as any).insertId as number;

            if (isDefault) {
                await setDefaultWithinTx(tx, userId, insertId);
            }

            await tx.commit();

            const [rows] = await conn.query(
                "SELECT id, user_id, label, address_text, lat, lng, is_default, default_owner, created_at FROM addresses WHERE id = ?",
                [insertId]
            );

            res.status(201).json({ data: (rows as any[])[0] });
        } catch (e) {
            try { await tx.rollback(); } catch { }
            throw e;
        } finally {
            tx.release();
        }
    })
);

// Update an address
router.patch(
    "/addresses/:id",
    asyncHandler(async (req: Request, res: Response) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) throw badRequest("invalid id");

        // read existing to know user_id
        const [existingRows] = await conn.query("SELECT * FROM addresses WHERE id = ?", [id]);
        const existing = (existingRows as any[])[0];
        if (!existing) return res.status(404).json({ error: "not found" });

        const userId = existing.user_id as number;

        const updates: string[] = [];
        const params: any[] = [];

        if (req.body?.label !== undefined) {
            const lbl = nonEmptyString(req.body.label) ? String(req.body.label).trim() : null;
            updates.push("label = ?");
            params.push(lbl);
        }
        if (req.body?.address_text !== undefined) {
            const at = nonEmptyString(req.body.address_text) ? String(req.body.address_text).trim() : null;
            if (!at) throw badRequest("address_text cannot be empty");
            updates.push("address_text = ?");
            params.push(at);
        }
        if (req.body?.lat !== undefined) {
            const lat = toNumber(req.body.lat);
            if (lat === null) throw badRequest("lat must be number");
            if (lat < -90 || lat > 90) throw badRequest("lat must be between -90 and 90");
            updates.push("lat = ?");
            params.push(lat);
        }
        if (req.body?.lng !== undefined) {
            const lng = toNumber(req.body.lng);
            if (lng === null) throw badRequest("lng must be number");
            if (lng < -180 || lng > 180) throw badRequest("lng must be between -180 and 180");
            updates.push("lng = ?");
            params.push(lng);
        }

        const toggleDefaultProvided = req.body?.is_default !== undefined;
        let setAsDefault = false;
        if (toggleDefaultProvided) {
            const isDefault = toBool(req.body.is_default);
            updates.push("is_default = ?");
            params.push(isDefault ? 1 : 0);
            setAsDefault = isDefault;
        }

        if (!updates.length && !toggleDefaultProvided) {
            return res.json({ data: existing }); // nothing to update
        }

        const tx = await conn.getConnection();
        try {
            await tx.beginTransaction();

            if (updates.length) {
                const sql = `UPDATE addresses SET ${updates.join(", ")} WHERE id = ?`;
                await tx.query(sql, [...params, id]);
            }

            if (setAsDefault) {
                await setDefaultWithinTx(tx, userId, id);
            }

            await tx.commit();

            const [rows] = await conn.query(
                "SELECT id, user_id, label, address_text, lat, lng, is_default, default_owner, created_at FROM addresses WHERE id = ?",
                [id]
            );

            res.json({ data: (rows as any[])[0] });
        } catch (e) {
            try { await tx.rollback(); } catch { }
            throw e;
        } finally {
            tx.release();
        }
    })
);

// Set as default (explicit endpoint)
router.patch(
    "/addresses/:id/default",
    asyncHandler(async (req: Request, res: Response) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) throw badRequest("invalid id");

        const [rows] = await conn.query("SELECT id, user_id FROM addresses WHERE id = ?", [id]);
        const found = (rows as any[])[0];
        if (!found) return res.status(404).json({ error: "not found" });

        const tx = await conn.getConnection();
        try {
            await tx.beginTransaction();
            await setDefaultWithinTx(tx, found.user_id, id);
            await tx.commit();
        } catch (e) {
            try { await tx.rollback(); } catch { }
            throw e;
        } finally {
            tx.release();
        }

        const [after] = await conn.query(
            "SELECT id, user_id, label, address_text, lat, lng, is_default, default_owner, created_at FROM addresses WHERE id = ?",
            [id]
        );

        res.json({ data: (after as any[])[0] });
    })
);

// Delete
router.delete(
    "/addresses/:id",
    asyncHandler(async (req: Request, res: Response) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) throw badRequest("invalid id");

        const [rows] = await conn.query("SELECT id, user_id, is_default FROM addresses WHERE id = ?", [id]);
        const found = (rows as any[])[0];
        if (!found) return res.status(404).json({ error: "not found" });

        await conn.query("DELETE FROM addresses WHERE id = ?", [id]);

        // Optional: if you want to always keep at least one default, you could set another address as default here.

        res.status(204).send();
    })
);