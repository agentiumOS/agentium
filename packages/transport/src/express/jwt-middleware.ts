import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

export interface JwtConfig {
  secret: string;
  algorithm?: string;
  issuer?: string;
  audience?: string;
  extractFrom?: "header" | "cookie";
  cookieName?: string;
}

export function createJwtMiddleware(config: JwtConfig) {
  let jwt: any;
  try {
    jwt = _require("jsonwebtoken");
  } catch {
    throw new Error("jsonwebtoken is required for JWT middleware. Install it: npm install jsonwebtoken");
  }

  const extractFrom = config.extractFrom ?? "header";
  const cookieName = config.cookieName ?? "token";

  return (req: any, res: any, next: any) => {
    let token: string | undefined;

    if (extractFrom === "header") {
      const auth = req.headers.authorization;
      if (auth?.startsWith("Bearer ")) {
        token = auth.slice(7);
      }
    } else if (extractFrom === "cookie") {
      token = req.cookies?.[cookieName];
    }

    if (!token) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const verifyOpts: Record<string, unknown> = {};
      if (config.algorithm) verifyOpts.algorithms = [config.algorithm];
      if (config.issuer) verifyOpts.issuer = config.issuer;
      if (config.audience) verifyOpts.audience = config.audience;

      const decoded = jwt.verify(token, config.secret, verifyOpts);
      req.user = decoded;
      next();
    } catch (err: any) {
      if (err.name === "TokenExpiredError") {
        return res.status(401).json({ error: "Token expired" });
      }
      return res.status(401).json({ error: "Invalid token" });
    }
  };
}
