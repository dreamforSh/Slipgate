/** Signed-in user's group subscriptions. */
export default {
  mySubs: {
    title: "我的订阅",
    loadFailed: "加载订阅失败",
    retry: "重试",
    redeem: "兑换订阅",
    liveCount: "{n} 个生效中",
    limitedSummary: "{n} 个订阅已达用量上限",
    since: "开始于 {date}",
    expiresOn: "到期 {date}",
    unlimited: "不限额度",
    unlimitedHint: "该分组未设置消费上限",
    overLimit: "已达到用量上限，此分组下的密钥将暂停使用，直到额度窗口释放。",
    resetNote: "用量已于 {time} 重置，此前的消费不再计入额度",
    status: {
      active: "生效中",
      limited: "已达上限",
      expired: "已过期",
      revoked: "已撤销",
    },
    expiry: {
      revoked: "已撤销",
      expired: "已过期",
      hoursLeft: "剩余 {n} 小时",
      daysLeft: "剩余 {n} 天",
    },
    window: {
      daily: "每日额度",
      weekly: "每周额度",
      monthly: "每月额度",
    },
    filter: {
      all: "全部",
      active: "生效中",
      ended: "已结束",
      empty: "没有符合筛选条件的订阅",
    },
    empty: {
      title: "还没有订阅",
      body: "订阅可让你在有效期内按额度使用指定分组，使用兑换码即可开通。",
      action: "使用兑换码",
    },
  },
};
