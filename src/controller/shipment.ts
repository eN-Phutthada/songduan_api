import { Router, Request, Response } from "express";
import { conn } from "../lib/db";
import { asyncHandler } from "../middleware/asyncHandler";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import { uploadMedia, buildUploadTarget, saveBufferToFile, safeUnlink, ensureDir } from "../utils/upload";
import path from "path";

const router = Router();
export default router;

router.get(
    "/",
    asyncHandler(async (req: Request, res: Response) => {
        // รองรับทั้ง snake/camel
        const _sender = (req.query.sender_id ?? req.query.senderId) as string | undefined;
        const _receiver = (req.query.receiver_id ?? req.query.receiverId) as string | undefined;
        const _status = req.query.status as string | undefined;
        const _available = req.query.available as string | undefined; // งานว่าง (ยังไม่ถูก assign)

        const senderId = _sender !== undefined && !isNaN(Number(_sender)) ? Number(_sender) : undefined;
        const receiverId = _receiver !== undefined && !isNaN(Number(_receiver)) ? Number(_receiver) : undefined;
        const status = _status ? _status.toUpperCase() : undefined;
        const available = _available === "1" || _available === "true";

        let page = Number(req.query.page ?? 1);
        if (!Number.isFinite(page) || page < 1) page = 1;
        let pageSize = Number(req.query.pageSize ?? 20);
        if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 20;
        if (pageSize > 100) pageSize = 100;
        const offset = (page - 1) * pageSize;

        const where: string[] = [];
        const params: any[] = [];

        if (senderId !== undefined) { where.push("s.sender_id = ?"); params.push(senderId); }
        if (receiverId !== undefined) { where.push("s.receiver_id = ?"); params.push(receiverId); }
        if (status) { where.push("s.status = ?"); params.push(status); }
        if (available) {
            // งานที่ยังไม่มีไรเดอร์ active
            where.push(`
        NOT EXISTS (
          SELECT 1 FROM rider_assignments ra
          WHERE ra.shipment_id = s.id AND ra.active_owner IS NOT NULL
        )
      `);
        }

        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

        // นับทั้งหมด (ใช้ params ชุดเดียวกัน)
        const [countRows] = await conn.query<RowDataPacket[]>(
            `SELECT COUNT(*) AS cnt
       FROM shipments s
       ${whereSql}`,
            params
        );
        const total = Number(countRows[0]?.cnt ?? 0);

        // รายการ + sender/receiver + pickup/dropoff + cover + rider (active)
        const [rows] = await conn.query<RowDataPacket[]>(
            `
      SELECT
        s.id,
        s.title,
        s.status,
        s.created_at,

        -- Sender
        us.id           AS sender_id,
        us.name         AS sender_name,
        us.phone        AS sender_phone,
        us.avatar_path  AS sender_avatar_path,

        -- Receiver
        ur.id           AS receiver_id,
        ur.name         AS receiver_name,
        ur.phone        AS receiver_phone,
        ur.avatar_path  AS receiver_avatar_path,

        -- Pickup
        ap.id           AS pickup_id,
        ap.label        AS pickup_label,
        ap.address_text AS pickup_address_text,
        ap.lat          AS pickup_lat,
        ap.lng          AS pickup_lng,

        -- Dropoff
        ad.id           AS dropoff_id,
        ad.label        AS dropoff_label,
        ad.address_text AS dropoff_address_text,
        ad.lat          AS dropoff_lat,
        ad.lng          AS dropoff_lng,

        -- Cover proof (ตอนรอไรเดอร์)
        sf.file_path    AS cover_file_path,

        -- Active rider (ถ้ามี)
        ra.rider_id     AS rider_id,
        urider.name     AS rider_name,
        urider.avatar_path AS rider_avatar_path
      FROM shipments s
      JOIN users     us ON us.id = s.sender_id
      JOIN users     ur ON ur.id = s.receiver_id
      JOIN addresses ap ON ap.id = s.pickup_address_id
      JOIN addresses ad ON ad.id = s.dropoff_address_id
      LEFT JOIN shipment_files sf
        ON sf.shipment_id = s.id AND sf.stage = 'WAITING_FOR_RIDER'
      LEFT JOIN rider_assignments ra
        ON ra.shipment_id = s.id AND ra.delivered_at IS NULL
      LEFT JOIN users urider
        ON urider.id = ra.rider_id
      ${whereSql}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ? OFFSET ?
      `,
            [...params, pageSize, offset]
        );

        const data = rows.map(r => {
            let pickupLabel = (r.pickup_label ?? '').toString();
            let dropoffLabel = (r.dropoff_label ?? '').toString();

            if (pickupLabel.trim() === 'บ้าน') pickupLabel = `${r.sender_name}`;
            if (dropoffLabel.trim() === 'บ้าน') dropoffLabel = `${r.receiver_name}`;

            return {
                id: r.id,
                title: r.title,
                status: r.status,
                created_at: r.created_at,

                sender: {
                    id: r.sender_id,
                    name: r.sender_name,
                    phone: r.sender_phone,
                    avatar_path: r.sender_avatar_path,
                },
                receiver: {
                    id: r.receiver_id,
                    name: r.receiver_name,
                    phone: r.receiver_phone,
                    avatar_path: r.receiver_avatar_path,
                },
                pickup: {
                    id: r.pickup_id,
                    label: pickupLabel,
                    address_text: r.pickup_address_text,
                    lat: r.pickup_lat,
                    lng: r.pickup_lng,
                },
                dropoff: {
                    id: r.dropoff_id,
                    label: dropoffLabel,
                    address_text: r.dropoff_address_text,
                    lat: r.dropoff_lat,
                    lng: r.dropoff_lng,
                },
                cover_file_path: r.cover_file_path ?? null,

                // ✅ ส่งข้อมูลไรเดอร์ไปให้หน้า Receiver ใช้แสดงชื่อ
                assignment: r.rider_id ? {
                    rider_id: r.rider_id,
                    rider: {
                        id: r.rider_id,
                        name: r.rider_name,
                        avatar_path: r.rider_avatar_path,
                    }
                } : null,
            };
        });

        return res.json({ data, page, pageSize, total });
    })
);


router.post(
    "/",
    uploadMedia.single("proof"),
    asyncHandler(async (req: Request, res: Response) => {
        const {
            title,
            sender_id,
            receiver_id,
            pickup_address_id,
            dropoff_address_id,
            items,
            note,
        } = req.body as any;

        if (!title || !sender_id || !receiver_id || !pickup_address_id || !dropoff_address_id) {
            return res.status(400).json({ error: { message: "กรอกข้อมูลไม่ครบ" } });
        }

        if (Number(sender_id) === Number(receiver_id)) {
            return res.status(400).json({ error: { message: "ไม่สามารถส่งให้ตัวเองได้" } });
        }

        // parse items (มาจาก form-data → string)
        let parsedItems: Array<{ name: string; qty?: number; note?: string }> = [];
        try {
            parsedItems = JSON.parse(items || "[]");
        } catch {
            return res.status(400).json({ error: { message: "items ต้องเป็น JSON array" } });
        }
        parsedItems = parsedItems
            .map(it => ({ name: String(it?.name ?? "").trim(), qty: Number(it?.qty ?? 1), note: it?.note ? String(it.note) : undefined }))
            .filter(it => it.name.length > 0);

        if (parsedItems.length === 0) {
            return res.status(400).json({ error: { message: "ต้องมีสินค้าอย่างน้อย 1 รายการ" } });
        }

        // --- ตรวจความมีอยู่จริง + owner ---
        const [[sender]] = await conn.query<RowDataPacket[]>("SELECT id FROM users WHERE id = ? LIMIT 1", [sender_id]);
        if (!sender) return res.status(404).json({ error: { message: "ไม่พบบัญชีผู้ส่ง" } });

        const [[receiver]] = await conn.query<RowDataPacket[]>("SELECT id FROM users WHERE id = ? LIMIT 1", [receiver_id]);
        if (!receiver) return res.status(404).json({ error: { message: "ไม่พบบัญชีผู้รับ" } });

        const [[pickup]] = await conn.query<RowDataPacket[]>("SELECT id, user_id FROM addresses WHERE id = ? LIMIT 1", [pickup_address_id]);
        if (!pickup) return res.status(404).json({ error: { message: "ไม่พบที่อยู่ต้นทาง" } });
        if (Number(pickup.user_id) !== Number(sender_id)) {
            return res.status(400).json({ error: { message: "ที่อยู่รับของไม่ใช่ของผู้ส่ง" } });
        }

        const [[dropoff]] = await conn.query<RowDataPacket[]>("SELECT id, user_id FROM addresses WHERE id = ? LIMIT 1", [dropoff_address_id]);
        if (!dropoff) return res.status(404).json({ error: { message: "ไม่พบที่อยู่ปลายทาง" } });
        if (Number(dropoff.user_id) !== Number(receiver_id)) {
            return res.status(400).json({ error: { message: "ที่อยู่ส่งของไม่ใช่ของผู้รับ" } });
        }

        const cx = await conn.getConnection();
        try {
            await cx.beginTransaction();

            // ── 1) INSERT shipments
            const [shipResult] = await cx.query<any>(
                `INSERT INTO shipments (title, sender_id, receiver_id, pickup_address_id, dropoff_address_id, note)
               VALUES (?, ?, ?, ?, ?, ?)`,
                [title, sender_id, receiver_id, pickup_address_id, dropoff_address_id, note ?? null]
            );

            const shipmentId = Number((shipResult as any).insertId);

            // ── 2) INSERT items
            for (const it of parsedItems) {
                await cx.query(
                    `INSERT INTO shipment_items (shipment_id, name, qty, note) VALUES (?, ?, ?, ?)`,
                    [shipmentId, it.name, it.qty || 1, it.note ?? null]
                );
            }

            // ── 3) INSERT status history (WAITING_FOR_RIDER)
            const actorUserId = (req as any).user?.id ?? Number(sender_id);
            await cx.query(
                `INSERT INTO shipment_status_history (shipment_id, status, actor_user_id, note)
         VALUES (?, 'WAITING_FOR_RIDER', ?, ?)`,
                [shipmentId, actorUserId, note ?? null]
            );

            // ── 4) handle proof file → บันทึกไฟล์ + INSERT shipment_files
            let proofPublicPath: string | null = null;
            if (req.file) {
                // ใช้ ref เป็น shipmentId เพื่อแยกโฟลเดอร์
                const up = buildUploadTarget("shipment", String(shipmentId), req.file.originalname);
                await saveBufferToFile(up.diskPath, req.file.buffer);

                await cx.query(
                    `INSERT INTO shipment_files (shipment_id, uploaded_by, stage, file_path)
           VALUES (?, ?, 'WAITING_FOR_RIDER', ?)`,
                    [shipmentId, actorUserId, up.publicPath]
                );
                proofPublicPath = up.publicPath;
            }

            await cx.commit();

            return res.status(201).json({
                data: {
                    shipment: {
                        id: shipmentId,
                        title,
                        sender_id: Number(sender_id),
                        receiver_id: Number(receiver_id),
                        pickup_address_id: Number(pickup_address_id),
                        dropoff_address_id: Number(dropoff_address_id),
                        status: "WAITING_FOR_RIDER",
                    },
                    proof: proofPublicPath ? { stage: "WAITING_FOR_RIDER", file_path: proofPublicPath } : null,
                    message: "สร้างงานส่งสำเร็จ",
                },
            });
        } catch (err) {
            await cx.rollback();
            throw err;
        } finally {
            cx.release();
        }
    })
);

router.post(
    "/:id/accept",
    asyncHandler(async (req, res) => {
        const shipmentId = Number(req.params.id);
        const riderId = Number(req.body?.rider_id); // 👈 ส่งมาจาก client

        if (!Number.isFinite(shipmentId) || !Number.isFinite(riderId)) {
            return res.status(400).json({ error: { message: "ข้อมูลไม่ครบ" } });
        }

        const cx = await conn.getConnection();
        try {
            await cx.beginTransaction();

            // 1) rider ต้องเป็น RIDER
            const [riderRows] = await cx.query<RowDataPacket[]>(
                "SELECT id, role FROM users WHERE id = ? LIMIT 1 FOR UPDATE",
                [riderId]
            );
            if (riderRows.length === 0) {
                await cx.rollback();
                return res.status(404).json({ error: { message: "ไม่พบผู้ใช้ (rider)" } });
            }
            if (String(riderRows[0].role).toUpperCase() !== "RIDER") {
                await cx.rollback();
                return res.status(403).json({ error: { message: "บัญชีนี้ไม่ใช่ RIDER" } });
            }

            // 2) shipment ต้องรอไรเดอร์
            const [shipRows] = await cx.query<RowDataPacket[]>(
                "SELECT id, status FROM shipments WHERE id = ? LIMIT 1 FOR UPDATE",
                [shipmentId]
            );
            if (shipRows.length === 0) {
                await cx.rollback();
                return res.status(404).json({ error: { message: "ไม่พบบันทึกงานจัดส่ง" } });
            }
            if (String(shipRows[0].status).toUpperCase() !== "WAITING_FOR_RIDER") {
                await cx.rollback();
                return res.status(409).json({ error: { message: "งานนี้ไม่ได้อยู่สถานะรอไรเดอร์" } });
            }

            // 3) งานนี้ถูกถืออยู่แล้วหรือไม่
            const [existAssign] = await cx.query<RowDataPacket[]>(
                "SELECT id FROM rider_assignments WHERE shipment_id = ? AND delivered_at IS NULL LIMIT 1 FOR UPDATE",
                [shipmentId]
            );
            if (existAssign.length > 0) {
                await cx.rollback();
                return res.status(409).json({ error: { message: "งานนี้ถูกรับไปแล้ว" } });
            }

            // 4) rider คนนี้มี active job อยู่หรือไม่ (unique index active_owner ดูแลอีกชั้น)
            const [busy] = await cx.query<RowDataPacket[]>(
                "SELECT id FROM rider_assignments WHERE active_owner = ? LIMIT 1 FOR UPDATE",
                [riderId]
            );
            if (busy.length > 0) {
                await cx.rollback();
                return res.status(409).json({ error: { message: "คุณมีงานที่ยังไม่เสร็จอยู่" } });
            }

            // 5) insert assignment
            const [ins] = await cx.query<ResultSetHeader>(
                "INSERT INTO rider_assignments (shipment_id, rider_id) VALUES (?, ?)",
                [shipmentId, riderId]
            );

            // 6) update status
            await cx.query(
                "UPDATE shipments SET status='RIDER_ACCEPTED', status_updated_at=CURRENT_TIMESTAMP WHERE id=?",
                [shipmentId]
            );

            // 7) history
            await cx.query(
                "INSERT INTO shipment_status_history (shipment_id, status, actor_user_id, note) VALUES (?, 'RIDER_ACCEPTED', ?, 'Rider accepted the job')",
                [shipmentId, riderId]
            );

            await cx.commit();
            return res.status(201).json({
                data: { assignment_id: ins.insertId, shipment_id: shipmentId, rider_id: riderId, status: "RIDER_ACCEPTED" },
            });
        } catch (e: any) {
            await cx.rollback();
            if (e?.code === "ER_DUP_ENTRY") {
                return res.status(409).json({ error: { message: "มีการรับงานนี้ไปแล้ว หรือคุณมีงานค้างอยู่" } });
            }
            return res.status(500).json({ error: { message: e?.message ?? "internal error" } });
        } finally {
            cx.release();
        }
    })
);
router.get(
    "/:id",
    asyncHandler(async (req, res) => {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) {
            return res.status(400).json({ error: { message: "shipment_id ไม่ถูกต้อง" } });
        }

        const [rows] = await conn.query<RowDataPacket[]>(
            `
      SELECT
        s.id, s.title, s.status, s.created_at,

        -- sender / receiver
        us.id  AS sender_id,   us.name  AS sender_name,   us.avatar_path AS sender_avatar_path,
        ur.id  AS receiver_id, ur.name  AS receiver_name, ur.avatar_path AS receiver_avatar_path,

        -- pickup / dropoff
        ap.id  AS pickup_id,   ap.label AS pickup_label,   ap.address_text AS pickup_address_text,
        ap.lat AS pickup_lat,  ap.lng   AS pickup_lng,
        ad.id  AS dropoff_id,  ad.label AS dropoff_label,  ad.address_text AS dropoff_address_text,
        ad.lat AS dropoff_lat, ad.lng   AS dropoff_lng,

        -- photos (nullable)
        sf_pick.file_path  AS pickup_photo_path,
        sf_deliv.file_path AS deliver_photo_path

      FROM shipments s
      JOIN users     us ON us.id = s.sender_id
      JOIN users     ur ON ur.id = s.receiver_id
      JOIN addresses ap ON ap.id = s.pickup_address_id
      JOIN addresses ad ON ad.id = s.dropoff_address_id

      -- รูปตอน "รับสินค้าไปแล้ว" (หลังจาก pickup)
      LEFT JOIN shipment_files sf_pick
        ON sf_pick.shipment_id = s.id AND sf_pick.stage = 'PICKED_UP_EN_ROUTE'

      -- รูปตอน "ส่งสำเร็จ"
      LEFT JOIN shipment_files sf_deliv
        ON sf_deliv.shipment_id = s.id AND sf_deliv.stage = 'DELIVERED'

      WHERE s.id = ?
      LIMIT 1
      `,
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: { message: "ไม่พบข้อมูลงานนี้" } });
        }

        const r = rows[0];

        return res.json({
            data: {
                id: r.id,
                title: r.title,
                status: r.status,
                created_at: r.created_at,

                sender: {
                    id: r.sender_id,
                    name: r.sender_name,
                    avatar_path: r.sender_avatar_path,
                },
                receiver: {
                    id: r.receiver_id,
                    name: r.receiver_name,
                    avatar_path: r.receiver_avatar_path,
                },

                pickup: {
                    id: r.pickup_id,
                    label: r.pickup_label,
                    address_text: r.pickup_address_text,
                    lat: r.pickup_lat,
                    lng: r.pickup_lng,
                },
                dropoff: {
                    id: r.dropoff_id,
                    label: r.dropoff_label,
                    address_text: r.dropoff_address_text,
                    lat: r.dropoff_lat,
                    lng: r.dropoff_lng,
                },

                // รูปจริงจาก DB (ถ้าไม่มีจะเป็น null)
                pickup_photo_path: r.pickup_photo_path ?? null,
                deliver_photo_path: r.deliver_photo_path ?? null,
            },
        });
    })
);

// ระยะอนุญาต (เมตร)
const GATE_METERS = 20;

// คำนวณระยะ haversine (เมตร)
function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000; // m
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Helper: ดึงข้อมูล shipment + จุด pickup/dropoff + assignment + ตำแหน่งไรเดอร์ล่าสุด
 * (lock ด้วย FOR UPDATE เพื่อลด race)
 */
async function getContextForShipment(cx: any, shipmentId: number) {
    // shipment + addresses
    const [srows] = (await cx.query(
        `
    SELECT
      s.id, s.status,
        s.pickup_address_id, s.dropoff_address_id,
        ap.lat AS pickup_lat, ap.lng AS pickup_lng,
        ad.lat AS drop_lat, ad.lng AS drop_lng
    FROM shipments s
    JOIN addresses ap ON ap.id = s.pickup_address_id
    JOIN addresses ad ON ad.id = s.dropoff_address_id
    WHERE s.id = ?
        LIMIT 1
    FOR UPDATE
        `, [shipmentId])) as [RowDataPacket[], any];

    if (srows.length === 0) return { notFound: true };

    const ship = srows[0];

    // assignment ที่ยัง active

    const [arows] = (await cx.query(`

    SELECT id, rider_id, accepted_at, picked_up_at, delivered_at
    FROM rider_assignments
    WHERE shipment_id = ? AND delivered_at IS NULL
    LIMIT 1
    FOR UPDATE
        `, [shipmentId])) as [RowDataPacket[], any];

    if (arows.length === 0) return { noActiveAssignment: true };

    const asg = arows[0];

    // ตำแหน่งไรเดอร์ล่าสุด
    const [lrows] = (await cx.query(
        `SELECT lat, lng, updated_at FROM rider_locations WHERE rider_id = ? LIMIT 1`,
        [asg.rider_id])) as [RowDataPacket[], any];
    const loc = lrows[0] ?? null;

    return { ship, asg, loc };
}

/**
 * POST /api/shipments/:id/pickup
 * เงื่อนไข:
 * - shipment ต้องอยู่สถานะ RIDER_ACCEPTED (มีไรเดอร์รับงานแล้ว)
 * - assignment ยังไม่ delivered
 * - มีตำแหน่งไรเดอร์ล่าสุด และอยู่ห่าง pickup ≤ 20 เมตร
 * เมื่อสำเร็จ:
 * - shipments.status = 'PICKED_UP_EN_ROUTE'
 * - rider_assignments.picked_up_at = NOW()
 * - เพิ่ม history
 */
router.post(
    "/:id/pickup",
    asyncHandler(async (req: Request, res: Response) => {
        const shipmentId = Number(req.params.id);
        if (!Number.isFinite(shipmentId)) {
            return res.status(400).json({ error: { message: "shipment_id ไม่ถูกต้อง" } });
        }

        const cx = await conn.getConnection();
        try {
            await cx.beginTransaction();

            const ctx = await getContextForShipment(cx, shipmentId);
            if ((ctx as any).notFound) {
                await cx.rollback();
                return res.status(404).json({ error: { message: "ไม่พบข้อมูลงานนี้" } });
            }
            if ((ctx as any).noActiveAssignment) {
                await cx.rollback();
                return res.status(409).json({ error: { message: "ยังไม่มีไรเดอร์ถือ job นี้" } });
            }

            const { ship, asg, loc } = ctx as any;

            // ตรวจสถานะ
            if (ship.status !== "RIDER_ACCEPTED" && ship.status !== "WAITING_FOR_RIDER") {
                await cx.rollback();
                return res.status(409).json({
                    error: { message: `สถานะปัจจุบัน(${ship.status}) ไม่สามารถเปลี่ยนเป็น PICKED_UP_EN_ROUTE ได้` },
                });
            }

            // ต้องมีตำแหน่งไรเดอร์ล่าสุด
            if (!loc) {
                await cx.rollback();
                return res.status(409).json({ error: { message: "ยังไม่มีตำแหน่งล่าสุดของไรเดอร์" } });
            }

            // ตรวจรัศมี ≤ 20m ที่จุด pickup
            const d = distanceMeters(loc.lat, loc.lng, ship.pickup_lat, ship.pickup_lng);
            if (d > GATE_METERS) {
                await cx.rollback();
                return res.status(422).json({
                    error: { message: `ต้องอยู่ในระยะไม่เกิน ${GATE_METERS} เมตรจากจุดรับ(ปัจจุบัน ~${d.toFixed(1)} m)` },
                });
            }

            // อัปเดตสถานะ
            await cx.query<ResultSetHeader>(
                `UPDATE shipments SET status = 'PICKED_UP_EN_ROUTE', status_updated_at = NOW() WHERE id =? `,
                [shipmentId]
            );
            await cx.query<ResultSetHeader>(
                `UPDATE rider_assignments SET picked_up_at = NOW() WHERE shipment_id =? `,
                [shipmentId]
            );
            await cx.query<ResultSetHeader>(
                `INSERT INTO shipment_status_history(shipment_id, status, actor_user_id, note)
         VALUES(?, 'PICKED_UP_EN_ROUTE', ?, ?)`,
                [shipmentId, asg.rider_id, 'Rider picked up the parcel']
            );

            await cx.commit();
            return res.status(200).json({
                data: {
                    shipment_id: shipmentId,
                    status: "PICKED_UP_EN_ROUTE",
                    distance_to_pickup_m: Number(d.toFixed(2)),
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
 * POST /api/shipments/:id/deliver
 * เงื่อนไข:
 * - assignment ยัง active
 * - shipments.status ต้องเป็น 'PICKED_UP_EN_ROUTE'
 * - มีตำแหน่งไรเดอร์ล่าสุด และอยู่ห่าง dropoff ≤ 20 เมตร
 * เมื่อสำเร็จ:
 * - shipments.status = 'DELIVERED'
 * - rider_assignments.delivered_at = NOW()
 * - เพิ่ม history
 */
router.post(
    "/:id/deliver",
    asyncHandler(async (req: Request, res: Response) => {
        const shipmentId = Number(req.params.id);
        if (!Number.isFinite(shipmentId)) {
            return res.status(400).json({ error: { message: "shipment_id ไม่ถูกต้อง" } });
        }

        const cx = await conn.getConnection();
        try {
            await cx.beginTransaction();

            const ctx = await getContextForShipment(cx, shipmentId);
            if ((ctx as any).notFound) {
                await cx.rollback();
                return res.status(404).json({ error: { message: "ไม่พบข้อมูลงานนี้" } });
            }
            if ((ctx as any).noActiveAssignment) {
                await cx.rollback();
                return res.status(409).json({ error: { message: "ยังไม่มีไรเดอร์ถือ job นี้" } });
            }

            const { ship, asg, loc } = ctx as any;

            if (ship.status !== "PICKED_UP_EN_ROUTE") {
                await cx.rollback();
                return res.status(409).json({
                    error: { message: `สถานะปัจจุบัน(${ship.status}) ยังไม่พร้อมส่งสำเร็จ` },
                });
            }

            if (!loc) {
                await cx.rollback();
                return res.status(409).json({ error: { message: "ยังไม่มีตำแหน่งล่าสุดของไรเดอร์" } });
            }

            // ตรวจรัศมี ≤ 20m ที่จุด dropoff
            const d = distanceMeters(loc.lat, loc.lng, ship.drop_lat, ship.drop_lng);
            if (d > GATE_METERS) {
                await cx.rollback();
                return res.status(422).json({
                    error: { message: `ต้องอยู่ในระยะไม่เกิน ${GATE_METERS} เมตรจากจุดส่ง(ปัจจุบัน ~${d.toFixed(1)} m)` },
                });
            }

            // อัปเดตสถานะ
            await cx.query<ResultSetHeader>(
                `UPDATE shipments SET status = 'DELIVERED', status_updated_at = NOW() WHERE id =? `,
                [shipmentId]
            );
            await cx.query<ResultSetHeader>(
                `UPDATE rider_assignments SET delivered_at = NOW() WHERE shipment_id =? `,
                [shipmentId]
            );
            await cx.query<ResultSetHeader>(
                `INSERT INTO shipment_status_history(shipment_id, status, actor_user_id, note)
         VALUES(?, 'DELIVERED', ?, ?)`,
                [shipmentId, asg.rider_id, 'Delivered successfully']
            );

            await cx.commit();
            return res.status(200).json({
                data: {
                    shipment_id: shipmentId,
                    status: "DELIVERED",
                    distance_to_dropoff_m: Number(d.toFixed(2)),
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
 * POST /api/shipments/:id/pickup-photo
 * POST /api/shipments/:id/deliver-photo
 * field: photo (image)
 */

router.post("/:id/pickup-photo",
    uploadMedia.single("photo"),
    asyncHandler(async (req: Request, res: Response) => {
        await handleUploadStage(req, res, "PICKED_UP_EN_ROUTE");
    })
);

router.post("/:id/deliver-photo",
    uploadMedia.single("photo"),
    asyncHandler(async (req: Request, res: Response) => {
        await handleUploadStage(req, res, "DELIVERED");
    })
);

async function handleUploadStage(req: Request, res: Response, stage: "PICKED_UP_EN_ROUTE" | "DELIVERED") {
    const shipmentId = Number(req.params.id);
    if (!shipmentId || !req.file) {
        return res.status(400).json({ error: { message: "ข้อมูลไม่ครบ (shipmentId หรือ photo)" } });
    }

    // ใครถืออยู่
    const [asgRows] = await conn.query(
        `SELECT rider_id FROM rider_assignments WHERE shipment_id=? AND delivered_at IS NULL LIMIT 1`,
        [shipmentId]
    ) as [any[], any];
    if (asgRows.length === 0) {
        return res.status(404).json({ error: { message: "ไม่พบงานหรือไรเดอร์ถือไม่อยู่" } });
    }
    const riderId = asgRows[0].rider_id;

    // ตำแหน่งไรเดอร์ล่าสุด
    const [locRows] = await conn.query(
        `SELECT lat, lng FROM rider_locations WHERE rider_id=? LIMIT 1`,
        [riderId]
    ) as [any[], any];
    if (locRows.length === 0) {
        return res.status(409).json({ error: { message: "ยังไม่มีตำแหน่งล่าสุดของไรเดอร์" } });
    }
    const { lat: rLat, lng: rLng } = locRows[0];

    // พิกัด pickup/dropoff
    const [spotRows] = await conn.query(
        `SELECT ap.lat pLat, ap.lng pLng, ad.lat dLat, ad.lng dLng
     FROM shipments s
     JOIN addresses ap ON ap.id = s.pickup_address_id
     JOIN addresses ad ON ad.id = s.dropoff_address_id
     WHERE s.id=? LIMIT 1`,
        [shipmentId]
    ) as [any[], any];
    if (spotRows.length === 0) {
        return res.status(404).json({ error: { message: "ไม่พบข้อมูลงานนี้" } });
    }
    const { pLat, pLng, dLat, dLng } = spotRows[0];

    // ตรวจรัศมี
    const dist = stage === "PICKED_UP_EN_ROUTE"
        ? distanceMeters(rLat, rLng, pLat, pLng)
        : distanceMeters(rLat, rLng, dLat, dLng);

    if (dist > GATE_METERS) {
        return res.status(422).json({
            error: { message: `ต้องอยู่ในระยะไม่เกิน ${GATE_METERS} m จากจุด${stage === "PICKED_UP_EN_ROUTE" ? "รับ" : "ส่ง"} (~${dist.toFixed(1)} m)` }
        });
    }

    // ลบของเดิม (stage เดิม)
    const [oldRows] = await conn.query(
        `SELECT file_path FROM shipment_files WHERE shipment_id=? AND stage=? LIMIT 1`,
        [shipmentId, stage]
    ) as [any[], any];
    if (oldRows.length > 0) {
        const old = oldRows[0].file_path as string;
        const full = path.join(process.cwd(), old.replace(/^\//, ""));
        await safeUnlink(full);
        await conn.query(`DELETE FROM shipment_files WHERE shipment_id=? AND stage=?`, [shipmentId, stage]);
    }

    // เซฟไฟล์ใหม่
    const ts = Date.now();
    const filename = `shipment_${shipmentId}_${stage}_${ts}${path.extname(req.file.originalname)}`;
    const dir = path.join("uploads", "shipments", `${shipmentId}`);
    const diskPath = path.join(dir, filename);
    const publicPath = `/${dir.replace(/\\/g, "/")}/${filename}`;

    ensureDir(path.dirname(diskPath));
    await saveBufferToFile(diskPath, req.file.buffer);

    await conn.query(
        `INSERT INTO shipment_files (shipment_id, uploaded_by, stage, file_path)
     VALUES (?, ?, ?, ?)`,
        [shipmentId, riderId, stage, publicPath]
    );

    return res.status(201).json({ data: { shipment_id: shipmentId, stage, file_path: publicPath } });
}