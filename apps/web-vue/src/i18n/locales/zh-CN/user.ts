/** Page copy for the user console (keys, balance, usage). */
export default {
  user: {
    createKey: "创建密钥",
    stats: {
      available: "可用余额",
      balance: "账户余额",
      held: "冻结中",
      enabledKeys: "已启用密钥",
      totalKeys: "共 {count} 个",
    },
    reveal: {
      title: "密钥已创建",
      notice: "请立即复制保存，关闭后将无法再次查看完整密钥。",
      saved: "我已保存",
    },
    keys: {
      title: "API 密钥",
      empty: "还没有 API 密钥",
      key: "密钥",
      group: "分组",
      rpm: "RPM",
      concurrency: "并发",
    },
    usage: {
      title: "使用记录",
      recent: "最近 {count} 条",
      empty: "暂无使用记录",
      time: "时间",
      model: "模型",
      protocol: "协议",
      tokens: "Token（输入 / 输出）",
      cost: "费用",
      latency: "首字 / 总耗时",
    },
    endpoints: {
      title: "接入地址",
    },
    form: {
      name: "名称",
      namePlaceholder: "例如 my-app",
      group: "分组",
      rpm: "每分钟请求上限",
      concurrency: "并发上限",
      submit: "创建",
    },
    errors: {
      create: "创建密钥失败",
      toggle: "更新密钥状态失败",
      delete: "删除密钥失败",
    },
  },
};
