import express from "express";
import usersRouter from "./controller/users";
import ridersRouter from "./controller/riders";
import addressesRouter from "./controller/addresses";
import uploadRouter from "./controller/upload";
import { conn } from "./lib/db";

export const app = express();

app.use(express.json());
app.use(express.text());

app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "api", ts: new Date().toISOString() });
});

app.get('/test-db', async (req, res) => {
    try {
        const [rows] = await conn.query('SELECT NOW() as now');
        res.json({
            status: 'ok',
            now: (rows as any)[0].now
        });
    } catch (err) {
        console.error('[DB] connection error', err);
        res.status(500).json({
            status: 'error',
            message: err instanceof Error ? err.message : String(err)
        });
    }
});

app.use("/users", usersRouter);
app.use("/riders", ridersRouter);
app.use("/addresses", addressesRouter);

app.use("/upload", uploadRouter);
app.use("/uploads", express.static("uploads"));

