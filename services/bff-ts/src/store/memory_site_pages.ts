import {
  SitePageSlugSchema,
  type CreateSitePageRequest,
  type PublicSitePageNavItem,
  type SitePage,
  type UpdateSitePageRequest,
} from "@slipgate/contracts";
import type { SitePagesStore } from "./site_pages_types.ts";
import { StoreError } from "./types.ts";

function sortPages(a: SitePage, b: SitePage): number {
  return a.sortOrder - b.sortOrder || a.slug.localeCompare(b.slug);
}

export class MemorySitePagesStore implements SitePagesStore {
  private readonly pages = new Map<string, SitePage>();

  async listAll(): Promise<SitePage[]> {
    return Array.from(this.pages.values())
      .map((p) => ({ ...p }))
      .sort(sortPages);
  }

  async listPublicNav(): Promise<PublicSitePageNavItem[]> {
    return Array.from(this.pages.values())
      .filter((p) => p.published && p.showInNav)
      .sort(sortPages)
      .map((p) => ({
        slug: p.slug,
        title: p.title,
        summary: p.summary,
        sortOrder: p.sortOrder,
      }));
  }

  async getBySlug(slug: string, options?: { includeDrafts?: boolean }): Promise<SitePage | null> {
    const norm = slug.trim().toLowerCase();
    for (const p of this.pages.values()) {
      if (p.slug === norm) {
        if (!options?.includeDrafts && !p.published) return null;
        return { ...p };
      }
    }
    return null;
  }

  async getById(id: string): Promise<SitePage | null> {
    const p = this.pages.get(id);
    return p ? { ...p } : null;
  }

  async create(input: CreateSitePageRequest): Promise<SitePage> {
    const slug = SitePageSlugSchema.parse(input.slug);
    for (const p of this.pages.values()) {
      if (p.slug === slug) {
        throw new StoreError("conflict", `Site page slug "${slug}" already exists`);
      }
    }
    const now = new Date().toISOString();
    const page: SitePage = {
      id: `page_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      slug,
      title: input.title.trim(),
      summary: input.summary.trim(),
      body: input.body,
      published: input.published,
      showInNav: input.showInNav,
      sortOrder: input.sortOrder,
      createdAtIso: now,
      updatedAtIso: now,
    };
    this.pages.set(page.id, page);
    return { ...page };
  }

  async update(id: string, input: UpdateSitePageRequest): Promise<SitePage> {
    const existing = this.pages.get(id);
    if (!existing) throw new StoreError("not_found", `Site page not found: ${id}`);
    const nextSlug = input.slug !== undefined ? SitePageSlugSchema.parse(input.slug) : existing.slug;
    if (nextSlug !== existing.slug) {
      for (const p of this.pages.values()) {
        if (p.id !== id && p.slug === nextSlug) {
          throw new StoreError("conflict", `Site page slug "${nextSlug}" already exists`);
        }
      }
    }
    const updated: SitePage = {
      ...existing,
      slug: nextSlug,
      title: input.title !== undefined ? input.title.trim() : existing.title,
      summary: input.summary !== undefined ? input.summary.trim() : existing.summary,
      body: input.body !== undefined ? input.body : existing.body,
      published: input.published !== undefined ? input.published : existing.published,
      showInNav: input.showInNav !== undefined ? input.showInNav : existing.showInNav,
      sortOrder: input.sortOrder !== undefined ? input.sortOrder : existing.sortOrder,
      updatedAtIso: new Date().toISOString(),
    };
    this.pages.set(id, updated);
    return { ...updated };
  }

  async delete(id: string): Promise<void> {
    if (!this.pages.delete(id)) {
      throw new StoreError("not_found", `Site page not found: ${id}`);
    }
  }
}
