import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const directory = new URL('../../../.github/workflows/', import.meta.url)

describe('CI publication boundary', () => {
  it('does not build container images or publish the shared Worker in GitHub', () => {
    for (const name of readdirSync(directory).filter(name => /\.ya?ml$/.test(name))) {
      const workflow = readFileSync(new URL(name, directory), 'utf8')
      expect(workflow, name).not.toMatch(/docker\s+(?:build|buildx)|docker\/(?:build-push-action|bake-action)/)
      expect(workflow, name).not.toMatch(/wrangler\s+deploy|pnpm\s+deploy:(?:worker|runtime|code)/)
      expect(workflow, name).not.toContain('CLOUDFLARE_API_TOKEN')
    }
  })

  it('runs the contributor check on every pull request without credentials', () => {
    const workflow = readFileSync(new URL('ci.yml', directory), 'utf8')
    expect(workflow).toMatch(/^on:\n(?: {2}\S.*\n|\s{4}.*\n)*? {2}pull_request:/m)
    expect(workflow).toMatch(/^ {6}- run: pnpm check$/m)
    expect(workflow).not.toMatch(/secrets\./)
  })
})
