import { z } from "zod";

export const FeaturesSchema = z
  .object({
    tickets: z.boolean(),
    issues: z.boolean(),
    handovers: z.boolean(),
    roadmap: z.boolean(),
    reviews: z.boolean(),
    bus: z.boolean().optional(),
  })
  .passthrough();

export type Features = z.infer<typeof FeaturesSchema>;

// 1.8.0: passthrough (was strict) so future additive bus.* settings never brick
// older readers project-wide (ISS-858 pattern). No new tracked-config keys here.
export const BusConfigSchema = z.object({
  maxBodyBytes: z.number().int().min(1024).max(65536).optional(),
  maxHops: z.number().int().min(2).max(32).optional(),
  requireIssueForCritical: z.boolean().optional(),
  // T-430: per-project opt-in. When true, every new session auto-attaches to the
  // Bus with live delivery via the SessionStart hook (no per-session `bus setup`).
  autoAttach: z.boolean().optional(),
}).passthrough();

export type BusConfig = z.infer<typeof BusConfigSchema>;

/**
 * T-424: Per-project usage-limit auto-resume configuration (feature-scoped, at
 * ConfigSchema ROOT, deliberately not under recipeOverrides). The hook/waker
 * hot paths read this shape through core/limit-config.ts (raw JSON + clamping,
 * crash-proof); this schema is the validation + documentation surface.
 * Precedence: global kill switch (~/.claude/storybloq/config.json) >
 * project enabled:false > default on.
 */
// Numeric bounds mirror LIMIT_CONFIG_BOUNDS in core/limit-config.ts (the
// hot-path clamping reader): out-of-bounds values there fall back to defaults,
// and here they fail validation, so the two surfaces cannot silently drift.
export const LimitResumeConfigSchema = z.object({
  enabled: z.boolean().optional(),                       // default true
  plainMode: z.enum(["notify", "headless"]).optional(),  // default "notify"
  /** Autonomous-only: explicit per-project opt-in to wake bypass-posture sessions headlessly. Default false. */
  inheritBypass: z.boolean().optional(),
  // default 5. 0 is valid and means "never headless-wake" -- notify-mode
  // records (plain default + FINALIZE stops) still deliver their reset
  // notification because the waker dispatches notifies BEFORE the attempt cap.
  maxAttempts: z.number().int().min(0).max(100).optional(),
  staggerMs: z.number().int().min(0).max(600_000).optional(),     // default 20_000
  maxConcurrent: z.number().int().min(1).max(16).optional(),      // default 2
  /** 0 = inactivity-based child termination disabled (opt-in). Default 0. */
  childInactivityMs: z.number().int().min(0).max(86_400_000).optional(),
  fallbackResetMs: z.number().int().min(60_000).max(691_200_000).optional(), // default 18_000_000 (5h)
  notify: z.boolean().optional(),                        // default true
}).optional();

export const ConfigSchema = z
  .object({
    version: z.number().int().min(1),
    schemaVersion: z.number().int().optional(),
    project: z.string().min(1),
    type: z.string(),
    language: z.string(),
    features: FeaturesSchema,
    bus: BusConfigSchema.optional(),
    limitResume: LimitResumeConfigSchema,
    recipe: z.string().optional(),  // default "coding" applied in guide.ts handleStart
    // ISS-730: opt-in continuous cross-reference integrity check. When true,
    // loadProject runs a full validateProject pass and surfaces ERROR-level
    // findings as advisory "cross_reference" load warnings (never fatal, never
    // trips strict mode). Off by default to keep loads O(per-file) and to avoid
    // bricking reads on a pre-existing dangling reference.
    validateOnLoad: z.boolean().optional(),
    recipeOverrides: z.object({
      maxTicketsPerSession: z.number().min(0).optional(),
      compactThreshold: z.string().optional(),
      reviewBackends: z.array(z.string()).optional(),
      codexReviewBackends: z.array(z.string()).optional(),
      handoverInterval: z.number().min(0).optional(),
      stages: z.record(z.record(z.unknown())).optional(),
      // T-328: accepted-input set, not the canonical set. The legacy "none" is
      // still valid in any config written before this ticket; it normalizes to
      // "current" when the recipe is resolved.
      branchStrategy: z.enum(["current", "per-ticket", "main", "none"]).optional(),
      maxParallelAgents: z.number().min(1).max(8).optional(),
      // T-461: the review-effort dial. Declared here because this object is a
      // plain z.object -- an undeclared key is STRIPPED by parse, which is what
      // silently killed the project-default precedence level until an
      // end-to-end start test caught it.
      //
      // Deliberately NOT an enum, unlike branchStrategy above. project-loader
      // calls ConfigSchema.parse (not safeParse), so an enum would turn a typo
      // in this one field into a THROW that breaks every command that loads the
      // project. The dial's own normalizer fails an unreadable value closed to
      // standard, which costs the project today's review instead of its config.
      reviewEffort: z.unknown().optional(),
      // T-461: `lenses` and `maxLenses` are read by the lens harness. Declared
      // here for the same reason as reviewEffort -- an undeclared key is
      // STRIPPED by parse -- and permissive for the same reason too: this
      // schema is parsed, not safe-parsed, so a strict shape would turn a typo
      // into a throw that breaks every command. The harness validates and
      // falls back per field.
      lensConfig: z.unknown().optional(),
    }).optional(),
    nodes: z.record(z.string(), z.unknown()).optional(),
    orchestrator: z.string().optional(),
    federation: z.record(z.unknown()).optional(),
    team: z.object({
      enabled: z.boolean().optional(),
      minCliVersion: z.string().optional(),
      minMacVersion: z.string().optional(),
      requiredFeatures: z.array(z.string()).optional(),
      claimStalenessHours: z.number().finite().nonnegative().optional(),
      idAllocator: z.enum(["local", "git-refs"]).optional(),
      idAllocatorRemote: z.string().regex(/^[A-Za-z0-9._-]+$/).refine((v) => !v.startsWith("-"), "Remote name must not start with -").optional(),
      protectedRef: z.string().min(1).refine((v) => !v.startsWith("-"), "Protected ref must not start with -").optional(),
      mergeDriverVersion: z.number().int().optional(),
    }).optional(),
  })
  .passthrough();

export type Config = z.infer<typeof ConfigSchema>;
