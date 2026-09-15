/** Named HTTP v1 operations. Paths are resolved only by the API client. */
export const AGENT_OPERATIONS = {
  interactionUpdate: ["PATCH", "/interactions/:interactionId"],
  messageList: ["GET", "/interactions/:interactionId/messages"],
  messageSend: ["POST", "/interactions/:interactionId/messages"],
  guidanceList: ["GET", "/interactions/:interactionId/guidance"],
  guidanceAcknowledge: ["POST", "/interactions/:interactionId/guidance/:guidanceId/acknowledgment"],
  fulfillmentGet: ["GET", "/interactions/:interactionId/fulfillment"],
  workspaceList: ["GET", "/workspaces"],
  workspaceGet: ["GET", "/workspaces/:workspaceId"],
  resourceList: ["GET", "/workspaces/:workspaceId/resources"],
  resourceGet: ["GET", "/workspaces/:workspaceId/resources/:resourceType/:resourceId"],
  resourceLink: ["POST", "/workspaces/:workspaceId/resources"],
  resourceRename: ["PATCH", "/workspaces/:workspaceId/resources/:resourceType/:resourceId"],
  queueList: ["GET", "/workspaces/:workspaceId/queue"],
  inboxList: ["GET", "/inbox"],
  inboxGet: ["GET", "/inbox/items/:workspaceId/:entryId"],
  viewList: ["GET", "/inbox/views"],
  viewPropose: ["POST", "/inbox/views"],
  policyList: ["GET", "/inbox/policies"],
  policyGet: ["GET", "/inbox/policies/:policyId"],
  policyPropose: ["POST", "/inbox/policies"],
  policySimulate: ["POST", "/inbox/policies/simulate"],
  insightGet: ["GET", "/inbox/insights"],
  notificationList: ["GET", "/inbox/notification-deliveries"],
  webhookList: ["GET", "/webhook-subscriptions"],
  webhookGet: ["GET", "/webhook-subscriptions/:subscriptionId"],
  webhookCreate: ["POST", "/webhook-subscriptions"],
  webhookUpdate: ["PATCH", "/webhook-subscriptions/:subscriptionId"],
  webhookDisable: ["POST", "/webhook-subscriptions/:subscriptionId/disable"],
  webhookRotate: ["POST", "/webhook-subscriptions/:subscriptionId/rotate-secret"],
  deliveryList: ["GET", "/webhook-subscriptions/:subscriptionId/deliveries"],
  deliveryReplay: ["POST", "/webhook-subscriptions/:subscriptionId/deliveries/:deliveryId/replay"],
} as const;

export type AgentOperation = keyof typeof AGENT_OPERATIONS;
export type AgentRequest = {
  params?: Record<string, string | undefined>;
  query?: Record<string, string | number | boolean | string[] | undefined>;
  body?: unknown;
  etag?: string | undefined;
  idempotencyKey?: string | undefined;
  correlationId?: string | undefined;
};
