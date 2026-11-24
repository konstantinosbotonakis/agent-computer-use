import os from "node:os";
import path from "node:path";

// Fixed by the public key in extension/manifest.json.
export const EXTENSION_ID = "ihapafjdgdhggebaglklkgenffidmejp";
export const NATIVE_HOST_NAME = "com.agentcomputeruse.host";

export const STATE_DIR = process.env.AGENT_COMPUTER_USE_HOME ?? path.join(os.homedir(), ".agent-computer-use");
export const BROKER_SOCKET = path.join(STATE_DIR, "broker.sock");
export const HOST_LAUNCHER = path.join(STATE_DIR, "native-host.sh");
// install copies the host and the extension here, so they keep working after npx clears its
// cache or the package moves.
export const INSTALLED_HOST_DIR = path.join(STATE_DIR, "host");
export const INSTALLED_EXTENSION_DIR = path.join(STATE_DIR, "extension");
