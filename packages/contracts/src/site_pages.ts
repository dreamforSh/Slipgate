import { z } from "zod";

export const SitePageSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must use lowercase letters, digits and hyphens");

export const SitePageSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  body: z.string(),
  published: z.boolean(),
  showInNav: z.boolean(),
  sortOrder: z.number().int(),
  createdAtIso: z.string(),
  updatedAtIso: z.string(),
});
export type SitePage = z.infer<typeof SitePageSchema>;

export const PublicSitePageNavItemSchema = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  sortOrder: z.number().int(),
});
export type PublicSitePageNavItem = z.infer<typeof PublicSitePageNavItemSchema>;

export const CreateSitePageRequestSchema = z.object({
  slug: SitePageSlugSchema,
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(300).default(""),
  body: z.string().max(100_000).default(""),
  published: z.boolean().default(false),
  showInNav: z.boolean().default(false),
  sortOrder: z.number().int().min(-9999).max(9999).default(0),
});
export type CreateSitePageRequest = z.infer<typeof CreateSitePageRequestSchema>;

export const UpdateSitePageRequestSchema = z.object({
  slug: SitePageSlugSchema.optional(),
  title: z.string().trim().min(1).max(120).optional(),
  summary: z.string().trim().max(300).optional(),
  body: z.string().max(100_000).optional(),
  published: z.boolean().optional(),
  showInNav: z.boolean().optional(),
  sortOrder: z.number().int().min(-9999).max(9999).optional(),
});
export type UpdateSitePageRequest = z.infer<typeof UpdateSitePageRequestSchema>;
