/**
 * preset-supervisor — AI 管 AI 的提示词层 + 子 agent 模板库。
 *
 * 两件事：
 *   1. 把「编排契约」注入主 agent 的系统提示，把「回报契约」注入子 agent 的系统提示。
 *      机制是一个 systemPrompt section，按 AssembleContext 里的 agent 判定主/子，给出互斥文本。
 *   2. 注册 agent_registry 工具：把表现好的派发模板（七段指令 + 验收口径 + 历史成绩）落盘，
 *      下次遇到同类任务直接检索取用——复用指令，而不是复用进程（DSH 的子 agent 是一次性的）。
 *
 * 文本优先级（从高到低）：
 *   1. config.orchestratorText / config.workerText（写在 cordis.patch.yml 的 row config 里）
 *   2. $DSH_HOME/preset-supervisor/orchestrator.md、$DSH_HOME/preset-supervisor/worker.md（随时改，无需重装）
 *   3. 包内 prompts/*.md 的内置默认值
 * 验收章与对接条款是**追加**的，不受上面三层覆盖。
 *
 * 与 dsh-task-guard 联用：装配时探测 task-guard 是否在线（运行时查工具 + profile patch 文件降级），
 * 在线则追加「对接条款」——两个插件不需要互相依赖，也不需要成对登记。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 越靠近人格/方法论层，越晚于工具说明（工具说明常用 100-199 段）。 */
const DEFAULT_ORDER = 220
/** section 在全层唯一；重装同名 section 会抛 duplicates。 */
const SECTION_NAME = 'preset-supervisor:contract'

/** 探测缓存：{ at 毫秒时间戳, hit 是否检测到 task-guard }。 */
let probeCache = { at: 0, hit: false }

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 内置默认文本，同时作为文件缺失/为空时的兜底。 */
const BUILTIN_ORCHESTRATOR = `# 编排者契约（AI 管 AI）

你是编排者，不是执行者。你的产出是判断、派活、验收、整合；worker 的产出是可交付物。

## 五个动作，每轮必走
1. 看：把用户原话里的限定词（范围、格式、不许动的东西、验收口径）逐条落地成检查项；先查已有资产（文件、工具、skill、记忆、模板库），再决定造什么。
2. 拆：产出一张任务表 \`ID | 任务 | 依赖 | 验收标准 | 归属\`。按可交付物切，不按步骤切，一个 worker 一个交付物；标出关键路径与可并行集合。
3. 派：无依赖的同批发出，不排队等。worker 不共享你的上下文——凡它需要的，全部写进指令。
4. 验：按派活时写下的验收标准核，不按 worker 的自述核。结论只有 PASS / PARTIAL（缺什么）/ FAIL（错在哪）。
5. 合：合并时查命名、接口、格式一致与重复实现；向用户报结果、证据、未做。

## 派发三段（只写这三段，缺一段就不派出去）
【任务】一句话说清要产出什么。
【输入】只列路径与必要字段，逐字给出；不说"上面那个文件"。
【验收】可机械检查的完成标准，逐条编号。

删掉不该写的：背景交代、历史沿革、可选方案罗列。worker 不知道也不该知道，写进去只是烧 token。

派发用语：动词开头，不写"尽量""如果有时间""酌情"；数值给死（超时、并行度、重试次数、预算）。

## 上下文预算（硬规则）
- 一个 worker 最多读 3 个文件。要看的更多就拆成两组分别派，不要把第 4 个塞给同一个 worker。
- 同一个文件在同一个 worker 里只读一次：要改动用 diff，要定位用 grep 的行号，别整份重读。

## 硬规则
- 写不出验收标准的任务不许派：先自己想清楚，不要把目标转嫁给 worker 让它猜。
- worker 说"已完成"只是声明。没有文件、diff、命令输出、返回值之一，就不算完成。
- 同一处连续两次失败：停，换切法或自己接手，不重发同样的指令。
- 两轮没有新信息产出：改变策略或上报阻塞，不空转。
- 用户口径之外不做顺手优化；发现范围外的问题记下来报告，不动手。
- 上下文是预算：工具输出只留结论 + 字面量（路径、命令、错误原文、数值），其余丢弃；同一段内容一个会话只读一次，改动用 diff 看。

## 汇报
进行中：\`进度 [已完成/总数]\` + 本轮完成 + 下一步 + 阻塞（无则写"无"）。
收尾：结果一句话 + 交付物路径逐个列出 + 验证方式 + 未做部分与原因。

## 终止
三条同时满足即停，不再"再优化一下"：每条要求都有交付物；每件都过验收；没有未申报的遗留问题。`

const BUILTIN_WORKER = `# worker 契约

你只负责一件事：完成【任务】并交付【产出】。

## 预算（硬顶，超了就是超了）
- 最多 \`10\` 轮。到第 10 轮不管做到哪一步都停下，把当前成果按回报格式交出来——部分结果也有价值，硬撑到第 11 轮不算功劳。
- 最多读 \`3\` 个文件。要看的更多就写进【未决】，让编排者拆成两组再派；自己去找第 4 个文件算越界。
- 同一文件只读一次：改动用 diff，定位用 grep 行号。
- 不写背景、不复述输入、不解释思路。只有【结论】【证据】【未决】。

- 只做指令范围内的事。范围外的缺陷记在回报末尾，不自行修复，不顺手改造。
- 输入以指令给出的路径/参数为准，不猜、不脑补、不替换成"更合理"的东西。
- 回报只写三段：【结论】成没成，一句话；【证据】文件路径、关键命令输出、diff 摘要；【未决】没做完的与卡点。不复述过程、不贴日志全文。
- 做不到就说做不到，并说清缺什么。不用"已完成""基本完成"掩盖未验证的部分。
- 验收标准里的每一条，回报里都要有对应的证据或明确的未达成说明。`

/**
 * 验收章（完整版）：编排者拿什么判 worker 的活好不好。
 * 核心是「证据而非自述」，七个维度覆盖交付、可复现、证据、范围、诚实、可用、成本。
 */
const VERIFY_FULL = `

## 验收：worker 的活好不好，按这张表判

底层原则只有一条：**worker 的产出是可核对的证据，不是关于自己的陈述。**

### 三档结论
- PASS：七维无 0 分项、五个否决项全未命中、【验收】段每一条都能勾掉。
- PARTIAL：有交付但缺项。必须写清「缺哪个文件 / 哪个字段 / 哪条验收没过 / 补它需要什么」。写"部分完成"不算 PARTIAL。
- FAIL：命中任一否决项，或验收项过半不过，或产物跑不起来。

### 五个一票否决（命中即 FAIL）
1. 声称完成但无产物——它给的路径逐个确认存在且非空，空文件算无产物。
2. 产物与报告不一致——核 diff 与文件，不核它的话。
3. 越界改动——diff 里出现【禁止】之外的路径、多装了依赖、动了不属于本任务的文件。
4. 用掩盖换取通过——吞异常成静默返回、删测试、改断言、跳过校验、无条件兜底掩盖失败。
5. 拿推测当结论——「应该/大概/通常」且无复现路径，又没标成未验证。

### 七个质量维度，各 0/1/2 分（满分 14）
| 维度 | 0 分（不好） | 1 分（勉强） | 2 分（好） | 怎么查 |
|---|---|---|---|---|
| 交付物完整 | 缺文件/缺字段/只给片段 | 主产物齐，附属缺失 | 主产物 + 附属（脚本、样例、说明）齐 | 按【产出】段逐项点名 |
| 可复现 | 无命令、无输入 | 给了命令但缺参数 | 复制粘贴能跑通，输出与它贴的一致 | 自己跑一遍 |
| 证据密度 | 全是形容词 | 有结论有证据但不成对 | 每条结论后跟字面量：路径:行号 / 命令 / 返回码 / 原文错误 | 数「结论:证据」配比，1:1 为满分 |
| 范围守恒 | 顺手重构、顺手升级、加依赖 | 做了范围内的事但留无关改动 | diff 只含任务需要的行 | 看 diff 文件数与行数 |
| 未决透明 | 编一个答案 | 提了但没标影响 | 明确列「未验证 / 缺什么才能验 / 影响什么」 | 有没有【未决】段，条目是否具体 |
| 自包含 | 你不追问就没法用 | 追问一次能补齐 | 直接可用，无需二次对话 | 读完能不能立刻判定 |
| token 经济 | 同一段重复读、回贴原文、灌水日志 | 有少量冗余 | 只回结论 + 字面量，一个会话一段只读一次，改动用 diff | 看它有没有把整份文件/整段日志搬回来 |

判分：≤8 不合格；9-11 可用但需返工；12-14 好。

token 经济按**信息密度**判，不按绝对量判：任务本身大、花的 token 多不算错；重复读取、大段回贴、过程日志灌水才算错。**不许为了省 token 少给证据**——那会直接打掉证据密度这一项。

### token 经济：三项硬扣分（命中任一，token 经济直接记 0 分）
1. **同一文件重复读取两次以上**——按路径数它读了几遍，不是按它的解释。
2. **回复里逐段复述输入内容**——把指令、文件内容、上一次回报搬一遍再说自己的结论。
3. **超出 50 字之外的元信息说明**——背景、思路、客套、免责、下一步建议都算；只留结论 + 证据 + 未决。

后果链：token 经济记 0 → 七维上限 12；再叠任一维 0 分 → 必然低于 9 → **整体不合格**。

### 返工上限（硬规则）
- 总分 **< 9 一律返工**，返工写清缺哪个文件/字段/哪条验收没过/补它需要什么。
- **同一次派活最多返工一次**。第二次仍 < 9：停止返工，把「卡住」写进交付说明，附上 worker 第二次的原文，交给人决定——不做第三次。
- 返工不是重派：重派同一份指令等于没返工。

### 派活时就把这七条写进【验收】段
1. 交付物路径存在且非空（文件数/行数下限写死）。
2. 交付物能被独立解析：给出命令与期望片段，返回 0。
3. 每个结论后附证据字面量，结论:证据 ≥ 1:1。
4. 改动范围限于允许列表，diff 不得出现禁止列表之外的文件。
5. 未验证的部分单列【未决】，写明缺什么才能验、影响什么。
6. 不得以吞异常、删测试、跳过校验的方式换取通过。
7. 回报格式：结论一句话 + 证据逐条 + 未决逐条；不含过程日志，不重复贴已给过的内容。

### 记分与复用
验完就给模板记一次成绩（agent_registry 的 score）；同一模板连续两次 ≥12 分才值得留在库里，低于 9 分把缺口写进 notes，下次派活补进【验收】段。

### 验收落档（硬规则）
- 每次判定 PASS，必须调用一次 \`agent_registry(action='snapshot', ...)\`，把模板 id、task_id、渲染后的完整 prompt、worker 回复原文、总得分与七维明细一起写进去。
- 不许用摘要代替原始回复：\`reply\` 必须是 worker 返回的完整文本。`

/** 验收章的简版：只要三档 + 否决项，省 token。 */
const VERIFY_LITE = `

## 验收（简版）
结论只有 PASS / PARTIAL（写清缺什么）/ FAIL（写清错在哪）。
一票否决：无产物、产物与报告不一致、越界改动、用吞异常/删测试换通过、拿推测当结论。
七维各 0/1/2 分（交付完整、可复现、证据密度、范围守恒、未决透明、自包含、token 经济），满分 14；≤8 不合格，12 以上算好。token 经济按信息密度判，不为省 token 少给证据。
token 经济硬扣分（命中任一直接记 0 分）：同一文件读两遍以上、逐段复述输入、超 50 字的元信息说明。总分 <9 一律返工，最多返工一次；第二次仍 <9 就写「卡住」并附 worker 原文，不做第三次。`

/** worker 侧的回报格式：它自己就该照着写，不必等被扣分。 */
const WORKER_REPORT = `

## 回报格式（会被按这七条评分）
- 三段固定：【结论】一句话；【证据】逐条字面量；【未决】没做完的与卡点。
- 每条结论后跟证据：路径:行号、命令、返回码、原文错误之一。结论:证据 ≥ 1:1。
- 【未决】写清「缺什么才能验」+「影响什么」，不写"部分完成"。
- 不贴无关原文、不复述过程、同一段内容不读第二遍。省 token 指不灌水，不是少给证据。
- 不得以吞异常、删测试、跳过校验的方式换取通过——会被一票否决。
- 回复正文最后附一行 \`TASK_ID: <task_id>\`，便于主管落盘对齐；除这一行外不加任何元信息。`

/** 模板库用法，只在工具注册成功时追加。 */
const REGISTRY_HINT = `

## 子 agent 模板库（agent_registry）
派活前先查库，别每次从零写指令：
1. \`agent_registry(action=search, query=<任务关键词>)\`；没命中再 \`action=list\` 看全部。
2. 命中就 \`action=get, id=…, vars={task,input,acceptance}\` 拿渲染好的 prompt，直接当 subagent 的 prompt 用；不要在它上面重新改写结构。
3. 新任务做完、验完，用 \`action=save\` 存模板（id 用英文短横线名，prompt 里留 {{task}}/{{input}}/{{acceptance}} 占位），\`action=score\` 记成绩（0-14 + PASS/PARTIAL/FAIL）。
4. 复用条件：同交付物类型 + 同验收口径才复用；模板里的 {{input}} 必须换成真实路径，不换就是猜。
5. 成绩连续两次低于 9 分的模板，把缺口写进 notes 或 \`action=delete\` 清掉，别留着误导下一次。
6. 判定 PASS 后立即 \`action=snapshot, id=…, task_id=…, prompt=<发出去的渲染全文>, reply=<worker 的完整原文>, score=…, dimensions=[…]\`：模板是下次的派法，快照是当次的底稿；查历史用 \`action=snapshots\`，看正文用 \`action=get, task_id=…\`。`

/**
 * 检测到 dsh-task-guard 时装在主 agent 契约后面的对接条款。
 * 目标是让两张计划表合成一张：任务表直接成为 task_plan 的入参，不写第二遍。
 */
function dshHome() {
  const explicit = process.env.DSH_HOME
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  return path.join(os.homedir(), '.dsh')
}

/**
 * 读一个 UTF-8 文本文件；缺失、不可读或全空白时返回空串。
 * 每次 assemble 都读：文件很小，且用户改完立即生效比省一次 stat 更值。
 * @param {string} file 绝对路径。
 * @returns {string} 去掉首尾空白的内容，或空串。
 */
function readTextOrEmpty(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return text.trim()
  } catch {
    return ''
  }
}

/**
 * 解析一份生效文本：row config 内联 > DSH_HOME 下的 md 文件 > 包内 prompts 文件 > 内置常量。
 * @param {string | undefined} inline row config 里的内联文本。
 * @param {string} userFile $DSH_HOME/preset-supervisor/*.md 的绝对路径。
 * @param {string} builtin 包内 prompts 文件路径。
 * @param {string} fallback 内置常量。
 * @returns {string} 非空文本。
 */
function resolveText(inline, userFile, builtin, fallback) {
  if (typeof inline === 'string' && inline.trim().length > 0) return inline.trim()
  const fromUser = readTextOrEmpty(userFile)
  if (fromUser.length > 0) return fromUser
  const fromPackage = readTextOrEmpty(builtin)
  if (fromPackage.length > 0) return fromPackage
  return fallback
}

/**
 * 当前装配作用域是不是子 agent。
 *
 * AssembleContext 的公开声明只有 scope/signal，但装配时会把 agent 带上，dsh-purge 等插件
 * 也按同一路径判定。字段缺失时一律当主 agent：宁可多给一份编排契约，也不要让主 agent
 * 因为判定不到而丢掉契约。
 * @param {unknown} context systemPrompt 传给 text 函数的装配上下文。
 * @returns {boolean} true 表示这是子 agent。
 */
function isSubagent(context) {
  try {
    return context?.agent?.session?.header?.origin === 'subagent'
  } catch {
    return false
  }
}

/**
 * 运行时可查：dsh-task-guard 把闸门工具注册在 tools 服务上，能看到就是装了且未被限制掉。
 * 装配期在别的 fiber 里访问服务可能抛错，所以调用方必须容忍这里返回 false 并走文件降级。
 * @param {any} ctx 插件上下文。
 * @returns {boolean} true 表示运行时能看到 task-guard 的工具。
 */
function probeRuntime(ctx) {
  try {
    const tools = (typeof ctx?.get === 'function' ? ctx.get('tools') : undefined) ?? ctx?.tools
    if (!tools || typeof tools.get !== 'function') return false
    return Boolean(tools.get('task_plan') || tools.get('task_step'))
  } catch {
    return false
  }
}

/**
 * 文件降级：profile 的 patch 里登记了 task-guard 且没写 disabled: true，就当成在线。
 * 运行时探测不可靠（装配回调不在活动 fiber 内），这条是主力判定。
 * @returns {boolean} true 表示 profile 里启用了 task-guard。
 */
function probeFiles() {
  const profileDir = process.env.DSH_PROFILE_DIR
  const candidates = []
  if (typeof profileDir === 'string' && profileDir.length > 0) {
    candidates.push(path.join(profileDir, 'cordis.patch.yml'))
    candidates.push(path.join(profileDir, 'package.json'))
  }
  candidates.push(path.join(dshHome(), 'profiles', 'desktop', 'cordis.patch.yml'))
  for (const file of candidates) {
    const text = readTextOrEmpty(file)
    if (text.length === 0) continue
    const at = text.search(/id:\s*['"]?task-guard['"]?/)
    if (at < 0) continue
    // 只看这一条 entry 之后的一小段，避免把别的 entry 的 disabled 读进来。
    const window = text.slice(at, at + 400)
    if (/disabled:\s*true/.test(window)) continue
    return true
  }
  return false
}

/**
 * 判断 dsh-task-guard 当前是否可用：运行时探测优先，失败走 profile 文件探测。
 * 结果按 60 秒缓存，避免每次装配都同步读盘；装/卸 task-guard 都在一分钟内反映出来。
 * @param {any} ctx 插件上下文。
 * @returns {boolean} true 表示该追加对接条款。
 */
function hasTaskGuard(ctx) {
  const now = Date.now()
  if (now - probeCache.at < 60_000) return probeCache.hit
  const hit = probeRuntime(ctx) || probeFiles()
  probeCache = { at: now, hit }
  return hit
}

/**
 * 归一化 taskGuard 配置：auto / on / off。
 * 兼容布尔写法（true→on，false→off），无法识别时按 auto 处理。
 * @param {unknown} value row config 里的 taskGuard 值。
 * @returns {'auto' | 'on' | 'off'} 探测策略。
 */
function normalizeTaskGuard(value) {
  if (value === true) return 'on'
  if (value === false) return 'off'
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (text === 'on' || text === 'always' || text === 'true') return 'on'
  if (text === 'off' || text === 'never' || text === 'false') return 'off'
  return 'auto'
}

/**
 * 归一化 verifyStandard 配置：full / lite / off。
 * @param {unknown} value row config 里的 verifyStandard 值。
 * @returns {'full' | 'lite' | 'off'} 验收章的详细程度。
 */
function normalizeVerify(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (text === 'off' || text === 'none' || value === false) return 'off'
  if (text === 'lite' || text === 'short' || text === 'min') return 'lite'
  return 'full'
}

/**
 * 拼接基础契约与对接条款；基础文本里已手写过对接内容时不再重复追加。
 * @param {string} base 生效的基础契约。
 * @param {string} adapter 对接条款。
 * @returns {string} 注入用的完整文本。
 */
function registryDir() {
  return path.join(dshHome(), 'preset-supervisor', 'agents')
}

/** 实例快照目录：模板是下次的派法，快照是当次的完整底稿。 */
function snapshotDir() {
  return path.join(registryDir(), 'snapshots')
}

/**
 * 列出全部快照；坏文件跳过，不拖累整表。
 * @returns {any[]} 快照对象数组。
 */
function listSnapshots() {
  const dir = snapshotDir()
  let names = []
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    try {
      const shot = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (shot && typeof shot.task_id === 'string') out.push(shot)
    } catch {
      /* 单个快照坏了不影响列表 */
    }
  }
  return out
}

/**
 * 写一份快照：同 task_id 直接覆盖，不留历史版本。
 * @param {any} shot 快照对象。
 * @returns {string} 落盘绝对路径。
 */
function writeSnapshot(shot) {
  const dir = snapshotDir()
  ensureDir(dir)
  const file = path.join(dir, `${shot.task_id}.json`)
  fs.writeFileSync(file, `${JSON.stringify(shot, null, 2)}\n`, 'utf8')
  return file
}

/**
 * 快照列表用的精简视图：只给元信息，不回正文（正文用 get + task_id 取）。
 * @param {any} shot 快照对象。
 * @returns {Record<string, unknown>} 摘要。
 */
function summarizeSnapshot(shot) {
  return {
    task_id: shot.task_id,
    score: shot.score ?? null,
    verdict: shot.verdict ?? null,
    reusabled: shot.reusabled === true,
    created_at: shot.created_at ?? null,
  }
}

/** 子 agent 每日 token 账本目录。 */
function metricsDir() {
  return path.join(dshHome(), 'preset-supervisor', 'metrics')
}

/** 本地日期键 YYYY-MM-DD。 */
function todayKey() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** profile 根目录：优先 DSH_PROFILE_DIR，其次 $DSH_HOME/profiles/<DSH_PROFILE>。 */
function profileDir() {
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  const name = process.env.DSH_PROFILE || 'desktop'
  return path.join(dshHome(), 'profiles', name)
}

/** 子 agent 预算默认值：10 轮、约 12 万字符上下文。 */
const BUDGET_DEFAULTS = { maxTurns: 10, maxContextChars: 120000 }

/**
 * 从 profile 的 agent.cordis.yml 读预算声明。
 * 不引 yaml 依赖，只认 subagentMaxTurns / subagentMaxContextChars 两个整数键。
 * @returns {{ maxTurns?: number, maxContextChars?: number }} 文件里声明的值，没写就不给。
 */
function readBudgetFromFile() {
  const text = readTextOrEmpty(path.join(profileDir(), 'agent.cordis.yml'))
  if (!text) return {}
  const turns = /subagentMaxTurns\s*:\s*(\d+)/.exec(text)
  const chars = /subagentMaxContextChars\s*:\s*(\d+)/.exec(text)
  const out = {}
  if (turns) out.maxTurns = Number(turns[1])
  if (chars) out.maxContextChars = Number(chars[1])
  return out
}

/**
 * 预算解析顺序：row config 显式值 > agent.cordis.yml 声明 > 内置默认。
 * @param {Record<string, unknown>} config 插件 row config。
 * @returns {{ maxTurns: number, maxContextChars: number, source: string }} 生效预算。
 */
function resolveBudget(config) {
  const out = { ...BUDGET_DEFAULTS, source: 'default' }
  const fromFile = readBudgetFromFile()
  if (Number.isFinite(fromFile.maxTurns) && fromFile.maxTurns > 0) {
    out.maxTurns = fromFile.maxTurns
    out.source = 'agent.cordis.yml'
  }
  if (Number.isFinite(fromFile.maxContextChars) && fromFile.maxContextChars > 0) {
    out.maxContextChars = fromFile.maxContextChars
    out.source = 'agent.cordis.yml'
  }
  const turns = Number(config?.subagentMaxTurns)
  if (Number.isFinite(turns) && turns > 0) {
    out.maxTurns = turns
    out.source = 'config'
  }
  const chars = Number(config?.subagentMaxContextChars)
  if (Number.isFinite(chars) && chars > 0) {
    out.maxContextChars = chars
    out.source = 'config'
  }
  return out
}

/** 单条消息的粗估字符数，只用于触发上下文截断，不用于计费。 */
function estimateChars(message) {
  try {
    return JSON.stringify(message ?? '').length
  } catch {
    return 0
  }
}

/**
 * 读一天的账本；文件不存在或损坏都当空账本，不让统计拖垮会话。
 * @param {string} date YYYY-MM-DD。
 * @returns {{ file: string, entries: any[] }} 文件路径与记录数组。
 */
function readMetrics(date) {
  const file = path.join(metricsDir(), `${date}.json`)
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { file, entries: Array.isArray(data?.entries) ? data.entries : [] }
  } catch {
    return { file, entries: [] }
  }
}

/**
 * 追加一条账本记录，按天累计写回。
 * @param {Record<string, unknown>} entry 记录，未给 date 时按今天。
 * @returns {string} 落盘绝对路径。
 */
function appendMetric(entry) {
  const date = typeof entry?.date === 'string' && entry.date.length > 0 ? entry.date : todayKey()
  const { file, entries } = readMetrics(date)
  entries.push({ ...entry, date })
  ensureDir(metricsDir())
  fs.writeFileSync(file, `${JSON.stringify({ date, entries }, null, 2)}\n`, 'utf8')
  return file
}

/**
 * 建目录，失败不抛（只读文件系统下工具仍要能返回错误而不是崩掉插件）。
 * @param {string} dir 目录绝对路径。
 */
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    /* 目录建不出来时后面的写入会自然失败并回报 */
  }
}

/**
 * 校验模板 id：允许中英文字母、数字、点、下划线、短横线，禁止路径分隔符。
 * @param {unknown} id 候选 id。
 * @returns {boolean} 是否可用作文件名。
 */
function validId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5._-]{0,63}$/.test(id)
}

/**
 * 读一个模板文件，坏 JSON 当成不存在。
 * @param {string} dir 目录。
 * @param {string} id 模板 id。
 * @returns {any | null} 模板对象或 null。
 */
function readProfile(dir, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 列出所有模板。
 * @param {string} dir 目录。
 * @returns {any[]} 模板对象数组。
 */
function listProfiles(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    try {
      const profile = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
      if (profile && typeof profile.id === 'string') out.push(profile)
    } catch {
      /* 单个文件坏了不拖累整表 */
    }
  }
  return out
}

/**
 * 写模板文件。
 * @param {string} dir 目录。
 * @param {any} profile 模板对象。
 */
function writeProfile(dir, profile) {
  ensureDir(dir)
  fs.writeFileSync(path.join(dir, `${profile.id}.json`), `${JSON.stringify(profile, null, 2)}\n`, 'utf8')
}

/**
 * 列表里用的精简视图：不带 prompt 全文，省 token。
 * @param {any} profile 模板对象。
 * @returns {Record<string, unknown>} 摘要。
 */
function summarize(profile) {
  return {
    id: profile.id,
    name: profile.name ?? '',
    summary: profile.summary ?? '',
    tags: Array.isArray(profile.tags) ? profile.tags : [],
    score: profile.score ?? null,
    bestScore: profile.bestScore ?? null,
    avgScore: profile.avgScore ?? null,
    verdict: profile.verdict ?? null,
    uses: profile.uses ?? 0,
    lastUsedAt: profile.lastUsedAt ?? null,
  }
}

/**
 * 渲染模板占位符：{{task}} / {{input}} / {{acceptance}} 等。
 * @param {unknown} template 模板全文。
 * @param {Record<string, unknown>} vars 变量表。
 * @returns {{text: string, unresolved: string[]}} 渲染结果与未替换的占位名。
 */
function renderTemplate(template, vars) {
  const text = String(template ?? '').replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  ))
  const unresolved = [...new Set([...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]))]
  return { text, unresolved }
}

/**
 * agent_registry 的工具定义。
 * 工具遵守 dsh-tools 的 ToolDefinition 契约：{ name, description, parameters, output, execute }。
 */
const registryTool = {
  name: 'agent_registry',
  description:
    '子 agent 模板库（preset-supervisor）：保存、检索、复用表现好的派发模板，代替每次从零写指令。'
    + 'action=list 列全部（按分数降序）；search 按关键词查；get 取模板并按 vars 渲染占位符，返回可直接用作 subagent prompt 的全文；'
    + 'save 新增或更新模板（prompt 必填，可用 {{task}}/{{input}}/{{acceptance}} 占位）；'
    + 'score 给模板记一次成绩（0-14 分 + PASS/PARTIAL/FAIL，写进 history 并重算平均分）；delete 删除模板；'
    + 'snapshot 把一次真实派活的完整底稿存成快照（id + task_id + 渲染后 prompt + worker 回复原文 + 分数 + 七维明细 + verdict + reusabled），落盘 agents/snapshots/<task_id>.json，同名覆盖；'
    + 'snapshots 只读列快照（可按 id 过滤，默认 5 条，降序），只回元信息，要正文用 get 传 task_id；'
    + 'cost 只读查某个日期（默认今天）的子 agent token 账本：当日输入/输出 token 与轮次总量，加单任务 token 前三名。'
    + '落盘位置 $DSH_HOME/preset-supervisor/agents/<id>.json，账本在 $DSH_HOME/preset-supervisor/metrics/<date>.json。',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'search', 'get', 'save', 'score', 'delete', 'snapshot', 'snapshots', 'cost'],
        description: 'list | search | get | save | score | delete | snapshot | snapshots | cost',
      },
      id: { type: 'string', description: '模板 id（英文短横线名，如 web-report-writer）' },
      name: { type: 'string', description: 'save 时的可读名' },
      summary: { type: 'string', description: 'save 时的一句话用途' },
      tags: { type: 'array', items: { type: 'string' }, description: 'save 时的检索标签' },
      prompt: { type: 'string', description: 'save 时的派发模板全文（七段结构，可含 {{task}} 等占位）' },
      acceptance: { type: 'array', items: { type: 'string' }, description: 'save 时的验收条目' },
      skills: { type: 'array', items: { type: 'string' }, description: 'save 时该模板常用的 skill 名' },
      vars: { type: 'object', additionalProperties: true, description: 'get 时替换占位符的变量表' },
      query: { type: 'string', description: 'search 的关键词' },
      limit: { type: 'number', description: 'list/search 的条数上限（默认 50）' },
      score: { type: 'number', description: 'score 的分数，0-14' },
      verdict: { type: 'string', enum: ['PASS', 'PARTIAL', 'FAIL'], description: 'score 时的结论' },
      notes: { type: 'string', description: 'score 时的缺口说明' },
      task_id: { type: 'string', description: 'snapshot 时的任务 id，同时作快照文件名；get 传它取快照正文' },
      reply: { type: 'string', description: 'snapshot 时 worker 返回的完整原文，不许用摘要代替' },
      dimensions: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'snapshot 时的七维明细，每项如 {name, score, note}' },
      date: { type: 'string', description: 'cost 时的日期，YYYY-MM-DD，缺省为今天' },
    },
    required: ['action'],
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  async execute(args) {
    const dir = registryDir()
    const action = typeof args?.action === 'string' ? args.action : 'list'

    if (action === 'list') {
      const limit = Number(args?.limit) > 0 ? Number(args.limit) : 50
      const items = listProfiles(dir)
        .map(summarize)
        .sort((a, b) => (Number(b.score ?? 0) - Number(a.score ?? 0))
          || String(b.lastUsedAt ?? '').localeCompare(String(a.lastUsedAt ?? '')))
        .slice(0, limit)
      return { ok: true, action, dir, total: items.length, items }
    }

    if (action === 'search') {
      const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : ''
      if (query.length === 0) return { ok: false, action, error: 'query-required', hint: 'search 需要一个关键词；想全看就用 action=list。' }
      const hits = listProfiles(dir)
        .filter((profile) => [
          profile.id, profile.name, profile.summary,
          (profile.tags ?? []).join(' '),
          String(profile.prompt ?? '').slice(0, 4000),
          (profile.acceptance ?? []).join(' '),
        ].join('\n').toLowerCase().includes(query))
        .map(summarize)
        .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
      return { ok: true, action, query, total: hits.length, items: hits, hint: hits.length > 0 ? '用 action=get + vars 取渲染后的 prompt。' : '没命中：直接用七段模板现写，做完再 action=save 存进来。' }
    }

    if (action === 'get') {
      if (typeof args?.task_id === 'string' && args.task_id.trim().length > 0) {
        const taskId = args.task_id.trim()
        const shot = listSnapshots().find((item) => item.task_id === taskId)
        if (!shot) {
          return { ok: false, action, error: 'snapshot-not-found', task_id: taskId, hint: '先用 action=snapshots 看有哪些 task_id。' }
        }
        return {
          ok: true,
          action,
          snapshot: summarizeSnapshot(shot),
          id: shot.id,
          prompt: shot.prompt,
          reply: shot.reply,
          dimensions: Array.isArray(shot.dimensions) ? shot.dimensions : [],
          hint: '这是当次完整底稿：prompt 是发出去的原文，reply 是收回来的原文。',
        }
      }
      if (!validId(args?.id)) return { ok: false, action, error: 'invalid-id', hint: 'id 只能是中英文字母/数字/点/下划线/短横线。' }
      const profile = readProfile(dir, args.id)
      if (!profile) return { ok: false, action, error: 'not-found', id: args.id }
      const vars = args?.vars && typeof args.vars === 'object' ? args.vars : {}
      const rendered = renderTemplate(profile.prompt, vars)
      profile.uses = Number(profile.uses ?? 0) + 1
      profile.lastUsedAt = new Date().toISOString()
      try {
        writeProfile(dir, profile)
      } catch {
        /* 记不上使用次数不影响取模板 */
      }
      return {
        ok: true,
        action,
        profile: summarize(profile),
        prompt: rendered.text,
        acceptance: profile.acceptance ?? [],
        skills: profile.skills ?? [],
        unresolved: rendered.unresolved,
        hint: rendered.unresolved.length > 0
          ? `还有未替换的占位：${rendered.unresolved.join('、')}——派活前换成真实值，别让 worker 猜。`
          : '可直接作为 subagent 的 prompt 使用。',
      }
    }

    if (action === 'save') {
      const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt.length === 0) return { ok: false, action, error: 'prompt-required', hint: 'save 必须给 prompt：七段结构的派发模板。' }
      const id = typeof args?.id === 'string' && args.id.trim().length > 0 ? args.id.trim() : `agent-${Date.now().toString(36)}`
      if (!validId(id)) return { ok: false, action, error: 'invalid-id', id }
      const existing = readProfile(dir, id)
      const now = new Date().toISOString()
      const scored = Number.isFinite(args?.score) ? Number(args.score) : null
      const profile = {
        id,
        name: typeof args?.name === 'string' && args.name.trim().length > 0 ? args.name.trim() : (existing?.name ?? id),
        summary: typeof args?.summary === 'string' ? args.summary : (existing?.summary ?? ''),
        tags: Array.isArray(args?.tags) ? args.tags : (existing?.tags ?? []),
        prompt,
        acceptance: Array.isArray(args?.acceptance) ? args.acceptance : (existing?.acceptance ?? []),
        skills: Array.isArray(args?.skills) ? args.skills : (existing?.skills ?? []),
        verdict: typeof args?.verdict === 'string' ? args.verdict : (existing?.verdict ?? null),
        score: scored ?? (existing?.score ?? null),
        bestScore: Math.max(Number(existing?.bestScore ?? 0), scored ?? 0) || null,
        avgScore: existing?.avgScore ?? null,
        uses: Number(existing?.uses ?? 0),
        notes: typeof args?.notes === 'string' ? args.notes : (existing?.notes ?? ''),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        lastUsedAt: existing?.lastUsedAt ?? null,
        history: Array.isArray(existing?.history) ? existing.history : [],
      }
      writeProfile(dir, profile)
      return { ok: true, action, profile: summarize(profile), path: path.join(dir, `${id}.json`) }
    }

    if (action === 'score') {
      if (!validId(args?.id)) return { ok: false, action, error: 'invalid-id' }
      const profile = readProfile(dir, args.id)
      if (!profile) return { ok: false, action, error: 'not-found', id: args.id }
      const value = Number(args?.score)
      if (!Number.isFinite(value) || value < 0 || value > 14) {
        return { ok: false, action, error: 'score-out-of-range', hint: '七维各 0/1/2 分，总分 0-14。' }
      }
      const verdict = ['PASS', 'PARTIAL', 'FAIL'].includes(args?.verdict)
        ? args.verdict
        : value >= 12 ? 'PASS' : value >= 9 ? 'PARTIAL' : 'FAIL'
      const history = [...(Array.isArray(profile.history) ? profile.history : []), {
        at: new Date().toISOString(),
        score: value,
        verdict,
        notes: typeof args?.notes === 'string' ? args.notes : '',
      }].slice(-20)
      const scores = history.map((entry) => Number(entry.score)).filter((n) => Number.isFinite(n))
      profile.score = value
      profile.verdict = verdict
      profile.bestScore = Math.max(Number(profile.bestScore ?? 0), value)
      profile.avgScore = scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : value
      profile.history = history
      profile.updatedAt = new Date().toISOString()
      writeProfile(dir, profile)
      return {
        ok: true,
        action,
        profile: summarize(profile),
        avgScore: profile.avgScore,
        recent: history.slice(-5),
        hint: value >= 12
          ? '表现好：可继续复用；把这次有效的原因是补进 summary/tags。'
          : '低于 12 分：把缺口写进 notes，下次派活时补进【验收】段再试。',
      }
    }

    if (action === 'snapshot') {
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      if (!validId(id)) return { ok: false, action, error: 'invalid-id', hint: 'snapshot 需要模板 id，与 save/get 用的是同一个。' }
      const taskId = typeof args?.task_id === 'string' ? args.task_id.trim() : ''
      if (!validId(taskId)) return { ok: false, action, error: 'invalid-task-id', hint: 'task_id 用作文件名，只能是中英文字母/数字/点/下划线/短横线。' }
      const prompt = typeof args?.prompt === 'string' ? args.prompt : ''
      if (prompt.trim().length === 0) return { ok: false, action, error: 'prompt-required', hint: 'prompt 必须是这次真正发给 worker 的渲染后全文。' }
      const reply = typeof args?.reply === 'string' ? args.reply : ''
      if (reply.trim().length === 0) return { ok: false, action, error: 'reply-required', hint: 'reply 必须是 worker 返回的完整原文，不许用摘要代替。' }
      const value = Number(args?.score)
      if (!Number.isFinite(value) || value < 0 || value > 14) {
        return { ok: false, action, error: 'score-out-of-range', hint: '七维各 0/1/2 分，总分 0-14。' }
      }
      const verdict = ['PASS', 'PARTIAL', 'FAIL'].includes(args?.verdict)
        ? args.verdict
        : value >= 12 ? 'PASS' : value >= 9 ? 'PARTIAL' : 'FAIL'
      const dimensions = Array.isArray(args?.dimensions) ? args.dimensions : []
      const shot = {
        id,
        task_id: taskId,
        created_at: new Date().toISOString(),
        prompt,
        reply,
        score: value,
        dimensions,
        verdict,
        reusabled: value >= 12,
      }
      let file = ''
      try {
        file = writeSnapshot(shot)
      } catch (error) {
        return { ok: false, action, error: 'write-failed', message: String(error?.message ?? error) }
      }
      return {
        ok: true,
        action,
        path: file,
        task_id: taskId,
        score: value,
        verdict,
        reusabled: shot.reusabled,
        size: { prompt: prompt.length, reply: reply.length, dimensions: dimensions.length },
        hint: shot.reusabled
          ? '已存档为可复用底稿：下次同任务照抄 prompt 与 dimensions。'
          : '存档完成，但 reusabled=false：低于 12 分，别当范本用。',
      }
    }

    if (action === 'snapshots') {
      const limit = Number(args?.limit) > 0 ? Number(args.limit) : 5
      const wantId = typeof args?.id === 'string' ? args.id.trim() : ''
      const all = listSnapshots()
        .filter((shot) => (wantId.length === 0 ? true : shot.id === wantId))
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
      return {
        ok: true,
        action,
        dir: snapshotDir(),
        total: all.length,
        items: all.slice(0, limit).map(summarizeSnapshot),
        hint: all.length > 0
          ? '要正文用 action=get 传 task_id。'
          : '还没有快照：判定 PASS 后调 action=snapshot 落一份。',
      }
    }

    if (action === 'cost') {
      const raw = typeof args?.date === 'string' ? args.date.trim() : ''
      const date = raw.length > 0 ? raw : todayKey()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { ok: false, action, error: 'invalid-date', hint: 'date 用 YYYY-MM-DD；不传就是今天。' }
      }
      const { file, entries } = readMetrics(date)
      const total = entries.reduce((acc, item) => {
        acc.tasks += 1
        acc.input_tokens += Number(item?.input_tokens) || 0
        acc.output_tokens += Number(item?.output_tokens) || 0
        acc.turns += Number(item?.turns) || 0
        return acc
      }, { tasks: 0, input_tokens: 0, output_tokens: 0, turns: 0 })
      const top = entries
        .map((item) => {
          const input = Number(item?.input_tokens) || 0
          const output = Number(item?.output_tokens) || 0
          return {
            task_id: item?.task_id ?? null,
            id: item?.id ?? null,
            total_tokens: input + output,
            input_tokens: input,
            output_tokens: output,
            turns: Number(item?.turns) || 0,
            verdict: item?.verdict ?? null,
          }
        })
        .sort((a, b) => b.total_tokens - a.total_tokens)
        .slice(0, 3)
      return {
        ok: true,
        action,
        date,
        file,
        exists: fs.existsSync(file),
        total,
        top,
        hint: entries.length > 0
          ? '前三按 input+output 总 token 排；turns 是子 agent 实际跑过的轮次。'
          : '这一天还没有记录：子 agent 跑完才会写账本。',
      }
    }

    if (action === 'delete') {
      if (!validId(args?.id)) return { ok: false, action, error: 'invalid-id' }
      const profile = readProfile(dir, args.id)
      if (!profile) return { ok: false, action, error: 'not-found', id: args.id }
      try {
        fs.unlinkSync(path.join(dir, `${args.id}.json`))
      } catch (error) {
        return { ok: false, action, error: 'delete-failed', message: String(error?.message ?? error) }
      }
      return { ok: true, action, id: args.id, deleted: true }
    }

    return { ok: false, action, error: 'unknown-action', allowed: ['list', 'search', 'get', 'save', 'score', 'delete', 'snapshot', 'snapshots', 'cost'] }
  },
}

/**
 * 依赖声明：cordis 的 Context 是受限代理，没在这里声明的服务一律拒绝访问
 * （否则激活期直接抛 `cannot get property "systemPrompt" without inject`）。
 * systemPrompt 是硬依赖；tools 用于注册 agent_registry 与探测 dsh-task-guard。
 */
// 依赖声明由包入口 index.js 统一声明：合并后只有一个插件、一个 inject。

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文。
 * @param {Record<string, unknown>} config 来自 cordis.patch.yml 的 row config。
 */
export function installOrchestrator(ctx, config = {}) {
  const enabled = config.enabled !== false
  const order = Number.isFinite(config.order) ? Number(config.order) : DEFAULT_ORDER
  const injectOrchestrator = config.injectOrchestrator !== false
  const injectWorker = config.injectWorker !== false
  const taskGuard = normalizeTaskGuard(config.taskGuard)
  const verify = normalizeVerify(config.verifyStandard)
  const registryEnabled = config.registry !== false

  const dir = dshHome()
  const orchestratorFile = typeof config.orchestratorFile === 'string' && config.orchestratorFile.trim().length > 0
    ? config.orchestratorFile.trim()
    : path.join(dir, 'preset-supervisor', 'orchestrator.md')
  const workerFile = typeof config.workerFile === 'string' && config.workerFile.trim().length > 0
    ? config.workerFile.trim()
    : path.join(dir, 'preset-supervisor', 'worker.md')

  const orchestratorBuiltin = path.join(HERE, 'prompts', 'orchestrator.md')
  const workerBuiltin = path.join(HERE, 'prompts', 'worker.md')

  // 先注册工具：text 回调要据此决定要不要附「模板库用法」。
  let registryReady = false
  if (registryEnabled) {
    try {
      const disposer = ctx.tools.register(registryTool)
      if (typeof disposer === 'function') ctx.effect(() => disposer)
      registryReady = true
    } catch (error) {
      console.warn(`[preset-supervisor] 注册 agent_registry 失败：${error?.message ?? error}`)
    }
  }

  // ── 子 agent 预算 + token 账本 ───────────────────────────────────────────
  // 预算来源：row config > profile 的 agent.cordis.yml > 内置默认（10 轮 / 12 万字符）。
  const budget = resolveBudget(config)
  /** sessionId → { input_tokens, output_tokens, turns, budget_hits } */
  const runStats = new Map()

  const statsOf = (id) => {
    const key = String(id ?? '')
    if (!key) return null
    let stats = runStats.get(key)
    if (!stats) {
      stats = { input_tokens: 0, output_tokens: 0, turns: 0, budget_hits: 0 }
      runStats.set(key, stats)
    }
    return stats
  }

  // 硬预算：子会话轮次或上下文超限时，本步只送「原始任务 + 最新指令」两条，
  // 中间过程全部丢弃——模型拿不到更多上下文，只能按已有信息交付部分结果。
  try {
    ctx.effect(() => ctx.on('agent/pre-step', async (payload, next) => {
      try {
        if (payload?.agent?.session?.header?.origin !== 'subagent') return next()
        const messages = Array.isArray(payload?.messages) ? payload.messages : []
        const turn = Number(payload?.turn) || 0
        const chars = messages.reduce((sum, message) => sum + estimateChars(message), 0)
        const overTurns = budget.maxTurns > 0 && turn > budget.maxTurns
        const overChars = budget.maxContextChars > 0 && chars > budget.maxContextChars
        if (!overTurns && !overChars) return next()
        const stats = statsOf(payload?.agent?.id)
        if (stats) stats.budget_hits += 1
        if (messages.length === 0) return next()
        const head = messages[0]
        const tail = messages[messages.length - 1]
        const kept = messages.length > 1 && head !== tail ? [head, tail] : [tail]
        return { kind: 'enter', messages: kept }
      } catch {
        return next()
      }
    }))
  } catch (error) {
    console.warn(`[preset-supervisor] 安装子 agent 预算钩子失败：${error?.message ?? error}`)
  }

  // 账本：assistant/message 事件的 usage 才是 token 来源（TokenUsage.inputTokens/outputTokens），
  // turn/start 记轮次；到 subagent/end 再按天落盘。
  try {
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      try {
        const stats = statsOf(session?.id)
        if (!stats) return
        if (event?.type === 'turn/start') {
          stats.turns = Math.max(stats.turns, Number(event?.data?.turn) || 0)
          return
        }
        if (event?.type === 'assistant/message') {
          const usage = event?.data?.usage
          if (!usage) return
          stats.input_tokens += Number(usage.inputTokens) || 0
          stats.output_tokens += Number(usage.outputTokens) || 0
        }
      } catch {
        /* 记账失败不影响会话 */
      }
    }))
  } catch (error) {
    console.warn(`[preset-supervisor] 安装 token 账本监听失败：${error?.message ?? error}`)
  }

  try {
    ctx.effect(() => ctx.on('subagent/end', (info) => {
      try {
        const id = String(info?.id ?? '')
        const stats = statsOf(id) ?? { input_tokens: 0, output_tokens: 0, turns: 0, budget_hits: 0 }
        const stop = String(info?.stopReason ?? '')
        // stopReason 直接映射成结论：跑完=PASS，撞 token 上限=PARTIAL（部分结果），其余=FAIL。
        const verdict = stop === 'completed' ? 'PASS' : stop === 'max-tokens' ? 'PARTIAL' : 'FAIL'
        appendMetric({
          task_id: String(info?.runId ?? id),
          id,
          input_tokens: stats.input_tokens,
          output_tokens: stats.output_tokens,
          turns: stats.turns,
          verdict,
          provider: info?.provider ?? null,
          stop_reason: stop,
          budget_hits: stats.budget_hits,
          at: new Date().toISOString(),
        })
        runStats.delete(id)
      } catch (error) {
        console.warn(`[preset-supervisor] 写 token 账本失败：${error?.message ?? error}`)
      }
    }))
  } catch (error) {
    console.warn(`[preset-supervisor] 安装 subagent 结束监听失败：${error?.message ?? error}`)
  }

  return {
    order,
    enabled,
    injectOrchestrator,
    injectWorker,
    verify,
    /**
     * 渲染本作用域应注入的编排契约。闸门协议不在这里——由包入口把它拼在同一个 section 里。
     * @param {unknown} context systemPrompt 传给 text 函数的装配上下文。
     * @returns {{ subagent: boolean, text: string }}
     */
    render(context) {
      const subagent = isSubagent(context)
      if (!enabled) return { subagent, text: '' }
      const wanted = subagent ? injectWorker : injectOrchestrator
      if (!wanted) return { subagent, text: '' }

      const base = subagent
        ? resolveText(config.workerText, workerFile, workerBuiltin, BUILTIN_WORKER)
        : resolveText(config.orchestratorText, orchestratorFile, orchestratorBuiltin, BUILTIN_ORCHESTRATOR)

      let text = base
      if (verify !== 'off') {
        const verifyText = subagent ? WORKER_REPORT : (verify === 'lite' ? VERIFY_LITE : VERIFY_FULL)
        text = `${text}\n${verifyText}`
      }
      if (!subagent && registryReady) text = `${text}\n${REGISTRY_HINT}`
      return { subagent, text }
    },
  }
}
