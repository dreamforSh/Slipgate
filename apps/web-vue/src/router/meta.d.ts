import "vue-router";

export {};

declare module "vue-router" {
  interface RouteMeta {
    /** i18n key for the page title (document title + breadcrumb). */
    titleKey?: string;
    layout?: "auth" | "app";
    requiresAuth?: boolean;
    requiresAdmin?: boolean;
  }
}
