import http from 'http';
import { app } from './app';
import { conn } from './lib/db'; // ใช้ warm-up และ graceful shutdown

const server = http.createServer(app);

const PORT = Number(process.env.PORT) || 3000;

// ปรับให้เพลย์ดีกับ proxy
server.keepAliveTimeout = 61_000;   // นานกว่า proxy เล็กน้อย
server.headersTimeout = 65_000;   // > keepAliveTimeout เสมอ
server.requestTimeout = 0;        // ไม่บังคับตัด (ปล่อยให้ reverse proxy จัดการ)
server.setTimeout(0);               // disable socket timeout ระดับ server

server.listen(PORT, '0.0.0.0', async () => {
    try {
        // วอร์ม DB รอบเดียวตอนบูต กันช็อตแรก
        await conn.query('SELECT 1');
        console.log('✅ DB ready');
    } catch (e) {
        console.error('❌ DB warm-up failed:', e);
    }
    console.log(`🚀 Server listening on ${PORT}`);
}).on('error', (error) => {
    console.error('❌ Server error:', error);
});

// กัน error low-level ไม่ให้ process ตายเงียบ ๆ
server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
    console.error('⚠️ clientError', err.code, err.message);
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// ปิดให้เรียบร้อยตอนคอนเทนเนอร์จะถูก kill
async function shutdown(code = 0) {
    try { await conn.end(); } catch { }
    server.close(() => process.exit(code));
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
process.on('unhandledRejection', (r) => console.error('unhandledRejection', r));
process.on('uncaughtException', (e) => { console.error('uncaughtException', e); shutdown(1); });
