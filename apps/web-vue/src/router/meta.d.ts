import "vue-router";

export {};

declare module "vue-router" {
  interface RouteMeta {
    title?: string;
    layout?: "auth" | "app";
    requiresAuth?: boolean;
    requiresAdmin?: boolean;
  }
}
