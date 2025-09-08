const { Client } = require('@notionhq/client');
const Logger = require('./Logger');

class NotionClient {
    constructor(token, databaseId) {
        this.notion = new Client({
            auth: token,
        });
        this.databaseId = databaseId;
        this.logger = new Logger('NotionClient');
    }

    /**
     * Fetch all bugs from the Notion database
     * @returns {Array} Array of formatted bug objects
     */
    async fetchAllBugs() {
        try {
            this.logger.info('Fetching all bugs from Notion database...');
            
            const response = await this.notion.databases.query({
                database_id: this.databaseId,
                sorts: [
                    {
                        property: 'ID',
                        direction: 'ascending',
                    },
                ],
            });

            const bugs = response.results.map(page => this.formatBugData(page));
            
            this.logger.info(`Successfully fetched ${bugs.length} bugs from Notion`);
            return bugs;
        } catch (error) {
            this.logger.error('Error fetching bugs from Notion:', error);
            throw error;
        }
    }

    /**
     * Format raw Notion page data into structured bug object
     * @param {Object} page - Raw Notion page object
     * @returns {Object} Formatted bug object
     */
    formatBugData(page) {
        const properties = page.properties;
        
        return {
            notionId: page.id,
            id: this.extractIdFromProperty(properties.ID),
            title: this.extractTextFromProperty(properties['Bug Title']),
            status: this.extractStatusFromProperty(properties.Status),
            type: this.extractSelectFromProperty(properties.Type),
            description: this.extractTextFromProperty(properties.Description),
            stepsToReproduce: this.extractTextFromProperty(properties['Steps to Reproduce']),
            module: this.extractSelectFromProperty(properties.Module),
            issueLink: this.extractUrlFromProperty(properties['Issue Link']),
            branchUrl: this.extractUrlFromProperty(properties['Branch Link']),
            lastModified: page.last_edited_time,
            url: page.url
        };
    }

    /**
     * Extract text content from Notion property
     * @param {Object} property - Notion property object
     * @returns {string} Extracted text
     */
    extractTextFromProperty(property) {
        if (!property) return '';
        
        if (property.type === 'title' && property.title) {
            return property.title.map(text => text.plain_text).join('');
        }
        
        if (property.type === 'rich_text' && property.rich_text) {
            return property.rich_text.map(text => text.plain_text).join('');
        }
        
        return '';
    }

    /**
     * Extract select value from Notion property
     * @param {Object} property - Notion property object
     * @returns {string} Selected option name
     */
    extractSelectFromProperty(property) {
        if (!property || property.type !== 'select' || !property.select) {
            return '';
        }
        return property.select.name;
    }

    /**
     * Extract unique ID from Notion property
     * @param {Object} property - Notion property object
     * @returns {string} Formatted ID (e.g., CBUG-1)
     */
    extractIdFromProperty(property) {
        if (!property || property.type !== 'unique_id' || !property.unique_id) {
            return '';
        }
        
        const { prefix, number } = property.unique_id;
        return `${prefix}-${number}`;
    }

    /**
     * Extract status value from Notion property
     * @param {Object} property - Notion property object
     * @returns {string} Status name
     */
    extractStatusFromProperty(property) {
        if (!property || property.type !== 'status' || !property.status) {
            return '';
        }
        return property.status.name;
    }

    /**
     * Extract URL from Notion property
     * @param {Object} property - Notion property object
     * @returns {string} URL value
     */
    extractUrlFromProperty(property) {
        if (!property || property.type !== 'url') {
            return '';
        }
        return property.url || '';
    }

    /**
     * Update bug status in Notion
     * @param {string} pageId - Notion page ID
     * @param {string} status - New status value
     * @returns {Object} Updated page object
     */
    async updateBugStatus(pageId, status) {
        try {
            this.logger.info(`Updating bug ${pageId} status to: ${status}`);
            
            const response = await this.notion.pages.update({
                page_id: pageId,
                properties: {
                    'Status': {
                        status: {
                            name: status
                        }
                    }
                }
            });
            
            this.logger.info(`Successfully updated bug ${pageId} status`);
            return response;
        } catch (error) {
            this.logger.error(`Error updating bug status for ${pageId}:`, error);
            throw error;
        }
    }

    /**
     * Update bug issue link in Notion
     * @param {string} pageId - Notion page ID
     * @param {string} issueUrl - GitHub issue URL
     * @returns {Object} Updated page object
     */
    async updateBugIssueLink(pageId, issueUrl) {
        try {
            this.logger.info(`Updating bug ${pageId} issue link to: ${issueUrl}`);
            
            const response = await this.notion.pages.update({
                page_id: pageId,
                properties: {
                    'Issue Link': {
                        url: issueUrl
                    }
                }
            });
            
            this.logger.info(`Successfully updated bug ${pageId} issue link`);
            return response;
        } catch (error) {
            this.logger.error(`Error updating bug issue link for ${pageId}:`, error);
            throw error;
        }
    }

    /**
     * Update both status and issue link in a single call
     * @param {string} pageId - Notion page ID
     * @param {Object} updates - Updates object with status and/or issueUrl
     * @returns {Object} Updated page object
     */
    async updateBugProperties(pageId, updates) {
        try {
            this.logger.info(`Updating bug ${pageId} properties:`, Object.keys(updates));
            
            const properties = {};
            
            if (updates.status) {
                properties['Status'] = {
                    status: {
                        name: updates.status
                    }
                };
            }
            
            if (updates.issueUrl) {
                properties['Issue Link'] = {
                    url: updates.issueUrl
                };
            }

            if (updates.branchUrl) {
                properties['Branch Link'] = {
                    url: updates.branchUrl
                };
            }
            
            const response = await this.notion.pages.update({
                page_id: pageId,
                properties
            });
            
            this.logger.info(`Successfully updated bug ${pageId} properties`);
            return response;
        } catch (error) {
            this.logger.error(`Error updating bug properties for ${pageId}:`, error);
            throw error;
        }
    }

    /**
     * Delete a bug page from Notion (archive it)
     * @param {string} pageId - Notion page ID
     * @returns {Object} Archived page object
     */
    async deleteBug(pageId) {
        try {
            this.logger.info(`Archiving bug ${pageId} in Notion...`);
            
            const response = await this.notion.pages.update({
                page_id: pageId,
                archived: true
            });
            
            this.logger.info(`Successfully archived bug ${pageId}`);
            return response;
        } catch (error) {
            this.logger.error(`Error archiving bug ${pageId}:`, error);
            throw error;
        }
    }

    /**
     * Get a specific bug by its Notion page ID
     * @param {string} pageId - Notion page ID
     * @returns {Object} Formatted bug object
     */
    async getBugById(pageId) {
        try {
            this.logger.info(`Fetching bug ${pageId} from Notion...`);
            
            const page = await this.notion.pages.retrieve({
                page_id: pageId
            });
            
            const bug = this.formatBugData(page);
            this.logger.info(`Successfully fetched bug ${bug.id}`);
            return bug;
        } catch (error) {
            this.logger.error(`Error fetching bug ${pageId}:`, error);
            throw error;
        }
    }
}

module.exports = NotionClient;