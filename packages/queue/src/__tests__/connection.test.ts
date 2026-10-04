import { expect, it } from "vitest";
import { queueConnection } from "../connection.js";

it("maps Redis URLs to socket options, including IPv6, encoded credentials and TLS", () => {
  expect(queueConnection("rediss://agent:p%40ss@[::1]:6380/2")).toEqual({
    host: "::1",
    port: 6380,
    db: 2,
    username: "agent",
    password: "p@ss",
    tls: {},
  });
  expect(() => queueConnection("https://redis.example/0")).toThrow(/redis/);
  expect(() => queueConnection("redis://localhost/1.5")).toThrow(/database/);
});
