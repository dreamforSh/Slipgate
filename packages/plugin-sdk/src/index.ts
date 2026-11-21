import type { ClashExitNode, WalletSummary } from "@slipgate/contracts";

export interface PluginContext {
  serviceVersion: string;
  logger: (message: string, meta?: Record<string, unknown>) => void;
}

export interface PaymentSettledEvent {
  orderId: string;
  userId: string;
  provider: string;
  amountNanoUsd: string;
  wallet?: WalletSummary;
}

export interface ExitHealthChangedEvent {
  node: ClashExitNode;
  previousStatus: ClashExitNode["healthStatus"];
}

export interface SlipgatePlugin {
  name: string;
  version: string;
  onInit?: (ctx: PluginContext) => Promise<void> | void;
  onPaymentSettled?: (ctx: PluginContext, event: PaymentSettledEvent) => Promise<void> | void;
  onExitHealthChanged?: (ctx: PluginContext, event: ExitHealthChangedEvent) => Promise<void> | void;
}

export function defineSlipgatePlugin(plugin: SlipgatePlugin): SlipgatePlugin {
  return plugin;
}

export class PluginRegistry {
  private readonly plugins: SlipgatePlugin[] = [];

  register(plugin: SlipgatePlugin): void {
    this.plugins.push(plugin);
  }

  async initAll(ctx: PluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.onInit?.(ctx);
    }
  }

  async emitPaymentSettled(ctx: PluginContext, event: PaymentSettledEvent): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.onPaymentSettled?.(ctx, event);
    }
  }

  async emitExitHealthChanged(ctx: PluginContext, event: ExitHealthChangedEvent): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.onExitHealthChanged?.(ctx, event);
    }
  }

  list(): readonly SlipgatePlugin[] {
    return this.plugins;
  }
}
