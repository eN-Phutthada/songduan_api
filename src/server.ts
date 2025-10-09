import http from "http";
import { app } from "./app";

const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 3000

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server listening on ${PORT}`)
}).on("error", (error) => {
    console.error("❌ Server error:", error);
});