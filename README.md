# dsh-capability-hint

在 `agent/pre-step` 注入一行「本轮可能适用：X」的能力提示，让**已安装但想不起来用**的方法论技能真正被调用。

## 这是什么

一个问题：技能装了几十个，真正被调用的永远是硬驱动的那几个（任务强制必需、业务专用）。
「通用方法论」层（`brainstorming`、`systematic-debugging`、`writing-plans`…）没有硬需求
驱动，于是**装了等于没装**。

本插件在每轮开头（`payload.messages` 非空时）按规则表匹配当前轮次文本，命中就注入一行：

```
[能力提示] 本轮可能适用：brainstorming, writing-plans
```

提示行同时记入**内存台账**（`applicable` 条目），技能真被调用时再记一条（`invoked`），
供 `defaultInvocationRate()` 计算默认调用率——也就是这个插件唯一的成功指标。

## 它**不**做什么

这三条是设计红线，不是"暂未实现"：

| 不做 | 说明 |
|---|---|
| **不替换技能目录** | 不重写 `tool-skill`、不改目录渲染、不删任何技能。目录瘦身交给官方配置（`catalogDescriptionMaxLength`），不写代码。 |
| **不改决策** | 注入是**叠加**（`agent.inject()`），不是拦截。监听器**必调 `next()` 并原样透传**下游决策，绝不短路、绝不改写 `PreStepDecision`。 |
| **不调 LLM** | 全流程零模型调用。匹配是纯字符串子串比对（`matchCapabilities`），渲染是纯函数（`renderHint`）。不判断"这个能力好不好"，只判断"这个词出现过没有"。 |

其它明确不做：

- ❌ **不自动淘汰技能**——只出报告供人判断，写入门是龙哥的动作。
- ❌ **不写 MEMORY.md / 技能库**——纯内存台账，无持久化。
- ❌ **不主动引入新能力**——第一版纯减法，只提高现有能力的召回。
- ❌ **不做 `agent/turn-stopping` 强制作废**——第一版只做零成本提示。
- ❌ **不触碰「任务强制必需」与「业务专用」两层**——只对「通用方法论」层做主动召回。
- ❌ **不追求覆盖全部能力**——先覆盖 20–30 个高频的。

## 配置项

插件通过 `Config` schema（`src/config.ts`）声明，harness 在**加载期**校验：非法值会响亮失败，不会静默降级。

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true` | 总开关。关掉后监听器仍在，但从不注入。 |
| `maxHintsPerTurn` | `number` | `3` | 单轮最多提示几个能力（防止提示本身变成噪音）。 |
| `hintPrefix` | `string` | `"[能力提示]"` | 提示行的前缀标记。 |
| `rulesPath` | `string` | `"hermes-intake-rules.json"` | 触发规则表路径（绝对路径或相对包根）。 |
| `excludeSkills` | `string[]` | `[]` | 永不提示的技能名（黑名单，优先级高于规则表）。 |

> 注：`maxHintsPerTurn` 指**按规则表顺序**截断，不是按重要性排序。若在意命中顺序，
> 需自行调整规则表里的排列。
>
> 另注：`rulesPath` 目前是**声明而未消费**的字段——`apply()` 用的是内置的
> `BUILTIN_RULES`（`src/rules.ts`），尚未从该路径加载。改这个值当前不会改变行为。

## 安装

```powershell
# 从仓库本地打包安装
pnpm pack
dsh plugin --profile web add ./dsh-capability-hint-0.1.0.tgz -w
```

`package.json` 的 `files` 白名单为 `["lib", "cordis.patch.yml"]`，因此 tarball 只含
构建产物与 bundle patch；`lib/` 由 `prepare` 脚本（`tsdown`）在安装时重新构建。

## 如何关掉

最轻的方式——**保持安装、只关注入**：

```yaml
# cordis.yml（或 profile 的插件配置节）
dsh-capability-hint:
  enabled: false
```

此时监听器仍注册（开销极低），但 `apply()` 里的分支不再进入，**不注入任何消息、
不记 applicable 台账**。这是最可逆的关法：改回 `true` 即恢复，无需重装。

彻底移除：`dsh plugin --profile web remove dsh-capability-hint`，
或直接删掉 `cordis.patch.yml` 引入的那一行。

## 停用条件（spec §10）

**任一触发即停止，不追加投入：**

| 条件 | 判据 |
|---|---|
| 机制无效 | 4 周观察期内，**所有能力的默认调用率均无上升** |
| 匹配失效 | 提示被采纳比例 **< 20%**（提示基本是错的） |
| 成本失控 | 单轮新增 token 显著超出预算，或影响会话响应 |
| 已被覆盖 | DSH 官方或社区出现等价机制（先查再建） |

### 读这个指标时的诚实限定

`defaultInvocationRate()` 的 `rate = invoked / applicable`，**分子分母是两个不同的
计数单位**：分母是"适用判定**条目数**"，分子是"被调用次数"。一轮里同一技能命中两次
会记 2 条 applicable；一个技能 3 轮适用、在第 1 轮调用 3 次，`rate` 会显示 `1`。

**只有 `rate === 0` 可以安全解读为"从未被调用"。** 更高的值不可当作"按轮次命中率"。

另有一个**已知盲区**：`invoked` 分子尚无真实 harness 会话的端到端验证——`observeToolCall`
按 `toolName === 'skill'` 加 `args.name` 识别调用，该形状是读源码核实的，不是跑出来的。
若真实运行中 skill 加载器换了工具名，**分子会系统性为 0，所有技能都读作 `rate = 0`**，
与"插件完全没起作用"无法区分。看到全 0 报告时，先怀疑这个，再下结论。

## 开发

```powershell
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm build       # tsdown → lib/
```

三个都要过。本项目有过 `pnpm test` 全绿而 `pnpm typecheck` 失败的先例——**测试绿不等于树是健全的**。
