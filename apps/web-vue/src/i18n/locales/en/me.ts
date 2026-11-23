import type zh from "../zh-CN/me";

const en: typeof zh = {
  me: {
    title: "Dashboard",
    greeting: {
      night: "Burning the midnight oil, {name}?",
      morning: "Good morning, {name}",
      noon: "Good afternoon, {name}",
      afternoon: "Good afternoon, {name}",
      evening: "Good evening, {name}",
    },
    subtitle: "Here's your usage at a glance — numbers refresh every minute.",
    actions: {
      createKey: "Create key",
      redeem: "Redeem",
      usage: "Usage",
    },
    overview: "Overview",
    updatedAt: "Updated {time}",
    retry: "Retry",
    loadFailed: "Failed to load the dashboard",
    truncated: "This range has a lot of traffic; totals shown are a lower bound.",
    range: {
      h24: "24h",
      d7: "7 days",
      d30: "30 days",
    },
    kpi: {
      balance: "Balance",
      topUp: "Top up",
      spent: "Total spent",
      spentHint: "Since your account was created",
      keys: "API keys (active / total)",
      manageKeys: "Manage keys",
      subs: "Active subscriptions",
      viewSubs: "View subscriptions",
      todayRequests: "Requests today",
      successRate: "{rate}% success",
      noRequestsToday: "No requests yet today",
      todayTokens: "Tokens today",
      tokenSplit: "In {input} · Out {output}",
      todayCost: "Spent today",
      avgLatency: "Avg latency {latency}",
      periodRequests: "Requests · {range}",
      periodCost: "Spent {cost} in range",
    },
    metric: {
      requests: "Requests",
      tokens: "Tokens",
      cost: "Cost",
      input: "Input",
      output: "Output",
    },
    trend: {
      requests: "Request trend",
      tokens: "Token trend",
      cost: "Cost trend",
      empty: "No requests in this range yet",
    },
    models: {
      title: "Top models",
    },
    keys: {
      title: "Usage by key",
    },
    breakdown: {
      empty: "No data yet",
      meta: "{requests} requests · {tokens} tokens · {cost}",
    },
    recent: {
      title: "Recent requests",
      viewAll: "View all",
      empty: "No requests yet",
      tokens: "{input} / {output} tokens",
    },
  },
};

export default en;
