/** Referral (affiliate) program for signed-in users. */
export default {
  affiliate: {
    title: "邀请返利",
    loadFailed: "加载邀请信息失败",
    retry: "重试",
    shareTitle: "邀请你加入",
    shareText: "通过我的邀请链接注册，一起使用这个 AI 网关：",
    shareFailed: "分享失败，请直接复制链接",
    disabled: {
      title: "邀请返利暂未开放",
      body: "管理员尚未开启邀请返利计划。开放后，你可以在这里获取专属邀请链接并查看邀请记录。",
      back: "返回仪表盘",
    },
    hero: {
      title: "邀请好友，获得 {rate} 充值返利",
      body: "好友通过你的专属链接或邀请码注册后，其每一笔付费充值都会按比例返利到你的账户余额。",
      link: "专属邀请链接",
      copyLink: "复制链接",
      share: "分享",
      code: "邀请码",
    },
    stats: {
      rate: "返利比例",
      rateHint: "按被邀请用户的付费充值金额计算",
      invitees: "已邀请用户",
      inviteesHint: "通过你的邀请注册的账户",
      recent: "近 30 天新增",
      recentHint: "最近 30 天内加入的被邀请用户",
      earned: "累计返利",
      earnedHint: "已发放到你余额的返利总额",
    },
    rebates: {
      title: "返利记录",
      recent: "最近 {n} 条",
      empty: "还没有返利记录",
      emptyHint: "被邀请的好友付费充值后，返利会自动发放到你的余额。",
      from: "来自 {email}",
    },
    steps: {
      title: "如何获得返利",
      share: {
        title: "分享链接",
        body: "复制专属邀请链接或邀请码，发送给朋友或同事。",
      },
      join: {
        title: "好友注册",
        body: "好友通过链接打开注册页，或在注册时填写你的邀请码。",
      },
      earn: {
        title: "自动返利",
        body: "好友每次付费充值，你将获得充值金额 {rate} 的余额返利。",
      },
    },
    invitees: {
      title: "邀请记录",
      count: "共 {n} 人",
      empty: "还没有人通过你的链接注册，快去分享吧",
      email: "邮箱",
      username: "昵称",
      joined: "注册时间",
    },
  },
};
