const { Octokit } = require('@octokit/rest');
const Logger = require('./Logger');

class GitHubClient {
    constructor(token) {
        this.octokit = new Octokit({
            auth: token,
        });
        this.logger = new Logger('GitHubClient');
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
     * @returns {Object} Created issue object
     */
    async createIssue(repo, bug) {
        try {
            const [owner, repoName] = repo.split('/');
            
            // Format title: [type]/[ID] [Title]
            const title = `[${bug.type}]/${bug.id} ${bug.title}`;
            
            // Format description with bug details
            const body = this.formatIssueBody(bug);
            
            // Determine labels based on bug properties
            const labels = this.determineLabels(bug);
            
            this.logger.info(`Creating new issue in ${repo}: ${title}`);
            
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
            throw error;
        }
    }

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
     * Format issue body with bug description and steps to reproduce
     * @param {Object} bug - Notion bug data
     * @returns {string} Formatted issue body
     */
    formatIssueBody(bug) {
        let body = '';
        
        if (bug.description) {
            body += `## Description\n${bug.description}\n\n`;
        }
        
        if (bug.stepsToReproduce) {
            body += `## Steps to Reproduce\n${bug.stepsToReproduce}\n\n`;
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
}

module.exports = GitHubClient;
