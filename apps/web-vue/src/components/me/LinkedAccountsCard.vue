<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute, useRouter, type LocationQuery } from "vue-router";
import type { LinkedIdentity, OAuthProviderId, PublicOAuthProvider } from "@slipgate/contracts";
import { ApiError, apiJson, errorText } from "../../lib/api";
import { formatDateShort } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";
import { usePortalStore } from "../../stores/portal";
import { useToastStore } from "../../stores/toast";
import OAuthProviderMark from "../settings/OAuthProviderMark.vue";
import { OAUTH_DEFAULT_NAMES } from "../settings/oauthForm";
import ConfirmButton from "../ui/ConfirmButton.vue";
import UiAlert from "../ui/UiAlert.vue";
import UiBadge from "../ui/UiBadge.vue";
import UiCard from "../ui/UiCard.vue";
import UiIcon from "../ui/UiIcon.vue";

/**
 * Profile card for third-party sign-in identities: link (full-page OAuth round trip that comes
 * back as /profile?oauth_linked=<id> or ?oauth_error=<code>) and unlink. Hidden when the site
 * has no provider enabled.
 */
const { t, te } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const portal = usePortalStore();
const toast = useToastStore();

interface Row {
  id: OAuthProviderId;
  name: string;
  /** Still offered by the site; a disabled provider only lists an existing link (to unlink it). */
  enabled: boolean;
  identity: LinkedIdentity | null;
}

const status = ref<"loading" | "ready" | "error">("loading");
const loadError = ref("");
const providers = ref<PublicOAuthProvider[]>([]);
const linked = ref<LinkedIdentity[]>([]);
/** Provider with a request in flight (or a link redirect under way). */
const busy = ref<OAuthProviderId | null>(null);
/** Error code the provider round trip came back with. */
const returnError = ref<string | null>(null);
/** Row that was just linked, briefly highlighted. */
const highlight = ref<OAuthProviderId | null>(null);
let highlightTimer: number | undefined;

const isProviderId = (v: string): v is OAuthProviderId => Object.prototype.hasOwnProperty.call(OAUTH_DEFAULT_NAMES, v);
const providerName = (p: { id: OAuthProviderId; displayName?: string }) => p.displayName?.trim() || OAUTH_DEFAULT_NAMES[p.id];

const rows = computed<Row[]>(() => {
  const out: Row[] = providers.value.map((p) => ({
    id: p.id,
    name: providerName(p),
    enabled: true,
    identity: linked.value.find((l) => l.provider === p.id) ?? null,
  }));
  for (const l of linked.value) {
    if (isProviderId(l.provider) && !out.some((r) => r.id === l.provider)) {
      out.push({ id: l.provider, name: OAUTH_DEFAULT_NAMES[l.provider], enabled: false, identity: l });
    }
  }
  return out;
});

const linkedCount = computed(() => rows.value.filter((r) => r.identity).length);
const visible = computed(() => status.value === "error" || (status.value === "ready" && providers.value.length > 0));
const resetAvailable = computed(() => portal.settings?.passwordResetEnabled === true);
const forgotTo = computed(() => ({ path: "/forgot-password", query: auth.user?.email ? { email: auth.user.email } : {} }));

/** Origin of the site's API base URL, where linking has to happen (link_wrong_host names it). */
const siteOrigin = computed(() => {
  try {
    return new URL(portal.settings?.apiBaseUrl ?? "").origin;
  } catch {
    return "";
  }
});

const returnErrorText = computed(() => {
  const code = returnError.value;
  if (!code) return "";
  const key = `register.oauth.errors.${code}`;
  return /^[a-z_]+$/.test(code) && te(key) ? t(key, { origin: siteOrigin.value }) : t("register.oauth.genericError");
});

const CHIP: Record<OAuthProviderId, string> = {
  github: "bg-fg text-bg",
  google: "icon-chip-info",
  linuxdo: "icon-chip-warning",
  wechat: "icon-chip-success",
  dingtalk: "icon-chip-info",
  oidc: "icon-chip-accent",
};

/* ---------------- Data ---------------- */

async function load() {
  status.value = "loading";
  try {
    const res = await apiJson<{ providers?: PublicOAuthProvider[]; linked?: LinkedIdentity[] }>("/api/v1/user/oauth");
    providers.value = (res.providers ?? []).filter((p) => isProviderId(p.id));
    linked.value = res.linked ?? [];
    status.value = "ready";
  } catch (err) {
    loadError.value = errorText(err, t("profile.linked.loadFailed"));
    status.value = "error";
  }
}

/** Same-origin target only: the link URL comes back from our BFF and is followed blindly otherwise. */
function sameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.origin).origin === window.location.origin;
  } catch {
    return false;
  }
}

async function link(row: Row) {
  if (busy.value) return;
  busy.value = row.id;
  returnError.value = null;
  try {
    const res = await apiJson<{ url?: string }>(`/api/v1/user/oauth/${row.id}/link`, { method: "POST" });
    if (!res.url || !sameOrigin(res.url)) throw new Error(t("profile.linked.linkFailed"));
    // Keep the button busy: the page is navigating away to the provider.
    window.location.assign(res.url);
  } catch (err) {
    busy.value = null;
    // A refusal the card can explain (the console is open on another origin than the site's):
    // shown inline like a failed round trip.
    if (err instanceof ApiError && err.code === "link_wrong_host") {
      returnError.value = err.code;
      return;
    }
    toast.error(errorText(err, t("profile.linked.linkFailed")));
  }
}

async function unlink(row: Row) {
  if (busy.value) return;
  busy.value = row.id;
  try {
    await apiJson<{ unlinked: boolean }>(`/api/v1/user/oauth/${row.id}`, { method: "DELETE" });
    linked.value = linked.value.filter((l) => l.provider !== row.id);
    toast.success(t("profile.linked.unlinked", { name: row.name }));
  } catch (err) {
    toast.error(errorText(err, t("profile.linked.unlinkFailed")));
  } finally {
    busy.value = null;
  }
}

/* ---------------- Return from the provider ---------------- */

function firstQuery(q: LocationQuery, name: string): string {
  const raw = q[name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" ? v.trim() : "";
}

function flash(id: OAuthProviderId) {
  highlight.value = id;
  window.clearTimeout(highlightTimer);
  highlightTimer = window.setTimeout(() => (highlight.value = null), 2400);
}

/** Back from a bfcache restore (user pressed Back on the provider page): the redirect never happened. */
function onPageShow(e: PageTransitionEvent) {
  if (e.persisted) busy.value = null;
}

onMounted(async () => {
  window.addEventListener("pageshow", onPageShow);
  const linkedId = firstQuery(route.query, "oauth_linked");
  const errorCode = firstQuery(route.query, "oauth_error");
  if (linkedId || errorCode) {
    const query = { ...route.query };
    delete query.oauth_linked;
    delete query.oauth_error;
    void router.replace({ query });
  }
  await load();
  if (errorCode) {
    returnError.value = errorCode;
    // No card to hold the message (nothing enabled, or it failed to load): fall back to a toast.
    if (status.value !== "ready" || providers.value.length === 0) toast.error(returnErrorText.value);
  }
  if (linkedId && isProviderId(linkedId)) {
    const row = rows.value.find((r) => r.id === linkedId);
    toast.success(t("register.oauth.linked", { name: row?.name ?? OAUTH_DEFAULT_NAMES[linkedId] }));
    if (row) flash(linkedId);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("pageshow", onPageShow);
  window.clearTimeout(highlightTimer);
});
</script>

<template>
  <UiCard v-if="visible" icon="link" :title="t('profile.linked.title')">
    <template #actions>
      <UiBadge v-if="status === 'ready'" :tone="linkedCount ? 'success' : 'neutral'" :dot="linkedCount > 0">
        <span class="tabular-nums">{{ t("profile.linked.count", { n: linkedCount, total: rows.length }) }}</span>
      </UiBadge>
    </template>

    <!-- Load failure -->
    <UiAlert v-if="status === 'error'" tone="danger">
      {{ loadError }}
      <template #action>
        <button type="button" class="btn btn-ghost btn-xs -my-1 shrink-0" @click="load">
          <UiIcon name="refresh" :size="13" />
          {{ t("profile.linked.retry") }}
        </button>
      </template>
    </UiAlert>

    <template v-else>
      <p class="text-xs leading-relaxed text-fg-subtle">{{ t("profile.linked.desc") }}</p>

      <Transition
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
        enter-from-class="-translate-y-1 opacity-0"
        leave-to-class="opacity-0"
      >
        <UiAlert v-if="returnErrorText" tone="danger" class="mt-4" :title="t('profile.linked.linkErrorTitle')">
          {{ returnErrorText }}
          <template #action>
            <button
              type="button"
              class="btn btn-ghost btn-icon btn-xs -my-1 -mr-1 shrink-0"
              :aria-label="t('common.close')"
              @click="returnError = null"
            >
              <UiIcon name="x" :size="14" />
            </button>
          </template>
        </UiAlert>
      </Transition>

      <ul class="mt-4 divide-y divide-line/70 overflow-hidden rounded-lg border border-line/80">
        <li
          v-for="row in rows"
          :key="row.id"
          class="flex items-center gap-3 px-3.5 py-3 transition-colors duration-700 motion-reduce:transition-none"
          :class="highlight === row.id ? 'bg-success/[0.07]' : ''"
        >
          <span
            class="icon-chip h-10 w-10 rounded-xl transition-colors duration-300 motion-reduce:transition-none"
            :class="row.identity ? CHIP[row.id] : 'ring-1 ring-inset ring-line'"
            aria-hidden="true"
          >
            <OAuthProviderMark :provider="row.id" :size="18" />
          </span>

          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span class="truncate text-sm font-medium text-fg">{{ row.name }}</span>
              <UiBadge v-if="row.identity" tone="success" dot>{{ t("profile.linked.linked") }}</UiBadge>
              <UiBadge v-if="!row.enabled">{{ t("profile.linked.providerOff") }}</UiBadge>
            </p>
            <p
              class="mt-0.5 truncate text-xs text-fg-subtle"
              :title="row.identity ? t('profile.linked.subject', { id: row.identity.subject }) : undefined"
            >
              {{
                row.identity
                  ? t("profile.linked.linkedAt", { date: formatDateShort(row.identity.createdAtIso) })
                  : t("profile.linked.notLinkedHint", { name: row.name })
              }}
            </p>
          </div>

          <ConfirmButton
            v-if="row.identity"
            size="sm"
            icon="unlink"
            class="shrink-0"
            :label="busy === row.id ? t('common.submitting') : t('profile.linked.unlink')"
            :confirm-label="t('profile.linked.unlinkConfirm')"
            :disabled="busy !== null"
            @confirm="unlink(row)"
          />
          <button
            v-else-if="row.enabled"
            type="button"
            class="btn btn-secondary btn-sm shrink-0"
            :disabled="busy !== null"
            :aria-busy="busy === row.id"
            @click="link(row)"
          >
            <UiIcon :name="busy === row.id ? 'loader' : 'link'" :size="13" :spin="busy === row.id" />
            {{ busy === row.id ? t("profile.linked.linking") : t("profile.linked.link") }}
          </button>
        </li>
      </ul>
    </template>

    <template v-if="status === 'ready' && linkedCount > 0" #footer>
      <p class="flex items-start gap-2 text-xs leading-relaxed text-fg-subtle">
        <UiIcon name="alert" :size="13" class="mt-0.5 shrink-0 text-warning" />
        <span class="min-w-0">
          {{ t("profile.linked.unlinkWarning") }}
          <RouterLink
            v-if="resetAvailable"
            :to="forgotTo"
            class="ml-1 inline-flex items-center gap-0.5 whitespace-nowrap font-medium text-accent hover:underline"
          >
            {{ t("profile.linked.setPassword") }}
            <UiIcon name="arrow-right" :size="12" />
          </RouterLink>
        </span>
      </p>
    </template>
  </UiCard>
</template>
