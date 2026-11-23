import type zh from "../zh-CN/my_subscriptions";

const en: typeof zh = {
  mySubs: {
    title: "My subscriptions",
    loadFailed: "Failed to load subscriptions",
    retry: "Retry",
    redeem: "Redeem a code",
    liveCount: "{n} active",
    limitedSummary: "{n} subscription(s) at their usage cap",
    since: "Started {date}",
    expiresOn: "Expires {date}",
    unlimited: "Unlimited",
    unlimitedHint: "No spend caps on this group",
    overLimit: "Usage cap reached — keys in this group are paused until the window frees up.",
    resetNote: "Usage was reset at {time}; earlier spend no longer counts",
    status: {
      active: "Active",
      limited: "Capped",
      expired: "Expired",
      revoked: "Revoked",
    },
    expiry: {
      revoked: "Revoked",
      expired: "Expired",
      hoursLeft: "{n}h left",
      daysLeft: "{n} days left",
    },
    window: {
      daily: "Daily",
      weekly: "Weekly",
      monthly: "Monthly",
    },
    filter: {
      all: "All",
      active: "Active",
      ended: "Ended",
      empty: "No subscriptions match this filter",
    },
    empty: {
      title: "No subscriptions yet",
      body: "A subscription lets you use a group within its caps until it expires. Redeem a code to get one.",
      action: "Redeem a code",
    },
  },
};

export default en;
