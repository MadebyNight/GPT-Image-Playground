export * from './legacyAgentExecutor'

/**
 * 兼容旧导入路径。
 *
 * 受限 Agent 不再在浏览器构造 Responses tools/tool_choice，也不通过
 * submitTask 直接调用上游。所有能力均由同源 Gateway 两阶段接口提供。
 */
export {
  cancelRestrictedAgentExecution,
  computeRestrictedAgentConfirmationHash,
  createRestrictedAgentPlan,
  decodeRestrictedAgentPlan,
  executeRestrictedAgentPlan,
  getRestrictedAgentAsset,
  getRestrictedAgentCapabilities,
  getRestrictedAgentExecution,
  getRestrictedAgentPlan,
  getRestrictedAgentPlanOperation,
  subscribeRestrictedAgentExecution,
} from './restrictedAgentApi'
