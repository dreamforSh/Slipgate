import type { ClashExitNode, WalletSummary } from "@slipgate/contracts";

export interface PluginContext {
  serviceVersion: string;
  logger: (message: string, meta?: Record<string, unknown>) => void;
  /** This plugin's saved settings (values of its declared `settings` fields). */
  config?: Record<string, string>;
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

/** A configurable field shown on the admin plugin page. */
export interface PluginSettingField {
  key: string;
  label: string;
  description?: string;
  /** Stored encrypted and never echoed back to the console. */
  secret?: boolean;
  placeholder?: string;
}

export interface SlipgatePlugin {
  name: string;
  version: string;
  description?: string;
  settings?: PluginSettingField[];
  onInit?: (ctx: PluginContext) => Promise<void> | void;
  onPaymentSettled?: (ctx: PluginContext, event: PaymentSettledEvent) => Promise<void> | void;
  onExitHealthChanged?: (ctx: PluginContext, event: ExitHealthChangedEvent) => Promise<void> | void;
}

export interface PluginDescriptor {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  hooks: string[];
  settings: PluginSettingField[];
}

export function defineSlipgatePlugin(plugin: SlipgatePlugin): SlipgatePlugin {
  return plugin;
}

const HOOKS = ["onInit", "onPaymentSettled", "onExitHealthChanged"] as const;

/**
 * Ordered plugin registry. Hooks run sequentially in registration order and errors propagate
 * to the caller. Disabled plugins are skipped; per-plugin config is injected into the context.
 */
export class PluginRegistry {
  private readonly plugins: SlipgatePlugin[] = [];
  private disabled = new Set<string>();
  private configs = new Map<string, Record<string, string>>();

  register(plugin: SlipgatePlugin): void {
    if (this.plugins.some((p) => p.name === plugin.name)) {
      throw new Error(`Plugin ${plugin.name} is already registered`);
    }
    this.plugins.push(plugin);
  }

  setDisabled(names: Iterable<string>): void {
    this.disabled = new Set(names);
  }

  setConfig(name: string, config: Record<string, string>): void {
    this.configs.set(name, { ...config });
  }

  isEnabled(name: string): boolean {
    return !this.disabled.has(name);
  }

  private active(): SlipgatePlugin[] {
    return this.plugins.filter((p) => !this.disabled.has(p.name));
  }

  private ctxFor(plugin: SlipgatePlugin, ctx: PluginContext): PluginContext {
    return { ...ctx, config: { ...(this.configs.get(plugin.name) ?? {}) } };
  }

  async initAll(ctx: PluginContext): Promise<void> {
    for (const plugin of this.active()) {
      await plugin.onInit?.(this.ctxFor(plugin, ctx));
    }
  }

  /**
   * Every enabled plugin gets the event even when an earlier one throws; the first failure is
   * rethrown afterwards. (The BFF delivers payments per plugin, see deliverPaymentSettled.)
   */
  async emitPaymentSettled(ctx: PluginContext, event: PaymentSettledEvent): Promise<void> {
    let failure: unknown = null;
    for (const plugin of this.active()) {
      try {
        await plugin.onPaymentSettled?.(this.ctxFor(plugin, ctx), event);
      } catch (err) {
        failure ??= err;
      }
    }
    if (failure !== null) throw failure;
  }

  /** Enabled plugins that handle settled payments (a payment notification's subscribers). */
  paymentSubscribers(): string[] {
    return this.active()
      .filter((p) => typeof p.onPaymentSettled === "function")
      .map((p) => p.name);
  }

  /** Delivers a settled payment to one plugin; false when it is unknown, disabled or not subscribed. */
  async deliverPaymentSettled(ctx: PluginContext, event: PaymentSettledEvent, name: string): Promise<boolean> {
    const plugin = this.active().find((p) => p.name === name);
    if (!plugin?.onPaymentSettled) return false;
    await plugin.onPaymentSettled(this.ctxFor(plugin, ctx), event);
    return true;
  }

  async emitExitHealthChanged(ctx: PluginContext, event: ExitHealthChangedEvent): Promise<void> {
    for (const plugin of this.active()) {
      await plugin.onExitHealthChanged?.(this.ctxFor(plugin, ctx), event);
    }
  }

  list(): readonly SlipgatePlugin[] {
    return this.plugins;
  }

  describe(): PluginDescriptor[] {
    return this.plugins.map((p) => ({
      name: p.name,
      version: p.version,
      description: p.description ?? "",
      enabled: !this.disabled.has(p.name),
      hooks: HOOKS.filter((h) => typeof p[h] === "function"),
      settings: (p.settings ?? []).map((s) => ({ ...s })),
    }));
  }
}
