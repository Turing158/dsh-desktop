import { originalRuntimeImport } from './runtime-hooks.mjs'
const { default: UpstreamManager } = await originalRuntimeImport('@deepseek-ai/dsh-mcp-manager')

export default class DesktopMcpManager extends UpstreamManager {
  // An explicit restart on the management page remains an immediate connect.
  async restart(name) {
    await super.restart(name)
    await this.host.wake?.(name)
  }
}
