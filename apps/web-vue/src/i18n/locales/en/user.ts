import type zh from "../zh-CN/user";

const en: typeof zh = {
  user: {
    createKey: "Create key",
    stats: {
      available: "Available balance",
      balance: "Account balance",
      held: "On hold",
      enabledKeys: "Active keys",
      totalKeys: "{count} total",
    },
    reveal: {
      title: "Key created",
      notice: "Copy it now. You won't be able to see the full key again.",
      saved: "I've saved it",
    },
    keys: {
      title: "API keys",
      empty: "No API keys yet",
      key: "Key",
      group: "Group",
      rpm: "RPM",
      concurrency: "Concurrency",
    },
    usage: {
      title: "Usage",
      recent: "Last {count}",
      empty: "No usage yet",
      time: "Time",
      model: "Model",
      protocol: "Protocol",
      tokens: "Tokens (in / out)",
      cost: "Cost",
      latency: "TTFT / Total",
    },
    endpoints: {
      title: "Endpoints",
    },
    form: {
      name: "Name",
      namePlaceholder: "e.g. my-app",
      group: "Group",
      rpm: "Requests per minute",
      concurrency: "Max concurrency",
      submit: "Create",
    },
    errors: {
      create: "Failed to create key",
      toggle: "Failed to update key",
      delete: "Failed to delete key",
    },
  },
};

export default en;
