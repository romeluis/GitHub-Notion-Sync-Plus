const Logger = require('./Logger');
const DataMapper = require('./DataMapper');

class SyncManager {
    constructor(notionClient, githubClient, configManager) {
        this.notion = notionClient;
        this.github = githubClient;
        this.config = configManager;
        this.mapper = new DataMapper();
        this.logger = new Logger('SyncManager');
    }

    /**
     * Perfor    /**
     * Perform full bidirectional sync between Notion and GitHub
     * @returns {Object} Sync results summary
     */
    async performFullSync() {
        this.logger.info('Starting full synchronization...');
        
        // Validate GitHub permissions first
        try {
            const permissions = await this.github.validatePermissions();
            this.logger.info(`GitHub permissions validated for user: ${permissions.user}`);
            
            if (!permissions.canCreateIssues) {
                this.logger.warn('⚠️  GitHub token lacks full permissions for creating issues');
                this.logger.warn('Current permissions allow reading but not creating issues');
                this.logger.warn('Some operations may fail - consider updating token permissions');
            }
        } catch (error) {
            this.logger.error('GitHub permission validation failed:', error.message);
            // Don't throw here, continue with sync but log the warning
            this.logger.warn('Continuing with sync despite permission validation failure');
        }
        
        try {
            // Step 1: Fetch data from both sources
            const [notionData, githubIssues, githubPRs] = await Promise.all([
                this.notion.fetchAllItems(), // This returns {bugs, tasks}
                this.github.fetchAllSyncedIssues(this.config.getAllRepositories()),
                this.github.fetchAllPullRequests(this.config.getAllRepositories())
            ]);

            // Combine bugs and tasks into a single items array for unified processing
            const allItems = [...notionData.bugs, ...notionData.tasks];

            this.logger.info(`Found ${notionData.bugs.length} bugs and ${notionData.tasks.length} tasks in Notion, ${githubIssues.length} synced issues in GitHub, ${githubPRs.length} pull requests in GitHub`);

            // Step 2: Create mappings for efficient lookup
            const { bugMap, issueMap, prMap } = this.createMappings(allItems, githubIssues, githubPRs);

            // Step 3: Determine sync operations (including PR sync)
            const syncOperations = this.determineSyncOperations(bugMap, issueMap, prMap);

            // Step 4: Execute sync operations
            const results = await this.executeSyncOperations(syncOperations);

            this.logger.info('Full synchronization completed');
            return results;                } catch (error) {
            if (error.message && error.message.includes('issues:write permission')) {
                this.logger.error(`GitHub token permission issue: ${error.message}`);
                this.logger.warn('To fix this issue:');
                this.logger.warn('1. Go to https://github.com/settings/tokens');
                this.logger.warn('2. Generate a new token or edit existing token');
                this.logger.warn('3. Ensure the following permissions are selected:');
                this.logger.warn('   - repo (Full control of private repositories) OR');
                this.logger.warn('   - public_repo (Access public repositories) AND issues (Read/write access to issues)');
                this.logger.warn('4. Update your GITHUB_TOKEN in the .env file');
                
                return {
                    type: 'permission_error',
                    bug: bug.id,
                    error: 'GitHub token lacks issues:write permission'
                };
            }
            
            this.logger.error(`Failed to create GitHub issue for bug ${bug.id}:`, error);
            throw error;
        }
    }

    /**
     * Create mappings for efficient bug/issue/PR lookups
     * @param {Array} items - Array of Notion bugs and tasks
     * @param {Array} issues - Array of GitHub issues
     * @param {Array} prs - Array of GitHub pull requests
     * @returns {Object} Maps for bugs, issues, and PRs
     */
    createMappings(items, issues, prs = []) {
        const bugMap = new Map();
        const issueMap = new Map();
        const prMap = new Map();

        // Create item mapping by ID (works for both bugs and tasks)
        items.forEach(item => {
            if (item.id) {
                bugMap.set(item.id, item);
            }
        });

        // Create issue mapping by bug ID (extracted from title)
        issues.forEach(issue => {
            const bugId = this.mapper.extractBugIdFromTitle(issue.title);
            if (bugId) {
                issueMap.set(bugId, issue);
            }
        });

        // Create PR mapping by bug ID (extracted from branch name)
        prs.forEach(pr => {
            if (pr.bugId) {
                // Store as array since there could be multiple PRs for one bug
                if (!prMap.has(pr.bugId)) {
                    prMap.set(pr.bugId, []);
                }
                prMap.get(pr.bugId).push(pr);
            }
        });

        this.logger.debug(`Created mappings: ${bugMap.size} items, ${issueMap.size} issues, ${prMap.size} PR groups`);
        return { bugMap, issueMap, prMap };
    }

    /**
     * Determine what sync operations need to be performed
     * @param {Map} bugMap - Map of Notion items (bugs & tasks) by ID
     * @param {Map} issueMap - Map of GitHub issues by bug ID
     * @param {Map} prMap - Map of GitHub pull requests by bug ID
     * @returns {Array} Array of sync operations
     */
    determineSyncOperations(bugMap, issueMap, prMap = new Map()) {
        const operations = [];

        // Check each item in Notion (bugs and tasks)
        for (const [itemId, item] of bugMap) {
            // Tasks only sync PR properties, not GitHub issues
            if (item.itemType === 'task') {
                // Only check for PR sync operations for tasks
                const correspondingPRs = prMap.get(itemId) || [];
                const prSyncOperations = this.determinePRSyncOperations(item, correspondingPRs);
                operations.push(...prSyncOperations);
                continue; // Skip all other sync operations for tasks
            }

            // For bugs, proceed with full validation and sync
            const validation = this.mapper.validateBugForSync(item);
            if (!validation.isValid) {
                this.logger.warn(`Skipping invalid ${item.itemType || 'item'} ${itemId}:`, validation.errors);
                continue;
            }

            const correspondingIssue = issueMap.get(itemId);
            const correspondingPRs = prMap.get(itemId) || [];

            if (!correspondingIssue) {
                // Item exists in Notion but not in GitHub
                // Check if item already has an issue link (might be broken link)
                if (item.issueLink) {
                    this.logger.warn(`${item.itemType || 'Item'} ${itemId} has issue link but no corresponding GitHub issue found. Link: ${item.issueLink}`);
                    // Still create operation - the existing link might be broken
                }
                
                operations.push(this.mapper.createSyncOperation(
                    'create',
                    item,
                    null,
                    `${item.itemType || 'Item'} exists in Notion but not in GitHub`
                ));
            } else {
                // Item exists in both - CHECK FOR UPDATES
                const updateOperations = this.determineUpdateOperations(item, correspondingIssue);
                operations.push(...updateOperations);
                
                // Also check if Notion item is missing the issue link
                if (!item.issueLink || item.issueLink !== correspondingIssue.githubUrl) {
                    operations.push(this.mapper.createSyncOperation(
                        'update_notion_link',
                        item,
                        correspondingIssue,
                        `Notion ${item.itemType || 'item'} missing or has incorrect GitHub issue link`
                    ));
                }

                // Check if GitHub issue needs branch link update
                if (item.branchUrl && !this.issueHasBranchLink(correspondingIssue, item.branchUrl)) {
                    operations.push(this.mapper.createSyncOperation(
                        'update_github_branch',
                        item,
                        correspondingIssue,
                        'GitHub issue missing branch link from Notion'
                    ));
                }
            }

            // Check for PR sync operations
            const prSyncOperations = this.determinePRSyncOperations(item, correspondingPRs);
            operations.push(...prSyncOperations);
        }

        // Check for orphaned issues (exist in GitHub but not in Notion)
        for (const [itemId, issue] of issueMap) {
            if (!bugMap.has(itemId)) {
                operations.push(this.mapper.createSyncOperation(
                    'delete',
                    null,
                    issue,
                    'Issue exists in GitHub but corresponding item was deleted from Notion'
                ));
            }
        }

        this.logger.info(`Determined ${operations.length} sync operations`);
        return operations;
    }

    /**
     * Determine PR sync operations for an item (bug or task)
     * @param {Object} item - Notion item object (bug or task)
     * @param {Array} prs - Array of GitHub pull requests for this item
     * @returns {Array} Array of PR sync operations
     */
    determinePRSyncOperations(item, prs) {
        const operations = [];

        // Get the most relevant PR for this item
        const mostRelevantPR = this.getMostRelevantPR(prs);

        // Check if PR status needs to be updated
        if (mostRelevantPR) {
            const expectedPRStatus = this.mapper.mapGitHubPRStateToNotionStatus(mostRelevantPR);
            this.logger.debug(`PR analysis for ${item.itemType || 'item'} ${item.id}:`);
            this.logger.debug(`  Current Notion status: "${item.pullRequestStatus}"`);
            this.logger.debug(`  Expected status: "${expectedPRStatus}"`);
            this.logger.debug(`  PR state: "${mostRelevantPR.state}"`);
            this.logger.debug(`  PR merged: "${mostRelevantPR.merged}"`);
            this.logger.debug(`  PR merged_at: "${mostRelevantPR.mergedAt}"`);
            this.logger.debug(`  PR closed_at: "${mostRelevantPR.closedAt}"`);
            this.logger.debug(`  PR mergeable: "${mostRelevantPR.mergeable}"`);
            
            if (this.mapper.needsPRStatusUpdate(item.pullRequestStatus, mostRelevantPR)) {
                operations.push(this.mapper.createPRSyncOperation(
                    item,
                    mostRelevantPR,
                    `PR status should be "${expectedPRStatus}" but is "${item.pullRequestStatus}"`
                ));
            }

            // Check if PR link needs to be updated
            if (this.mapper.needsPRLinkUpdate(item.pullRequestLink, mostRelevantPR)) {
                operations.push(this.mapper.createSyncOperation(
                    'update_notion_pr_link',
                    item,
                    mostRelevantPR,
                    `PR link should be "${mostRelevantPR.githubUrl}" but is "${item.pullRequestLink}"`
                ));
            }
        } else {
            // No PR found - check if we should clear PR status/link
            if (item.pullRequestStatus && item.pullRequestStatus !== 'None') {
                // Only clear if there's a branch URL but no PR - indicating development started but no PR created yet
                if (item.branchUrl) {
                    this.logger.debug(`${item.itemType || 'Item'} ${item.id} has branch but no PR - keeping current PR status`);
                } else {
                    operations.push(this.mapper.createSyncOperation(
                        'clear_notion_pr',
                        item,
                        null,
                        `No pull request found for ${item.itemType || 'item'}, clearing PR status`
                    ));
                }
            }
        }

        return operations;
    }

    /**
     * Get the most relevant pull request from an array of PRs
     * @param {Array} prs - Array of pull requests
     * @returns {Object|null} Most relevant PR or null
     */
    getMostRelevantPR(prs) {
        if (!prs || prs.length === 0) {
            return null;
        }

        // Sort by priority: open PRs first, then merged, then closed
        // Within each group, sort by most recent
        const sortedPRs = [...prs].sort((a, b) => {
            // Priority order: open > merged > closed
            const getStatePriority = (pr) => {
                if (pr.state === 'open') return 3;
                if (pr.merged) return 2;
                return 1; // closed but not merged
            };
            
            const priorityDiff = getStatePriority(b) - getStatePriority(a);
            if (priorityDiff !== 0) return priorityDiff;
            
            // If same priority, sort by most recent update
            return new Date(b.updatedAt) - new Date(a.updatedAt);
        });

        return sortedPRs[0];
    }

    /**
     * Determine update operations for existing bug/issue pairs
     * @param {Object} bug - Notion bug
     * @param {Object} issue - GitHub issue
     * @returns {Array} Array of update operations
     */
    determineUpdateOperations(bug, issue) {
        const operations = [];

        // Check if GitHub issue state needs to be updated based on Notion status
        const expectedGitHubState = this.mapper.mapNotionStatusToGitHubState(bug.status);
        const githubNeedsUpdate = issue.state !== expectedGitHubState;
        
        // Check if Notion status needs to be updated based on GitHub state
        const expectedNotionStatus = this.mapper.mapGitHubStateToNotionStatus(issue.state, bug.status);
        const notionNeedsUpdate = bug.status !== expectedNotionStatus;

        // Prevent conflicting updates in the same sync cycle
        if (githubNeedsUpdate && notionNeedsUpdate) {
            // Use update timestamps to determine which changed more recently
            const notionUpdated = new Date(bug.lastModified || 0);
            const githubUpdated = new Date(issue.updated_at || 0);
            
            if (notionUpdated >= githubUpdated) {
                // Notion was updated more recently, sync to GitHub
                this.logger.info(`Notion bug ${bug.id} updated more recently (${notionUpdated.toISOString()}) than GitHub issue (${githubUpdated.toISOString()}), syncing to GitHub`);
                operations.push(this.mapper.createSyncOperation(
                    'update_github_state',
                    bug,
                    issue,
                    `Notion status "${bug.status}" updated more recently, requires GitHub state "${expectedGitHubState}"`
                ));
            } else {
                // GitHub was updated more recently, sync to Notion
                this.logger.info(`GitHub issue #${issue.number} updated more recently (${githubUpdated.toISOString()}) than Notion bug (${notionUpdated.toISOString()}), syncing to Notion`);
                operations.push(this.mapper.createSyncOperation(
                    'update_notion_status',
                    bug,
                    issue,
                    `GitHub state "${issue.state}" updated more recently, requires Notion status "${expectedNotionStatus}"`
                ));
            }
        } else if (githubNeedsUpdate) {
            // Only GitHub needs update
            operations.push(this.mapper.createSyncOperation(
                'update_github_state',
                bug,
                issue,
                `Notion status "${bug.status}" requires GitHub state "${expectedGitHubState}"`
            ));
        } else if (notionNeedsUpdate) {
            // Only Notion needs update
            operations.push(this.mapper.createSyncOperation(
                'update_notion_status',
                bug,
                issue,
                `GitHub state "${issue.state}" requires Notion status "${expectedNotionStatus}"`
            ));
        }

        return operations;
    }

    /**
     * Execute all sync operations
     * @param {Array} operations - Array of sync operations
     * @returns {Object} Execution results
     */
    async executeSyncOperations(operations) {
        const results = {
            created: 0,
            updated: 0,
            deleted: 0,
            failed: 0,
            operations: []
        };

        this.logger.info(`Executing ${operations.length} sync operations...`);

        for (const operation of operations) {
            try {
                const result = await this.executeOperation(operation);
                results.operations.push({ ...operation, result, success: true });

                switch (operation.action) {
                    case 'create':
                        results.created++;
                        break;
                    case 'update_github_state':
                    case 'update_notion_status':
                    case 'update_notion_pr':
                    case 'update_notion_pr_link':
                    case 'clear_notion_pr':
                        results.updated++;
                        break;
                    case 'delete':
                        results.deleted++;
                        break;
                }

            } catch (error) {
                this.logger.error(`Failed to execute operation ${operation.action}:`, error);
                results.failed++;
                results.operations.push({ ...operation, error: error.message, success: false });
            }
        }

        this.logger.info(`Sync operations completed: ${results.created} created, ${results.updated} updated, ${results.deleted} deleted, ${results.failed} failed`);
        return results;
    }

    /**
     * Check if a GitHub issue has a specific branch link in its body
     * @param {Object} issue - GitHub issue object
     * @param {string} branchUrl - Branch URL to check for
     * @returns {boolean} True if issue has the branch link
     */
    issueHasBranchLink(issue, branchUrl) {
        if (!issue.body || !branchUrl) return false;
        
        // Check if the branch URL appears in the issue body
        return issue.body.includes(branchUrl);
    }

    /**
     * Execute a single sync operation
     * @param {Object} operation - Sync operation object
     * @returns {Object} Operation result
     */
    async executeOperation(operation) {
        this.logger.info(`Executing ${operation.action}: ${operation.reason}`);

        switch (operation.action) {
            case 'create':
                return await this.createGitHubIssue(operation.source);

            case 'update_github_state':
                return await this.updateGitHubIssueState(operation.source, operation.target);

            case 'update_notion_status':
                return await this.updateNotionBugStatus(operation.source, operation.target);

            case 'update_notion_link':
                return await this.updateNotionBugLink(operation.source, operation.target);

            case 'update_github_branch':
                return await this.updateGitHubIssueBranchLink(operation.source, operation.target);

            case 'delete':
                return await this.deleteGitHubIssue(operation.target);

            case 'update_notion_pr':
                return await this.updateNotionPRProperties(operation.source, operation.target);

            case 'update_notion_pr_link':
                return await this.updateNotionPRLink(operation.source, operation.target);

            case 'clear_notion_pr':
                return await this.clearNotionPRProperties(operation.source);

            default:
                throw new Error(`Unknown operation: ${operation.action}`);
        }
    }

    /**
     * Create a new GitHub issue from Notion bug
     * @param {Object} bug - Notion bug object
     * @returns {Object} Created issue
     */
    async createGitHubIssue(bug) {
        const repository = this.config.getRepositoryForModule(bug.module);
        
        this.logger.info(`Creating GitHub issue for bug ${bug.id} in ${repository}`);
        
        // Create the GitHub issue with branch URL if available
        const issue = await this.github.createIssue(repository, bug, bug.branchUrl);
        
        // Update the Notion bug with the GitHub issue link
        try {
            await this.notion.updateBugIssueLink(bug.notionId, issue.githubUrl);
            this.logger.info(`Updated Notion bug ${bug.id} with GitHub issue link: ${issue.githubUrl}`);
        } catch (error) {
            this.logger.warn(`Failed to update Notion bug ${bug.id} with issue link:`, error.message);
            // Don't fail the entire operation if we can't update the link
        }
        
        this.logger.info(`Successfully created issue #${issue.githubId} for bug ${bug.id}` + 
                        (bug.branchUrl ? ` with branch link: ${bug.branchUrl}` : ''));
        return issue;
    }

    /**
     * Update GitHub issue state based on Notion status
     * @param {Object} bug - Notion bug object
     * @param {Object} issue - GitHub issue object
     * @returns {Object} Updated issue
     */
    async updateGitHubIssueState(bug, issue) {
        const newState = this.mapper.mapNotionStatusToGitHubState(bug.status);
        
        this.logger.info(`Updating GitHub issue #${issue.githubId} state to: ${newState}`);
        
        const updatedIssue = await this.github.updateIssueState(issue.repository, issue.githubId, newState);
        
        // Add comment explaining the state change
        await this.github.addComment(
            issue.repository,
            issue.githubId,
            `Issue state updated to "${newState}" based on Notion bug status: "${bug.status}"`
        );
        
        return updatedIssue;
    }

    /**
     * Update Notion item status based on GitHub issue state
     * @param {Object} item - Notion item object (bug or task)
     * @param {Object} issue - GitHub issue object
     * @returns {Object} Updated item
     */
    async updateNotionBugStatus(item, issue) {
        const newStatus = this.mapper.mapGitHubStateToNotionStatus(issue.state, item.status);
        
        this.logger.info(`Updating Notion ${item.itemType || 'item'} ${item.id} status to: ${newStatus}`);
        
        let updatedItem;
        if (item.itemType === 'task') {
            updatedItem = await this.notion.updateTaskStatus(item.notionId, newStatus);
        } else {
            updatedItem = await this.notion.updateBugStatus(item.notionId, newStatus);
        }
        
        return updatedItem;
    }

    /**
     * Update Notion item issue link
     * @param {Object} item - Notion item object (bug or task)
     * @param {Object} issue - GitHub issue object
     * @returns {Object} Updated item
     */
    async updateNotionBugLink(item, issue) {
        this.logger.info(`Updating Notion ${item.itemType || 'item'} ${item.id} issue link to: ${issue.githubUrl}`);
        
        let updatedItem;
        if (item.itemType === 'task') {
            updatedItem = await this.notion.updateTaskIssueLink(item.notionId, issue.githubUrl);
        } else {
            updatedItem = await this.notion.updateBugIssueLink(item.notionId, issue.githubUrl);
        }
        
        return updatedItem;
    }

    /**
     * Update GitHub issue with branch link from Notion
     * @param {Object} bug - Notion bug object with branch URL
     * @param {Object} issue - GitHub issue object
     * @returns {Object} Updated issue
     */
    async updateGitHubIssueBranchLink(bug, issue) {
        this.logger.info(`Updating GitHub issue #${issue.githubId} with branch link: ${bug.branchUrl}`);
        
        try {
            const branchName = bug.branchUrl.split('/').pop();
            
            // Update the issue body to include branch information in Development section
            let newBody = issue.body || '';
            
            // Check if Development section already exists
            if (newBody.includes('## Development')) {
                // Update existing Development section
                const developmentRegex = /(## Development\n)(.*?)(\n\n|$)/s;
                const developmentMatch = newBody.match(developmentRegex);
                
                if (developmentMatch && !developmentMatch[2].includes(bug.branchUrl)) {
                    // Add branch to existing Development section
                    const existingContent = developmentMatch[2].trim();
                    const newContent = existingContent 
                        ? `${existingContent}\n**Branch:** [${branchName}](${bug.branchUrl})`
                        : `**Branch:** [${branchName}](${bug.branchUrl})`;
                    
                    newBody = newBody.replace(
                        developmentRegex,
                        `## Development\n${newContent}\n\n`
                    );
                }
            } else {
                // Add new Development section
                const developmentSection = `## Development\n**Branch:** [${branchName}](${bug.branchUrl})`;
                
                if (newBody.includes('---\n*This issue was automatically created from Notion')) {
                    // Insert before the footer
                    newBody = newBody.replace(
                        /---\n\*This issue was automatically created from Notion/,
                        `${developmentSection}\n\n---\n*This issue was automatically created from Notion`
                    );
                } else {
                    // Just append
                    newBody += `\n\n${developmentSection}`;
                }
            }

            await this.github.updateIssueBody(issue.repository, issue.githubId, newBody);

            this.logger.info(`Successfully updated GitHub issue #${issue.githubId} Development section with branch link`);
            
            return {
                type: 'updated',
                issueNumber: issue.githubId,
                branchUrl: bug.branchUrl,
                branchName: branchName
            };

        } catch (error) {
            this.logger.error(`Failed to update GitHub issue #${issue.githubId} with branch link:`, error);
            throw error;
        }
    }

    /**
     * Delete/close GitHub issue when bug is deleted from Notion
     * @param {Object} issue - GitHub issue object
     * @returns {Object} Operation result
     */
    async deleteGitHubIssue(issue) {
        this.logger.info(`Deleting orphaned GitHub issue #${issue.githubId} from ${issue.repository}`);
        
        try {
            // Add comment explaining why the issue is being deleted
            await this.github.addComment(
                issue.repository,
                issue.githubId,
                'This issue is being deleted because the corresponding bug was removed from Notion. The issue will be closed and locked to prevent further interaction.'
            );
            
            // Delete (close and lock) the issue
            await this.github.deleteIssue(issue.repository, issue.githubId);
            
            this.logger.info(`Successfully deleted GitHub issue #${issue.githubId}`);
            
            return {
                type: 'deleted',
                repository: issue.repository,
                issueNumber: issue.githubId,
                success: true
            };
        } catch (error) {
            this.logger.error(`Failed to delete GitHub issue #${issue.githubId}:`, error);
            
            return {
                type: 'deleted',
                repository: issue.repository,
                issueNumber: issue.githubId,
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Update Notion item PR properties based on GitHub PR data
     * @param {Object} item - Notion item object (bug or task)
     * @param {Object} pr - GitHub pull request object
     * @returns {Object} Updated item
     */
    async updateNotionPRProperties(item, pr) {
        try {
            const prStatus = this.mapper.mapGitHubPRStateToNotionStatus(pr);
            
            this.logger.info(`Updating Notion ${item.itemType || 'item'} ${item.id} PR properties - Status: ${prStatus}, Link: ${pr.githubUrl}`);
            
            let updatedItem;
            if (item.itemType === 'task') {
                updatedItem = await this.notion.updateTaskProperties(item.notionId, {
                    pullRequestStatus: prStatus,
                    pullRequestLink: pr.githubUrl
                }, 'task');
            } else {
                updatedItem = await this.notion.updateBugProperties(item.notionId, {
                    pullRequestStatus: prStatus,
                    pullRequestLink: pr.githubUrl
                });
            }
            
            this.logger.info(`Successfully updated PR properties for ${item.itemType || 'item'} ${item.id}`);
            return updatedItem;
        } catch (error) {
            this.logger.error(`Failed to update PR properties for ${item.itemType || 'item'} ${item.id}:`, error);
            throw error;
        }
    }

    /**
     * Update Notion item PR link only
     * @param {Object} item - Notion item object (bug or task)
     * @param {Object} pr - GitHub pull request object
     * @returns {Object} Updated item
     */
    async updateNotionPRLink(item, pr) {
        try {
            this.logger.info(`Updating Notion ${item.itemType || 'item'} ${item.id} PR link to: ${pr.githubUrl}`);
            
            let updatedItem;
            if (item.itemType === 'task') {
                updatedItem = await this.notion.updateTaskProperties(item.notionId, {
                    pullRequestLink: pr.githubUrl
                }, 'task');
            } else {
                updatedItem = await this.notion.updateBugPullRequestLink(item.notionId, pr.githubUrl);
            }
            
            this.logger.info(`Successfully updated PR link for ${item.itemType || 'item'} ${item.id}`);
            return updatedItem;
        } catch (error) {
            this.logger.error(`Failed to update PR link for ${item.itemType || 'item'} ${item.id}:`, error);
            throw error;
        }
    }

    /**
     * Clear Notion item PR properties (set status to None, clear link)
     * @param {Object} item - Notion item object (bug or task)
     * @returns {Object} Updated item
     */
    async clearNotionPRProperties(item) {
        try {
            this.logger.info(`Clearing PR properties for Notion ${item.itemType || 'item'} ${item.id}`);
            
            let updatedItem;
            if (item.itemType === 'task') {
                updatedItem = await this.notion.updateTaskProperties(item.notionId, {
                    pullRequestStatus: 'None',
                    pullRequestLink: null
                }, 'task');
            } else {
                updatedItem = await this.notion.updateBugProperties(item.notionId, {
                    pullRequestStatus: 'None',
                    pullRequestLink: null
                });
            }
            
            this.logger.info(`Successfully cleared PR properties for ${item.itemType || 'item'} ${item.id}`);
            return updatedItem;
        } catch (error) {
            this.logger.error(`Failed to clear PR properties for ${item.itemType || 'item'} ${item.id}:`, error);
            throw error;
        }
    }
}

module.exports = SyncManager;
