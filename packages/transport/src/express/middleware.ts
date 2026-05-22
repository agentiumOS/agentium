export function errorHandler(options?: { logger?: Pick<Console, "error"> }) {
  const log = options?.logger ?? console;
  return (err: any, _req: any, res: any, _next: any) => {
    log.error("[agentium:transport] Error:", err.message);
    const statusCode = err.statusCode ?? 500;
    const isClientError = statusCode >= 400 && statusCode < 500;
    res.status(statusCode).json({
      error: isClientError ? (err.message ?? "Bad request") : "Internal server error",
    });
  };
}

export function requestLogger(options?: { logger?: Pick<Console, "log"> }) {
  const log = options?.logger ?? console;
  return (req: any, _res: any, next: any) => {
    const safePath = String(req.path).replace(/[\x00-\x1f\x7f]/g, "");
    log.log(`[agentium:transport] ${req.method} ${safePath}`);
    next();
  };
}
