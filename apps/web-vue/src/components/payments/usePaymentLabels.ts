import type { PaymentOrderItem } from "@slipgate/contracts";
import { useI18n } from "vue-i18n";
import { formatUsd } from "../../lib/format";
import { channelKey, currencySymbol, formatFiat } from "./paymentUtil";

/** Localized labels shared by the purchase, order and admin payment pages. */
export function usePaymentLabels() {
  const { t, te } = useI18n();

  const known = (key: string, raw: string) => (te(key) ? t(key) : raw);

  const channelLabel = (provider: string, method: string | null | undefined) => {
    const key = channelKey(provider, method);
    return known(`payments.channels.${key}`, key);
  };
  const channelHint = (provider: string, method: string | null | undefined) => {
    // The official Alipay / WeChat Pay merchants share the EasyPay channels' names: tell them apart.
    if (provider === "alipay" || provider === "wxpay") return t(`payFlow.channelHints.${provider}Direct`);
    const key = channelKey(provider, method);
    return known(`payments.channelHints.${key}`, "");
  };
  const providerLabel = (provider: string) => known(`payments.providers.${provider}`, provider);
  const statusLabel = (status: string) => known(`payments.statuses.${status}`, status);
  const kindLabel = (kind: string) => known(`payments.kinds.${kind}`, kind);
  const currencyLabel = (currency: string) => known(`payments.currencies.${currency}`, currency);

  /** Plan name, or "Custom top-up" for free-amount orders. */
  const itemLabel = (order: Pick<PaymentOrderItem, "planName">) => order.planName || t("payments.customTopUp");

  /** What an order delivers: a balance credit or a subscription. */
  const deliveredText = (
    order: Pick<PaymentOrderItem, "kind" | "creditNanoUsd" | "groupName" | "validityDays">,
  ): string =>
    order.kind === "subscription"
      ? t("payments.subscriptionValue", {
          group: order.groupName || t("payments.unknownGroup"),
          days: order.validityDays ?? 0,
        })
      : formatUsd(order.creditNanoUsd);

  const amountText = (order: Pick<PaymentOrderItem, "amountMinor" | "currency">) =>
    formatFiat(order.amountMinor, order.currency);

  return {
    t,
    channelLabel,
    channelHint,
    providerLabel,
    statusLabel,
    kindLabel,
    currencyLabel,
    itemLabel,
    deliveredText,
    amountText,
    currencySymbol,
  };
}
