const { Octokit } = require('@octokit/rest');
const Logger = require('./Logger');

class GitHubClient {
    constructor(token, logger) {
        this.token = token;
        this.logger = logger;
        
        // Configure Octokit based on token format
        let authConfig;
        
        if (token?.startsWith('github_pat_')) {
            // Fine-grained personal access token
            authConfig = {
                auth: token
            };
        } else if (token?.startsWith('ghp_')) {
            // Classic personal access token
            authConfig = {
                auth: token
            };
        } else {
            // Default configuration
            authConfig = {
                auth: token
            };
        }
        
        this.octokit = new Octokit(authConfig);
    }

    /**
     * Validate GitHub token permissions
     * @returns {Object} Permissions information
     */
    async validatePermissions() {
        try {
            // Test token by getting user info
            const userResponse = await this.octokit.rest.users.getAuthenticated();
            const user = userResponse.data;
            
            // Get token scopes from response headers
            const scopes = userResponse.headers['x-oauth-scopes'] || '';
            const acceptedPermissions = userResponse.headers['x-accepted-github-permissions'] || '';
            
            this.logger.info(`GitHub token authenticated as: ${user.login}`);
            this.logger.info(`Token scopes: ${scopes}`);
            this.logger.info(`Accepted permissions: ${acceptedPermissions}`);
            
            // Check if we have necessary permissions
            const hasRepoAccess = scopes.includes('repo') || scopes.includes('public_repo');
            const hasIssuesWrite = scopes.includes('repo') || acceptedPermissions.includes('issues=write');
            
            return {
                user: user.login,
                scopes: scopes.split(', ').filter(s => s.length > 0),
                hasRepoAccess,
                hasIssuesWrite,
                canCreateIssues: hasRepoAccess && hasIssuesWrite
            };
        } catch (error) {
            this.logger.error('Failed to validate GitHub token:', error);
            throw new Error(`GitHub token validation failed: ${error.message}`);
        }
    }

    /**
     * Fetch all issues from a repository that were created by this sync tool
     * @param {string} repo - Repository in format "owner/repo"
     * @returns {Array} Array of formatted issue objects
     */
    async fetchSyncedIssues(repo) {
        try {
            const [owner, repoName] = repo.split('/');
            this.logger.info(`Fetching synced issues from ${repo}...`);
            
            const response = await this.octokit.rest.issues.listForRepo({
                owner,
                repo: repoName,
                labels: 'notion-sync',
                state: 'all',
                per_page: 100
            });

            const issues = response.data.map(issue => this.formatIssueData(issue, repo));
            
            this.logger.info(`Successfully fetched ${issues.length} synced issues from ${repo}`);
            return issues;
        } catch (error) {
            if (error.status === 404) {
                this.logger.warn(`Repository ${repo} not found or no access`);
                return [];
            }
            this.logger.error(`Error fetching issues from ${repo}:`, error);
            throw error;
        }
    }

    /**
     * Fetch all synced issues from multiple repositories
     * @param {Array} repos - Array of repository names
     * @returns {Array} Array of all issues from all repositories
     */
    async fetchAllSyncedIssues(repos) {
        try {
            this.logger.info(`Fetching synced issues from ${repos.length} repositories...`);
            
            const allIssues = [];
            for (const repo of repos) {
                try {
                    const issues = await this.fetchSyncedIssues(repo);
                    allIssues.push(...issues);
                } catch (error) {
                    this.logger.warn(`Skipping ${repo} due to error:`, error.message);
                    // Continue with other repositories
                }
            }
            
            this.logger.info(`Successfully fetched ${allIssues.length} total synced issues`);
            return allIssues;
        } catch (error) {
            this.logger.error('Error fetching all synced issues:', error);
            throw error;
        }
    }

    /**
     * Format raw GitHub issue data into structured object
     * @param {Object} issue - Raw GitHub issue object
     * @param {string} repo - Repository name
     * @returns {Object} Formatted issue object
     */
    formatIssueData(issue, repo) {
        // Extract notion bug ID from title (format: [type]/[ID] [Title])
        const titleMatch = issue.title.match(/^\[(\w+)\]\/(CBUG-\d+)\s+(.+)$/);
        
        return {
            githubId: issue.number,
            githubUrl: issue.html_url,
            repository: repo,
            title: issue.title,
            body: issue.body,
            state: issue.state, // 'open' or 'closed'
            labels: issue.labels.map(label => label.name),
            createdAt: issue.created_at,
            updatedAt: issue.updated_at,
            closedAt: issue.closed_at,
            // Extracted from title format
            bugType: titleMatch ? titleMatch[1] : null,
            bugId: titleMatch ? titleMatch[2] : null,
            bugTitle: titleMatch ? titleMatch[3] : issue.title,
            // Check if this issue was created by sync tool
            isNotionSync: issue.labels.some(label => label.name === 'notion-sync')
        };
    }

    /**
     * Create a new GitHub issue from Notion bug data
     * @param {string} repo - Repository in format "owner/repo"
     * @param {Object} bug - Notion bug data
     * @param {string} branchUrl - Optional branch URL to include in issue body
     * @returns {Object} Created issue object
     */
    async createIssue(repo, bug, branchUrl = null) {
        try {
            const [owner, repoName] = repo.split('/');
            
            // Format title: ID: Title → CBUG-2: Test Bug Fix
            const title = `${bug.id}: ${bug.title}`;
            
            // Format description with bug details and optional branch URL
            const body = this.formatIssueBody(bug, branchUrl || bug.branchUrl);
            
            // Determine labels based on bug properties (including type)
            const labels = this.determineLabels(bug);
            
            this.logger.info(`Creating new issue in ${repo}: ${title}`);
            this.logger.info(`Owner: ${owner}, Repo: ${repoName}`);
            this.logger.info(`Title: ${title}`);
            this.logger.info(`Body: ${body}`);
            this.logger.info(`Labels: ${JSON.stringify(labels)}`);
            
            const response = await this.octokit.rest.issues.create({
                owner,
                repo: repoName,
                title,
                body,
                labels
            });
            
            this.logger.info(`Successfully created issue #${response.data.number} in ${repo}`);
            return this.formatIssueData(response.data, repo);
        } catch (error) {
            this.logger.error(`Error creating issue in ${repo}:`, error);
            this.logger.error(`Error status: ${error.status}`);
            this.logger.error(`Error message: ${error.message}`);
            if (error.response) {
                this.logger.error(`Error response data:`, error.response.data);
            }
            
            if (error.status === 404) {
                const detailedError = new Error(`Repository ${repo} not found or GitHub token lacks issues:write permission. Please check: 1) Repository exists, 2) Token has access to repository, 3) Token has issues:write permission, 4) Repository has issues enabled`);
                detailedError.originalError = error;
                throw detailedError;
            }
            throw error;
        }
    }

    /**
    /**
     * Update GitHub issue state (close/reopen)
     * @param {string} repo - Repository in format "owner/repo"
     * @param {number} issueNumber - GitHub issue number
     * @param {string} state - 'closed' or 'open'
     * @returns {Object} Updated issue object
     */
    async updateIssueState(repo, issueNumber, state) {
        try {
            const [owner, repoName] = repo.split('/');
            
            this.logger.info(`Updating issue #${issueNumber} in ${repo} to state: ${state}`);
            
            const response = await this.octokit.rest.issues.update({
                owner,
                repo: repoName,
                issue_number: issueNumber,
                state
            });
            
            this.logger.info(`Successfully updated issue #${issueNumber} state to ${state}`);
            return this.formatIssueData(response.data, repo);
        } catch (error) {
            this.logger.error(`Error updating issue #${issueNumber} in ${repo}:`, error);
            throw error;
        }
    }

    /**
     * Add comment to GitHub issue
     * @param {string} repo - Repository in format "owner/repo"
     * @param {number} issueNumber - GitHub issue number
     * @param {string} body - Comment body
     * @returns {Object} Created comment object
     */
    async addComment(repo, issueNumber, body) {
        try {
            const [owner, repoName] = repo.split('/');
            
            this.logger.info(`Adding comment to issue #${issueNumber} in ${repo}`);
            
            const response = await this.octokit.rest.issues.createComment({
                owner,
                repo: repoName,
                issue_number: issueNumber,
                body
            });
            
            this.logger.info(`Successfully added comment to issue #${issueNumber}`);
            return response.data;
        } catch (error) {
            this.logger.error(`Error adding comment to issue #${issueNumber}:`, error);
            throw error;
        }
    }

    /**
     * Update GitHub issue body
     * @param {string} repo - Repository in format "owner/repo"
     * @param {number} issueNumber - GitHub issue number
     * @param {string} body - New issue body
     * @returns {Object} Updated issue object
     */
    async updateIssueBody(repo, issueNumber, body) {
        try {
            const [owner, repoName] = repo.split('/');
            
            this.logger.info(`Updating body for issue #${issueNumber} in ${repo}`);
            
            const response = await this.octokit.rest.issues.update({
                owner,
                repo: repoName,
                issue_number: issueNumber,
                body
            });
            
            this.logger.info(`Successfully updated issue #${issueNumber} body`);
            return this.formatIssueData(response.data, repo);
        } catch (error) {
            this.logger.error(`Error updating issue #${issueNumber} body:`, error);
            throw error;
        }
    }

    /**
     * Format issue body with bug description and steps to reproduce
     * @param {Object} bug - Notion bug data
     * @returns {string} Formatted issue body
     */
    formatIssueBody(bug, branchUrl = null) {
        let body = '';
        
        if (bug.description) {
            body += `## Description\n${bug.description}\n\n`;
        }
        
        if (bug.stepsToReproduce) {
            body += `## Steps to Reproduce\n${bug.stepsToReproduce}\n\n`;
        }

        // Add branch information if provided
        if (branchUrl) {
            const branchName = branchUrl.split('/').pop();
            body += `## Development\n**Branch:** [${branchName}](${branchUrl})\n\n`;
        }
        
        body += `---\n*This issue was automatically created from Notion bug ${bug.id}*`;
        
        return body;
    }

    /**
     * Determine GitHub labels based on bug properties
     * @param {Object} bug - Notion bug data
     * @returns {Array} Array of label names
     */
    determineLabels(bug) {
        const labels = ['bug', 'notion-sync'];
        
        // Add type-based labels
        if (bug.type) {
            labels.push(bug.type.toLowerCase());
        }
        
        // Add status-based labels if needed
        switch (bug.status) {
            case 'Blocked':
                labels.push('blocked');
                break;
            case 'In Progress':
                labels.push('in-progress');
                break;
            case 'In Review':
                labels.push('in-review');
                break;
        }
        
        return labels;
    }

    /**
     * Check if repository exists and is accessible
     * @param {string} repo - Repository in format "owner/repo"
     * @returns {boolean} Repository accessibility
     */
    async checkRepositoryAccess(repo) {
        try {
            const [owner, repoName] = repo.split('/');
            const response = await this.octokit.rest.repos.get({
                owner,
                repo: repoName
            });
            this.logger.info(`✅ Repository ${repo} is accessible`);
            return true;
        } catch (error) {
            if (error.status === 404) {
                this.logger.warn(`Repository ${repo} not found or not accessible`);
            } else {
                this.logger.error(`Error accessing repository ${repo}:`, error.message);
            }
            return false;
        }
    }

    /**
     * Delete a GitHub issue (requires admin/maintain permissions)
     * @param {string} repo - Repository in format "owner/repo"
     * @param {number} issueNumber - Issue number to delete
     * @returns {boolean} Success status
     */
    async deleteIssue(repo, issueNumber) {
        try {
            const [owner, repoName] = repo.split('/');
            
            this.logger.info(`Deleting GitHub issue #${issueNumber} in ${repo}`);
            
            // Note: GitHub doesn't have a direct "delete issue" API endpoint
            // Instead, we need to use the Transfer API or close + lock the issue
            // For now, we'll close and lock the issue as this is the closest to "deletion"
            
            // First close the issue
            await this.octokit.rest.issues.update({
                owner,
                repo: repoName,
                issue_number: issueNumber,
                state: 'closed'
            });
            
            // Then lock the issue to prevent further interaction
            await this.octokit.rest.issues.lock({
                owner,
                repo: repoName,
                issue_number: issueNumber,
                lock_reason: 'resolved' // or 'off-topic', 'too heated', 'spam'
            });
            
            this.logger.info(`Successfully deleted (closed and locked) issue #${issueNumber} in ${repo}`);
            return true;
        } catch (error) {
            this.logger.error(`Error deleting issue #${issueNumber} in ${repo}:`, error);
            throw error;
        }
    }

    /**
     * Create a new branch from a source branch
     * @param {string} repo - Repository in format "owner/repo"
     * @param {string} branchName - Name of the new branch
     * @param {string} sourceBranch - Source branch to create from (default: main)
     * @returns {Object|null} Branch info or null if already exists
     */
    async createBranch(repo, branchName, sourceBranch = 'main') {
        try {
            const [owner, repoName] = repo.split('/');
            
            this.logger.info(`Creating branch ${branchName} from ${sourceBranch} in ${repo}`);

            // Get the SHA of the source branch
            const { data: sourceRef } = await this.octokit.rest.git.getRef({
                owner,
                repo: repoName,
                ref: `heads/${sourceBranch}`
            });

            // Create new branch
            const { data: newBranch } = await this.octokit.rest.git.createRef({
                owner,
                repo: repoName,
                ref: `refs/heads/${branchName}`,
                sha: sourceRef.object.sha
            });

            this.logger.info(`Successfully created branch ${branchName} in ${repo}`, {
                sha: newBranch.object.sha
            });

            return {
                name: branchName,
                sha: newBranch.object.sha,
                url: `https://github.com/${repo}/tree/${branchName}`,
                repository: repo
            };

        } catch (error) {
            if (error.status === 422) {
                this.logger.warn(`Branch ${branchName} already exists in ${repo}`);
                return null;
            }
            
            this.logger.error(`Failed to create branch ${branchName} in ${repo}:`, error);
            throw error;
        }
    }

    /**
     * Fetch pull requests for a specific branch or all PRs related to synced issues
     * @param {string} repo - Repository in format "owner/repo"
     * @param {string} branchName - Optional branch name to filter PRs
     * @returns {Array} Array of formatted pull request objects
     */
    async fetchPullRequests(repo, branchName = null) {
        try {
            const [owner, repoName] = repo.split('/');
            this.logger.info(`Fetching pull requests from ${repo}${branchName ? ` for branch ${branchName}` : ''}...`);
            
            const params = {
                owner,
                repo: repoName,
                state: 'all',
                per_page: 100
            };

            if (branchName) {
                params.head = `${owner}:${branchName}`;
            }
            
            const response = await this.octokit.rest.pulls.list(params);
            const prs = response.data.map(pr => this.formatPullRequestData(pr, repo));
            
            this.logger.info(`Successfully fetched ${prs.length} pull requests from ${repo}`);
            return prs;
        } catch (error) {
            if (error.status === 404) {
                this.logger.warn(`Repository ${repo} not found or no access`);
                return [];
            }
            this.logger.error(`Error fetching pull requests from ${repo}:`, error);
            throw error;
        }
    }

    /**
     * Fetch all pull requests from multiple repositories
     * @param {Array} repos - Array of repository names
     * @returns {Array} Array of all pull requests from all repositories
     */
    async fetchAllPullRequests(repos) {
        try {
            this.logger.info(`Fetching pull requests from ${repos.length} repositories...`);
            
            const allPRs = [];
            for (const repo of repos) {
                try {
                    const prs = await this.fetchPullRequests(repo);
                    allPRs.push(...prs);
                } catch (error) {
                    this.logger.warn(`Skipping ${repo} due to error:`, error.message);
                    // Continue with other repositories
                }
            }
            
            this.logger.info(`Successfully fetched ${allPRs.length} total pull requests`);
            return allPRs;
        } catch (error) {
            this.logger.error('Error fetching all pull requests:', error);
            throw error;
        }
    }

    /**
     * Format raw GitHub pull request data into structured object
     * @param {Object} pr - Raw GitHub pull request object
     * @param {string} repo - Repository name
     * @returns {Object} Formatted pull request object
     */
    formatPullRequestData(pr, repo) {
        // Extract bug/task ID from branch name if possible
        const branchName = pr.head.ref;
        const bugIdMatch = branchName.match(/^(CBUG-\d+|TSK-\d+)\//);
        
        return {
            githubId: pr.number,
            githubUrl: pr.html_url,
            repository: repo,
            title: pr.title,
            body: pr.body,
            state: pr.state, // 'open' or 'closed'
            merged: pr.merged || false, // GitHub API provides this field
            mergeable: pr.mergeable, // null, true, or false
            mergeable_state: pr.mergeable_state, // Additional merge state info
            branchName: branchName,
            baseBranch: pr.base.ref,
            headBranch: pr.head.ref,
            createdAt: pr.created_at,
            updatedAt: pr.updated_at,
            mergedAt: pr.merged_at,
            closedAt: pr.closed_at,
            // Extract bug/task ID from branch name
            bugId: bugIdMatch ? bugIdMatch[1] : null,
            // Check if PR is associated with a synced issue
            labels: pr.labels ? pr.labels.map(label => label.name) : []
        };
    }

    /**
     * Find pull requests associated with a specific bug/task ID
     * @param {string} bugId - Bug/Task ID (e.g., "CBUG-2" or "TSK-1")
     * @param {string} repo - Repository name
     * @returns {Array} Array of pull requests associated with the bug/task
     */
    async findPullRequestsByBugId(bugId, repo) {
        try {
            const allPRs = await this.fetchPullRequests(repo);
            
            // Filter PRs that are related to this bug ID
            const relatedPRs = allPRs.filter(pr => {
                // Check if PR branch name starts with bug ID
                return pr.branchName.startsWith(`${bugId}/`) || pr.bugId === bugId;
            });
            
            this.logger.info(`Found ${relatedPRs.length} pull requests for bug ${bugId} in ${repo}`);
            return relatedPRs;
        } catch (error) {
            this.logger.error(`Error finding pull requests for bug ${bugId}:`, error);
            throw error;
        }
    }

    /**
     * Get the most relevant pull request for a bug/task
     * @param {string} bugId - Bug/Task ID
     * @param {string} repo - Repository name
     * @returns {Object|null} Most relevant pull request or null
     */
    async getMostRelevantPullRequest(bugId, repo) {
        const prs = await this.findPullRequestsByBugId(bugId, repo);
        
        if (prs.length === 0) {
            return null;
        }
        
        // Sort by priority: open PRs first, then merged, then closed
        // Within each group, sort by most recent
        prs.sort((a, b) => {
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
        
        return prs[0];
    }

    /**
     * Check if a branch exists in a repository
     * @param {string} repo - Repository name (owner/repo)
     * @param {string} branchName - Branch name to check
     * @returns {boolean} True if branch exists
     */
    async checkBranchExists(repo, branchName) {
        try {
            const [owner, repoName] = repo.split('/');
            
            await this.octokit.rest.git.getRef({
                owner,
                repo: repoName,
                ref: `heads/${branchName}`
            });
            
            this.logger.info(`Branch ${branchName} exists in ${repo}`);
            return true;
        } catch (error) {
            if (error.status === 404) {
                this.logger.info(`Branch ${branchName} does not exist in ${repo}`);
                return false;
            }
            this.logger.error(`Error checking if branch ${branchName} exists:`, error);
            throw error;
        }
    }

    /**
     * Check if a branch has changes compared to another branch
     * @param {string} repo - Repository name (owner/repo)
     * @param {string} branchName - Branch to check
     * @param {string} baseBranch - Base branch to compare against (default: main)
     * @returns {boolean} True if branch has changes
     */
    async branchHasChanges(repo, branchName, baseBranch = 'main') {
        try {
            const [owner, repoName] = repo.split('/');
            
            const comparison = await this.octokit.rest.repos.compareCommitsWithBasehead({
                owner,
                repo: repoName,
                basehead: `${baseBranch}...${branchName}`
            });
            
            const hasChanges = comparison.data.ahead_by > 0;
            this.logger.info(`Branch ${branchName} has ${comparison.data.ahead_by} commits ahead of ${baseBranch}`);
            return hasChanges;
        } catch (error) {
            this.logger.error(`Error comparing branch ${branchName} with ${baseBranch}:`, error);
            throw error;
        }
    }

    /**
     * Create a new pull request
     * @param {string} repo - Repository name (owner/repo)
     * @param {string} headBranch - Source branch for the PR
     * @param {string} baseBranch - Target branch for the PR (default: main)
     * @param {string} title - PR title
     * @param {string} body - PR body/description
     * @returns {Object} Created pull request object
     */
    async createPullRequest(repo, headBranch, baseBranch, title, body) {
        try {
            const [owner, repoName] = repo.split('/');
            
            this.logger.info(`Creating pull request in ${repo}: ${headBranch} → ${baseBranch}`);
            this.logger.info(`PR Title: ${title}`);
            
            const response = await this.octokit.rest.pulls.create({
                owner,
                repo: repoName,
                title,
                body,
                head: headBranch,
                base: baseBranch
            });
            
            this.logger.info(`Successfully created PR #${response.data.number} in ${repo}`);
            return this.formatPullRequestData(response.data, repo);
        } catch (error) {
            this.logger.error(`Error creating pull request in ${repo}:`, error);
            
            if (error.status === 422) {
                // Handle common PR creation errors
                if (error.message?.includes('No commits between')) {
                    throw new Error(`No changes found between ${baseBranch} and ${headBranch}`);
                } else if (error.message?.includes('already exists')) {
                    throw new Error(`Pull request already exists for branch ${headBranch}`);
                }
            }
            
            throw error;
        }
    }

    /**
     * Get detailed pull request information
     * @param {string} repo - Repository name (owner/repo)
     * @param {number} prNumber - Pull request number
     * @returns {Object} Detailed pull request data
     */
    async getPullRequestDetails(repo, prNumber) {
        try {
            const [owner, repoName] = repo.split('/');
            
            const response = await this.octokit.rest.pulls.get({
                owner,
                repo: repoName,
                pull_number: prNumber
            });
            
            this.logger.info(`Retrieved details for PR #${prNumber} in ${repo}`);
            return response.data;
        } catch (error) {
            this.logger.error(`Error getting PR #${prNumber} details:`, error);
            throw error;
        }
    }

    /**
     * Merge a pull request
     * @param {string} repo - Repository name (owner/repo)
     * @param {number} prNumber - Pull request number
     * @param {string} commitTitle - Commit title for the merge
     * @param {string} mergeMethod - Merge method: 'merge', 'squash', or 'rebase'
     * @returns {Object} Merge result
     */
    async mergePullRequest(repo, prNumber, commitTitle, mergeMethod = 'squash') {
        try {
            const [owner, repoName] = repo.split('/');
            
            this.logger.info(`Merging PR #${prNumber} in ${repo} using ${mergeMethod} method`);
            
            const response = await this.octokit.rest.pulls.merge({
                owner,
                repo: repoName,
                pull_number: prNumber,
                commit_title: commitTitle,
                merge_method: mergeMethod
            });
            
            this.logger.info(`Successfully merged PR #${prNumber}`, {
                sha: response.data.sha,
                merged: response.data.merged
            });
            
            return {
                merged: response.data.merged,
                sha: response.data.sha,
                message: response.data.message
            };
        } catch (error) {
            this.logger.error(`Error merging PR #${prNumber}:`, error);
            
            if (error.status === 405) {
                throw new Error(`Pull request #${prNumber} cannot be merged: ${error.message}`);
            } else if (error.status === 409) {
                throw new Error(`Merge conflict in pull request #${prNumber}: ${error.message}`);
            }
            
            throw error;
        }
    }
}

module.exports = GitHubClient;
