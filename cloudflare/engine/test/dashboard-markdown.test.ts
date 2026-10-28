import { describe, expect, it } from 'vitest'
import { renderDashboardMarkdown } from '../src/dashboard-markdown.js'

describe('private report Markdown rendering', () => {
  it('renders headings, emphasis, tables, lists, blockquotes and fenced code while retaining the original', () => {
    const source = '# Report\n\n**Summary**\n\n| Item | Result |\n| --- | --- |\n| Fixture | Reviewed |\n\n- First\n- Second\n\n> Evidence\n\n```text\n<literal>\n```'
    const files = { 'report.md': source, 'metadata.json': '{"complete":true}' }
    const html = renderDashboardMarkdown(files)['report.md']!
    for (const tag of ['<h1>', '<strong>', '<table>', '<ul>', '<blockquote>', '<pre><code']) expect(html).toContain(tag)
    expect(html).toContain('&lt;literal&gt;')
    expect(renderDashboardMarkdown(files)['metadata.json']).toBeUndefined()
    expect(files['report.md']).toBe(source)
  })

  it('escapes raw HTML and suppresses executable links, images and other external resource loads', () => {
    const html = renderDashboardMarkdown({ 'report.md': '<script>alert(1)</script>\n\n<iframe src="https://fixture.invalid"></iframe>\n\n[bad](javascript:alert(1))\n\n[bad](data:text/html,test)\n\n![tracking](https://fixture.invalid/pixel)\n\n![internal](/dashboard/api/runs)' })['report.md']!
    expect(html).not.toMatch(/<(script|iframe|img|svg)\b/i)
    expect(html).not.toMatch(/href=["'](?:javascript|data):/i)
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('[Image: tracking]')
  })

  it('keeps explicit web references private on navigation and renders other protocols as text', () => {
    const html = renderDashboardMarkdown({ 'REPORT.MD': '[reference](https://example.com/evidence)\n\n[local](file:///private/fixture)\n\n[relative](/dashboard/api/runs)' })['REPORT.MD']!
    expect(html).toContain('href="https://example.com/evidence"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('target="_blank"')
    expect(html).not.toMatch(/href="(?:file:|\/dashboard)/)
  })
})
