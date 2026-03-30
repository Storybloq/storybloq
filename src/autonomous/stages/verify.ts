import type { WorkflowStage, StageResult, StageAdvance, StageContext } from "./types.js";
import type { GuideReportInput } from "../session-types.js";
import { gitDiffNames } from "../git-inspector.js";

const MAX_VERIFY_RETRIES = 3;

// Next.js App Router: app/**/api/**/route.ts → GET /api/... (requires api/ segment — skip page handlers)
const APP_ROUTER_RE = /^(?:src\/)?app\/((?:.*\/)?api\/.*?)\/route\.[jt]sx?$/;
// Next.js Pages Router: pages/api/... → GET /api/...
const PAGES_ROUTER_RE = /^(?:src\/)?pages\/(api\/.*?)\.[jt]sx?$/;
// Dynamic segment [id] → 1, route group (...) → stripped
const DYNAMIC_SEGMENT_RE = /\[([^\]\.]+)\]/g;
const ROUTE_GROUP_RE = /\([^)]+\)\/?/g;
// Catch-all: [...slug] or [[...slug]]
const CATCH_ALL_RE = /\[\[?\.\.\./;

/**
 * VERIFY stage — smoke test HTTP endpoints after code review.
 *
 * enter(): Instruct agent to start dev server, curl endpoints, report results.
 * report(): Evaluate status codes. 5xx/0 → back(IMPLEMENT). 2xx/3xx → advance.
 *           4xx from explicit → warn+advance. Unparseable → retry.
 */
export class VerifyStage implements WorkflowStage {
  readonly id = "VERIFY";

  skip(ctx: StageContext): boolean {
    const config = ctx.recipe.stages?.VERIFY as Record<string, unknown> | undefined;
    return !config?.enabled;
  }

  async enter(ctx: StageContext): Promise<StageResult | StageAdvance> {
    const config = ctx.recipe.stages?.VERIFY as Record<string, unknown> | undefined;
    const startCommand = (config?.startCommand as string) ?? "npm run dev";
    const readinessUrl = (config?.readinessUrl as string) ?? "http://localhost:3000";
    const explicitEndpoints = (config?.endpoints as string[]) ?? [];
    const retryCount = ctx.state.verifyRetryCount ?? 0;

    // Resolve endpoints: explicit first, then auto-detect
    let endpoints = [...explicitEndpoints];
    let autoDetected = false;

    if (endpoints.length === 0) {
      const mergeBase = ctx.state.git.mergeBase;
      if (mergeBase) {
        const diffResult = await gitDiffNames(ctx.root, mergeBase);
        if (diffResult.ok) {
          const detected = detectEndpoints(diffResult.data);
          endpoints = detected.endpoints;
          autoDetected = endpoints.length > 0; // only true when endpoints actually found
          if (detected.skippedRoutes.length > 0) {
            ctx.appendEvent("verify_skipped_routes", {
              routes: detected.skippedRoutes,
            });
          }
        }
      }
    }

    // Persist autoDetected flag for report() to differentiate 4xx handling
    ctx.writeState({ verifyAutoDetected: autoDetected });

    // No endpoints → advance with note (ticket may not touch HTTP endpoints)
    if (endpoints.length === 0) {
      ctx.appendEvent("verify", { result: "no_endpoints", autoDetected: false });
      return { action: "advance" };
    }

    return {
      instruction: [
        `# Verify Endpoints ${retryCount > 0 ? `— Retry ${retryCount}` : ""}`,
        "",
        `Start the dev server and smoke test ${endpoints.length} endpoint(s).`,
        "",
        "**Steps:**",
        `1. Start server: \`${startCommand}\``,
        `2. Wait for readiness: curl ${readinessUrl} until it returns 200 (timeout: 30s)`,
        "   - If port is in use: `lsof -ti:PORT | xargs kill -9` then retry",
        `3. Curl each endpoint and record the HTTP status code:`,
        ...endpoints.map((e) => {
          const method = (e.match(/^(GET|POST|PUT|DELETE|PATCH)\s+/i)?.[1] ?? "GET").toUpperCase();
          const path = e.replace(/^(GET|POST|PUT|DELETE|PATCH)\s+/i, "");
          const methodFlag = method !== "GET" ? ` -X ${method}` : "";
          return `   - \`curl -s -o /dev/null -w "%{http_code}"${methodFlag} "${readinessUrl.replace(/\/$/, "")}${path}"\``;
        }),
        "4. Kill the server process",
        "",
        "Report results in your notes as a JSON array:",
        '```',
        `notes: ${JSON.stringify(endpoints.map((e) => ({ endpoint: e, status: "STATUS_CODE" })))}`,
        '```',
        "",
        "Call `claudestory_autonomous_guide` with:",
        '```json',
        `{ "sessionId": "${ctx.state.sessionId}", "action": "report", "report": { "completedAction": "verify_done", "notes": "<paste the JSON array above with actual status codes>" } }`,
        '```',
        "",
        autoDetected
          ? "**Note:** Endpoints were auto-detected from changed files. Dynamic segments use placeholder ID `1`. If a 404 is expected, seed a test record first."
          : "",
      ].filter(Boolean).join("\n"),
      reminders: [
        "Start the server, curl ALL endpoints, report results, then kill the server.",
        "Include the HTTP status code for each endpoint.",
      ],
      transitionedFrom: ctx.state.previousState ?? undefined,
    };
  }

  async report(ctx: StageContext, report: GuideReportInput): Promise<StageAdvance> {
    const notes = report.notes ?? "";
    const retryCount = ctx.state.verifyRetryCount ?? 0;
    const nextRetry = retryCount + 1;

    // Parse results
    let results: Array<{ endpoint: string; status: number }>;
    try {
      const parsed = JSON.parse(notes);
      if (!Array.isArray(parsed)) throw new Error("not array");
      results = parsed.map((r: { endpoint?: string; status?: unknown }) => ({
        endpoint: String(r.endpoint ?? ""),
        status: typeof r.status === "number" ? r.status : parseInt(String(r.status), 10),
      }));
      if (results.some((r) => !r.endpoint || isNaN(r.status))) throw new Error("invalid entry");
    } catch {
      // Unparseable → retry
      if (nextRetry >= MAX_VERIFY_RETRIES) {
        return exhaustionAction(ctx);
      }
      ctx.writeState({ verifyRetryCount: nextRetry });
      return {
        action: "retry",
        instruction: "Could not parse endpoint results. Report results as a JSON array: [{\"endpoint\": \"GET /api/users\", \"status\": 200}, ...]",
      };
    }

    // Check for server errors (5xx or 0)
    const serverErrors = results.filter((r) => r.status >= 500 || r.status === 0);
    if (serverErrors.length > 0) {
      ctx.writeState({ verifyRetryCount: 0 });
      ctx.appendEvent("verify", {
        result: "fail",
        errors: serverErrors,
      });
      const errorDetails = serverErrors.map((e) => `${e.endpoint}: ${e.status}`).join(", ");
      return {
        action: "back",
        target: "IMPLEMENT",
        reason: `Server errors: ${errorDetails}`,
      };
    }

    // Check for 4xx
    const clientErrors = results.filter((r) => r.status >= 400 && r.status < 500);
    if (clientErrors.length > 0) {
      const isAutoDetected = ctx.state.verifyAutoDetected ?? false;
      if (isAutoDetected) {
        // Auto-detected endpoints: 4xx may be bad path derivation → retry
        if (nextRetry >= MAX_VERIFY_RETRIES) {
          return exhaustionAction(ctx);
        }
        ctx.writeState({ verifyRetryCount: nextRetry });
        ctx.appendEvent("verify", { result: "retry_4xx_auto", clientErrors });
        return {
          action: "retry",
          instruction: [
            "Some auto-detected endpoints returned 4xx. This may be a bad path derivation or the endpoint needs data seeding.",
            `Errors: ${clientErrors.map((e) => `${e.endpoint}: ${e.status}`).join(", ")}`,
            "",
            "Try: seed test data first (e.g. POST to create a record, then re-curl). Or report the same results if 4xx is expected.",
          ].join("\n"),
        };
      }
      // Explicit endpoints: 4xx = advance with warning (user configured it)
      ctx.appendEvent("verify", { result: "pass_with_warnings", warnings: clientErrors });
    }

    // All 2xx/3xx (or 4xx from explicit) → advance
    ctx.writeState({ verifyRetryCount: 0 });
    ctx.appendEvent("verify", {
      result: clientErrors.length > 0 ? "pass_with_warnings" : "pass",
      endpointCount: results.length,
      statuses: results.map((r) => r.status),
    });
    return { action: "advance" };
  }
}

function exhaustionAction(ctx: StageContext): StageAdvance {
  ctx.writeState({ verifyRetryCount: 0 });
  ctx.appendEvent("verify", { result: "skipped_failed" });
  return { action: "advance" };
}

// --- Endpoint auto-detection ---

interface DetectedEndpoints {
  endpoints: string[];
  skippedRoutes: string[];
}

export function detectEndpoints(changedFiles: string[]): DetectedEndpoints {
  const endpoints: string[] = [];
  const skippedRoutes: string[] = [];

  for (const file of changedFiles) {
    // Skip catch-all routes
    if (CATCH_ALL_RE.test(file)) {
      skippedRoutes.push(file);
      continue;
    }

    // Next.js App Router
    const appMatch = file.match(APP_ROUTER_RE);
    if (appMatch) {
      let path = appMatch[1]!;
      path = path.replace(ROUTE_GROUP_RE, ""); // strip route groups
      path = path.replace(DYNAMIC_SEGMENT_RE, "1"); // dynamic → placeholder
      path = path.replace(/\/$/, ""); // trailing slash
      endpoints.push(`GET /${path}`);
      continue;
    }

    // Next.js Pages Router
    const pagesMatch = file.match(PAGES_ROUTER_RE);
    if (pagesMatch) {
      let path = pagesMatch[1]!;
      path = path.replace(DYNAMIC_SEGMENT_RE, "1");
      // Remove /index suffix
      path = path.replace(/\/index$/, "");
      endpoints.push(`GET /${path}`);
      continue;
    }
  }

  return { endpoints: [...new Set(endpoints)], skippedRoutes };
}
