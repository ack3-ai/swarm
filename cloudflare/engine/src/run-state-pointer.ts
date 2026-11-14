/** Content-addressed state selected by the existing run index. */
export interface RunStatePointer {
  generation: number
  digest: string
}

export const runStateKey = (runId: string, generation: number, digest: string): string =>
  `runs/${runId}/states/${String(generation).padStart(12, '0')}-${digest}.json`

export interface SavedStateReference { runId: string; state: RunStatePointer }

/** Historical recovery formats are interpreted only by their immutable app version. */
export function assertCurrentExecutionFormat(value: object): void {
  const record = value as { journal?: readonly { type: string; payload: { validation?: unknown; artifact?: object } }[];
    controls?: { lastReceipt?: { outcome?: { status?: string } } }; waveAdmission?: object;
    discoveryScheduler?: { admissions?: readonly object[] }; waveReceipts?: readonly object[];
    stageEndReceipts?: readonly { reason: string }[]; rejectedAttempts?: readonly object[] }
  const dispositions = [record.waveAdmission, ...(record.discoveryScheduler?.admissions ?? []),
    ...(record.waveReceipts ?? []), ...(record.journal?.map(event => event.payload) ?? [])]
  if (record.journal?.some(event => ['run.resumed', 'run.time-amended', 'run.executor-replaced'].includes(event.type))
    || record.stageEndReceipts?.some(receipt => receipt.reason === 'operator-discovery-pool-waiver')
    || record.rejectedAttempts?.some(attempt => Object.hasOwn(attempt, 'operatorWaiver'))
    || record.controls?.lastReceipt?.outcome?.status === 'failed'
    || record.journal?.some(event => Object.hasOwn(event.payload, 'nativeControl')
      || event.type === 'run.control-settled' && (event.payload as { lastReceipt?: { outcome?: { status?: string } } }).lastReceipt?.outcome?.status === 'failed')
    || dispositions.some(item => item != null && Object.hasOwn(item, 'abandonedTasks'))
    || record.journal?.some(event => ['task.occurrences-restarted', 'task.occurrences-skipped', 'run.configuration-amended'].includes(event.type)
    || event.type === 'task.accepted'
    && (Object.hasOwn(event.payload, 'validation') || event.payload.artifact !== undefined && Object.hasOwn(event.payload.artifact, 'acceptance')))
    || record.controls?.lastReceipt !== undefined && Object.hasOwn(record.controls.lastReceipt, 'validation')
    || ['failedWaveRecovery', 'terminalCompletionRecovery', 'runtimeTransition', 'promotedExecutionProofs', 'configurationHistory']
    .some(field => Object.prototype.hasOwnProperty.call(value, field))) {
    throw new Error('execution record belongs to its historical app version')
  }
}
