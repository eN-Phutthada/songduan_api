import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
        return res.status(401).json({
            error: { message: "ต้องแนบ token แบบ Bearer <token>" },
        });
    }

    const token = header.substring(7);
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET!);
        (req as any).user = decoded; // ถ้ายังไม่ได้เพิ่ม type ให้ req.user
        next();
    } catch (e) {
        return res.status(401).json({
            error: { message: "token ไม่ถูกต้องหรือหมดอายุ" },
        });
    }
}
