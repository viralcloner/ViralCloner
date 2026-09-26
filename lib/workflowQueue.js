const { readKey, updateData } = require('./utils');
const { BrowserWindow } = require('electron');

// Workflow Queue System
// Simplified architecture: Backend is authoritative for all state
// No executionId tracking needed - backend saves to DB before sending events
class WorkflowQueueManager {
    constructor() {
        this.runningWorkflows = new Set(); // Set of workflowIds currently running
        this.queuedWorkflows = []; // Array of {workflowId, automationId, posts, resolve, reject}
        this.stoppedWorkflows = new Set(); // Set of workflowIds that were manually stopped
        this.maxConcurrentWorkflows = 2; // Default value, will be loaded from settings
        this._addLock = Promise.resolve(); // Mutex lock for addWorkflow to prevent race conditions
    }

    /**
     * Acquire a lock for thread-safe addWorkflow operations
     * Prevents race conditions when multiple workflows are added simultaneously
     */
    async _acquireLock() {
        let unlockNext;
        const willLock = new Promise(resolve => unlockNext = resolve);
        const lockAcquired = this._addLock;
        this._addLock = this._addLock.then(() => willLock);
        await lockAcquired;
        return unlockNext;
    }

    async loadSettings() {
        try {
            const automationSettings = (await readKey('automationSettings')) || {};
            this.maxConcurrentWorkflows = automationSettings.maxConcurrentWorkflows || 2;
            console.log(`🔧 Workflow queue system loaded with max concurrent workflows: ${this.maxConcurrentWorkflows}`);
        } catch (error) {
            console.warn('Failed to load workflow queue settings, using default:', error.message);
            this.maxConcurrentWorkflows = 2;
        }
    }

    async addWorkflow(workflowId, automationId, posts) {
        // Use mutex lock to prevent race conditions when multiple workflows are added simultaneously
        const unlock = await this._acquireLock();
        
        console.log(`🔒 [Queue] Lock acquired for workflow ${workflowId}`);
        console.log(`🔒 [Queue] Current state: ${this.runningWorkflows.size}/${this.maxConcurrentWorkflows} running, ${this.queuedWorkflows.length} queued`);
        console.log(`🔒 [Queue] Running workflows:`, Array.from(this.runningWorkflows));
        
        try {
            // Refresh settings each time to get latest configuration
            await this.loadSettings();

            // Clear any previous stopped state for this workflow (supports reruns)
            // Use type coercion to handle both string and number workflowIds
            const wfIdStr = String(workflowId);
            this.stoppedWorkflows.delete(wfIdStr);
            this.stoppedWorkflows.delete(parseInt(workflowId, 10));
            console.log(`🔄 Cleared stopped state for workflow ${workflowId} (rerun support)`);

            return new Promise((resolve, reject) => {
                if (this.runningWorkflows.size < this.maxConcurrentWorkflows) {
                    // Can start immediately
                    this.runningWorkflows.add(workflowId);
                    console.log(`🚀 Starting workflow ${workflowId} immediately (${this.runningWorkflows.size}/${this.maxConcurrentWorkflows} running)`);
                    
                    // Update workflow status to "pending" and notify frontend
                    this.updateWorkflowStatus(workflowId, 'pending');
                    this.notifyStatusChange(workflowId, 'pending', 'immediate-start');
                    
                    resolve(); // No executionId needed - backend is authoritative
                } else {
                    // Add to queue
                    this.queuedWorkflows.push({ workflowId, automationId, posts, resolve, reject });
                    console.log(`⏳ Queued workflow ${workflowId} (${this.queuedWorkflows.length} in queue, ${this.runningWorkflows.size}/${this.maxConcurrentWorkflows} running)`);
                    
                    // Update workflow status to "queued" and notify frontend
                    this.updateWorkflowStatus(workflowId, 'queued');
                    this.notifyStatusChange(workflowId, 'queued', 'added-to-queue');
                }
            });
        } finally {
            // Always release the lock, even if an error occurs
            console.log(`🔓 [Queue] Releasing lock for workflow ${workflowId}`);
            unlock();
        }
    }

    async finishWorkflow(workflowId) {
        console.log(`🏁 [Queue] finishWorkflow called for workflow ${workflowId}`);
        
        // CRITICAL: Check both string and number forms due to type inconsistencies
        // Frontend may pass workflowId as string or number depending on source
        const wfIdStr = String(workflowId);
        const wfIdNum = parseInt(workflowId, 10);
        
        // Check if this workflow was manually stopped (checking all type variations)
        const wasStopped = this.stoppedWorkflows.has(workflowId) || 
                           this.stoppedWorkflows.has(wfIdStr) || 
                           (!isNaN(wfIdNum) && this.stoppedWorkflows.has(wfIdNum));
        if (wasStopped) {
            // Clean up all type variations
            this.stoppedWorkflows.delete(workflowId);
            this.stoppedWorkflows.delete(wfIdStr);
            if (!isNaN(wfIdNum)) this.stoppedWorkflows.delete(wfIdNum);
            console.log(`✅ Workflow ${workflowId} was stopped - cleanup only, checking queue for next workflow`);
            this.runningWorkflows.delete(workflowId);
            
            // CRITICAL: Even for stopped workflows, dequeue the next one if available
            // Otherwise queued workflows get stuck when a running workflow is stopped
            if (this.queuedWorkflows.length > 0) {
                const nextWorkflow = this.queuedWorkflows.shift();
                this.runningWorkflows.add(nextWorkflow.workflowId);
                console.log(`🚀 Starting queued workflow ${nextWorkflow.workflowId} after stopped workflow cleanup (${this.runningWorkflows.size}/${this.maxConcurrentWorkflows} running, ${this.queuedWorkflows.length} remaining)`);
                
                await this.updateWorkflowStatus(nextWorkflow.workflowId, 'pending');
                this.notifyStatusChange(nextWorkflow.workflowId, 'pending', 'dequeued-after-stop');
                
                nextWorkflow.resolve();
            }
            return;
        }

        this.runningWorkflows.delete(workflowId);
        console.log(`✅ Workflow ${workflowId} finished (${this.runningWorkflows.size}/${this.maxConcurrentWorkflows} running)`);

        // Start next workflow in queue if any
        if (this.queuedWorkflows.length > 0) {
            const nextWorkflow = this.queuedWorkflows.shift();
            this.runningWorkflows.add(nextWorkflow.workflowId);
            console.log(`🚀 Starting queued workflow ${nextWorkflow.workflowId} (${this.runningWorkflows.size}/${this.maxConcurrentWorkflows} running, ${this.queuedWorkflows.length} remaining)`);
            
            // CRITICAL: Await DB update BEFORE notifying frontend to ensure consistency
            // This prevents the 10-second frontend refresh from seeing stale "queued" status
            await this.updateWorkflowStatus(nextWorkflow.workflowId, 'pending');
            this.notifyStatusChange(nextWorkflow.workflowId, 'pending', 'dequeued-and-started');
            
            nextWorkflow.resolve();
        }
    }

    async updateWorkflowStatus(workflowId, status) {
        try {
            const workflowDb = require('./database');
            const workflow = workflowDb.getWorkflowWithPosts(workflowId);
            if (workflow) {
                workflowDb.updateWorkflowStatus(workflowId, status, workflow.progress || 0);
                console.log(`✓ [Queue] DB updated: workflow ${workflowId} status => "${status}"`);
                return true;
            } else {
                console.warn(`⚠️ [Queue] Cannot update workflow ${workflowId} status to "${status}": workflow not found in DB`);
                return false;
            }
        } catch (error) {
            console.warn(`❌ [Queue] Failed to update workflow ${workflowId} status to ${status}:`, error.message);
            return false;
        }
    }

    async removeFromQueue(workflowId) {
        console.log(`🛑 [Queue] removeFromQueue called for workflow ${workflowId}`);
        
        // Mark this workflow as stopped so finishWorkflow won't start another workflow
        this.stoppedWorkflows.add(workflowId);
        
        // Remove from running workflows
        const wasRunning = this.runningWorkflows.has(workflowId);
        this.runningWorkflows.delete(workflowId);
        
        // Remove from queue if present
        const queueIndex = this.queuedWorkflows.findIndex(w => w.workflowId === workflowId);
        if (queueIndex !== -1) {
            const removedWorkflow = this.queuedWorkflows.splice(queueIndex, 1)[0];
            removedWorkflow.reject(new Error('Workflow was stopped'));
            console.log(`🛑 Removed workflow ${workflowId} from queue`);
        } else if (wasRunning) {
            console.log(`🛑 Removed workflow ${workflowId} from running set`);
        }

        // If we removed a running workflow, start the next one in queue
        if (wasRunning && this.queuedWorkflows.length > 0) {
            const nextWorkflow = this.queuedWorkflows.shift();
            this.runningWorkflows.add(nextWorkflow.workflowId);
            console.log(`🚀 Starting queued workflow ${nextWorkflow.workflowId} after removal (${this.runningWorkflows.size}/${this.maxConcurrentWorkflows} running)`);
            
            // CRITICAL: Await DB update BEFORE notifying frontend to ensure consistency
            await this.updateWorkflowStatus(nextWorkflow.workflowId, 'pending');
            this.notifyStatusChange(nextWorkflow.workflowId, 'pending', 'dequeued-after-removal');
            
            nextWorkflow.resolve();
        }
    }

    notifyStatusChange(workflowId, status, reason) {
        // Send IPC event to frontend to update workflow status immediately
        try {
            const window = BrowserWindow.getAllWindows()[0];
            if (window && !window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
                window.webContents.send('workflow-status-changed', {
                    workflowId,
                    status,
                    reason,
                    timestamp: new Date().toISOString()
                });
                console.log(`📡 Notified frontend: Workflow ${workflowId} status changed to "${status}" (${reason})`);
            }
        } catch (error) {
            console.warn(`Failed to notify frontend of workflow ${workflowId} status change:`, error.message);
        }
    }

    getQueueStatus() {
        return {
            running: Array.from(this.runningWorkflows),
            queued: this.queuedWorkflows.map(w => w.workflowId),
            maxConcurrent: this.maxConcurrentWorkflows
        };
    }

    /**
     * Get status of a specific workflow
     */
    getStatus() {
        return {
            running: this.runningWorkflows.size,
            queued: this.queuedWorkflows.length,
            maxConcurrent: this.maxConcurrentWorkflows
        };
    }
}

// Global workflow queue manager instance
const workflowQueue = new WorkflowQueueManager();

module.exports = { workflowQueue };