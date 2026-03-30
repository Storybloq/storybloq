import { z } from "zod";

export const FeaturesSchema = z
  .object({
    tickets: z.boolean(),
    issues: z.boolean(),
    handovers: z.boolean(),
    roadmap: z.boolean(),
    reviews: z.boolean(),
  })
  .passthrough();

export type Features = z.infer<typeof FeaturesSchema>;

export const ConfigSchema = z
  .object({
    version: z.number().int().min(1),
    schemaVersion: z.number().int().optional(),
    project: z.string().min(1),
    type: z.string(),
    language: z.string(),
    features: FeaturesSchema,
    recipe: z.string().optional(),  // default "coding" applied in guide.ts handleStart
    recipeOverrides: z.object({
      maxTicketsPerSession: z.number().min(0).optional(),
      compactThreshold: z.string().optional(),
      reviewBackends: z.array(z.string()).optional(),
    }).optional(),
  })
  .passthrough();

export type Config = z.infer<typeof ConfigSchema>;
