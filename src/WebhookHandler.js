const express = require('express');
const cors = require('cors');

/**
 * WebhookHandler manages Notion webhook actions for branch creation
 * Handles both Bug and Task database webhooks when buttons are pressed
 */
class WebhookHandler {
    constructor(config, githubClient, notionClient, logger) {
        this.config = config;
        this.github = githubClient;
        this.notion = notionClient;
        this.logger = logger;
        this.app = express();
        this.server = null;
        
        this.setupMiddleware();
        this.setupRoutes();
    }

    /**
     * Setup Express middleware
     */
    setupMiddleware() {
        // Enable CORS for webhook endpoint
        this.app.use(cors({
            origin: ['https://notion.so', 'https://www.notion.so'],
            methods: ['POST'],
            allowedHeaders: ['Content-Type', 'Authorization']
        }));

        // Parse JSON bodies
        this.app.use(express.json());

        // Request logging
        this.app.use((req, res, next) => {
            this.logger.info(`${req.method} ${req.path}`, {
                userAgent: req.get('User-Agent'),
                contentType: req.get('Content-Type')
            });
            next();
        });
    }

    /**
     * Setup Express routes
     */
    setupRoutes() {
        // Main webhook endpoint for Notion webhook actions
        this.app.post('/webhook/notion', this.handleNotionWebhook.bind(this));
        
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({ 
                status: 'ok', 
                service: 'GitHub-Notion Sync Plus',
                webhook: 'active',
                timestamp: new Date().toISOString()
            });
        });

        // Root endpoint with instructions
        this.app.get('/', (req, res) => {
            res.json({
                service: 'GitHub-Notion Sync Plus Webhook Server',
                endpoints: {
                    webhook: 'POST /webhook/notion',
                    health: 'GET /health'
                },
                webhookUrl: `https://capstone.up-grade.ca/webhook/notion`
            });
        });
    }

    /**
     * Handle incoming Notion webhook actions
     * @param {Object} req - Express request object
     * @param {Object} res - Express response object
     */
    async handleNotionWebhook(req, res) {
        try {
            this.logger.info('Received Notion webhook action', { 
                body: req.body,
                headers: req.headers
            });

            // Respond immediately to prevent timeout (Notion expects quick response)
            res.status(200).json({ 
                status: 'received', 
                timestamp: new Date().toISOString() 
            });

            // Process webhook asynchronously to avoid blocking
            setImmediate(() => this.processWebhookAsync(req.body));

        } catch (error) {
            this.logger.error('Error handling webhook:', error);
            res.status(500).json({ 
                error: 'Webhook processing failed',
                message: error.message
            });
        }
    }

    /**
     * Process webhook data asynchronously
     * @param {Object} webhookData - Notion webhook action data
     */
    async processWebhookAsync(webhookData) {
        try {
            this.logger.info('Processing webhook action asynchronously', { webhookData });

            // Check if this is a branch creation button action
            if (this.isBranchCreationAction(webhookData)) {
                await this.createBranchFromWebhook(webhookData);
            } else {
                this.logger.info('Webhook action not related to branch creation, ignoring');
            }

        } catch (error) {
            this.logger.error('Error processing webhook asynchronously:', error);
        }
    }

    /**
     * Check if webhook action is for branch creation
     * @param {Object} webhookData - Webhook payload
     * @returns {boolean} True if this is a branch creation action
     */
    isBranchCreationAction(webhookData) {
        // Notion webhook actions have specific structure
        // We're looking for button clicks that trigger branch creation
        return webhookData && 
               webhookData.title && 
               webhookData.id && 
               webhookData.module && 
               webhookData.type;
    }

    /**
     * Create a branch based on webhook data
     * @param {Object} webhookData - Contains title, id, module, type from Notion
     */
    async createBranchFromWebhook(webhookData) {
        try {
            const { title, id, module, type } = webhookData;
            
            this.logger.info('Creating branch from webhook data', {
                id, title, module, type
            });

            // Get repository from module mapping
            const repository = this.getRepositoryFromModule(module);
            if (!repository) {
                this.logger.error('Unknown module, cannot create branch', { module });
                return;
            }

            // Generate branch name using same format as issues: [type]/ID-title
            const branchName = this.generateBranchName(id, title, type);

            // Create branch from main
            const branchResult = await this.github.createBranch(repository, branchName, 'main');
            
            if (branchResult) {
                this.logger.info('Successfully created branch', {
                    repository,
                    branchName,
                    branchUrl: branchResult.url
                });

                // Update Notion with branch link
                await this.updateNotionWithBranchLink(id, branchResult.url, webhookData);
                
            } else {
                this.logger.warn('Branch already exists or creation failed', {
                    repository, branchName
                });
            }

        } catch (error) {
            this.logger.error('Error creating branch from webhook:', error);
        }
    }

    /**
     * Generate branch name from bug/task data
     * @param {string} id - Bug/Task ID (CBUG-1 or TSK-1)
     * @param {string} title - Issue title
     * @param {string} type - Issue type
     * @returns {string} Branch name
     */
    generateBranchName(id, title, type) {
        // Convert title to safe branch name
        const safeTitle = title
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
            .replace(/\s+/g, '-')         // Replace spaces with hyphens
            .substring(0, 40);            // Limit length

        // Format: feature/CBUG-1-fix-login-issue
        const prefix = id.startsWith('TSK-') ? 'task' : 'feature';
        return `${prefix}/${id}-${safeTitle}`;
    }

    /**
     * Get repository from module name
     * @param {string} module - Module name (Application/Firmware)
     * @returns {string|null} Repository path or null
     */
    getRepositoryFromModule(module) {
        try {
            const moduleMapping = JSON.parse(this.config.get('MODULE_MAPPING'));
            return moduleMapping[module] || null;
        } catch (error) {
            this.logger.error('Error parsing module mapping:', error);
            return null;
        }
    }

    /**
     * Update Notion with branch link
     * @param {string} id - Bug/Task ID
     * @param {string} branchUrl - GitHub branch URL
     * @param {Object} webhookData - Original webhook data for context
     */
    async updateNotionWithBranchLink(id, branchUrl, webhookData) {
        try {
            // This would need to be implemented based on whether it's a Bug or Task
            // For now, we'll log the action
            this.logger.info('Would update Notion with branch link', {
                id, branchUrl, type: id.startsWith('TSK-') ? 'Task' : 'Bug'
            });

            // TODO: Implement Notion API call to update branch link field
            // This would require knowing the page ID from the webhook or finding it by ID

        } catch (error) {
            this.logger.error('Error updating Notion with branch link:', error);
        }
    }

    /**
     * Start the webhook server
     * @param {number} port - Port to listen on
     * @returns {Promise} Resolves when server is ready
     */
    start(port = 3000) {
        return new Promise((resolve) => {
            this.server = this.app.listen(port, () => {
                this.logger.info(`Webhook server listening on port ${port}`);
                this.logger.info(`Webhook URL: https://capstone.up-grade.ca/webhook/notion`);
                resolve();
            });
        });
    }

    /**
     * Stop the webhook server
     */
    stop() {
        if (this.server) {
            this.server.close();
            this.logger.info('Webhook server stopped');
        }
    }
}

module.exports = WebhookHandler;
