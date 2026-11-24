// Chrome native messaging frames every JSON message with a 32-bit length prefix in native
// byte order, which is little-endian on every platform Chrome supports.

export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

// Returns a function that takes raw stdin chunks and calls onMessage once per complete message.
export function createMessageReader(onMessage) {
  let buffered = Buffer.alloc(0);
  return (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (buffered.length < 4 + length) return;
      const body = buffered.subarray(4, 4 + length);
      buffered = buffered.subarray(4 + length);
      onMessage(JSON.parse(body.toString("utf8")));
    }
  };
}
