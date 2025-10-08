import { Router } from "express";
import { conn } from "../lib/db";
import { asyncHandler } from "../middleware/asyncHandler";

import { RowDataPacket } from "mysql2";

const router = Router();
export default router;

router.get(
    "/vehicles/:userId",
    asyncHandler(async (req, res) => {
        const { userId } = req.params;

        if (!userId) {
            return res.status(400).json({ error: "userId is required" });
        }

        const [rows] = await conn.query<RowDataPacket[]>(
            `
            SELECT 
                rp.user_id,
                rp.vehicle_plate AS license_plate,
                rp.vehicle_model AS vehicle_model,
                rp.vehicle_photo_path AS image,
                rp.is_active
            FROM rider_profiles rp
            WHERE rp.user_id = ? AND rp.is_active = 1
            LIMIT 1
            `,
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Vehicle not found" });
        }

        const vehicle = rows[0] as RowDataPacket & {
            user_id: number;
            license_plate: string;
            vehicle_model: string;
            image: string | null;
            is_active: number;
        };

        return res.json({
            data: {
                user_id: vehicle.user_id,
                license_plate: vehicle.license_plate,
                vehicle_model: vehicle.vehicle_model,
                image: vehicle.image,
                is_active: vehicle.is_active === 1,
            },
        });

    })
);

// GET /api/riders/:id/active-assignment
router.get(
    "/:id/active-assignment",
    asyncHandler(async (req, res) => {
        const riderId = Number(req.params.id);
        if (!Number.isFinite(riderId)) {
            return res.status(400).json({ error: { message: "rider_id ไม่ถูกต้อง" } });
        }

        const [rows] = await conn.query<RowDataPacket[]>(
            `SELECT shipment_id
         FROM rider_assignments
        WHERE rider_id = ? AND delivered_at IS NULL
        LIMIT 1`,
            [riderId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: { message: "no active job" } });
        }

        return res.json({ data: { shipment_id: rows[0].shipment_id } });
    })
);
