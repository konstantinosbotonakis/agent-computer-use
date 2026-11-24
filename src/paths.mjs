import os from "node:os";
import path from "node:path";

// Fixed by the public key in extension/manifest.json.
export const EXTENSION_ID = "ihapafjdgdhggebaglklkgenffidmejp";
export const NATIVE_HOST_NAME = "com.agentcomputeruse.host";

export const STATE_DIR = process.env.AGENT_COMPUTER_USE_HOME ?? path.join(os.homedir(), ".agent-computer-use");
export const BROKER_SOCKET = path.join(STATE_DIR, "broker.sock");
export const HOST_LAUNCHER = path.join(STATE_DIR, "native-host.sh");
