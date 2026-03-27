/**
 * Stage registration — imports all stage implementations and registers them.
 * Import this module once (in guide.ts) to populate the registry.
 */
import { registerStage } from "./registry.js";
import { PickTicketStage } from "./pick-ticket.js";
import { PlanStage } from "./plan.js";
import { PlanReviewStage } from "./plan-review.js";
import { ImplementStage } from "./implement.js";
import { TestStage } from "./test.js";
import { CodeReviewStage } from "./code-review.js";
import { FinalizeStage } from "./finalize.js";
import { CompleteStage } from "./complete.js";
import { HandoverStage } from "./handover.js";

// Register all extracted stages (pipeline order)
registerStage(new PickTicketStage());
registerStage(new PlanStage());
registerStage(new PlanReviewStage());
registerStage(new ImplementStage());
registerStage(new TestStage());
registerStage(new CodeReviewStage());
registerStage(new FinalizeStage());
registerStage(new CompleteStage());
registerStage(new HandoverStage());
