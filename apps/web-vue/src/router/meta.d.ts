import "vue-router";

export {};

declare module "vue-router" {
  interface RouteMeta {
    /** i18n key for the page title (document title + breadcrumb). */
    titleKey?: string;
    /** auth: centred card (login/setup); public: PublicLayout pages; app (default): AppShell. */
    layout?: "auth" | "app" | "public";
    requiresAuth?: boolean;
    requiresAdmin?: boolean;
    /** Signed-out visitors whose URL carries a `token` query go here (query kept) instead of the login page. */
    guestRedirect?: string;
  }
}
