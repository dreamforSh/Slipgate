import { computed, ref, watch } from "vue";
import { usePortalStore } from "../stores/portal";

const STORAGE_KEY = "slipgate_login_agreement";

function readAcceptedRevision(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { revision?: unknown };
    return typeof parsed.revision === "string" ? parsed.revision : null;
  } catch {
    return null;
  }
}

function writeAcceptedRevision(revision: string | null) {
  try {
    if (revision) localStorage.setItem(STORAGE_KEY, JSON.stringify({ revision, acceptedAt: new Date().toISOString() }));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private mode): consent lasts for this page only.
  }
}

/**
 * The login / sign-up agreement gate (terms, privacy …) from the public settings. Consent is kept
 * in this browser per revision: a new date or any edited document asks again.
 */
export function useLoginAgreement() {
  const portal = usePortalStore();
  const settings = computed(() => portal.settings);

  const documents = computed(() => settings.value?.loginAgreementDocuments ?? []);
  const enabled = computed(() => settings.value?.loginAgreementEnabled === true && documents.value.length > 0);
  const mode = computed<"modal" | "checkbox">(() => (settings.value?.loginAgreementMode === "checkbox" ? "checkbox" : "modal"));
  const updatedAt = computed(() => settings.value?.loginAgreementUpdatedAt ?? "");
  const revision = computed(() => settings.value?.loginAgreementRevision ?? "");

  const acceptedRevision = ref<string | null>(readAcceptedRevision());
  const accepted = computed(() => !enabled.value || (revision.value !== "" && acceptedRevision.value === revision.value));
  /** Sign-in, sign-up, email codes and third-party sign-in wait for consent. */
  const blocked = computed(() => enabled.value && !accepted.value);

  /** Modal mode: the dialog. */
  const dialogOpen = ref(false);
  /** The visitor declined (or closed the dialog) on this page. */
  const declined = ref(false);

  // Modal mode asks as soon as the page knows there is something to agree to.
  watch(
    [enabled, mode, revision],
    () => {
      if (blocked.value && mode.value === "modal" && !declined.value) dialogOpen.value = true;
      if (!blocked.value) dialogOpen.value = false;
    },
    { immediate: true },
  );

  function accept() {
    if (revision.value) writeAcceptedRevision(revision.value);
    acceptedRevision.value = revision.value || null;
    declined.value = false;
    dialogOpen.value = false;
  }

  function reject() {
    writeAcceptedRevision(null);
    acceptedRevision.value = null;
    declined.value = true;
    dialogOpen.value = false;
  }

  function open() {
    dialogOpen.value = true;
  }

  return { enabled, mode, documents, updatedAt, revision, accepted, blocked, dialogOpen, declined, accept, reject, open };
}
