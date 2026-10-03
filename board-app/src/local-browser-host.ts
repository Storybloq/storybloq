import {
  AppBridge,
  PostMessageTransport,
} from "@modelcontextprotocol/ext-apps/app-bridge";

import { localBrowserPost } from "./local-browser-transport.js";
const capability = location.hash.slice(1);
const requestedTheme = new URLSearchParams(location.search).get("theme");
const theme =
  requestedTheme === "light" || requestedTheme === "dark"
    ? requestedTheme
    : matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
const status = document.getElementById("status")!;
const frame = document.getElementById("board") as HTMLIFrameElement;
async function open() {
  if (!/^[a-f0-9]{64}$/.test(capability))
    throw Error("Open Storybloq using the link from this project's task.");
  const initial = await localBrowserPost(capability, { operation: "open" });
  const bridge = new AppBridge(
    null,
    { name: "Storybloq local board", version: "1" },
    { serverTools: {} },
    {
      hostContext: {
        theme,
        displayMode: "inline",
        availableDisplayModes: ["inline"],
      },
    },
  );
  bridge.oncalltool = async (params) =>
    localBrowserPost(capability, {
      operation: "call",
      name: params.name,
      arguments: params.arguments ?? {},
    });
  bridge.oninitialized = async () => {
    await bridge.sendToolInput({ arguments: {} });
    await bridge.sendToolResult(initial.result);
    status.hidden = true;
  };
  await bridge.connect(
    new PostMessageTransport(frame.contentWindow!, frame.contentWindow!),
  );
  frame.srcdoc = initial.html;
  window.addEventListener(
    "pagehide",
    () => {
      void bridge.close();
    },
    { once: true },
  );
}
void open().catch((error) => {
  status.textContent =
    error instanceof Error
      ? error.message
      : "Storybloq could not open. Return to the project task and open it again.";
});
