-- Lane S1: custom Markdown site pages mounted at /p/:slug and optional public navigation.

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
