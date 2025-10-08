import http, { Server } from "http";
import { app } from "./app";

const PORT: number = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const server: Server = http.createServer(app);

server.listen(PORT, HOST, () => {
    console.log(`🚀 Server running at http://${HOST}:${PORT}`);
});

server.on("error", onError);
server.on("listening", onListening);

function onError(error: NodeJS.ErrnoException): void {
    if (error.syscall !== "listen") throw error;
    const bind = `Port ${PORT}`;
    switch (error.code) {
        case "EACCES":
            console.error(`${bind} requires elevated privileges`);
            process.exit(1);
        case "EADDRINUSE":
            console.error(`${bind} is already in use`);
            process.exit(1);
        default:
            throw error;
    }
}

function onListening(): void {
    const addr = server.address();
    if (!addr) {
        console.warn("⚠️  Server address is null");
        return;
    }
    const bind = typeof addr === "string" ? `pipe ${addr}` : `port ${addr.port}`;
    console.log(`✅ Listening on ${bind}`);
}
