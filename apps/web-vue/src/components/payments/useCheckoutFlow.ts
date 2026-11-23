import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import type { CreateOrderRequest, CreateOrderResponse, PaymentCheckout, PaymentOrderItem } from "@slipgate/contracts";
import { useToastStore } from "../../stores/toast";
import { invokeWechatPay, PayApiError, payApi, resultLink, savePendingPurchase } from "./paymentFlow";

/**
 * Hands a created (or resumed) order to the way it is paid: a redirect to the provider, the
 * in-page QR modal, WeChat's JSAPI bridge, the Airwallex page, or the result page (manual).
 */
export function useCheckoutFlow() {
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToastStore();

  /** Order shown in the QR modal (with the checkout it is paid by). */
  const qrOrder = ref<PaymentOrderItem | null>(null);
  const qrOpen = ref(false);
  /** The browser is leaving for the provider or WeChat: keep buttons busy. */
  const leaving = ref(false);

  /**
   * POST /user/orders. Resolves null when WeChat must authorize first: the purchase is kept for
   * /payment/wechat/callback and the browser is already on its way to WeChat.
   */
  async function createOrder(body: CreateOrderRequest): Promise<CreateOrderResponse | null> {
    try {
      return await payApi<CreateOrderResponse>("/api/v1/user/orders", { method: "POST", body });
    } catch (err) {
      if (err instanceof PayApiError && err.code === "wechat_oauth_required" && typeof err.body.authorizeUrl === "string") {
        savePendingPurchase({ planId: body.planId, amount: body.amount, provider: body.provider, method: body.method });
        leaving.value = true;
        toast.info(t("payFlow.checkout.wechatAuthorizing"));
        window.location.assign(err.body.authorizeUrl);
        return null;
      }
      throw err;
    }
  }

  async function proceed(order: PaymentOrderItem, checkout: PaymentCheckout | null = order.checkout): Promise<void> {
    const flow = checkout?.flow ?? (order.provider === "manual" ? "manual" : "redirect");
    const payUrl = checkout?.payUrl ?? order.payUrl;
    if (flow === "redirect" && payUrl) {
      leaving.value = true;
      toast.info(t("payFlow.checkout.redirecting"));
      window.location.assign(payUrl);
      return;
    }
    if (flow === "qrcode" && checkout?.qrCode) {
      qrOrder.value = { ...order, checkout, qrCode: checkout.qrCode };
      qrOpen.value = true;
      return;
    }
    if (flow === "jsapi" && checkout?.jsapi) {
      const outcome = await invokeWechatPay(checkout.jsapi);
      if (outcome === "unavailable") toast.warning(t("payFlow.checkout.wechatUnavailable"));
      else if (outcome === "fail") toast.warning(t("payFlow.checkout.wechatFailed"));
      await router.push(resultLink(order.id, outcome === "cancel" ? { cancelled: "1" } : {}));
      return;
    }
    if (flow === "airwallex" && checkout?.airwallex) {
      await router.push({ path: "/payment/airwallex", query: { order: order.id } });
      return;
    }
    await router.push(resultLink(order.id));
  }

  /** The QR modal saw the order paid. */
  function onQrPaid(order: PaymentOrderItem) {
    qrOpen.value = false;
    void router.push(resultLink(order.id));
  }

  return { createOrder, proceed, qrOrder, qrOpen, leaving, onQrPaid };
}
