// Chrome starts this process when the Agent Computer Use extension connects to it. It bridges
// the extension, which speaks native messaging on stdin and stdout, and local agents, which
// send JSON lines over a Unix socket that only the current user can open.
//
// Agent to extension: { id, op, params } gains an "agent" field naming the socket it came from.
// Extension to agent: responses { agent, id, result | error } and events { agent, event, params }
// go back to that socket without the "agent" field.
import fs from "node:fs";
import net from "node:net";
import { createMessageReader, encodeMessage } from "./native-messaging.mjs";
import { BROKER_SOCKET, STATE_DIR } from "./paths.mjs";

const agentSockets = new Map(); // agent id -> socket
let nextAgentId = 1;

function sendToExtension(message) {
  process.stdout.write(encodeMessage(message));
}

function sendToAgent(agentId, message) {
  const socket = agentSockets.get(agentId);
  if (socket && !socket.destroyed) socket.write(JSON.stringify(message) + "\n");
}

process.stdin.on(
  "data",
  createMessageReader(({ agent, ...message }) => sendToAgent(agent, message)),
);
// Chrome closes stdin when the extension disconnects or Chrome quits.
process.stdin.on("end", () => process.exit(0));

function handleAgentLine(agentId, line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    sendToAgent(agentId, { error: "The message is not valid JSON." });
    return;
  }
  sendToExtension({ ...message, agent: agentId });
}

function acceptAgent(socket) {
  const agentId = nextAgentId++;
  agentSockets.set(agentId, socket);
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (line) handleAgentLine(agentId, line);
      newline = buffered.indexOf("\n");
    }
  });
  socket.on("close", () => {
    agentSockets.delete(agentId);
    sendToExtension({ agent: agentId, op: "agent.disconnected" });
  });
  socket.on("error", () => socket.destroy());
}

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(STATE_DIR, 0o700);
// A socket left by an earlier host is stale: Chrome runs one host per extension connection.
fs.rmSync(BROKER_SOCKET, { force: true });
const server = net.createServer(acceptAgent);
server.listen(BROKER_SOCKET, () => fs.chmodSync(BROKER_SOCKET, 0o600));
