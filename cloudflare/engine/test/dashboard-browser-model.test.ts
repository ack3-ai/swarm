import { readFileSync } from 'node:fs'
import { runInNewContext, Script } from 'node:vm'
import { describe, expect, it } from 'vitest'

const html = readFileSync(new URL('../src/dashboard.html', import.meta.url), 'utf8')
const script = html.match(/<script nonce="__CSP_NONCE__">([\s\S]*?)<\/script>/)![1]!
const functions = script.split(/document\.addEventListener\(\s*["']click/)[0]!
const evaluate = (expression: string): unknown => runInNewContext(`${functions}\n${expression}`, {})
describe('container observation incidents', () => {
  const fixture = `
    const task={taskId:'research-2',agentId:'luna-2',model:'luna',provider:'codex',role:'researcher',
      modelPool:'luna',promptKind:'research',status:'awaiting-result',lastAttempt:1,usage:{},provisionalUsage:{}};
    const wave={stageId:'discovery',id:'luna/wave-4',sourceWaveId:'wave-4',tasks:[task]};
    const health={runId:'run-1',stageId:'discovery',waveId:'wave-4',taskId:'research-2',attempt:1,
      status:'unresolved',lastSuccessfulProcessAt:'2026-10-07T00:10:00Z',nextObservationAfter:'2026-10-07T00:25:00Z'};
    snapshot={run:{id:'run-1'},waves:[wave],observationHealth:[health]};
  `
  it('shows the exact incident consistently in its card and pool wave without an activity stripe', () => {
    const result = evaluate(`${fixture} ({card:laneCard(task,key(wave)),pool:poolProgressMarkup([wave])});`) as any
    expect(result.card).toContain('Container unresponsive')
    expect(result.card).toContain('Process last confirmed')
    expect(result.card).toContain('Next check')
    expect(result.card).not.toContain('bar live')
    expect(result.pool).toContain('1 unresponsive')
    expect(result.pool).not.toContain('1 awaiting result')
  })
  it('does not borrow incident evidence from another run, stage, source wave, task or attempt', () => {
    for (const change of [{runId:'run-2'},{stageId:'review'},{waveId:'wave-3'},{taskId:'research-1'},{attempt:2}]) {
      expect(evaluate(`${fixture} Object.assign(health,${JSON.stringify(change)});visibleTaskStatus(task,wave);`))
        .toBe('awaiting-result')
    }
  })
  it('accepted results supersede old incidents and missing evidence does not imply unresponsiveness', () => {
    expect(evaluate(`${fixture} task.status='accepted';visibleTaskStatus(task,wave);`)).toBe('accepted')
    for (const status of ['unknown','watching','observing']) {
      expect(evaluate(`${fixture} health.status='${status}';visibleTaskStatus(task,wave);`)).toBe('awaiting-result')
    }
    expect(evaluate(`${fixture} delete snapshot.observationHealth;visibleTaskStatus(task,wave);`)).toBe('awaiting-result')
  })
})
describe('readable agent transcript', () => {
  const transcript = (events: unknown[], complete = true) => evaluate(`
    const state=newAgentTranscript(); appendAgentTranscript(state,${JSON.stringify(events)},${complete});
    ({state,html:agentTranscriptMarkup(state)});`) as any
  const event = (value: unknown, stream = 'stdout') => ({ at: '2026-09-26T20:00:00Z', stream, text: JSON.stringify(value) + '\n' })

  it('shows Claude text and paired MCP calls through the existing transcript view', () => {
    const { state } = transcript([
      event({ type: 'assistant', message: { content: [
        { type: 'text', text: 'Checking the source.' },
        { type: 'tool_use', id: 'exa-1', name: 'mcp__exa__web_search_exa', input: { query: 'public question' } },
      ] } }),
      event({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'exa-1', content: [{ type: 'text', text: 'Public evidence' }] },
      ] } }),
    ])
    expect(state.entries).toHaveLength(2)
    expect(state.entries[0]).toMatchObject({ kind: 'message', text: 'Checking the source.' })
    expect(state.entries[1]).toMatchObject({ kind: 'tool', searchTool: true, output: 'Public evidence', status: 'completed' })
  })

  it('reassembles native JSON across pages and interleaved stderr without exposing its envelope', () => {
    const text = JSON.stringify({ type: 'thinking', text: 'Inspect the boundary.\nThen compare the callers.' }) + '\n'
    const result = evaluate(`const state=newAgentTranscript();
      appendAgentTranscript(state,[${JSON.stringify({ at: '2026-09-26T20:00:00Z', stream: 'stdout', text: text.slice(0, 25) })}]);
      appendAgentTranscript(state,[${JSON.stringify({ at: '2026-09-26T20:00:01Z', stream: 'stderr', text: 'Waiting for upstream\n' })}]);
      appendAgentTranscript(state,[${JSON.stringify({ at: '2026-09-26T20:00:02Z', stream: 'stdout', text: text.slice(25) })}]);
      state;`) as any
    expect(result.entries).toHaveLength(2)
    expect(result.entries[1]).toMatchObject({ title: 'Reasoning', text: 'Inspect the boundary.\nThen compare the callers.', at: '2026-09-26T20:00:00Z' })
  })

  it('shows DSH messages, tool inputs/results and quota errors as readable entries', () => {
    const { state, html } = transcript([
      event({ type: 'text', text: 'Reading the entry point.' }),
      event({ type: 'tool_call', tool: 'read', input: { file_path: 'source.sol', offset: 12 } }),
      event({ type: 'tool_result', status: 'completed', result: 'first line\nsecond line', truncated: true }),
      event({ type: 'status', phase: 'turn_end', reason: { error: { code: 'QUOTA', status: 402 } } }),
    ])
    expect(state.entries.map((entry: any) => entry.title)).toEqual(['Agent message', 'Tool · read', 'Tool result', 'Execution error'])
    expect(html).toContain('file_path: source.sol\noffset: 12')
    expect(html).toContain('first line\nsecond line\n[Truncated by the harness]')
    expect(html).not.toContain('"type": "tool_result"')
    expect(state.entries[3].folded).toBe(false)
  })

  it('updates Codex tool activity in place and renders untrusted output as text', () => {
    const { state, html } = transcript([
      event({ type: 'item.started', item: { id: 'tool1', type: 'command_execution', command: 'rg example', aggregated_output: '', status: 'in_progress' } }),
      event({ type: 'item.completed', item: { id: 'tool1', type: 'command_execution', command: 'rg example', aggregated_output: '<img src=x onerror=alert(1)>', exit_code: 0, status: 'completed' } }),
      event({ type: 'item.completed', item: { id: 'message1', type: 'agent_message', text: '</pre><script>alert(1)</script>' } }),
    ])
    expect(state.entries).toHaveLength(2)
    expect(state.entries[0]).toMatchObject({ title: 'Command', status: 'completed', exitCode: 0 })
    expect(html).toContain('completed · exit 0')
    expect(html).toContain('&lt;img')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script>')
  })

  it('preserves unfamiliar events and flushes an unterminated final entry only when complete', () => {
    const { state, html } = transcript([
      event({ type: 'future-event', detail: 'Keep this visible' }),
      { at: null, stream: 'stderr', text: '\u001b[31mplain diagnostic\u001b[0m' },
    ])
    expect(state.entries[0].text).toContain('Keep this visible')
    expect(state.entries[1].text).toBe('plain diagnostic')
    const pending = transcript([{ stream: 'stdout', at: null, text: '{"type":"final","text":"done"}' }], false)
    expect(pending.state.entries).toHaveLength(0)
    expect(pending.state.pending.stdout.text).toContain('done')
  })

  it('joins interleaved tool results across pages by call ID and retains failures', () => {
    const result = evaluate(`const state=newAgentTranscript();
      appendAgentTranscript(state,${JSON.stringify([
        event({ type: 'tool_call', callId: 'a', tool: 'read', input: { path: 'a.txt' } }),
        event({ type: 'tool_call', callId: 'b', tool: 'read', input: { path: 'b.txt' } }),
      ])});
      appendAgentTranscript(state,${JSON.stringify([
        { ...event({ type: 'tool_result', callId: 'b', status: 'completed', result: 'B contents' }), at: '2026-09-26T20:00:05Z' },
        { ...event({ type: 'tool_result', callId: 'a', status: 'error', result: 'A failed' }), at: '2026-09-26T20:00:10Z' },
      ])});
      ({state,tools:transcriptEntries(state,'tools'),filtered:transcriptEntries(state,'diagnostics'),html:agentTranscriptMarkup(state)});`) as any
    expect(result.state.entries).toHaveLength(2)
    expect(result.state.entries[0]).toMatchObject({ command: 'path: a.txt', output: 'A failed', kind: 'error', at: '2026-09-26T20:00:00Z' })
    expect(result.state.entries[1]).toMatchObject({ command: 'path: b.txt', output: 'B contents' })
    expect(result.tools).toHaveLength(2)
    expect(result.filtered).toHaveLength(1)
    expect(result.html).toContain('error · 10s')
  })

  it.each([
    { fetch: 'web_fetch', search: 'web_search' },
    { fetch: 'mcp__exa__web_fetch_exa', search: 'mcp__exa__web_search_exa' },
  ])('shows native search calls, credit errors and timeouts without counting pending calls as completed: %j', ({ fetch, search }) => {
    const rows = [
      event({ type: 'item.started', item: { id: 'search', type: 'mcp_tool_call', server: 'exa', tool: 'web_search_exa', arguments: { query: '<script>query</script>' }, status: 'in_progress', result: null } }),
      event({ type: 'tool_call', callId: 'fetch', tool: fetch, input: { url: 'https://example.com/source' } }),
      event({ type: 'tool_result', callId: 'fetch', status: 'completed', result: 'Source contents' }),
      event({ type: 'tool_call', callId: 'credit', tool: search, input: { query: 'credits' } }),
      event({ type: 'tool_result', callId: 'credit', status: 'completed', result: 'Error: WEB_PROVIDER_ERROR HTTP 402: exhausted credits' }),
      event({ type: 'item.completed', item: { id: 'slow', type: 'mcp_tool_call', server: 'exa', tool: 'web_search_exa', status: 'failed', arguments: { query: 'slow' }, error: { message: 'timed out awaiting tools/call after 120s' } } }),
      event({ type: 'tool_call', callId: 'other', tool: 'read', input: { path: 'source.sol' } }),
    ]
    const result = evaluate(`const state=newAgentTranscript();appendAgentTranscript(state,${JSON.stringify(rows)},true);
      ({entries:transcriptEntries(state,'search'),summary:searchTranscriptSummary(state),html:agentTranscriptMarkup(state,'search')});`) as any
    expect(result.entries).toHaveLength(4)
    expect(result.summary).toContain('1 completed · 1 failed · 1 timed out · 1 no result recorded')
    expect(result.summary).toContain('loaded history')
    expect(result.html).toContain('HTTP 402')
    expect(result.html).toContain('Source contents')
    expect(result.html).toContain('&lt;script&gt;query&lt;/script&gt;')
    expect(result.html).not.toContain('<script>query')
    expect(result.html).not.toContain('source.sol')
  })

  it('deduplicates MCP updates and distinguishes embedded errors from successful text', () => {
    const rows = [
      event({ type: 'item.started', item: { id: 'a', type: 'mcp_tool_call', server: 'exa', tool: 'web_search_exa', arguments: { query: 'timeouts' }, status: 'in_progress' } }),
      event({ type: 'item.completed', item: { id: 'a', type: 'mcp_tool_call', server: 'exa', tool: 'web_search_exa', arguments: { query: 'timeouts' }, status: 'completed', result: { content: [{ type: 'text', text: 'An article about timeout errors' }] } } }),
      event({ type: 'item.completed', item: { id: 'b', type: 'mcp_tool_call', server: 'exa', tool: 'web_fetch_exa', status: 'completed', result: { isError: true, content: [{ type: 'text', text: 'offline' }] } } }),
      event({ type: 'item.completed', item: { id: 'c', type: 'mcp_tool_call', server: 'other', tool: 'web_search_exa', status: 'completed' } }),
    ]
    const result = evaluate(`const state=newAgentTranscript();appendAgentTranscript(state,${JSON.stringify(rows)},true);
      ({entries:transcriptEntries(state,'search'),summary:searchTranscriptSummary(state)});`) as any
    expect(result.entries).toHaveLength(2)
    expect(result.summary).toContain('1 completed · 1 failed')
    expect(result.summary).not.toContain('timed out')
    expect(evaluate('searchTranscriptSummary(newAgentTranscript())')).toBe('No search or source calls in loaded history.')
  })

  it('folds reasoning and searches only loaded literal text without rendering markup', () => {
    const result = evaluate(`const state=newAgentTranscript();
      appendAgentTranscript(state,${JSON.stringify([
        event({ type: 'thinking', text: '<script>private detail</script>' }),
        event({ type: 'text', text: 'A separate message' }),
      ])});
      ({filtered:transcriptEntries(state,'reasoning','PRIVATE DETAIL'),html:agentTranscriptMarkup(state,'reasoning','<script>')});`) as any
    expect(result.filtered).toHaveLength(1)
    expect(result.html).toContain('<details')
    expect(result.html).not.toContain(' open')
    expect(result.html).toContain('&lt;script&gt;')
    expect(result.html).not.toContain('separate message')
  })

  it('distinguishes saved activity, paginated history and capture end from provider health or success', () => {
    const result = evaluate(`const state=newAgentTranscript();
      appendAgentTranscript(state,${JSON.stringify([event({ type: 'status', phase: 'step_start', step: 1 })])});
      appendAgentTranscript(state,[{stream:'stdout',at:'2026-09-26T20:02:00Z',text:'{"type":"text"'}]);
      const logs={mode:'captured',complete:false,nextOffset:2,chunkCount:2};
      const now=Date.parse('2026-09-26T20:03:00Z');
      ({live:transcriptActivity(state,logs,now),loading:transcriptActivity(state,{...logs,complete:true,chunkCount:3},now),ended:transcriptActivity(state,{...logs,complete:true},now)});`) as any
    expect(result.live).toBe('Last message 1m 00s ago')
    expect(result.loading).toBe('More history available')
    expect(result.ended).toBe('End of history')
  })

  it('explains deterministic accepted steps without requesting a model transcript', () => {
    const elements = new Map<string, any>()
    const document = { querySelectorAll: () => [], getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', value: '' })
      return elements.get(id)
    } }
    const calls = runInNewContext(`${functions}
      snapshot={run:{id:'test'},waves:[{id:'wave-0',stageId:'review',status:'complete',tasks:[
        {taskId:'union',agentId:'supervisor',providerClass:'deterministic',status:'accepted',usage:zero(),provisionalUsage:zero()}]}]};
      selectedAgent='supervisor'; let calls=0; loadAgentInspector=()=>{calls++};
      renderAgentInspector(); calls;`, { document, clearTimeout: () => {} })
    expect(calls).toBe(0)
    expect(elements.get('inspector-status').textContent).toBe('Code step.')
    expect(elements.get('inspector-refresh').disabled).toBe(true)
  })

  it('preserves history beyond the old entry and character limits, including split large records', () => {
    const events = Array.from({length: 600}, (_, i) => event({ type: 'text', text: `message-${i}-` + 'x'.repeat(500) }))
    const { state } = transcript(events)
    expect(state.entries).toHaveLength(600)
    expect(state.entries[0].text).toContain('message-0-')
    expect(state.entries[599].text).toContain('message-599-')
    const text = JSON.stringify({ type: 'text', text: 'x'.repeat(1000001) })
    const result = evaluate(`const state=newAgentTranscript();
      appendAgentTranscript(state,[{stream:'stdout',text:${JSON.stringify(text.slice(0, 800000))}}]);
      appendAgentTranscript(state,[{stream:'stdout',text:${JSON.stringify(text.slice(800000) + '\n')}}],true);state;`) as any
    expect(result.entries[0].text).toHaveLength(1000001)
  })

  it('keeps routine steps in diagnostics while showing messages, retries and failures by default', () => {
    const result = evaluate(`const state=newAgentTranscript();appendAgentTranscript(state,${JSON.stringify([
      event({ type:'status', phase:'step_start', step:1 }),
      event({ role:'user', content:'Continue with the next check.' }),
      event({ type:'llm/retry', retry:1 }), event({ type:'error', message:'failed' }),
    ])},true);({normal:transcriptEntries(state).map(x=>x.kind),diagnostics:transcriptEntries(state,'diagnostics').map(x=>x.kind)});`) as any
    expect(result.normal).toEqual(['message','retry','error'])
    expect(result.diagnostics).toEqual(['status','retry','error'])
  })
})

describe('dashboard browser accounting', () => {
  it.each(['tokens', 'time', 'throughput'])('charts started waves without compressing %s behind planned waves', metric => {
    const elements = new Map<string, any>()
    const document = { getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', value: '' })
      return elements.get(id)
    } }
    const showPlanned = runInNewContext(`${functions}
      snapshot=exampleSnapshot(); waveMetric=${JSON.stringify(metric)};
      const base=snapshot.waves[0];
      snapshot.waves=[
        {...base,id:'wave-0@luna',status:'complete',tasks:[]},
        {...base,id:'wave-0@deepseek',status:'current',tasks:[],usage:sum([]),throughput:null},
        {...base,id:'wave-1@luna',status:'current',tasks:[],usage:sum([]),throughput:null},
        ...Array.from({length:128},(_,i)=>({...base,id:'planned-'+i,status:'pending',tasks:[]})),
        {...base,id:'skipped',status:'not-run',tasks:[]}
      ];
      renderOverview(); () => { $('show-planned').checked=true; renderProgress(); };`, { document }) as () => void
    const chart = elements.get('waves').innerHTML as string
    expect(chart.match(/data-wave=/g)).toHaveLength(3)
    expect(chart).toContain('wave-0@deepseek')
    expect(chart).toContain('wave-1@luna')
    expect(chart).not.toContain('planned-')
    expect(chart).not.toContain('skipped')
    expect(chart).toContain('min-width:700px')
    expect(elements.get('progress-wave').innerHTML.match(/<option /g)).toHaveLength(3)
    expect(elements.get('wave-note').textContent).toContain('planned waves remain in the Stage / wave selector')
    showPlanned()
    expect(elements.get('progress-wave').innerHTML.match(/<option /g)).toHaveLength(132)
  })

  it('shows an empty chart for an unstarted stage while keeping its planned waves selectable', () => {
    const elements = new Map<string, any>()
    const document = { getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', value: '' })
      return elements.get(id)
    } }
    runInNewContext(`${functions}
      snapshot=exampleSnapshot();
      snapshot.waves=[snapshot.waves[0],{...snapshot.waves[0],stageId:'future',status:'pending',tasks:[]}];
      selectedStage='future'; renderOverview();`, { document })
    expect(elements.get('waves').innerHTML).toContain('No waves started in this scope.')
    expect(elements.get('progress-wave').innerHTML.match(/<option /g)).toHaveLength(1)
  })

  it.each([
    { saved: 'failed', native: 'errored', display: 'failed' },
    { saved: 'running', native: 'terminated', display: 'stopped' },
    { saved: 'running', native: 'unknown', display: 'unknown' },
    { saved: 'running', native: 'paused', display: 'paused' },
  ])('refreshes the selected run label for $native despite saved $saved', async ({ saved, native, display }) => {
    const runs = {
      value: 'selected-run',
      options: [
        { value: 'selected-run', textContent: 'selected-run · saved running' },
        { value: 'other-run', textContent: 'other-run · saved running' },
      ],
    }
    const error = { textContent: '', hidden: true }
    await runInNewContext(`${functions}
      render = () => {};
      loadRun('selected-run', false);`, {
      document: { hidden: true, getElementById: (id: string) => id === 'runs' ? runs : error },
      AbortController, clearTimeout,
      fetch: async () => ({ ok: true, json: async () => ({
        schemaVersion: 1, agents: [], findings: [],
        run: { id: 'selected-run', status: saved }, workflow: { status: native }, executionStatus: display,
      }) }),
    })
    expect(error.textContent).toBe('')
    expect(runs.value).toBe('selected-run')
    expect(runs.options.map(option => option.textContent)).toEqual([
      `selected-run · ${display}`, 'other-run · saved running',
    ])
  })

  it('explains unknown execution status without claiming the Workflow ended and keeps polling', () => {
    const elements = new Map<string, any>()
    const document = {
      querySelectorAll: () => [],
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', hidden: false })
        return elements.get(id)
      },
    }
    const refresh = runInNewContext(`${functions}
      snapshot=exampleSnapshot(); isExample=false;
      snapshot.run.status='running'; snapshot.executionStatus='unknown'; snapshot.workflow=null;
      renderOverview=renderPerformance=renderAgentInspector=renderLineage=renderCosts=()=>{};
      render(); workflowRefreshState(snapshot);`, { document })
    expect(elements.get('run-status')).toMatchObject({ textContent: 'unknown', className: 'pill unknown' })
    expect(elements.get('notice').textContent).toContain('Execution status unavailable.')
    expect(elements.get('notice').textContent).not.toContain('Workflow ended')
    expect(refresh).toMatchObject({ active: true })
  })

  it('shows paused status without claiming the Workflow ended and detects later resume', () => {
    const elements = new Map<string, any>()
    const document = {
      querySelectorAll: () => [],
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', hidden: false })
        return elements.get(id)
      },
    }
    const refresh = runInNewContext(`${functions}
      snapshot=exampleSnapshot(); isExample=false;
      snapshot.run.status='running'; snapshot.executionStatus='paused'; snapshot.workflow={status:'paused'};
      renderOverview=renderPerformance=renderAgentInspector=renderLineage=renderCosts=()=>{};
      render(); workflowRefreshState(snapshot);`, { document })
    expect(elements.get('run-status')).toMatchObject({ textContent: 'paused', className: 'pill paused' })
    expect(elements.get('notice').textContent).toContain('Workflow paused.')
    expect(elements.get('notice').textContent).not.toContain('Workflow ended')
    expect(refresh).toMatchObject({ active: true })
  })

  const poolTask = (modelPool: string, localWave: number, status: string) => ({
    taskId: `${modelPool}-${localWave}`, agentId: `${modelPool}-lane`, promptKind: 'research',
    modelPool, localWave, status, model: 'deepseek/example', provider: 'provider-a',
  })
  const poolWave = (id: string, tasks: unknown[]) => ({ id, stageId: 'discovery', tasks })

  it('shows separate pool waves even when model and provider are identical', () => {
    const waves = [
      poolWave('wave-0', [poolTask('endpoint-a', 0, 'accepted'), poolTask('endpoint-b', 0, 'awaiting-result')]),
      poolWave('wave-1', [poolTask('endpoint-a', 1, 'accepted'), poolTask('endpoint-b', 1, 'pending')]),
      poolWave('wave-2', [poolTask('endpoint-a', 2, 'awaiting-result'), poolTask('endpoint-b', 2, 'pending')]),
    ]
    const rows = evaluate(`discoveryPoolProgress(${JSON.stringify(waves)})`) as any[]
    expect(rows.map(row => [row.id, row.waves.map((wave: any) => wave.label)]))
      .toEqual([['endpoint-a', ['Wave 0', 'Wave 1', 'Wave 2']], ['endpoint-b', ['Wave 0']]])
    expect(rows[0].waves[2]).toMatchObject({ waiting: 1, accepted: 0, total: 1 })
    expect(rows[1].waves[0]).toMatchObject({ waiting: 1, accepted: 0, total: 1 })
    expect(evaluate(`waveRoster(${JSON.stringify(waves[0])})`)).toBe('Research agents in this wave: 1 DeepSeek (endpoint-a) + 1 DeepSeek (endpoint-b)')
    const aliased = poolWave('wave-0', [poolTask('provider-a', 0, 'accepted'),
      { ...poolTask('provider-c', 0, 'accepted'), model: 'deepseek/v4-flash', provider: 'provider-c' }])
    expect(evaluate(`waveRoster(${JSON.stringify(aliased)})`)).toBe('Research agents in this wave: 1 DeepSeek (provider-a) + 1 DeepSeek (provider-c)')
  })

  it('does not invent pools in old snapshots or imply unavailable work was accepted', () => {
    expect(evaluate(`poolProgressMarkup([{stageId:'discovery',id:'wave-0',tasks:[{promptKind:'research',model:'legacy'}]}])`)).toBe('')
    const waves = [poolWave('wave-0', [poolTask('optional-endpoint', 0, 'unavailable')])]
    const markup = evaluate(`poolProgressMarkup(${JSON.stringify(waves)})`) as string
    expect(markup).toContain('0/1 accepted · 1 unavailable')
    expect(markup).toContain('data-complete="false"')
    expect(markup).not.toContain('sealed')
  })

  it('escapes pool labels and keeps the exact wave key for inspection', () => {
    const waves = [poolWave('pool-a-wave-7', [poolTask('<endpoint>', 7, 'returned')])]
    const markup = evaluate(`poolProgressMarkup(${JSON.stringify(waves)})`) as string
    expect(markup).toContain('&lt;endpoint&gt;')
    expect(markup).not.toContain('<endpoint>')
    expect(markup).toContain('data-wave="discovery/pool-a-wave-7"')
    expect(markup).toContain('1 returned')
    expect(markup).not.toContain('1 awaiting result')
  })
  it('discards an old agent log response after switching runs, even if cancellation is ignored', async () => {
    const elements = new Map<string, any>()
    const document = { getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', value: '', checked: false })
      return elements.get(id)
    } }
    let finish!: (value: unknown) => void
    const result = runInNewContext(`${functions}
      snapshot={run:{id:'old-run'},waves:[{stageId:'discovery',id:'wave-0',status:'current',tasks:[{taskId:'task',agentId:'lane'}]}]};
      selectedAgent='lane';inspectorKey=JSON.stringify(agentInspectionSelection());
      const pending=loadAgentInspector();
      resetAgentInspector();snapshot={run:{id:'new-run'},waves:[]};
      ({pending,data:()=>inspectorData});`, {
      document, AbortController, URLSearchParams, clearTimeout, fetch: () => new Promise(resolve => { finish = resolve }),
    }) as { pending: Promise<void>; data(): unknown }
    finish({ ok: true, json: async () => ({ prompt: { text: 'old private prompt' }, logs: { events: [] } }) })
    await result.pending
    expect(result.data()).toBeNull()
    expect(document.getElementById('inspector-prompt').textContent).toBe('')
    expect(html).toContain('$("inspector-log").textContent =')
    expect(html).not.toContain('$("inspector-log").innerHTML =')
  })

  it('escapes endpoint labels and preserves unknown request rates in the graph', () => {
    const chart = evaluate(`performanceChart([{provider:'<endpoint>',model:'<model>',thinking:null,
      reasoningEffort:null,outputTokensPerSecond:null,requests:2,measuredRequests:0}])`) as string
    expect(chart).toContain('&lt;endpoint&gt;')
    expect(chart).not.toContain('<endpoint>')
    expect(chart).toContain('—')
    expect(chart).toContain('0/2 measured requests')
  })

  it('discards endpoint timing returned after switching audit or selection', async () => {
    const elements = new Map<string, any>()
    const document = { getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '' })
      return elements.get(id)
    } }
    let finish!: (value: unknown) => void
    const result = runInNewContext(`${functions}
      snapshot={run:{id:'old-run'},waves:[{stageId:'discovery',id:'wave-0',status:'current',tasks:[]}]};
      const pending=loadPerformance();
      resetPerformance();
      snapshot={run:{id:'new-run'},waves:[]};
      ({pending,data:()=>performanceData});`, {
      document, AbortController, URLSearchParams, fetch: () => new Promise(resolve => { finish = resolve }),
    }) as { pending: Promise<void>; data(): unknown }
    finish({ ok: true, json: async () => ({ groups: [], inspectedReceipts: 99 }) })
    await result.pending
    expect(result.data()).toBeNull()
  })
  it('labels elapsed throughput, provisional usage and unknown speed explicitly', () => {
    expect(evaluate('throughputMarkup(null)')).toContain('Throughput unavailable')
    expect(evaluate('throughputMarkup({totalTokensPerSecond:150,outputTokensPerSecond:0.05,partial:true,provisional:true})'))
      .toContain('150 tokens/s · <0.1 output/s · partial · includes provisional')
    expect(evaluate('rateText(Infinity)')).toBe('—')
    expect(html).toContain('value="throughput"')
    expect(evaluate('exampleSnapshot().waves[0].throughput.totalTokensPerSecond')).toBeGreaterThan(0)
  })
  it('keeps polling for unknown, transitional, and temporarily unavailable Workflow status', () => {
    for (const status of ['unknown', 'waitingForPause', 'running']) {
      expect(evaluate(`workflowRefreshState({workflow:{status:'${status}'},run:{status:'running'}})`))
        .toMatchObject({ active: true })
    }
    expect(evaluate(`workflowRefreshState({workflow:null,run:{status:'running'}})`)).toEqual({
      active: true, label: 'Workflow status unavailable · refreshing from saved progress',
    })
    expect(evaluate(`workflowRefreshState({workflow:{status:'terminated'},run:{status:'running'}})`))
      .toEqual({ active: false, label: 'Workflow terminated · polling stopped' })
  })
  it('formats elapsed time and advances only live clocks from the latest sample', () => {
    expect(evaluate('duration(3_661_000)')).toBe('1h 01m 01s')
    expect(evaluate('duration(null)')).toBe('Time unavailable')
    expect(evaluate('duration(1432)')).toBe('1.432s')
    expect(evaluate('duration(1)')).toBe('0.001s')
    expect(evaluate('duration(0)')).toBe('0s')
    expect(evaluate('snapshotSampleAt = 1000; elapsedTime({elapsedMs:120_000,live:true}, 4000)')).toBe(123_000)
    expect(evaluate('snapshotSampleAt = 1000; elapsedTime({elapsedMs:120_000,live:false}, 4000)')).toBe(120_000)
    expect(evaluate('snapshotSampleAt = 1000; elapsedTime({elapsedMs:null,live:true}, 4000)')).toBeNull()
  })
  it('labels result receipt latency separately from unconfirmed activity', () => {
    expect(evaluate('taskTimeLabel({timing:{elapsedMs:120000,basis:"result",live:false}})')).toBe('Result received after')
    expect(evaluate('taskTimeLabel({timing:{elapsedMs:120000,basis:"wave",live:true}})')).toBe('Awaiting result for')
    expect(evaluate('taskTimeLabel({timing:{elapsedMs:null}})')).toBe('Timing not recorded')
    expect(evaluate('taskTimeLabel({timing:{elapsedMs:1432,basis:"single-task-wave",live:false}})'))
      .toBe('Single-task wave · includes saving result')
    expect(evaluate('taskTimeLabel({status:"interrupted",timing:{elapsedMs:null,live:false}})')).toBe('Run ended · end time not recorded')
  })

  it.each(['failed', 'stopped', 'incomplete'])('keeps the %s wave visible and selected without suggesting ongoing work', status => {
    const elements = new Map<string, any>()
    const document = { getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', value: '' })
      return elements.get(id)
    } }
    runInNewContext(`${functions}
      snapshot=exampleSnapshot();
      const base=snapshot.waves[0];
      snapshot.waves=[{...base,id:'finished',status:'complete',tasks:[]},
        {...base,id:'ended',status:${JSON.stringify(status)},tasks:[],timing:{live:false,elapsedMs:null}}];
      renderOverview();`, { document })
    expect(elements.get('progress-wave').value).toBe('explore/ended')
    expect(elements.get('progress-summary').textContent).toContain(`Run ${status}`)
    expect(elements.get('progress-summary').textContent).not.toContain('Current wave')
    expect(elements.get('waves').innerHTML).toContain('explore/ended')
    expect(elements.get('progress-time').innerHTML).not.toContain('data-ticking="true"')
  })

  const rotating = `
    const core = [1,2,3].map(n => ({agentId:'core-research-'+n,model:'gpt-codex-a',provider:'subscription',
      promptKind:'research',providerClass:'core',researcher:n}));
    const mirror = n => ({agentId:'additive-research-'+n,model:'deepseek/v4-flash',provider:'provider-c',
      promptKind:'research',providerClass:'additive',researcher:n});
    snapshot={waves:[1,2,3].map(n=>({stageId:'discovery',id:'wave-'+(n-1),tasks:[...core,mirror(n)]})),
      activity:[1,2,3].map(n=>({stageId:'discovery',waveId:'wave-'+(n-1),agentId:mirror(n).agentId}))};`;

  it('counts the actual per-wave roster rather than distinct assignments across waves', () => {
    expect(evaluate(`${rotating} snapshot.waves.map(waveRoster)`)).toEqual([
      'Research agents in this wave: 3 gpt-codex-a + 1 DeepSeek',
      'Research agents in this wave: 3 gpt-codex-a + 1 DeepSeek',
      'Research agents in this wave: 3 gpt-codex-a + 1 DeepSeek',
    ])
    expect(evaluate(`${rotating} waveRoster({tasks:[...core,mirror(1),mirror(2),mirror(3)]})`))
      .toBe('Research agents in this wave: 3 gpt-codex-a + 3 DeepSeek')
    expect(evaluate(`${rotating} agentLabel('additive-research-3')`)).toBe('DeepSeek · mirrors researcher 3')
    expect(evaluate(`${rotating} assignmentWaves('additive-research-3')`)).toBe('Recorded in discovery/wave-2')
    expect(evaluate(`${rotating} selectedWave='discovery/wave-0';assignmentWaves('additive-research-3')`))
      .toBe('No recorded execution in this scope')
  })

  it('keeps historical extra jobs separate and does not infer assignment numbers from workspace IDs', () => {
    expect(evaluate(`${rotating} snapshot.waves[0].tasks.push({agentId:'challenge-open-adversarial-replica',
      model:'deepseek/v4-flash',provider:'provider-c',promptKind:'coverage-challenge'});
      waveRoster(snapshot.waves[0])`)).toBe('Research agents in this wave: 3 gpt-codex-a + 1 DeepSeek · Additional jobs: 1 DeepSeek')
    expect(evaluate(`assignmentLabel({agentId:'custom-999',model:'custom-model',promptKind:'research',researcher:2})`))
      .toBe('custom-model · researcher 2')
    expect(evaluate(`assignmentLabel({agentId:'additive-research-3',model:'custom-model'})`))
      .toBe('additive-research-3')
  })

  it('defaults progress to the active wave and honors stage/wave selection', () => {
    const data = `snapshot={waves:[
      {id:'wave-0',stageId:'explore',status:'complete'},
      {id:'wave-1',stageId:'explore',status:'current'},
      {id:'wave-0',stageId:'verify',status:'pending'}]};`;
    expect(evaluate(`${data}progressWave().id`)).toBe('wave-1')
    expect(evaluate(`${data}selectedWave='explore/wave-0';progressWave().id`)).toBe('wave-0')
    expect(evaluate(`${data}selectedStage='verify';progressWave().stageId`)).toBe('verify')
    expect(evaluate(`${data}snapshot.waves[1].status='complete';progressWave().id`)).toBe('wave-1')
  })
  it('renders zero-usage lanes and escapes their labels while keeping provisional accounting explicit', () => {
    const card = evaluate(`laneCard({agentId:'<agent>',taskId:'task',model:'<model>',provider:'fixture',role:'<role>',
      status:'awaiting-result',lastAttempt:null,lastReceiptAt:null,rejectedAttempts:0,usage:sum([]),provisionalUsage:sum([])})`) as string
    expect(card).toContain('Awaiting result')
    expect(card).toContain('&lt;agent&gt;')
    expect(card).not.toContain('<model>')
    expect(card).toContain('Usage not recorded')
    const returned = evaluate(`laneCard({agentId:'agent',taskId:'task',model:'model',provider:'fixture',role:'role',
      status:'returned',lastAttempt:2,lastReceiptAt:null,rejectedAttempts:1,usage:sum([]),
      provisionalUsage:{modelCalls:1,inputTokens:10,outputTokens:5,costUsd:0}})`) as string
    expect(returned).toContain('Returned · unvalidated')
    expect(returned).toContain('15 provisional tokens')
    expect(returned).toContain('Last observed attempt 2')
  })

  it('distinguishes deterministic zero usage from missing provider telemetry', () => {
    const setup = `const t={agentId:'union',taskId:'union',model:'deterministic',provider:'deterministic-supervisor',
      role:'lead',providerClass:'deterministic',status:'accepted',usage:sum([]),provisionalUsage:sum([]),
      timing:{elapsedMs:1432,live:false,basis:'single-task-wave'}};`
    const card = evaluate(`${setup} laneCard(t)`) as string
    expect(card).toContain('1.432s')
    expect(card).toContain('No model calls · 0 tokens')
    expect(card).toContain('Token throughput not applicable')
    expect(card).not.toContain('unavailable')
    expect(card).not.toContain('not recorded')
    const missing = evaluate(`${setup} t.status='awaiting-result';laneCard(t)`) as string
    expect(missing).toContain('Usage not recorded')
    const rejected = evaluate(`${setup} t.providerClass='additive';t.status='unavailable';t.usage.modelCalls=2;laneCard(t)`) as string
    expect(rejected).toContain('0 recorded tokens')
    expect(rejected).not.toContain('No model calls')
    expect(evaluate(`${setup} snapshot={waves:[{stageId:'setup',status:'complete',tasks:[t]}]};
      throughputMarkup(null,modelFreeStage({id:'setup',status:'complete'}))`)).toContain('not applicable')
    expect(evaluate(`${setup} modelFreeWave({status:'complete',tasks:[t,{...t,providerClass:'core'}]})`)).toBe(false)
    expect(evaluate(`${setup} modelFreeWave({status:'current',tasks:[t]})`)).toBe(false)
  })

  it('offers a direct report view even with zero findings, without selecting a finding', () => {
    expect(html).toContain('data-view="report"')
    expect(evaluate(`snapshot={findings:[],nodes:[
      {kind:'report',artifactDigest:'saved-report'},
      {kind:'report',artifactDigest:'saved-report'},
      {kind:'observation',artifactDigest:'observation'},
      {kind:'report',artifactDigest:null}]};reportOutputs().map(n=>n.artifactDigest)`)).toEqual(['saved-report'])
    expect(evaluate('snapshot={nodes:[],findings:[]};reportOutputs()')).toEqual([])
  })
  it('discards a report response after switching runs even when the old request still resolves', async () => {
    const elements = new Map<string, { value: string; textContent: string; replaceChildren(): void }>()
    let finish!: (value: unknown) => void
    const document = { getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, { value: 'fixture-digest', textContent: '', replaceChildren() {} })
      return elements.get(id)!
    } }
    const result = runInNewContext(`${functions}
      snapshot={run:{id:'old-run'}};
      const pending=loadReport();
      resetReport();
      snapshot={run:{id:'new-run'}};
      ({pending, data:()=>reportData});`, {
      document, AbortController, fetch: () => new Promise(resolve => { finish = resolve }),
    }) as { pending: Promise<void>; data(): unknown }
    finish({ ok: true, json: async () => ({ files: { 'report.md': 'Old run private document' } }) })
    await result.pending
    expect(result.data()).toBeNull()
    expect(document.getElementById('report-status').textContent).toBe('No accepted report is available yet.')
  })
  it('uses the same-origin Access session without collecting an operator token', () => {
    expect(html).not.toContain('Operator token')
    expect(html).not.toContain('authorization: `Bearer')
    expect(html).toContain('credentials: "same-origin"')
    expect(html).toContain('/dashboard/api/runs')
  })
  it('parses under the nonce-only script boundary, including literal source document examples', () => {
    expect(() => new Script(script)).not.toThrow()
    expect(html.match(/<script nonce=/g)).toHaveLength(1)
    expect(evaluate('exampleSnapshot().activity.length')).toBe(77)
  })
  it('shows one recorded cost, preserving unknown and partial accounting', () => {
    expect(evaluate('costLabel({costUsd:0})')).toBe('Unavailable')
    expect(evaluate('costLabel({costUsd:0,costAccountingComplete:false})')).toBe('Unavailable')
    expect(evaluate('costLabel({costUsd:0,costAccountingComplete:true})')).toBe('$0.00')
    expect(evaluate('costLabel({costUsd:0.000457625,costAccountingComplete:true})')).toBe('$0.000458')
    expect(evaluate('costLabel({costUsd:0.0000001,costAccountingComplete:true})')).toBe('<$0.000001')
    expect(evaluate('costLabel({costUsd:0.0000001,costAccountingComplete:false})')).toBe('<$0.000001 · Incomplete')
    expect(evaluate('costLabel({costUsd:0.5,costAccountingComplete:false})')).toBe('$0.50 · Incomplete')
    expect(evaluate('costLabel({costUsd:0.5})')).toBe('$0.50 · Incomplete')
    expect(evaluate('costLabel({costUsd:NaN,costAccountingComplete:true})')).toBe('Unavailable')
    expect(html).not.toContain('API-equivalent')
    expect(html).not.toContain('rates-dialog')
  })
  it('keeps aggregate costs incomplete when any constituent is unpriced', () => {
    expect(evaluate(`const good={...zero(),modelCalls:1,costUsd:0.2};
      costLabel(sum([good,{...good,costUsd:0,costAccountingComplete:undefined}]))`)).toBe('$0.20 · Incomplete')
    expect(evaluate(`costLabel(sum([{...zero(),modelCalls:1,costUsd:0.2},{...zero(),costUsd:0.3}]))`)).toBe('$0.50')
  })
  it('renders provider-separated model rows from the same saved usage as the total', () => {
    const elements: Record<string, any> = {}
    runInNewContext(`${functions}

      snapshot={recordedUsage:{...zero(),costUsd:0.3,costAccountingComplete:false}, agents:[
        {model:'same-model',provider:'one',usage:{...zero(),costUsd:0.3}},
        {model:'same-model',provider:'two',usage:{...zero(),costAccountingComplete:false}},
        {model:'<model>',provider:'<provider>',usage:{...zero()}}
      ]};renderCosts();`, {document:{getElementById: (id: string) => elements[id] ||= {}}})
    expect(elements['provider-cost'].textContent).toBe('$0.30 · Incomplete')
    expect(elements['cost-table'].innerHTML.match(/same-model/g)).toHaveLength(2)
    expect(elements['cost-table'].innerHTML).toContain('Unavailable')
    expect(elements['cost-table'].innerHTML).toContain('&lt;model&gt;')
    expect(elements['cost-table'].innerHTML).not.toContain('<provider>')
  })
  it('labels missing cache detail as unknown and preserves partially recorded cache tokens', () => {
    expect(evaluate('cachedLabel({cacheAccountingComplete:false})')).toBe('Unknown')
    expect(evaluate('cachedLabel({cacheAccountingComplete:false,cachedInputTokens:30})')).toBe('30 recorded')
    expect(evaluate('cachedLabel({cacheAccountingComplete:true,cachedInputTokens:0})')).toBe('0')
  })
})

it('routes independent-wave inspection to the original task and limits performance to its configured pool', () => {
  const selection = evaluate(`snapshot={run:{id:'fixture'},waves:[{id:'wave-9@endpoint-a',sourceWaveId:'wave-9',
    stageId:'discovery',modelPool:'endpoint-a',status:'current',tasks:[{taskId:'a9',agentId:'lane-a'}]}]};
    selectedWave='discovery/wave-9@endpoint-a'; selectedAgent='lane-a'; performanceSelection();`)
  expect(selection).toEqual({ runId: 'fixture', stageId: 'discovery', waveId: 'wave-9', poolId: 'endpoint-a', taskId: 'a9' })
})


describe('session context display', () => {
  it('labels a retained allocation with its original owning run', () => {
    const html = evaluate(`filesystemMarkup({usage:'retained-from-parent',policy:'fresh-pristine',
      workspaceKey:'review',sourceRunId:'original-run',importedEvidence:'negative-review-packet-only',uses:[]})`) as string
    expect(html).toContain('Reused from parent run')
    expect(html).toContain('<code>original-run</code>')
    expect(html).not.toContain('First recorded use')
  })
  it('shows filesystem reuse independently of context and escapes allocation history', () => {
    const html = evaluate(`filesystemMarkup({usage:'reused-across-tasks',policy:'continuation',workspaceKey:'<script>lane</script>',
      sourceRunId:'parent',importedEvidence:'research-frontier',uses:[{stageId:'discovery',waveId:'wave-0',taskId:'<img>',attempt:1,selected:true}]})`) as string
    expect(html).toContain('Reused across tasks / waves')
    expect(html).toContain('Persistent across waves')
    expect(html).toContain('&lt;script&gt;lane&lt;/script&gt;')
    expect(html).toContain('&lt;img&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('does not prove that files survived a container restart')
    expect(html).toContain('does not share another agent’s live filesystem')
  })
  it('labels explicit fresh context, requested resume and conflicting evidence honestly', () => {
    expect(evaluate(`contextLabel({mode:'new',freshContextFallback:false})`)).toBe('Fresh context')
    expect(evaluate(`contextLabel({mode:'resume',sessionSource:'resume-request',sessionId:'abc'})`)).toBe('Resume requested')
    expect(evaluate(`contextLabel({mode:'resume',sessionSource:'native-log',sessionId:'abc'})`)).toBe('Resumed session')
    expect(evaluate(`contextLabel({mismatch:true})`)).toBe('Session evidence conflicts')
    expect(evaluate(`contextLabel(null)`)).toBe('Context continuity not recorded')
  })
  it('escapes IDs and preserves full session identity for comparison', () => {
    const html = evaluate(`contextMarkup({context:{mode:'new',sessionId:'<script>test</script>'},attempts:[]})`) as string
    expect(html).toContain('&lt;script&gt;test&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('Shared workspace or shared findings do not imply shared conversation')
  })
})

describe('readable handover cards', () => {
  it('does not label mixed reference outcomes as uniformly supported', () => {
    expect(evaluate(`handoverOutcome({verification:[{behavior:'reproduced',exploitability:'supported'},
      {behavior:'unresolved',exploitability:'unresolved'}],reviews:[],dispositions:[]})`)).toBe('Mixed verification')
  })
  it('escapes every untrusted observation and decision while distinguishing missing verification', () => {
    const row = { id:'OBS-1', observation:{statement:'<script>bad</script>',conditions:['<img>'],consequence:'impact',evidence:['proof']},
      source:{task:'research',model:'model',wave:'wave',digest:'a'.repeat(64)},
      dispositions:[{disposition:'candidate',reference:'C-1',rationale:'<svg onload=x>',source:null}],reviews:[],verification:[],custody:[],dissent:true };
    const result = evaluate(`handoverRowMarkup(${JSON.stringify(row)})`) as string
    expect(result).toContain('&lt;script&gt;')
    expect(result).toContain('&lt;svg')
    expect(result).not.toContain('<script>')
    expect(result).toContain('Review disagreement')
    expect(result).toContain('No structured verification outcome')
    expect(result).toContain('do not establish vulnerability confirmation')
  })
})


describe('configuration and history controls', () => {
  it('renders the saved runtime identity and configured wave ceiling', () => {
    const elements = new Map<string, any>()
    const document = { getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '' })
      return elements.get(id)
    } }
    runInNewContext(`${functions}
      snapshot={configuration:{runtime:{id:'runtime-fixture',containerImageDigest:'sha256:fixture'},maxDiscoveryWaves:64,pools:[]}};
      renderConfiguration();`, { document })
    expect(elements.get('configuration-content').innerHTML).toContain('runtime-fixture')
    expect(elements.get('configuration-content').innerHTML).toContain('<dd>64</dd>')
    expect(elements.get('configuration-content').innerHTML).toContain('sha256:fixture')
  })

  it('resumes Follow before a hidden-tab request finishes aborting', async () => {
    const elements = new Map<string, any>()
    const document = { hidden: false, getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', value: '', checked: true })
      return elements.get(id)
    } }
    const requests: Array<{ reject: (error: Error) => void }> = []
    const result = runInNewContext(`${functions}
      snapshot={run:{id:'run'},waves:[{stageId:'discovery',id:'wave-0',status:'current',tasks:[{taskId:'task',agentId:'lane'}]}]};
      selectedAgent='lane';inspectorKey=JSON.stringify(agentInspectionSelection());
      const pending=loadAgentInspector();
      document.hidden=true;handleInspectorVisibility();
      document.hidden=false;handleInspectorVisibility();
      ({pending,loading:()=>inspectorLoading,reset:resetAgentInspector});`, {
      document, AbortController, URLSearchParams, clearTimeout,
      fetch: () => new Promise((_resolve, reject) => requests.push({ reject })),
    }) as { pending: Promise<void>; loading(): boolean; reset(): void }
    expect(requests).toHaveLength(2)
    requests[0]!.reject(new Error('Aborted'))
    await result.pending
    expect(result.loading()).toBe(true)
    result.reset()
    requests[1]!.reject(new Error('Aborted'))
  })
})

describe('disclosures during dashboard refresh', () => {
  const setup = `
    const host = {
      nodes: [], writes: 0, scrollTop: 120,
      contains(node) { return this.nodes.some(n => n.summary === node); },
      querySelectorAll() { return this.nodes; },
      set innerHTML(markup) {
        this.writes++;
        this.nodes = JSON.parse(markup).map(([key, open = false]) => {
          const node = { dataset: { disclosure: key }, open };
          node.summary = { tagName: 'SUMMARY', parentElement: node, focus() { document.activeElement = this; } };
          node.querySelector = () => node.summary;
          return node;
        });
      }
    };
    const draw = (keys, scope = 'run-a:task-1:attempt-1') => renderDisclosures(host, JSON.stringify(keys), scope);
  `
  const run = (body: string) => runInNewContext(`${functions}\n${setup}\n${body}`, { document: { activeElement: null } })

  it('keeps nested evidence open and a deliberately closed section closed when content changes', () => {
    expect(run(`
      draw([['row'], ['original'], ['review', true]]);
      host.nodes[0].open = true; host.nodes[1].open = true; host.nodes[2].open = false;
      document.activeElement = host.nodes[1].summary;
      draw([['review', true], ['row'], ['original'], ['new-review']]);
      ({ open: host.nodes.map(n => n.open), focused: document.activeElement.parentElement.dataset.disclosure, scroll: host.scrollTop });
    `)).toEqual({ open: [false, true, true, false], focused: 'original', scroll: 120 })
  })

  it('leaves unchanged DOM in place and remembers disclosures hidden by filters', () => {
    expect(run(`
      draw([['row'], ['original']]); host.nodes[1].open = true;
      const original = host.nodes[1]; draw([['row'], ['original']]);
      const sameNode = original === host.nodes[1];
      draw([]); draw([['row'], ['original']]);
      ({ sameNode, writes: host.writes, open: host.nodes[1].open });
    `)).toEqual({ sameNode: true, writes: 3, open: true })
  })

  it('does not carry disclosure choices into another run or attempt', () => {
    expect(run(`
      draw([['original']]); host.nodes[0].open = true;
      draw([['original']], 'run-a:task-1:attempt-2'); const attempt = host.nodes[0].open;
      host.nodes[0].open = true; draw([['original']], 'run-b:task-1:attempt-2');
      [attempt, host.nodes[0].open];
    `)).toEqual([false, false])
  })

  it('keeps the current handover visible while a newer generation is loading', () => {
    const elements = new Map<string, any>()
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, { innerHTML: 'visible evidence', value: '', replaceChildren() { this.innerHTML = '' } })
      return elements.get(id)
    }
    runInNewContext(`${functions}\n
      snapshot = { run: { id: 'run-a', stateGeneration: 2 } }; isExample = false;
      handoverRunId = 'run-a'; handoverData = { rows: [], artifacts: [] }; handoverKey = handoverDataKey = 'run-a:1';
      api = () => new Promise(() => {});
      loadHandovers(); renderDisclosures = () => {}; renderHandovers(); undefined;
    `, { document: { getElementById: element }, AbortController })
    expect(element('handover-content').innerHTML).toBe('visible evidence')
    expect(element('handover-packet').innerHTML).toBe('visible evidence')
    expect(element('handover-status').textContent).toBe('Updating reviews and evidence… · 0 of 0 observations · 0 review disagreements')
  })
})
