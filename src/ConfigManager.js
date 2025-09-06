require('dotenv').config();
const Logger = require('./Logger');

class ConfigManager {
    constructor() {
        this.logger = new Logger('ConfigManager');
        this.validateEnvironment();
    }

    /**
     * Validate that all required environment variables are present
     */
    validateEnvironment() {
        const requiredVars = [
            'NOTION_TOKEN',
            'GITHUB_TOKEN',
            'BUG_DATABASE_ID',
            'MODULE_MAPPING'
        ];

        const missingVars = requiredVars.filter(varName => !process.env[varName]);

        if (missingVars.length > 0) {
            this.logger.error('Missing required environment variables:', missingVars);
            throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
        }

        this.logger.info('All required environment variables are present');
    }

    /**
     * Get Notion API token
     * @returns {string} Notion token
     */
    getNotionToken() {
        return process.env.NOTION_TOKEN;
    }

    /**
     * Get GitHub API token
     * @returns {string} GitHub token
     */
    getGitHubToken() {
        return process.env.GITHUB_TOKEN;
    }

    /**
     * Get Bug database ID
     * @returns {string} Database ID
     */
    getBugDatabaseId() {
        return process.env.BUG_DATABASE_ID;
    }

    /**
     * Get module to repository mapping
     * @returns {Object} Module mapping object
     */
    getModuleMapping() {
        try {
            return JSON.parse(process.env.MODULE_MAPPING);
        } catch (error) {
            this.logger.error('Error parsing MODULE_MAPPING:', error);
            throw new Error('Invalid MODULE_MAPPING format in environment variables');
        }
    }

    /**
     * Get repository for a given module
     * @param {string} module - Module name
     * @returns {string} Repository name in format "owner/repo"
     */
    getRepositoryForModule(module) {
        const mapping = this.getModuleMapping();
        const repo = mapping[module];
        
        if (!repo) {
            throw new Error(`No repository mapping found for module: ${module}`);
        }
        
        return repo;
    }

    /**
     * Get all configured repositories
     * @returns {Array} Array of repository names
     */
    getAllRepositories() {
        const mapping = this.getModuleMapping();
        return Object.values(mapping);
    }

    /**
     * Get debug mode setting
     * @returns {boolean} Debug mode enabled
     */
    isDebugMode() {
        return process.env.DEBUG === 'true';
    }
}

module.exports = ConfigManager;
