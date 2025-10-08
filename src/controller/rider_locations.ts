import { Router, Request, Response } from "express";
import { RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { conn } from "../lib/db";
import { asyncHandler } from "../middleware/asyncHandler";

const router = Router();
export default router;

/**
 * POST /rider_locations/:id/location
 * อัปเดตตำแหน่งไรเดอร์ (upsert by rider_id)
 * Body: { lat:number, lng:number, heading_deg?:number, speed_mps?:number, shipment_id?:number }
 */
router.post(
    "/:id/location",
    asyncHandler(async (req: Request, res: Response) => {
        const riderId = Number(req.params.id);
        const { lat, lng, heading_deg, speed_mps, shipment_id } = req.body ?? {};

        // --- validate basic ---
        if (!Number.isFinite(riderId)) {
            return res.status(400).json({ error: { message: "rider_id ไม่ถูกต้อง" } });
        }
        const _lat = Number(lat);
        const _lng = Number(lng);
        if (!Number.isFinite(_lat) || _lat < -90 || _lat > 90) {
            return res.status(400).json({ error: { message: "lat ไม่ถูกต้อง" } });
        }
        if (!Number.isFinite(_lng) || _lng < -180 || _lng > 180) {
            return res.status(400).json({ error: { message: "lng ไม่ถูกต้อง" } });
        }
        const _heading = heading_deg !== undefined ? Number(heading_deg) : null;
        const _speed = speed_mps !== undefined ? Number(speed_mps) : null;
        if (_heading !== null && (!Number.isFinite(_heading) || _heading < 0 || _heading >= 360)) {
            return res.status(400).json({ error: { message: "heading_deg ไม่ถูกต้อง (0–360)" } });
        }
        if (_speed !== null && (!Number.isFinite(_speed) || _speed < 0)) {
            return res.status(400).json({ error: { message: "speed_mps ต้องเป็นเลขไม่ติดลบ" } });
        }

        const cx = await conn.getConnection();
        try {
            await cx.beginTransaction();

            // 1) ไรเดอร์ต้องมีตัวตนและ role ถูกต้อง
            const [riders] = await cx.query<RowDataPacket[]>(
                "SELECT id, role FROM users WHERE id=? LIMIT 1 FOR UPDATE",
                [riderId]
            );
            if (riders.length === 0) {
                await cx.rollback();
                return res.status(404).json({ error: { message: "ไม่พบผู้ใช้ (rider)" } });
            }
            if (String(riders[0].role).toUpperCase() !== "RIDER") {
                await cx.rollback();
                return res.status(403).json({ error: { message: "บัญชีนี้ไม่ใช่ RIDER" } });
            }

            // 2) ถ้ามี shipment_id ให้ตรวจว่าความสัมพันธ์ถูกต้องและงานยัง active
            if (shipment_id !== undefined && shipment_id !== null) {
                const sid = Number(shipment_id);
                if (!Number.isFinite(sid)) {
                    await cx.rollback();
                    return res.status(400).json({ error: { message: "shipment_id ไม่ถูกต้อง" } });
                }

                // งานต้องอยู่ใน assignment ของไรเดอร์นี้ และยังไม่ delivered
                const [asgs] = await cx.query<RowDataPacket[]>(
                    `SELECT id FROM rider_assignments
             WHERE shipment_id=? AND rider_id=? AND delivered_at IS NULL
             LIMIT 1 FOR UPDATE`,
                    [sid, riderId]
                );
                if (asgs.length === 0) {
                    await cx.rollback();
                    return res.status(409).json({ error: { message: "ไม่มีงานที่กำลังทำอยู่กับ shipment_id นี้" } });
                }
            }

            // 3) upsert ตำแหน่ง
            const [r] = await cx.query<ResultSetHeader>(
                `INSERT INTO rider_locations (rider_id, lat, lng, heading_deg, speed_mps)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           lat=VALUES(lat),
           lng=VALUES(lng),
           heading_deg=VALUES(heading_deg),
           speed_mps=VALUES(speed_mps),
           updated_at=CURRENT_TIMESTAMP`,
                [riderId, _lat, _lng, _heading, _speed]
            );

            await cx.commit();
            return res.status(200).json({
                data: {
                    rider_id: riderId,
                    lat: _lat,
                    lng: _lng,
                    heading_deg: _heading,
                    speed_mps: _speed,
                    updated: true,
                },
            });
        } catch (e: any) {
            await cx.rollback();
            return res.status(500).json({ error: { message: e?.message ?? "internal error" } });
        } finally {
            cx.release();
        }
    })
);

/**
 * GET /rider_locations/:id/location
 * ดึงตำแหน่งล่าสุดของไรเดอร์
 */
router.get(
    "/:id/location",
    asyncHandler(async (req: Request, res: Response) => {
        const riderId = Number(req.params.id);
        if (!Number.isFinite(riderId)) {
            return res.status(400).json({ error: { message: "rider_id ไม่ถูกต้อง" } });
        }

        const [rows] = await conn.query<RowDataPacket[]>(
            `SELECT rider_id, lat, lng, heading_deg, speed_mps, updated_at
         FROM rider_locations WHERE rider_id=? LIMIT 1`,
            [riderId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: { message: "ยังไม่มีตำแหน่งของไรเดอร์คนนี้" } });
        }
        const r = rows[0];
        return res.json({
            data: {
                rider_id: r.rider_id,
                lat: r.lat,
                lng: r.lng,
                heading_deg: r.heading_deg,
                speed_mps: r.speed_mps,
                updated_at: r.updated_at,
            },
        });
    })
);

/**
 * GET /rider_locations/shipments/:id/rider_location
 * ดึงตำแหน่งไรเดอร์ของ "งานนี้" (เฉพาะถ้างานยัง active)
 */
router.get(
    "/shipments/:id/rider_location",
    asyncHandler(async (req: Request, res: Response) => {
        const shipmentId = Number(req.params.id);
        if (!Number.isFinite(shipmentId)) {
            return res.status(400).json({ error: { message: "shipment_id ไม่ถูกต้อง" } });
        }

        // หา rider ที่ถือ job นี้อยู่ (ยังไม่ delivered)
        const [asgs] = await conn.query<RowDataPacket[]>(
            `SELECT ra.rider_id
         FROM rider_assignments ra
         JOIN shipments s ON s.id = ra.shipment_id
        WHERE ra.shipment_id=? AND ra.delivered_at IS NULL
        LIMIT 1`,
            [shipmentId]
        );
        if (asgs.length === 0) {
            return res.status(404).json({ error: { message: "ไม่มีไรเดอร์ถือ job นี้อยู่" } });
        }
        const riderId = asgs[0].rider_id;

        // หาตำแหน่งล่าสุด
        const [locs] = await conn.query<RowDataPacket[]>(
            `SELECT rider_id, lat, lng, heading_deg, speed_mps, updated_at
         FROM rider_locations WHERE rider_id=? LIMIT 1`,
            [riderId]
        );
        if (locs.length === 0) {
            return res.status(404).json({ error: { message: "ยังไม่มีตำแหน่งของไรเดอร์คนนี้" } });
        }
        const r = locs[0];
        return res.json({
            data: {
                rider_id: r.rider_id,
                lat: r.lat,
                lng: r.lng,
                heading_deg: r.heading_deg,
                speed_mps: r.speed_mps,
                updated_at: r.updated_at,
            },
        });
    })
);
