const Logger = require('./Logger');

class DataMapper {
    constructor() {
        this.logger = new Logger('DataMapper');
    }

    /**
     * Map Notion status to GitHub issue state
     * @param {string} notionStatus - Notion bug status
     * @returns {string} GitHub issue state ('open' or 'closed')
     */
    mapNotionStatusToGitHubState(notionStatus) {
        const statusMapping = {
            'Reported': 'open',
            'Blocked': 'open',
            'In Progress': 'open',
            'In Review': 'open',
            'Rejected': 'closed',
            'Fixed': 'closed'
        };
        
        return statusMapping[notionStatus] || 'open';
    }

    /**
     * Map GitHub issue state to Notion status
     * @param {string} githubState - GitHub issue state
     * @param {string} currentNotionStatus - Current Notion status for context
     * @returns {string} Notion status
     */
    mapGitHubStateToNotionStatus(githubState, currentNotionStatus = 'Reported') {
        if (githubState === 'closed') {
            // If issue is closed in GitHub and Notion status is already a closed state, keep it
            if (['Fixed', 'Rejected'].includes(currentNotionStatus)) {
                return currentNotionStatus;
            }
            // Otherwise, default to Fixed for closed issues
            return 'Fixed';
        }
        
        // If reopened and was previously closed, mark as Reported
        if (githubState === 'open' && ['Fixed', 'Rejected'].includes(currentNotionStatus)) {
            return 'Reported';
        }
        
        // Otherwise keep current status
        return currentNotionStatus;
    }

    /**
     * Generate GitHub issue title from Notion bug data
     * @param {Object} bug - Notion bug object
     * @returns {string} Formatted GitHub issue title
     */
    generateGitHubTitle(bug) {
        const type = bug.type || 'Bug';
        const id = bug.id || 'UNKNOWN';
        const title = bug.title || 'Untitled';
        
        return `[${type}]/${id} ${title}`;
    }

    /**
     * Generate GitHub issue body from Notion bug data
     * @param {Object} bug - Notion bug object
     * @returns {string} Formatted GitHub issue body
     */
    generateGitHubBody(bug) {
        let body = '';
        
        if (bug.description) {
            body += `## Description\n${bug.description}\n\n`;
        }
        
        if (bug.stepsToReproduce) {
            body += `## Steps to Reproduce\n${bug.stepsToReproduce}\n\n`;
        }
        
        // Add metadata
        body += `## Bug Information\n`;
        body += `- **Type**: ${bug.type || 'Unknown'}\n`;
        body += `- **Module**: ${bug.module || 'Unknown'}\n`;
        body += `- **Status**: ${bug.status || 'Unknown'}\n\n`;
        
        body += `---\n*This issue was automatically created from Notion bug ${bug.id}*`;
        
        return body;
    }

    /**
     * Determine GitHub labels based on Notion bug data
     * @param {Object} bug - Notion bug object
     * @returns {Array} Array of label names
     */
    generateGitHubLabels(bug) {
        const labels = ['bug', 'notion-sync'];
        
        // Add type-based labels
        if (bug.type) {
            labels.push(bug.type.toLowerCase());
        }
        
        // Add status-based labels
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
     * Extract Notion bug ID from GitHub issue title
     * @param {string} title - GitHub issue title
     * @returns {string|null} Extracted bug ID or null
     */
    extractBugIdFromTitle(title) {
        // Match new format: "CBUG-2: Test Title" or old format: "[Application]/(CBUG-2) Title"
        const newMatch = title.match(/^(CBUG-\d+|TSK-\d+):\s+(.+)$/);
        if (newMatch) {
            return newMatch[1]; // Return CBUG-2 or TSK-1
        }
        
        // Fallback to old format
        const oldMatch = title.match(/^\[(\w+)\]\/(CBUG-\d+)\s+(.+)$/);
        return oldMatch ? oldMatch[2] : null;
    }

    /**
     * Create a mapping key for linking Notion bugs to GitHub issues
     * @param {Object} bug - Notion bug object
     * @returns {string} Mapping key
     */
    createMappingKey(bug) {
        return `${bug.id}-${bug.module}`;
    }

    /**
     * Compare two timestamps to determine which is newer
     * @param {string} timestamp1 - First timestamp
     * @param {string} timestamp2 - Second timestamp
     * @returns {number} -1 if ts1 is older, 1 if ts1 is newer, 0 if equal
     */
    compareTimestamps(timestamp1, timestamp2) {
        const ts1 = new Date(timestamp1);
        const ts2 = new Date(timestamp2);
        
        if (ts1 < ts2) return -1;
        if (ts1 > ts2) return 1;
        return 0;
    }

    /**
     * Validate that a bug has all required fields for GitHub sync
     * @param {Object} bug - Notion bug object
     * @returns {Object} Validation result with isValid and errors
     */
    validateBugForSync(bug) {
        const errors = [];
        
        if (!bug.id) {
            errors.push('Bug ID is missing');
        }
        
        if (!bug.title) {
            errors.push('Bug title is missing');
        }
        
        if (!bug.module) {
            errors.push('Module is missing');
        }
        
        if (!bug.type) {
            errors.push('Type is missing');
        }
        
        return {
            isValid: errors.length === 0,
            errors
        };
    }

    /**
     * Create sync operation object
     * @param {string} action - Action type ('create', 'update', 'close', 'delete')
     * @param {Object} source - Source object (bug or issue)
     * @param {Object} target - Target object (issue or bug)
     * @param {string} reason - Reason for the sync operation
     * @returns {Object} Sync operation object
     */
    createSyncOperation(action, source, target, reason) {
        return {
            action,
            source,
            target,
            reason,
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = DataMapper;
