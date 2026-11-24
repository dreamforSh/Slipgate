import type { CreateSitePageRequest, PublicSitePageNavItem, SitePage, UpdateSitePageRequest } from "@slipgate/contracts";

export interface SitePagesStore {
  listAll(): Promise<SitePage[]>;
  listPublicNav(): Promise<PublicSitePageNavItem[]>;
  getBySlug(slug: string, options?: { includeDrafts?: boolean }): Promise<SitePage | null>;
  getById(id: string): Promise<SitePage | null>;
  create(input: CreateSitePageRequest): Promise<SitePage>;
  update(id: string, input: UpdateSitePageRequest): Promise<SitePage>;
  delete(id: string): Promise<void>;
}
