import net from "node:net";
import { BROKER_SOCKET } from "./paths.mjs";

const NOT_REACHABLE =
  "Agent Computer Use is not reachable. Check that Chrome is running with the Agent Computer Use extension enabled, then run `agent-computer-use doctor`.";

// Talks to the native host over its Unix socket. Connects on first use and again after the
// host goes away, for example when Chrome restarts.
export class BrokerClient {
  #socket = null;
  #connecting = null;
  #nextId = 1;
  #pending = new Map(); // request id -> { resolve, reject }
  #eventListeners = new Set();

  onEvent(listener) {
    this.#eventListeners.add(listener);
  }

  async request(op, params = {}, timeoutMs = 30_000) {
    const socket = await this.#connect();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Chrome did not answer ${op} within ${timeoutMs / 1000} seconds.`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.write(JSON.stringify({ id, op, params }) + "\n");
    });
  }

  close() {
    this.#socket?.end();
  }

  #connect() {
    if (this.#socket) return Promise.resolve(this.#socket);
    this.#connecting ??= new Promise((resolve, reject) => {
      const socket = net.createConnection(BROKER_SOCKET);
      let buffered = "";
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        this.#socket = socket;
        resolve(socket);
      });
      socket.on("data", (chunk) => {
        buffered += chunk;
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line.trim()) this.#handleMessage(JSON.parse(line));
          newline = buffered.indexOf("\n");
        }
      });
      socket.on("error", (error) => reject(new Error(`${NOT_REACHABLE} (${error.code ?? error.message})`)));
      socket.on("close", () => this.#handleClose());
    }).finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  #handleMessage(message) {
    if (message.event) {
      for (const listener of this.#eventListeners) listener(message);
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
  }

  #handleClose() {
    this.#socket = null;
    for (const { reject } of this.#pending.values()) reject(new Error("The connection to Chrome closed. Retry the call."));
    this.#pending.clear();
    for (const listener of this.#eventListeners) listener({ event: "bridge.closed", params: {} });
  }
}
