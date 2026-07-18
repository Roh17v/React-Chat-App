/**
 * Property 19: Backend `since` filter and ordering
 *
 * Validates: Requirements 13.1, 13.2, 13.3
 *
 * For any DB state of the Message collection, any user `u` with access to a
 * conversation `c` (DM or channel), and any `(since, limit)` parameters with
 * `limit ≥ 1`, the response of `GET /api/messages/.../:id?since=&limit=` is
 * exactly `sortAsc({ m ∈ Messages(c) : m.createdAt > since AND m.deletedFor ∌ u })`
 * truncated to length `limit`.
 *
 * The test exercises the controller handlers directly with a real MongoDB
 * instance backed by mongodb-memory-server. We do not mock the model or the
 * query — the property is verified end-to-end against the real Mongoose
 * pipeline.
 */
import { describe, it, beforeAll, afterAll, beforeEach, expect } from "vitest";
import fc from "fast-check";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import Message from "../models/message.model.js";
import {
  getMessages,
  getChannelMessages,
} from "./message.controller.js";

let mongo;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

beforeEach(async () => {
  await Message.deleteMany({});
});

// --- Mock req/res helpers --------------------------------------------------

const mockRes = () => {
  const res = {};
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
};

const callDM = async ({ user, contactId, query }) => {
  const req = { params: { contactId: contactId.toString() }, user, query };
  const res = mockRes();
  let nextErr;
  await getMessages(req, res, (err) => {
    nextErr = err;
  });
  return { res, nextErr };
};

const callChannel = async ({ user, channelId, query }) => {
  const req = { params: { channelId: channelId.toString() }, user, query };
  const res = mockRes();
  let nextErr;
  await getChannelMessages(req, res, (err) => {
    nextErr = err;
  });
  return { res, nextErr };
};

// --- Generators ------------------------------------------------------------

// Bound timestamps to a small window so `since` cuts at meaningful points and
// shrinking is fast.
const MIN_TS = Date.UTC(2024, 0, 1);
const MAX_TS = Date.UTC(2024, 0, 2); // 24h window

const arbTimestamp = () => fc.integer({ min: MIN_TS, max: MAX_TS });

const arbObjectIdString = () =>
  fc.uuid().map(() => new mongoose.Types.ObjectId().toString());

// --- Property: getMessages with `since` -----------------------------------

describe("Property 19 — getMessages `since` filter and ordering", () => {
  it("returns sortAsc({ m : m.createdAt > since AND deletedFor ∌ u }) truncated to limit", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          // The two participants of the DM under test.
          userId: arbObjectIdString(),
          contactId: arbObjectIdString(),
          // A handful of other users (used to populate `deletedFor`).
          otherUsers: fc.array(arbObjectIdString(), { minLength: 0, maxLength: 3 }),
          // Random message rows. We allow `extra` rows from a different DM
          // pair to make sure the controller filters by conversation.
          rows: fc.array(
            fc.record({
              createdAt: arbTimestamp(),
              // Whether this row belongs to the DM under test or a foreign DM.
              foreign: fc.boolean(),
              // Whether the user under test has deleted-for-me'd this row.
              deletedForUser: fc.boolean(),
              // Direction inside the DM (sender = user vs sender = contact).
              userIsSender: fc.boolean(),
              content: fc.string({ maxLength: 16 }),
            }),
            { minLength: 0, maxLength: 25 }
          ),
          since: arbTimestamp(),
          limit: fc.integer({ min: 1, max: 200 }),
        }),
        async ({ userId, contactId, otherUsers, rows, since, limit }) => {
          // Reset state for each shrink/iteration.
          await Message.deleteMany({});

          const userOid = new mongoose.Types.ObjectId(userId);
          const contactOid = new mongoose.Types.ObjectId(contactId);
          const foreignOid = new mongoose.Types.ObjectId();

          // Insert all rows with explicit createdAt/updatedAt by using
          // `insertMany` with `timestamps: false` so Mongo does not overwrite
          // our chosen createdAt.
          const docs = rows.map((r) => {
            const sender = r.foreign
              ? foreignOid
              : r.userIsSender
              ? userOid
              : contactOid;
            const receiver = r.foreign
              ? new mongoose.Types.ObjectId()
              : r.userIsSender
              ? contactOid
              : userOid;
            const deletedFor = r.deletedForUser ? [userOid] : [];
            const t = new Date(r.createdAt);
            return {
              sender,
              receiver,
              messageType: "text",
              content: r.content || "x",
              deletedFor,
              createdAt: t,
              updatedAt: t,
            };
          });
          if (docs.length > 0) {
            await Message.insertMany(docs, { timestamps: false });
          }

          // Compute the oracle: rows in this DM, not deleted-for-user, with
          // createdAt strictly greater than `since`, sorted asc by createdAt,
          // then truncated to `limit`.
          const sinceMs = since;
          const expected = rows
            .map((r, i) => ({ r, i }))
            .filter(({ r }) => !r.foreign)
            .filter(({ r }) => !r.deletedForUser)
            .filter(({ r }) => r.createdAt > sinceMs)
            .sort((a, b) => {
              if (a.r.createdAt !== b.r.createdAt) {
                return a.r.createdAt - b.r.createdAt;
              }
              return a.i - b.i; // stable on input order if ts collides
            })
            .slice(0, limit)
            .map(({ r }) => r);

          const { res, nextErr } = await callDM({
            user: { _id: userOid },
            contactId: contactOid,
            query: {
              since: new Date(sinceMs).toISOString(),
              limit: String(limit),
            },
          });

          expect(nextErr).toBeUndefined();
          expect(res.statusCode).toBe(200);
          expect(Array.isArray(res.body)).toBe(true);

          // Compare cardinalities and ordering.
          expect(res.body.length).toBe(expected.length);

          // Ordering: ascending createdAt.
          for (let i = 1; i < res.body.length; i++) {
            expect(
              new Date(res.body[i].createdAt).getTime() >=
                new Date(res.body[i - 1].createdAt).getTime()
            ).toBe(true);
          }

          // Set-equivalence on (createdAt, content). Mongo may reorder rows
          // that share the same timestamp; the oracle sorts those by input
          // index, so we compare as multisets keyed by (ts, content).
          const keyOf = (m) =>
            `${new Date(m.createdAt).getTime()}::${m.content ?? ""}`;
          const actualKeys = res.body.map(keyOf).sort();
          const expectedKeys = expected
            .map((r) => `${r.createdAt}::${r.content || "x"}`)
            .sort();
          expect(actualKeys).toEqual(expectedKeys);

          // Req 13.5 — every returned row carries updatedAt.
          for (const m of res.body) {
            expect(m.updatedAt).toBeDefined();
          }
        }
      ),
      { numRuns: 30 }
    );
  });

  it("ignores rows whose createdAt is <= since (boundary is strict >)", async () => {
    const userOid = new mongoose.Types.ObjectId();
    const contactOid = new mongoose.Types.ObjectId();
    const t = new Date("2024-01-01T00:00:00.000Z");
    await Message.insertMany(
      [
        {
          sender: userOid,
          receiver: contactOid,
          messageType: "text",
          content: "at-boundary",
          createdAt: t,
          updatedAt: t,
        },
      ],
      { timestamps: false }
    );

    const { res } = await callDM({
      user: { _id: userOid },
      contactId: contactOid,
      query: { since: t.toISOString(), limit: "50" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns 400 on an invalid `since` timestamp", async () => {
    const userOid = new mongoose.Types.ObjectId();
    const contactOid = new mongoose.Types.ObjectId();
    const { nextErr } = await callDM({
      user: { _id: userOid },
      contactId: contactOid,
      query: { since: "not-a-date", limit: "50" },
    });
    expect(nextErr).toBeDefined();
    expect(nextErr.status || nextErr.statusCode).toBe(400);
  });
});

// --- Property: getChannelMessages with `since` ----------------------------

describe("Property 19 — getChannelMessages `since` filter and ordering", () => {
  it("returns sortAsc({ m : m.createdAt > since AND deletedFor ∌ u }) truncated to limit", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          userId: arbObjectIdString(),
          channelId: arbObjectIdString(),
          rows: fc.array(
            fc.record({
              createdAt: arbTimestamp(),
              // Whether this row belongs to the channel under test or another.
              foreign: fc.boolean(),
              deletedForUser: fc.boolean(),
              content: fc.string({ maxLength: 16 }),
            }),
            { minLength: 0, maxLength: 25 }
          ),
          since: arbTimestamp(),
          limit: fc.integer({ min: 1, max: 200 }),
        }),
        async ({ userId, channelId, rows, since, limit }) => {
          await Message.deleteMany({});

          const userOid = new mongoose.Types.ObjectId(userId);
          const channelOid = new mongoose.Types.ObjectId(channelId);
          const foreignChannel = new mongoose.Types.ObjectId();
          const senderOid = new mongoose.Types.ObjectId();

          const docs = rows.map((r) => {
            const t = new Date(r.createdAt);
            return {
              sender: senderOid,
              channelId: r.foreign ? foreignChannel : channelOid,
              messageType: "text",
              content: r.content || "x",
              deletedFor: r.deletedForUser ? [userOid] : [],
              createdAt: t,
              updatedAt: t,
            };
          });
          if (docs.length > 0) {
            await Message.insertMany(docs, { timestamps: false });
          }

          const sinceMs = since;
          const expected = rows
            .map((r, i) => ({ r, i }))
            .filter(({ r }) => !r.foreign)
            .filter(({ r }) => !r.deletedForUser)
            .filter(({ r }) => r.createdAt > sinceMs)
            .sort((a, b) =>
              a.r.createdAt !== b.r.createdAt
                ? a.r.createdAt - b.r.createdAt
                : a.i - b.i
            )
            .slice(0, limit)
            .map(({ r }) => r);

          const { res, nextErr } = await callChannel({
            user: { _id: userOid },
            channelId: channelOid,
            query: {
              since: new Date(sinceMs).toISOString(),
              limit: String(limit),
            },
          });

          expect(nextErr).toBeUndefined();
          expect(res.statusCode).toBe(200);
          expect(res.body.length).toBe(expected.length);

          for (let i = 1; i < res.body.length; i++) {
            expect(
              new Date(res.body[i].createdAt).getTime() >=
                new Date(res.body[i - 1].createdAt).getTime()
            ).toBe(true);
          }

          const keyOf = (m) =>
            `${new Date(m.createdAt).getTime()}::${m.content ?? ""}`;
          const actualKeys = res.body.map(keyOf).sort();
          const expectedKeys = expected
            .map((r) => `${r.createdAt}::${r.content || "x"}`)
            .sort();
          expect(actualKeys).toEqual(expectedKeys);

          for (const m of res.body) {
            expect(m.updatedAt).toBeDefined();
          }
        }
      ),
      { numRuns: 25 }
    );
  });
});

// --- Sanity: legacy (no since) path still works (Req 13.4) ----------------

describe("Legacy page+limit path is preserved when `since` is omitted", () => {
  it("returns rows sorted ascending after the controller's reverse() of desc-fetched page", async () => {
    const userOid = new mongoose.Types.ObjectId();
    const contactOid = new mongoose.Types.ObjectId();
    const docs = [];
    for (let i = 0; i < 5; i++) {
      const t = new Date(Date.UTC(2024, 0, 1, 0, 0, i));
      docs.push({
        sender: userOid,
        receiver: contactOid,
        messageType: "text",
        content: `m${i}`,
        createdAt: t,
        updatedAt: t,
      });
    }
    await Message.insertMany(docs, { timestamps: false });

    const { res } = await callDM({
      user: { _id: userOid },
      contactId: contactOid,
      query: { page: "1", limit: "50" },
    });
    expect(res.statusCode).toBe(200);
    // Controller returns sanitized.reverse() on the legacy path so callers see
    // the page in ascending order.
    expect(res.body.map((m) => m.content)).toEqual([
      "m0",
      "m1",
      "m2",
      "m3",
      "m4",
    ]);
    for (const m of res.body) {
      expect(m.updatedAt).toBeDefined();
    }
  });
});
