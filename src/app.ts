import express from "express";
import usersRouter from "./controller/users";
import ridersRouter from "./controller/riders";
import addressesRouter from "./controller/addresses";
import shipmentRouter from "./controller/shipment";
import rider_locations from "./controller/rider_locations";
import uploadRouter from "./controller/upload";
import { conn } from "./lib/db";

export const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.text({ limit: '256kb' }));

// --- health endpoints ---
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.get('/', (_req, res) => {
    const html = `
  <style>
    body { background:#0f0f0f;color:#00ffcc;font-family:monospace;text-align:center;padding-top:20vh; }
    h1 { font-size:3rem;margin-bottom:.5rem; } p { color:#999; }
  </style>
  <h1>⚡ API online ⚡</h1>
  <p>Render instance is alive — version ${process.env.npm_package_version}</p>
`;
    res.send(html);
});

app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'api', ts: new Date().toISOString() });
});

app.get('/test-db', async (_req, res) => {
    try {
        const [rows] = await conn.query('SELECT NOW() as now');
        res.json({ status: 'ok', now: (rows as any)[0].now });
    } catch (err: any) {
        console.error('[DB] connection error', {
            code: err?.code, errno: err?.errno, fatal: err?.fatal, message: err?.message
        });
        res.status(500).json({ status: 'error', message: err?.message, code: err?.code });
    }
});

// --- routers ---
app.use('/users', usersRouter);
app.use('/riders', ridersRouter);
app.use('/addresses', addressesRouter);
app.use('/shipments', shipmentRouter);
app.use('/rider_locations', rider_locations);
app.use('/upload', uploadRouter);
app.use('/uploads', express.static('uploads'));

// --- ONE error handler at the very end ---
app.use((err: any, _req: any, res: any, _next: any) => {
    if (err?.message === 'INVALID_FILE_TYPE') {
        return res.status(400).json({
            error: { message: 'ไฟล์รูปไม่รองรับ (รองรับ .jpg/.jpeg/.png/.webp/.gif/.heic/.heif)' }
        });
    }

    console.error('🔥 Unhandled error:', {
        message: err?.message,
        code: err?.code,
        errno: err?.errno,
        sqlState: err?.sqlState
    });

    return res.status(500).json({
        error: { message: err?.message || 'internal error', code: err?.code }
    });
});
