export function queueConnection(
  value: string | { host: string; port: number; password?: string; db?: number; tls?: boolean },
) {
  if (typeof value !== "string") return { ...value, ...(value.tls ? { tls: {} } : { tls: undefined }) };
  const url = new URL(value);
  if (!["redis:", "rediss:"].includes(url.protocol)) throw new Error("Queue connection URL must use redis or rediss");
  const db = url.pathname === "/" || !url.pathname ? 0 : Number(url.pathname.slice(1));
  if (!Number.isSafeInteger(db) || db < 0) throw new Error("Invalid Redis database");
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: Number(url.port || 6379),
    db,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === "rediss:" ? { tls: {} } : {}),
  };
}
