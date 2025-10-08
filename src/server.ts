import http, { Server } from "http";
import { app } from "./app";

const server: Server = http.createServer(app);

server.listen(() => {
    console.log(`🚀 Server running at https://songduan-api.com`);
});

// server.on("listening", onListening);

// function onListening(): void {
//     const addr = server.address();
//     if (!addr) {
//         console.warn("⚠️  Server address is null");
//         return;
//     }
//     const bind = typeof addr === "string" ? `pipe ${addr}` : `port ${addr.port}`;
//     console.log(`✅ Listening on ${bind}`);
// }
