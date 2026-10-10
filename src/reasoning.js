// 只广告真正能落到 OpenCode variant 上的档位：OpenCode 声明了什么，这里才映射什么。
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export function reasoningEfforts(model) {
  if (!model.reasoning) return {};
  return Object.fromEntries(Object.entries(model.variants ?? {})
    .filter(([, options]) => !options.disabled && EFFORTS.includes(options.reasoningEffort))
    .map(([variant, options]) => [options.reasoningEffort, variant]));
}

// 转成 WorkBuddy 认识的声明。三种情况要分开：
//   1. 不支持推理 → 直接说不支持；
//   2. 支持推理但一个档位都映射不上 → 勾选推理，档位留空，关不掉思考；
//   3. 有档位 → 广告档位，默认优先 medium，能不能关思考看有没有 none。
export function workBuddyReasoning(model) {
  const supportedEfforts = Object.keys(reasoningEfforts(model));
  const enabled = supportedEfforts.filter(e => e !== 'none');
  if (!model.reasoning) return { supportsReasoning: false };
  if (!enabled.length) return {
    supportsReasoning: true, onlyReasoning: true,
    reasoning: { supportedEfforts: [], canDisableThinking: false },
  };
  return {
    supportsReasoning: true,
    onlyReasoning: !supportedEfforts.includes('none'),
    reasoning: {
      supportedEfforts,
      defaultEffort: enabled.includes('medium') ? 'medium' : enabled[0],
      canDisableThinking: supportedEfforts.includes('none'),
    },
  };
}
