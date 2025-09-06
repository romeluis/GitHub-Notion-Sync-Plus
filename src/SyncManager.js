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
            const [notionBugs, githubIssues] = await Promise.all([
                this.notion.fetchAllBugs(),
                this.github.fetchAllSyncedIssues(this.config.getAllRepositories())
            ]);

            this.logger.info(`Found ${notionBugs.length} bugs in Notion, ${githubIssues.length} synced issues in GitHub`);

            // Step 2: Create mappings for efficient lookup
            const { bugMap, issueMap } = this.createMappings(notionBugs, githubIssues);

            // Step 3: Determine sync operations
            const syncOperations = this.determineSyncOperations(bugMap, issueMap);

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
     * Create mappings for efficient bug/issue lookups
     * @param {Array} bugs - Array of Notion bugs
     * @param {Array} issues - Array of GitHub issues
     * @returns {Object} Maps for bugs and issues
     */
    createMappings(bugs, issues) {
        const bugMap = new Map();
        const issueMap = new Map();

        // Create bug mapping by ID
        bugs.forEach(bug => {
            if (bug.id) {
                bugMap.set(bug.id, bug);
            }
        });

        // Create issue mapping by bug ID (extracted from title)
        issues.forEach(issue => {
            const bugId = this.mapper.extractBugIdFromTitle(issue.title);
            if (bugId) {
                issueMap.set(bugId, issue);
            }
        });

        this.logger.debug(`Created mappings: ${bugMap.size} bugs, ${issueMap.size} issues`);
        return { bugMap, issueMap };
    }

    /**
     * Determine what sync operations need to be performed
     * @param {Map} bugMap - Map of Notion bugs by ID
     * @param {Map} issueMap - Map of GitHub issues by bug ID
     * @returns {Array} Array of sync operations
     */
    determineSyncOperations(bugMap, issueMap) {
        const operations = [];

        // Check each bug in Notion
        for (const [bugId, bug] of bugMap) {
            const validation = this.mapper.validateBugForSync(bug);
            if (!validation.isValid) {
                this.logger.warn(`Skipping invalid bug ${bugId}:`, validation.errors);
                continue;
            }

            const correspondingIssue = issueMap.get(bugId);

            if (!correspondingIssue) {
                // Bug exists in Notion but not in GitHub
                // Check if bug already has an issue link (might be broken link)
                if (bug.issueLink) {
                    this.logger.warn(`Bug ${bugId} has issue link but no corresponding GitHub issue found. Link: ${bug.issueLink}`);
                    // Still create operation - the existing link might be broken
                }
                
                operations.push(this.mapper.createSyncOperation(
                    'create',
                    bug,
                    null,
                    'Bug exists in Notion but not in GitHub'
                ));
            } else {
                // Bug exists in both - CHECK FOR UPDATES
                const updateOperations = this.determineUpdateOperations(bug, correspondingIssue);
                operations.push(...updateOperations);
                
                // Also check if Notion bug is missing the issue link
                if (!bug.issueLink || bug.issueLink !== correspondingIssue.githubUrl) {
                    operations.push(this.mapper.createSyncOperation(
                        'update_notion_link',
                        bug,
                        correspondingIssue,
                        'Notion bug missing or has incorrect GitHub issue link'
                    ));
                }
            }
        }

        // Check for orphaned issues (exist in GitHub but not in Notion)
        for (const [bugId, issue] of issueMap) {
            if (!bugMap.has(bugId)) {
                operations.push(this.mapper.createSyncOperation(
                    'delete',
                    null,
                    issue,
                    'Issue exists in GitHub but corresponding bug was deleted from Notion'
                ));
            }
        }

        this.logger.info(`Determined ${operations.length} sync operations`);
        return operations;
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
        if (issue.state !== expectedGitHubState) {
            operations.push(this.mapper.createSyncOperation(
                'update_github_state',
                bug,
                issue,
                `Notion status "${bug.status}" requires GitHub state "${expectedGitHubState}"`
            ));
        }

        // Check if Notion status needs to be updated based on GitHub state
        const expectedNotionStatus = this.mapper.mapGitHubStateToNotionStatus(issue.state, bug.status);
        if (bug.status !== expectedNotionStatus) {
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

            case 'delete':
                return await this.deleteGitHubIssue(operation.target);

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
        
        // Create the GitHub issue
        const issue = await this.github.createIssue(repository, bug);
        
        // Update the Notion bug with the GitHub issue link
        try {
            await this.notion.updateBugIssueLink(bug.notionId, issue.githubUrl);
            this.logger.info(`Updated Notion bug ${bug.id} with GitHub issue link: ${issue.githubUrl}`);
        } catch (error) {
            this.logger.warn(`Failed to update Notion bug ${bug.id} with issue link:`, error.message);
            // Don't fail the entire operation if we can't update the link
        }
        
        this.logger.info(`Successfully created issue #${issue.githubId} for bug ${bug.id}`);
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
     * Update Notion bug status based on GitHub issue state
     * @param {Object} bug - Notion bug object
     * @param {Object} issue - GitHub issue object
     * @returns {Object} Updated bug
     */
    async updateNotionBugStatus(bug, issue) {
        const newStatus = this.mapper.mapGitHubStateToNotionStatus(issue.state, bug.status);
        
        this.logger.info(`Updating Notion bug ${bug.id} status to: ${newStatus}`);
        
        const updatedBug = await this.notion.updateBugStatus(bug.notionId, newStatus);
        
        return updatedBug;
    }

    /**
     * Update Notion bug issue link
     * @param {Object} bug - Notion bug object
     * @param {Object} issue - GitHub issue object
     * @returns {Object} Updated bug
     */
    async updateNotionBugLink(bug, issue) {
        this.logger.info(`Updating Notion bug ${bug.id} issue link to: ${issue.githubUrl}`);
        
        const updatedBug = await this.notion.updateBugIssueLink(bug.notionId, issue.githubUrl);
        
        return updatedBug;
    }

    /**
     * Delete/close GitHub issue when bug is deleted from Notion
     * @param {Object} issue - GitHub issue object
     * @returns {Object} Deletion result
     */
    async deleteGitHubIssue(issue) {
        this.logger.info(`Closing orphaned GitHub issue #${issue.githubId}`);
        
        // Add comment explaining why the issue is being closed
        await this.github.addComment(
            issue.repository,
            issue.githubId,
            'This issue is being closed because the corresponding bug was deleted from Notion.'
        );
        
        // Close the issue
        const closedIssue = await this.github.updateIssueState(issue.repository, issue.githubId, 'closed');
        
        return closedIssue;
    }
}

module.exports = SyncManager;
