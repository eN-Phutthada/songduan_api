// src/lib/db.ts
// import fs from 'fs';
// import path from 'path';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

// function buildSSL() {
//     const useSSL = (process.env.DB_SSL || 'true').toLowerCase() === 'true';
//     if (!useSSL) return undefined;

//     const caPath = process.env.DB_CA_PATH;
//     if (caPath) {
//         return {
//             rejectUnauthorized: true,
//             ca: fs.readFileSync(path.resolve(caPath), 'utf8'),
//         } as any;
//     }
//     // ใช้ CA ของระบบ (หรือ provider ไม่บังคับ CA)
//     return { rejectUnauthorized: true } as any;
// }

export const conn = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,

    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,

    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    connectTimeout: 20_000,

    // ssl: buildSSL(),
});

// --- เหตุการณ์ระดับพูล: ช่วยวินิจฉัยปัญหา ---
(conn as any).on('connection', (c: any) => {
    // ยืดอายุ session (8 ชม.) ลดโอกาสโดน wait_timeout ฝั่ง DB ฆ่า
    c.query('SET SESSION wait_timeout = 28800');
    c.query('SET SESSION interactive_timeout = 28800');
});

(conn as any).on('acquire', () => {
    if (process.env.NODE_ENV !== 'production') console.log('[pool] acquire');
});
(conn as any).on('release', () => {
    if (process.env.NODE_ENV !== 'production') console.log('[pool] release');
});

// health ping เป็นระยะ (กัน connection ตายเงียบ ๆ)
const PING_MS = 5 * 60 * 1000; // 5 นาที
setInterval(async () => {
    try { await conn.query('DO 1'); }
    catch (e) { console.error('[DB ping failed]', e); }
}, PING_MS);
