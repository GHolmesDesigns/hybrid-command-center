import type { ProviderAgentCostList, ProviderAgentCostRecord } from '../../shared/agent-cost.ts';
import type { AgentCostProvider } from './cost-provider.ts';

/** Test double for provider-reported agent usage. */
export class MockAgentCostProvider implements AgentCostProvider {
  readonly available = true;
  records: ProviderAgentCostRecord[] = [];
  listWarnings: string[] = [];
  listFailure?: Error;
  readonly listCalls: number[] = [];

  async list(): Promise<ProviderAgentCostList> {
    this.listCalls.push(this.records.length);
    if (this.listFailure) throw this.listFailure;
    return { records: [...this.records], warnings: [...this.listWarnings] };
  }
}
