import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

const TURN = { durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as const
const ATTACH = { surface: 'desktop', clientId: 'desktop:default' } as const
const START = { cwd: 'C:\\work\\MyProject', surface: 'desktop', isInteractive: true } as const
const COLD_START_MS = 60_000
const STATUS_WAITING = 'Will speak when you open this session'
const ANNOUNCEMENT = 'MyProject has finished and would like to speak.'
const ANNOUNCER = 'session-1#announce'

type Sent = { text: string; voice: string; owner: string; queue?: boolean; after_own?: boolean; paused?: boolean }

type Job = { id: number; text: string; owner: string; result?: string; error?: string; waiters: (() => void)[] }

type Speaker = {
  isRunning: boolean
  starts: string[][]
  spoken: string[]
  sends: Sent[]
  records: unknown[]
  writes: string[]
  played: string[]
  ended: { text: string; result: string }[]
  playing: () => string | undefined
  holds: (text: string) => boolean
  end: (result?: string) => void
  speakAs: (owner: string, text: string) => void
  speechError?: string
  stopBodies: Record<string, unknown>[]
  pauseCalls: string[]
  pauseFails: boolean
  waitingAnswers: number
  holdSends: number
  releaseSends: () => void
  toasts: string[]
  startResult: { exitCode: number; stdout: string; stderr: string }
  urls: string[]
  exists: (path: string) => boolean
  summaryRequests: { model: string; system: string; prompt: string }[]
  summaryMode: 'answer' | 'fail' | 'timeout' | 'long'
  holdSummaries: number
  summaryFailure: Record<string, unknown>
  summaryCancelled: boolean
  cancelledCount: number
  surfaceGate?: Promise<void>
  surfaceCalls: number
  releasers: (() => void)[]
  releaseSummaries: () => void
  surfaces: string[]
  answers: string[]
  thoughts: string[]
  tools: string[][]
  stepCounts: Map<string, number>
  cwd: string
  sessionId: string
  until: (condition: () => boolean) => Promise<void>
  settle: () => Promise<void>
}

function emptyBand(on: On) {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
}

// Models the speaker's /speak, /stop, /wait, /pause and /resume: one job plays at a time, the rest wait in line, and a paused owner's jobs wait at the front. A job finishes at once unless `holds` keeps it playing until `end`.
function fakeSpeaker(on: On): Speaker {
  emptyBand(on)
  const clock = mock.clock(on)
  const listeners: (() => void)[] = []
  const notify = () => listeners.slice().forEach(listener => listener())
  const jobs = new Map<number, Job>()
  const line: Job[] = []
  const paused = new Set<string>()
  let current: Job | undefined

  const close = (job: Job, result: string, error?: string) => {
    job.result = result
    job.error = error
    speaker.ended.push({ text: job.text, result })
    job.waiters.splice(0).forEach(wake => wake())
  }
  const playNext = () => {
    for (;;) {
      const next = current ? -1 : line.findIndex(job => !paused.has(job.owner))
      if (next < 0) break
      const job = line.splice(next, 1)[0]!
      current = job
      speaker.played.push(job.text)
      if (speaker.speechError !== undefined) {
        current = undefined
        close(job, 'error', speaker.speechError)
      } else if (!speaker.holds(job.text)) {
        current = undefined
        close(job, 'finished')
      }
    }
    notify()
  }
  const cut = (isCut: (job: Job) => boolean) => {
    for (const job of line.filter(isCut)) {
      line.splice(line.indexOf(job), 1)
      close(job, 'stopped')
    }
    if (current && isCut(current)) {
      const job = current
      current = undefined
      close(job, 'stopped')
    }
    playNext()
  }
  const enqueue = (body: Sent) => {
    const job: Job = { id: jobs.size + 1, text: body.text, owner: body.owner, waiters: [] }
    jobs.set(job.id, job)
    if (body.paused === true) paused.add(body.owner)
    else if (body.paused === false || (!body.queue && !body.after_own)) paused.delete(body.owner)
    const isOwnerPaused = paused.has(body.owner)
    if (!body.queue) cut(other => (other.owner === body.owner ? !body.after_own : !isOwnerPaused && !paused.has(other.owner)))
    line.push(job)
    playNext()
    return job
  }

  const speaker: Speaker = {
    isRunning: false,
    starts: [],
    spoken: [],
    sends: [],
    records: [],
    writes: [],
    played: [],
    ended: [],
    playing: () => current?.text,
    holds: () => false,
    end: (result = 'finished') => {
      const job = current
      if (!job) throw new Error('nothing is playing')
      current = undefined
      close(job, result)
      playNext()
    },
    speakAs: (owner, text) => void enqueue({ text, voice: 'af_heart', owner }),
    stopBodies: [],
    pauseCalls: [],
    pauseFails: false,
    waitingAnswers: 0,
    holdSends: 0,
    releaseSends: () => {},
    toasts: [],
    startResult: { exitCode: 0, stdout: 'ready', stderr: '' },
    urls: [],
    exists: () => true,
    summaryRequests: [],
    summaryMode: 'answer',
    holdSummaries: 0,
    summaryFailure: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' },
    summaryCancelled: false,
    cancelledCount: 0,
    surfaceCalls: 0,
    releasers: [],
    releaseSummaries: () => speaker.releasers.splice(0).forEach(release => release()),
    surfaces: ['desktop'],
    answers: [],
    thoughts: [],
    tools: [],
    stepCounts: new Map(),
    cwd: 'C:\\work\\MyProject',
    sessionId: 'session-1',
    settle: () => clock.settle(),
    until: condition =>
      new Promise<void>(resolve => {
        const check = () => {
          if (!condition()) return
          listeners.splice(listeners.indexOf(check), 1)
          resolve()
        }
        listeners.push(check)
        check()
      }),
  }
  const answer = (body: unknown, status = 200) => ({ value: { status, ok: status < 400, headers: {}, text: JSON.stringify(body) } })

  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_$, e) {
    const thought = speaker.thoughts.shift() ?? ''
    if (thought) {
      yield { kind: 'thinking', index: 0, text: thought.slice(0, 3), ref: 1 } as never
      yield { kind: 'thinking', index: 0, text: thought.slice(3), ref: 2 } as never
    }
    for (const [i, id] of (speaker.tools.shift() ?? []).entries()) yield { kind: 'tool', index: i + 2, id, name: 'Read', ref: i + 3 } as never
    return { turnId: e.turnId, index: e.index, answer: speaker.answers.shift() ?? '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  on('fs.exists', (_$, e) => ({ value: speaker.exists(e.path) }))
  on('fs.write', (_$, e) => {
    speaker.writes.push(e.path)
    return { value: undefined }
  })
  on('session.id', () => ({ value: speaker.sessionId }))
  on('session.cwd', () => ({ value: speaker.cwd }))
  on('session.surfaces', async () => {
    speaker.surfaceCalls += 1
    notify()
    await speaker.surfaceGate
    return { value: speaker.surfaces }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.attach', (_$, e) => ({ clientId: e.clientId }))
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))

  on('http.fetch', async (_$, e) => {
    const url = new URL(e.url)
    speaker.urls.push(e.url)
    if (!speaker.isRunning) return { deny: 'connection refused' }
    if (url.pathname === '/health') return answer({ service: 'claudevoice', ready: true, speaking: current !== undefined })
    if (url.pathname === '/speak') {
      const { record, ...body } = JSON.parse(e.init?.body ?? '{}') as Sent & { record?: unknown }
      speaker.sends.push(body)
      speaker.records.push(record)
      speaker.spoken.push(body.text)
      const job = enqueue(body)
      if (speaker.holdSends > 0) {
        speaker.holdSends -= 1
        await new Promise<void>(resolve => (speaker.releaseSends = resolve))
      }
      return answer({ job: job.id })
    }
    if (url.pathname === '/stop') {
      const body = JSON.parse(e.init?.body ?? '{}') as { owner?: string; job?: number }
      speaker.stopBodies.push(body)
      if (body.job === undefined) paused.delete(body.owner ?? '')
      cut(job => (body.job !== undefined ? job.id === body.job : body.owner !== undefined ? job.owner === body.owner : true))
      return answer({ stopped: true })
    }
    if (url.pathname === '/pause' || url.pathname === '/resume') {
      const { owner } = JSON.parse(e.init?.body ?? '{}') as { owner: string }
      speaker.pauseCalls.push(`${url.pathname.slice(1)} ${owner}`)
      if (speaker.pauseFails) return answer({ error: 'not found' }, 404)
      if (url.pathname === '/pause') {
        if (current?.owner === owner || line.some(job => job.owner === owner)) paused.add(owner)
        if (current?.owner === owner) {
          line.unshift(current)
          current = undefined
        }
      } else if (paused.delete(owner) && line.some(job => job.owner === owner)) {
        cut(job => job.owner !== owner && !paused.has(job.owner))
      }
      playNext()
      return answer({ paused: paused.has(owner) })
    }
    if (url.pathname === '/wait') {
      const job = jobs.get(Number(url.searchParams.get('job')))
      if (!job) return answer({ result: 'unknown' })
      if (job.result === undefined && speaker.waitingAnswers > 0) {
        speaker.waitingAnswers -= 1
        notify()
        return answer({ job: job.id, result: 'waiting' })
      }
      if (job.result === undefined) await new Promise<void>(resolve => job.waiters.push(resolve))
      return answer({ job: job.id, result: job.result, ...(job.error === undefined ? {} : { error: job.error }) })
    }
    return answer({ error: 'not found' }, 404)
  })

  on('process.run', async (_$, e) => {
    speaker.starts.push([...e.argv])
    notify()
    if (speaker.startResult.exitCode === 0) speaker.isRunning = true
    return { value: { ...speaker.startResult } }
  })

  on('model.complete', async (_$, e, next) => {
    const prompt = String(e.prompt)
    speaker.summaryRequests.push({ model: e.model, system: String(e.system ?? ''), prompt })
    notify()
    if (speaker.holdSummaries > 0) {
      speaker.holdSummaries -= 1
      const cancelled = await new Promise<boolean>(resolve => {
        speaker.releasers.push(() => resolve(false))
        next.signal.addEventListener('abort', () => resolve(true), { once: true })
      })
      if (cancelled) {
        speaker.summaryCancelled = true
        speaker.cancelledCount += 1
        notify()
        return { value: { isAnswered: false, reason: 'aborted', usage: { input_tokens: 0, output_tokens: 0 } } }
      }
    }
    if (speaker.summaryMode === 'timeout') return { value: { isAnswered: false, reason: 'aborted' } }
    if (speaker.summaryMode === 'fail') return { value: speaker.summaryFailure }
    if (speaker.summaryMode === 'long') return { value: { isAnswered: true, text: 'Report. '.repeat(80), usage: { input_tokens: 1, output_tokens: 1 } } }
    const reply = prompt.replace(/^<(reply|thinking)>\n/, '').replace(/\n<\/(reply|thinking)>$/, '')
    return { value: { isAnswered: true, text: `Spoken: ${reply}`, usage: { input_tokens: 1, output_tokens: 1 } } }
  })

  on('ui.toast', (_$, e) => {
    speaker.toasts.push(e.text)
    notify()
    return { value: undefined }
  })

  return speaker
}

type Engine = Parameters<Parameters<typeof test>[1]>[0]
type Mounted = Awaited<ReturnType<Engine['ui']['mount']>>

const PLACE = /^Message \d+ of \d+$/

async function texts(ui: Mounted) {
  await ui.redraw()
  return (await ui.findAll({ type: 'Text' }))
    .map(found => found.text)
    .filter(text => text !== 'beneath' && !text.startsWith('read-aloud'))
}

const statusShown = async (ui: Mounted) => (await texts(ui)).find(text => !PLACE.test(text))
const placeShown = async (ui: Mounted) => (await texts(ui)).find(text => PLACE.test(text))

async function showsStatus(speaker: Speaker, ui: Mounted, text: string) {
  await speaker.settle()
  expect(await statusShown(ui)).toBe(text)
}

async function showsNoStatus(speaker: Speaker, ui: Mounted) {
  await speaker.settle()
  expect(await statusShown(ui)).toBeUndefined()
}

async function showsPlace(speaker: Speaker, ui: Mounted, text: string | undefined) {
  await speaker.settle()
  expect(await placeShown(ui)).toBe(text)
}

async function label(ui: Mounted, key: string) {
  await ui.redraw()
  return (await ui.find({ key }))?.props.label
}

function open($: Engine, surface: 'desktop' | 'terminal' = 'desktop') {
  return $.ui.mount({ plugin: 'read-aloud', surface, ...BAND })
}

async function turnVoiceOn(ui: Mounted) {
  await ui.press({ key: 'voice-toggle' })
  expect((await ui.find({ key: 'voice-toggle' }))?.props.label).toBe('Voice: on')
}

async function step($: Engine, speaker: Speaker, answer: string, extra: { turnId?: string; agentId?: string; thought?: string; tools?: string[] } = {}) {
  const { thought = '', tools = [], ...rest } = extra
  speaker.answers.push(answer)
  speaker.thoughts.push(thought)
  speaker.tools.push(tools)
  const turnId = rest.turnId ?? 't1'
  const index = speaker.stepCounts.get(turnId) ?? 0
  speaker.stepCounts.set(turnId, index + 1)
  const stream = $.turn.step({ model: 'opus', messageCount: 1, ...rest, turnId, index })
  let read = await stream.next()
  while (!read.done) read = await stream.next()
  return read.value
}

async function finishTurn($: Engine, speaker: Speaker, answer: string, turnId = 't1') {
  await step($, speaker, answer, { turnId })
  await $.turn.complete({ ...TURN, turnId, answer })
}

async function finishTurns($: Engine, speaker: Speaker, answers: string[]) {
  for (const [n, answer] of answers.entries()) await finishTurn($, speaker, answer, `t${n + 1}`)
}

async function runTurn($: Engine, speaker: Speaker, answers: string[], turnId = 't1') {
  for (const answer of answers) await step($, speaker, answer, { turnId })
  await $.turn.complete({ ...TURN, turnId, answer: answers.at(-1) ?? '' })
}

describe('bar row', () => {
  test('shows a voice toggle, picker, Repeat and Skip on desktop and terminal under what is drawn beneath', { timeoutMs: COLD_START_MS }, async ($, on) => {
    emptyBand(on)
    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await open($, surface)
      expect(await ui.find({ text: /^beneath$/ })).toBeDefined()
      expect((await ui.find({ key: 'voice-toggle' }))?.props.label).toBe('Voice: off')
      expect((await ui.find({ key: 'voice-pick' }))?.type).toBe('Select')
      expect((await ui.find({ key: 'voice-repeat' }))?.props.label).toBe('Repeat')
      expect((await ui.find({ key: 'voice-skip' }))?.props).toMatchObject({ label: 'Skip', dimColor: true })
      expect(await statusShown(ui)).toBeUndefined()
      expect(await placeShown(ui)).toBeUndefined()
      await ui.unmount()
    }
  })

  test('draws nothing of its own while a survey is showing', { timeoutMs: COLD_START_MS }, async ($, on) => {
    emptyBand(on)
    const ui = await $.ui.mount({ plugin: 'read-aloud', surface: 'desktop', ...BAND, props: { ...BAND.props, hasSurvey: true } })
    expect(await ui.find({ key: 'voice-toggle' })).toBeUndefined()
    expect(await ui.find({ key: 'voice-pick' })).toBeUndefined()
    expect(await ui.find({ key: 'voice-skip' })).toBeUndefined()
    await ui.unmount()
  })

  test('lists all 28 voices, best grade first, with name, gender and grade', async ($, on) => {
    fakeSpeaker(on)
    const ui = await open($)
    const options = (await ui.find({ key: 'voice-pick' }))?.props.options as { value: string; label: string }[]
    expect(options).toHaveLength(28)
    expect(options[0]).toEqual({ value: 'af_heart', label: 'Heart - Female (A)' })
    expect(options[1]).toEqual({ value: 'af_bella', label: 'Bella - Female (A-)' })
    expect(options[27]).toEqual({ value: 'am_adam', label: 'Adam - Male (F+)' })
    expect(options.every(option => /^[A-Z][a-z]+ - (Female|Male) \([A-F][+-]?\)$/.test(option.label))).toBe(true)
    expect(new Set(options.map(option => option.value)).size).toBe(28)
    const rank = (option: { label: string }) => {
      const grade = option.label.match(/\((.+)\)/)![1]!
      return 'ABCDF'.indexOf(grade[0]!) * 3 + (grade.endsWith('+') ? 0 : grade.endsWith('-') ? 2 : 1)
    }
    const ranks = options.map(rank)
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    await ui.unmount()
  })

  test('the picker starts on the first voice when there is no config.json', async ($, on) => {
    fakeSpeaker(on)
    await $.session.start(START)
    const ui = await open($)
    expect((await ui.find({ key: 'voice-pick' }))?.props.value).toBe('af_heart')
    await ui.unmount()
  })

  test('the picker starts on the voice in config.json, read when the session starts', async ($, on) => {
    fakeSpeaker(on)
    on('fs.read', (_$, e) => (e.path.endsWith('config.json') ? { value: '{"voice": "bf_emma"}' } : { deny: 'no such file' }))
    await $.session.start(START)
    const ui = await open($)
    expect((await ui.find({ key: 'voice-pick' }))?.props.value).toBe('bf_emma')
    await ui.unmount()
  })

  test('picking a voice changes the picker and the voice that is spoken', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await ui.select({ key: 'voice-pick', value: 'am_adam' })
    expect((await ui.find({ key: 'voice-pick' }))?.props.value).toBe('am_adam')
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.sends.length === 1)
    expect(speaker.sends[0]!.voice).toBe('am_adam')
    await ui.unmount()
  })
})

describe('with voice off', () => {
  test('a turn ending asks for no summary and sends nothing to the speaker', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await finishTurn($, speaker, 'Hello.')
    await speaker.settle()
    expect(speaker.summaryRequests).toHaveLength(0)
    expect(speaker.urls).toHaveLength(0)
    expect(speaker.starts).toHaveLength(0)
    expect(speaker.toasts).toEqual([])
    expect(await placeShown(ui)).toBeUndefined()
    await ui.unmount()
  })

  test('turning voice on does nothing until the next turn ends', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await finishTurn($, speaker, 'Before.')
    await turnVoiceOn(ui)
    await speaker.settle()
    expect(speaker.summaryRequests).toHaveLength(0)
    expect(speaker.spoken).toEqual([])
    expect(speaker.urls).toHaveLength(0)
    await finishTurn($, speaker, 'After.', 't2')
    await speaker.until(() => speaker.spoken.length === 1)
    expect(speaker.spoken).toEqual(['Spoken: After.'])
    await ui.unmount()
  })
})

describe('with voice on and the session viewed', () => {
  test('a main turn ending is summarized and spoken with the chosen voice, the session as owner, after its own earlier speech', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'I changed `config.json`.')
    await speaker.until(() => speaker.ended.length === 1)

    expect(speaker.summaryRequests).toHaveLength(1)
    expect(speaker.summaryRequests[0]!.model).toBe('haiku')
    expect(speaker.summaryRequests[0]!.prompt).toBe('<reply>\nI changed `config.json`.\n</reply>')
    expect(speaker.summaryRequests[0]!.system).toContain('config dot json')
    expect(speaker.summaryRequests[0]!.system).toContain('If the reply asks no question, ask none.')
    expect(speaker.summaryRequests[0]!.system).toContain('"claude.md" becomes "claude dot md"')
    expect(speaker.summaryRequests[0]!.system).toContain('Your words go straight to a text-to-speech engine')
    expect(speaker.summaryRequests[0]!.system).toContain(
      "Do not say that this is a summary. If the reply is only a sentence or two, keep it about as long as the reply. If it is longer, use at most about a third of the reply's length, and never more than 120 words.",
    )
    expect(speaker.sends[0]).toEqual({ text: 'Spoken: I changed `config.json`.', voice: 'af_heart', owner: 'session-1', after_own: true, paused: false })
    expect(speaker.ended).toEqual([{ text: 'Spoken: I changed `config.json`.', result: 'finished' }])
    await showsNoStatus(speaker, ui)
    await showsPlace(speaker, ui, undefined)
    expect(speaker.toasts).toEqual([])
    await ui.unmount()
  })

  test('shows when it is summarizing and when it is speaking', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holdSummaries = 1
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.summaryRequests.length === 1)
    await showsStatus(speaker, ui, 'Summarizing…')
    expect(await label(ui, 'voice-repeat')).toBe('Stop')
    speaker.releaseSummaries()
    await speaker.until(() => speaker.playing() === 'Spoken: Hello.')
    await showsStatus(speaker, ui, 'Speaking')
    speaker.end()
    await showsNoStatus(speaker, ui)
    expect(await label(ui, 'voice-repeat')).toBe('Repeat')
    await ui.unmount()
  })

  test('Repeat sends thinking to Haiku labeled as thinking when the latest block was thinking', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await step($, speaker, '', { thought: 'Hmm, let me think.' })
    await $.turn.complete({ ...TURN, answer: '' })
    await ui.press({ key: 'voice-repeat' })
    await speaker.until(() => speaker.sends.length === 1)
    expect(speaker.summaryRequests.map(request => request.prompt)).toEqual(['<thinking>\nHmm, let me think.\n</thinking>'])
    await ui.unmount()
  })

  test('a subagent step and turn ending are ignored, and Repeat still says the main reply', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Main reply.')
    await speaker.until(() => speaker.ended.length === 1)
    await step($, speaker, 'Helper report.', { turnId: 't2', agentId: 'helper' })
    await $.turn.complete({ ...TURN, turnId: 't2', agentId: 'helper', answer: 'Helper report.' })
    await speaker.settle()
    expect(speaker.summaryRequests).toHaveLength(1)
    expect(speaker.spoken).toEqual(['Spoken: Main reply.'])
    expect(await placeShown(ui)).toBeUndefined()
    await ui.press({ key: 'voice-repeat' })
    await speaker.until(() => speaker.spoken.length === 2)
    expect(speaker.spoken).toEqual(['Spoken: Main reply.', 'Spoken: Main reply.'])
    expect(speaker.summaryRequests).toHaveLength(1)
    await ui.unmount()
  })

  test('starts the speaker when it is not running, then speaks', async ($, on) => {
    const speaker = fakeSpeaker(on)
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.spoken.length === 1)
    expect(speaker.starts).toHaveLength(1)
    expect(speaker.starts[0]!.slice(1)).toEqual(['-m', 'claudevoice', 'start'])
    expect(speaker.starts[0]![0]).toMatch(/[\\/]\.venv[\\/]Scripts[\\/]python\.exe$/)
    expect(speaker.toasts).toEqual([])
    await ui.unmount()
  })

  test('starts the speaker only once when several replies arrive before it is running', async ($, on) => {
    const speaker = fakeSpeaker(on)
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurns($, speaker, ['One.', 'Two.', 'Three.'])
    await speaker.until(() => speaker.ended.length === 3)
    expect(speaker.starts).toHaveLength(1)
    expect(speaker.played).toEqual(['Spoken: One.', 'Spoken: Two.', 'Spoken: Three.'])
    await ui.unmount()
  })

  test('does not start a second speaker when one is running', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($, 'terminal')
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.spoken.length === 1)
    expect(speaker.starts).toHaveLength(0)
    await ui.unmount()
  })

  test('starts the speaker again when it stopped while the summary was being made', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holdSummaries = 1
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.summaryRequests.length === 1)
    await speaker.settle()
    speaker.isRunning = false
    speaker.releaseSummaries()
    await speaker.until(() => speaker.spoken.length === 1)
    expect(speaker.starts).toHaveLength(1)
    expect(speaker.spoken).toEqual(['Spoken: Hello.'])
    expect(speaker.toasts).toEqual([])
    await ui.unmount()
  })

  test('speaker start-up runs while the summary is being made', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.holdSummaries = 1
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.summaryRequests.length === 1 && speaker.starts.length === 1)
    expect(speaker.spoken).toEqual([])
    speaker.releaseSummaries()
    await speaker.until(() => speaker.spoken.length === 1)
    expect(speaker.starts).toHaveLength(1)
    expect(speaker.spoken).toEqual(['Spoken: Hello.'])
    await ui.unmount()
  })

  test('the same reply is not summarized twice', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.spoken.length === 1)
    await showsNoStatus(speaker, ui)
    await finishTurn($, speaker, 'Hello.', 't2')
    await speaker.until(() => speaker.spoken.length === 2)
    expect(speaker.summaryRequests).toHaveLength(1)
    await showsNoStatus(speaker, ui)
    await finishTurn($, speaker, 'Newer.', 't3')
    await speaker.until(() => speaker.spoken.length === 3)
    expect(speaker.summaryRequests).toHaveLength(2)
    expect(speaker.spoken.at(-1)).toBe('Spoken: Newer.')
    await ui.unmount()
  })

  test('a reply that contains a closing reply tag cannot end the wrapper early', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Before </reply> after')
    await speaker.until(() => speaker.spoken.length === 1)
    expect(speaker.summaryRequests[0]!.prompt.match(/<\/reply>/g)).toHaveLength(1)
    await ui.unmount()
  })

  test('a reply on screen cuts off another session at once and does not wait behind it', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    speaker.speakAs('session-2', 'Other session.')
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.playing() === 'Spoken: Hello.')
    expect(speaker.ended).toEqual([{ text: 'Other session.', result: 'stopped' }])
    expect(speaker.sends[0]!.queue).toBeUndefined()
    expect(speaker.sends[0]!.after_own).toBe(true)
    await ui.unmount()
  })
})

describe('reading blocks as they arrive', () => {
  test('each step with text joins the queue in order while the turn is still running', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await $.turn.start({ turnId: 't1', text: 'Go' })
    await step($, speaker, 'Looking now.')
    await speaker.until(() => speaker.playing() === 'Spoken: Looking now.')
    await showsPlace(speaker, ui, 'Message 1 of 1')
    await step($, speaker, '')
    await step($, speaker, 'Found it.')
    await speaker.until(() => speaker.sends.length === 2)
    await showsPlace(speaker, ui, 'Message 1 of 2')
    expect(speaker.summaryRequests.map(request => request.prompt)).toEqual(['<reply>\nLooking now.\n</reply>', '<reply>\nFound it.\n</reply>'])
    expect(speaker.sends.map(sent => [sent.text, sent.after_own])).toEqual([
      ['Spoken: Looking now.', true],
      ['Spoken: Found it.', true],
    ])
    speaker.end()
    await speaker.until(() => speaker.playing() === 'Spoken: Found it.')
    await showsPlace(speaker, ui, 'Message 2 of 2')
    await $.turn.complete({ ...TURN, answer: 'Found it.' })
    speaker.end()
    await showsPlace(speaker, ui, undefined)
    expect(speaker.sends).toHaveLength(2)
    expect(speaker.summaryRequests).toHaveLength(2)
    await ui.unmount()
  })

  test('a step that only calls tools adds nothing', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await step($, speaker, '')
    await step($, speaker, '  \n')
    await speaker.settle()
    expect(speaker.summaryRequests).toHaveLength(0)
    expect(speaker.urls).toHaveLength(0)
    expect(await placeShown(ui)).toBeUndefined()
    expect(await statusShown(ui)).toBeUndefined()
    await ui.unmount()
  })

  test('the end of the turn does not add its text again', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await step($, speaker, 'Done.')
    await speaker.until(() => speaker.ended.length === 1)
    await $.turn.complete({ ...TURN, answer: 'Done.' })
    await step($, speaker, 'Also done.', { turnId: 't2' })
    await speaker.until(() => speaker.ended.length === 2)
    await $.turn.complete({ ...TURN, turnId: 't2', answer: 'Different final text.' })
    await speaker.settle()
    expect(speaker.played).toEqual(['Spoken: Done.', 'Spoken: Also done.'])
    expect(speaker.summaryRequests).toHaveLength(2)
    expect(await placeShown(ui)).toBeUndefined()
    await ui.unmount()
  })

  test('Repeat says the most recent block from its saved summary, not the text the turn ended with', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await step($, speaker, 'First block.')
    await step($, speaker, 'Second block.')
    await $.turn.complete({ ...TURN, answer: 'Something else.' })
    await speaker.until(() => speaker.ended.length === 2)
    await showsNoStatus(speaker, ui)
    await ui.press({ key: 'voice-repeat' })
    await speaker.until(() => speaker.sends.length === 3)
    expect(speaker.sends[2]).toEqual({ text: 'Spoken: Second block.', voice: 'af_heart', owner: 'session-1', paused: false })
    expect(speaker.summaryRequests).toHaveLength(2)
    await ui.unmount()
  })

  test('with voice off, steps ask for no summary, and Repeat summarizes the most recent block', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await runTurn($, speaker, ['First block.', '', 'Second block.', ''])
    await speaker.settle()
    expect(speaker.summaryRequests).toHaveLength(0)
    expect(speaker.urls).toHaveLength(0)
    await ui.press({ key: 'voice-repeat' })
    await speaker.until(() => speaker.sends.length === 1)
    expect(speaker.summaryRequests.map(request => request.prompt)).toEqual(['<reply>\nSecond block.\n</reply>'])
    expect(speaker.sends[0]!.text).toBe('Spoken: Second block.')
    await ui.unmount()
  })

  test('a session not on screen holds its blocks without announcing while the turn runs, announces once when it ends, and plays them in order when opened', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    await $.turn.start({ turnId: 't1', text: 'Go' })
    await step($, speaker, 'One.')
    await step($, speaker, '')
    await step($, speaker, 'Two.')
    await speaker.until(() => speaker.summaryRequests.length === 2)
    await showsStatus(speaker, ui, STATUS_WAITING)
    await showsPlace(speaker, ui, 'Message 1 of 2')
    expect(speaker.sends).toEqual([])
    await $.turn.complete({ ...TURN, answer: 'Two.' })
    await speaker.until(() => speaker.sends.length === 1)
    await speaker.settle()
    expect(speaker.sends).toEqual([{ text: ANNOUNCEMENT, voice: 'af_heart', owner: ANNOUNCER, queue: true }])

    speaker.holds = () => true
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.until(() => speaker.sends.length === 3)
    expect(speaker.sends.slice(1).map(sent => sent.text)).toEqual(['Spoken: One.', 'Spoken: Two.'])
    speaker.end()
    await showsPlace(speaker, ui, 'Message 2 of 2')
    speaker.end()
    await showsPlace(speaker, ui, undefined)
    expect(speaker.played).toEqual([ANNOUNCEMENT, 'Spoken: One.', 'Spoken: Two.'])
    await ui.unmount()
  })

  test('opening the session mid-turn plays blocks as they arrive and does not announce at the end', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await $.turn.start({ turnId: 't1', text: 'Go' })
    await step($, speaker, 'One.')
    await speaker.until(() => speaker.summaryRequests.length === 1)
    await showsStatus(speaker, ui, STATUS_WAITING)
    expect(speaker.sends).toEqual([])
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.until(() => speaker.playing() === 'Spoken: One.')
    await step($, speaker, 'Two.')
    await speaker.until(() => speaker.sends.length === 2)
    expect(speaker.sends[1]).toEqual({ text: 'Spoken: Two.', voice: 'af_heart', owner: 'session-1', after_own: true, paused: false })
    await $.turn.complete({ ...TURN, answer: 'Two.' })
    await speaker.settle()
    expect(speaker.sends.map(sent => sent.text)).toEqual(['Spoken: One.', 'Spoken: Two.'])
    speaker.end()
    await speaker.until(() => speaker.playing() === 'Spoken: Two.')
    speaker.end()
    await showsPlace(speaker, ui, undefined)
    await ui.unmount()
  })

  test('a turn that ends off screen after everything was heard does not announce', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await $.turn.start({ turnId: 't1', text: 'Go' })
    await step($, speaker, 'One.')
    await speaker.until(() => speaker.ended.length === 1)
    speaker.surfaces = []
    await $.turn.complete({ ...TURN, answer: 'One.' })
    await speaker.settle()
    expect(speaker.sends.map(sent => sent.text)).toEqual(['Spoken: One.'])
    await ui.unmount()
  })
})

describe('the reply queue', () => {
  test('replies are spoken one after another in turn order, each sent to wait for the one before it', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurns($, speaker, ['One.', 'Two.', 'Three.'])
    await speaker.until(() => speaker.sends.length === 3)
    expect(speaker.sends.map(sent => [sent.text, sent.after_own])).toEqual([
      ['Spoken: One.', true],
      ['Spoken: Two.', true],
      ['Spoken: Three.', true],
    ])
    expect(speaker.played).toEqual(['Spoken: One.'])
    await showsPlace(speaker, ui, 'Message 1 of 3')
    await showsStatus(speaker, ui, 'Speaking')
    speaker.end()
    await showsPlace(speaker, ui, 'Message 2 of 3')
    expect(speaker.playing()).toBe('Spoken: Two.')
    speaker.end()
    await showsPlace(speaker, ui, 'Message 3 of 3')
    expect(speaker.playing()).toBe('Spoken: Three.')
    speaker.end()
    await showsPlace(speaker, ui, undefined)
    await showsNoStatus(speaker, ui)
    expect(speaker.ended.map(ended => ended.result)).toEqual(['finished', 'finished', 'finished'])
    expect(speaker.stopBodies).toEqual([])
    await ui.unmount()
  })

  test('a newer turn does not cancel an older reply still being summarized, and the older one is spoken first', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holdSummaries = 1
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurns($, speaker, ['First.', 'Second.'])
    await speaker.until(() => speaker.summaryRequests.length === 2)
    await speaker.settle()
    expect(speaker.sends).toEqual([])
    expect(speaker.summaryCancelled).toBe(false)
    await showsStatus(speaker, ui, 'Summarizing…')
    await showsPlace(speaker, ui, 'Message 1 of 2')
    speaker.releaseSummaries()
    await speaker.until(() => speaker.ended.length === 2)
    expect(speaker.played).toEqual(['Spoken: First.', 'Spoken: Second.'])
    expect(speaker.toasts).toEqual([])
    await showsNoStatus(speaker, ui)
    await ui.unmount()
  })

  test('summaries are made at the same time, and a later one that is ready first still waits its turn', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holdSummaries = 2
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurns($, speaker, ['One.', 'Two.', 'Three.'])
    await speaker.until(() => speaker.summaryRequests.length === 3 && speaker.releasers.length === 2)
    speaker.releasers[1]!()
    await speaker.settle()
    expect(speaker.sends).toEqual([])
    speaker.releasers[0]!()
    await speaker.until(() => speaker.ended.length === 3)
    expect(speaker.played).toEqual(['Spoken: One.', 'Spoken: Two.', 'Spoken: Three.'])
    await ui.unmount()
  })

  test('the label counts a reply from the moment its turn ends and starts again at 1 of 1 after the last one', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holdSummaries = 1
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'One.')
    await speaker.until(() => speaker.summaryRequests.length === 1)
    await showsPlace(speaker, ui, 'Message 1 of 1')
    await finishTurn($, speaker, 'Two.', 't2')
    await showsPlace(speaker, ui, 'Message 1 of 2')
    speaker.releaseSummaries()
    await speaker.until(() => speaker.sends.length === 2)
    await showsPlace(speaker, ui, 'Message 1 of 2')
    speaker.end()
    await showsPlace(speaker, ui, 'Message 2 of 2')
    speaker.end()
    await showsPlace(speaker, ui, undefined)
    await finishTurn($, speaker, 'Three.', 't3')
    await speaker.until(() => speaker.playing() === 'Spoken: Three.')
    await showsPlace(speaker, ui, 'Message 1 of 1')
    await ui.unmount()
  })
})

describe('skip button', () => {
  test('cuts off the reply being spoken and moves to the next one', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurns($, speaker, ['One.', 'Two.', 'Three.'])
    await speaker.until(() => speaker.sends.length === 3)
    await showsPlace(speaker, ui, 'Message 1 of 3')
    expect((await ui.find({ key: 'voice-skip' }))?.props.dimColor).toBe(false)
    await ui.press({ key: 'voice-skip' })
    await speaker.until(() => speaker.playing() === 'Spoken: Two.')
    expect(speaker.stopBodies).toEqual([{ job: 1 }])
    expect(speaker.ended).toEqual([{ text: 'Spoken: One.', result: 'stopped' }])
    await showsPlace(speaker, ui, 'Message 2 of 3')
    await showsStatus(speaker, ui, 'Speaking')
    await ui.press({ key: 'voice-skip' })
    await speaker.until(() => speaker.playing() === 'Spoken: Three.')
    await showsPlace(speaker, ui, 'Message 3 of 3')
    expect((await ui.find({ key: 'voice-skip' }))?.props.dimColor).toBe(true)
    speaker.end()
    await showsPlace(speaker, ui, undefined)
    expect(speaker.sends).toHaveLength(3)
    await ui.unmount()
  })

  test('does nothing on the last reply in the queue', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Only.')
    await speaker.until(() => speaker.playing() === 'Spoken: Only.')
    await showsPlace(speaker, ui, 'Message 1 of 1')
    await ui.press({ key: 'voice-skip' })
    await speaker.settle()
    expect(speaker.stopBodies).toEqual([])
    expect(speaker.playing()).toBe('Spoken: Only.')
    await showsPlace(speaker, ui, 'Message 1 of 1')
    await ui.unmount()
  })

  test('does nothing when the queue is empty', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await ui.press({ key: 'voice-skip' })
    await speaker.settle()
    expect(speaker.urls).toEqual([])
    expect(speaker.toasts).toEqual([])
    await ui.unmount()
  })

  test('drops a reply still being summarized, cancelling Haiku, and moves on to the next', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holdSummaries = 1
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurns($, speaker, ['One.', 'Two.'])
    await speaker.until(() => speaker.summaryRequests.length === 2)
    await showsStatus(speaker, ui, 'Summarizing…')
    await ui.press({ key: 'voice-skip' })
    await speaker.until(() => speaker.playing() === 'Spoken: Two.')
    expect(speaker.summaryCancelled).toBe(true)
    expect(speaker.spoken).toEqual(['Spoken: Two.'])
    await showsPlace(speaker, ui, 'Message 2 of 2')
    expect(speaker.toasts).toEqual([])
    await ui.unmount()
  })

  test('drops a reply whose send is still being answered, and stops just that job when the answer comes', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holdSends = 1
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurns($, speaker, ['One.', 'Two.'])
    await speaker.until(() => speaker.sends.length === 1)
    await showsStatus(speaker, ui, 'Starting voice…')
    await ui.press({ key: 'voice-skip' })
    await showsPlace(speaker, ui, 'Message 2 of 2')
    speaker.releaseSends()
    await speaker.until(() => speaker.playing() === 'Spoken: Two.')
    expect(speaker.stopBodies).toEqual([{ job: 1 }])
    expect(speaker.ended).toEqual([{ text: 'Spoken: One.', result: 'stopped' }])
    await ui.unmount()
  })
})

describe('with voice on and the session not viewed', () => {
  test('announces itself once for several replies, holds them, and plays them in order when opened', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurns($, speaker, ['One.', 'Two.', 'Three.'])
    await speaker.until(() => speaker.summaryRequests.length === 3)
    await showsStatus(speaker, ui, STATUS_WAITING)
    await showsPlace(speaker, ui, 'Message 1 of 3')
    expect(speaker.sends).toEqual([{ text: ANNOUNCEMENT, voice: 'af_heart', owner: ANNOUNCER, queue: true }])
    expect(speaker.stopBodies).toEqual([{ owner: ANNOUNCER }])

    speaker.holds = () => true
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.until(() => speaker.sends.length === 4)
    expect(speaker.sends.slice(1)).toEqual(
      ['One.', 'Two.', 'Three.'].map(text => ({ text: `Spoken: ${text}`, voice: 'af_heart', owner: 'session-1', after_own: true, paused: false })),
    )
    await showsStatus(speaker, ui, 'Speaking')
    speaker.end()
    speaker.end()
    await showsPlace(speaker, ui, 'Message 3 of 3')
    speaker.end()
    await showsPlace(speaker, ui, undefined)
    expect(speaker.played).toEqual([ANNOUNCEMENT, 'Spoken: One.', 'Spoken: Two.', 'Spoken: Three.'])
    expect(speaker.sends).toHaveLength(4)
    await ui.unmount()
  })

  test('the held queue cuts off another session when the session is opened', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await showsStatus(speaker, ui, STATUS_WAITING)
    speaker.holds = () => true
    speaker.speakAs('session-2', 'Other session.')
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.until(() => speaker.playing() === 'Spoken: Hello.')
    expect(speaker.ended.at(-1)).toEqual({ text: 'Other session.', result: 'stopped' })
    await ui.unmount()
  })

  test('an announcement that was cut off by another session is sent again, and not again once it finishes', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    speaker.holds = text => text === ANNOUNCEMENT
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.playing() === ANNOUNCEMENT)
    speaker.end('stopped')
    await speaker.until(() => speaker.sends.length === 2 && speaker.playing() === ANNOUNCEMENT)
    expect(speaker.sends[1]).toEqual({ text: ANNOUNCEMENT, voice: 'af_heart', owner: ANNOUNCER, queue: true })
    speaker.end()
    await speaker.settle()
    expect(speaker.sends).toHaveLength(2)
    await ui.unmount()
  })

  test('switching to a waiting session speaks its summary at once and drops its own announcement', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    speaker.holds = text => text === ANNOUNCEMENT
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.playing() === ANNOUNCEMENT)
    await showsStatus(speaker, ui, STATUS_WAITING)
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.until(() => speaker.ended.length === 2)
    expect(speaker.sends[1]).toEqual({ text: 'Spoken: Hello.', voice: 'af_heart', owner: 'session-1', after_own: true, paused: false })
    expect(speaker.ended).toEqual([
      { text: ANNOUNCEMENT, result: 'stopped' },
      { text: 'Spoken: Hello.', result: 'finished' },
    ])
    await speaker.settle()
    expect(speaker.sends).toHaveLength(2)
    await ui.unmount()
  })

  test('two clients attaching together speak the waiting summary once', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await showsStatus(speaker, ui, STATUS_WAITING)
    speaker.surfaces = ['desktop']
    await Promise.all([$.session.attach(ATTACH), $.session.attach({ ...ATTACH, clientId: 'desktop:two' })])
    await speaker.until(() => speaker.spoken.includes('Spoken: Hello.'))
    await speaker.settle()
    expect(speaker.spoken.filter(text => text === 'Spoken: Hello.')).toHaveLength(1)
    await ui.unmount()
  })

  test('a session viewed when the turn ends but not when the summary is ready still announces itself', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holdSummaries = 1
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.summaryRequests.length === 1)
    speaker.surfaces = []
    speaker.releaseSummaries()
    await speaker.until(() => speaker.sends.length === 1)
    expect(speaker.sends[0]).toEqual({ text: ANNOUNCEMENT, voice: 'af_heart', owner: ANNOUNCER, queue: true })
    await showsStatus(speaker, ui, STATUS_WAITING)
    await ui.unmount()
  })

  test('announces the session by its title, keeps the summary waiting, and speaks it when the session is opened', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    await $.classic.UserPromptSubmit({ prompt: 'Do it', session_title: 'Fix the login page' })
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.sends.length === 1)

    expect(speaker.sends[0]).toEqual({ text: 'Fix the login page has finished and would like to speak.', voice: 'af_heart', owner: ANNOUNCER, queue: true })
    await showsStatus(speaker, ui, STATUS_WAITING)
    expect(speaker.spoken).toHaveLength(1)

    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.until(() => speaker.sends.length === 2)
    expect(speaker.sends[1]).toEqual({ text: 'Spoken: Hello.', voice: 'af_heart', owner: 'session-1', after_own: true, paused: false })
    await showsNoStatus(speaker, ui)
    expect(speaker.summaryRequests).toHaveLength(1)

    await $.session.attach({ ...ATTACH, clientId: 'desktop:two' })
    await speaker.settle()
    expect(speaker.sends).toHaveLength(2)
    await ui.unmount()
  })

  test('takes the session name from the session start event', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    await $.classic.SessionStart({ source: 'startup', session_title: 'Weekly report' })
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.sends.length === 1)
    expect(speaker.sends[0]!.text).toBe('Weekly report has finished and would like to speak.')
    await ui.unmount()
  })

  test('uses the last folder of the working directory when there is no title', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.sends.length === 1)
    expect(speaker.sends[0]).toEqual({ text: ANNOUNCEMENT, voice: 'af_heart', owner: ANNOUNCER, queue: true })
    await ui.unmount()
  })

  test('uses the chosen voice for the announcement and for the waiting summary', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    await ui.select({ key: 'voice-pick', value: 'bm_george' })
    await finishTurn($, speaker, 'Hello.')
    await showsStatus(speaker, ui, STATUS_WAITING)
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.until(() => speaker.sends.length === 2)
    expect(speaker.sends.map(sent => sent.voice)).toEqual(['bm_george', 'bm_george'])
    await ui.unmount()
  })

  test('opening the session speaks nothing when no summary is waiting', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await $.session.attach(ATTACH)
    await speaker.settle()
    expect(speaker.urls).toHaveLength(0)
    await ui.unmount()
  })

  test('opening the session while its summary is being made ends the announcement for good', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    speaker.holdSummaries = 1
    speaker.holds = text => text === ANNOUNCEMENT
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.playing() === ANNOUNCEMENT)
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    speaker.end('stopped')
    await speaker.settle()
    expect(speaker.sends).toHaveLength(1)
    speaker.releaseSummaries()
    await speaker.until(() => speaker.sends.length === 2)
    expect(speaker.sends[1]).toEqual({ text: 'Spoken: Hello.', voice: 'af_heart', owner: 'session-1', after_own: true, paused: false })
    await ui.unmount()
  })

  test('the session is opened before the summary is ready, and the summary is spoken once it is', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    speaker.holdSummaries = 1
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.summaryRequests.length === 1)
    speaker.surfaces = ['desktop']
    speaker.releaseSummaries()
    await speaker.until(() => speaker.spoken.includes('Spoken: Hello.'))
    expect(speaker.spoken.filter(text => text === 'Spoken: Hello.')).toHaveLength(1)
    await ui.unmount()
  })
})

describe('turning voice off', () => {
  test('two presses in a row turn voice on and then off again', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await Promise.all([ui.press({ key: 'voice-toggle' }), ui.press({ key: 'voice-toggle' })])
    await speaker.settle()
    expect((await ui.find({ key: 'voice-toggle' }))?.props.label).toBe('Voice: off')
    await ui.unmount()
  })

  test('aborts a summary that is being made and tells the speaker to stop this session and its announcement', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holdSummaries = 1
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.summaryRequests.length === 1)
    await ui.press({ key: 'voice-toggle' })
    await speaker.settle()

    expect(speaker.summaryCancelled).toBe(true)
    expect(speaker.stopBodies).toEqual([{ owner: 'session-1' }, { owner: ANNOUNCER }])
    expect(speaker.spoken).toEqual([])
    expect(speaker.toasts).toEqual([])
    expect((await ui.find({ key: 'voice-toggle' }))?.props.label).toBe('Voice: off')
    expect(await placeShown(ui)).toBeUndefined()
    await turnVoiceOn(ui)
    expect(await statusShown(ui)).toBeUndefined()
    await ui.unmount()
  })

  test('clears the whole queue: the reply playing, the ones waiting at the speaker and the ones still being summarized', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurns($, speaker, ['One.', 'Two.'])
    await speaker.until(() => speaker.sends.length === 2)
    speaker.holdSummaries = 1
    await finishTurn($, speaker, 'Three.', 't3')
    await speaker.until(() => speaker.summaryRequests.length === 3)
    await showsPlace(speaker, ui, 'Message 1 of 3')
    await ui.press({ key: 'voice-toggle' })
    await speaker.settle()
    expect(speaker.summaryCancelled).toBe(true)
    expect(speaker.ended).toEqual([
      { text: 'Spoken: Two.', result: 'stopped' },
      { text: 'Spoken: One.', result: 'stopped' },
    ])
    expect(speaker.playing()).toBeUndefined()
    expect(speaker.sends).toHaveLength(2)
    expect(await placeShown(ui)).toBeUndefined()
    expect(await statusShown(ui)).toBeUndefined()
    await ui.unmount()
  })

  test('drops a waiting summary, so opening the session later speaks nothing', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await showsStatus(speaker, ui, STATUS_WAITING)
    await ui.press({ key: 'voice-toggle' })
    await turnVoiceOn(ui)
    expect(await statusShown(ui)).toBeUndefined()
    expect(await placeShown(ui)).toBeUndefined()
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.settle()
    expect(speaker.spoken).toEqual([ANNOUNCEMENT])
    expect(speaker.stopBodies).toEqual([{ owner: ANNOUNCER }, { owner: 'session-1' }, { owner: ANNOUNCER }])
    await ui.unmount()
  })

  test('cuts off speech that is playing', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'A long reply.')
    await speaker.until(() => speaker.playing() === 'Spoken: A long reply.')
    await showsStatus(speaker, ui, 'Speaking')
    await ui.press({ key: 'voice-toggle' })
    await speaker.settle()
    expect(speaker.stopBodies).toEqual([{ owner: 'session-1' }, { owner: ANNOUNCER }])
    expect(speaker.ended).toEqual([{ text: 'Spoken: A long reply.', result: 'stopped' }])
    expect(speaker.toasts).toEqual([])
    await turnVoiceOn(ui)
    expect(await statusShown(ui)).toBeUndefined()
    await ui.unmount()
  })

  test('a speaker that cannot be reached does not raise an error', async ($, on) => {
    const speaker = fakeSpeaker(on)
    const ui = await open($)
    await turnVoiceOn(ui)
    await ui.press({ key: 'voice-toggle' })
    expect(speaker.toasts).toEqual([])
    expect((await ui.find({ key: 'voice-toggle' }))?.props.label).toBe('Voice: off')
    await ui.unmount()
  })

  test('says so when config.json is not valid JSON and the speaker cannot be told to stop', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    on('fs.read', (_$, e) => (e.path.endsWith('config.json') ? { value: '{ not json' } : { deny: 'no such file' }))
    const ui = await open($)
    await turnVoiceOn(ui)
    await ui.press({ key: 'voice-toggle' })
    expect(speaker.toasts).toHaveLength(1)
    expect(speaker.toasts[0]).toMatch(/^Could not stop speaking: config\.json is not valid JSON/)
    expect(speaker.stopBodies).toEqual([])
    await ui.unmount()
  })
})

describe('when something goes wrong', () => {
  test('a failed summary falls back to the full reply and says why', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.summaryMode = 'fail'
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.toasts.length === 1)
    expect(speaker.toasts).toEqual(['Could not make a voice summary (Claude answered with code 529), so the full reply will be read'])
    expect(speaker.spoken).toEqual(['Hello.'])
    await ui.unmount()
  })

  test('a summary that times out says it took too long', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.summaryMode = 'timeout'
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.toasts.length === 1)
    expect(speaker.toasts).toEqual(['Could not make a voice summary (it took too long), so the full reply will be read'])
    expect(speaker.spoken).toEqual(['Hello.'])
    await ui.unmount()
  })

  test('says why for a rate limit and for a login problem', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.summaryMode = 'fail'
    const ui = await open($)
    await turnVoiceOn(ui)
    speaker.summaryFailure = { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit' }
    await finishTurn($, speaker, 'One.')
    await speaker.until(() => speaker.toasts.length === 1)
    await showsNoStatus(speaker, ui)
    speaker.summaryFailure = { isAnswered: false, reason: 'api-error', status: 401, error: 'auth' }
    await finishTurn($, speaker, 'Two.', 't2')
    await speaker.until(() => speaker.toasts.length === 2)
    expect(speaker.toasts).toEqual([
      'Could not make a voice summary (rate limit reached), so the full reply will be read',
      'Could not make a voice summary (you are not signed in), so the full reply will be read',
    ])
    await ui.unmount()
  })

  test('a failed summary waiting behind another reply gives its reason when its own turn to speak comes', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'One.')
    await speaker.until(() => speaker.playing() === 'Spoken: One.')
    speaker.summaryMode = 'fail'
    await finishTurn($, speaker, 'Two.', 't2')
    await speaker.until(() => speaker.sends.length === 2)
    await speaker.settle()
    expect(speaker.toasts).toEqual([])
    speaker.end()
    await speaker.until(() => speaker.toasts.length === 1)
    expect(speaker.playing()).toBe('Two.')
    await ui.unmount()
  })

  test('a failed summary on an unviewed session waits with the full reply and gives the reason when it is spoken', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    speaker.summaryMode = 'fail'
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await showsStatus(speaker, ui, STATUS_WAITING)
    expect(speaker.toasts).toEqual([])
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.until(() => speaker.sends.length === 2 && speaker.toasts.length === 1)
    expect(speaker.sends[1]!.text).toBe('Hello.')
    expect(speaker.toasts).toEqual(['Could not make a voice summary (Claude answered with code 529), so the full reply will be read'])
    await ui.unmount()
  })

  test('says why when the speaker cannot start', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.startResult = { exitCode: 1, stdout: 'port 47811 is in use by another program\n', stderr: '' }
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.toasts.length === 1)
    await showsNoStatus(speaker, ui)
    await showsPlace(speaker, ui, undefined)
    expect(speaker.toasts).toEqual(['Could not read aloud: port 47811 is in use by another program'])
    expect(speaker.starts).toHaveLength(1)
    expect(speaker.spoken).toEqual([])
    await ui.unmount()
  })

  test('reports a speech error', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.speechError = 'no output device'
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.toasts.length === 1)
    expect(speaker.toasts).toEqual(['Could not read aloud: no output device'])
    await ui.unmount()
  })

  test('says so when config.json is not valid JSON', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    on('fs.read', (_$, e) => (e.path.endsWith('config.json') ? { value: '{ not json' } : { deny: 'no such file' }))
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.toasts.length === 1)
    expect(speaker.toasts[0]).toMatch(/^Could not read aloud: config\.json is not valid JSON/)
    expect(speaker.spoken).toEqual([])
    await showsNoStatus(speaker, ui)
    await ui.unmount()
  })
})

describe('finding the project', () => {
  test('uses the folder the marketplace was added from when the add-on runs from a copy', async ($, on) => {
    const speaker = fakeSpeaker(on)
    const project = 'D:\\elsewhere\\ClaudeVoice'
    speaker.exists = path => path.startsWith(project)
    on('fs.read', (_$, e) => {
      if (e.path.endsWith('known_marketplaces.json')) {
        return { value: JSON.stringify({ 'ray-voice': { source: { source: 'directory', path: project }, installLocation: project } }) }
      }
      if (e.path === `${project}\\config.json`) return { value: '{"port": 50123, "voice": "bm_lewis"}' }
      return { deny: 'no such file' }
    })
    await $.session.start(START)
    const ui = await open($)
    expect((await ui.find({ key: 'voice-pick' }))?.props.value).toBe('bm_lewis')
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.spoken.length === 1)
    expect(speaker.toasts).toEqual([])
    expect(speaker.starts[0]![0]).toBe(`${project}\\.venv\\Scripts\\python.exe`)
    expect(speaker.urls.every(url => url.startsWith('http://127.0.0.1:50123/'))).toBe(true)
    expect(speaker.sends[0]!.voice).toBe('bm_lewis')
    await ui.unmount()
  })

  test('says so when the project folder cannot be found', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.exists = () => false
    on('fs.read', () => ({ deny: 'no such file' }))
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.toasts.length === 1)
    expect(speaker.toasts[0]).toMatch(/could not find the ClaudeVoice folder/)
    expect(speaker.starts).toHaveLength(0)
    await ui.unmount()
  })
})

describe('which reply Repeat says when a turn ends without its steps having been seen', () => {
  const toolUse = { id: 'a', tool: 'Bash', input: {} }
  const toolResult = { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'ok', isError: false }] }

  async function repeatedAfter(on: On, $: Engine, rows: unknown[], prompt: string) {
    on('session.messages', () => ({ value: rows }))
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await finishTurn($, speaker, 'Older reply.')
    await $.turn.start({ turnId: 't2', text: prompt })
    await $.turn.complete({ ...TURN, turnId: 't2', answer: '' })
    await ui.press({ key: 'voice-repeat' })
    await speaker.until(() => speaker.spoken.length === 1)
    await ui.unmount()
    return speaker.spoken
  }

  test('a turn that ends on a tool call keeps its last text, not the reply before it', async ($, on) => {
    const rows = [
      { role: 'user', text: 'First question', toolUses: [] },
      { role: 'assistant', text: 'Older reply.', toolUses: [] },
      { role: 'user', text: 'Second question', toolUses: [] },
      { role: 'assistant', text: 'Looking.', toolUses: [toolUse] },
      toolResult,
      { role: 'assistant', text: 'Newest reply.', toolUses: [{ ...toolUse, id: 'b' }] },
      { ...toolResult, toolResults: [{ tool_use_id: 'b', text: 'ok', isError: false }] },
      { role: 'assistant', text: '', toolUses: [] },
    ]
    expect(await repeatedAfter(on, $, rows, 'Second question')).toEqual(['Spoken: Newest reply.'])
  })

  test('a turn with no text at all queues nothing and keeps the reply before it', async ($, on) => {
    const rows = [
      { role: 'user', text: 'First question', toolUses: [] },
      { role: 'assistant', text: 'Older reply.', toolUses: [] },
      { role: 'user', text: 'Do it', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [] },
    ]
    on('session.messages', () => ({ value: rows }))
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await finishTurn($, speaker, 'Older reply.')
    await turnVoiceOn(ui)
    await $.turn.start({ turnId: 't2', text: 'Do it' })
    await finishTurn($, speaker, '', 't2')
    await speaker.settle()
    expect(speaker.summaryRequests).toHaveLength(0)
    expect(speaker.spoken).toEqual([])
    expect(await placeShown(ui)).toBeUndefined()
    await ui.press({ key: 'voice-repeat' })
    await speaker.until(() => speaker.spoken.length === 1)
    expect(speaker.spoken).toEqual(['Spoken: Older reply.'])
    await ui.unmount()
  })

  test('a message sent while Claude was working does not hide the text before it', async ($, on) => {
    const rows = [
      { role: 'user', text: 'First question', toolUses: [] },
      { role: 'assistant', text: 'Older reply.', toolUses: [] },
      { role: 'user', text: 'Second question', toolUses: [] },
      { role: 'assistant', text: 'Working on it.', toolUses: [toolUse] },
      toolResult,
      { role: 'user', text: 'Also check the tests', toolUses: [] },
      { role: 'user', text: '[Request interrupted by user]', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [] },
    ]
    expect(await repeatedAfter(on, $, rows, 'Second question')).toEqual(['Spoken: Working on it.'])
  })
})

describe('repeat button', () => {
  test('speaks the saved summary again without asking Haiku again, cutting off everything', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Done.')
    await speaker.until(() => speaker.ended.length === 1)
    await showsNoStatus(speaker, ui)
    speaker.holds = () => true
    speaker.speakAs('session-2', 'Other session.')
    void ui.press({ key: 'voice-repeat' })
    await speaker.until(() => speaker.sends.length === 2 && speaker.playing() === 'Spoken: Done.')
    expect(speaker.summaryRequests).toHaveLength(1)
    expect(speaker.sends[1]).toEqual({ text: 'Spoken: Done.', voice: 'af_heart', owner: 'session-1', paused: false })
    expect(speaker.ended.at(-1)).toEqual({ text: 'Other session.', result: 'stopped' })
    await showsPlace(speaker, ui, 'Message 1 of 1')
    speaker.end()
    await showsPlace(speaker, ui, undefined)
    await ui.unmount()
  })

  test('with voice off and no summary yet, summarizes the latest reply and speaks it, leaving voice off', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await finishTurn($, speaker, 'Older.')
    await finishTurn($, speaker, 'Latest.', 't2')
    await speaker.settle()
    expect(speaker.summaryRequests).toHaveLength(0)
    await ui.press({ key: 'voice-repeat' })
    await speaker.until(() => speaker.sends.length === 1)
    expect(speaker.summaryRequests).toHaveLength(1)
    expect(speaker.sends[0]!.text).toBe('Spoken: Latest.')
    expect((await ui.find({ key: 'voice-toggle' }))?.props.label).toBe('Voice: off')
    await ui.unmount()
  })

  test('with no reply yet, says so and does nothing', async ($, on) => {
    const speaker = fakeSpeaker(on)
    const ui = await open($)
    await ui.press({ key: 'voice-repeat' })
    await speaker.settle()
    expect(speaker.toasts).toEqual(['There is no reply to repeat yet'])
    expect(speaker.summaryRequests).toHaveLength(0)
    expect(speaker.sends).toHaveLength(0)
    expect(await placeShown(ui)).toBeUndefined()
    await ui.unmount()
  })

  test('clears a held queue and speaks only the latest reply as message 1 of 1', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurns($, speaker, ['One.', 'Two.'])
    await speaker.until(() => speaker.summaryRequests.length === 2)
    await showsStatus(speaker, ui, STATUS_WAITING)
    await showsPlace(speaker, ui, 'Message 1 of 2')
    expect(await label(ui, 'voice-repeat')).toBe('Repeat')
    speaker.holds = () => true
    speaker.surfaces = ['desktop']
    void ui.press({ key: 'voice-repeat' })
    await speaker.until(() => speaker.playing() === 'Spoken: Two.')
    await showsPlace(speaker, ui, 'Message 1 of 1')
    expect(speaker.summaryRequests).toHaveLength(2)
    expect(speaker.sends.map(sent => sent.text)).toEqual([ANNOUNCEMENT, 'Spoken: Two.'])
    expect(speaker.sends[1]).toEqual({ text: 'Spoken: Two.', voice: 'af_heart', owner: 'session-1', paused: false })
    await $.session.attach(ATTACH)
    await speaker.settle()
    expect(speaker.sends).toHaveLength(2)
    speaker.end()
    await showsPlace(speaker, ui, undefined)
    await ui.unmount()
  })

  test('a reply that ends during a repeat joins the same window after it', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'One.')
    await speaker.until(() => speaker.playing() === 'Spoken: One.')
    speaker.end()
    await showsPlace(speaker, ui, undefined)
    void ui.press({ key: 'voice-repeat' })
    await speaker.until(() => speaker.sends.length === 2)
    await finishTurn($, speaker, 'Two.', 't2')
    await speaker.until(() => speaker.sends.length === 3)
    await showsPlace(speaker, ui, 'Message 1 of 2')
    expect(speaker.playing()).toBe('Spoken: One.')
    speaker.end()
    await speaker.until(() => speaker.playing() === 'Spoken: Two.')
    await showsPlace(speaker, ui, 'Message 2 of 2')
    await ui.unmount()
  })

  test('becomes Stop while summarizing, and Stop cancels Haiku and the speech without turning voice on', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holdSummaries = 1
    const ui = await open($)
    await finishTurn($, speaker, 'Hello.')
    void ui.press({ key: 'voice-repeat' })
    await speaker.until(() => speaker.summaryRequests.length === 1)
    expect(await label(ui, 'voice-repeat')).toBe('Stop')
    await ui.press({ key: 'voice-repeat' })
    await speaker.settle()
    expect(speaker.summaryCancelled).toBe(true)
    expect(speaker.stopBodies).toContainEqual({ owner: 'session-1' })
    expect(speaker.sends).toHaveLength(0)
    expect(await label(ui, 'voice-repeat')).toBe('Repeat')
    expect(await placeShown(ui)).toBeUndefined()
    expect((await ui.find({ key: 'voice-toggle' }))?.props.label).toBe('Voice: off')
    await ui.unmount()
  })

  test('Stop while speaking silences the session, clears the queue and leaves voice on', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurns($, speaker, ['A long reply.', 'Another.'])
    await speaker.until(() => speaker.sends.length === 2)
    await showsStatus(speaker, ui, 'Speaking')
    await showsPlace(speaker, ui, 'Message 1 of 2')
    expect(await label(ui, 'voice-repeat')).toBe('Stop')
    await ui.press({ key: 'voice-repeat' })
    await speaker.settle()
    expect(speaker.stopBodies).toEqual([{ owner: 'session-1' }, { owner: ANNOUNCER }])
    expect(speaker.playing()).toBeUndefined()
    expect(speaker.ended.map(ended => ended.result)).toEqual(['stopped', 'stopped'])
    expect(await statusShown(ui)).toBeUndefined()
    expect(await placeShown(ui)).toBeUndefined()
    expect(await label(ui, 'voice-repeat')).toBe('Repeat')
    expect((await ui.find({ key: 'voice-toggle' }))?.props.label).toBe('Voice: on')
    await finishTurn($, speaker, 'Next.', 't3')
    await speaker.until(() => speaker.playing() === 'Spoken: Next.')
    await showsPlace(speaker, ui, 'Message 1 of 1')
    await ui.unmount()
  })

  test('Stop while the voice is starting leaves the row idle and stops just that job once the held request returns', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holdSends = 1
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.sends.length === 1)
    await showsStatus(speaker, ui, 'Starting voice…')
    await ui.press({ key: 'voice-repeat' })
    speaker.speakAs('session-2', 'Other session.')
    speaker.releaseSends()
    await speaker.until(() => speaker.stopBodies.length === 3)
    await speaker.settle()
    expect(speaker.stopBodies).toEqual([{ owner: 'session-1' }, { owner: ANNOUNCER }, { job: 1 }])
    expect(speaker.playing()).toBe('Other session.')
    expect(await statusShown(ui)).toBeUndefined()
    expect(await label(ui, 'voice-repeat')).toBe('Repeat')
    expect((await ui.find({ key: 'voice-toggle' }))?.props.label).toBe('Voice: on')
    await ui.unmount()
  })
})

describe('version label', () => {
  test('shows the loaded version from the manifest after the session starts', async ($, on) => {
    const speaker = fakeSpeaker(on)
    on('fs.read', (_$, e) => (e.path.endsWith('plugin.json') ? { value: '{"name": "read-aloud", "version": "9.8.7"}' } : { deny: 'no such file' }))
    const ui = await open($)
    expect(await ui.find({ text: 'read-aloud' })).toBeDefined()
    await $.session.start(START)
    await speaker.settle()
    await ui.redraw()
    expect(await ui.find({ text: 'read-aloud v9.8.7' })).toBeDefined()
    await ui.unmount()
  })
})

describe('reply stripe', () => {
  test('draws what the app draws for each reply beside a colored stripe, on desktop and terminal', async ($, on) => {
    on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
      const { Markdown } = $.ui.resolve(e)
      return <Markdown text={e.props.text} />
    })
    for (const surface of ['desktop', 'terminal'] as const) {
      const ui = await $.ui.mount({
        plugin: 'read-aloud',
        surface,
        component: 'AssistantMessage',
        props: { text: 'Hello **there**.', isFirstOfReply: true },
      })
      const drawn = JSON.stringify(await ui.drawn())
      expect(drawn).toContain('"backgroundColor":"#1BA9C4"')
      expect(drawn).toContain('"type":"Markdown"')
      expect(drawn).toContain('Hello **there**.')
      await ui.unmount()
    }
  })
})

describe('catching up on a session with many held blocks', () => {
  test('more than three held blocks play as one catch-up made from all of them', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurns($, speaker, ['One?', 'Two.', 'Three.', 'Four.'])
    await speaker.until(() => speaker.summaryRequests.length === 4)
    await showsPlace(speaker, ui, 'Message 1 of 4')

    speaker.holds = () => true
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.until(() => speaker.sends.length === 2)
    const catchUp = speaker.summaryRequests[4]!
    expect(catchUp.system).toContain('catches the person up')
    expect(catchUp.system).toContain('a question that a later piece answers')
    for (const [i, text] of ['One?', 'Two.', 'Three.', 'Four.'].entries()) expect(catchUp.prompt).toContain(`<reply ${i + 1}>\n${text}\n</reply>`)
    expect(speaker.sends[1]).toEqual({ text: `Spoken: ${catchUp.prompt.replace(/\n<\/reply>$/, '')}`, voice: 'af_heart', owner: 'session-1', after_own: true, paused: false })
    await showsPlace(speaker, ui, 'Message 1 of 1')
    speaker.end()
    await showsPlace(speaker, ui, undefined)
    await speaker.settle()
    expect(speaker.sends).toHaveLength(2)
    await ui.unmount()
  })

  test('a catch-up labels thinking blocks as thinking', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    await step($, speaker, 'One.', { thought: 'Hmm.' })
    await finishTurns($, speaker, ['Two.', 'Three.'])
    await speaker.until(() => speaker.summaryRequests.length === 4)
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.until(() => speaker.summaryRequests.length === 5)
    expect(speaker.summaryRequests[4]!.prompt).toContain('<thinking 1>\nHmm.\n</thinking>')
    expect(speaker.summaryRequests[4]!.prompt).toContain('<reply 2>\nOne.\n</reply>')
    await ui.unmount()
  })

  test('opening the session while the first block is still being summarized plays the catch-up for all blocks', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    speaker.holdSummaries = 1
    await finishTurns($, speaker, ['One.', 'Two.', 'Three.', 'Four.'])
    await speaker.until(() => speaker.summaryRequests.length === 4)
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await showsStatus(speaker, ui, 'Summarizing…')
    speaker.releaseSummaries()
    await speaker.until(() => speaker.sends.length === 2)
    expect(speaker.sends[1]!.text).toContain('<reply 4>')
    expect(speaker.records[1]).toMatchObject({ kind: 'catch-up', summary: 'haiku' })
    expect(speaker.records[1]!.original).toHaveLength(4)
    await ui.unmount()
  })

  test('another client attaching to a session already on screen does not combine its pending blocks', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = ['desktop']
    const ui = await open($)
    await turnVoiceOn(ui)
    speaker.holdSummaries = 1
    await finishTurns($, speaker, ['One.', 'Two.', 'Three.', 'Four.'])
    await speaker.until(() => speaker.summaryRequests.length === 4)
    await speaker.settle()
    await $.session.attach(ATTACH)
    await speaker.settle()
    expect(speaker.summaryRequests).toHaveLength(4)
    speaker.releaseSummaries()
    await speaker.until(() => speaker.sends.length === 4)
    expect(speaker.records.map(record => record.kind)).toEqual(['reply', 'reply', 'reply', 'reply'])
    await ui.unmount()
  })

  test('opening the session while a block waits to learn if it is viewed still plays the catch-up, and says so in the record', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    let release!: () => void
    speaker.surfaceGate = new Promise<void>(resolve => (release = resolve))
    for (const answer of ['One.', 'Two.', 'Three.', 'Four.']) await step($, speaker, answer)
    await speaker.until(() => speaker.summaryRequests.length === 4 && speaker.surfaceCalls > 0)
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.until(() => speaker.summaryRequests.length === 5)
    release()
    await speaker.until(() => speaker.sends.length === 1)
    await speaker.settle()
    expect(speaker.sends).toHaveLength(1)
    expect(speaker.sends[0]!.text).toContain('<reply 4>')
    expect(speaker.records[0]).toMatchObject({ kind: 'catch-up', summary: 'haiku' })
    expect(speaker.records[0]!.original).toHaveLength(4)
    await ui.unmount()
  })

  test('stopping cancels the requests of blocks folded into a catch-up as well as the catch-up', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    speaker.holdSummaries = 5
    for (const answer of ['One.', 'Two.', 'Three.', 'Four.']) await step($, speaker, answer)
    await speaker.until(() => speaker.summaryRequests.length === 4)
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.until(() => speaker.summaryRequests.length === 5)
    await ui.press({ key: 'voice-toggle' })
    await speaker.settle()
    expect(speaker.cancelledCount).toBe(5)
    expect(speaker.sends).toHaveLength(0)
    await ui.unmount()
  })

  test('the row says Summarizing while the catch-up is being made', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurns($, speaker, ['One.', 'Two.', 'Three.', 'Four.'])
    await speaker.until(() => speaker.summaryRequests.length === 4)
    speaker.holdSummaries = 1
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.until(() => speaker.summaryRequests.length === 5)
    await showsStatus(speaker, ui, 'Summarizing…')
    speaker.releaseSummaries()
    await ui.unmount()
  })

  test('when the catch-up cannot be made, a message says so', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurns($, speaker, ['One.', 'Two.', 'Three.', 'Four.'])
    await speaker.until(() => speaker.summaryRequests.length === 4)
    speaker.summaryMode = 'fail'
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.until(() => speaker.sends.length === 2)
    await speaker.until(() => speaker.toasts.length > 0)
    expect(speaker.toasts[0]).toContain('Could not make a catch-up summary (Claude answered with code 529)')
    await ui.unmount()
  })

  test('when the catch-up cannot be made, the separate summaries play back to back as one', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurns($, speaker, ['One.', 'Two.', 'Three.', 'Four.'])
    await speaker.until(() => speaker.summaryRequests.length === 4)
    speaker.summaryMode = 'fail'
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.settle()
    await speaker.until(() => speaker.sends.length === 2)
    expect(speaker.sends[1]!.text).toBe(['One.', 'Two.', 'Three.', 'Four.'].map(text => `Spoken: ${text}`).join('\n\n'))
    await ui.unmount()
  })
})

describe('a summary that runs away', () => {
  test('a summary far longer than its block is replaced by the block itself', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    const block = 'A'.repeat(250) + '.'
    speaker.summaryMode = 'long'
    await finishTurn($, speaker, block)
    await speaker.until(() => speaker.sends.length === 1)
    expect(speaker.sends[0]!.text).toBe(block)
    expect(speaker.summaryRequests[0]!.system).toContain('Write the script once, in the first person, with nothing before or after it')
    await ui.unmount()
  })
})

describe('point of view', () => {
  test('the instructions make Haiku speak as the assistant, never about it', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.summaryRequests.length === 1)
    const rules = speaker.summaryRequests[0]!.system
    expect(rules).toContain('You are the speaking voice of a coding assistant.')
    expect(rules).toContain('Never call the assistant "the assistant", "the agent"')
    await ui.unmount()
  })
})

describe('reading thinking', () => {
  test('a step with thinking and a reply queues the thinking first, then the reply', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await step($, speaker, 'The reply.', { thought: 'My thinking.' })
    await speaker.until(() => speaker.sends.length === 2)
    expect(speaker.sends.map(sent => sent.text)).toEqual(['Spoken: My thinking.', 'Spoken: The reply.'])
    expect(speaker.summaryRequests[0]!.system).toContain("Sometimes you are given the assistant's thinking")
    expect(speaker.summaryRequests[0]!.system).toContain('"Gradle 8.9" becomes "Gradle 8 point 9"')
    await ui.unmount()
  })

  test('thinking is sent in thinking tags and a reply in reply tags', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await step($, speaker, 'The reply.', { thought: 'My thinking.' })
    await speaker.until(() => speaker.summaryRequests.length === 2)
    expect(speaker.summaryRequests.map(request => request.prompt)).toEqual([
      '<thinking>\nMy thinking.\n</thinking>',
      '<reply>\nThe reply.\n</reply>',
    ])
    expect(speaker.summaryRequests[0]!.system).toContain('<thinking> tags')
    await ui.unmount()
  })

  test('a step with only thinking is still read', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await step($, speaker, '', { thought: 'Only thinking here.' })
    await speaker.until(() => speaker.sends.length === 1)
    expect(speaker.sends[0]!.text).toBe('Spoken: Only thinking here.')
    await ui.unmount()
  })

  test('a subagent step does not read its thinking', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await step($, speaker, '', { thought: 'Subagent thinking.', agentId: 'helper' })
    await speaker.settle()
    expect(speaker.sends).toEqual([])
    await ui.unmount()
  })
})

describe('what is sent with each speech for the spoken log', () => {
  const ABOUT = { session: 'session-1', sessionName: 'MyProject' }

  test('thinking and reply blocks carry their turn, step, the tool call ids of that step, the original text and how it was made', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await $.turn.start({ turnId: 't1', text: 'Go' })
    await step($, speaker, 'The reply.', { thought: 'My thinking.', tools: ['toolu_a', 'toolu_b'] })
    await step($, speaker, 'Second reply.')
    await speaker.until(() => speaker.records.length === 3)
    expect(speaker.records).toEqual([
      { ...ABOUT, kind: 'thinking', turnId: 't1', step: 0, toolUseIds: ['toolu_a', 'toolu_b'], original: 'My thinking.', summary: 'haiku' },
      { ...ABOUT, kind: 'reply', turnId: 't1', step: 0, toolUseIds: ['toolu_a', 'toolu_b'], original: 'The reply.', summary: 'haiku' },
      { ...ABOUT, kind: 'reply', turnId: 't1', step: 1, toolUseIds: [], original: 'Second reply.', summary: 'haiku' },
    ])
    await $.turn.complete({ ...TURN, answer: 'Second reply.' })
    await speaker.settle()
    expect(speaker.writes).toEqual([])
    await ui.unmount()
  })

  test('a block read in full says why, and a runaway summary says it was replaced', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    speaker.summaryMode = 'fail'
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.ended.length === 1)
    speaker.summaryMode = 'long'
    const block = 'A'.repeat(250) + '.'
    await finishTurn($, speaker, block, 't2')
    await speaker.until(() => speaker.records.length === 2)
    expect(speaker.records).toEqual([
      { ...ABOUT, kind: 'reply', turnId: 't1', step: 0, toolUseIds: [], original: 'Hello.', summary: 'full-text', reason: 'Claude answered with code 529' },
      { ...ABOUT, kind: 'reply', turnId: 't2', step: 0, toolUseIds: [], original: block, summary: 'runaway' },
    ])
    await ui.unmount()
  })

  test('the announcement and Repeat say what they are', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'One.')
    await speaker.until(() => speaker.sends.length === 1)
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.until(() => speaker.ended.length === 2)
    await showsNoStatus(speaker, ui)
    await ui.press({ key: 'voice-repeat' })
    await speaker.until(() => speaker.sends.length === 3)
    expect(speaker.records).toEqual([
      { ...ABOUT, kind: 'announcement' },
      { ...ABOUT, kind: 'reply', turnId: 't1', step: 0, toolUseIds: [], original: 'One.', summary: 'haiku' },
      { ...ABOUT, kind: 'repeat', original: 'One.', summary: 'saved' },
    ])
    await ui.unmount()
  })

  const HELD = [
    { turnId: 't1', answer: 'One?', tools: [] },
    { turnId: 't2', answer: 'Two.', tools: ['toolu_2'] },
    { turnId: 't3', answer: 'Three.', tools: [] },
    { turnId: 't4', answer: 'Four.', tools: ['toolu_4a', 'toolu_4b'] },
  ]
  const COMBINED = HELD.map(({ turnId, answer, tools }, i) => ({ kind: 'reply', turnId, step: 0, toolUseIds: tools, original: answer }))

  async function catchUpRecord($: Engine, on: On, summaryMode: Speaker['summaryMode']) {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.surfaces = []
    const ui = await open($)
    await turnVoiceOn(ui)
    for (const { turnId, answer, tools } of HELD) {
      await step($, speaker, answer, { turnId, tools })
      await $.turn.complete({ ...TURN, turnId, answer })
    }
    await speaker.until(() => speaker.summaryRequests.length === 4)
    speaker.summaryMode = summaryMode
    speaker.surfaces = ['desktop']
    await $.session.attach(ATTACH)
    await speaker.until(() => speaker.records.length === 2)
    await ui.unmount()
    return speaker.records[1]
  }

  test('a catch-up lists every block it was made from', async ($, on) => {
    expect(await catchUpRecord($, on, 'answer')).toEqual({ ...ABOUT, kind: 'catch-up', original: COMBINED, summary: 'haiku' })
  })

  test('a catch-up that could not be made says the separate summaries were joined, and why', async ($, on) => {
    expect(await catchUpRecord($, on, 'fail')).toEqual({
      ...ABOUT,
      kind: 'catch-up',
      original: COMBINED,
      summary: 'separate',
      reason: 'Claude answered with code 529',
    })
  })
})

describe('pause and resume', () => {
  test('Pause sets the session aside and Resume carries on, with the row showing which', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.playing() === 'Spoken: Hello.')
    await showsStatus(speaker, ui, 'Speaking')
    expect(await ui.find({ key: 'voice-pause' })).toMatchObject({ props: { label: 'Pause', dimColor: false } })
    await ui.press({ key: 'voice-pause' })
    await speaker.settle()
    expect(speaker.pauseCalls).toEqual(['pause session-1'])
    expect(speaker.playing()).toBeUndefined()
    await showsStatus(speaker, ui, 'Paused')
    expect(await label(ui, 'voice-pause')).toBe('Resume')
    expect(await label(ui, 'voice-repeat')).toBe('Stop')
    await ui.press({ key: 'voice-pause' })
    await speaker.settle()
    expect(speaker.pauseCalls).toEqual(['pause session-1', 'resume session-1'])
    expect(speaker.playing()).toBe('Spoken: Hello.')
    await showsStatus(speaker, ui, 'Speaking')
    expect(await label(ui, 'voice-pause')).toBe('Pause')
    speaker.end()
    await speaker.until(() => speaker.ended.length === 1)
    await showsNoStatus(speaker, ui)
    expect(speaker.toasts).toEqual([])
    await ui.unmount()
  })

  test('the row is not written again when its status and place have not changed', async ($, on) => {
    let draws = 0
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      draws += 1
      return next(e)
    })
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurns($, speaker, ['One.', 'Two.'])
    await speaker.until(() => speaker.playing() === 'Spoken: One.')
    await showsStatus(speaker, ui, 'Speaking')
    await showsPlace(speaker, ui, 'Message 1 of 2')
    const drawn = await ui.redraw().then(() => draws)
    await $.session.attach(ATTACH)
    await speaker.settle()
    await ui.redraw()
    expect(draws - drawn).toBeLessThanOrEqual(1)
    speaker.end()
    await showsPlace(speaker, ui, 'Message 2 of 2')
    await ui.unmount()
  })

  test('Pause is dimmed and does nothing while the session has nothing to say', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    const ui = await open($)
    await turnVoiceOn(ui)
    expect(await ui.find({ key: 'voice-pause' })).toMatchObject({ props: { label: 'Pause', dimColor: true } })
    await ui.press({ key: 'voice-pause' })
    await speaker.settle()
    expect(speaker.pauseCalls).toEqual([])
    await ui.unmount()
  })

  test('while paused, Skip moves to the next block and stays paused', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurns($, speaker, ['One.', 'Two.'])
    await speaker.until(() => speaker.sends.length === 2)
    await ui.press({ key: 'voice-pause' })
    await speaker.settle()
    await ui.press({ key: 'voice-skip' })
    await speaker.until(() => speaker.ended.length === 1)
    await showsPlace(speaker, ui, 'Message 2 of 2')
    await showsStatus(speaker, ui, 'Paused')
    expect(speaker.playing()).toBeUndefined()
    await ui.press({ key: 'voice-pause' })
    await speaker.until(() => speaker.playing() === 'Spoken: Two.')
    await ui.unmount()
  })

  test('Stop while paused ends the pause along with the speech', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.playing() === 'Spoken: Hello.')
    await ui.press({ key: 'voice-pause' })
    await speaker.settle()
    await ui.press({ key: 'voice-repeat' })
    await speaker.until(() => speaker.ended.length === 1)
    await showsNoStatus(speaker, ui)
    expect(await label(ui, 'voice-pause')).toBe('Pause')
    await finishTurn($, speaker, 'Next.', 't2')
    await speaker.until(() => speaker.playing() === 'Spoken: Next.')
    await ui.unmount()
  })

  test('a paused session that is left does not announce itself when more blocks arrive', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.playing() === 'Spoken: Hello.')
    await ui.press({ key: 'voice-pause' })
    await speaker.settle()
    speaker.surfaces = []
    await finishTurn($, speaker, 'More.', 't2')
    await speaker.settle()
    expect(speaker.spoken).not.toContain(ANNOUNCEMENT)
    await ui.unmount()
  })

  test('every send says whether the session is paused', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'One.')
    await speaker.until(() => speaker.playing() === 'Spoken: One.')
    await ui.press({ key: 'voice-pause' })
    await speaker.settle()
    await finishTurn($, speaker, 'Two.', 't2')
    await speaker.until(() => speaker.sends.length === 2)
    expect(speaker.sends.map(sent => sent.paused)).toEqual([false, true])
    expect(speaker.pauseCalls).toEqual(['pause session-1'])
    expect(speaker.playing()).toBeUndefined()
    await ui.unmount()
  })

  test('Resume pressed while a block is being sent is not undone by that block', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'One.')
    await speaker.until(() => speaker.playing() === 'Spoken: One.')
    await ui.press({ key: 'voice-pause' })
    await speaker.settle()
    speaker.holdSends = 1
    await finishTurn($, speaker, 'Two.', 't2')
    await speaker.until(() => speaker.sends.length === 2)
    await ui.press({ key: 'voice-pause' })
    await speaker.settle()
    speaker.releaseSends()
    await speaker.until(() => speaker.playing() === 'Spoken: One.')
    await showsStatus(speaker, ui, 'Speaking')
    expect(await label(ui, 'voice-pause')).toBe('Pause')
    await ui.unmount()
  })

  test('when the speaker cannot pause, the row does not say Paused', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    speaker.pauseFails = true
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.playing() === 'Spoken: Hello.')
    await ui.press({ key: 'voice-pause' })
    await speaker.settle()
    expect(speaker.toasts.length).toBe(1)
    await showsStatus(speaker, ui, 'Speaking')
    expect(await label(ui, 'voice-pause')).toBe('Pause')
    expect(speaker.playing()).toBe('Spoken: Hello.')
    await ui.unmount()
  })

  test('a wait that comes back still waiting is asked again', async ($, on) => {
    const speaker = fakeSpeaker(on)
    speaker.isRunning = true
    speaker.holds = () => true
    speaker.waitingAnswers = 2
    const ui = await open($)
    await turnVoiceOn(ui)
    await finishTurn($, speaker, 'Hello.')
    await speaker.until(() => speaker.playing() === 'Spoken: Hello.' && speaker.waitingAnswers === 0)
    await showsStatus(speaker, ui, 'Speaking')
    speaker.end()
    await speaker.until(() => speaker.ended.length === 1)
    await showsNoStatus(speaker, ui)
    expect(speaker.toasts).toEqual([])
    await ui.unmount()
  })
})
