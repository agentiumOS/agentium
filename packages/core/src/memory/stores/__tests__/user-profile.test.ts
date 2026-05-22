import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryStorage } from "../../../storage/in-memory.js";
import { UserProfile } from "../user-profile.js";

describe("UserProfile", () => {
  let storage: InMemoryStorage;
  let profile: UserProfile;

  beforeEach(() => {
    storage = new InMemoryStorage();
    profile = new UserProfile(storage);
  });

  it("returns null when no profile exists", async () => {
    const data = await profile.getProfile("user1");
    expect(data).toBeNull();
  });

  it("creates a new profile with updateProfile", async () => {
    const result = await profile.updateProfile("user1", { name: "Akash", role: "Engineer" });
    expect(result.name).toBe("Akash");
    expect(result.role).toBe("Engineer");
    expect(result.custom).toEqual({});
  });

  it("merges updates into existing profile", async () => {
    await profile.updateProfile("user1", { name: "Akash", role: "Engineer" });
    const updated = await profile.updateProfile("user1", { location: "Mumbai", custom: { team: "AI" } });
    expect(updated.name).toBe("Akash");
    expect(updated.role).toBe("Engineer");
    expect(updated.location).toBe("Mumbai");
    expect(updated.custom).toEqual({ team: "AI" });
  });

  it("merges custom fields", async () => {
    await profile.updateProfile("user1", { custom: { a: 1 } });
    const updated = await profile.updateProfile("user1", { custom: { b: 2 } });
    expect(updated.custom).toEqual({ a: 1, b: 2 });
  });

  it("clears a profile", async () => {
    await profile.updateProfile("user1", { name: "Akash" });
    await profile.clear("user1");
    const data = await profile.getProfile("user1");
    expect(data).toBeNull();
  });

  it("generates context string", async () => {
    await profile.updateProfile("user1", {
      name: "Akash Sengar",
      role: "Product Manager",
      timezone: "Asia/Kolkata",
    });
    const ctx = await profile.getContextString("user1");
    expect(ctx).toContain("About this user:");
    expect(ctx).toContain("- Name: Akash Sengar");
    expect(ctx).toContain("- Role: Product Manager");
    expect(ctx).toContain("- Timezone: Asia/Kolkata");
  });

  it("returns empty context for missing profile", async () => {
    const ctx = await profile.getContextString("user1");
    expect(ctx).toBe("");
  });

  it("creates a tool definition", () => {
    const tool = profile.asTool();
    expect(tool.name).toBe("update_user_profile");
    expect(tool.execute).toBeDefined();
  });
});
