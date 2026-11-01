// Stand-in for the Workers runtime module, so Durable Object classes load in Node tests.
export class DurableObject<Env = unknown> {
  constructor(protected readonly ctx: DurableObjectState, protected readonly env: Env) {}
}
