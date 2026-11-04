import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const STORE_NAME = "ruang-pdt06";
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const ROOM_ID_PATTERN = /^[a-f0-9]{36}$/;
const QUESTION_ID_PATTERN = /^[a-f0-9]{32}$/;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function readBody(request) {
  if (!request.body) throw new ApiError(400, "A JSON request body is required.");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ApiError(
        413,
        "This request exceeds Netlify's 6 MB function payload limit. Shorten it or split it into smaller questions; your draft is still here.",
      );
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, "The request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "The request body must be a JSON object.");
  }
  return body;
}

function roomKey(id) {
  return `rooms/${id}/state`;
}

function questionPrefix(id, epoch) {
  return `rooms/${id}/epochs/${epoch}/questions/`;
}

function submissionKey(id, questionId) {
  return `rooms/${id}/submissions/${questionId}`;
}

function questionKey(id, epoch, questionId) {
  return `${questionPrefix(id, epoch)}${questionId}`;
}

function publicRoom(room) {
  return { id: room.id, open: room.open, epoch: room.epoch, createdAt: room.createdAt };
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function matchesOwner(room, request) {
  const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token || !/^[a-f0-9]{64}$/.test(room.ownerHash || "")) return false;
  const expected = Buffer.from(room.ownerHash, "hex");
  const supplied = Buffer.from(hashToken(token), "hex");
  return timingSafeEqual(expected, supplied);
}

async function getRoom(store, id) {
  const room = await store.get(roomKey(id), { consistency: "strong", type: "json" });
  if (!room) throw new ApiError(404, "Classroom unavailable. Check the link with the presenter.");
  return room;
}

async function updateRoom(store, id, update) {
  const key = roomKey(id);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const entry = await store.getWithMetadata(key, { consistency: "strong", type: "json" });
    if (!entry) throw new ApiError(404, "Classroom unavailable. Check the link with the presenter.");
    const next = update(entry.data);
    const result = await store.setJSON(key, next, { onlyIfMatch: entry.etag });
    if (result.modified) return { room: next, previous: entry.data };
  }
  throw new ApiError(409, "The classroom changed at the same time. Refresh and try again.");
}

async function getSnapshot(store, id, request) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const roomBefore = await getRoom(store, id);
    const { blobs } = await store.list({ prefix: questionPrefix(id, roomBefore.epoch) });
    const questions = await Promise.all(
      blobs.map(async ({ key }) => store.get(key, { consistency: "strong", type: "json" })),
    );
    const roomAfter = await getRoom(store, id);
    if (roomBefore.revision !== roomAfter.revision) continue;

    return {
      room: publicRoom(roomAfter),
      owner: matchesOwner(roomAfter, request),
      questions: questions
        .filter((question) => question && question.epoch === roomAfter.epoch)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    };
  }
  throw new ApiError(409, "The classroom is changing too quickly. Retry the update.");
}

async function requireOwner(store, id, request) {
  const room = await getRoom(store, id);
  if (!matchesOwner(room, request)) {
    throw new ApiError(403, "Only the presenter who created this classroom can do that.");
  }
  return room;
}

async function submitQuestion(store, id, body) {
  if (typeof body.id !== "string" || !QUESTION_ID_PATTERN.test(body.id)) {
    throw new ApiError(400, "The question ID is invalid.");
  }
  if (typeof body.text !== "string" || !body.text.trim()) {
    throw new ApiError(400, "Please write a question first.");
  }

  const textHash = hashToken(body.text);
  let submission = await store.get(submissionKey(id, body.id), {
    consistency: "strong",
    type: "json",
  });

  if (submission && submission.textHash !== textHash) {
    throw new ApiError(409, "This draft ID was already used for different text. Edit the draft and send it again.");
  }

  let room = await getRoom(store, id);
  if (!submission) {
    if (!room.open) throw new ApiError(409, "This classroom is closed. Your draft is still here.");
    const candidate = {
      id: body.id,
      textHash,
      createdAt: Date.now(),
      epoch: room.epoch,
    };
    const result = await store.setJSON(submissionKey(id, body.id), candidate, { onlyIfNew: true });
    submission = result.modified
      ? candidate
      : await store.get(submissionKey(id, body.id), { consistency: "strong", type: "json" });
    if (!submission) throw new ApiError(409, "The question conflicted with another submission. Retry it.");
    if (submission.textHash !== textHash) {
      throw new ApiError(409, "This draft ID was already used for different text. Edit the draft and send it again.");
    }
  }

  room = await getRoom(store, id);
  let cleanupPending = false;
  if (submission.epoch === room.epoch) {
    const key = questionKey(id, submission.epoch, submission.id);
    await store.setJSON(
      key,
      { ...submission, text: body.text, resolved: false },
      { onlyIfNew: true },
    );
    room = await getRoom(store, id);
    if (submission.epoch !== room.epoch) {
      try {
        await store.delete(key);
      } catch (error) {
        cleanupPending = true;
        console.error("Ruang stale question cleanup failed:", error?.name || "UnknownError");
      }
    }
  } else {
    try {
      await store.delete(questionKey(id, submission.epoch, submission.id));
    } catch (error) {
      cleanupPending = true;
      console.error("Ruang stale question cleanup failed:", error?.name || "UnknownError");
    }
  }

  return {
    ok: true,
    cleared: submission.epoch < room.epoch,
    createdAt: submission.createdAt,
    cleanupPending,
  };
}

async function moderateQuestion(store, id, request, action, questionId) {
  if (typeof questionId !== "string" || !QUESTION_ID_PATTERN.test(questionId)) {
    throw new ApiError(400, "The question ID is invalid.");
  }

  let room = await requireOwner(store, id, request);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const key = questionKey(id, room.epoch, questionId);
    const entry = await store.getWithMetadata(key, { consistency: "strong", type: "json" });
    if (!entry) throw new ApiError(404, "That question is no longer in this classroom.");
    const result = await store.setJSON(
      key,
      { ...entry.data, resolved: action === "resolve" },
      { onlyIfMatch: entry.etag },
    );
    if (result.modified) return { ok: true, room: publicRoom(room) };
    room = await requireOwner(store, id, request);
  }
  throw new ApiError(409, "That question changed at the same time. Refresh and try again.");
}

export function createHandler(store) {
  return async function handler(request) {
    try {
      const requestUrl = new URL(request.url);
      const origin = request.headers.get("origin");
      if (origin && new URL(origin).origin !== requestUrl.origin) {
        throw new ApiError(403, "This classroom API only accepts same-origin requests.");
      }

      if (request.method === "GET") {
        const id = requestUrl.searchParams.get("room");
        if (!id) return jsonResponse({ ok: true });
        if (!ROOM_ID_PATTERN.test(id)) throw new ApiError(400, "The classroom link is invalid.");
        return jsonResponse(await getSnapshot(store, id, request));
      }

      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed." }, 405);
      }
      if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
        throw new ApiError(415, "Send classroom requests as JSON.");
      }

      const body = await readBody(request);
      if (body.action === "create") {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const id = randomBytes(18).toString("hex");
          const ownerToken = randomBytes(32).toString("base64url");
          const room = {
            id,
            ownerHash: hashToken(ownerToken),
            open: true,
            epoch: 0,
            revision: 0,
            createdAt: Date.now(),
          };
          const result = await store.setJSON(roomKey(id), room, { onlyIfNew: true });
          if (result.modified) {
            return jsonResponse({ ok: true, room: publicRoom(room), ownerToken }, 201);
          }
        }
        throw new ApiError(503, "A classroom could not be created. Please try again.");
      }

      if (typeof body.room !== "string" || !ROOM_ID_PATTERN.test(body.room)) {
        throw new ApiError(400, "The classroom link is invalid or missing.");
      }

      if (body.action === "question") {
        return jsonResponse(await submitQuestion(store, body.room, body));
      }
      if (body.action === "resolve" || body.action === "reopen") {
        return jsonResponse(await moderateQuestion(store, body.room, request, body.action, body.id));
      }
      if (body.action === "clear" || body.action === "open" || body.action === "close") {
        await requireOwner(store, body.room, request);
        const { room, previous } = await updateRoom(store, body.room, (latest) => {
          if (!matchesOwner(latest, request)) {
            throw new ApiError(403, "Only the presenter who created this classroom can do that.");
          }
          return {
            ...latest,
            open: body.action === "open" ? true : body.action === "close" ? false : latest.open,
            epoch: body.action === "clear" ? latest.epoch + 1 : latest.epoch,
            revision: latest.revision + 1,
          };
        });
        let cleanupPending = false;
        if (body.action === "clear") {
          try {
            const { blobs } = await store.list({ prefix: questionPrefix(body.room, previous.epoch) });
            const results = await Promise.allSettled(blobs.map(({ key }) => store.delete(key)));
            cleanupPending = results.some((result) => result.status === "rejected");
          } catch (error) {
            cleanupPending = true;
            console.error("Ruang question cleanup failed:", error?.name || "UnknownError");
          }
        }
        return jsonResponse({ ok: true, room: publicRoom(room), cleanupPending });
      }

      throw new ApiError(400, "The classroom operation is not supported.");
    } catch (error) {
      if (error instanceof ApiError) {
        return jsonResponse({ error: error.message }, error.status);
      }
      console.error("Ruang API request failed:", error?.name || "UnknownError");
      return jsonResponse({ error: "The shared classroom service failed. Please retry; your draft remains here." }, 500);
    }
  };
}

export default async function handler(request) {
  const store = getStore({ name: STORE_NAME, consistency: "strong" });
  return createHandler(store)(request);
}
