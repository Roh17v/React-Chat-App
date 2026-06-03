// @ts-check
/**
 * Unit tests for wireFormat error paths.
 *
 * Covers task 2.3:
 *   - Each missing required field returns
 *     `{ ok: false, error: { kind: "MISSING_FIELD", field } }`
 *     without throwing (Req 12.5).
 *   - Unknown fields at any depth are ignored — `toLocalRow` does not throw
 *     and the local row never carries them (Req 12.4).
 */

import { describe, it, expect } from "vitest";

import { toLocalRow, toWirePayload } from "./wireFormat.js";

const baseTextMessage = () => ({
  _id: "msg_1",
  sender: "user_a",
  receiver: "user_b",
  messageType: "text",
  content: "hello",
  status: "sent",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
});

const baseFileMessage = () => ({
  _id: "msg_2",
  sender: { _id: "user_a", firstName: "A" },
  receiver: { _id: "user_b" },
  messageType: "file",
  fileUrl: "https://cdn.example.com/abc",
  fileName: "abc.png",
  fileMetadata: { width: 100, height: 100 },
  status: "delivered",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:01.000Z",
});

const baseCallMessage = () => ({
  _id: "msg_3",
  sender: "user_a",
  receiver: "user_b",
  messageType: "call",
  status: "sent",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
});

const baseChannelMessage = () => ({
  _id: "msg_4",
  sender: "user_a",
  channelId: "chan_1",
  messageType: "text",
  content: "hi all",
  status: "sent",
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
});

describe("toLocalRow — required field validation", () => {
  it("accepts a well-formed text DM message", () => {
    const result = toLocalRow(baseTextMessage());
    expect(result.ok).toBe(true);
  });

  it("accepts a well-formed file DM message", () => {
    const result = toLocalRow(baseFileMessage());
    expect(result.ok).toBe(true);
  });

  it("accepts a well-formed call message", () => {
    const result = toLocalRow(baseCallMessage());
    expect(result.ok).toBe(true);
  });

  it("accepts a well-formed channel message", () => {
    const result = toLocalRow(baseChannelMessage());
    expect(result.ok).toBe(true);
  });

  it.each([
    ["_id", { _id: undefined }],
    ["_id", { _id: "" }],
    ["_id", { _id: 123 }],
    ["sender", { sender: undefined }],
    ["sender", { sender: null }],
    ["sender", { sender: "" }],
    ["sender", { sender: {} }], // populated subdoc with no _id
    ["sender", { sender: { _id: "" } }],
    ["sender", { sender: { _id: 7 } }],
    ["messageType", { messageType: undefined }],
    ["messageType", { messageType: "video" }],
    ["messageType", { messageType: 42 }],
    ["createdAt", { createdAt: undefined }],
    ["createdAt", { createdAt: "" }],
    ["createdAt", { createdAt: 0 }],
    ["updatedAt", { updatedAt: undefined }],
    ["updatedAt", { updatedAt: "" }],
  ])("returns MISSING_FIELD %s when %p is malformed", (field, override) => {
    const m = { ...baseTextMessage(), ...override };
    const result = toLocalRow(m);
    expect(result).toEqual({
      ok: false,
      error: { kind: "MISSING_FIELD", field },
    });
  });

  it('returns MISSING_FIELD content when messageType="text" and content is missing', () => {
    const m = baseTextMessage();
    delete m.content;
    expect(toLocalRow(m)).toEqual({
      ok: false,
      error: { kind: "MISSING_FIELD", field: "content" },
    });
  });

  it('returns MISSING_FIELD content when messageType="text" and content is null', () => {
    const m = { ...baseTextMessage(), content: null };
    expect(toLocalRow(m)).toEqual({
      ok: false,
      error: { kind: "MISSING_FIELD", field: "content" },
    });
  });

  it('returns MISSING_FIELD content when messageType="text" and content is non-string', () => {
    const m = { ...baseTextMessage(), content: 42 };
    expect(toLocalRow(m)).toEqual({
      ok: false,
      error: { kind: "MISSING_FIELD", field: "content" },
    });
  });

  it('accepts empty-string content when messageType="text"', () => {
    // Empty content is meaningful (e.g. file caption attached to a text row),
    // so the serializer accepts it. Only undefined/null/non-string is rejected.
    const m = { ...baseTextMessage(), content: "" };
    const result = toLocalRow(m);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.content).toBe("");
  });

  it('returns MISSING_FIELD fileUrl when messageType="file" and fileUrl is missing', () => {
    const m = baseFileMessage();
    delete m.fileUrl;
    expect(toLocalRow(m)).toEqual({
      ok: false,
      error: { kind: "MISSING_FIELD", field: "fileUrl" },
    });
  });

  it('returns MISSING_FIELD fileUrl when messageType="file" and fileUrl is empty', () => {
    const m = { ...baseFileMessage(), fileUrl: "" };
    expect(toLocalRow(m)).toEqual({
      ok: false,
      error: { kind: "MISSING_FIELD", field: "fileUrl" },
    });
  });

  it('does not require content when messageType="call"', () => {
    const result = toLocalRow(baseCallMessage());
    expect(result.ok).toBe(true);
  });

  it('does not require fileUrl when messageType="text"', () => {
    const result = toLocalRow(baseTextMessage());
    expect(result.ok).toBe(true);
  });

  it("returns MISSING_FIELD _id when the input is null", () => {
    expect(toLocalRow(null)).toEqual({
      ok: false,
      error: { kind: "MISSING_FIELD", field: "_id" },
    });
  });

  it("returns MISSING_FIELD _id when the input is not an object", () => {
    expect(toLocalRow("not an object")).toEqual({
      ok: false,
      error: { kind: "MISSING_FIELD", field: "_id" },
    });
    expect(toLocalRow(42)).toEqual({
      ok: false,
      error: { kind: "MISSING_FIELD", field: "_id" },
    });
    expect(toLocalRow([])).toEqual({
      ok: false,
      error: { kind: "MISSING_FIELD", field: "_id" },
    });
  });
});

describe("toLocalRow — never throws", () => {
  it("does not throw on any of the malformed JSON-shaped inputs", () => {
    // Server payloads are always JSON-decoded values: scalars, plain objects,
    // arrays. The serializer's "never throws" contract (Req 12.4 / 12.5) is
    // bounded to that shape — it makes no guarantees about adversarial
    // objects that throw on property access (e.g. Proxies, getters), which
    // cannot occur after `JSON.parse`.
    const samples = [
      undefined,
      null,
      true,
      false,
      0,
      42,
      NaN,
      "string",
      "",
      [],
      [1, 2, 3],
      {},
      { _id: "x" },
      { _id: "x", sender: "y" },
      { _id: "x", sender: "y", messageType: "text" },
      { _id: "x", sender: { _id: "y" }, messageType: "file" },
      { _id: "x", sender: "y", messageType: "call", createdAt: "t" },
    ];
    for (const s of samples) {
      expect(() => toLocalRow(s)).not.toThrow();
    }
  });

  it("does not throw when fileMetadata contains a circular reference", () => {
    const cyclic = {};
    // @ts-ignore — building a cycle on purpose
    cyclic.self = cyclic;
    const m = { ...baseFileMessage(), fileMetadata: cyclic };
    expect(() => toLocalRow(m)).not.toThrow();
    const result = toLocalRow(m);
    // We accept the row (cycle is defended-against by the JSON.stringify
    // wrapper falling back to "{}").
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.fileMetadataJson).toBe("{}");
  });
});

describe("toLocalRow — ignores unknown fields at any depth", () => {
  it("ignores unknown top-level fields", () => {
    const m = {
      ...baseTextMessage(),
      __unknown_top__: "ghost",
      another_unknown: { nested: 1 },
      reactions: ["👍"], // future-feature field the current schema doesn't know
    };
    const result = toLocalRow(m);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const key of Object.keys(result.value)) {
      expect(key).not.toBe("__unknown_top__");
      expect(key).not.toBe("another_unknown");
      expect(key).not.toBe("reactions");
    }
  });

  it("ignores unknown fields nested inside sender / receiver subdocs", () => {
    const m = {
      ...baseTextMessage(),
      sender: { _id: "user_a", firstName: "A", roleHint: "admin" },
      receiver: {
        _id: "user_b",
        avatarColor: "#ff0",
        deeply: { nested: { unknown: true } },
      },
    };
    const result = toLocalRow(m);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.senderId).toBe("user_a");
    expect(result.value.receiverId).toBe("user_b");
  });

  it("preserves unknown nested fields inside fileMetadata (data is opaque to the serializer)", () => {
    // fileMetadata is opaque JSON: nested unknowns must NOT be stripped, since
    // the round-trip property requires they survive. This is the inverse of
    // top-level handling — the serializer treats `fileMetadata` as user data.
    const m = {
      ...baseFileMessage(),
      fileMetadata: {
        width: 10,
        unknown_thing: { nested: { deeply: "value" } },
        unicode: "héllo · 你好 · 🌍",
      },
    };
    const result = toLocalRow(m);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const restored = JSON.parse(result.value.fileMetadataJson);
    expect(restored).toEqual(m.fileMetadata);
  });

  it("preserves unknown fields inside replyTo (opaque payload)", () => {
    const m = {
      ...baseTextMessage(),
      replyTo: {
        messageId: "msg_99",
        senderId: "user_z",
        messageType: "text",
        previewText: "hi",
        // Unknown / future-feature fields:
        reactionSummary: { "👍": 2 },
        nested: { whatever: [1, 2, 3] },
      },
    };
    const result = toLocalRow(m);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replyToJson).not.toBeNull();
    const restored = JSON.parse(/** @type {string} */ (result.value.replyToJson));
    expect(restored).toEqual(m.replyTo);
  });
});

describe("toLocalRow — invariants of the returned row", () => {
  it("sets syncState='confirmed', queueSeq=null, localFilePath=null", () => {
    const result = toLocalRow(baseTextMessage());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.syncState).toBe("confirmed");
    expect(result.value.queueSeq).toBeNull();
    expect(result.value.localFilePath).toBeNull();
  });

  it("defaults fileMetadataJson to '{}' when fileMetadata is absent", () => {
    const result = toLocalRow(baseTextMessage());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fileMetadataJson).toBe("{}");
  });

  it("defaults fileMetadataJson to '{}' when fileMetadata is null", () => {
    const m = { ...baseTextMessage(), fileMetadata: null };
    const result = toLocalRow(m);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fileMetadataJson).toBe("{}");
  });

  it("defaults replyToJson to null when replyTo is absent", () => {
    const result = toLocalRow(baseTextMessage());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replyToJson).toBeNull();
  });

  it("normalizes sender as a bare id string", () => {
    const m = { ...baseTextMessage(), sender: "user_x" };
    const result = toLocalRow(m);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.senderId).toBe("user_x");
  });

  it("normalizes sender from a populated { _id } subdoc", () => {
    const m = {
      ...baseTextMessage(),
      sender: { _id: "user_y", firstName: "Y" },
    };
    const result = toLocalRow(m);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.senderId).toBe("user_y");
  });

  it("treats absent receiver (channel message) as null receiverId", () => {
    const result = toLocalRow(baseChannelMessage());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receiverId).toBeNull();
    expect(result.value.channelId).toBe("chan_1");
  });
});

describe("toWirePayload — defensive validation", () => {
  it("returns MISSING_FIELD on a row with no serverId", () => {
    const result = toWirePayload({
      serverId: null,
      senderId: "u",
      messageType: "text",
      content: "x",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: "MISSING_FIELD", field: "_id" },
    });
  });

  it("returns MISSING_FIELD when local row is not an object", () => {
    expect(toWirePayload(null)).toEqual({
      ok: false,
      error: { kind: "MISSING_FIELD", field: "_id" },
    });
  });

  it("does not throw on garbage input", () => {
    const samples = [undefined, null, 0, "x", [], {}];
    for (const s of samples) {
      expect(() => toWirePayload(s)).not.toThrow();
    }
  });

  it("recovers gracefully from corrupted fileMetadataJson by defaulting to {}", () => {
    const result = toWirePayload({
      serverId: "msg_1",
      senderId: "user_a",
      receiverId: "user_b",
      channelId: null,
      messageType: "text",
      content: "hi",
      fileUrl: null,
      fileName: null,
      fileMetadataJson: "{not valid json", // deliberately broken
      replyToJson: null,
      status: "sent",
      deletedForEveryone: false,
      deletedAt: null,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fileMetadata).toEqual({});
  });
});
