import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import { mountWorkspace } from "./workspace-view.js";
import { startAutoRefresh } from "./polling.js";
const app = new App({ name: "Storybloq board", version: "0.1.0" });
new OpenAIExtensions(app);
const view = mountWorkspace(document, (name, args) =>
  app.callServerTool({ name, arguments: args }),
);
const theme = (context: ReturnType<App["getHostContext"]>) => {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables)
    applyHostStyleVariables(context.styles.variables);
};
app.ontoolresult = (r) => view.receive(r);
app.addEventListener("hostcontextchanged", theme);
let stopRefresh: (() => void) | undefined;
let tornDown = false;
app.onteardown = async () => {
  tornDown = true;
  stopRefresh?.();
  view.dispose();
  return {};
};
try {
  await app.connect();
  theme(app.getHostContext());
  if (!tornDown)
    stopRefresh = startAutoRefresh(
      () => view.autoRefresh(),
      () => document.visibilityState === "visible",
      (fn, ms) => window.setInterval(fn, ms),
      (timer) => window.clearInterval(timer),
    );
} catch {
  view.error();
}
