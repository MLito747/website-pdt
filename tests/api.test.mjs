import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "../netlify/functions/api.mjs";

class MemoryBlobs {
  constructor() {
    this.values = new Map();
    this.version = 0;
  }

  async get(key) {
    const entry = this.values.get(key);
    return entry ? structuredClone(entry.value) : null;
  }

  async getWithMetadata(key) {
    const entry = this.values.get(key);
    return entry ? { data: structuredClone(entry.value), etag: entry.etag } : null;
  }

  async setJSON(key, value, options = {}) {
    const current = this.values.get(key);
    if (options.onlyIfNew && current) return { modified: false, etag: current.etag };
    if (options.onlyIfMatch !== undefined && current?.etag !== options.onlyIfMatch) {
      return { modified: false, etag: current?.etag };
    }
    const etag = `"${++this.version}"`;
    this.values.set(key, { value: structuredClone(value), etag });
    return { modified: true, etag };
  }

  async list({ prefix }) {
    return {
      blobs: [...this.values.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, etag: this.values.get(key).etag })),
    };
  }

  async delete(key) {
    this.values.delete(key);
  }
}

function createTestApi() {
  const store = new MemoryBlobs();
  const handler = createHandler(store);
  async function send(method, { body, room, token, origin } = {}) {
    const url = new URL("https://classroom.test/.netlify/functions/api");
    if (room) url.searchParams.set("room", room);
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    if (origin) headers.origin = origin;
    const request = new Request(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const response = await handler(request);
    return { status: response.status, data: await response.json() };
  }
  return { send, store };
}

async function createRoom(send) {
  const result = await send("POST", { body: { action: "create" } });
  assert.equal(result.status, 201);
  return result.data;
}

test("parallel submissions and retry keep independent, idempotent questions", async () => {
  const { send, store } = createTestApi();
  const { room, ownerToken } = await createRoom(send);
  const items = Array.from({ length: 32 }, (_, index) => ({
    action: "question",
    room: room.id,
    id: index.toString(16).padStart(32, "0"),
    text: `Question ${index}`,
  }));
  const results = await Promise.all(items.map((body) => send("POST", { body })));
  assert.ok(results.every((result) => result.status === 200));

  const retry = await send("POST", {
    body: { ...items[0], action: "question" },
  });
  assert.equal(retry.status, 200);
  const snapshot = await send("GET", { room: room.id, token: ownerToken });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.data.owner, true);
  assert.equal(snapshot.data.questions.length, items.length);
  assert.equal(new Set(snapshot.data.questions.map((question) => question.id)).size, items.length);
  assert.ok(snapshot.data.questions.every((question) => Number.isFinite(question.createdAt)));
  assert.equal(JSON.stringify(snapshot.data).includes(ownerToken), false);
  assert.equal(JSON.stringify(snapshot.data).includes("ownerHash"), false);
});

test("moderation requires the owner and resolve/reopen remain visible", async () => {
  const { send } = createTestApi();
  const { room, ownerToken } = await createRoom(send);
  const id = "b".repeat(32);
  await send("POST", { body: { action: "question", room: room.id, id, text: "A question" } });

  const denied = await send("POST", { body: { action: "resolve", room: room.id, id } });
  assert.equal(denied.status, 403);
  const resolved = await send("POST", {
    body: { action: "resolve", room: room.id, id },
    token: ownerToken,
  });
  assert.equal(resolved.status, 200);
  let snapshot = await send("GET", { room: room.id });
  assert.equal(snapshot.data.questions[0].resolved, true);

  const reopened = await send("POST", {
    body: { action: "reopen", room: room.id, id },
    token: ownerToken,
  });
  assert.equal(reopened.status, 200);
  snapshot = await send("GET", { room: room.id });
  assert.equal(snapshot.data.questions[0].resolved, false);
});

test("close blocks new submissions and owner refresh token reopens the room", async () => {
  const { send } = createTestApi();
  const { room, ownerToken } = await createRoom(send);
  const closed = await send("POST", {
    body: { action: "close", room: room.id },
    token: ownerToken,
  });
  assert.equal(closed.data.room.open, false);
  const blocked = await send("POST", {
    body: { action: "question", room: room.id, id: "c".repeat(32), text: "No longer open" },
  });
  assert.equal(blocked.status, 409);

  const refreshed = await send("GET", { room: room.id, token: ownerToken });
  assert.equal(refreshed.data.owner, true);
  const reopened = await send("POST", {
    body: { action: "open", room: room.id },
    token: ownerToken,
  });
  assert.equal(reopened.data.room.open, true);
});

test("clear advances the question generation and an old retry cannot repopulate it", async () => {
  const { send, store } = createTestApi();
  const { room, ownerToken } = await createRoom(send);
  const previous = { action: "question", room: room.id, id: "d".repeat(32), text: "Before clear" };
  await send("POST", { body: previous });
  const cleared = await send("POST", {
    body: { action: "clear", room: room.id },
    token: ownerToken,
  });
  assert.equal(cleared.data.room.epoch, 1);
  assert.deepEqual((await send("GET", { room: room.id })).data.questions, []);
  assert.equal([...store.values.keys()].some((key) => key.includes("/epochs/0/questions/")), false);

  const retry = await send("POST", { body: previous });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.cleared, true);
  assert.deepEqual((await send("GET", { room: room.id })).data.questions, []);

  const afterClear = await send("POST", {
    body: { action: "question", room: room.id, id: "e".repeat(32), text: "After clear" },
  });
  assert.equal(afterClear.status, 200);
  const snapshot = await send("GET", { room: room.id });
  assert.deepEqual(snapshot.data.questions.map((question) => question.text), ["After clear"]);
});

test("same-origin API rejects cross-origin requests", async () => {
  const { send } = createTestApi();
  const response = await send("GET", { origin: "https://outside.test" });
  assert.equal(response.status, 403);
});

test("blank and oversized questions receive clear client errors", async () => {
  const { send } = createTestApi();
  const { room } = await createRoom(send);
  const blank = await send("POST", {
    body: { action: "question", room: room.id, id: "f".repeat(32), text: " \n " },
  });
  assert.equal(blank.status, 400);
  const oversized = await send("POST", {
    body: { action: "question", room: room.id, id: "a".repeat(32), text: "x".repeat(6 * 1024 * 1024) },
  });
  assert.equal(oversized.status, 413);
  assert.match(oversized.data.error, /Netlify's 6 MB function payload limit/);
});
