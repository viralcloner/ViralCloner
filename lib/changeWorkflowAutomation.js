// The state check and write are synchronous so execution cannot start between them.
function changeWorkflowAutomation({ workflowDb, workflowQueue, automations }, workflowId, automationId) {
  const validId = value => (typeof value === "string" && value.trim().length > 0) ||
    (typeof value === "number" && Number.isFinite(value));
  if (!validId(workflowId) || !validId(automationId)) return { success: false, code: "invalid" };
  const automation = Object.values(automations || {}).find(item =>
    item && String(item.id) === String(automationId));
  if (!automation) return { success: false, code: "missing_automation" };
  const workflow = workflowDb.getWorkflow(workflowId);
  if (!workflow) return { success: false, code: "missing_workflow" };
  const queue = workflowQueue.getQueueStatus();
  const busy = [...queue.running, ...queue.queued].some(id => String(id) === String(workflowId));
  if (busy) return { success: false, code: "not_editable" };
  // The workflow list displays completed records with only failed results as
  // Failed. Use the persisted post results to support that same state here.
  const posts = workflow.status === "completed" ? workflowDb.getWorkflowPosts(workflowId) : [];
  const completedWithFailedResults = posts.some(post => post.status === "failed") &&
    !posts.some(post => post.status === "completed");
  if (!completedWithFailedResults && !["paused", "stopped", "failed"].includes(workflow.status)) {
    return { success: false, code: "not_editable" };
  }
  const result = workflowDb.updateWorkflowAutomation(workflowId, automation.id);
  if (!result.changes) return { success: false, code: "missing_workflow" };
  return { success: true, automationId: automation.id };
}

module.exports = { changeWorkflowAutomation };
