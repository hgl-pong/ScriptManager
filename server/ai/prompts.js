// Prompt construction for the five AI uses. Pure functions of the request, so the
// HTTP layer only has to gather the script text and the last run.

export const AI_KINDS = ['generate', 'explain', 'diagnose', 'logging', 'harden']

const TYPE_LABEL = {
  cmd: 'cmd 批处理（.bat / .cmd）',
  powershell: 'PowerShell（.ps1）',
  python: 'Python（.py）',
}

const TYPE_RULES = {
  cmd: '首行写 @echo off；只使用 cmd.exe 内置命令和常见的 Windows 系统工具；控制台输出用英文，避免中文编码问题；注释用中文；路径一律加引号。',
  powershell: '使用 Windows PowerShell 5.1 兼容语法；路径参数加引号；先做基本参数检查；注释用中文。',
  python: '只使用 Python 标准库，除非需求明确要求第三方包；文件读写显式指定 encoding="utf-8"；注释用中文。',
}

const SCRIPT_SYSTEM = [
  '你是 Windows 上的脚本助手。',
  '用户会用中文描述需求或贴出脚本，你按下面的约束输出脚本正文。',
  '只输出脚本本身，不要 Markdown 代码围栏，不要解释、前后缀或“以下是脚本”之类的话。',
].join('\n')

const CHAT_SYSTEM = [
  '你是 Windows 脚本助手，熟悉 cmd 批处理、PowerShell 5.1 和 Python。',
  '用简体中文回答；先给结论，再给必要的细节；不要复述整个脚本，除非用户要求。',
].join('\n')

// Returns { system, messages } in the shape the job layer sends.
export function buildMessages(kind, context = {}) {
  if (!AI_KINDS.includes(kind)) throw new Error(`未知的 AI 用途：${kind}`)

  const type = TYPE_LABEL[context.type] ? context.type : 'cmd'
  const label = TYPE_LABEL[type]
  const rules = TYPE_RULES[type]

  if (kind === 'generate') {
    const parts = [
      `目标解释器：${label}`,
      context.previous
        ? `上一版脚本（请在此基础上按补充要求修改）：\n\`\`\`\n${context.previous}\n\`\`\``
        : '',
      `需求：${String(context.prompt ?? '').trim() || '（沿用上一版脚本的要求）'}`,
      '约束：',
      `- ${rules}`,
      '- 脚本要能直接保存为文件运行，不依赖当前目录。',
      '- 只输出完整脚本正文：不要代码围栏，不要解释。',
    ]
    return {
      system: `${SCRIPT_SYSTEM}\n目标解释器：${label}`,
      messages: [{ role: 'user', content: parts.filter(Boolean).join('\n\n') }],
    }
  }

  const scriptBlock = `脚本（${label}）：\n\`\`\`\n${context.script ?? ''}\n\`\`\``

  let content
  if (kind === 'explain') {
    content = [
      '解释下面这个脚本做了什么：',
      scriptBlock,
      '用中文分点说明关键步骤，最后列出可能的副作用、风险或容易误用的地方。不要改写脚本。',
    ].join('\n\n')
  } else if (kind === 'diagnose') {
    const exitCode = context.lastExitCode ?? null
    const output = String(context.lastRunText ?? '').trim()
    content = [
      '一个脚本运行失败了，请判断最可能的原因并给出修复建议。',
      scriptBlock,
      exitCode === null ? '本进程内还没有这个脚本的运行记录。' : `最近一次运行的退出码：${exitCode}`,
      output ? `最近一次运行的输出：\n\`\`\`\n${output}\n\`\`\`` : '',
      '用中文回答：先给最可能的原因（结合输出里的报错），再给检查步骤和修复方法。如果需要改脚本，把修改后的完整脚本放在最后并用代码围栏包住。',
    ]
      .filter(Boolean)
      .join('\n\n')
  } else if (kind === 'logging') {
    content = [
      `给下面这个 ${label} 脚本加上日志和错误处理，不改变原有功能：`,
      scriptBlock,
      '要求：关键步骤写日志（带时间或步骤名）；错误分支给出清晰提示并以非零码退出；临时文件或中间状态失败时能看出失败在哪一步。',
      '只输出完整脚本正文：不要代码围栏，不要解释。',
    ].join('\n\n')
  } else {
    content = [
      `在不改变功能的前提下，把下面这个 ${label} 脚本改写得更加安全：`,
      scriptBlock,
      '重点：校验路径和参数；删除/覆盖前检查目标；所有路径加引号；避免以当前目录为隐含基准；失败时给出清晰错误并以非零码退出；不要引入新依赖。',
      '只输出完整脚本正文：不要代码围栏，不要解释。',
    ].join('\n\n')
  }

  return { system: CHAT_SYSTEM, messages: [{ role: 'user', content }] }
}

// AI output is asked to be raw script, but a fenced reply is a common failure mode.
// Only unwrap when the whole text is one fence, so an edited reply is left alone.
export function unwrapScript(text) {
  const raw = String(text ?? '')
  const match = raw.trim().match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/)
  return match ? match[1].replace(/\r$/, '') : raw
}
