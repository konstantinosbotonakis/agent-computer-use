import assert from "node:assert/strict";
import { test } from "node:test";
import { createMessageReader, encodeMessage } from "../src/native-messaging.mjs";

test("a message survives encoding and decoding", () => {
  const received = [];
  createMessageReader((message) => received.push(message))(encodeMessage({ op: "ping", text: "héllo" }));
  assert.deepEqual(received, [{ op: "ping", text: "héllo" }]);
});

test("messages split across chunks and batched in one chunk are both decoded", () => {
  const received = [];
  const read = createMessageReader((message) => received.push(message));
  const frames = Buffer.concat([encodeMessage({ id: 1 }), encodeMessage({ id: 2 }), encodeMessage({ id: 3 })]);
  read(frames.subarray(0, 3));
  read(frames.subarray(3, 20));
  read(frames.subarray(20));
  assert.deepEqual(received, [{ id: 1 }, { id: 2 }, { id: 3 }]);
});
