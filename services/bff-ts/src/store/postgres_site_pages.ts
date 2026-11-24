import type postgres from "postgres";
import {
  SitePageSlugSchema,
  type CreateSitePageRequest,
  type PublicSitePageNavItem,
  type SitePage,
  type UpdateSitePageRequest,
} from "@slipgate/contracts";
import type { SitePagesStore } from "./site_pages_types.ts";
import { StoreError } from "./types.ts";

type Sql = ReturnType<typeof postgres>;
const pgCode = (err: unknown): string | undefined => (err as { code?: string } | null)?.code;

export const PG_SITE_PAGES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS commerce.site_pages (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL,
    summary     TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL DEFAULT '',
    published   BOOLEAN NOT NULL DEFAULT FALSE,
    show_in_nav BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_site_pages_pub_nav
    ON commerce.site_pages (published, show_in_nav, sort_order, slug);
`;

interface SitePageRow {
  id: string;
  slug: string;
  title: string;
  summary: string;
  body: string;
  published: boolean;
  showInNav: boolean;
  sortOrder: number;
  createdAtIso: string;
  updatedAtIso: string;
}

function toSitePage(r: SitePageRow): SitePage {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    summary: r.summary,
    body: r.body,
    published: r.published,
    showInNav: r.showInNav,
    sortOrder: r.sortOrder,
    createdAtIso: r.createdAtIso,
    updatedAtIso: r.updatedAtIso,
  };
}

export class PostgresSitePagesStore implements SitePagesStore {
  constructor(private readonly sql: Sql) {}

  async listAll(): Promise<SitePage[]> {
    const rows = await this.sql<SitePageRow[]>`
      SELECT id, slug, title, summary, body, published,
             show_in_nav AS "showInNav",
             sort_order AS "sortOrder",
             created_at::text AS "createdAtIso",
             updated_at::text AS "updatedAtIso"
        FROM commerce.site_pages
       ORDER BY sort_order ASC, slug ASC
    `;
    return rows.map(toSitePage);
  }

  async listPublicNav(): Promise<PublicSitePageNavItem[]> {
    return this.sql<PublicSitePageNavItem[]>`
      SELECT slug, title, summary, sort_order AS "sortOrder"
        FROM commerce.site_pages
       WHERE published = TRUE AND show_in_nav = TRUE
       ORDER BY sort_order ASC, slug ASC
    `;
  }

  async getBySlug(slug: string, options?: { includeDrafts?: boolean }): Promise<SitePage | null> {
    const norm = slug.trim().toLowerCase();
    const rows = await this.sql<SitePageRow[]>`
      SELECT id, slug, title, summary, body, published,
             show_in_nav AS "showInNav",
             sort_order AS "sortOrder",
             created_at::text AS "createdAtIso",
             updated_at::text AS "updatedAtIso"
        FROM commerce.site_pages
       WHERE slug = ${norm}
         AND (${Boolean(options?.includeDrafts)}::boolean OR published = TRUE)
       LIMIT 1
    `;
    return rows[0] ? toSitePage(rows[0]) : null;
  }

  async getById(id: string): Promise<SitePage | null> {
    const rows = await this.sql<SitePageRow[]>`
      SELECT id, slug, title, summary, body, published,
             show_in_nav AS "showInNav",
             sort_order AS "sortOrder",
             created_at::text AS "createdAtIso",
             updated_at::text AS "updatedAtIso"
        FROM commerce.site_pages
       WHERE id = ${id}
       LIMIT 1
    `;
    return rows[0] ? toSitePage(rows[0]) : null;
  }

  async create(input: CreateSitePageRequest): Promise<SitePage> {
    const slug = SitePageSlugSchema.parse(input.slug);
    const id = `page_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    try {
      const rows = await this.sql<SitePageRow[]>`
        INSERT INTO commerce.site_pages (id, slug, title, summary, body, published, show_in_nav, sort_order)
        VALUES (${id}, ${slug}, ${input.title.trim()}, ${input.summary.trim()}, ${input.body},
                ${input.published}, ${input.showInNav}, ${input.sortOrder})
        RETURNING id, slug, title, summary, body, published,
                  show_in_nav AS "showInNav",
                  sort_order AS "sortOrder",
                  created_at::text AS "createdAtIso",
                  updated_at::text AS "updatedAtIso"
      `;
      return toSitePage(rows[0]);
    } catch (err) {
      if (pgCode(err) === "23505") {
        throw new StoreError("conflict", `Site page slug "${slug}" already exists`);
      }
      throw err;
    }
  }

  async update(id: string, input: UpdateSitePageRequest): Promise<SitePage> {
    const existing = await this.getById(id);
    if (!existing) throw new StoreError("not_found", `Site page not found: ${id}`);
    const nextSlug = input.slug !== undefined ? SitePageSlugSchema.parse(input.slug) : existing.slug;
    try {
      const rows = await this.sql<SitePageRow[]>`
        UPDATE commerce.site_pages
           SET slug = ${nextSlug},
               title = ${input.title !== undefined ? input.title.trim() : existing.title},
               summary = ${input.summary !== undefined ? input.summary.trim() : existing.summary},
               body = ${input.body !== undefined ? input.body : existing.body},
               published = ${input.published !== undefined ? input.published : existing.published},
               show_in_nav = ${input.showInNav !== undefined ? input.showInNav : existing.showInNav},
               sort_order = ${input.sortOrder !== undefined ? input.sortOrder : existing.sortOrder},
               updated_at = NOW()
         WHERE id = ${id}
        RETURNING id, slug, title, summary, body, published,
                  show_in_nav AS "showInNav",
                  sort_order AS "sortOrder",
                  created_at::text AS "createdAtIso",
                  updated_at::text AS "updatedAtIso"
      `;
      if (!rows[0]) throw new StoreError("not_found", `Site page not found: ${id}`);
      return toSitePage(rows[0]);
    } catch (err) {
      if (pgCode(err) === "23505") {
        throw new StoreError("conflict", `Site page slug "${nextSlug}" already exists`);
      }
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    const res = await this.sql`DELETE FROM commerce.site_pages WHERE id = ${id}`;
    if (res.count === 0) {
      throw new StoreError("not_found", `Site page not found: ${id}`);
    }
  }
}
