import type zh from "../zh-CN/affiliate";

const en: typeof zh = {
  affiliate: {
    title: "Referral",
    loadFailed: "Failed to load referral info",
    retry: "Retry",
    shareTitle: "Join me",
    shareText: "Sign up with my invite link and try this AI gateway:",
    shareFailed: "Sharing failed — copy the link instead",
    disabled: {
      title: "The referral program isn't open yet",
      body: "An administrator hasn't turned on referrals. Once they do, your personal invite link and invite history will show up here.",
      back: "Back to dashboard",
    },
    hero: {
      title: "Invite friends, earn {rate} back",
      body: "When someone signs up with your link or code, a share of every paid top-up they make is credited to your balance.",
      link: "Your invite link",
      copyLink: "Copy link",
      share: "Share",
      code: "Invite code",
    },
    stats: {
      rate: "Rebate rate",
      rateHint: "Of every paid top-up by people you invite",
      invitees: "People invited",
      inviteesHint: "Accounts created with your invite",
      recent: "Joined in 30 days",
      recentHint: "Invitees who signed up in the last 30 days",
      earned: "Rebates earned",
      earnedHint: "Total credited to your balance",
    },
    rebates: {
      title: "Rebate history",
      recent: "Latest {n}",
      empty: "No rebates yet",
      emptyHint: "When friends you invited pay for a top-up, your rebate is credited to your balance automatically.",
      from: "From {email}",
    },
    steps: {
      title: "How it works",
      share: {
        title: "Share your link",
        body: "Copy your invite link or code and send it to friends or teammates.",
      },
      join: {
        title: "They sign up",
        body: "They open the link to register, or enter your code while signing up.",
      },
      earn: {
        title: "You earn",
        body: "Each time they pay for a top-up, {rate} of it is credited to your balance.",
      },
    },
    invitees: {
      title: "Your invitees",
      count: "{n} total",
      empty: "Nobody has signed up with your link yet — go share it",
      email: "Email",
      username: "Name",
      joined: "Joined",
    },
  },
};

export default en;
