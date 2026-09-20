# dsh-capability-hint

在每轮第一步（`agent/pre-step`，`step === 1`）注入一行「本轮可能适用：X」的能力提示，
让**已安装但想不起来用**的方法论技能真正被调用。

## 这是什么

一个问题：技能装了几十个，真正被调用的永远是硬驱动的那几个（任务强制必需、业务专用）。
「通用方法论」层（`brainstorming`、`systematic-debugging`、`writing-plans`…）没有硬需求
驱动，于是**装了等于没装**。

本插件在每轮**第一步**按规则表匹配当前轮次文本，命中就把一行提示**追加到本步的
`enter` 决策消息末尾**：

```
[能力提示] 本轮可能适用：brainstorming, writing-plans
```

提示行同时记入**内存台账**（`applicable` 条目），技能真被调用时再记一条（`invoked`），
供 `defaultInvocationRate()` 计算默认调用率——也就是这个插件唯一的成功指标。

## 它**不**做什么

| 不做 | 说明 |
|---|---|
| **不替换技能目录** | 不重写 `tool-skill`、不改目录渲染、不删任何技能。目录瘦身交给官方配置（`catalogDescriptionMaxLength`），不写代码。 |
| **不改决策** | 提示是**追加**，不是拦截：先 `await next()` 拿到下游决策，只在 `kind === 'enter'` 时把一行提示排到 `messages` **末尾**。既有消息一条不丢、不改、不重排。下游返回 `reject` 时**原样透传**，不追加。 |
| **不调 LLM** | 全流程零模型调用。匹配是纯字符串子串比对（`matchCapabilities`），渲染是纯函数（`renderHint`）。 |
| **不重复注入** | 只在 `step === 1`（每轮第一次 proposal）匹配；且排除 `source.plugin === name` 的消息，插件永不可能匹配自己的输出。 |

### 为什么走 `PreStepDecision` 而不是 `agent.inject()`

这是对实施计划 Global Constraints「不通过 `PreStepDecision` 改消息」的**显式偏离**，理由如下：

`agent.inject()` 写的是 **`next-step` 收件箱**，而驱动在 `preStep` 里**已经先
`claim()` 掉了本步批次**、之后才派发 waterfall。官方文档
（`docs/subsystems/core.md:139-144`）原文即：*"A running driver claims it at the nearest
later step boundary… **It may miss a request whose pre-step already claimed its batch.**"*

后果是提示**必然晚一步**到达 —— 该用它来选能力的那个模型调用看不到它，插件的前提目的落空。
能够落进**本步**的唯一机制就是 `enter` 决策的 `messages`。这条约束原本要防的是"干扰
`tool-skill` 的目录通道"和"操纵步骤决策"，而**追加一行消息既不干扰目录（`tool-skill`
走的是 `agent.inject()`，另一个通道），也不改变进入/拒绝的决策本身**。

其它明确不做：

- ❌ **不自动淘汰技能**——只出报告供人判断，删除技能始终是人的动作。
- ❌ **不写 MEMORY.md / 技能库**——纯内存台账，无持久化（见下）。
- ❌ **不做 `agent/turn-stopping` 强制作废**——第一版只做零成本提示。
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

#### 怎么读到这些条目（I2）

`apply()` 的返回值只有**直接调用 `apply` 的人**拿得到，运行中的 harness 不持有它。
因此台账同时通过 `ctx.provide` 注册为 **ctx 服务名 `dsh-capability-hint`**：

```ts
const entries = ctx['dsh-capability-hint'].entries()   // readonly LedgerEntry[]
const report  = defaultInvocationRate([...entries])     // RateReport[]
```

两条路径指向**同一个对象**、同一个生命周期（`ctx.provide` 在插件卸载时自动注销）。
服务名常量导出为 `LEDGER_SERVICE`。

#### 一个仍未关闭的盲区：`invoked` 分子

`observeToolCall` 按 `toolName === 'skill'` + `args.name` 识别调用，该形状是**读源码**
核实的，**不是跑出来的**：`invoked` 分子**没有任何真实 harness 会话的端到端验证**。

已核实的部分：`tools/result` 是真实的 emit 事件（签名 `docs/subsystems/tools.md:714`），
`exec.arguments` 是注册表已解析并深冻结的对象（`dsh-tools/lib/types/index.d.ts:204-205`），
工具模型可见名 `skill` 与 `dsh-tool-skill/lib/index.js:60-66` 一致。因此"工具名被加载器
换掉"这一具体假设**风险较低** —— 它不是主导原因。

真正主导的原因是**时机与分母**（本次已修）：修复前提示晚一步到达，且分母会因每步
重新自触发而膨胀，导致每一次判定都对应不到任何真实的调用机会。修复之后，剩下的风险
按可能性排序：

1. **会话内观测窗口太短** —— 4 周观察期的数据被进程重启切成碎片（见下 I3）。
2. **`lastTurn` 归属** —— `tools/result` 载荷里没有 `turn`，位次只能沿用本实例最近一次
   `agent/pre-step` 观测到的轮次；跨实例/中途加载时会退化成哨兵 `0`。
3. **技能确实没被调用** —— 也就是插件真的没起作用。

看到全 0 报告时，先排除第 1、2 条，再下"该退役"的结论。

#### I3：没有持久化，所以 4 周停用条件是**当前不可证伪的**（待裁决）

spec 把台账映射到 `ctx.storage`，并要求跨**周**聚合（上表的停用条件是 4 周观察窗）。
本次**有意不实现持久化**，后果必须说清楚：

- 台账是**进程内**的。harness 重启 = 分母归零，历史一并消失。
- 因此 **"4 周观察期内所有能力默认调用率均无上升"这条停用条件，以当前实现无法判定** ——
  没有一个能活过重启的分母，你永远只能看到"本次会话"的切片。
- 这不影响插件本身的可用性（提示照常工作），只影响**退役判据的可执行性**。

这被标记为**需要人裁决的决策**（实现 `ctx.storage` 持久化，还是把观察窗缩短到单次
会话）。在裁决之前，请只把台账当作会话级诊断，不要据此做退役判断。

## 开发

```powershell
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm build       # tsdown → lib/
```

三个都要过。本项目有过 `pnpm test` 全绿而 `pnpm typecheck` 失败的先例——**测试绿不等于树是健全的**。
