import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false })
markdown.validateLink = href => /^https?:\/\//i.test(href) || href.startsWith('#')
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index]!.attrSet('rel', 'noopener noreferrer')
  tokens[index]!.attrSet('target', '_blank')
  return renderer.renderToken(tokens, index, options)
}
// Reports are private: embedded images must never trigger external requests.
markdown.renderer.rules.image = (tokens, index) =>
  `<span class="markdown-image">[Image: ${markdown.utils.escapeHtml(tokens[index]!.content)}]</span>`

export function renderDashboardMarkdown(files: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(files)
    .filter(([name]) => /\.(md|markdown)$/i.test(name))
    .map(([name, source]) => [name, markdown.render(source)]))
}
