import { describe, expect, it, vi } from "vitest";
import { type GmailWatchClient, type GmailWatchOptions, gmailWatchSource } from "../gmail.js";

function fixture() {
  const client: GmailWatchClient = {
    users: {
      getProfile: vi.fn(async () => ({ data: { emailAddress: "me@example.com", historyId: "90071992547409930" } })),
      watch: vi.fn(async () => ({ data: { historyId: "90071992547409931", expiration: "2000000000000" } })),
      stop: vi.fn(async () => ({})),
      history: {
        list: vi.fn(async () => ({
          data: {
            historyId: "90071992547409932",
            history: [{ id: "90071992547409931", messagesAdded: [{ message: { id: "m1", labelIds: ["INBOX"] } }] }],
          },
        })),
      },
      messages: {
        list: vi.fn(async () => ({ data: { messages: [{ id: "m1" }] } })),
        get: vi.fn(async ({ id }) => ({
          data: {
            id,
            internalDate: "1767268800000",
            snippet: "hello",
            payload: {
              headers: [
                { name: "Subject", value: "new" },
                { name: "X-Secret", value: "omit" },
              ],
            },
          },
        })),
      },
    },
  };
  const options: GmailWatchOptions = {
    id: "gmail",
    mailbox: "me@example.com",
    topicName: "projects/fixture/topics/mail",
    identity: { tenantId: "t", actorId: "a" },
    labelIds: ["INBOX"],
    client,
    verifyPush: vi.fn(async () => ({
      identity: { tenantId: "t", actorId: "a" },
      messageId: "push1",
      data: { emailAddress: "me@example.com", historyId: "90071992547409932" },
    })),
  };
  return {
    client,
    options,
    source: gmailWatchSource(options),
    signal: new AbortController().signal,
    limits: { maxEventsPerWake: 10, maxPagesPerWake: 2, maxResyncEvents: 10 },
  };
}
describe("optional host-bound Gmail watch source", () => {
  it("does no I/O at construction, verifies mailbox ownership and preserves integer cursor precision", async () => {
    const f = fixture();
    expect(f.client.users.getProfile).not.toHaveBeenCalled();
    expect(f.source.compareCursors("90071992547409930", "90071992547409931")).toBe(-1);
    expect(() => f.source.compareCursors("1e3", "1000")).toThrow();
    await f.source.activate("key", f.signal);
    expect(f.client.users.watch).toHaveBeenCalledWith(
      {
        userId: "me@example.com",
        requestBody: { topicName: "projects/fixture/topics/mail", labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" },
      },
      { signal: f.signal },
    );
    vi.mocked(f.client.users.getProfile).mockResolvedValueOnce({
      data: { emailAddress: "other@example.com", historyId: "1" },
    });
    await expect(f.source.activate("key", f.signal)).rejects.toThrow("mailbox");
    expect(f.client.users.watch).toHaveBeenCalledTimes(1);
  });
  it("reads committed history with stable event identity and metadata-only bounded content", async () => {
    const f = fixture();
    const result = await f.source.read("90071992547409930", f.limits, f.signal);
    expect(result).toMatchObject({
      cursor: "90071992547409932",
      resynced: false,
      events: [{ id: "90071992547409931:m1:added", data: { headers: [{ name: "Subject", value: "new" }] } }],
    });
    expect(f.client.users.history.list).toHaveBeenCalledWith(
      expect.objectContaining({ startHistoryId: "90071992547409930", historyTypes: ["messageAdded"] }),
      { signal: f.signal },
    );
    expect(f.client.users.messages.get).toHaveBeenCalledWith(expect.objectContaining({ format: "metadata" }), {
      signal: f.signal,
    });
  });
  it("fails without advancing when pagination exceeds the configured bound", async () => {
    const f = fixture();
    vi.mocked(f.client.users.history.list).mockResolvedValue({ data: { historyId: "20", nextPageToken: "more" } });
    await expect(f.source.read("10", f.limits, f.signal)).rejects.toThrow("page bound");
    expect(f.client.users.history.list).toHaveBeenCalledTimes(2);
  });
  it("skips deleted message metadata without suppressing new messages or losing paginated history", async () => {
    const f = fixture();
    vi.mocked(f.client.users.history.list)
      .mockResolvedValueOnce({
        data: {
          historyId: "20",
          nextPageToken: "page2",
          history: [
            {
              id: "11",
              messagesAdded: [
                { message: { id: "deleted", labelIds: ["INBOX"] } },
                { message: { id: "live1", labelIds: ["INBOX"] } },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          historyId: "30",
          history: [{ id: "21", messagesAdded: [{ message: { id: "live2", labelIds: ["INBOX"] } }] }],
        },
      });
    vi.mocked(f.client.users.messages.get).mockRejectedValueOnce({ response: { status: 404 } });
    const result = await f.source.read("10", f.limits, f.signal);
    expect(result).toMatchObject({ cursor: "30", resynced: false });
    expect(result.events.map((event) => event.id)).toEqual(["11:live1:added", "21:live2:added"]);
    expect(f.client.users.history.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ startHistoryId: "10", pageToken: "page2" }),
      { signal: f.signal },
    );
    expect(f.client.users.getProfile).not.toHaveBeenCalled();
    expect(f.client.users.messages.list).not.toHaveBeenCalled();
  });
  it("does not suppress metadata permission errors or treat them as an expired cursor", async () => {
    const f = fixture();
    vi.mocked(f.client.users.messages.get).mockRejectedValueOnce({ response: { status: 403 } });
    await expect(f.source.read("10", f.limits, f.signal)).rejects.toEqual({ response: { status: 403 } });
    expect(f.client.users.messages.list).not.toHaveBeenCalled();
    expect(f.client.users.getProfile).not.toHaveBeenCalled();
  });
  it("charges vanished message lookups against the total wake bound", async () => {
    const f = fixture();
    vi.mocked(f.client.users.history.list)
      .mockResolvedValueOnce({
        data: {
          historyId: "20",
          nextPageToken: "page2",
          history: [{ id: "11", messagesAdded: [{ message: { id: "deleted", labelIds: ["INBOX"] } }] }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          historyId: "30",
          history: [{ id: "21", messagesAdded: [{ message: { id: "live", labelIds: ["INBOX"] } }] }],
        },
      });
    vi.mocked(f.client.users.messages.get).mockRejectedValueOnce({ code: 404 });
    await expect(f.source.read("10", { ...f.limits, maxEventsPerWake: 1 }, f.signal)).rejects.toThrow("event bound");
    expect(f.client.users.messages.get).toHaveBeenCalledTimes(1);
    expect(f.client.users.messages.list).not.toHaveBeenCalled();
  });
  it("uses a bounded suppressed full sync for expired history, but does not silently retry permission errors", async () => {
    const f = fixture();
    vi.mocked(f.client.users.history.list).mockRejectedValueOnce({ response: { status: 404 } });
    const result = await f.source.read("1", f.limits, f.signal);
    expect(result).toMatchObject({
      cursor: "90071992547409930",
      resynced: true,
      events: [{ id: "resync:90071992547409930:m1" }],
    });
    vi.mocked(f.client.users.history.list).mockRejectedValueOnce({ response: { status: 403 } });
    await expect(f.source.read("1", f.limits, f.signal)).rejects.toEqual({ response: { status: 403 } });
    expect(f.client.users.messages.list).toHaveBeenCalledTimes(1);
  });
  it("caps resync message count and page count", async () => {
    const f = fixture();
    vi.mocked(f.client.users.history.list).mockRejectedValue({ code: 404 });
    vi.mocked(f.client.users.messages.list).mockResolvedValue({ data: { messages: [{ id: "m1" }, { id: "m2" }] } });
    await expect(f.source.read("1", { ...f.limits, maxResyncEvents: 1 }, f.signal)).rejects.toThrow("bound");
    expect(f.client.users.messages.get).not.toHaveBeenCalled();
    vi.mocked(f.client.users.messages.list).mockResolvedValue({ data: { nextPageToken: "more" } });
    await expect(f.source.read("1", f.limits, f.signal)).rejects.toThrow("page bound");
  });
  it("requires authenticated principal and fixed mailbox even if push claims match", async () => {
    const f = fixture();
    expect(await f.source.verifyTrigger?.("signed")).toMatchObject({
      tenantId: "t",
      actorId: "a",
      sourceScope: "me@example.com",
    });
    vi.mocked(f.options.verifyPush!).mockResolvedValueOnce({
      identity: { tenantId: "other", actorId: "a" },
      messageId: "p2",
      data: { emailAddress: "me@example.com", historyId: "2" },
    });
    await expect(f.source.verifyTrigger?.("spoof")).rejects.toThrow("does not own");
    vi.mocked(f.options.verifyPush!).mockRejectedValueOnce(new Error("signature invalid"));
    await expect(f.source.verifyTrigger?.("bad")).rejects.toThrow("signature");
  });
});
