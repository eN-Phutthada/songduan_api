import { Router, Request, Response } from "express";
import { conn } from "../lib/db";
import { asyncHandler } from "../middleware/asyncHandler";
import { RowDataPacket } from "mysql2";
import { uploadMedia, buildUploadTarget, saveBufferToFile } from "../utils/upload";

const router = Router();
export default router;

router.get(
    "/",
    asyncHandler(async (req: Request, res: Response) => {
        const _sender = (req.query.sender_id ?? req.query.senderId) as string | undefined;
        const _receiver = (req.query.receiver_id ?? req.query.receiverId) as string | undefined;
        const _status = req.query.status as string | undefined;

        const senderId = _sender && !isNaN(Number(_sender)) ? Number(_sender) : undefined;
        const receiverId = _receiver && !isNaN(Number(_receiver)) ? Number(_receiver) : undefined;
        const status = _status ? _status.toUpperCase() : undefined;

        let page = Math.max(1, Number(req.query.page ?? 1));
        let pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20)));
        const offset = (page - 1) * pageSize;

        const where: string[] = [];
        const params: any[] = [];

        if (senderId !== undefined) { where.push("s.sender_id = ?"); params.push(senderId); }
        if (receiverId !== undefined) { where.push("s.receiver_id = ?"); params.push(receiverId); }
        if (status) { where.push("s.status = ?"); params.push(status); }

        // const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

        if (senderId) {
            where.push("s.sender_id = ?");
            params.push(senderId);
        }
        if (receiverId) {
            where.push("s.receiver_id = ?");
            params.push(receiverId);
        }
        if (status) {
            where.push("s.status = ?");
            params.push(status);
        }

        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

        // นับจำนวนทั้งหมดเพื่อทำ pagination
        const [countRows] = await conn.query<RowDataPacket[]>(
            `SELECT COUNT(*) AS cnt
       FROM shipments s
       ${whereSql}`,
            params
        );
        const total = Number(countRows[0]?.cnt ?? 0);

        // ดึงรายการ + join ข้อมูลที่ต้องใช้
        const [rows] = await conn.query<RowDataPacket[]>(
            `
      SELECT
        s.id,
        s.title,
        s.status,
        s.created_at,

        -- Sender
        us.id     AS sender_id,
        us.name   AS sender_name,
        us.phone  AS sender_phone,
        us.avatar_path AS sender_avatar_path,

        -- Receiver
        ur.id     AS receiver_id,
        ur.name   AS receiver_name,
        ur.phone  AS receiver_phone,
        ur.avatar_path AS receiver_avatar_path,

        -- Pickup
        ap.id     AS pickup_id,
        ap.label  AS pickup_label,
        ap.address_text AS pickup_address_text,
        ap.lat    AS pickup_lat,
        ap.lng    AS pickup_lng,

        -- Dropoff
        ad.id     AS dropoff_id,
        ad.label  AS dropoff_label,
        ad.address_text AS dropoff_address_text,
        ad.lat    AS dropoff_lat,
        ad.lng    AS dropoff_lng,

        -- cover (proof ตอนเริ่มงาน ถ้ามี)
        sf.file_path AS cover_file_path

      FROM shipments s
      JOIN users     us ON us.id = s.sender_id
      JOIN users     ur ON ur.id = s.receiver_id
      JOIN addresses ap ON ap.id = s.pickup_address_id
      JOIN addresses ad ON ad.id = s.dropoff_address_id
      LEFT JOIN shipment_files sf
        ON sf.shipment_id = s.id AND sf.stage = 'WAITING_FOR_RIDER'

      ${whereSql}
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ? OFFSET ?
      `,
            [...params, pageSize, offset]
        );

        const data = rows.map(r => ({
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
            cover_file_path: r.cover_file_path ?? null,
        }));

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

            // ── 1) INSERT shipments (เวอร์ชันไม่มี note ในคอลัมน์)
            //     const [shipResult] = await cx.query<any>(
            //         `INSERT INTO shipments (title, sender_id, receiver_id, pickup_address_id, dropoff_address_id)
            //  VALUES (?, ?, ?, ?, ?)`,
            //         [title, sender_id, receiver_id, pickup_address_id, dropoff_address_id]
            //     );

            // ถ้าคุณเพิ่ม note ที่ตาราง shipments แล้ว ใช้คิวรีนี้แทน:
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
