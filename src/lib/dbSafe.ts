import { conn } from './db';

const TRANSIENT = new Set([
    'ECONNRESET',
    'PROTOCOL_CONNECTION_LOST',
    'ETIMEDOUT',
    'EPIPE',
    'PROTOCOL_PACKETS_OUT_OF_ORDER',
]);

export async function safeQuery<T = any>(
    sql: string,
    params?: any[],
    maxRetry = 2
): Promise<T> {
    let attempt = 0;
    let lastErr: any;
    while (attempt <= maxRetry) {
        try {
            const [rows] = await conn.query(sql, params);
            return rows as T;
        } catch (err: any) {
            lastErr = err;
            if (!TRANSIENT.has(err?.code)) throw err;
            const delay = 200 * Math.pow(2, attempt); // 200, 400, 800ms
            await new Promise(r => setTimeout(r, delay));
            attempt++;
        }
    }
    throw lastErr;
}
